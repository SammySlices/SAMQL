"""JSON ingestion: a tolerant multi-format reader plus the recursive
JSONFlattener that turns nested JSON into a set of relational tables
(parent/child rows linked by synthetic _id / <parent>_id keys).

Lifted directly from the original single-file application. GUI-free.
"""
import decimal
import json
import os
import pickle
import re
import shutil
import tempfile
import time
from collections import defaultdict

from . import progress as _opreg

try:
    import orjson as _orjson

    def _json_loads(s):
        return _orjson.loads(s)

    def _json_load(f):
        return _orjson.loads(f.read())
except Exception:
    def _json_loads(s):
        return json.loads(s)

    def _json_load(f):
        return json.load(f)


# ---------------------------------------------------------------------------
# Schema-driven DuckDB flatten (SQL UNNEST) -- no Python parse.
#
# Given a nested DuckDB table's column types, plan the SQL that explodes each
# array (LIST) column into its own child table -- struct arrays are expanded
# into columns, scalar arrays become a single "value" column -- carrying a
# parent key down as the foreign key. When the table already has an id-like
# scalar column we use it directly (children read straight from the source);
# otherwise we synthesize a stable row key in a one-off keyed copy.
#
# These are pure planners: they build SQL strings and run nothing, so the SQL
# they emit can be asserted in tests even where DuckDB is not installed.
# ---------------------------------------------------------------------------

# id-like column-name patterns, highest score first. Order matters: the first
# pattern a name matches is taken as that name's score, so more specific
# patterns must precede the generic ones.
_KEY_NAME_PATTERNS = [
    (r"^trade[ _-]?id$", 100),
    (r"^deal[ _-]?id$", 96),
    (r"trade[ _-]?id$", 90),
    (r"deal[ _-]?id$", 88),
    (r"^id$", 85),
    (r"[ _-]id$", 80),
    (r"id$", 70),                 # camelCase tradeId / dealId (no separator)
    (r"^uu?id$", 66),
    (r"uu?id$", 58),
    (r"^(row|record|entity|object)[ _-]?key$", 52),
    (r"[ _-]?key$", 44),
    (r"^reference$", 40),
    (r"reference", 34),
    (r"^ref$", 30),
]


def _type_is_list(type_str):
    """True when a DuckDB DESCRIBE type is an array/LIST (its element is
    exploded to a child table). DuckDB renders these as ``<elem>[]`` or
    ``LIST(...)``."""
    t = (type_str or "").strip().upper()
    return t.endswith("[]") or t.startswith("LIST")


def _type_is_struct_list(type_str):
    """True when the array's element is a STRUCT, so the child table's columns
    are the struct's fields (e.g. ``STRUCT(...)[]``)."""
    t = (type_str or "").strip().upper()
    if not t.endswith("[]"):
        return False
    return t[:-2].strip().startswith("STRUCT")


def _type_is_scalar(type_str):
    """True for a plain scalar column (a valid FK-key candidate) -- not an
    array, struct, map or union."""
    t = (type_str or "").strip().upper()
    if not t:
        return False
    return not (t.endswith("[]") or t.startswith("LIST")
                or t.startswith("STRUCT") or t.startswith("MAP")
                or t.startswith("UNION"))


def _type_is_struct(type_str):
    """True for a top-level STRUCT column (an object, not a struct array).
    Such a column is left nested by the flatten and stays queryable via dot
    access (e.g. ``identifier.sophis``)."""
    t = (type_str or "").strip().upper()
    return t.startswith("STRUCT") and not t.endswith("[]")


def detect_key_column(coltypes):
    """Pick the most id-like SCALAR column to carry down as the parent/FK key.

    ``coltypes`` is ``{column_name: TYPE_STRING}`` as returned by DuckDB
    DESCRIBE. Returns the chosen column name, or ``None`` when no id-like
    scalar column is present -- the caller then synthesizes a row key."""
    best, best_score = None, 0
    for name, typ in coltypes.items():
        if not _type_is_scalar(typ):
            continue
        low = str(name).lower()
        score = 0
        for pat, sc in _KEY_NAME_PATTERNS:
            if re.search(pat, low):
                score = sc
                break
        if score > best_score:
            best, best_score = name, score
    return best


def _qi(ident):
    """Quote a DuckDB identifier."""
    return '"' + str(ident).replace('"', '""') + '"'


def _sanitize_suffix(name):
    """Make an array column name safe as a table-name suffix."""
    s = re.sub(r"[^0-9A-Za-z]+", "_", str(name)).strip("_")
    return s or "arr"


def _split_struct_fields(type_str):
    """Split a DuckDB ``STRUCT(name TYPE, ...)`` type string into
    ``[(name, type), ...]`` -- paren-depth aware (MAP/LIST/STRUCT nest),
    double-quote aware (quoted field names, doubled-quote escapes)."""
    t = type_str.strip()
    if not (t.startswith("STRUCT(") and t.endswith(")")):
        return []
    body = t[len("STRUCT("):-1]
    parts, depth, quote, cur = [], 0, False, []
    i = 0
    while i < len(body):
        ch = body[i]
        if quote:
            cur.append(ch)
            if ch == '"':
                if i + 1 < len(body) and body[i + 1] == '"':
                    cur.append('"'); i += 1
                else:
                    quote = False
        elif ch == '"':
            quote = True; cur.append(ch)
        elif ch in "(<[":
            depth += 1; cur.append(ch)
        elif ch in ")>]":
            depth -= 1; cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(ch)
        i += 1
    if cur:
        parts.append("".join(cur))
    out = []
    for f in parts:
        f = f.strip()
        if not f:
            continue
        if f.startswith('"'):
            j = 1
            name_chars = []
            while j < len(f):
                if f[j] == '"':
                    if j + 1 < len(f) and f[j + 1] == '"':
                        name_chars.append('"'); j += 2; continue
                    j += 1; break
                name_chars.append(f[j]); j += 1
            out.append(("".join(name_chars), f[j:].strip()))
        else:
            sp = f.find(" ")
            if sp < 0:
                continue
            out.append((f[:sp], f[sp + 1:].strip()))
    return out


