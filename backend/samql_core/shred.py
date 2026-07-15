"""Shred a nested (JSON) column into RELATIONAL tables -- one table per
array level, with deterministic join keys -- generated as pure DuckDB SQL
over the column's PARQUET backing.

Why this design (vs. row-based normalizers like dlt / json_normalize): the
historical pain was 6M child records taking forever, and that cost comes from
normalizing row-by-row in Python. Here every child table is ONE vectorized
``CREATE TABLE .. AS SELECT`` over columnar parquet with projection pushdown
-- the cashflows table only ever reads the cashflows subtree -- so millions
of rows land in seconds and the whole model is plain SQL the user can read.

Keys are deterministic and hierarchical, so joins Just Work:
  root table:   _rid  (parquet file_row_number)  [+ ord for the root list]
  child tables: the parent's keys + ``<level>_ord`` (1-based position)
Join a child to its parent with ``USING (<the shared prefix>)``.

The plan is derived from the column's parsed type tree (diagnostics.parse_
duckdb_type), so this module is pure and fully unit-testable without DuckDB;
executing the emitted SQL is the session's job.
"""

import re
import functools

from .diagnostics import _needs_quote


# .485: DuckDB reserved keywords that cannot appear as a BARE identifier.
# A lowercase reserved word (a JSON field literally named "end", "order",
# "type", "values", "group", ... -- all common in derivatives data) used to
# render UNQUOTED, and a bare reserved word made the flatten CTAS a
# ParserException ("syntax error at or near ')'") the moment such a column or
# struct leaf hit the base SELECT. Quoting a lowercase reserved word matches
# DuckDB's stored (lower-cased) form exactly, so this is always safe; the set
# is generous on purpose (quoting a non-reserved name is harmless, and
# _needs_quote/mixed-case already cover the rest). _rq() on the session side
# already always-quotes table names, so identifier quoting stays consistent.
_DUCKDB_RESERVED = frozenset("""
all analyse analyze and any array as asc asymmetric both case cast check
collate column constraint create default deferrable desc describe distinct
do else end enum except false fetch for foreign from grant group having in
initially intersect into lateral leading limit list map not null offset on
only or order pivot pivot_longer pivot_wider placing primary qualify
references returning select show some struct symmetric table then to trailing
true union unique unpivot using values variadic when where window with
""".split())


def _q(name):
    s = str(name)
    # quote anything non-plain, anything mixed-case (struct fields keep their
    # created case, so don't gamble on identifier case folding), AND any
    # reserved keyword (a bare reserved word is a parser error).
    if _needs_quote(s) or s != s.lower() or s.lower() in _DUCKDB_RESERVED:
        return '"%s"' % s.replace('"', '""')
    return s


def _qq(name):
    """.485: UNCONDITIONALLY quote an identifier. The flatten planner feeds
    raw JSON field/column names straight into SQL, and those are adversarial:
    a Sophis 'keywords'/'product' bag carries arbitrary keys (reserved words,
    spaces, parens, %, /, dots, quotes...). A curated reserved-word list will
    always miss one -- the on-box "syntax error at or near ')'" was exactly
    such a miss. A quoted identifier with its inner quotes doubled is immune to
    ALL of them (reserved words AND special characters), and quoting the exact
    stored (DESCRIBE-cased) name always resolves. Used for every JSON-derived
    identifier in build_flatten_sql; _q (conditional) still serves the shred
    node. _rq() on the session side is likewise always-quote, so table-name
    quoting stays consistent."""
    return '"%s"' % str(name).replace('"', '""')


_SANITIZE_RE = re.compile(r"[^\w]+", re.UNICODE)


@functools.lru_cache(maxsize=8192)
def _sanitize_cached(part):
    # .520 audit: unicode-aware. The old ASCII class reduced a non-latin
    # name ("税率") to EMPTY and every such column fell back to the same
    # "x" -- order-dependent x/x_2 table names. Word characters of any
    # script survive now; a pure-symbol name gets a short deterministic
    # hash so two of them never collide or swap.
    s = _SANITIZE_RE.sub("_", part).strip("_").lower()
    if s:
        return s
    import hashlib
    return "c_" + hashlib.md5(part.encode("utf-8")).hexdigest()[:6]


def _sanitize(part):
    # .481 audit: memoised + precompiled. The flatten planner sanitises
    # the SAME path fragments repeatedly (every leaf under a struct
    # re-sanitises its parent parts), so a wide struct spent most of its
    # planning time re-running this regex. Caching makes it O(1) on
    # repeats; a wide table with 8k struct fields dropped from ~0.5s to
    # a few ms.
    return _sanitize_cached(str(part))


def _uniq_alias(base, seen, counter):
    """.481 audit: O(1) unique-alias allocation. The old form probed
    `while a in seen: a = base_i; i += 1` from scratch each call -- when
    many fields sanitise to the SAME base (a messy/adversarial schema),
    that walk is 1+2+...+n = O(n^2) just to build the plan. ``counter``
    remembers the next suffix to try per base, so each allocation is
    amortised O(1). ``seen`` is kept in sync for any external readers."""
    if base not in seen:
        seen.add(base)
        counter[base] = 2
        return base
    i = counter.get(base, 2)
    a = "%s_%d" % (base, i)
    # a manual name may already occupy base_i; skip forward if so (rare,
    # still amortised O(1) because counter never rewinds)
    while a in seen:
        i += 1
        a = "%s_%d" % (base, i)
    counter[base] = i + 1
    seen.add(a)
    return a


def root_id_candidates(columns, promote_col=None, max_out=200):
    """.521: walk a file's parsed schema and list every field that can serve
    as the record-level unique identifier (root_id). 1:1 paths (top-level
    scalars, scalars inside wrapper objects) are first-class; a MAP column
    yields a per-key candidate once the session fills its live keys; and --
    "just in case" -- scalars reachable through ONE list hop are offered
    too, evaluated as the FIRST element (labelled so). Returns dicts:
      {"label", "steps": [field, ...], "in_list": [field, ...] | None,
       "map": bool, "type": <duck type or None>}
    ``columns`` is [(name, parsed_node)]; with ``promote_col`` the walk
    happens INSIDE that column's element (the .507 promoted-records shape).
    """
    out = []

    def add(steps, in_list, is_map, typ):
        if len(out) >= max_out:
            return
        core = ".".join(steps)
        if in_list:
            lbl = "%s[1].%s -- first element" % (".".join(in_list), core)
        else:
            lbl = core
        if is_map:
            lbl += "[<key>]"
        out.append({"label": lbl, "steps": list(steps),
                    "in_list": list(in_list) if in_list else None,
                    "map": bool(is_map), "type": typ})

    def walk(fields, prefix, in_list, depth):
        if depth > 6:
            return
        for name, nd in fields:
            t = (nd or {}).get("t")
            path = prefix + [name]
            if t == "scalar":
                add(path, in_list, False, nd.get("type"))
            elif t == "map":
                add(path, in_list, True, None)
            elif t == "struct":
                walk(nd.get("fields") or [], path, in_list, depth + 1)
            elif t == "list" and in_list is None:
                elem = nd.get("of") or {}
                if elem.get("t") == "scalar":
                    add([], path, False, elem.get("type"))
                elif elem.get("t") == "struct":
                    walk(elem.get("fields") or [], [], path, depth + 1)

    if promote_col is not None:
        node = dict(columns).get(promote_col) or {}
        elem = node.get("of") or {}
        walk(elem.get("fields") or [], [], None, 0)
    else:
        walk(list(columns), [], None, 0)
    return out


