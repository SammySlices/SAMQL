"""Shared diagnostics: an extensible registry of checks used by the CLI
(tools/diag_load.py), the server (/api/diagnostics), and the Settings ->
Diagnostics modal in the UI. Write a diagnostic once here and it is available
everywhere.

A diagnostic is a callable ``fn(session, **params) -> dict``. Register it with
the ``@diagnostic(...)`` decorator and it shows up in ``list_diagnostics()`` for
the UI to render (with its declared params) and can be executed via ``run()``.
To add a future check (e.g. an engine health probe, a temp-dir audit, a config
dump), write a function, decorate it, and it appears in the modal automatically.
"""
import importlib.util as _ilu
import io
import os
import platform
import time

_REGISTRY = {}   # name -> {"fn", "label", "description", "params"}


def diagnostic(name, label, description="", params=None):
    """Register a diagnostic. ``params`` is a list of
    {name, label, type, default?} the UI renders as inputs (types: text, int,
    table, bool)."""
    def deco(fn):
        _REGISTRY[name] = {"fn": fn, "label": label,
                           "description": description, "params": params or []}
        return fn
    return deco


def list_diagnostics():
    """Metadata for every registered diagnostic, for the UI to render."""
    return [{"name": n, "label": d["label"], "description": d["description"],
             "params": d["params"]} for n, d in _REGISTRY.items()]


def run(name, session=None, **params):
    """Execute a diagnostic by name. Never raises: a failure comes back as
    {ok: False, error, traceback} so the UI can show it."""
    d = _REGISTRY.get(name)
    if not d:
        return {"ok": False, "name": name,
                "error": "Unknown diagnostic: %r" % name}
    try:
        return {"ok": True, "name": name, "result": d["fn"](session, **params)}
    except Exception as e:  # diagnostics must never crash the caller
        import traceback
        return {"ok": False, "name": name,
                "error": "%s: %s" % (type(e).__name__, e),
                "traceback": traceback.format_exc()}


# ---- shared helpers -------------------------------------------------

def _has(mod):
    try:
        return _ilu.find_spec(mod) is not None
    except Exception:
        return False


def feature_map():
    """Which optional accelerators / drivers are importable in this process."""
    return {m: _has(m) for m in
            ("duckdb", "ijson", "orjson", "pyarrow", "sqlglot",
             "pyodbc", "openpyxl", "pandas")}


def _ram_gb():
    try:
        from .engines import total_physical_ram_bytes
        return round(total_physical_ram_bytes() / (1024 ** 3), 1)
    except Exception:
        return None


# ---- diagnostic: environment ---------------------------------------

@diagnostic("environment", "Environment & features",
            "Version, Python, platform, memory, and which optional accelerators "
            "are present. The first thing to check when behaviour differs "
            "between machines.")
def env_report(session=None, **_):
    from . import __version__, BUILD
    feats = feature_map()
    try:
        from .loaders import JSON_SPILL_ROWS
        spill = JSON_SPILL_ROWS
    except Exception:
        spill = None
    reader = os.environ.get("SAMQL_JSON_READER", "") or "auto"
    try:
        from . import load_thresholds as LT
        ondisk_v, ondisk_src = LT.get_raw("ondisk_mb")
        hard_v, hard_src = LT.get_raw("ondisk_hard_mb")
        ondisk_disp = "%s (%s)" % (ondisk_v, ondisk_src)
        hard_disp = "%s (%s)" % (hard_v, hard_src)
    except Exception:
        ondisk_disp = os.environ.get("SAMQL_ONDISK_MB") or "512 (default)"
        hard_disp = os.environ.get("SAMQL_ONDISK_HARD_MB") or "256 (default)"
    info = {
        "version": __version__,
        "build": BUILD,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "ram_gb": _ram_gb(),
        "features": feats,
        "json_reader": reader,
        "json_spill_rows": spill,
        "ondisk_mb": ondisk_disp,
        "ondisk_hard_mb": hard_disp,
    }
    if feats["ijson"] and reader == "auto":
        info["reader_note"] = ("Files starting with '[' are read with ijson; if "
                               "a load is slow, try SAMQL_JSON_READER=stdlib.")
    return info


# ---- diagnostic: JSON load profiler --------------------------------

def _resolve_path(session, table, path):
    if path:
        return str(path)
    if session and table:
        for mgr in (getattr(session, "duckdb", None),
                    getattr(session, "db", None)):
            if mgr is not None:
                # Prefer the ORIGINAL file (JSON/CSV) when the live source is a
                # Parquet cache -- sniffing / field trees need the text input,
                # not the converted cache path.
                origins = getattr(mgr, "table_origins", {}) or {}
                origin = origins.get(table)
                if origin and os.path.exists(str(origin)):
                    return str(origin)
                src = getattr(mgr, "table_sources", {}).get(table)
                if src and os.path.exists(str(src)):
                    return str(src)
    return None


def _needs_quote(ident):
    import re
    return bool(re.search(r'[^A-Za-z0-9_]', ident or "")) or not (
        ident and (ident[0].isalpha() or ident[0] == "_"))


def parse_duckdb_type(s):
    """Parse a DuckDB column type string into a small tree.

    Handles the nested types a flatten-off JSON load produces:
      STRUCT(name type, ...), <type>[] (list), MAP(k, v), and scalars (incl.
      parameterised ones like DECIMAL(18,2)). Field names may be double-quoted.
    Returns nodes shaped like:
      {"t":"scalar","type":"BIGINT"}
      {"t":"struct","fields":[(name, node), ...]}
      {"t":"list","of": node}
      {"t":"map","key":node,"val":node}
    Pure and defensive: anything it can't parse comes back as a scalar of the
    raw text, so it never raises on odd input."""
    s = (s or "").strip()
    i = [0]
    n = len(s)

    def ws():
        while i[0] < n and s[i[0]] in " \t\r\n":
            i[0] += 1

    def peek():
        return s[i[0]] if i[0] < n else ""

    def read_ident():
        ws()
        if peek() == '"':
            i[0] += 1
            buf = []
            while i[0] < n:
                ch = s[i[0]]
                if ch == '"':
                    if i[0] + 1 < n and s[i[0] + 1] == '"':
                        buf.append('"')
                        i[0] += 2
                        continue
                    i[0] += 1
                    break
                buf.append(ch)
                i[0] += 1
            return "".join(buf)
        start = i[0]
        while i[0] < n and s[i[0]] not in ' \t\r\n(),[]':
            i[0] += 1
        return s[start:i[0]]

    def parse():
        ws()
        ws_start = i[0]
        while i[0] < n and (s[i[0]].isalnum() or s[i[0]] == "_"):
            i[0] += 1
        word = s[ws_start:i[0]].upper()
        if word == "STRUCT":
            ws()
            if peek() == "(":
                i[0] += 1
            fields = []
            ws()
            guard = 0
            while peek() and peek() != ")" and guard < 10000:
                guard += 1
                fname = read_ident()
                ftype = parse()
                fields.append((fname, ftype))
                ws()
                if peek() == ",":
                    i[0] += 1
                    ws()
            if peek() == ")":
                i[0] += 1
            node = {"t": "struct", "fields": fields}
        elif word == "MAP":
            ws()
            if peek() == "(":
                i[0] += 1
            k = parse()
            ws()
            if peek() == ",":
                i[0] += 1
            v = parse()
            ws()
            if peek() == ")":
                i[0] += 1
            node = {"t": "map", "key": k, "val": v}
        else:
            typ = word
            ws()
            if peek() == "(":                    # parameterised scalar
                depth = 0
                ts = i[0]
                while i[0] < n:
                    c = s[i[0]]
                    if c == "(":
                        depth += 1
                    elif c == ")":
                        depth -= 1
                        if depth == 0:
                            i[0] += 1
                            break
                    i[0] += 1
                typ = word + s[ts:i[0]]
            node = {"t": "scalar", "type": typ or word or "?"}
        ws()
        while peek() == "[":                      # list suffix (maybe nested)
            i[0] += 1
            while peek() and peek() != "]":
                i[0] += 1
            if peek() == "]":
                i[0] += 1
            node = {"t": "list", "of": node}
            ws()
        return node

    try:
        return parse()
    except Exception:
        return {"t": "scalar", "type": s or "?"}