def _walk_nested(parts, type_str, lists, leaves):
    """Descend plain STRUCT wrappers (.422): every LIST found at a
    dotted path is a child-table candidate; every scalar/MAP leaf under
    a wrapper becomes a dotted root column. MAP stays a leaf (its keys
    are data, not schema); LIST elements are NOT descended into -- one
    explosion level per child, exactly like top-level arrays."""
    if _type_is_list(type_str):
        lists.append((parts, type_str))
        return
    if type_str.strip().startswith("MAP"):
        leaves.append((parts, type_str))
        return
    if _type_is_struct(type_str):
        for name, ft in _split_struct_fields(type_str):
            _walk_nested(parts + [name], ft, lists, leaves)
        return
    leaves.append((parts, type_str))


def _dotted(parts):
    return ".".join(_qi(p) for p in parts)


def _leaf_alias(parts, sep, used):
    base = sep.join(_sanitize_suffix(p) for p in parts)
    alias, i = base, 0
    while alias in used:
        i += 1
        alias = "%s%s%d" % (base, sep, i)
    used.add(alias)
    return alias


_HUB_IDENTS = ("code", "id", "isin", "cusip", "sedol", "ticker", "name")


def duckdb_unnest_plan(table, coltypes, root_name, sep="_", fk_suffix="_id",
                       synth_key="_rowkey", key=None, existing_names=None,
                       detect=True, fk_name=None, child_prefix=None):
    """Plan the SQL to flatten nested ``table`` into a root table plus one
    child table per array column, via UNNEST.

    Returns a dict::

        { "statements": [ {"target","sql","kind"}, ... ],   # ordered
          "cleanup":    [ table, ... ],                      # drop after
          "root": root_name,
          "children": { child_table: source_array_col },
          "key": key_col_used,        # column the FK value comes from
          "fk":  fk_col,              # FK column name on root + children
          "synthesized": bool,
          "list_cols": [ ... ] }

    Pure: emits SQL text only, executes nothing.

    Key handling: pass ``key`` to force a specific existing column; with
    ``detect=True`` (default) an id-like column is auto-detected; with
    ``detect=False`` (and no ``key``) a stable row key is always synthesized.
    A synthesized key is materialized once in a keyed copy (so it is identical
    across the parent and every child) and carries the SAME column name on the
    root and the children -- so a single ``WHERE key = ...`` / join works
    everywhere. ``fk_name`` overrides the FK column name if needed. When the
    table has no array columns, a single keyed table is produced (any struct
    columns stay nested and remain queryable via dot access)."""
    existing = set(existing_names or ())
    # .422: descend plain STRUCT wrappers. Sophis-style tables carry ONE
    # top-level STRUCT ("json") with every array buried inside it -- the
    # top-level-only scan planned nothing ("won't flatten") and the
    # struct-only branch kept the blob nested (the "partial JSON").
    nested_lists = []    # [(path_parts, type)] -- dotted child sources
    wrap_leaves = []     # [(path_parts, type)] -- dotted root columns
    wrapper_cols = []    # top-level structs we explode onto the root
    for c, t in coltypes.items():
        if _type_is_list(t):
            nested_lists.append(([c], t))
        elif _type_is_struct(t):
            wrapper_cols.append(c)
            _walk_nested([c], t, nested_lists, wrap_leaves)
    list_cols = ["|".join(p) for p, _t in nested_lists]  # legacy field
    struct_arr = {"|".join(p) for p, t in nested_lists
                  if _type_is_struct_list(t)}

    if detect and key is None:
        key = detect_key_column(coltypes)
    synthesized = key is None

    # A synthesized key uses one consistent name on root + children (join/filter
    # on a single column); a detected business key gets the <root>_id FK name.
    fk_col = fk_name or (synth_key if synthesized else
                         "%s%s" % (root_name, fk_suffix))
    stmts = []
    cleanup = []

    if not nested_lists and not wrapper_cols:
        # Truly flat (no arrays anywhere, no struct wrappers): a single
        # keyed table, unchanged behavior.
        if synthesized:
            root_sql = ("CREATE TABLE %s AS SELECT row_number() OVER () AS %s, "
                        "* FROM %s"
                        % (_qi(root_name), _qi(synth_key), _qi(table)))
            key_ref = synth_key
        else:
            root_sql = ("CREATE TABLE %s AS SELECT * FROM %s"
                        % (_qi(root_name), _qi(table)))
            key_ref = key
        stmts.append({"target": root_name, "kind": "root", "sql": root_sql})
        return {"statements": stmts, "cleanup": cleanup, "root": root_name,
                "children": {}, "key": key_ref, "fk": fk_col,
                "synthesized": synthesized, "list_cols": [], "hub": None}

    # Arrays present -> the root + children read from a keyed copy
    # (synthesized key materialized once, identical across every child
    # query). Wrappers-without-arrays need NO staging (there are no
    # children to align): the key is synthesized inline on the root.
    if synthesized and not nested_lists:
        src = table
        key_ref = synth_key
    elif synthesized:
        keyed = "%s_src_%s" % (synth_key, root_name)
        i = 0
        while keyed in existing:
            i += 1
            keyed = "%s_src_%s_%d" % (synth_key, root_name, i)
        stmts.append({
            "target": keyed, "kind": "staging",
            "sql": ("CREATE TABLE %s AS SELECT row_number() OVER () AS %s, * "
                    "FROM %s" % (_qi(keyed), _qi(synth_key), _qi(table))),
        })
        cleanup.append(keyed)
        src = keyed
        key_ref = synth_key
    else:
        src = table
        key_ref = key

    # --- root ---------------------------------------------------------
    # Top-level scalars stay as-is; top-level LIST columns and the
    # exploded wrapper structs are excluded; every scalar/MAP leaf found
    # under a wrapper comes back as a dotted column with a readable
    # sep-joined alias -- so the root is actually FLAT, not a struct
    # blob (.422, the "partial JSON" fix).
    top_lists = {p[0] for p, _t in nested_lists if len(p) == 1}
    excl_cols = sorted(top_lists | set(wrapper_cols))
    sel = []
    if synthesized and not nested_lists:
        sel.append("row_number() OVER () AS %s" % _qi(synth_key))
    if excl_cols:
        sel.append("* EXCLUDE (%s)" % ", ".join(_qi(c) for c in excl_cols))
    else:
        sel.append("*")
    used_alias = set(coltypes) - set(excl_cols)
    for parts, _t in wrap_leaves:
        sel.append("%s AS %s"
                   % (_dotted(parts), _qi(_leaf_alias(parts, sep,
                                                      used_alias))))
    root_sql = ("CREATE TABLE %s AS SELECT %s FROM %s"
                % (_qi(root_name), ", ".join(sel), _qi(src)))
    stmts.append({"target": root_name, "kind": "root", "sql": root_sql})

    # --- one child table per array column ----------------------------------
    children = {}
    used = set(existing) | {root_name}
    # .501: child tables are named by their ELEMENT PATH ("json", "json_legs"),
    # not "<file>_json_legs" -- the file name lives on the ROOT only, so the
    # sidebar reads as a hierarchy instead of every table repeating the file
    # name. ``child_prefix`` controls it: None keeps the historical
    # root-prefixed names (used by the RECURSIVE re-flatten of a child, whose
    # root IS the element path, so grandchildren still read "json_legs");
    # "" (the top-level call) drops the prefix. The `used` loop keeps names
    # unique against the whole existing catalog either way, so two loaded
    # files that both carry a "json" element cannot clobber each other.
    _pref = root_name if child_prefix is None else child_prefix
    for parts, _t in nested_lists:
        tag = "|".join(parts)
        _path = sep.join(_sanitize_suffix(p) for p in parts)
        base = ("%s%s%s" % (_pref, sep, _path)) if _pref else _path
        child = base
        i = 0
        while child in used:
            i += 1
            child = "%s%s%d" % (base, sep, i)
        used.add(child)
        children[child] = ".".join(parts)
        src_expr = _dotted(parts)
        if tag in struct_arr:
            # struct array -> expand the element struct into columns
            sql = ("CREATE TABLE %s AS WITH _x AS (SELECT %s AS %s, "
                   "UNNEST(%s) AS _e FROM %s WHERE %s IS NOT NULL) "
                   "SELECT %s, _e.* FROM _x"
                   % (_qi(child), _qi(key_ref), _qi(fk_col), src_expr,
                      _qi(src), src_expr, _qi(fk_col)))
        else:
            # scalar array -> a single value column
            sql = ("CREATE TABLE %s AS SELECT %s AS %s, UNNEST(%s) AS %s "
                   "FROM %s WHERE %s IS NOT NULL"
                   % (_qi(child), _qi(key_ref), _qi(fk_col), src_expr,
                      _qi("value"), _qi(src), src_expr))
        stmts.append({"target": child, "kind": "child", "sql": sql})

    # --- joinkeys hub (.422, the .406 promise) --------------------------
    # One slim table every child joins through: the row key plus up to
    # five identifier-ish scalar leaves (code / id / isin / ...).
    hub = None
    if children:
        idents = []
        for parts, _t in wrap_leaves:
            last = parts[-1].lower()
            if (last in _HUB_IDENTS
                    or last.endswith("_id") or last.endswith("code")):
                idents.append(parts)
            if len(idents) >= 5:
                break
        base = "%s%sjoinkeys" % (root_name, sep)
        hub = base
        i = 0
        while hub in used:
            i += 1
            hub = "%s%s%d" % (base, sep, i)
        used.add(hub)
        hub_used = {fk_col}
        hsel = ["%s AS %s" % (_qi(key_ref), _qi(fk_col))]
        for parts in idents:
            hsel.append("%s AS %s"
                        % (_dotted(parts),
                           _qi(_leaf_alias(parts, sep, hub_used))))
        stmts.append({
            "target": hub, "kind": "hub",
            "sql": ("CREATE TABLE %s AS SELECT %s FROM %s"
                    % (_qi(hub), ", ".join(hsel), _qi(src))),
        })

    return {
        "statements": stmts,
        "cleanup": cleanup,
        "root": root_name,
        "children": children,
        "key": key_ref,
        "fk": fk_col,
        "synthesized": synthesized,
        "list_cols": list_cols,
        "hub": hub,
    }