def render_root_expr(cand, alias, map_key=None):
    """.521: the SQL fragment for a validated candidate, relative to
    ``alias`` (t0 = the source row; e0 = the promoted record element).
    Map lookups render version-safely as map_extract(...)[1] (always a
    one-or-empty LIST across DuckDB versions) and are CAST to VARCHAR
    (decision: map values are JSON-ish). Never trusts client SQL --
    only validated field names, quoted."""
    def path(parts):
        return ".".join(_qq(x) for x in parts)

    base = alias
    steps = list(cand.get("steps") or [])
    in_list = cand.get("in_list")
    if in_list:
        expr = "%s.%s[1]" % (base, path(in_list))
        if steps:
            expr += "." + path(steps)
    else:
        expr = "%s.%s" % (base, path(steps))
    if cand.get("map"):
        key = str(map_key if map_key is not None else "")
        expr = "CAST(map_extract(%s, '%s')[1] AS VARCHAR)" % (
            expr, key.replace("'", "''"))
    return expr


def validate_root_choice(columns, promote_col, choice):
    """.521: re-derive the candidate set and require the client's choice to
    match one of ours (steps + in_list + map). Returns the SERVER's own
    candidate dict (plus the client's map key, format-checked) or None."""
    if not isinstance(choice, dict):
        return None
    want = (tuple(choice.get("steps") or ()),
            tuple(choice.get("in_list") or ()) or None,
            bool(choice.get("map")))
    for c in root_id_candidates(columns, promote_col=promote_col):
        got = (tuple(c["steps"]), tuple(c["in_list"] or ()) or None,
               c["map"])
        if got == want:
            if c["map"]:
                k = choice.get("map_key")
                if not isinstance(k, str) or not k or len(k) > 512:
                    return None
                c = dict(c, map_key=k)
            return c
    return None


def plan_shred(column, node, base="rec", max_tables=40, root_ord=None,
               reserved=None, children_use_base=True):
    """Table plan for shredding ``column`` (parsed type ``node``) into
    relational tables. Returns {tables: [spec...], notes: [...]}. Each spec:

      name       -- output table name (base + array path, sanitized/unique)
      path       -- human path of the array this table explodes
      keys       -- ordered key column names ([_rid, <ord>...])
      parent     -- parent table name (None for the root table)
      depth      -- how many array hops from the source row
      fields     -- non-array field names kept at this level (struct kept
                    as struct; maps/JSON kept as-is)
      child_arrays -- array field names EXCLUDEd here (each gets its own
                    table)
      select_sql(src) is assembled by build_table_sql().

    ``root_ord`` overrides the root array's ordinal column name (default
    ``<base>_ord``); the deep-flatten path passes the shallow list's ordinal
    name so a deep list's root ordinal matches a one-level flatten.

    .507: ``children_use_base=False`` names children by their ELEMENT PATH
    alone ("legs", "legs_cashflows") -- used when the ROOT itself takes the
    file's name (single-list promotion), so the file name doesn't repeat on
    every child. The joinkeys hub stays root-prefixed either way (it belongs
    to the root).

    .507: for a struct-element ROOT, each depth-1 WRAPPER OBJECT with scalar
    leaves becomes its OWN 1:1 table (kind "wrapper": the wrapper's leaves,
    keyed like the root, one row per element that actually HAS the object)
    instead of dumping every leaf onto the root as dotted columns. On
    union-typed data (sophis: optional branches appear in the merged struct
    type), the old inlining made the root a sea of mostly-NULL columns; now
    the root carries the TOP-LEVEL fields only, and each object is a table
    that simply has no row where the object was absent.
    """
    tables = []
    notes = []
    # .501: uniquify against the existing catalog too (minus the root itself,
    # which re-flatten replaces by design) so a deep child ("json_legs") from
    # one file can't clobber the same-named child from another.
    taken = set(n for n in (reserved or ()) if n != _sanitize(base))
    # .520 audit: DuckDB resolves identifiers case-insensitively -- a live
    # "LEGS" must block a planned "legs" (the CTAS would collide) -- so
    # uniqueness is checked on the casefolded name.
    taken_low = {n.lower() for n in taken}

    def uniq(name):
        n, i = name, 2
        while n.lower() in taken_low:
            n = "%s_%d" % (name, i)
            i += 1
        taken.add(n)
        taken_low.add(n.lower())
        return n

    def fields_of(struct_node):
        """Split a struct's fields three ways: PLAIN depth-1 scalars,
        dotted LEAVES under struct wrappers, and ARRAY children (deep,
        dotted). .428: wrappers are no longer kept as whole columns --
        materializing the blob duplicated every nested array inline and
        blew the on-box 13 GiB memory limit on the root CTAS (struct
        vectors aren't spillable mid-pipeline). The wrapper's scalar
        siblings survive as dotted leaf columns instead; array data
        lives ONLY in its child table."""
        names, kids, leaves = [], [], []
        seen = set()
        _seen_ix = {}

        def scan(fields, prefix, parts):
            for fn, fnode in (fields or []):
                dotted = prefix + fn if not prefix else prefix + "." + fn
                nparts = parts + [fn]
                if fnode.get("t") == "list":
                    kids.append((dotted, fnode))
                elif fnode.get("t") == "struct":
                    scan(fnode.get("fields"), dotted, nparts)
                elif not prefix:
                    names.append(fn)
                    seen.add(fn)
                else:
                    alias = "_".join(_sanitize(x) for x in nparts)
                    a = _uniq_alias(alias, seen, _seen_ix)
                    leaves.append((list(nparts), a))
        scan(struct_node.get("fields"), "", [])
        return names, kids, leaves

    def walk(arr_node, path_parts, hops, keys, parent):
        """arr_node is a LIST node; emit its element table, then recurse into
        the element's array fields."""
        if len(tables) >= max_tables:
            notes.append("table cap (%d) reached; deeper arrays skipped"
                         % max_tables)
            return
        elem = arr_node.get("of") or {}
        if path_parts:
            ord_col = _sanitize(path_parts[-1]) + "_ord"
        else:
            # Root array: default ordinal is <base>_ord. But the deep-flatten
            # caller passes root_ord so the root ordinal matches the SHALLOW
            # list's name (e.g. "json_ord") instead of the long base-prefixed
            # "<base>_ord" -- otherwise a deep list's root ordinal reads as the
            # whole table name + "_json_ord", inconsistent with a one-level
            # flatten and unusable in ORDER BY.
            ord_col = root_ord or (base + "_ord")
        my_keys = keys + [ord_col]
        if path_parts and not children_use_base:
            name = uniq(_sanitize("_".join(
                _sanitize(p) for p in path_parts)))
        else:
            name = uniq(_sanitize("_".join([base] + [
                _sanitize(p) for p in path_parts])))
        if elem.get("t") == "struct":
            fields, kids, leaves = fields_of(elem)
        else:
            fields, kids, leaves = ["value"], [], []  # array of scalars
        wrap_specs = []
        if hops == 1 and elem.get("t") == "struct":
            # .510: depth-1 MAP fields (DuckDB's read_json turns
            # heterogeneous objects -- the sophis "identifier" -- into
            # MAP(VARCHAR, ...)) become their OWN (key, value) tables, one
            # row per entry, keyed like the root. Left inline they render
            # as an opaque (often empty-looking) map cell; as a table every
            # entry is a queryable row. The root drops the column.
            for _mf, _mnode in (elem.get("fields") or []):
                if (_mnode or {}).get("t") != "map":
                    continue
                if len(tables) + len(wrap_specs) + 1 >= max_tables:
                    notes.append("table cap (%d) reached; map '%s' left "
                                 "inline" % (max_tables, _mf))
                    continue
                if _mf in fields:
                    fields = [f for f in fields if f != _mf]
                # .520 audit: a MAP whose VALUES are an all-scalar STRUCT
                # (the classic identifier block: {"sophis": {v, src}, ...})
                # used to dump the whole struct into one "value" cell --
                # nested json again, one level down. Those values now
                # explode into real columns: (key, v, src, ...), one row
                # per entry. Any non-scalar member keeps the plain
                # (key, value) shape untouched.
                _mval = (_mnode or {}).get("val") or {}
                _vleaves = None
                if _mval.get("t") == "struct" and _mval.get("fields") and                         all((vn or {}).get("t") == "scalar"
                            for _, vn in _mval["fields"]):
                    _vseen = {"key", "value"}
                    _vctr = {}
                    _vleaves = []
                    for _vf, _ in _mval["fields"]:
                        _al = _uniq_alias(_sanitize(_vf), _vseen, _vctr)
                        _vleaves.append((_al, _vf))
                wrap_specs.append({
                    "name": uniq(_sanitize(_mf) if not children_use_base
                                 else _sanitize(base + "_" + _sanitize(_mf))),
                    "path": (column + ("." + ".".join(path_parts)
                                       if path_parts else "")
                             + "." + _mf + " (map)"),
                    "keys": list(my_keys) + [_sanitize(_mf) + "_ord"],
                    "parent": None,   # filled below: the root's final name
                    "depth": hops,
                    "fields": (["key"] + [a for a, _ in _vleaves]
                               if _vleaves else ["key", "value"]),
                    "leaves": [],
                    "child_arrays": [],
                    "elem_scalar": False,
                    "hop_path": list(path_parts),
                    "map_field": _mf,
                    "map_value_leaves": _vleaves,
                })
        if hops == 1 and elem.get("t") == "struct" and leaves:
            # .507: peel the root's wrapper objects into their own tables.
            by_wrap = {}
            for parts, _alias in leaves:
                by_wrap.setdefault(parts[0], []).append(parts)
            leaves = []           # the root keeps depth-1 scalars ONLY
            for wf, plist in by_wrap.items():
                if len(tables) + len(wrap_specs) + 1 >= max_tables:
                    notes.append("table cap (%d) reached; wrapper '%s' "
                                 "left un-split" % (max_tables, wf))
                    break
                _seen = set()
                _six = {}
                rel = [(list(parts),
                        _uniq_alias("_".join(_sanitize(x)
                                             for x in parts[1:]),
                                    _seen, _six))
                       for parts in plist]
                wrap_specs.append({
                    "name": uniq(_sanitize(wf) if not children_use_base
                                 else _sanitize(base + "_" + _sanitize(wf))),
                    "path": (column + ("." + ".".join(path_parts)
                                       if path_parts else "")
                             + "." + wf + " (object)"),
                    "keys": list(my_keys),
                    "parent": None,   # filled below: the root's final name
                    "depth": hops,
                    "fields": [],
                    "leaves": rel,
                    "child_arrays": [],
                    "elem_scalar": False,
                    "hop_path": list(path_parts),
                    "wrapper_field": wf,
                })
        spec = {
            "name": name,
            "path": (column + ("." + ".".join(path_parts)
                               if path_parts else "")),
            "keys": list(my_keys),
            "parent": parent,
            "depth": hops,
            "fields": fields,
            "leaves": leaves,
            "child_arrays": [fn for fn, _n in kids],
            "elem_scalar": elem.get("t") != "struct",
            "hop_path": list(path_parts),
        }
        tables.append(spec)
        for ws in wrap_specs:
            ws["parent"] = name
            tables.append(ws)
        for fn, fnode in kids:
            walk(fnode, path_parts + [fn], hops + 1, my_keys, name)

    if node.get("t") == "list":
        walk(node, [], 1, ["_rid"], None)
        # JOIN-HELPER (on-box ask 2026-07-02): deep-shred child tables are
        # slim, but the ROOT keeps every wrapper struct and is enormous per
        # row. This slim hub carries _rid + a few scalar identifiers, so
        # children join to IT (child._rid = <base>_joinkeys._rid) without
        # dragging the fat root through every join. The name says what it
        # is; the path says what it keys.
        if tables and len(tables) < max_tables:
            root = tables[0]
            # .520 audit: under .518 the hub IS the records table (no base
            # data table exists) -- so it must carry EVERY depth-1 scalar
            # the root would have carried. The old "slim helper" design
            # (first 5 identifiers, JSON scalars skipped) silently DROPPED
            # record columns from the family once the root stopped
            # existing. Fields literally named like the key/surrogate
            # columns are renamed at SQL build time now, not dropped.
            idents = [fn for fn in root["fields"]]
            tables.append({
                "name": uniq(_sanitize(base + "_joinkeys")),
                "path": column + " (join keys: every shred table joins "
                        "here on _rid)",
                "keys": list(root["keys"]),
                "parent": root["name"],
                "depth": 1,
                "fields": idents,
                "child_arrays": [],
                "elem_scalar": False,
                "hop_path": [],
                "join_helper": True,
            })
    else:
        notes.append("column is not an array; nothing to shred")
    return {"tables": tables, "notes": notes}