def _type_label(node):
    t = node.get("t")
    if t == "scalar":
        return node.get("type", "?")
    if t == "struct":
        return "STRUCT (%d field%s)" % (len(node.get("fields", [])),
                                        "" if len(node.get("fields", [])) == 1
                                        else "s")
    if t == "list":
        inner = node.get("of", {})
        return "LIST of " + _type_label(inner)
    if t == "map":
        return "MAP"
    return "?"


def flatten_type_tree(column, node, max_nodes=4000):
    """Walk a parsed type into a flat list of display rows for the structure
    view. Each row is {depth, name, type, kind, path, note}. `path` is the
    DuckDB expression to read that value from a row of the table (dotted struct
    access); arrays are marked so the reader knows to UNNEST. `kind` is one of
    scalar / struct / array / array-scalar / map."""
    rows = []

    def acc(name):
        return '"%s"' % name if _needs_quote(name) else name

    def walk(name, nd, depth, path, in_array):
        if len(rows) >= max_nodes:
            return
        t = nd.get("t")
        if t == "struct":
            rows.append({"depth": depth, "name": name, "type": _type_label(nd),
                         "kind": "struct",
                         "path": None if in_array else path,
                         "note": None})
            for (fn, fnode) in nd.get("fields", []):
                child_path = (None if in_array
                              else "%s.%s" % (path, acc(fn)))
                walk(fn, fnode, depth + 1, child_path, in_array)
        elif t == "list":
            of = nd.get("of", {})
            scalar_elem = of.get("t") == "scalar"
            rows.append({
                "depth": depth, "name": name,
                "type": _type_label(nd),
                "kind": "array-scalar" if scalar_elem else "array",
                "path": None if in_array else path,
                "note": ("UNNEST(%s) to get one row per element"
                         % path) if (path and not in_array) else
                        "nested array — UNNEST after expanding the parent"})
            # descend into the element type so the shape is visible; paths
            # inside an array are only valid after an UNNEST, so drop them
            walk("(element)", of, depth + 1, None, True)
        elif t == "map":
            rows.append({"depth": depth, "name": name, "type": "MAP",
                         "kind": "map", "path": None if in_array else path,
                         "note": "map/dictionary"})
        else:
            rows.append({"depth": depth, "name": name,
                         "type": nd.get("type", "?"), "kind": "scalar",
                         "path": None if in_array else path, "note": None})

    walk(column, node, 0, acc(column), False)
    return rows


def discover_load_fields(path, sample=0, time_budget_s=25):
    """Sample records from a JSON file and list the fields that contain nested
    structure -- arrays (which become child tables and multiply rows) and
    objects (which add nested columns) -- so the load UI can offer a checkbox
    per field to skip.

    A swap-style file front-loads small records and hides the heavy arrays deep
    in the file, so this is time-boxed rather than front-only: it scans as far
    as the budget allows, tracking distinct nested keys as it goes, and reports
    whether it covered the whole file. Each field: key, kind (array|object),
    min depth seen, how many sampled records had it, and (arrays) the largest
    element count seen. Skipping is by bare key, so one checkbox skips that key
    wherever it appears."""
    from .flatten import stream_json_records
    seen = {}
    n = 0
    t0 = time.monotonic()
    budget = float(time_budget_s or 25)
    cap = int(sample or 0)
    MAX_DEPTH = 40
    ELEM_SCAN = 8          # array elements to descend into (to find deeper arrays)

    def rec(key, kind, depth, items):
        e = seen.get(key)
        if e is None:
            e = {"key": key, "kind": kind, "depth": depth,
                 "count": 0, "max_items": 0}
            seen[key] = e
        if kind == "array":
            e["kind"] = "array"        # array wins over object for a shared name
        e["count"] += 1
        if depth < e["depth"]:
            e["depth"] = depth
        if items and items > e["max_items"]:
            e["max_items"] = items

    def walk(obj, depth):
        if depth > MAX_DEPTH:
            return
        if isinstance(obj, dict):
            for k, v in obj.items():
                key = str(k)
                if isinstance(v, list):
                    rec(key, "array", depth, len(v))
                    scanned = 0
                    for it in v:
                        if isinstance(it, (dict, list)):
                            walk(it, depth + 1)
                        scanned += 1
                        if scanned >= ELEM_SCAN:
                            break
                elif isinstance(v, dict):
                    rec(key, "object", depth, None)
                    walk(v, depth + 1)
        elif isinstance(obj, list):
            scanned = 0
            for it in obj:
                if isinstance(it, (dict, list)):
                    walk(it, depth + 1)
                scanned += 1
                if scanned >= ELEM_SCAN:
                    break

    def _over():
        return time.monotonic() - t0 > budget
    complete = True
    try:
        for r in stream_json_records(path, should_cancel=_over):
            walk(r, 0)
            n += 1
            if cap and n >= cap:
                break
            if (n & 31) == 0 and _over():
                complete = False
                break
    except InterruptedError:
        complete = False
    except Exception:
        complete = False
    fields = sorted(
        seen.values(),
        key=lambda e: (e["kind"] != "array", -e["max_items"], e["depth"],
                       e["key"]))
    return {"sampled": n, "complete": complete,
            "scan_s": round(time.monotonic() - t0, 2),
            "fields": fields}


def _json_path_seg(key):
    """A JSON-path segment for DuckDB, quoting keys that aren't simple."""
    import re
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key or ""):
        return "." + key
    return '."%s"' % (key or "").replace('"', '""')


def access_recipes(column, rows):
    """Attach an ``access`` recipe to every row of a flattened type tree: how to
    actually QUERY that field.

    For each node:
      first     -- the first-record expression, hopping arrays with [1]
                   (e.g. json[1].strike.strikePrice.currency)
      sel       -- the select expression for an all-rows query
      unnests   -- the FROM-clause UNNEST chain (one hop per enclosing array)
                   that makes ``sel`` valid, e.g.
                   UNNEST(json) AS x1(e1), UNNEST(e1.receivingLeg) AS x2(e2)
      recursive -- for an array node, the one-shot
                   UNNEST(<first>, recursive := true) expression
      note      -- map / opaque-JSON access hints

    Pure and engine-free: works on the parsed type alone, so it is fully
    testable without DuckDB. Mutates ``rows`` in place and returns them.
    ``rows`` must INCLUDE the depth-0 root row for the column itself."""
    def q(name):
        return '"%s"' % name.replace('"', '""') if _needs_quote(name) else name

    stack = []  # ancestors: dicts with depth/kind/first/all/unnests/alias_n
    counter = [0]

    def hop(parent):
        # one UNNEST hop: explode the parent's list value into element eN
        counter[0] += 1
        n = counter[0]
        return {
            "unnests": parent["unnests"]
            + ["UNNEST(%s) AS x%d(e%d)" % (parent["all"], n, n)],
            "all": "e%d" % n,
        }

    for r in rows:
        while stack and stack[-1]["depth"] >= r["depth"]:
            stack.pop()
        parent = stack[-1] if stack else None
        kind = r.get("kind")
        name = r.get("name") or ""
        if parent is None:
            ent = {"depth": r["depth"], "kind": kind, "first": q(column),
                   "all": q(column), "unnests": []}
        elif name == "(element)":
            h = hop(parent)
            ent = {"depth": r["depth"], "kind": kind,
                   "first": parent["first"] + "[1]",
                   "all": h["all"], "unnests": h["unnests"]}
        else:
            ent = {"depth": r["depth"], "kind": kind,
                   "first": parent["first"] + "." + q(name),
                   "all": parent["all"] + "." + q(name),
                   "unnests": list(parent["unnests"])}
        acc = {"first": ent["first"], "sel": ent["all"],
               "unnests": list(ent["unnests"])}
        if kind in ("array", "array-scalar"):
            # selecting the array usually means exploding it: give the hop
            h = hop(ent)
            acc["sel"] = h["all"]
            acc["unnests"] = h["unnests"]
            counter[0] -= 0  # alias numbers stay unique across the walk
            if kind == "array":
                acc["recursive"] = ("UNNEST(%s, recursive := true)"
                                    % ent["first"])
                acc["note"] = ("one row per element; %s.* spreads the "
                               "element's fields into columns" % h["all"])
            else:
                acc["note"] = "one row per element (scalar list)"
        elif kind == "struct":
            acc["note"] = ("a record: append .field, or %s.* to spread its "
                           "fields" % ent["all"])
        elif kind == "map":
            acc["note"] = ("map/dictionary: %s['key'] or "
                           "map_extract(%s, 'key')" % (ent["first"],
                                                       ent["first"]))
        elif (r.get("type") or "").strip().upper() == "JSON":
            acc["note"] = ("opaque JSON: %s->>'$.field' extracts text"
                           % ent["first"])
        r["access"] = acc
        stack.append(ent)
    return rows