def read_json_any_format(path):
    """Read a JSON file that may be: a single object, an array, NDJSON
    (one object per line), or concatenated JSON values. Returns a list
    of records. Tries several encodings before giving up."""
    encodings = ("utf-8", "utf-8-sig", "latin-1")
    last_exc = None
    for enc in encodings:
        try:
            with open(path, "r", encoding=enc) as f:
                data = _json_load(f)
            return data if isinstance(data, list) else [data]
        except UnicodeDecodeError as e:
            last_exc = e
            continue
        except json.JSONDecodeError as e:
            last_exc = e
            break
    # NDJSON
    try:
        objs = []
        all_ok = True
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    objs.append(_json_loads(stripped))
                except json.JSONDecodeError:
                    all_ok = False
                    break
        if all_ok and objs:
            return objs
    except Exception as e:
        last_exc = e
    # Concatenated JSON values
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        if text.startswith("\ufeff"):
            text = text[1:]
        decoder = json.JSONDecoder()
        objs = []
        i, n = 0, len(text)
        while i < n:
            while i < n and text[i] in " \t\r\n,":
                i += 1
            if i >= n:
                break
            if text[i] in "[]":
                i += 1
                continue
            try:
                obj, end = decoder.raw_decode(text, i)
            except json.JSONDecodeError:
                if objs:
                    break
                raise
            objs.append(obj)
            i = end
        if objs:
            if all(isinstance(o, list) for o in objs):
                flat = []
                for o in objs:
                    flat.extend(o)
                return flat
            return objs
    except Exception as e:
        last_exc = e
    raise ValueError(
        f"Could not parse JSON file: {path}\n"
        f"Last error: {type(last_exc).__name__}: {last_exc}")