def build_table_sql(spec, column, src_parquet, row_range=None,
                    insert=False, json_access=False,
                    json_arr_schema='"JSON"', root_is_json_list=False):
    """The full CREATE OR REPLACE TABLE statement for one plan entry.

    Shape (two array hops, struct elements):

      CREATE OR REPLACE TABLE "base_legs" AS
      SELECT t0.file_row_number + 1 AS "_rid",
             g0.rec_ord, g1.legs_ord,
             e1.* EXCLUDE ("cashflows")
      FROM read_parquet('src', file_row_number = true) AS t0,
           generate_series(1, len(t0."json")) AS g0(rec_ord),
           LATERAL (SELECT t0."json"[g0.rec_ord] AS e0) AS l0,
           generate_series(1, len(e0."legs")) AS g1(legs_ord),
           LATERAL (SELECT e0."legs"[g1.legs_ord] AS e1) AS l1

    Every hop is index-by-ordinal (generate_series + LATERAL), so the ordinal
    IS the key and the element gets a real alias for ``e.*`` / EXCLUDE.

    ``json_access``: opaque JSON / JSON[] columns (flatten-off) cannot use
    STRUCT field hops. Emit ``from_json(..., ['JSON'|'VARCHAR'])`` +
    ``json_extract`` instead so CTAS stays projection-friendly over Parquet.
    ``json_arr_schema`` is the from_json element type token (JSON or VARCHAR).
    ``root_is_json_list``: column is already JSON[] — unnest directly.
    """
    fwd = src_parquet.replace("\\", "/").replace("'", "''")
    hops = [column] + list(spec["hop_path"])
    keys = spec["keys"]  # ["_rid", ord0, ord1, ...] -> one ord per hop
    _root = spec.get("root_expr")
    if json_access:
        return _build_table_sql_json(
            spec, column, fwd, hops, keys, _root,
            row_range=row_range, insert=insert,
            arr_schema=json_arr_schema,
            root_is_json_list=root_is_json_list)

    # .429: the hop engine is an UNNEST PIPELINE with per-stage
    # narrowing, replacing generate_series + LATERAL element-indexing.
    # The old pattern carried the ENTIRE parent cell across a cross
    # join and re-materialized the full element per ordinal tuple --
    # multiplicative struct copies that blew the 13 GiB ceiling even
    # after the projections went lean (.428), because projection
    # pruning cannot push through list[index]. Here every stage
    # unnests ONCE (unnest + generate_subscripts emit aligned rows),
    # streams, and forwards ONLY the keys plus the exact subtree the
    # next hop needs -- untouched siblings die at each CTE boundary,
    # so the working set per batch is keys + one subtree.
    # .522 audit: an e0-flavoured expression cannot reference the unnest
    # ALIAS from the same SELECT (lateral column aliases are version-
    # fragile there); substitute the unnest expression itself. DuckDB
    # zips multiple unnests of the same list positionally, so values
    # stay aligned with e0 by construction.
    _root_u0 = (_root.replace("e0.", "unnest(t0.%s)." % _q(hops[0]))
                if _root else None)
    ctes = []
    ctes.append(
        'u0 AS (SELECT t0.file_row_number + 1 AS "_rid", '
        "generate_subscripts(t0.%s, 1) AS %s, "
        "unnest(t0.%s) AS e0%s "
        "FROM read_parquet('%s', file_row_number = true) AS t0%s)"
        % (_q(hops[0]), _q(keys[1]), _q(hops[0]),
           (', %s AS "root_id"' % _root_u0) if _root else "", fwd,
           (" WHERE t0.file_row_number + 1 BETWEEN %d AND %d"
            % (int(row_range[0]), int(row_range[1])))
           if row_range else ""))
    prev_keys = ['"_rid"', _q(keys[1])]
    # .521: root_id is carried like a key through every hop (but never
    # participates in _sk).
    carry = list(prev_keys) + (['"root_id"'] if _root else [])
    for i2, part in enumerate(hops[1:], start=1):
        dotted = ".".join(_q(x) for x in part.split("."))
        lst = "_l%d" % i2
        ctes.append(
            "n%d AS (SELECT %s, e%d.%s AS %s FROM u%d "
            "WHERE e%d.%s IS NOT NULL)"
            % (i2 - 1, ", ".join(carry), i2 - 1, dotted, lst,
               i2 - 1, i2 - 1, dotted))
        ctes.append(
            "u%d AS (SELECT %s, generate_subscripts(%s, 1) AS %s, "
            "unnest(%s) AS e%d FROM n%d)"
            % (i2, ", ".join(carry), lst, _q(keys[i2 + 1]), lst,
               i2, i2 - 1))
        prev_keys.append(_q(keys[i2 + 1]))
        carry.append(_q(keys[i2 + 1]))
    prev_elem = "e%d" % (len(hops) - 1)
    # .495: single-column surrogate key (_sk) + FK to the parent's _sk
    # (_parent_sk), so a deep child joins to its parent on ONE column instead
    # of matching the whole compound-key tuple. The compound key columns stay
    # (they carry array position for ORDER BY).
    _sk, _psk = _surrogate_frags(list(prev_keys))
    sel = [_sk] + ([_psk] if _psk else []) + list(prev_keys)
    if _root:
        sel.append('"root_id"')
    if spec["elem_scalar"]:
        sel.append('%s AS "value"' % prev_elem)
    elif spec.get("join_helper"):
        # .520 audit: the hub now carries the FULL record payload, so its
        # outputs need the same case-insensitive collision renaming as the
        # leaves branch (a field named "_sk"/"json_ord" gets _2-suffixed
        # instead of colliding with the key columns).
        _used = {k.lower(): 0 for k in spec["keys"]}
        _used["_sk"] = 0
        _used["_parent_sk"] = 0
        if _root:
            _used["root_id"] = 0

        def _hout(nm):
            b = nm
            low = b.lower()
            if low in _used:
                _used[low] += 1
                b = "%s_%d" % (b, _used[low])
                _used[b.lower()] = 0
            else:
                _used[low] = 0
            return b
        for f in spec["fields"]:
            out = _hout(f)
            if out == f:
                sel.append("%s.%s" % (prev_elem, _q(f)))
            else:
                sel.append("%s.%s AS %s" % (prev_elem, _q(f), _q(out)))
    elif spec.get("map_field"):
        # .510: (key, value) explode of an element-level MAP field, aligned
        # by subscript on the SAME unnest chain as the root. The entry
        # ordinal is the last key; NULL/empty maps contribute no rows.
        mf = spec["map_field"]
        oc = spec["keys"][-1]
        head = ("INSERT INTO %s" if insert
                else "CREATE OR REPLACE TABLE %s AS") % _q(spec["name"])
        m_expr = "%s.%s" % (prev_elem, _q(mf))
        inner = ("SELECT %s, generate_subscripts(map_keys(%s), 1) AS %s, "
                 "map_keys(%s) AS _mk, map_values(%s) AS _mv "
                 "FROM u%d WHERE %s IS NOT NULL"
                 % (", ".join(carry), m_expr, _q(oc),
                    m_expr, m_expr, len(hops) - 1, m_expr))
        keys_all = list(prev_keys) + [_q(oc)]
        _sk2, _psk2 = _surrogate_frags(keys_all)
        _vl = spec.get("map_value_leaves")
        if _vl:
            _vparts = ['_mk[%s] AS "key"' % _q(oc)]
            _vparts += ["_mv[%s].%s AS %s" % (_q(oc), _q(raw), _q(al))
                        for al, raw in _vl]
        else:
            _vparts = ['_mk[%s] AS "key"' % _q(oc),
                       '_mv[%s] AS "value"' % _q(oc)]
        sel2 = ([_sk2] + ([_psk2] if _psk2 else []) + keys_all
                + (['"root_id"'] if _root else []) + _vparts)
        return ("%s\nWITH %s,\n     m0 AS (%s)\nSELECT %s\nFROM m0"
                % (head, ",\n     ".join(ctes), inner,
                   ",\n       ".join(sel2)))
    elif spec.get("wrapper_field"):
        # .507: a wrapper-object table -- the object's scalar leaves with
        # RELATIVE aliases (the table IS the object, so "identifier.sophis"
        # is just "sophis" here), one row per element that HAS the object.
        # .520 audit: a wrapper is 1:1 WITH ITS ELEMENT, so its parent row
        # is that element's hub row -- _parent_sk must be the FULL-key
        # concat (== hub._sk), not keys[:-1]. The old rid-only value made
        # the one-line surrogate join (w._parent_sk = hub._sk) match
        # NOTHING.
        _skw, _ = _surrogate_frags(list(prev_keys))
        sel = [_skw,
               _skw.replace(' AS "_sk"', ' AS "_parent_sk"')] \
            + list(prev_keys)
        if _root:
            sel.append('"root_id"')
        used = {k.lower(): 0 for k in spec["keys"]}
        used["_sk"] = 0
        used["_parent_sk"] = 0
        if _root:
            used["root_id"] = 0

        def _wout(name):
            b = name
            low = b.lower()
            if low in used:
                used[low] += 1
                b = "%s_%d" % (b, used[low])
                used[b.lower()] = 0
            else:
                used[low] = 0
            return b
        for parts, alias in spec["leaves"]:
            sel.append("%s.%s AS %s" % (
                prev_elem, ".".join(_q(x) for x in parts),
                _q(_wout(alias))))
        head = ("INSERT INTO %s" if insert
                else "CREATE OR REPLACE TABLE %s AS") % _q(spec["name"])
        return ("%s\nWITH %s\nSELECT %s\nFROM u%d\nWHERE %s.%s IS NOT NULL"
                % (head, ",\n     ".join(ctes),
                   ",\n       ".join(sel), len(hops) - 1,
                   prev_elem, _q(spec["wrapper_field"])))
    elif spec.get("leaves") is not None:
        # .428: EXPLICIT lean projection -- depth-1 scalars by name plus
        # every wrapper leaf as a dotted, readably-aliased column. No
        # element star, no wrapper blobs; array data is never selected
        # in a parent at all (it lives only in its child table).
        # .446 [PLAN PASS 3] fix: output names must be UNIQUE under
        # DuckDB's case-insensitive catalog -- fields differing only by
        # case ("a"/"A"), or a plain field colliding with a wrapper
        # leaf's alias (w_inner vs w.inner), made the CTAS a
        # BinderError at shred time. Collisions get _2/_3 suffixes.
        # .495: reserve the surrogate columns too, so an element field literally
        # named "_sk"/"_parent_sk" gets suffixed rather than colliding.
        used = {k.lower(): 0 for k in spec["keys"]}
        used["_sk"] = 0
        used["_parent_sk"] = 0
        if _root:
            used["root_id"] = 0

        def _out(name):
            base = name
            low = base.lower()
            if low in used:
                used[low] += 1
                base = "%s_%d" % (base, used[low])
                used[base.lower()] = 0
            else:
                used[low] = 0
            return base
        for f in spec["fields"]:
            out = _out(f)
            if out == f:
                sel.append("%s.%s" % (prev_elem, _q(f)))
            else:
                sel.append("%s.%s AS %s" % (prev_elem, _q(f), _q(out)))
        for parts, alias in spec["leaves"]:
            sel.append("%s.%s AS %s" % (
                prev_elem, ".".join(_q(x) for x in parts),
                _q(_out(alias))))
    elif spec["child_arrays"]:
        # legacy spec shape (pre-.428, no "leaves"): direct kids only in
        # EXCLUDE (.425); dotted kids ride inside kept wrapper blobs.
        direct = [c for c in spec["child_arrays"] if "." not in c]
        if direct:
            sel.append("%s.* EXCLUDE (%s)" % (
                prev_elem, ", ".join(_q(c) for c in direct)))
        else:
            sel.append("%s.*" % prev_elem)
    else:
        sel.append("%s.*" % prev_elem)
    head = ("INSERT INTO %s" if insert
            else "CREATE OR REPLACE TABLE %s AS") % _q(spec["name"])
    return ("%s\nWITH %s\nSELECT %s\nFROM u%d"
            % (head, ",\n     ".join(ctes),
               ",\n       ".join(sel), len(hops) - 1))