def _json_tree_new():
    return {"kind": None, "types": set(), "children": {},
            "elem": None, "max_items": 0}


def _json_tree_merge(node, val, depth):
    """Merge one Python value into a shape tree (mutates ``node``)."""
    if depth > 40:
        return
    # Double-encoded JSON often survives as a string leaf inside arrays /
    # objects; decode before treating it as a scalar so field discovery can
    # see nested keys under "(element)".
    if isinstance(val, str):
        coerced = _coerce_json_sample(val)
        if isinstance(coerced, (dict, list)):
            _json_tree_merge(node, coerced, depth)
            return
        val = coerced
    if isinstance(val, dict):
        if node["kind"] != "array":
            node["kind"] = "object"
        for k, v in val.items():
            ch = node["children"].get(str(k))
            if ch is None:
                ch = _json_tree_new()
                node["children"][str(k)] = ch
            _json_tree_merge(ch, v, depth + 1)
    elif isinstance(val, list):
        node["kind"] = "array"
        if len(val) > node["max_items"]:
            node["max_items"] = len(val)
        if node["elem"] is None:
            node["elem"] = _json_tree_new()
        for it in val[:8]:
            _json_tree_merge(node["elem"], it, depth + 1)
    else:
        if node["kind"] is None:
            node["kind"] = "scalar"
        node["types"].add("null" if val is None
                          else {"str": "text", "int": "integer",
                                "float": "double", "bool": "boolean"}
                          .get(type(val).__name__, type(val).__name__))


def _coerce_json_sample(val, _decode_depth=0):
    """Turn a live cell (JSON text / STRUCT dict / list) into a mergeable
    Python value. Opaque JSON cells often arrive as already-encoded strings,
    and arrays may hold *stringified* objects (double-encoded JSON) — recurse
    after each successful parse so nested keys surface under ``(element)``.

    ``_decode_depth`` caps successive string→JSON decodes only; walking
    already-parsed dict/list structure is uncapped (merge has its own limit)."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        # STRUCT/LIST cells may still hold JSON-encoded string leaves.
        if isinstance(val, dict):
            out = {}
            for k, v in val.items():
                out[str(k)] = _coerce_json_sample(v, _decode_depth)
            return out
        return [_coerce_json_sample(v, _decode_depth) for v in val[:32]]
    if isinstance(val, (bytes, bytearray)):
        try:
            val = val.decode("utf-8", "replace")
        except Exception:
            return str(val)
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return val
        if s[0] in "{[":
            try:
                import orjson
                parsed = orjson.loads(s)
            except Exception:
                try:
                    import json as _json
                    parsed = _json.loads(s)
                except Exception:
                    return val
            # One loads() is not enough when the array elements are themselves
            # JSON text (e.g. ["{\"id\":1}", ...]). Re-coerce the parsed value.
            if _decode_depth >= 12:
                return parsed
            return _coerce_json_sample(parsed, _decode_depth + 1)
        return val
    return val


def _field_tree_from_root(root, colname="json", access_style="json",
                          sampled=0, complete=True, scan_s=0.0,
                          source=None):
    """Walk a merged shape root into the display nodes used by the sidebar."""
    rows = []

    def label(nd):
        if nd["kind"] == "object":
            return "object (%d field%s)" % (len(nd["children"]),
                                            "" if len(nd["children"]) == 1
                                            else "s")
        if nd["kind"] == "array":
            el = nd["elem"]
            inner = ("object" if el and el["kind"] == "object"
                     else "array" if el and el["kind"] == "array"
                     else "/".join(sorted(el["types"])) if el and el["types"]
                     else "value")
            return "array of " + inner
        ts = sorted(nd["types"] - {"null"}) or ["null"]
        return "/".join(ts)

    def expr(jptr):
        if access_style == "struct":
            return colname + jptr.replace("$", "", 1)  # $.a.b -> .a.b
        return "%s ->> '%s'" % (colname, jptr)

    def walk(name, nd, depth, jptr, in_array):
        if len(rows) >= 4000:
            return
        k = nd["kind"]
        if k == "object":
            rows.append({"depth": depth, "name": name, "type": label(nd),
                         "kind": "struct",
                         "path": None if (in_array or depth == 0) else expr(jptr),
                         "note": None})
            for key in nd["children"]:
                walk(key, nd["children"][key], depth + 1,
                     None if in_array else jptr + _json_path_seg(key), in_array)
        elif k == "array":
            rows.append({"depth": depth, "name": name, "type": label(nd),
                         "kind": ("array-scalar"
                                  if (nd["elem"] and nd["elem"]["kind"] == "scalar")
                                  else "array"),
                         "path": None if in_array else expr(jptr),
                         "note": ("array — expand with UNNEST" if not in_array
                                  else "nested array — UNNEST after the parent")})
            if nd["elem"]:
                walk("(element)", nd["elem"], depth + 1, None, True)
        else:
            rows.append({"depth": depth, "name": name,
                         "type": label(nd), "kind": "scalar",
                         "path": None if in_array else expr(jptr), "note": None})

    walk(colname, root, 0, "$", False)
    out = {"sampled": sampled, "complete": complete,
           "scan_s": scan_s, "nodes": rows}
    if source is not None:
        out["source"] = source
    return out


def json_values_to_field_tree(values, colname="json", access_style="json"):
    """Build a nested field tree from already-sampled Python/JSON values.

    Same display shape as ``json_field_tree`` / ``flatten_type_tree``. Used when
    DESCRIBE only shows opaque JSON / JSON[] (flatten-off depth cap) so the
    sidebar can still expand real field names from live table cells."""
    root = _json_tree_new()
    n = 0
    for raw in values or []:
        _json_tree_merge(root, _coerce_json_sample(raw), 0)
        n += 1
    return _field_tree_from_root(root, colname=colname,
                                 access_style=access_style,
                                 sampled=n, complete=True, scan_s=0.0,
                                 source="sampled-values")


def json_field_tree(path, colname="json", access_style="json",
                    sample=0, time_budget_s=25):
    """Sample a JSON file and return the nested field TREE of its records, in
    the same display shape as flatten_type_tree, with a query expression per
    readable scalar. This is how the structure view shows field names when the
    engine stored the record as one opaque JSON column (so DESCRIBE reveals no
    sub-fields).

    `access_style` picks the query syntax: "json" -> DuckDB JSON access on the
    column, e.g.  json ->> '$.a.b'  (returns text) and an UNNEST note for
    arrays; "struct" -> dotted struct access, e.g.  json.a.b. Time-boxed like
    discovery. Merges the shape across sampled records so ragged inputs still
    produce a complete tree."""
    from .flatten import stream_json_records

    root = _json_tree_new()
    n = 0
    t0 = time.monotonic()
    budget = float(time_budget_s or 25)
    cap = int(sample or 0)

    def _over():
        return time.monotonic() - t0 > budget
    complete = True
    try:
        for r in stream_json_records(path, should_cancel=_over):
            _json_tree_merge(root, r, 0)
            n += 1
            if cap and n >= cap:
                break
            if (n & 31) == 0 and _over():
                complete = False
                break
    except InterruptedError:
        complete = False
    except Exception:
        complete = False

    return _field_tree_from_root(root, colname=colname,
                                 access_style=access_style,
                                 sampled=n, complete=complete,
                                 scan_s=round(time.monotonic() - t0, 2))


def _scratch_writer(session):
    """A throwaway engine that mirrors the app's write path, so the write phase
    is timed against the same machinery a real load uses. Prefer DuckDB when
    present (that is the production path); else SQLite. Isolated instance -- it
    never touches the user's tables."""
    if feature_map()["duckdb"]:
        try:
            from .engines import DuckDBManager
            return DuckDBManager(), "duckdb"
        except Exception:
            pass
    try:
        from .engines import DBManager
        return DBManager(disk_backed=False), "sqlite"
    except Exception:
        return None, None