def _detect_first_char(path, enc):
    """Return the first non-whitespace character of the file (decoded with
    ``enc``), or '' if the file is empty/all-whitespace. Raises
    UnicodeDecodeError if the bytes aren't valid for ``enc``."""
    with open(path, "r", encoding=enc) as f:
        while True:
            chunk = f.read(4096)
            if not chunk:
                return ""
            s = chunk.lstrip()
            if s:
                return s[0]


def _text_chunks(f, size=65536):
    while True:
        chunk = f.read(size)
        if not chunk:
            return
        yield chunk


# Streaming JSON readers decode by advancing an index into a buffer (never
# re-slicing off the front after every value) and, when one value runs past the
# buffer, read a GROWING chunk to complete it. The previous readers re-ran
# raw_decode from the start of a growing buffer and copied the tail after every
# value (buf = buf[end:]); both are quadratic in the size of an individual
# value, so a file of ~1.7 MB records read in 64 KB chunks spent almost all its
# time re-scanning partially read values (throughput collapsed from ~47 MB/s at
# 77 KB records to ~3 MB/s at 4 MB records). Index + growing reads keeps
# throughput flat regardless of how large individual records are.
_READ_BASE = 1 << 20    # 1 MB first read for a value
_READ_CAP = 1 << 24     # grow up to 16 MB while completing one very large value


def _iter_concat_values(f, on_read=None):
    """Stream JSON values from a single object, NDJSON/JSONL, or concatenated
    values, decoding incrementally so the whole file is never held in memory
    (only one value plus a read buffer at a time).

    ``on_read`` (optional) is called after every raw read -- it polls for
    cancellation (raising to abort) and stamps a heartbeat, so even a single
    very large value stays cancellable mid-read and never looks like a stall."""
    scan = json.JSONDecoder().raw_decode
    buf = ""
    pos = 0
    while True:
        L = len(buf)
        while pos < L and buf[pos] <= " ":       # skip inter-value whitespace
            pos += 1
        if pos >= L:                             # buffer drained -> read more
            buf = ""
            pos = 0
            chunk = f.read(_READ_BASE)
            if on_read is not None:
                on_read()
            if not chunk:
                return
            buf += chunk
            continue
        rsize = _READ_BASE
        while True:
            try:
                obj, end = scan(buf, pos)        # decode one value at pos
                break
            except ValueError:                   # value runs past buffer end
                if pos:
                    buf = buf[pos:]              # drop consumed prefix (rare)
                    pos = 0
                chunk = f.read(rsize)
                if on_read is not None:
                    on_read()
                if not chunk:                    # EOF mid-value
                    tail = buf.strip()
                    if not tail:
                        return
                    obj, end = scan(tail, 0)     # raises on a malformed tail
                    yield obj
                    return
                buf += chunk
                if rsize < _READ_CAP:
                    rsize <<= 1                  # grow the read for big values
        yield obj
        pos = end