def _json_ptr(parts):
    """JSONPath under ``$`` for field parts (quoted when needed)."""
    out = ["$"]
    for p in parts:
        s = str(p)
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", s):
            out.append("." + s)
        else:
            out.append("['%s']" % s.replace("'", "''"))
    return "".join(out)


def _json_field_expr(elem, parts, as_text=True):
    ptr = _json_ptr(parts)
    if as_text:
        return "(%s->>'%s')" % (elem, ptr)
    return "json_extract(%s, '%s')" % (elem, ptr)


def _json_arr_expr(base_expr, arr_schema):
    """Coerce a JSON/text cell to a DuckDB list via from_json."""
    sch = arr_schema if arr_schema.startswith('"') else '"%s"' % arr_schema
    return "from_json(CAST(%s AS VARCHAR), '[%s]')" % (base_expr, sch)


def _json_elem_wrap(elem_expr, arr_schema):
    """Wrap a from_json element when schema was VARCHAR (double-encoded)."""
    if "VARCHAR" in (arr_schema or "").upper():
        return "json(%s)" % elem_expr
    return elem_expr


def _build_table_sql_json(spec, column, fwd, hops, keys, _root,
                          row_range=None, insert=False, arr_schema='"JSON"',
                          root_is_json_list=False):
    """Opaque-JSON shred CTAS: from_json + json_extract over Parquet."""
    col0 = _q(hops[0])
    if root_is_json_list:
        root_arr = "t0.%s" % col0
        e0_expr = "unnest(%s)" % root_arr
    else:
        root_arr = "_a0"
        e0_raw = "unnest(_a0)"
        e0_expr = _json_elem_wrap(e0_raw, arr_schema)
    where = (" WHERE t0.file_row_number + 1 BETWEEN %d AND %d"
             % (int(row_range[0]), int(row_range[1]))) if row_range else ""
    ctes = []
    if root_is_json_list:
        ctes.append(
            'u0 AS (SELECT t0.file_row_number + 1 AS "_rid", '
            "generate_subscripts(%s, 1) AS %s, "
            "%s AS e0 "
            "FROM read_parquet('%s', file_row_number = true) AS t0%s)"
            % (root_arr, _q(keys[1]), e0_expr, fwd, where))
    else:
        arr = _json_arr_expr("t0.%s" % col0, arr_schema)
        ctes.append(
            'u0 AS (SELECT t0.file_row_number + 1 AS "_rid", '
            "generate_subscripts(_a0, 1) AS %s, "
            "%s AS e0 "
            "FROM read_parquet('%s', file_row_number = true) AS t0, "
            "LATERAL (SELECT %s AS _a0) AS _j0%s)"
            % (_q(keys[1]), e0_expr, fwd, arr, where))
    prev_keys = ['"_rid"', _q(keys[1])]
    carry = list(prev_keys) + (['"root_id"'] if _root else [])
    for i2, part in enumerate(hops[1:], start=1):
        parts = part.split(".")
        lst = "_l%d" % i2
        child_json = _json_field_expr("e%d" % (i2 - 1), parts, as_text=False)
        child_arr = _json_arr_expr(child_json, arr_schema)
        ctes.append(
            "n%d AS (SELECT %s, %s AS %s FROM u%d WHERE %s IS NOT NULL)"
            % (i2 - 1, ", ".join(carry), child_arr, lst,
               i2 - 1, child_json))
        ei = _json_elem_wrap("unnest(%s)" % lst, arr_schema)
        ctes.append(
            "u%d AS (SELECT %s, generate_subscripts(%s, 1) AS %s, "
            "%s AS e%d FROM n%d)"
            % (i2, ", ".join(carry), lst, _q(keys[i2 + 1]),
               ei, i2, i2 - 1))
        prev_keys.append(_q(keys[i2 + 1]))
        carry.append(_q(keys[i2 + 1]))
    prev_elem = "e%d" % (len(hops) - 1)
    _sk, _psk = _surrogate_frags(list(prev_keys))
    sel = [_sk] + ([_psk] if _psk else []) + list(prev_keys)
    if _root:
        sel.append('"root_id"')
    if spec["elem_scalar"]:
        sel.append('CAST(%s AS VARCHAR) AS "value"' % prev_elem)
    elif spec.get("join_helper") or spec.get("leaves") is not None \
            or spec.get("map_field") or spec.get("wrapper_field"):
        used = {k.lower(): 0 for k in spec["keys"]}
        used["_sk"] = 0
        used["_parent_sk"] = 0
        if _root:
            used["root_id"] = 0

        def _out(name):
            base = name
            low = base.lower()
            if low in used:
                used[low] += 1
                base = "%s_%d" % (base, used[low])
                used[base.lower()] = 0
            else:
                used[low] = 0
            return base
        for f in spec.get("fields") or []:
            sel.append("%s AS %s" % (
                _json_field_expr(prev_elem, [f], as_text=True),
                _q(_out(f))))
        for parts, alias in (spec.get("leaves") or []):
            # wrapper_field tables use relative leaf paths; others are absolute
            # under the element. For JSON, both are field parts under prev_elem.
            sel.append("%s AS %s" % (
                _json_field_expr(prev_elem, parts, as_text=True),
                _q(_out(alias))))
    else:
        sel.append('CAST(%s AS VARCHAR) AS "value"' % prev_elem)
    head = ("INSERT INTO %s" if insert
            else "CREATE OR REPLACE TABLE %s AS") % _q(spec["name"])
    return ("%s\nWITH %s\nSELECT %s\nFROM u%d"
            % (head, ",\n     ".join(ctes),
               ",\n       ".join(sel), len(hops) - 1))