def _hint(read_prod_s, read_std_s, uses_ijson):
    if (uses_ijson and read_std_s > 0 and read_prod_s > 0.02
            and read_prod_s / read_std_s > 1.5):
        return ("ijson is %.1fx slower than the stdlib reader on this file. "
                "Set SAMQL_JSON_READER=stdlib to use the faster reader."
                % (read_prod_s / read_std_s))
    return ""


def profile_json_load(path, max_records=40, session=None, offset=0):
    """The JSON load profiler core, shared by the CLI and the server. Reads a
    window of ``max_records`` top-level records starting at ``offset`` (so you
    can skip past the small records at the front of a file and aim at the big
    ones deeper in), and returns a structured breakdown of read vs read+flatten
    vs the engine write of EVERY table produced (per-table timing, throughput,
    and any write error -- a write error here is exactly what makes the real
    load fall back to the slow nested path), plus a cProfile of the hot funcs."""
    import cProfile
    import pstats
    from .flatten import (stream_json_records, JSONFlattener,
                          _iter_stream_records)
    try:
        from .loaders import JSON_SPILL_ROWS as SPILL
    except Exception:
        SPILL = 150_000
    n = int(max_records or 40)
    off = max(0, int(offset or 0))
    feats = feature_map()
    with open(path, "rb") as f:
        fc = f.read(65536).decode("utf-8", "replace").lstrip()[:1]
    uses_ijson = (fc == "[" and feats["ijson"]
                  and os.environ.get("SAMQL_JSON_READER", "").lower() != "stdlib")

    def _window(gen):
        # skip `off` records, then yield up to `n` -- lets us profile a slice
        # deep in the file (the big swap records) not just the front.
        i = 0
        for rec in gen:
            i += 1
            if i <= off:
                continue
            yield rec
            if i >= off + n:
                break

    def _timeit(gen):
        t = time.monotonic()
        c = 0
        for _ in _window(gen):
            c += 1
        return round(time.monotonic() - t, 3), c

    # A: read via production routing (ijson when applicable)
    read_prod_s, read_prod_n = _timeit(stream_json_records(path))

    # A2: read forcing the stdlib raw_decode reader (direct comparison)
    def _stdlib():
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            yield from _iter_stream_records(fh)
    read_std_s, read_std_n = _timeit(_stdlib())

    # B: read + flatten (same window)
    fl = JSONFlattener(root_name="diag", spill_threshold=SPILL)
    t = time.monotonic()
    for rec in _window(stream_json_records(path)):
        fl.add_record(rec)
    flat_s = round(time.monotonic() - t, 3)
    tables = sorted(((tn, fl.row_count(tn), len(fl.columns(tn)))
                     for tn in fl.table_names()), key=lambda x: -x[1])

    # C: write EVERY table with the app's real write path (add_table_streaming),
    # on one engine, timing each table and CAPTURING any per-table error. This is
    # the part the old profiler skipped: it only wrote the largest-by-rows table,
    # so a wide or deep table -- or one whose write throws (which is exactly what
    # makes the real load fall back to the slow nested read_json path) -- was
    # never exercised. The largest table is also written cold-then-warm to
    # separate one-time engine startup from the steady per-load cost.
    write = None
    per_table = []
    if tables:
        mgr, engine_label = _scratch_writer(session)
        if mgr is not None:
            try:
                big = tables[0][0]
                rows = list(fl.iter_rows_aligned(big))
                cols = fl.columns(big)
                n_rows = len(rows)
                # cold vs warm on the largest table (startup vs steady cost)
                cold_s = warm_s = None
                wbuf = io.StringIO()
                try:
                    t = time.monotonic()
                    mgr.add_table_streaming("diag_cold", cols, iter(rows),
                                            source="diag")
                    cold_s = round(time.monotonic() - t, 3)
                    t = time.monotonic()
                    mgr.add_table_streaming("diag_warm", cols, iter(rows),
                                            source="diag")
                    warm_s = round(time.monotonic() - t, 3)
                    wpr = cProfile.Profile()
                    wpr.enable()
                    mgr.add_table_streaming("diag_prof", cols, iter(rows),
                                            source="diag")
                    wpr.disable()
                    pstats.Stats(wpr, stream=wbuf).sort_stats(
                        "cumulative").print_stats(12)
                except Exception as e:
                    wbuf.write("largest-table write failed: %s: %s"
                               % (type(e).__name__, e))
                rps = (n_rows / warm_s) if warm_s and warm_s > 0 else None
                fast = bool(warm_s is not None
                            and (warm_s < 0.5 or (rps or 0) > 2000))
                write = {"engine": engine_label, "table": big, "rows": n_rows,
                         "seconds": cold_s, "warm_seconds": warm_s,
                         "warm_rows_per_s": (round(rps) if rps else None),
                         "fast": fast,
                         "cold_start": bool(cold_s and warm_s is not None
                                            and cold_s - warm_s > 0.3
                                            and cold_s > 0.5),
                         "profile": wbuf.getvalue()}
                # now write EVERY table once, timing + catching errors per table
                for tn, _r, _c in tables:
                    trows = list(fl.iter_rows_aligned(tn))
                    tcols = fl.columns(tn)
                    rec = {"name": tn, "rows": len(trows), "cols": len(tcols)}
                    try:
                        t = time.monotonic()
                        mgr.add_table_streaming("t_" + tn, tcols, iter(trows),
                                                source="diag")
                        sec = round(time.monotonic() - t, 3)
                        rec["seconds"] = sec
                        rec["rows_per_s"] = (round(len(trows) / sec)
                                             if sec > 0 else None)
                    except Exception as e:
                        rec["error"] = "%s: %s" % (type(e).__name__, e)
                    per_table.append(rec)
            finally:
                try:
                    mgr.close()
                except Exception:
                    pass
    fl.close()

    # cProfile the read+flatten so the single hottest function is visible
    fl2 = JSONFlattener(root_name="diag", spill_threshold=SPILL)
    pr = cProfile.Profile()
    pr.enable()
    for rec in _window(stream_json_records(path)):
        fl2.add_record(rec)
    pr.disable()
    fl2.close()
    buf = io.StringIO()
    pstats.Stats(pr, stream=buf).sort_stats("cumulative").print_stats(12)

    # slowest / errored table across the full write (what to look at)
    slow = None
    for r in per_table:
        if r.get("error"):
            slow = r
            break
        if slow is None or (r.get("seconds") or 0) > (slow.get("seconds") or 0):
            slow = r

    # D: flatten-off production path (sniff → optional NDJSON rewrite →
    # depth-capped native COPY to Parquet). The flatten timings above remain
    # for flatten-ON comparison; large loads no longer stream-flatten by
    # default, so this section is what the UI/load path actually does.
    parquet_path = _profile_flatten_off_parquet(path, feats)

    return {
        "path": path,
        "size_mb": round(os.path.getsize(path) / 1e6, 2),
        "first_char": fc,
        "reader": "ijson" if uses_ijson else "stdlib",
        "sampled": n,
        "offset": off,
        "read_prod_s": read_prod_s, "read_prod_n": read_prod_n,
        "read_stdlib_s": read_std_s, "read_stdlib_n": read_std_n,
        "flatten_s": flat_s,
        "flatten_only_s": round(flat_s - read_prod_s, 3),
        "tables": [{"name": t, "rows": r, "cols": co} for t, r, co in tables[:12]],
        "total_rows": sum(r for _, r, _ in tables),
        "table_count": len(tables),
        "write": write,
        "per_table": per_table,
        "slowest_table": slow,
        "flatten_off_parquet": parquet_path,
        "nested_discovery": (
            "When flatten-off stores opaque JSON / JSON[] columns "
            "(maximum_depth=2), nested field trees are built by sampling "
            "live cell values — DESCRIBE alone shows no deep schema."
        ),
        "features": feats,
        "hint": _hint(read_prod_s, read_std_s, uses_ijson),
        "profile": buf.getvalue(),
    }