def _iter_stream_records(f, on_read=None):
    """Yield individual top-level JSON records, streaming with bounded memory,
    and correctly handle a *stream of concatenated* top-level values -- one or
    more arrays and/or bare objects written back-to-back, the shape some
    exporters emit instead of one well-formed array.

    A top-level array is unwrapped element-by-element (only the current element
    plus a read buffer is ever held, so a multi-GB array never lands in memory
    at once); a bare object or scalar is yielded whole; and -- the crucial
    difference from a single-array reader -- after each top-level value the scan
    continues to the next one instead of stopping at the first array's closing
    ``]`` (which silently drops everything after it). Handles a single array,
    concatenated arrays, concatenated objects, NDJSON, and any mix.

    ``on_read`` (optional) runs after every raw chunk read: it polls for
    cancellation (raising to abort promptly, even mid-record) and stamps a
    heartbeat so a slow read is never mistaken for a stall."""
    dec = json.JSONDecoder()
    scan = dec.raw_decode
    buf = [""]
    pos = [0]
    produced = [0]   # count of records yielded (for the not-JSON-at-all check)

    def _fill(rsize):
        # drop the consumed prefix (so a later scan never re-scans it) then read
        # a (growing) chunk; returns False at EOF.
        if pos[0]:
            buf[0] = buf[0][pos[0]:]
            pos[0] = 0
        chunk = f.read(rsize)
        if on_read is not None:
            on_read()                 # cancel-check + heartbeat (may raise)
        if not chunk:
            return False
        buf[0] += chunk
        return True

    def _skip_ws():
        # advance past whitespace between values; read more if the buffer ends
        # mid-whitespace. Returns False at EOF.
        while True:
            b = buf[0]
            p = pos[0]
            L = len(b)
            while p < L and b[p] <= " ":
                p += 1
            pos[0] = p
            if p < L:
                return True
            if not _fill(_READ_BASE):
                return False

    def _decode_value():
        # decode one complete JSON value at pos, growing the read while partial;
        # returns (obj, end) or None at EOF (incomplete trailing value).
        rsize = _READ_BASE
        while True:
            try:
                return scan(buf[0], pos[0])
            except ValueError:
                if not _fill(rsize):
                    return None
                if rsize < _READ_CAP:
                    rsize <<= 1

    while True:
        if not _skip_ws():
            return
        if buf[0][pos[0]] == "[":
            pos[0] += 1               # enter this array
            while True:
                if not _skip_ws():
                    return            # unterminated array: stop gracefully
                c = buf[0][pos[0]]
                if c == ",":
                    pos[0] += 1
                    continue
                if c == "]":
                    pos[0] += 1       # end of this array; resume outer scan
                    break
                got = _decode_value()
                if got is None:
                    return            # cannot complete the final element
                obj, end = got
                pos[0] = end
                produced[0] += 1
                yield obj
        else:
            # A bare top-level value (object / scalar): NDJSON, concatenated
            # objects, or an object between arrays. Decode it whole and go on.
            got = _decode_value()
            if got is None:
                if produced[0]:
                    return            # truncated tail after valid records: stop
                tail = buf[0][pos[0]:].strip()
                if not tail:
                    return            # genuinely empty -> no records (not error)
                # Nothing decoded and the content is not JSON (e.g. an HTML login
                # page whose body starts with '<'). Re-run the decode so the
                # natural JSONDecodeError propagates -- callers turn it into a
                # human "the endpoint did not return JSON" message rather than a
                # silent zero-record load.
                dec.raw_decode(tail, 0)   # raises JSONDecodeError
                return
            obj, end = got
            pos[0] = end
            produced[0] += 1
            yield obj


def _iter_array_elements(f, on_read=None):
    """Stream the top-level elements of a JSON array one at a time, with
    bounded memory (only the current element plus a read buffer).

    ``on_read`` (optional) is called after every raw chunk read from the file.
    It polls for cancellation (raising to abort promptly) and stamps a
    heartbeat -- so a giant single element, which is assembled over many chunk
    reads before it can be decoded, is still cancellable mid-read and keeps the
    operation off the stall list instead of looking hung."""
    dec = json.JSONDecoder()
    chunks = _text_chunks(f)
    buf = ""

    def _more():
        c = next(chunks)              # raises StopIteration at EOF
        if on_read is not None:
            on_read()                 # cancel-check + heartbeat (may raise)
        return c

    # consume up to and including the opening bracket
    while True:
        s = buf.lstrip()
        if s.startswith("["):
            buf = s[1:]
            break
        if s and s[0] != "[":
            raise ValueError("expected '[' at start of JSON array")
        try:
            buf += _more()
        except StopIteration:
            raise ValueError("unterminated or empty JSON array")
    while True:
        buf = buf.lstrip()
        while buf[:1] == ",":
            buf = buf[1:].lstrip()
        if buf[:1] == "]":
            return
        if not buf:
            try:
                buf += _more()
            except StopIteration:
                return  # unterminated array: stop gracefully
            continue
        try:
            obj, end = dec.raw_decode(buf)
        except ValueError:
            try:
                buf += _more()
            except StopIteration:
                return  # cannot complete the final element
            continue
        yield obj
        buf = buf[end:]


class _CountingReader:
    """Wrap a binary file so byte reads accumulate a progress count. ijson
    pulls data via ``.read()``; we forward it and report the position
    best-effort every ~256 KB so a flatten can show read progress. It also
    polls for cancellation on every read (so a Stop aborts even a single huge
    array element ijson is buffering) and stamps a heartbeat, keeping the op
    off the stall list."""

    def __init__(self, fb, progress, total, should_cancel=None):
        self._fb = fb
        self._progress = progress
        self._total = total
        self._should_cancel = should_cancel
        self._count = 0
        self._since = 0

    def read(self, size=-1):
        if self._should_cancel is not None and self._should_cancel():
            raise InterruptedError("cancelled during JSON read")
        first = self._count == 0
        chunk = self._fb.read(size)
        self._count += len(chunk)
        self._since += len(chunk)
        # Heartbeat on the first read and then every ~256 KB, so even a modest
        # file stamps at least one beat (a bare beat() updates the op on this
        # thread -> off the stall list). Progress is reported only when a
        # callback + total are known.
        if chunk and (first or self._since >= 262144):
            self._since = 0
            try:
                _opreg.beat()
            except Exception:
                pass
            if self._progress is not None and self._total:
                try:
                    self._progress(min(self._count, self._total), self._total)
                except Exception:
                    pass
        return chunk

    def close(self):
        try:
            self._fb.close()
        except Exception:
            pass