# ---------------------------------------------------------------------------
# .474: TABLE-LEVEL flatten (the Load-modal "flatten" toggle).
#
# plan_shred() above explodes ONE nested column and treats THAT column as the
# root -- which is wrong for "flatten this whole table": it dropped every
# top-level scalar and every sibling nested column. This planner takes the
# WHOLE TABLE's column set as the root record and produces exactly the shape
# the relational model wants:
#
#   <base>            one row per source record: all top-level scalars, PLUS
#                     every single-struct column flattened INLINE
#                     (product -> product_x, product_y, ...). List columns are
#                     dropped from here (each becomes its own table).
#   <base>_joinkeys   _rid + one ordinal per top-level list (fees_ord, ...),
#                     so a child row maps to its exact position; the base
#                     joins on _rid alone.
#   <base>_<list>     one row per element of a top-level list: _rid + <list>_ord
#                     + the element's fields flattened INLINE (a struct element
#                     spreads its subfields; a scalar element becomes "value").
#
# Everything reads directly from the loaded table, so it works whether the
# table is a real DuckDB table or the parquet-backed view a flatten-off JSON
# load produces. "row_expr" is the SQL that yields a stable 1-based row id for
# each source record (parquet's file_row_number+1 when reading the cache, or
# ROW_NUMBER() over the table otherwise).
# ---------------------------------------------------------------------------