def _profile_flatten_off_parquet(path, feats):
    """Time the flatten-off Parquet conversion path used for large JSON."""
    if not feats.get("duckdb"):
        return {"skipped": True, "reason": "duckdb not available"}
    try:
        from .engines import (DuckDBManager, _sniff_json_format,
                              _is_ndjson_path)
        from . import tmputil
    except Exception as e:
        return {"skipped": True, "reason": "%s: %s" % (type(e).__name__, e)}

    out = {"maximum_depth": 2}
    try:
        t0 = time.monotonic()
        fmt = ("ndjson" if _is_ndjson_path(path)
               else _sniff_json_format(path))
        out["sniff_s"] = round(time.monotonic() - t0, 3)
        out["format"] = fmt
    except Exception as e:
        out["sniff_error"] = "%s: %s" % (type(e).__name__, e)
        fmt = None

    mgr = None
    cache = None
    try:
        mgr = DuckDBManager()
        t0 = time.monotonic()
        read_path, is_nd, cleanup = mgr._json_source_for_read(path)
        out["rewrite_s"] = round(time.monotonic() - t0, 3)
        out["rewrote_to_ndjson"] = bool(cleanup)
        out["reads_as_ndjson"] = bool(is_nd)
        cache = tmputil.new_tempfile("diag_pq_", ".parquet")
        try:
            os.unlink(cache)
        except OSError:
            pass
        cfwd = cache.replace("\\", "/").replace("'", "''")
        rfwd = read_path.replace("\\", "/").replace("'", "''")
        from .engines import _json_readers, exec_copy_parquet
        readers = _json_readers(
            rfwd, ndjson=is_nd,
            memory_limit_mb=getattr(mgr, "_applied_resource_memory_mb", None),
            maximum_depth=2)
        t0 = time.monotonic()
        last = None
        for reader in readers:
            try:
                exec_copy_parquet(
                    mgr.conn, "SELECT * FROM %s" % reader, cfwd)
                last = None
                break
            except Exception as e:
                last = e
                try:
                    os.unlink(cache)
                except OSError:
                    pass
        out["native_parquet_s"] = round(time.monotonic() - t0, 3)
        if last is not None:
            out["error"] = "%s: %s" % (type(last).__name__, last)
        else:
            try:
                out["parquet_bytes"] = os.path.getsize(cache)
                cur = mgr.conn.cursor()
                try:
                    cur.execute(
                        "SELECT count(*) FROM read_parquet('%s')" % cfwd)
                    out["rows"] = int(cur.fetchone()[0])
                    cur.execute(
                        "DESCRIBE SELECT * FROM read_parquet('%s')" % cfwd)
                    cols = [(r[0], r[1] or "") for r in cur.fetchall()]
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                out["columns"] = [{"name": c, "type": t} for c, t in cols]
                opaque = [c for c, t in cols
                          if "JSON" in (t or "").upper()]
                out["opaque_json_columns"] = opaque
                out["note"] = (
                    "Flatten-off Parquet path (depth=2). Opaque JSON columns "
                    "need sampled-value field trees for nested discovery."
                    if opaque else
                    "Flatten-off Parquet path (depth=2).")
            except Exception as e:
                out["post_error"] = "%s: %s" % (type(e).__name__, e)
        if cleanup:
            try:
                os.unlink(cleanup)
            except OSError:
                pass
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        if cache:
            try:
                os.unlink(cache)
            except OSError:
                pass
        if mgr is not None:
            try:
                conn = getattr(mgr, "_conn", None) or getattr(mgr, "conn", None)
                if conn is not None:
                    conn.close()
            except Exception:
                pass
    return out


def scan_heaviest_records(path, cap=0, top=15):
    """Read the file (parsing records but NOT flattening -- so it's bounded and
    fast) and find the records that would explode the flatten: the ones with the
    largest nested array at any depth and the largest total element count. A
    single record with a multi-million-element array is exactly what makes a
    deep-flatten load crawl (one add_record emits millions of rows while the byte
    position sits still). ``cap`` limits how many records to scan (0 = all)."""
    import heapq
    from .flatten import stream_json_records

    def _weigh(o):
        # iterative deep walk: longest array at any depth + total element count
        max_arr = 0
        total = 0
        stack = [o]
        while stack:
            x = stack.pop()
            if type(x) is list:
                ln = len(x)
                if ln > max_arr:
                    max_arr = ln
                total += ln
                stack.extend(x)
            elif type(x) is dict:
                total += len(x)
                stack.extend(x.values())
        return max_arr, total

    heaviest = []          # min-heap keyed by (max_arr, total)
    n = 0
    t0 = time.monotonic()
    for i, rec in enumerate(stream_json_records(path)):
        if cap and i >= cap:
            break
        max_arr, total = _weigh(rec)
        entry = (max_arr, total, i)
        if len(heaviest) < top:
            heapq.heappush(heaviest, entry)
        elif entry > heaviest[0]:
            heapq.heapreplace(heaviest, entry)
        n = i + 1
    scan_s = round(time.monotonic() - t0, 3)
    heaviest.sort(reverse=True)
    top_arr = heaviest[0][0] if heaviest else 0
    return {
        "path": path,
        "size_mb": round(os.path.getsize(path) / 1e6, 2),
        "scanned": n,
        "scan_s": scan_s,
        "records_per_s": (round(n / scan_s) if scan_s > 0 else None),
        "max_array_len": top_arr,
        # a record whose biggest array is in the millions will dominate a flatten
        "explosive": bool(top_arr >= 100_000),
        "heaviest": [{"record_index": i, "max_array_len": ma, "elements": tot}
                     for (ma, tot, i) in heaviest],
    }


@diagnostic("json_heaviest", "JSON heaviest records (find the explosion)",
            "Scans the whole file (reading, not flattening -- fast) and reports "
            "the records with the biggest nested arrays / element counts. This "
            "finds the one record that makes a deep-flatten load crawl: a single "
            "record with a multi-million-element array explodes into millions of "
            "child rows in one step.",
            params=[
                {"name": "table", "label": "Loaded table (uses its source file)",
                 "type": "table"},
                {"name": "path", "label": "or a JSON file path", "type": "text"},
                {"name": "max_records", "label": "Scan up to N records (0 = all)",
                 "type": "int", "default": 0},
                {"name": "top", "label": "Show the N heaviest", "type": "int",
                 "default": 15},
            ])
def json_heaviest_diag(session=None, table=None, path=None, max_records=0,
                       top=15, **_):
    p = _resolve_path(session, table, path)
    if not p:
        return {"error": "Provide a loaded table or a JSON file path."}
    if not os.path.exists(p):
        return {"error": "File not found: %s" % p}
    return scan_heaviest_records(p, int(max_records or 0), int(top or 15))


@diagnostic("json_load", "JSON load profiler",
            "Times the JSON load phases: production read vs stdlib read, "
            "read+flatten (flatten-ON comparison), per-table engine writes, "
            "AND the flatten-OFF Parquet path (sniff → NDJSON rewrite → "
            "depth=2 native COPY). For a loaded table, prefers the original "
            "JSON file when the live source is a Parquet cache. Use offset to "
            "skip small leading records and aim at bigger ones deeper in.",
            params=[
                {"name": "table", "label": "Loaded table (uses its source file)",
                 "type": "table"},
                {"name": "path", "label": "or a JSON file path", "type": "text"},
                {"name": "max_records", "label": "Records to sample",
                 "type": "int", "default": 40},
                {"name": "offset", "label": "Skip this many records first",
                 "type": "int", "default": 0},
            ])
def json_load_diag(session=None, table=None, path=None, max_records=40,
                   offset=0, **_):
    p = _resolve_path(session, table, path)
    if not p:
        return {"error": "Provide a loaded table or a JSON file path."}
    if not os.path.exists(p):
        return {"error": "File not found: %s" % p}
    return profile_json_load(p, max_records, session, offset=offset)


# ====================================================================
#  Full load analysis -- one comprehensive run that covers every outcome
# ====================================================================