def stream_json_records(path, progress=None, should_cancel=None):
    """Yield top-level JSON records one at a time with bounded memory.

    Handles a single object, a (possibly very large) array, NDJSON/JSONL,
    and concatenated JSON values. Uses ``ijson`` for arrays when it is
    installed (C-accelerated, fully streaming) and otherwise a pure-stdlib
    incremental parser. Falls back to the tolerant whole-file reader only
    if streaming can't even determine the encoding.

    ``progress(bytes_done, bytes_total)`` (optional) is called periodically
    with the approximate read position so a caller can show progress.
    ``should_cancel`` (optional, a no-arg predicate) is polled on every raw
    chunk read -- so a Stop aborts the read promptly even in the middle of one
    enormous record, not just between records -- raising ``InterruptedError``.
    On every chunk a throttled heartbeat is also stamped (a bare ``beat()``
    updates the op running on this thread), so a slow read is never mistaken
    for a stall.
    """
    total = None
    if progress:
        try:
            total = os.path.getsize(path)
        except Exception:
            total = None

    _last = [0.0]

    def _tick(fobj):
        # Called after every raw chunk read. Cancel is checked every time (so a
        # Stop lands inside a single huge record, not only between records); the
        # heartbeat + progress report are throttled to ~150 ms so they add no
        # measurable cost on a fast stream.
        if should_cancel is not None and should_cancel():
            raise InterruptedError("cancelled during JSON read")
        now = time.monotonic()
        if now - _last[0] < 0.15:
            return
        _last[0] = now
        try:
            _opreg.beat()
        except Exception:
            pass
        if progress and total:
            try:
                b = getattr(fobj, "buffer", None)
                pos = b.tell() if b is not None else fobj.tell()
                progress(min(int(pos), total), total)
            except Exception:
                pass

    chosen = None
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            first = _detect_first_char(path, enc)
            chosen = enc
            break
        except UnicodeDecodeError:
            continue
    if chosen is None:
        for rec in read_json_any_format(path):
            yield rec
        return
    if first == "":
        return
    if first == "[":
        # Optional fast path: ijson streams array items natively. ijson's
        # items() rebuilds each object from parse events in Python, which for
        # deeply nested records can be much slower than the stdlib C decoder;
        # set SAMQL_JSON_READER=stdlib to force the (also streaming, bounded-
        # memory) raw_decode reader below and skip ijson entirely.
        force_stdlib = os.environ.get("SAMQL_JSON_READER", "").lower() == "stdlib"
        try:
            import ijson  # optional dependency
            have_ijson = not force_stdlib
        except Exception:
            have_ijson = False
        if have_ijson:
            yielded = 0
            try:
                with open(path, "rb") as fb:
                    # Always wrap: the counting reader stamps heartbeats and
                    # polls cancel on every read, so an ijson read is never
                    # mistaken for a stall and stays interruptible even when no
                    # progress callback was supplied. (It is already the reader
                    # used on the progress path, so this is not a new code path
                    # for ijson.)
                    src = _CountingReader(fb, progress, total, should_cancel)
                    # Plain items() streams the FIRST top-level array's elements
                    # with bounded memory (the fast path for a normal single
                    # array). If the file is a *concatenated* stream -- more than
                    # one top-level array/object back to back -- ijson raises
                    # after the first value's end (it parses one document by
                    # default). That is caught below and the whole file is
                    # re-read with the stdlib concat-aware reader, which yields
                    # every record across all values (arrays unwrapped, bare
                    # objects included). Do NOT pass multiple_values here: it
                    # suppresses that raise AND skips bare objects between arrays,
                    # so a mixed stream would silently lose records.
                    for item in ijson.items(src, "item"):
                        yielded += 1
                        yield item
                if progress and total:
                    progress(total, total)
                return
            except InterruptedError:
                # A cancel during the ijson read must abort, NOT fall through to
                # the stdlib recovery (which would re-read the file from scratch
                # and ignore the Stop).
                raise
            except Exception:
                # ijson (yajl) is stricter than Python's json and rejects some
                # inputs the stdlib tolerates -- notably the non-standard
                # NaN / Infinity literals. Recover by switching to the tolerant
                # stdlib array parser, skipping the records already emitted so
                # none are duplicated.
                skip = yielded
                with open(path, "r", encoding=chosen, errors="replace") as f:
                    for i, rec in enumerate(
                            _iter_stream_records(f, on_read=lambda: _tick(f))):
                        if i >= skip:
                            yield rec
                return
        with open(path, "r", encoding=chosen, errors="replace") as f:
            for rec in _iter_stream_records(f, on_read=lambda: _tick(f)):
                yield rec
        return
    # Anything not starting with '[' (a bare object, NDJSON, or concatenated
    # objects/arrays in any mix). Use the array-aware streaming reader: it
    # decodes concatenated top-level values with the index + growing-read method
    # AND unwraps any top-level array element-by-element, so an embedded array in
    # an object-first stream is streamed (bounded memory) rather than buffered
    # whole. Output is identical to decoding each value whole -- the flattener
    # iterates a whole-array record the same way -- but memory stays bounded and
    # large arrays get the fast path too.
    with open(path, "r", encoding=chosen, errors="replace") as f:
        for rec in _iter_stream_records(f, on_read=lambda: _tick(f)):
            yield rec