# .478 audit: a hard recursion cap. A pathologically deep struct type
# (malformed/adversarial schema) would otherwise recurse until Python's
# stack overflowed -- an unhandled RecursionError taking the flatten
# down. 64 levels is far past any real nesting; beyond it we stop
# descending (the deep leaves just aren't inlined) rather than crash.
_MAX_INLINE_DEPTH = 64


def _struct_inline(node, prefix, parts, out, seen, _depth=0, _seen_ix=None,
                   nested_lists=None):
    """Recurse a struct, emitting (sql_path_expr_fragments, alias) for every
    SCALAR/MAP/JSON leaf -- struct wrappers are flattened inline. A list found
    inside the struct is never inlined (it can't be a scalar column). What
    happens to it depends on ``nested_lists``:

      * ``nested_lists`` is a list  -> the list is APPENDED as
        (path_parts, list_node) so the caller can break it out into its OWN
        child table. Every hop from the record root down to such a list is a
        struct-field access (this walker only descends structs), so there is
        exactly ONE such list per source row -- it keys on ``_rid`` alone,
        just like a top-level list (.490).
      * ``nested_lists`` is None     -> the list is skipped entirely (legacy:
        a list nested inside a LIST element would need a COMPOUND key and is
        still out of scope).

    Returns nothing; appends (path_parts, alias) to ``out``. Capped at
    _MAX_INLINE_DEPTH."""
    if _depth >= _MAX_INLINE_DEPTH:
        return
    if _seen_ix is None:
        _seen_ix = {}
    for fn, fnode in (node.get("fields") or []):
        nparts = parts + [fn]
        t = fnode.get("t")
        if t == "struct":
            _struct_inline(fnode, prefix, nparts, out, seen, _depth + 1,
                           _seen_ix, nested_lists)
        elif t == "list":
            if nested_lists is not None:
                nested_lists.append((list(nparts), fnode))
            continue
        else:
            alias = "_".join(_sanitize(x) for x in nparts)
            a = _uniq_alias(alias, seen, _seen_ix)
            out.append((list(nparts), a))