def _weigh_record(o):
    """Deep, iterative structural weigh of one parsed record. Returns
    (biggest_array_len_at_any_depth, sum_of_all_array_lengths, max_depth,
    approx_bytes). ``sum_of_all_array_lengths`` is a close proxy for how many
    child rows the record flattens to (every array element becomes a row in its
    table)."""
    max_arr = 0
    arr_rows = 0
    max_depth = 0
    approx = 0
    stack = [(o, 0)]
    while stack:
        x, d = stack.pop()
        if d > max_depth:
            max_depth = d
        t = type(x)
        if t is list:
            ln = len(x)
            if ln > max_arr:
                max_arr = ln
            arr_rows += ln
            approx += 2
            for it in x:
                stack.append((it, d + 1))
        elif t is dict:
            approx += 2
            for k, v in x.items():
                approx += len(k) + 4
                stack.append((v, d + 1))
        elif t is str:
            approx += len(x) + 2
        else:
            approx += 8
    return max_arr, arr_rows, max_depth, approx


def _read_window_timed(gen, n):
    t = time.monotonic()
    c = 0
    for _ in gen:
        c += 1
        if c >= n:
            break
    return round(time.monotonic() - t, 3), c


def _fmt_secs(s):
    if s is None:
        return "unknown"
    if s < 90:
        return "%.1fs" % s
    if s < 5400:
        return "%.1f min" % (s / 60.0)
    return "%.1f hours" % (s / 3600.0)