class JSONFlattener:
    # How deep nested objects / arrays are exploded into child tables before a
    # still-nested value is kept verbatim (stringified) instead of recursing.
    # Guards against a RecursionError on a pathologically deep document; well
    # above anything real JSON produces.
    _MAX_NEST_DEPTH = 64

    def __init__(self, separator="_", root_name="root",
                 spill_threshold=0, spill_dir=None, progress_cb=None,
                 exclude=None):
        self.sep = separator
        self.root_name = root_name
        # Selective flattening: keys/paths the caller does NOT want flattened.
        # A bare token (e.g. "cashFlows") skips that key wherever it appears --
        # its column AND, if it is an array/object, the child table(s) it would
        # have produced. A dotted token (e.g. "payingLeg.swapStream") skips that
        # branch by prefix, relative to each record. Skipping a heavy array is
        # the big lever on a swap-style file: it removes the rows entirely, not
        # just speeds them up.
        self._exclude_keys = set()
        self._exclude_paths = set()
        for tok in (exclude or []):
            tok = str(tok).strip()
            if not tok:
                continue
            parts = tuple(p for p in tok.split(".") if p)
            if len(parts) == 1:
                self._exclude_keys.add(parts[0])
            elif len(parts) > 1:
                self._exclude_paths.add(parts)
        self.tables = defaultdict(list)
        self._counters = defaultdict(int)
        self._spill_threshold = int(spill_threshold or 0)
        self._spill_dir = spill_dir
        self._progress_cb = progress_cb
        self._col_order = defaultdict(list)
        self._seen_cols = defaultdict(set)
        # Map each original key PATH to the column name it was assigned, per
        # table, plus the set of names already in use. Two distinct source keys
        # that sanitize to the same name (e.g. "a b", "a_b", a nested "a.b", or
        # a flat key colliding with a nested path) get disambiguated instead of
        # silently overwriting each other -- and the mapping is stable across
        # records, so ragged inputs stay column-aligned.
        self._col_for_path = defaultdict(dict)
        self._cols_in_use = defaultdict(set)
        self._row_counts = defaultdict(int)
        self._spill_writers = {}
        self._spill_paths = {}
        self._emit_total = 0
        self._own_spill_dir = False
        if self._spill_threshold and not self._spill_dir:
            try:
                from . import tmputil
                self._spill_dir = tempfile.mkdtemp(
                    prefix="samql_jf_", dir=tmputil.instance_dir())
            except Exception:
                self._spill_dir = tempfile.mkdtemp(
                    prefix="samql_jf_", dir=None)  # last resort: system temp
            self._own_spill_dir = True

    def _next_id(self, table):
        self._counters[table] += 1
        return self._counters[table]

    def _is_excluded(self, path):
        """True if this key PATH (a tuple of keys from the current record root)
        should be skipped -- either a bare excluded key appears anywhere in it,
        or an excluded dotted path is a prefix of it."""
        if self._exclude_keys:
            for key in path:
                if key in self._exclude_keys:
                    return True
        if self._exclude_paths:
            for ex in self._exclude_paths:
                if len(ex) <= len(path) and path[:len(ex)] == ex:
                    return True
        return False

    def _emit(self, table, row):
        buf = self.tables[table]
        buf.append(row)
        seen = self._seen_cols[table]
        order = self._col_order[table]
        for k in row:
            if k not in seen:
                seen.add(k)
                order.append(k)
        self._row_counts[table] += 1
        self._emit_total += 1
        if self._spill_threshold and len(buf) >= self._spill_threshold:
            self._spill_table(table)
        cb = self._progress_cb
        if cb is not None and (self._emit_total % 5000 == 0):
            try:
                cb(self._emit_total)
            except Exception as _e:
                # A cancel signal (the progress callback raising LoadCancelled
                # when Stop is pressed) MUST propagate so the flatten aborts
                # mid-parse; only genuine progress-reporting errors are
                # swallowed. Matched by class name to avoid importing loaders
                # here, which would be a circular import.
                if type(_e).__name__ == "LoadCancelled":
                    raise

    def _spill_table(self, table):
        buf = self.tables.get(table)
        if not buf:
            return
        w = self._spill_writers.get(table)
        if w is None:
            idx = len(self._spill_writers)
            safe = self._sanitize(table)[:40]
            path = os.path.join(self._spill_dir, f"_jf_{idx}_{safe}.pkl")
            w = open(path, "ab")
            self._spill_writers[table] = w
            self._spill_paths[table] = path
        dump = pickle.dump
        proto = pickle.HIGHEST_PROTOCOL
        for r in buf:
            dump(r, w, protocol=proto)
        w.flush()
        buf.clear()

    def table_names(self):
        names = list(self.tables.keys())
        for t in self._col_order:
            if t not in self.tables:
                names.append(t)
        return names

    def columns(self, table):
        return list(self._col_order.get(table, []))

    def row_count(self, table):
        if table in self._row_counts:
            return self._row_counts[table]
        return len(self.tables.get(table, []))

    def iter_rows(self, table):
        path = self._spill_paths.get(table)
        if path:
            w = self._spill_writers.get(table)
            if w is not None and not w.closed:
                try:
                    w.flush()
                    w.close()
                except Exception:
                    pass
            try:
                with open(path, "rb") as rf:
                    load = pickle.load
                    while True:
                        try:
                            yield load(rf)
                        except EOFError:
                            break
            except FileNotFoundError:
                pass
        for r in self.tables.get(table, []):
            yield r

    @staticmethod
    def _sqlite_value(v):
        # SQLite binds Python ints as 64-bit signed; anything larger raises
        # OverflowError, and Decimals raise outright. Coerce both to a
        # lossless text form so a JSON file with big integers or
        # high-precision decimals loads cleanly instead of crashing.
        if v is None or isinstance(v, (str, bytes)):
            return v
        if isinstance(v, int):  # includes bool (0/1), which is fine
            if -9223372036854775808 <= v <= 9223372036854775807:
                return v
            return str(v)
        if isinstance(v, float):
            return v
        if isinstance(v, decimal.Decimal):
            try:
                if v == v.to_integral_value():
                    iv = int(v)
                    if -9223372036854775808 <= iv <= 9223372036854775807:
                        return iv
                    return str(iv)
                f = float(v)
                if f == f and f not in (float("inf"), float("-inf")):
                    return f
                return str(v)
            except Exception:
                return str(v)
        if isinstance(v, (dict, list)):
            return json.dumps(v, default=str)
        iso = getattr(v, "isoformat", None)
        if callable(iso):
            try:
                return iso()
            except Exception:
                pass
        return str(v)

    def iter_rows_aligned(self, table):
        cols = self.columns(table)
        coerce = self._sqlite_value
        for r in self.iter_rows(table):
            yield tuple(coerce(r.get(c)) for c in cols)

    def close(self):
        for w in list(self._spill_writers.values()):
            try:
                if not w.closed:
                    w.close()
            except Exception:
                pass
        self._spill_writers.clear()
        for p in list(self._spill_paths.values()):
            try:
                os.remove(p)
            except Exception:
                pass
        self._spill_paths.clear()
        if self._own_spill_dir and self._spill_dir:
            try:
                shutil.rmtree(self._spill_dir, ignore_errors=True)
            except Exception:
                pass
            self._own_spill_dir = False

    @staticmethod
    def _sanitize(name):
        s = "".join(ch if (ch.isalnum() or ch == "_") else "_"
                    for ch in str(name))
        if s and s[0].isdigit():
            s = "_" + s
        s = s.strip("_")
        return s or "col"

    def add_record(self, record):
        """Flatten a single top-level record incrementally. Used by the
        streaming loader so the input is never fully held in memory."""
        self._add_record(record, self._sanitize(self.root_name), None, None)

    def flatten(self, data):
        root = self._sanitize(self.root_name)
        if isinstance(data, list):
            for item in data:
                self._add_record(item, root, None, None)
        else:
            self._add_record(data, root, None, None)
        return dict(self.tables)


    def _add_record(self, record, table_name, parent_id, parent_table):
        if record is None:
            return
        if isinstance(record, list):
            for item in record:
                self._add_record(item, table_name, parent_id, parent_table)
            return
        if not isinstance(record, dict):
            rid = self._next_id(table_name)
            row = {"_id": rid, "value": record}
            if parent_id is not None and parent_table:
                row[f"{parent_table}_id"] = parent_id
            self._emit(table_name, row)
            return
        rid = self._next_id(table_name)
        row = {"_id": rid}
        if parent_id is not None and parent_table:
            row[f"{parent_table}_id"] = parent_id
        nested_arrays = []

        colmap = self._col_for_path[table_name]
        in_use = self._cols_in_use[table_name]
        for fixed in row:
            in_use.add(fixed)  # reserve _id / parent FK so data keys avoid them

        def col_for(path):
            existing = colmap.get(path)
            if existing is not None:
                return existing
            base = self._sanitize(self.sep.join(path))
            name, k = base, 2
            while name in in_use:
                name = "%s_%d" % (base, k)
                k += 1
            in_use.add(name)
            colmap[path] = name
            return name

        has_exclude = bool(self._exclude_keys or self._exclude_paths)

        def walk(obj, prefix_path, depth):
            for k, v in obj.items():
                path = prefix_path + (str(k),)
                if has_exclude and self._is_excluded(path):
                    continue  # skip this key: no column, no child table
                if isinstance(v, dict):
                    if depth >= self._MAX_NEST_DEPTH:
                        row[col_for(path)] = v  # too deep: keep as a JSON value
                    else:
                        walk(v, path, depth + 1)
                elif isinstance(v, list):
                    nested_arrays.append((col_for(path), v))
                else:
                    row[col_for(path)] = v

        walk(record, (), 0)
        self._emit(table_name, row)
        for arr_name, arr_value in nested_arrays:
            child_table = self._sanitize(f"{table_name}{self.sep}{arr_name}")
            self._emit_array(arr_value, child_table, rid, table_name, 1)

    def _emit_array(self, arr, table_name, parent_id, parent_table, depth):
        """Emit one array as a child table, one element at a time. Objects
        become child rows (recursing into their own nested structure); scalars
        become a one-column ``value`` row; a nested array becomes an anchor row
        plus a deeper ``<table>_items`` child, recursing to any depth. Past
        ``_MAX_NEST_DEPTH`` a still-nested array is kept as a JSON value rather
        than recursing, so a pathologically deep document degrades gracefully
        instead of overflowing the stack. The 1- and 2-level output is
        byte-identical to the original hand-rolled version; only arrays nested
        three or more deep change -- they are now exploded into child rows
        instead of being stringified at the third level."""
        fk = (f"{parent_table}_id"
              if (parent_id is not None and parent_table) else None)
        for item in arr:
            if isinstance(item, dict):
                self._add_record(item, table_name, parent_id, parent_table)
            elif isinstance(item, list):
                cid = self._next_id(table_name)
                row = {"_id": cid}
                if fk:
                    row[fk] = parent_id
                if depth >= self._MAX_NEST_DEPTH:
                    row["value"] = item  # too deep: keep as a JSON value
                    self._emit(table_name, row)
                else:
                    self._emit(table_name, row)
                    inner = self._sanitize(f"{table_name}{self.sep}items")
                    self._emit_array(item, inner, cid, table_name, depth + 1)
            else:
                cid = self._next_id(table_name)
                row = {"_id": cid}
                if fk:
                    row[fk] = parent_id
                row["value"] = item
                self._emit(table_name, row)