def plan_flatten_table(columns, base="rec", reserved=None):
    """Plan the table-level flatten. ``columns`` is an ordered list of
    (name, parsed_node) for the table's TOP-LEVEL columns. Returns
    {tables: [spec...], notes: [...]}; each spec is consumed by
    build_flatten_sql(). Pure.

    .501: child tables are named by their ELEMENT PATH ("legs", "attrs"), not
    "<file>_legs" -- only the ROOT keeps the file/base name. ``reserved`` is
    the set of names already in the catalog; planned names uniquify against it
    (suffix _2) so two files that both carry a "legs" element can't clobber
    each other. The base itself is exempt (re-flattening a file REPLACES its
    own base by design)."""
    tables = []
    notes = []
    taken = set(n for n in (reserved or ()) if n != _sanitize(base))
    taken_low = {n.lower() for n in taken}  # .520: case-insensitive catalog

    def uniq(name):
        n, i = name, 2
        while n.lower() in taken_low:
            n = "%s_%d" % (name, i)
            i += 1
        taken.add(n)
        taken_low.add(n.lower())
        return n

    def _pathkey(parts):
        # a stable, collision-resistant identifier stem for a list PATH:
        # ["fees"] -> "fees"; ["record","items"] -> "record_items".
        return "_".join(_sanitize(p) for p in parts)

    scalars = []          # plain top-level scalar column names (small values)
    inline_structs = []   # (colname, [(path_parts, alias), ...])
    lists = []            # (path_parts, list_node) -- top-level AND struct-nested
    maps = []             # (colname, map_node) -> a (key, value) child table
    json_cols = []        # colname -> a 1:1 side table (blob moved off the base)
    for name, node in columns:
        t = (node or {}).get("t")
        if t == "list":
            lists.append(([name], node))
        elif t == "struct":
            leaves = []
            nested = []
            seen = set()
            # .490: collect lists nested inside this top-level struct so they
            # break out into their own child tables (record.items -> its own
            # table) instead of being silently dropped. The path to each is
            # all struct hops, so they key on _rid like any top-level list.
            _struct_inline(node, name, [name], leaves, seen,
                           nested_lists=nested)
            inline_structs.append((name, leaves))
            lists.extend(nested)
        elif t == "map":
            # .500: a MAP (arbitrary-key object) used to land inline on the base
            # as a "scalar/map/json" leaf -- DuckDB hands it back as a dict, so a
            # deeply-nested one was megabytes per row and froze the grid. It has
            # no fixed schema to inline as columns, so break it into a tidy
            # (key, value) child table instead: one row per entry, keyed on _rid.
            maps.append((name, node))
        elif (t == "scalar"
              and (node.get("type") or "").upper() == "JSON"):
            # .500: a JSON-typed scalar is a blob (a whole nested value as text);
            # inline it made the base fat and was the other half of the stall.
            # Move it to its own 1:1 side table so the base stays slim; join back
            # on _rid. (Plain scalars -- BIGINT/VARCHAR/... -- stay on the base.)
            json_cols.append(name)
        else:
            scalars.append(name)

    base_name = uniq(_sanitize(base))
    tables.append({
        "kind": "base",
        "name": base_name,
        "scalars": scalars,
        "inline_structs": inline_structs,
        # informational only; nested lists are already excluded from the base
        # by _struct_inline, so only TOP-LEVEL list columns are listed here.
        "drop_lists": [p[0] for p, _ in lists if len(p) == 1],
    })

    ord_cols = [_pathkey(p) + "_ord" for p, _ in lists]
    # .520 audit (under the .518 no-base contract): the hub IS the records
    # table -- ONE per family, ALWAYS emitted, carrying the whole old base
    # payload (top-level scalars + inlined struct leaves), one row per
    # source record, _sk = the record's _rid. Every child's _parent_sk is
    # the rid-concat, so the one-line rule (child._parent_sk = hub._sk)
    # holds for lists, maps and json side tables alike. The old design
    # (keys-only hubs, one per list, skipped entirely for a slim base)
    # lost every top-level scalar once the base stopped being created --
    # and a slim-base family had NO anchor at all.
    if lists or maps or json_cols or inline_structs:
        # (a completely FLAT table has nothing to anchor -- no hub)
        tables.append({
            "kind": "joinkeys",
            "name": uniq(_sanitize(base + "_joinkeys")),
            "scalars": scalars,
            "inline_structs": inline_structs,
        })

    # .500 (a): each top-level MAP -> a (key, value) child table.
    for colname, _mnode in maps:
        tables.append({
            "kind": "map",
            "name": uniq(_sanitize(colname)),
            "col": colname,
            "ord_col": _sanitize(colname) + "_ord",
        })
    # .500 (b): each top-level JSON blob -> a 1:1 side table off the base.
    for colname in json_cols:
        tables.append({
            "kind": "jsonside",
            "name": uniq(_sanitize(colname)),
            "col": colname,
        })

    for (p, node), ordc in zip(lists, ord_cols):
        elem = (node or {}).get("of") or {}
        leaves = []
        elem_scalar = elem.get("t") != "struct"
        nested_child_specs = []
        if not elem_scalar:
            seen = set()
            # Nested lists inside list elements get compound keys
            # (_rid + parent ordinals + own ordinal) — same model as plan_shred.
            enest = []
            _struct_inline(elem, "", [], leaves, seen, nested_lists=enest)
            for np, nnode in enest:
                nested_child_specs.append((list(p) + list(np), nnode, p, ordc))
        tables.append({
            "kind": "list",
            "name": uniq(_pathkey(p)),
            "list_path": p,
            "ord_col": ordc,
            "elem_scalar": elem_scalar,
            "leaves": leaves,   # element struct subfields, inlined
            # key ordinals from the root down to this list (exclusive of own)
            "parent_ords": [],
            "parent_list_path": None,
        })
        # Emit one child table per nested-in-element list, keyed on the full
        # compound path so rows join: child._parent_sk == parent._sk.
        for full_path, nnode, parent_path, parent_ord in nested_child_specs:
            n_elem = (nnode or {}).get("of") or {}
            n_leaves = []
            n_scalar = n_elem.get("t") != "struct"
            if not n_scalar:
                n_seen = set()
                # One more level of nesting still noted (rare); deeper levels
                # go through plan_shred via flatten_table's deep_cols route.
                deeper = []
                _struct_inline(n_elem, "", [], n_leaves, n_seen,
                               nested_lists=deeper)
                for dp, _dn in deeper:
                    notes.append(
                        "list nested deeper than compound-key flatten "
                        "(%s); use Shred / deep flatten for full breakout"
                        % (".".join(full_path + dp)))
            n_ord = _pathkey(full_path) + "_ord"
            tables.append({
                "kind": "list",
                "name": uniq(_pathkey(full_path)),
                "list_path": full_path,
                "ord_col": n_ord,
                "elem_scalar": n_scalar,
                "leaves": n_leaves,
                "parent_ords": [parent_ord],
                "parent_list_path": parent_path,
            })

    if not lists and not inline_structs and not maps and not json_cols:
        notes.append("no nested columns to flatten")
    return {"tables": tables, "notes": notes}


def _surrogate_frags(key_exprs):
    """SELECT fragments for the single-column surrogate key (``_sk``) and the
    foreign key to the PARENT row's ``_sk`` (``_parent_sk``). ``key_exprs`` is
    this row's ordered key expressions ([_rid, ord0, ord1, ...]); the parent's
    key is the same list without the last ordinal, so ``child._parent_sk ==
    parent._sk`` BY CONSTRUCTION -- a child joins to its parent on that one
    column. The value is a deterministic '/'-joined path ("5/2/3"): no global
    counter, so it is parallel-safe and stable across rebuilds, and readable
    enough to eyeball a row's lineage. Every key is CAST to VARCHAR so the
    concat never depends on implicit typing. Returns (sk_frag, parent_frag or
    None) -- the top of the tree (a lone _rid key) has no parent above it."""
    def cat(exprs):
        return ("concat_ws('/', %s)"
                % ", ".join("CAST(%s AS VARCHAR)" % e for e in exprs))
    sk = '%s AS "_sk"' % cat(key_exprs)
    if len(key_exprs) <= 1:
        return sk, None
    return sk, '%s AS "_parent_sk"' % cat(key_exprs[:-1])