def run_full_analysis(path, session=None, scan_cap=0, sample=200,
                      time_budget_s=45):
    """One-shot, comprehensive 'why is this load slow' analysis. In a single run:

      1. environment (features, RAM, reader mode)
      2. a WHOLE-FILE read-only structural scan: record count, byte size, read
         throughput, the heaviest records, and the total projected row explosion
         (sum of all nested array lengths) -- this alone finds a bomb record and
         the total volume without flattening anything
      3. a reader comparison (ijson vs stdlib) on a sample
      4. a flatten of the front sample -> flatten throughput + resulting table
         shape (width), and a write of every one of those tables to a scratch
         engine (per-table timing/throughput, cold-vs-warm, and any write error
         -- a write error is what makes the real load fall back to the slow path)
      5. a flatten of the SINGLE heaviest record it just found (auto-offset), so
         a record that explodes is measured directly, not guessed at
      6. a projection of the full-load time from the measured throughputs, and a
         VERDICT naming which bottleneck it is (or that there is none)

    Bounded: the read-only scan is fast even on a bomb; only a small sample and
    one heavy record are actually flattened/written."""
    import heapq
    from .flatten import (stream_json_records, JSONFlattener,
                          _iter_stream_records)
    try:
        from .loaders import JSON_SPILL_ROWS as SPILL
    except Exception:
        SPILL = 150_000

    feats = feature_map()
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        fc = f.read(65536).decode("utf-8", "replace").lstrip()[:1]
    uses_ijson = (fc == "[" and feats["ijson"]
                  and os.environ.get("SAMQL_JSON_READER", "").lower() != "stdlib")
    warnings = []

    # ---- 1) whole-file structural scan (read-only, TIME-BOXED) ------
    # A multi-GB / swap-heavy file can take longer to read than an HTTP request
    # allows, so the scan runs under a wall-clock budget: it covers as much as it
    # can, tracks the real byte position, and if it doesn't finish it extrapolates
    # the full read time from the measured rate. Not finishing in the budget is
    # itself a finding (the read is the slow part).
    heaviest = []
    total_records = 0
    total_arr_rows = 0
    global_max_arr = 0
    global_max_depth = 0
    scan_err = None
    scan_complete = True
    hit_cap = False
    _pos = [0]

    def _prog(done, total):
        try:
            _pos[0] = int(done)
        except Exception:
            pass
    budget = float(time_budget_s or 45)
    t0 = time.monotonic()

    def _over_budget():
        return time.monotonic() - t0 > budget
    try:
        for i, rec in enumerate(stream_json_records(path, progress=_prog,
                                                    should_cancel=_over_budget)):
            if scan_cap and i >= scan_cap:
                hit_cap = True
                break
            ma, rows, dep, _b = _weigh_record(rec)
            total_records = i + 1
            total_arr_rows += rows
            if ma > global_max_arr:
                global_max_arr = ma
            if dep > global_max_depth:
                global_max_depth = dep
            entry = (rows, ma, i)
            if len(heaviest) < 15:
                heapq.heappush(heaviest, entry)
            elif entry > heaviest[0]:
                heapq.heapreplace(heaviest, entry)
            # check the time budget every 64 records (cheap)
            if (i & 63) == 0 and _over_budget():
                scan_complete = False
                break
    except InterruptedError:
        # the reader hit the budget mid-record (e.g. stuck parsing a huge one)
        scan_complete = False
    except MemoryError:
        scan_err = ("ran out of memory parsing a record -- a single record is "
                    "too large to hold in memory (this alone would fail a load)")
    except Exception as e:
        scan_err = "%s: %s" % (type(e).__name__, e)
    scan_s = round(time.monotonic() - t0, 3)
    bytes_covered = _pos[0]
    read_mbps = (round((bytes_covered / 1e6) / scan_s, 1)
                 if (scan_s > 0 and bytes_covered) else None)
    # extrapolate full read time if we didn't cover the whole file
    frac = (bytes_covered / size) if (size and bytes_covered) else None
    est_full_read_s = None
    if not scan_complete and read_mbps and read_mbps > 0:
        est_full_read_s = round((size / 1e6) / read_mbps, 1)
    est_total_records = (int(total_records / frac)
                         if (not scan_complete and frac and frac > 0)
                         else total_records)
    heaviest.sort(reverse=True)
    # projected total rows across all tables ~ nested array elements + roots,
    # extrapolated to the whole file if the scan was time-boxed short
    est_total_rows = total_arr_rows + total_records
    if not scan_complete and frac and frac > 0:
        est_total_rows = int(est_total_rows / frac)
    scan_rps = (round(total_records / scan_s) if scan_s > 0 else None)

    # ---- 2) reader comparison on a sample ---------------------------
    rn = min(int(sample or 200), total_records or int(sample or 200)) or 1
    ij_s, ij_n = _read_window_timed(stream_json_records(path), rn)

    def _std():
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            yield from _iter_stream_records(fh)
    st_s, st_n = _read_window_timed(_std(), rn)
    reader_ratio = (round(ij_s / st_s, 1) if (uses_ijson and st_s > 0) else None)

    # ---- 3) flatten the front sample -> throughput + table shape ----
    def _flatten_window(off, n):
        fl = JSONFlattener(root_name="diag", spill_threshold=SPILL)
        t = time.monotonic()
        seen = 0
        for i, rec in enumerate(stream_json_records(path)):
            if i < off:
                continue
            fl.add_record(rec)
            seen += 1
            if seen >= n:
                break
        sec = round(time.monotonic() - t, 3)
        tbls = sorted(((tn, fl.row_count(tn), len(fl.columns(tn)))
                       for tn in fl.table_names()), key=lambda x: -x[1])
        return fl, sec, tbls, sum(r for _, r, _ in tbls), seen

    fl_front, front_s, front_tables, front_rows, front_seen = _flatten_window(0, rn)
    flat_rps = (round(front_rows / front_s) if front_s > 0 else None)
    max_cols = max((c for _, _, c in front_tables), default=0)

    # ---- 4) write every front table to a scratch engine -------------
    write_tables = []
    cold_s = warm_s = None
    warm_rps = None
    mgr, engine_label = _scratch_writer(session)
    if mgr is not None and front_tables:
        try:
            big = front_tables[0][0]
            rows = list(fl_front.iter_rows_aligned(big))
            cols = fl_front.columns(big)
            try:
                t = time.monotonic()
                mgr.add_table_streaming("cold", cols, iter(rows), source="d")
                cold_s = round(time.monotonic() - t, 3)
                t = time.monotonic()
                mgr.add_table_streaming("warm", cols, iter(rows), source="d")
                warm_s = round(time.monotonic() - t, 3)
                if warm_s > 0:
                    warm_rps = round(len(rows) / warm_s)
            except Exception as e:
                warnings.append("largest write failed: %s: %s"
                                % (type(e).__name__, e))
            for tn, _r, _c in front_tables:
                trows = list(fl_front.iter_rows_aligned(tn))
                tcols = fl_front.columns(tn)
                rec = {"name": tn, "rows": len(trows), "cols": len(tcols)}
                try:
                    t = time.monotonic()
                    mgr.add_table_streaming("t_" + tn, tcols, iter(trows),
                                            source="d")
                    sec = round(time.monotonic() - t, 3)
                    rec["seconds"] = sec
                    rec["rows_per_s"] = (round(len(trows) / sec)
                                         if sec > 0 else None)
                except Exception as e:
                    rec["error"] = "%s: %s" % (type(e).__name__, e)
                write_tables.append(rec)
        finally:
            try:
                mgr.close()
            except Exception:
                pass
    fl_front.close()
    write_errors = [w for w in write_tables if w.get("error")]
    ok = [w["rows_per_s"] for w in write_tables if w.get("rows_per_s")]
    write_rps = (min(ok) if ok else None)   # conservative: worst table

    # ---- 5) flatten the single heaviest record (auto-offset) --------
    heavy_probe = None
    if heaviest and heaviest[0][1] >= 1000:      # biggest array >= 1000
        hidx = heaviest[0][2]
        hrows_est = heaviest[0][0]               # element count (row proxy)
        if hrows_est > 500_000:
            # too big to flatten inside the budget -- report it from the scan
            heavy_probe = {"record_index": hidx, "skipped_flatten": True,
                           "est_rows": hrows_est,
                           "max_array_len": heaviest[0][1],
                           "note": ("this record alone is projected to explode "
                                    "into ~%s rows; not flattened here to stay "
                                    "within the time budget" % f"{hrows_est:,}")}
        else:
            fl_h = JSONFlattener(root_name="diag", spill_threshold=SPILL)
            t = time.monotonic()
            err = None
            try:
                for i, rec in enumerate(stream_json_records(path)):
                    if i < hidx:
                        continue
                    fl_h.add_record(rec)
                    break
            except MemoryError:
                err = "ran out of memory flattening this record"
            except Exception as e:
                err = "%s: %s" % (type(e).__name__, e)
            hsec = round(time.monotonic() - t, 3)
            produced = fl_h._emit_total
            if err:
                heavy_probe = {"record_index": hidx, "error": err,
                               "flatten_s": hsec, "rows_produced": produced}
            else:
                ht = sorted(((tn, fl_h.row_count(tn), len(fl_h.columns(tn)))
                             for tn in fl_h.table_names()), key=lambda x: -x[1])
                heavy_probe = {
                    "record_index": hidx, "flatten_s": hsec,
                    "rows_produced": produced,
                    "rows_per_s": (round(produced / hsec) if hsec > 0 else None),
                    "tables": [{"name": t, "rows": r, "cols": c}
                               for t, r, c in ht[:8]],
                }
            fl_h.close()

    # ---- 6) projection + verdict ------------------------------------
    # Phase 1 of the real load is read+flatten, interleaved; the whole-file scan
    # (read + a structural walk ~ the same shape as flatten) is a good proxy for
    # it, so phase-1 time ~ the scan time (extrapolated to the whole file if the
    # scan was time-boxed short). Phase 2 is the write.
    est_read_s = (est_full_read_s if (not scan_complete and est_full_read_s)
                  else scan_s)
    est_write_s = ((est_total_rows / write_rps)
                   if (write_rps and est_total_rows) else None)
    est_flatten_s = ((est_total_rows / flat_rps)
                     if (flat_rps and est_total_rows) else None)
    est_total_s = (round((est_read_s or 0) + (est_write_s or 0), 1)
                   if (est_read_s is not None and est_write_s is not None)
                   else None)

    # fraction of the file the scan actually covered (by bytes)
    scan_frac = ((bytes_covered / size) if (size and bytes_covered) else None)
    # unreliable if we stopped at a small cap on a substantial file: there are
    # more records than we saw, and too few to represent the whole file. (Byte
    # fraction is not used here -- the reader buffers ahead, so it overstates
    # coverage for a small scan.)
    scan_too_small = bool(hit_cap and size > 20_000_000
                          and total_records < 5000)

    bottleneck = "none"
    if scan_err:
        bottleneck = "read-error"
    elif write_errors:
        bottleneck = "write-error-fallback"
    elif scan_too_small:
        # the scan finished but covered a tiny slice of the file (a small
        # scan_cap), so every projection below is off a non-representative
        # sample -- do not name a bottleneck from it.
        bottleneck = "scan-too-small"
    elif global_max_arr >= 1_000_000:
        bottleneck = "single-record-explosion"
    elif not scan_complete and (est_full_read_s or 0) > 120:
        bottleneck = "read-throughput"
    elif est_total_rows and est_total_rows > 20_000_000:
        bottleneck = "row-volume"
    elif (write_rps and flat_rps and write_rps < flat_rps / 5
          and max_cols >= 40):
        bottleneck = "write-width"
    elif reader_ratio and reader_ratio >= 2.0 and (ij_s or 0) > 0.1:
        bottleneck = "reader-ijson"

    tips = {
        "read-error": ("The file could not be fully read: %s. Fix/trim the file "
                       "or report this record." % scan_err),
        "scan-too-small": (
            "Only %s records (~%s MB of %s MB) were scanned, so the numbers "
            "below are NOT representative of the whole file -- the big records "
            "are deeper in. Set 'Scan up to N records' to 0 to scan the whole "
            "file (it is time-boxed, so it will not hang) and re-run."
            % (f"{total_records:,}", round(bytes_covered / 1e6, 1),
               round(size / 1e6, 1))),
        "write-error-fallback": (
            "A table's write threw (%s). The real load catches this and falls "
            "back to the slow single-table read_json path -- that fallback is "
            "the crawl. Fix the offending value/type so the flatten write "
            "succeeds." % (write_errors[0].get("error") if write_errors else "")),
        "single-record-explosion": (
            "One record has a %s-element array; flattening it emits that many "
            "child rows in a single step, stalling the load while the byte "
            "position sits still. Cap or chunk that array, or exclude that "
            "record." % f"{global_max_arr:,}"),
        "read-throughput": (
            "Reading the file is the bottleneck. In the %ss budget the scan "
            "covered only ~%s MB of %s MB (~%s MB/s), so reading the whole file "
            "alone is ~%s -- before any write. Big, deeply-nested records make "
            "ijson slow; try SAMQL_JSON_READER=stdlib, and run the load in the "
            "background." % (int(budget), round(bytes_covered / 1e6, 1),
                             round(size / 1e6, 1), read_mbps,
                             _fmt_secs(est_full_read_s))),
        "row-volume": (
            "The file flattens to ~%s rows total. That volume is the cost; "
            "nothing is broken. Expect ~%s -- load in the background, or load "
            "fewer records." % (f"{est_total_rows:,}", _fmt_secs(est_total_s))),
        "write-width": (
            "Wide tables (up to %d columns) write far slower per row than narrow "
            "ones, and that dominates. The write, not the read, is the cost."
            % max_cols),
        "reader-ijson": (
            "ijson is %sx slower than the stdlib reader on this data. Set "
            "SAMQL_JSON_READER=stdlib to use the faster reader."
            % reader_ratio),
        "none": ("No single bottleneck stands out; every measured phase is fast "
                 "at steady state. If a full load is still slow, re-run with a "
                 "bigger time budget or send this report."),
    }
    verdict = tips.get(bottleneck, tips["none"])
    if scan_too_small:
        est_total_s = None   # projection off a tiny sample is meaningless

    try:
        from . import __version__ as _ver, BUILD as _bld
        _vstr = "%s (%s)" % (_ver, _bld)
    except Exception:
        _vstr = "?"

    return {
        "version": _vstr,
        "file": {"path": path, "size_mb": round(size / 1e6, 2),
                 "first_char": fc, "reader": "ijson" if uses_ijson else "stdlib"},
        "features": feats,
        "scan": {
            "records": total_records, "scan_s": scan_s,
            "records_per_s": scan_rps, "scan_error": scan_err,
            "complete": scan_complete,
            "bytes_covered_mb": (round(bytes_covered / 1e6, 1)
                                 if bytes_covered else 0),
            "read_mbps": read_mbps,
            "est_full_read_s": est_full_read_s,
            "est_total_records": est_total_records,
            "max_array_len": global_max_arr, "max_depth": global_max_depth,
            "est_total_rows": est_total_rows,
            "heaviest": [{"record_index": i, "elements": rows,
                          "max_array_len": ma} for (rows, ma, i) in heaviest],
        },
        "reader": {"ijson_s": ij_s, "stdlib_s": st_s, "sampled": rn,
                   "ratio": reader_ratio},
        "flatten": {"sampled": front_seen, "seconds": front_s,
                    "rows": front_rows, "rows_per_s": flat_rps,
                    "table_count": len(front_tables), "max_cols": max_cols},
        "write": {"engine": engine_label, "cold_s": cold_s, "warm_s": warm_s,
                  "warm_rows_per_s": warm_rps, "per_table": write_tables,
                  "errors": write_errors},
        "heavy_record": heavy_probe,
        "projection": {"est_total_rows": est_total_rows,
                       "flatten_rows_per_s": flat_rps,
                       "write_rows_per_s": write_rps,
                       "est_read_s": (round(est_read_s, 1)
                                      if est_read_s is not None else None),
                       "est_flatten_s": (round(est_flatten_s, 1)
                                         if est_flatten_s is not None else None),
                       "est_write_s": (round(est_write_s, 1)
                                       if est_write_s is not None else None),
                       "est_total_s": est_total_s,
                       "est_total_human": (_fmt_secs(est_total_s)
                                           if est_total_s is not None
                                           else None)},
        "bottleneck": bottleneck,
        "verdict": verdict,
        "warnings": warnings,
    }