def build_flatten_sql(spec, src_expr, row_expr, json_access=False,
                      json_arr_schema='"JSON"'):
    """CREATE OR REPLACE TABLE statement for one plan_flatten_table spec.
    ``src_expr`` is a ready FROM source -- either a table name or a
    ``read_parquet(...)`` expression, wrapped by the caller so it drops
    straight into ``FROM <src_expr> AS t0``. ``row_expr`` yields the
    stable 1-based _rid per source row.

    ``json_access``: opaque JSON column — use from_json + json_extract
    instead of STRUCT subscript hops.
    """
    Q = _qq          # .485: every JSON-derived identifier is quoted here
    qsrc = src_expr

    _root = spec.get("root_expr")

    def _root_dodge(name):
        # .521: OUR root_id column wins; a source field literally named
        # root_id (any case) is emitted suffixed.
        return (_root and name.lower() == "root_id")

    if spec["kind"] == "base":
        # .495: _sk is this record's surrogate key (= its _rid as a path); it is
        # the top of the tree, so no _parent_sk. Children FK to it via
        # child._parent_sk = <base>._sk.
        sk, _psk = _surrogate_frags([row_expr])
        sel = [sk, '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        for c in spec["scalars"]:
            # .485: qualify with the source alias -- a bare scalar that
            # shadows a keyword or a relation name is ambiguous; t0."end"
            # is not. (Reserved names are also quoted by _q now.)
            if _root_dodge(c):
                sel.append("t0.%s AS %s" % (Q(c), Q(c + "_1")))
            else:
                sel.append("t0.%s" % Q(c))
        for colname, leaves in spec["inline_structs"]:
            for parts, alias in leaves:
                # parts starts with the column name (see _struct_inline);
                # the access path is t0 . colname . <rest>. Qualifying with
                # t0 makes struct-field access unambiguous (never mis-read as
                # a schema/table ref) and matches the child tables' style.
                path = _inline_path(colname, parts[1:])
                sel.append("t0.%s AS %s" % (path, Q(alias)))
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s FROM %s AS t0'
                % (Q(spec["name"]), ", ".join(sel), qsrc))

    if spec["kind"] == "map":
        # .500 (a): explode a MAP into (key, value) rows, ONE per entry, aligned
        # by subscript exactly like the list tables (map_keys/map_values are
        # positionally paired lists, so key[i]/value[i] belong together). An
        # empty/NULL map contributes no rows (INNER lateral). Keyed on
        # (_rid, <col>_ord); FK to the base via _parent_sk = base._sk.
        col = spec["col"]
        ordc = spec["ord_col"]
        acc = Q(col)
        sk, psk = _surrogate_frags([row_expr, "g.%s" % Q(ordc)])
        sel = [sk, psk, '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        sel += ["g.%s AS %s" % (Q(ordc), Q(ordc)),
                'map_keys(t0.%s)[g.%s] AS "key"' % (acc, Q(ordc)),
                'map_values(t0.%s)[g.%s] AS "value"' % (acc, Q(ordc))]
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s '
                "FROM %s AS t0, LATERAL ("
                "SELECT generate_subscripts(map_keys(t0.%s), 1) AS %s) AS g"
                % (Q(spec["name"]), ", ".join(sel), qsrc, acc, Q(ordc)))

    if spec["kind"] == "jsonside":
        # .500 (b): move a JSON blob OFF the base into its own 1:1 side table
        # (_rid + the value), so the base stays slim. Join back on _rid (or
        # _sk, which is _rid here). One row per source row.
        col = spec["col"]
        sk, _psk = _surrogate_frags([row_expr])
        # .520 audit: a 1:1 side table's parent row is its OWN record --
        # emit _parent_sk (= _sk = the rid) so the shared one-line join
        # (side."_parent_sk" = hub."_sk") works like every other child.
        sel = [sk, sk.replace(' AS "_sk"', ' AS "_parent_sk"'),
               '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        sel += ["t0.%s AS %s" % (Q(col), Q(col))]
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s FROM %s AS t0'
                % (Q(spec["name"]), ", ".join(sel), qsrc))

    if spec["kind"] == "joinkeys":
        # .520 audit: the RECORDS HUB -- one row per source record, _sk =
        # the record's _rid, the whole old base payload (scalars + inlined
        # struct leaves). Children join here one-line:
        # child."_parent_sk" = hub."_sk".
        sk, _psk = _surrogate_frags([row_expr])
        sel = [sk, '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        for c in spec["scalars"]:
            if _root_dodge(c):
                sel.append("t0.%s AS %s" % (Q(c), Q(c + "_1")))
            else:
                sel.append("t0.%s" % Q(c))
        for colname, leaves in spec["inline_structs"]:
            for parts, alias in leaves:
                path = _inline_path(colname, parts[1:])
                sel.append("t0.%s AS %s" % (path, Q(alias)))
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s FROM %s AS t0'
                % (Q(spec["name"]), ", ".join(sel), qsrc))

    # kind == "list": explode ONE list (top-level, struct-nested, or
    # nested-inside-a-list-element with compound keys).
    path = spec["list_path"]
    ordc = spec["ord_col"]
    parent_ords = list(spec.get("parent_ords") or [])
    parent_list_path = spec.get("parent_list_path")

    if json_access and not parent_ords:
        # Opaque JSON top-level list via from_json over Parquet.
        col = path[0]
        if len(path) > 1:
            arr = _json_arr_expr(
                _json_field_expr("t0.%s" % Q(col), path[1:], as_text=False),
                json_arr_schema)
        else:
            arr = _json_arr_expr("t0.%s" % Q(col), json_arr_schema)
        elem_raw = "_arr[g.%s]" % Q(ordc)
        elem = _json_elem_wrap(elem_raw, json_arr_schema)
        sk, psk = _surrogate_frags([row_expr, "g.%s" % Q(ordc)])
        sel = [sk, psk, '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        sel += ["g.%s AS %s" % (Q(ordc), Q(ordc))]
        if spec["elem_scalar"]:
            sel.append('CAST(%s AS VARCHAR) AS "value"' % elem)
        else:
            for parts, alias in spec["leaves"]:
                sel.append("%s AS %s" % (
                    _json_field_expr(elem, parts, as_text=True), Q(alias)))
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s '
                "FROM %s AS t0, LATERAL (SELECT %s AS _arr) AS _j, "
                "LATERAL (SELECT generate_subscripts(_arr, 1) AS %s) AS g"
                % (Q(spec["name"]), ", ".join(sel), qsrc, arr, Q(ordc)))

    if parent_ords and parent_list_path:
        # Compound-key child: unnest the parent list, then this list at
        # the relative path under each parent element.
        parent_acc = _inline_path(parent_list_path[0], parent_list_path[1:])
        parent_ord = parent_ords[0]
        rel = path[len(parent_list_path):]
        parent_elem = "t0.%s[g0.%s]" % (parent_acc, Q(parent_ord))
        child_list = parent_elem
        for part in rel:
            child_list = "%s.%s" % (child_list, Q(part))
        elem = "%s[g.%s]" % (child_list, Q(ordc))
        key_exprs = [row_expr, "g0.%s" % Q(parent_ord), "g.%s" % Q(ordc)]
        sk, psk = _surrogate_frags(key_exprs)
        sel = [sk, psk, '%s AS "_rid"' % row_expr]
        if _root:
            sel.append('%s AS "root_id"' % _root)
        sel += ["g0.%s AS %s" % (Q(parent_ord), Q(parent_ord)),
                "g.%s AS %s" % (Q(ordc), Q(ordc))]
        if spec["elem_scalar"]:
            sel.append('%s AS "value"' % elem)
        else:
            for parts, alias in spec["leaves"]:
                sel.append("%s AS %s" % (_inline_path_expr(elem, parts),
                                         Q(alias)))
        return ('CREATE OR REPLACE TABLE %s AS SELECT %s '
                "FROM %s AS t0, LATERAL ("
                "SELECT generate_subscripts(t0.%s, 1) AS %s) AS g0, "
                "LATERAL ("
                "SELECT generate_subscripts(%s, 1) AS %s) AS g"
                % (Q(spec["name"]), ", ".join(sel), qsrc,
                   parent_acc, Q(parent_ord), child_list, Q(ordc)))

    # Standard single-level list (top-level or struct-nested under record).
    acc = _inline_path(path[0], path[1:])
    elem = "t0.%s[g.%s]" % (acc, Q(ordc))
    sk, psk = _surrogate_frags([row_expr, "g.%s" % Q(ordc)])
    sel = [sk, psk, '%s AS "_rid"' % row_expr]
    if _root:
        sel.append('%s AS "root_id"' % _root)
    sel += ["g.%s AS %s" % (Q(ordc), Q(ordc))]
    if spec["elem_scalar"]:
        sel.append('%s AS "value"' % elem)
    else:
        for parts, alias in spec["leaves"]:
            sel.append("%s AS %s" % (_inline_path_expr(elem, parts),
                                     Q(alias)))
    return ('CREATE OR REPLACE TABLE %s AS SELECT %s '
            "FROM %s AS t0, LATERAL ("
            "SELECT generate_subscripts(t0.%s, 1) AS %s) AS g"
            % (Q(spec["name"]), ", ".join(sel), qsrc, acc, Q(ordc)))


def _inline_path(root, parts):
    """A dotted struct access expression: root.a.b.c, each part
    UNCONDITIONALLY quoted (.485 -- immune to reserved/special field names).
    ``parts`` is the path BELOW the root (root already given separately)."""
    expr = _qq(root)
    for p in parts:
        expr += "." + _qq(p)
    return expr


def _inline_path_expr(base_expr, parts):
    """Like _inline_path but the base is a ready SQL EXPRESSION (e.g.
    ``t0."fees"[g."fees_ord"]``) rather than an identifier to quote.
    Each field part is UNCONDITIONALLY quoted (.485)."""
    expr = base_expr
    for p in parts:
        expr += "." + _qq(p)
    return expr