@diagnostic("full_analysis", "Full load analysis (start here)",
            "One comprehensive run: scans the whole file, finds the heaviest "
            "records, measures read + flatten + per-table write (and any write "
            "error), then projects the full-load time and names the bottleneck. "
            "The one diagnostic to run first.",
            params=[
                {"name": "table", "label": "Loaded table (uses its source file)",
                 "type": "table"},
                {"name": "path", "label": "or a JSON file path", "type": "text"},
                {"name": "sample", "label": "Sample size for flatten/write",
                 "type": "int", "default": 200},
                {"name": "scan_cap",
                 "label": "Scan up to N records (0 = whole file)",
                 "type": "int", "default": 0},
                {"name": "time_budget_s",
                 "label": "Scan time budget (seconds)", "type": "int",
                 "default": 45},
            ])
def full_analysis_diag(session=None, table=None, path=None, sample=200,
                       scan_cap=0, time_budget_s=45, **_):
    p = _resolve_path(session, table, path)
    if not p:
        return {"error": "Provide a loaded table or a JSON file path."}
    if not os.path.exists(p):
        return {"error": "File not found: %s" % p}
    return run_full_analysis(p, session, scan_cap=int(scan_cap or 0),
                             sample=int(sample or 200),
                             time_budget_s=int(time_budget_s or 45))


def _raw_column_types(session, table):
    """[(col, raw_type_string)] for a table, from the engine that owns it,
    WITHOUT the case-folding column_types() applies -- nested field-name case
    matters for the structure view. Prefers DuckDB (which carries the full
    nested STRUCT/LIST type); falls back to SQLite declared types."""
    duck = getattr(session, "duckdb", None)
    db = getattr(session, "db", None)
    if duck is not None and table in getattr(duck, "table_columns", {}):
        try:
            _c, rows = duck.execute_read('DESCRIBE "%s"' % table)
            if rows:
                return "duckdb", [(r[0], r[1] or "") for r in rows]
        except Exception:
            pass
    if db is not None and table in getattr(db, "table_columns", {}):
        try:
            types = db.column_types(table)
            cols = db.table_columns.get(table, [])
            return "sqlite", [(c, types.get(c, "")) for c in cols]
        except Exception:
            pass
    # not in either cache: try a DuckDB DESCRIBE anyway (view / fresh table)
    if duck is not None:
        try:
            _c, rows = duck.execute_read('DESCRIBE "%s"' % table)
            if rows:
                return "duckdb", [(r[0], r[1] or "") for r in rows]
        except Exception:
            pass
    return None, []


@diagnostic("structure", "Nested structure (field paths to query)",
            "Shows a table's columns and expands its nested shape into a field "
            "tree with the exact expression to read each value (and which "
            "fields are arrays needing UNNEST). For a STRUCT column that is the "
            "column type; for a table that stores whole records in one opaque "
            "JSON column, give the JSON file path and it samples the file to "
            "show the real fields. Use it to see how to query without "
            "flattening the whole file.",
            params=[{"name": "table", "label": "Loaded table",
                     "type": "table"},
                    {"name": "path",
                     "label": "or a JSON file path (to sample its fields)",
                     "type": "text"}])
def structure_diag(session=None, table=None, path=None, **_):
    if not table and not path:
        return {"error": "Pick a loaded table (or give a JSON file path)."}
    columns = []
    nested_any = False
    engine = None
    if table:
        engine, pairs = _raw_column_types(session, table)
        for (cname, ctype) in pairs:
            node = parse_duckdb_type(ctype)
            nested = node.get("t") in ("struct", "list", "map")
            nested_any = nested_any or nested
            columns.append({"name": cname, "type": ctype, "nested": nested,
                            "nodes": flatten_type_tree(cname, node)})

    # A JSON source we can sample for the TRUE field tree -- essential when the
    # record was stored as one opaque JSON column (DESCRIBE shows no sub-fields).
    def _is_json(p):
        return bool(p) and str(p).lower().endswith((".json", ".ndjson", ".jsonl"))
    json_src = None
    if _is_json(path) and os.path.exists(str(path)):
        json_src = str(path)
    elif session and table:
        src = _resolve_path(session, table, None)
        if _is_json(src):
            json_src = src

    file_tree = None
    if json_src:
        col = None
        if len(columns) == 1:
            col = columns[0]["name"]
        else:
            for c in columns:
                if "JSON" in (c["type"] or "").upper():
                    col = c["name"]
                    break
        col = col or "json"
        access = "struct" if any(c["nested"] for c in columns) else "json"
        ft = json_field_tree(json_src, colname=col, access_style=access)
        file_tree = {"column": col, "access": access, "source": json_src, **ft}

    q = '"%s"' % (table or "t")
    hints = []
    if file_tree and file_tree["access"] == "json":
        col = file_tree["column"]
        hints = [
            "Each record is stored in the '%s' column as JSON. Read a field "
            "with the ->> operator, e.g.  SELECT %s ->> '$.cashFlows.note' "
            "FROM %s" % (col, col, q),
            "->> returns text; cast when you need a number/date, e.g. "
            "(%s ->> '$.px')::DOUBLE" % col,
            "Expand an array with UNNEST over the extracted JSON, or re-load "
            "the file with flatten ON (or only the heavy arrays skipped) to get "
            "real child tables.",
        ]
    elif engine == "duckdb" and nested_any:
        hints = [
            "Read a nested scalar with dotted access, e.g.  "
            "SELECT json.id, json.cashFlows.note FROM %s" % q,
            "Expand an array into rows with UNNEST, e.g.  SELECT u.* FROM %s, "
            "UNNEST(json.cashFlows.payingLeg) AS t(u)" % q,
            "Prefer real child tables? Re-load the file with flatten ON, or "
            "with only the heavy arrays skipped (Skip these fields), to get "
            "them without the full explosion.",
        ]
    elif engine == "sqlite":
        hints = ["This table is already flat -- every column is a scalar you "
                 "can select directly."]
    elif not table and json_src:
        hints = ["Sampled the file directly (no table loaded). Load it to "
                 "query, or use these paths as a guide."]
    return {"engine": engine, "table": table, "column_count": len(columns),
            "nested": nested_any, "columns": columns, "file_tree": file_tree,
            "hints": hints}


@diagnostic(
    "shred_preflight",
    "Shred preflight (why won't this table flatten?)",
    "Every gate between a table and 'Create relational tables', with a "
    "reason per column -- run this when the picker comes back empty. "
    "Checks: DuckDB engine, Parquet backing, nested array-of-records "
    "columns (with the typeof fallback), and the planned table count.",
    params=[{"name": "table", "label": "Table", "type": "table"},
            {"name": "engine", "label": "Engine", "type": "text",
             "default": "duckdb"}])
def _diag_shred_preflight(session, table="", engine="duckdb"):
    return session.shred_preflight(engine or "duckdb", table)
