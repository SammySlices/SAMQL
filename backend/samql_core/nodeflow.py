"""Compile a NodeFlow graph (visual node-based data flow) into SQL.

Everything a node produces is expressed by one core, ``node_output_sql``,
which is used two ways:

  * the executor (session._materialize_flow) builds each (node, output-port)
    into a TEMP table and feeds downstream nodes the temp-table name, so the
    whole workflow lives in temp tables, Alteryx-style; and
  * ``compile_port`` composes the upstream as nested subqueries (no temp
    tables) -- used by ``nodeflow_columns`` and by the tests.

Graph shape (JSON from the frontend):
    {"nodes": [{"id","type","config"}],
     "edges": [{"from":{"node","port"},"to":{"node","port"}}]}

``get_input(in_port)`` returns a FROM-able relation expression -- a quoted
temp-table name or a parenthesised subquery -- or None when nothing is
connected. ``cols_of(select_sql)`` returns the column names of a relation.
"""

import re
from collections import deque


def sanitize_ident(name, fallback=""):
    """Turn an arbitrary string into a safe SQL identifier: collapse runs of
    non-word characters to "_", trim leading/trailing "_", and prefix a leading
    digit with "t_". Returns ``fallback`` (default "") when nothing usable
    remains, so callers decide whether an empty name is an error or a default.
    One home for the table-name sanitisation several call sites used to inline."""
    s = re.sub(r"[^0-9A-Za-z_]+", "_", (name or "").strip()).strip("_")
    if not s:
        return fallback
    if s[0].isdigit():
        s = "t_" + s
    return s

# friendly field type -> a CAST target that works on both SQLite and DuckDB
_SQL_TYPES = {
    "text": "TEXT", "string": "TEXT", "varchar": "TEXT",
    "integer": "INTEGER", "int": "INTEGER", "bigint": "BIGINT",
    "decimal": "DOUBLE", "double": "DOUBLE", "float": "DOUBLE", "real": "DOUBLE",
    "date": "DATE", "datetime": "TIMESTAMP", "timestamp": "TIMESTAMP",
    "boolean": "BOOLEAN", "bool": "BOOLEAN",
}

# summarize aggregations -> SQL templates (the %s is the quoted column)
_AGG_FUNCS = {
    "sum": "SUM(%s)",
    "avg": "AVG(%s)",
    "min": "MIN(%s)",
    "max": "MAX(%s)",
    "count": "COUNT(%s)",
    "countd": "COUNT(DISTINCT %s)",
}

# window calculations -> SQL templates ("%s" marks the quoted source column;
# templates without it take no column). The OVER (...) clause is appended.
_WINDOW_FUNCS = {
    "row_number": "ROW_NUMBER()",
    "rank": "RANK()",
    "dense_rank": "DENSE_RANK()",
    "running_sum": "SUM(%s)",
    "running_avg": "AVG(%s)",
    "running_min": "MIN(%s)",
    "running_max": "MAX(%s)",
    "running_count": "COUNT(%s)",
    "lag": "LAG(%s)",
    "lead": "LEAD(%s)",
}


class NodeflowError(Exception):
    """A user-fixable problem; the message is shown directly to the user."""


class NodeRunError(NodeflowError):
    """A specific node failed at run time (its SQL errored on the engine).
    Carries which node so the UI can point at the exact culprit, plus a
    human-readable explanation as the message."""

    def __init__(self, message, node_id=None, node_type=None):
        super().__init__(message)
        self.node_id = node_id
        self.node_type = node_type


# Substrings (lower-cased) that mark a value/type mismatch a user fixes with a
# cast -- DuckDB and SQLite phrase these differently, so match several.
_TYPE_ERROR_MARKERS = (
    "no function matches", "explicit type cast", "binder error",
    "cannot cast", "could not convert", "conversion error",
    "no operator matches", "type mismatch", "invalid input syntax",
    "mismatch type",
)


def node_label(node):
    """Human label for a node: its type plus the name shown on the card, e.g.
    'formula node "net_amount"' or just 'select node'."""
    typ = ((node or {}).get("type") or "node")
    cfg = (node or {}).get("config") or {}
    name = str(cfg.get("label") or "").strip()
    return ('%s node "%s"' % (typ, name)) if name else ("%s node" % typ)


def explain_node_error(node, raw):
    """Turn a raw engine error into a message that names the node and, when it
    looks like a type/cast mismatch, says how to fix it."""
    raw = str(raw)
    low = raw.lower()
    hint = ""
    if any(m in low for m in _TYPE_ERROR_MARKERS):
        hint = (" This looks like a type mismatch -- often a text column used "
                "in arithmetic (the engine won't auto-convert text to a "
                "number). Cast it first, e.g. CAST(col AS BIGINT), or make sure "
                "the column is the right type.")
    return "The %s couldn't run: %s%s" % (node_label(node), raw, hint)


def _q(ident):
    return '"' + str(ident).replace('"', '""') + '"'


def _node_map(graph):
    return {n["id"]: n for n in (graph.get("nodes") or []) if n.get("id")}


def upstream(graph, node_id, in_port):
    """(src_node, src_port) feeding node_id's input in_port, or (None, None)."""
    for e in (graph.get("edges") or []):
        t = e.get("to") or {}
        if t.get("node") == node_id and t.get("port") == in_port:
            f = e.get("from") or {}
            return f.get("node"), f.get("port")
    return None, None


def _cols_of_rel(cols_of, rel):
    return cols_of("SELECT * FROM %s AS _c" % rel)


def _ident_cols(text):
    """Pull the column-ish identifiers out of a free-form expression (a filter
    condition, etc). Single-quoted string literals are stripped first so their
    contents aren't mistaken for columns. Returns bare words plus bracketed
    [name] and double-quoted "name" identifiers. Over-inclusion is harmless --
    the source intersects this against its real columns before pruning -- but
    we never want to miss a real reference, so we cast wide."""
    s = str(text or "")
    s = re.sub(r"'(?:[^']|'')*'", " ", s)            # drop '...' literals
    names = set(re.findall(r"\[([^\]]+)\]", s))      # [bracketed name]
    names |= set(re.findall(r'"((?:[^"]|"")*)"', s)) # "quoted name"
    names |= set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", s))  # bare words
    return {n.strip() for n in names if n and n.strip()}


def _project_source(base_sql, needed, cols_of):
    """Wrap a source's SQL so it reads only the columns that are actually used
    downstream. ``needed`` is a set of wanted column names (or None = all).
    Matching is case-insensitive and column order is preserved, so this is a
    pure narrowing -- it never drops a column that's still referenced, and if
    nothing can be pruned it returns the original SQL unchanged."""
    if not needed:
        return base_sql
    try:
        allcols = list(cols_of(base_sql) or [])
    except Exception:
        return base_sql
    if not allcols:
        return base_sql
    want = {str(n).lower() for n in needed}
    keep = [c for c in allcols if str(c).lower() in want]
    if not keep or len(keep) >= len(allcols):
        return base_sql  # nothing to gain (or, defensively, keep everything)
    return "SELECT %s FROM (%s) AS _proj" % (
        ", ".join(_q(c) for c in keep), base_sql)


def project_output_sql(base_sql, needed, cols_of):
    """Narrow any intermediate relation to its live output columns.

    Source nodes already call :func:`_project_source` directly.  The session
    also applies this wrapper at materialisation boundaries so filter/sort/group
    dependencies can be present while the operation runs, then disappear before
    the checkpoint is cached.  Unknown schemas fall back to the original SQL.
    """
    return _project_source(base_sql, needed, cols_of)


def _strlit(s):
    return "'%s'" % str(s).replace("'", "''")


def _snake(s):
    """A column name -> snake_case: split camelCase, turn runs of non-alnum
    into underscores, lowercase, trim."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(s))
    s = re.sub(r"[^0-9A-Za-z]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s or str(s)


def _brackets_to_idents(expr):
    """Turn [Field Name] references into "Field Name" quoted identifiers, so a
    formula can refer to fields with bracket syntax (raw "quoted" refs and
    unquoted refs keep working too). Brackets inside a single-quoted string
    literal are left untouched -- otherwise a regex character class like
    '[A-Za-z]' would be mangled into an identifier. An empty [] (the function
    templates' placeholder) is left as-is so it surfaces as an obvious error
    rather than a silent ""."""
    out = []
    i, n = 0, len(expr)
    in_str = False
    while i < n:
        ch = expr[i]
        if in_str:
            out.append(ch)
            if ch == "'":
                if i + 1 < n and expr[i + 1] == "'":  # '' escape -> literal '
                    out.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "[":
            j = expr.find("]", i + 1)
            if j != -1:
                inner = expr[i + 1:j].strip()
                if inner:
                    out.append('"%s"' % inner.replace('"', '""'))
                    i = j + 1
                    continue
        out.append(ch)
        i += 1
    return "".join(out)


def _split_call_args(expr, open_paren):
    """Split the comma-separated arguments of a call whose '(' is at index
    open_paren. Respects nested parentheses and single-quoted string literals.
    Returns (args, close_index); close_index is -1 if the parens are
    unbalanced."""
    args = []
    depth = 0
    i, n = open_paren, len(expr)
    in_str = False
    start = open_paren + 1
    while i < n:
        ch = expr[i]
        if in_str:
            if ch == "'":
                if i + 1 < n and expr[i + 1] == "'":
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                args.append(expr[start:i])
                return args, i
        elif ch == "," and depth == 1:
            args.append(expr[start:i])
            start = i + 1
        i += 1
    return args, -1


def _if_to_case(expr):
    """Rewrite IF(cond, then, else) into a portable CASE WHEN cond THEN then
    ELSE else END. SQLite has no IF() function, so without this the
    spreadsheet-style conditional fails on the SQLite engine (it works on
    DuckDB). IF is matched only as a standalone function call -- a non-identifier
    char before it and a '(' after -- so column names and longer words ending in
    'if' are safe; occurrences inside single-quoted strings are skipped; and
    nesting is handled by recursing into each argument. A malformed IF
    (unbalanced, or not exactly three arguments) is passed through untouched so
    the engine reports a clear error rather than us guessing."""
    out = []
    i, n = 0, len(expr)
    in_str = False
    while i < n:
        ch = expr[i]
        if in_str:
            out.append(ch)
            if ch == "'":
                if i + 1 < n and expr[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
            out.append(ch)
            i += 1
            continue
        if (ch in "Ii" and i + 1 < n and expr[i + 1] in "Ff"
                and (i == 0 or not (expr[i - 1].isalnum()
                                    or expr[i - 1] in '_."'))):
            j = i + 2
            while j < n and expr[j] in " \t":
                j += 1
            if j < n and expr[j] == "(":
                args, close = _split_call_args(expr, j)
                if close != -1 and len(args) == 3:
                    cond, then, els = (_if_to_case(a.strip()) for a in args)
                    out.append("CASE WHEN (%s) THEN (%s) ELSE (%s) END"
                               % (cond, then, els))
                    i = close + 1
                    continue
        out.append(ch)
        i += 1
    return "".join(out)


def _prepare_expr(expr):
    """Normalise a user-written SQL expression for the formula and filter nodes:
    resolve [Field] references to quoted identifiers and rewrite IF(...) into a
    portable CASE expression. Every other function is passed straight through to
    the engine (regexp_* and friends are registered for SQLite to match
    DuckDB), so no SELECT wrapper is ever needed -- just the expression."""
    return _if_to_case(_brackets_to_idents(expr))


def _assert_single_sql_fragment(text, what):
    """Reject multi-statement payloads in node-authored SQL fragments.

    Filter conditions, formula expressions, and SQL-node queries are spliced
    into compiled CREATE … AS SQL. SQLite's execute() splits on semicolons and
    runs every statement, so an embedded ``; DROP TABLE …`` would otherwise
    execute during a normal node run.
    """
    from .sqlutil import split_statements
    parts = [p for p in split_statements(text or "") if p and p.strip()]
    if len(parts) > 1:
        raise NodeflowError(
            "%s must be a single SQL expression (no extra statements after "
            "a semicolon)." % what)
    return text


_USERNODE_EXPAND_MAX_DEPTH = 8


def _assert_no_nested_usernode(nodes, *, where="graph"):
    """Raise when any usernode appears at top level or inside group children."""
    stack = list(nodes or [])
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        if node.get("type") == "usernode":
            raise NodeflowError(
                "Nested created nodes are not supported — expand the inner "
                "one into the tab before creating a new node "
                "(%s)." % where)
        cfg = node.get("config") or {}
        children = cfg.get("children") or []
        if isinstance(children, list):
            stack.extend(c for c in children if isinstance(c, dict))


def _sqlite_split_rows(src, col, delim, name, cols):
    """SQLite has no unnest/split-to-rows, so explode a delimited string column
    with a recursive CTE: peel one piece off the front each step. Columns other
    than the produced one are carried unchanged through the recursion."""
    d = _strlit(delim)
    qcol = _q(col)
    carry = [c for c in cols if c != name]
    carry_sel = "".join(", " + _q(c) for c in carry)
    seed = (
        "SELECT "
        "CASE WHEN instr(%(c)s, %(d)s)>0 THEN substr(%(c)s, instr(%(c)s,%(d)s)+length(%(d)s)) ELSE '' END AS _rest, "
        "CASE WHEN instr(%(c)s, %(d)s)>0 THEN substr(%(c)s, 1, instr(%(c)s,%(d)s)-1) ELSE %(c)s END AS _item"
        "%(carry)s FROM (%(src)s) AS _s"
    ) % {"c": qcol, "d": d, "carry": carry_sel, "src": src}
    rec = (
        "SELECT "
        "CASE WHEN instr(_rest, %(d)s)>0 THEN substr(_rest, instr(_rest,%(d)s)+length(%(d)s)) ELSE '' END AS _rest, "
        "CASE WHEN instr(_rest, %(d)s)>0 THEN substr(_rest, 1, instr(_rest,%(d)s)-1) ELSE _rest END AS _item"
        "%(carry)s FROM _ex_rec WHERE _rest <> ''"
    ) % {"d": d, "carry": carry_sel}
    proj = []
    for c in cols:
        proj.append("_item AS %s" % _q(c) if c == name else _q(c))
    if name not in cols:
        proj.append("_item AS %s" % _q(name))
    return (
        "WITH RECURSIVE _ex_rec(_rest, _item%s) AS (%s UNION ALL %s) "
        "SELECT %s FROM _ex_rec" % (carry_sel, seed, rec, ", ".join(proj))
    )


def node_output_sql(node, port, get_input, cols_of, engine=None, needed=None):
    """SQL producing the relation at (node, port).

    ``engine`` is "duckdb" / "sqlite" / None and lets a few nodes emit
    engine-specific SQL (e.g. JSON extraction).

    ``needed`` is an optional set of column names that are actually used
    downstream of this node (None = all). Source nodes use it to read only
    those columns, and projection-aware transforms omit unused passthrough or
    derived outputs. This keeps wide flows narrow without changing a target
    that is materialised in full."""
    typ = node.get("type")
    cfg = node.get("config") or {}
    label = cfg.get("label") or typ or "node"

    def need(in_port):
        r = get_input(in_port)
        if r is None:
            # NodeRunError so the UI can highlight the exact node, not just
            # name it in prose
            raise NodeRunError(
                'The "%s" node has an input with nothing connected to it.'
                % label,
                node_id=node.get("id"), node_type=typ)
        return r

    # a disabled (bypassed) node passes its primary input straight through, so
    # it can be toggled off without unwiring it. Only meaningful for nodes that
    # have an input; sources/sinks with nothing wired fall through to normal.
    if cfg.get("disabled"):
        ins = NODE_PORTS.get(typ, {}).get("in", [])
        if ins:
            src = get_input(ins[0])
            if src is not None:
                return "SELECT * FROM %s AS _bypass" % src

    if typ == "input":
        table = (cfg.get("table") or "").strip()
        if not table:
            raise NodeflowError("Pick a table for the input node.")
        return _project_source("SELECT * FROM %s" % _q(table), needed, cols_of)

    if typ == "directory":
        # a directory node reads a file the user picked from a folder; the file
        # is loaded into a hidden table when chosen, and referenced here.
        table = (cfg.get("table") or "").strip()
        if not table:
            raise NodeflowError(
                "Pick a folder and a file for the directory node.")
        return _project_source("SELECT * FROM %s" % _q(table), needed, cols_of)

    if typ == "appendfolder":
        # reads + stacks every file in a folder into a hidden table when the
        # folder is chosen; referenced here like an input.
        table = (cfg.get("table") or "").strip()
        if not table:
            raise NodeflowError(
                "Pick a folder for the append-from-folder node.")
        return _project_source("SELECT * FROM %s" % _q(table), needed, cols_of)

    if typ == "filebrowser":
        # Dynamic, run-time file load: a glob/path pattern (with ${vars}
        # already resolved) read DIRECTLY by DuckDB -- no pre-load step, so the
        # path can change per run/iteration. DuckDB globs natively, unions the
        # matched files by name (tolerating schema drift), and reads them
        # lazily/out-of-core. With a source column set, each row is tagged with
        # its file. SQLite can't read files from SQL, so it's DuckDB-only.
        if engine != "duckdb":
            raise NodeflowError(
                "The dynamic file browser reads files directly and needs "
                "DuckDB. Install DuckDB, or load files with the Input / "
                "Directory / Append-folder nodes on SQLite.")
        pat = (cfg.get("pattern") or "").strip()
        if not pat:
            raise NodeflowError(
                "Set a file path or glob in the file browser node -- it can "
                "include ${variables}, e.g. /data/*_${as_of}.csv.")
        esc = pat.replace("'", "''")  # keep the path inside the SQL string
        ext = pat.rsplit(".", 1)[-1].lower() if "." in pat else ""
        if ext in ("parquet", "pq"):
            reader = ("read_parquet('%s', filename=true, union_by_name=true)"
                      % esc)
        elif ext in ("json", "ndjson", "jsonl"):
            reader = "read_json_auto('%s', filename=true)" % esc
        else:
            reader = ("read_csv_auto('%s', filename=true, union_by_name=true)"
                      % esc)
        src = (cfg.get("source_column") or "").strip()
        if src:
            # expose DuckDB's filename column under the user's chosen name.
            base_sql = "SELECT * RENAME (filename AS %s) FROM %s" % (
                _q(src), reader)
        else:
            base_sql = "SELECT * EXCLUDE (filename) FROM %s" % reader
        # File-browser sources can be extremely wide.  Apply the same liveness
        # projection used by loaded-table inputs so DuckDB pushes the column
        # list into the file scan instead of reading every field first.
        return _project_source(base_sql, needed, cols_of)

    if typ == "apinode":
        # an API node fetches a JSON endpoint and loads it into a hidden table
        # when you press Fetch; it's referenced here like an input. The "err"
        # port exposes a small fixed-schema table of fetch failures -- 0 rows
        # when the last fetch succeeded, one row when continue-on-error caught
        # a failed fetch -- so a flow can branch error handling off it.
        if port == "err":
            et = (cfg.get("err_table") or "").strip()
            if not et:
                raise NodeflowError(
                    "Fetch from the API node first (press Fetch); its error "
                    "output appears after a fetch.")
            return _project_source("SELECT * FROM %s" % _q(et), needed, cols_of)
        table = (cfg.get("table") or "").strip()
        if not table:
            raise NodeflowError(
                "Fetch from the API node first (press Fetch) so it has data "
                "to read.")
        return _project_source("SELECT * FROM %s" % _q(table), needed, cols_of)

    if typ in ("sqlserver", "sharepoint", "webscrape"):
        table = (cfg.get("table") or "").strip()
        label = {
            "sqlserver": "SQL Server",
            "sharepoint": "SharePoint",
            "webscrape": "Web scrape",
        }.get(typ, typ)
        if not table:
            raise NodeflowError(
                "Fetch from the %s node first (press Fetch) so it has data "
                "to read." % label)
        return _project_source("SELECT * FROM %s" % _q(table), needed, cols_of)

    if typ == "shred":
        # .475/.494/.495: flatten a nested DuckDB load into its full relational
        # set (base + <base>_joinkeys + one table per list + the deep hierarchy
        # when elements carry their own arrays, all with single-column surrogate
        # keys _sk/_parent_sk so children join to parents on one column), via
        # the SAME flatten_table the Load-modal toggle uses (a pre-pass side
        # effect, not a SELECT). Emits ONE table (config["output"], default base).
        base = ((cfg.get("base") or cfg.get("table") or "")).strip()
        src_table = (cfg.get("table") or "").strip()
        if not base:
            raise NodeRunError(
                'Pick the loaded (nested) table for the "%s" node.' % label,
                node_id=node.get("id"), node_type=typ)
        out_tbl = (cfg.get("output") or "").strip() or base
        # .478 audit: a FLAT source has nothing to flatten, so the
        # pre-pass creates no base table. Rather than fail on a missing
        # table, fall back to the source itself -- the node passes the
        # (unnested) data straight through. cols_of raises if a table is
        # unknown, so probe the chosen output and degrade to the source.
        try:
            cols_of("SELECT * FROM %s" % _q(out_tbl))
        except Exception:
            if src_table:
                out_tbl = src_table
        return _project_source("SELECT * FROM %s" % _q(out_tbl),
                               needed, cols_of)

    if typ == "select":
        up = need("in")
        fields = cfg.get("fields") or []
        want = None if needed is None else {str(x).lower() for x in needed}
        sel = []
        for f in fields:
            if f.get("keep") is False:
                continue
            col = (f.get("name") or "").strip()
            if not col:
                continue
            alias = (f.get("rename") or col).strip() or col
            # A downstream projection may make configured fields dead. Omitting
            # them here is essential once their source columns have also been
            # pruned; otherwise strict engines bind a now-missing dead column.
            if want is not None and alias.lower() not in want:
                continue
            ty = (f.get("type") or "").strip().lower()
            expr = _q(col)
            if ty:
                expr = "CAST(%s AS %s)" % (_q(col), _SQL_TYPES.get(ty, "TEXT"))
            sel.append("%s AS %s" % (expr, _q(alias)))
        if not sel:
            raise NodeflowError(
                "Tick at least one field to keep in the select node.")
        return "SELECT %s FROM %s AS _s" % (", ".join(sel), up)

    if typ == "filter":
        up = need("in")
        cond = (cfg.get("condition") or "").strip()
        if not cond:
            raise NodeflowError(
                "Enter a condition for the filter node (e.g. score > 50).")
        _assert_single_sql_fragment(cond, "The filter condition")
        cond = _prepare_expr(cond)  # [Field] refs + portable IF(), like formulas
        if port == "true":
            return ("SELECT * FROM %s AS _f WHERE COALESCE((%s), FALSE)"
                    % (up, cond))
        if port == "false":
            return ("SELECT * FROM %s AS _f WHERE NOT COALESCE((%s), FALSE)"
                    % (up, cond))
        raise NodeflowError("Unknown filter output: %s" % port)

    if typ == "join":
        left = need("left")
        right = need("right")
        pairs = [(k.get("left"), k.get("right"))
                 for k in (cfg.get("keys") or [])
                 if k.get("left") and k.get("right")]
        if not pairs:
            raise NodeflowError(
                "Add at least one key pair (left = right) to the join node.")
        oncond = " AND ".join("a.%s = b.%s" % (_q(l), _q(r))
                              for l, r in pairs)
        # legacy per-side output ports still resolve for older saved workflows
        if port == "left_only":
            r0 = pairs[0][1]
            return ("SELECT a.* FROM %s AS a LEFT JOIN %s AS b ON %s "
                    "WHERE b.%s IS NULL" % (left, right, oncond, _q(r0)))
        if port == "right_only":
            l0 = pairs[0][0]
            return ("SELECT b.* FROM %s AS b LEFT JOIN %s AS a ON %s "
                    "WHERE a.%s IS NULL" % (right, left, oncond, _q(l0)))
        if port not in ("out", "inner"):
            raise NodeflowError("Unknown join output: %s" % port)
        # Three-output join (Alteryx-style): the "inner" port is always a plain
        # inner join (matching rows, columns from both sides) regardless of the
        # node's mode; "left_only"/"right_only" above are the unmatched sides.
        # The legacy single "out" port still honours the saved mode so older
        # workflows keep working.
        #   inner -> matching rows, columns from both sides
        #   left  -> all left rows + matching right columns (NULL when no match)
        #   semi  -> left rows that HAVE a match (left columns only)
        #   anti  -> left rows with NO match (left columns only)
        mode = "inner" if port == "inner" \
            else (cfg.get("mode") or "inner").strip().lower()
        if mode == "semi":
            return ("SELECT a.* FROM %s AS a WHERE EXISTS "
                    "(SELECT 1 FROM %s AS b WHERE %s)"
                    % (left, right, oncond))
        if mode == "anti":
            r0 = pairs[0][1]
            return ("SELECT a.* FROM %s AS a LEFT JOIN %s AS b ON %s "
                    "WHERE b.%s IS NULL" % (left, right, oncond, _q(r0)))
        if mode not in ("inner", "left"):
            raise NodeflowError("Unknown join mode: %s" % mode)
        join_kw = "JOIN" if mode == "inner" else "LEFT JOIN"
        lcols = _cols_of_rel(cols_of, left)
        rcols = _cols_of_rel(cols_of, right)
        # exclude join keys case-insensitively (a configured "ID" must still
        # drop a real "id"), and de-dup right aliases against the left columns
        # AND each other -- same proven scheme as multijoin -- so the result
        # never carries two columns with one name.
        rkeys = {r.lower() for _, r in pairs}
        lset = {c.lower() for c in lcols}
        used = set(lset)
        sel = ["a.%s" % _q(c) for c in lcols]
        for c in rcols:
            if c.lower() in rkeys:
                continue
            base = c if c.lower() not in lset else ("r_" + c)
            alias = base
            i = 2
            while alias.lower() in used:
                alias = "%s_%d" % (base, i)
                i += 1
            used.add(alias.lower())
            sel.append("b.%s AS %s" % (_q(c), _q(alias)))
        return "SELECT %s FROM %s AS a %s %s AS b ON %s" % (
            ", ".join(sel), left, join_kw, right, oncond)

    if typ == "multijoin":
        # an inner join across up to 5 inputs. Each input after the base is
        # joined to a chosen already-present input on its own key pair(s)
        # (composite keys supported); different inputs may join on different
        # fields, in a star or chained shape.
        ports = NODE_PORTS["multijoin"]["in"]
        rels = {}
        for p in ports:
            r = get_input(p)
            if r is not None:
                rels[p] = r
        if not rels:
            raise NodeflowError(
                "Connect at least one input to the multi-join node.")
        connected = [p for p in ports if p in rels]
        base = cfg.get("base")
        if base not in rels:
            base = connected[0]
        alias_of = {p: "_mj_%s" % p for p in connected}
        if len(connected) == 1:
            return "SELECT * FROM %s AS %s" % (rels[base], alias_of[base])
        present = {base}
        steps = []  # (input, against, [(left, right), ...])
        for j in (cfg.get("joins") or []):
            inp = j.get("input")
            against = j.get("against") or base
            if inp not in rels or inp == base or inp in present:
                continue
            pairs = [(k.get("left"), k.get("right"))
                     for k in (j.get("on") or [])
                     if k.get("left") and k.get("right")]
            if not pairs:
                raise NodeflowError(
                    "Each join needs at least one key pair (left = right).")
            if against not in present:
                raise NodeflowError(
                    "A join refers to an input (%s) that hasn't been joined "
                    "yet -- reorder the joins." % against)
            steps.append((inp, against, pairs))
            present.add(inp)
        if not steps:
            raise NodeflowError(
                "Add at least one join linking another input to the base.")
        used = set()

        def uniq(name):
            nm = name
            i = 2
            while nm.lower() in used:
                nm = "%s_%d" % (name, i)
                i += 1
            used.add(nm.lower())
            return nm
        sel = []
        for c in _cols_of_rel(cols_of, rels[base]):
            sel.append("%s.%s AS %s"
                       % (alias_of[base], _q(c), _q(uniq(c))))
        for inp, _against, pairs in steps:
            rkeys = {r for _, r in pairs}
            for c in _cols_of_rel(cols_of, rels[inp]):
                if c in rkeys:
                    continue
                cand = c if c.lower() not in used else ("%s_%s" % (inp, c))
                sel.append("%s.%s AS %s"
                           % (alias_of[inp], _q(c), _q(uniq(cand))))
        frm = "%s AS %s" % (rels[base], alias_of[base])
        for inp, against, pairs in steps:
            oncond = " AND ".join(
                "%s.%s = %s.%s"
                % (alias_of[against], _q(l), alias_of[inp], _q(r))
                for l, r in pairs)
            frm += " INNER JOIN %s AS %s ON %s" % (rels[inp], alias_of[inp],
                                                   oncond)
        return "SELECT %s FROM %s" % (", ".join(sel), frm)

    if typ == "union":
        rels = []
        for p in NODE_PORTS["union"]["in"]:
            r = get_input(p)
            if r is not None:
                rels.append(r)
        if not rels:
            raise NodeflowError(
                "Connect at least one input to the union node.")
        allcols = []
        seen = set()
        per = []
        for r in rels:
            c = _cols_of_rel(cols_of, r)
            per.append((r, {x.lower() for x in c}))
            for x in c:
                if x.lower() not in seen:
                    seen.add(x.lower())
                    allcols.append(x)
        parts = []
        for r, cset in per:
            sel = []
            for col in allcols:
                if col.lower() in cset:
                    sel.append(_q(col))
                else:
                    sel.append("NULL AS %s" % _q(col))
            parts.append("SELECT %s FROM %s AS _u" % (", ".join(sel), r))
        return " UNION ALL ".join(parts)

    if typ == "formula":
        up = need("in")
        valid = [((f.get("name") or "").strip(), (f.get("expr") or "").strip())
                 for f in (cfg.get("formulas") or [])
                 if (f.get("name") or "").strip()
                 and (f.get("expr") or "").strip()]
        if not valid:
            raise NodeflowError(
                "Add at least one formula (a column name and an expression) "
                "to the formula node.")
        for n, e in valid:
            _assert_single_sql_fragment(e, 'Formula "%s"' % n)
        fnames = {n.lower() for n, _ in valid}
        incols = _cols_of_rel(cols_of, up)
        want = None if needed is None else {str(x).lower() for x in needed}
        # Keep only passthrough columns and derived formulas that are consumed
        # downstream. The liveness pass has already retained every source
        # column referenced by the selected expressions.
        sel = [_q(c) for c in incols
               if c.lower() not in fnames
               and (want is None or c.lower() in want)]
        for n, e in valid:
            if want is None or n.lower() in want:
                sel.append("(%s) AS %s" % (_prepare_expr(e), _q(n)))
        if not sel:  # defensive fallback for an unknown downstream column
            sel = [_q(c) for c in incols if c.lower() not in fnames]
            sel.extend("(%s) AS %s" % (_prepare_expr(e), _q(n))
                       for n, e in valid)
        return "SELECT %s FROM %s AS _fx" % (", ".join(sel), up)

    if typ == "summarize":
        up = need("in")
        groups = [g for g in (cfg.get("group_by") or []) if g]
        valid = []
        for a in (cfg.get("aggs") or []):
            col = (a.get("col") or "").strip()
            func = (a.get("func") or "").strip().lower()
            if not col or func not in _AGG_FUNCS:
                continue
            name = (a.get("name") or "").strip() or ("%s_%s" % (func, col))
            valid.append((func, col, name))
        if not valid:
            raise NodeflowError(
                "Add at least one aggregation to the summarize node.")
        want = None if needed is None else {str(x).lower() for x in needed}
        # GROUP BY retains every configured key (dropping one changes row
        # cardinality), but unused keys/aggregates need not be projected.
        sel = [_q(g) for g in groups
               if want is None or g.lower() in want]
        for func, col, name in valid:
            if want is None or name.lower() in want:
                sel.append("%s AS %s" % (_AGG_FUNCS[func] % _q(col), _q(name)))
        if not sel:  # unknown requested output: preserve the legacy full shape
            sel = [_q(g) for g in groups]
            sel.extend("%s AS %s" % (_AGG_FUNCS[f] % _q(c), _q(n))
                       for f, c, n in valid)
        sql = "SELECT %s FROM %s AS _sm" % (", ".join(sel), up)
        if groups:
            sql += " GROUP BY %s" % ", ".join(_q(g) for g in groups)
        return sql

    if typ == "sort":
        up = need("in")
        terms = []
        for srt in (cfg.get("sorts") or []):
            col = (srt.get("col") or "").strip()
            if not col:
                continue
            d = (srt.get("dir") or "asc").strip().lower()
            terms.append("%s %s" % (_q(col), "DESC" if d.startswith("desc")
                                    else "ASC"))
        if not terms:
            raise NodeflowError("Pick at least one field to sort the sort node by.")
        return "SELECT * FROM %s AS _so ORDER BY %s" % (up, ", ".join(terms))

    if typ == "sample":
        up = need("in")
        mode = (cfg.get("mode") or "head").strip().lower()
        try:
            n = max(1, int(cfg.get("n") or 100))
        except (TypeError, ValueError):
            n = 100
        if mode == "random":
            return ("SELECT * FROM %s AS _sm ORDER BY RANDOM() LIMIT %d"
                    % (up, n))
        return "SELECT * FROM %s AS _sm LIMIT %d" % (up, n)

    if typ == "unique":
        up = need("in")
        by = [c for c in (cfg.get("by") or []) if c]
        if not by:
            return "SELECT DISTINCT * FROM %s AS _un" % up
        incols = _cols_of_rel(cols_of, up)
        inner_sel = ", ".join(_q(c) for c in incols)
        keyexpr = ", ".join(_q(c) for c in by)
        # keep one arbitrary-but-deterministic row per distinct key combination
        return (
            "SELECT %s FROM (SELECT %s, ROW_NUMBER() OVER "
            "(PARTITION BY %s ORDER BY %s) AS _rn FROM %s AS _un) AS _ur "
            "WHERE _rn = 1" % (inner_sel, inner_sel, keyexpr, keyexpr, up))

    if typ == "unpivot":
        up = need("in")
        keep = [c for c in (cfg.get("keep") or []) if c]
        cols = [c for c in (cfg.get("unpivot") or []) if c]
        if not cols:
            raise NodeflowError(
                "Pick at least one column for the unpivot node to turn into rows.")
        name_field = (cfg.get("name_field") or "field").strip() or "field"
        value_field = (cfg.get("value_field") or "value").strip() or "value"
        parts = []
        for c in cols:
            sel = [_q(k) for k in keep]
            sel.append("'%s' AS %s" % (c.replace("'", "''"), _q(name_field)))
            sel.append("%s AS %s" % (_q(c), _q(value_field)))
            parts.append("SELECT %s FROM %s AS _up" % (", ".join(sel), up))
        return " UNION ALL ".join(parts)

    if typ == "window":
        up = need("in")
        valid = []
        for w in (cfg.get("windows") or []):
            func = (w.get("func") or "").strip().lower()
            if func not in _WINDOW_FUNCS:
                continue
            name = (w.get("name") or "").strip()
            if not name:
                continue
            col = (w.get("col") or "").strip()
            tmpl = _WINDOW_FUNCS[func]
            if "%s" in tmpl and not col:
                continue
            part = [c for c in (w.get("partition_by") or []) if c]
            order = [((o.get("col") or "").strip(), (o.get("dir") or "asc"))
                     for o in (w.get("order_by") or []) if (o.get("col") or "").strip()]
            valid.append((tmpl, col, name, part, order))
        if not valid:
            raise NodeflowError(
                "Add at least one window calculation (a function and a name) "
                "to the window node.")
        incols = _cols_of_rel(cols_of, up)
        wnames = {n.lower() for _, _, n, _, _ in valid}
        want = None if needed is None else {str(x).lower() for x in needed}
        sel = [_q(c) for c in incols
               if c.lower() not in wnames
               and (want is None or c.lower() in want)]
        for tmpl, col, name, part, order in valid:
            if want is not None and name.lower() not in want:
                continue
            fn = tmpl % _q(col) if "%s" in tmpl else tmpl
            over = []
            if part:
                over.append("PARTITION BY " + ", ".join(_q(c) for c in part))
            if order:
                over.append("ORDER BY " + ", ".join(
                    "%s %s" % (_q(c), "DESC" if d.lower().startswith("desc")
                               else "ASC") for c, d in order))
            sel.append("%s OVER (%s) AS %s" % (fn, " ".join(over), _q(name)))
        if not sel:
            sel = [_q(c) for c in incols if c.lower() not in wnames]
            for tmpl, col, name, part, order in valid:
                fn = tmpl % _q(col) if "%s" in tmpl else tmpl
                over = []
                if part:
                    over.append("PARTITION BY " + ", ".join(_q(c) for c in part))
                if order:
                    over.append("ORDER BY " + ", ".join(
                        "%s %s" % (_q(c), "DESC" if d.lower().startswith("desc")
                                   else "ASC") for c, d in order))
                sel.append("%s OVER (%s) AS %s" % (fn, " ".join(over), _q(name)))
        return "SELECT %s FROM %s AS _w" % (", ".join(sel), up)

    if typ == "perioddelta":
        src = need("in")
        value = (cfg.get("value") or "").strip()
        order = (cfg.get("order") or "").strip()
        if not value:
            raise NodeflowError("Pick the value column for period change.")
        if not order:
            raise NodeflowError("Pick the period/order column for period change.")
        partition = [c for c in (cfg.get("partition") or []) if c]
        try:
            offset = max(1, min(int(cfg.get("offset") or 1), 100000))
        except (TypeError, ValueError):
            offset = 1
        mode = (cfg.get("mode") or "absolute").strip().lower()
        if mode not in ("absolute", "percent", "previous", "running_total"):
            mode = "absolute"
        out = (cfg.get("out") or ({
            "absolute": "period_change",
            "percent": "period_change_pct",
            "previous": "previous_value",
            "running_total": "running_total",
        }[mode])).strip()
        if not out:
            raise NodeflowError("Name the period-change output column.")
        direction = "DESC" if str(cfg.get("dir") or "asc").lower().startswith("desc") else "ASC"
        over_parts = []
        if partition:
            over_parts.append("PARTITION BY " + ", ".join(_q(c) for c in partition))
        over_parts.append("ORDER BY %s %s" % (_q(order), direction))
        over = " ".join(over_parts)
        prev = "LAG(%s, %d) OVER (%s)" % (_q(value), offset, over)
        if mode == "previous":
            expr = prev
        elif mode == "running_total":
            expr = ("SUM(%s) OVER (%s ROWS BETWEEN UNBOUNDED PRECEDING "
                    "AND CURRENT ROW)" % (_q(value), over))
        elif mode == "percent":
            expr = ("CASE WHEN (%(p)s) IS NULL OR (%(p)s) = 0 THEN NULL "
                    "ELSE ((%(v)s) - (%(p)s)) * 100.0 / (%(p)s) END"
                    % {"p": prev, "v": _q(value)})
        else:
            expr = "(%s) - (%s)" % (_q(value), prev)
        incols = _cols_of_rel(cols_of, src)
        want = None if needed is None else {str(x).lower() for x in needed}
        sel = [_q(c) for c in incols
               if c.lower() != out.lower()
               and (want is None or c.lower() in want)]
        if want is None or out.lower() in want:
            sel.append("%s AS %s" % (expr, _q(out)))
        if not sel:
            sel = [_q(c) for c in incols if c.lower() != out.lower()]
            sel.append("%s AS %s" % (expr, _q(out)))
        return "SELECT %s FROM %s AS _pd" % (", ".join(sel), src)

    if typ == "bin":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a column for the bin node.")
        parsed = []
        for c in (cfg.get("cuts") or []):
            raw = c.get("le")
            if raw is None or str(raw).strip() == "":
                continue
            try:
                le = float(raw)
            except Exception:
                continue
            lbl = c.get("label")
            if lbl is None or str(lbl).strip() == "":
                lbl = "<= %s" % raw
            parsed.append((le, str(lbl)))
        if not parsed:
            raise NodeflowError(
                "Add at least one numeric cut point to the bin node.")
        parsed.sort(key=lambda t: t[0])
        out = (cfg.get("out") or "bucket").strip() or "bucket"
        else_label = str(cfg.get("else_label") or "other")
        whens = ["WHEN %s IS NULL THEN NULL" % _q(col)]
        for le, lbl in parsed:
            whens.append("WHEN %s <= %s THEN '%s'"
                         % (_q(col), le, lbl.replace("'", "''")))
        case = "CASE %s ELSE '%s' END" % (
            " ".join(whens), else_label.replace("'", "''"))
        return "SELECT *, %s AS %s FROM %s AS _bin" % (case, _q(out), src)

    if typ == "rank":
        src = need("in")
        order = (cfg.get("order") or "").strip()
        if not order:
            raise NodeflowError("Pick a field to rank by for the rank node.")
        method = (cfg.get("method") or "row_number").lower()
        if method not in ("row_number", "rank", "dense_rank"):
            method = "row_number"
        direction = "DESC" if (cfg.get("dir") or "desc").lower() == "desc" \
            else "ASC"
        parts = [p for p in (cfg.get("partition") or []) if p]
        out = (cfg.get("out") or "rank").strip() or "rank"
        over = ("PARTITION BY %s " % ", ".join(_q(p) for p in parts)) \
            if parts else ""
        over += "ORDER BY %s %s" % (_q(order), direction)
        ranked = "SELECT *, %s() OVER (%s) AS %s FROM %s AS _r" % (
            method, over, _q(out), src)
        top = cfg.get("top_n")
        try:
            topn = int(top) if top not in (None, "") else None
        except Exception:
            topn = None
        if topn and topn > 0:
            return "SELECT * FROM (%s) AS _rk WHERE %s <= %d" % (
                ranked, _q(out), topn)
        return ranked

    if typ == "fill":
        src = need("in")
        cols = _cols_of_rel(cols_of, src)
        fills = {}
        for f in (cfg.get("fills") or []):
            c = (f.get("col") or "").strip()
            if c:
                fills[c] = f
        if not fills:
            raise NodeflowError(
                "Pick at least one column to fill in the fill node.")
        sel = []
        for c in cols:
            f = fills.get(c)
            if not f:
                sel.append(_q(c))
                continue
            method = (f.get("method") or "value").lower()
            if method == "avg":
                expr = "AVG(%s) OVER ()" % _q(c)
            elif method == "min":
                expr = "MIN(%s) OVER ()" % _q(c)
            elif method == "max":
                expr = "MAX(%s) OVER ()" % _q(c)
            elif method == "zero":
                expr = "0"
            elif method == "empty":
                expr = "''"
            else:
                v = f.get("value")
                if v is None or str(v) == "":
                    expr = "''"
                else:
                    vs = str(v)
                    try:
                        float(vs)
                        expr = vs
                    except Exception:
                        expr = "'%s'" % vs.replace("'", "''")
            sel.append("COALESCE(%s, %s) AS %s" % (_q(c), expr, _q(c)))
        if not sel:
            return "SELECT * FROM %s AS _fill" % src
        return "SELECT %s FROM %s AS _fill" % (", ".join(sel), src)

    if typ == "dedupe":
        src = need("in")
        keys = [k for k in (cfg.get("keys") or []) if k]
        if not keys:
            raise NodeflowError(
                "Pick at least one key column for the dedupe node.")
        sort = (cfg.get("sort") or "").strip()
        keep = (cfg.get("keep") or "first").lower()
        if sort:
            orderby = "%s %s" % (_q(sort), "DESC" if keep == "last" else "ASC")
        else:
            orderby = ", ".join(_q(k) for k in keys)
        cols = _cols_of_rel(cols_of, src)
        proj = ", ".join(_q(c) for c in cols) if cols else "*"
        ranked = ("SELECT *, ROW_NUMBER() OVER (PARTITION BY %s ORDER BY %s) "
                  "AS _dd_rn FROM %s AS _dd"
                  % (", ".join(_q(k) for k in keys), orderby, src))
        return "SELECT %s FROM (%s) AS _ddx WHERE _dd_rn = 1" % (proj, ranked)

    if typ == "split":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a column to split.")
        delim = cfg.get("delim")
        if delim is None or str(delim) == "":
            raise NodeflowError("Set a delimiter for the split node.")
        delim = str(delim)
        names = [str(n).strip() for n in (cfg.get("names") or []) if str(n).strip()]
        if not names:
            raise NodeflowError(
                "Name at least one output column for the split node.")
        dq = delim.replace("'", "''")
        dlen = len(delim)
        inner = src
        prev = _q(col)
        n = len(names)
        for i in range(n):
            part = ("CASE WHEN instr(%s, '%s') > 0 THEN substr(%s, 1, "
                    "instr(%s, '%s') - 1) ELSE %s END"
                    % (prev, dq, prev, prev, dq, prev))
            sel = ["*", "%s AS %s" % (part, _q(names[i]))]
            if i < n - 1:
                rcol = "_sp_r%d" % i
                rest = ("CASE WHEN instr(%s, '%s') > 0 THEN substr(%s, "
                        "instr(%s, '%s') + %d) ELSE '' END"
                        % (prev, dq, prev, prev, dq, dlen))
                sel.append("%s AS %s" % (rest, _q(rcol)))
                prev = _q(rcol)
            inner = "(SELECT %s FROM %s AS _sp%d)" % (", ".join(sel), inner, i)
        orig = _cols_of_rel(cols_of, src)
        final = [_q(c) for c in orig] + [_q(nm) for nm in names]
        return "SELECT %s FROM %s AS _spf" % (", ".join(final), inner)

    if typ == "validate":
        # passes data through unchanged; the checks are run by a preview
        # (validate_nodeflow), not from this relation
        return "SELECT * FROM %s AS _val" % need("in")

    if typ == "jsonextract":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a JSON column to extract from.")
        extracts = [(e.get("path"), e.get("name"))
                    for e in (cfg.get("extracts") or [])
                    if e.get("path") and e.get("name")]
        if not extracts:
            raise NodeflowError(
                "Add at least one field to extract (path -> new column).")
        names = {n for _, n in extracts}
        cols = _cols_of_rel(cols_of, src)
        sel = [_q(c) for c in cols if c not in names]
        for path, name in extracts:
            p = str(path).strip()
            if not p.startswith("$"):
                p = "$." + p
            pq = p.replace("'", "''")
            if engine == "duckdb":
                # json_extract_string returns the unquoted scalar text
                expr = "json_extract_string(%s, '%s')" % (_q(col), pq)
            else:
                # SQLite's json_extract already returns unquoted scalars
                expr = "json_extract(%s, '%s')" % (_q(col), pq)
            sel.append("%s AS %s" % (expr, _q(name)))
        return "SELECT %s FROM %s AS _jx" % (", ".join(sel), src)

    if typ == "explode":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a column to explode into rows.")
        mode = (cfg.get("mode") or "json").strip().lower()
        name = (cfg.get("name") or col).strip() or col
        cols = _cols_of_rel(cols_of, src)
        if mode == "delim":
            delim = cfg.get("delim")
            if delim in (None, ""):
                raise NodeflowError(
                    "Enter a delimiter to split on (e.g. a comma).")
            if engine == "duckdb":
                others = [c for c in cols if c != name]
                keep = "".join(_q(c) + ", " for c in others)
                return ("SELECT %sunnest(string_split(%s, %s)) AS %s "
                        "FROM (%s) AS _ex"
                        % (keep, _q(col), _strlit(delim), _q(name), src))
            return _sqlite_split_rows(src, col, delim, name, cols)
        if mode == "nested":
            # Native DuckDB LIST/STRUCT column (or a nested field path like
            # json[1].receivingLeg): UNNEST(..., recursive := true) explodes the
            # list into rows AND every nested list/struct inside each element
            # into columns, all the way down. DuckDB only.
            if engine != "duckdb":
                raise NodeflowError(
                    "Explode nested (recursive) needs the DuckDB engine -- "
                    "SQLite has no UNNEST. Switch the flow's engine to DuckDB.")
            # `col` may be a plain column (quote it) or a path expression into
            # one (pass through; its names resolve against the subquery). The
            # exploded column -- or a path's BASE column (json[1].x -> json) --
            # is dropped from the kept columns so a huge nested blob isn't
            # repeated on every exploded row.
            is_plain = col in cols
            expr = _q(col) if is_plain else col
            base = col if is_plain else re.split(r"[\[.\s]", col.strip(), 1)[0]
            others = [c for c in cols if c != base]
            keep = "".join(_q(c) + ", " for c in others)
            return ("SELECT %sUNNEST(%s, recursive := true) FROM (%s) AS _ex"
                    % (keep, expr, src))
        # JSON-array mode
        if engine == "duckdb":
            others = [c for c in cols if c != name]
            keep = "".join("_ex." + _q(c) + ", " for c in others)
            return ("SELECT %sunnest(from_json(_ex.%s, '[\"json\"]')) AS %s "
                    "FROM (%s) AS _ex" % (keep, _q(col), _q(name), src))
        # SQLite: json_each expands a JSON array into rows
        proj = []
        for c in cols:
            if c == name:
                proj.append("_je.value AS %s" % _q(c))
            else:
                proj.append("_ex.%s AS %s" % (_q(c), _q(c)))
        if name not in cols:
            proj.append("_je.value AS %s" % _q(name))
        return ("SELECT %s FROM (%s) AS _ex, json_each(_ex.%s) AS _je"
                % (", ".join(proj), src, _q(col)))

    if typ == "textclean":
        src = need("in")
        targets = [c for c in (cfg.get("cols") or []) if c]
        if not targets and (cfg.get("col") or "").strip():  # legacy single col
            targets = [(cfg.get("col") or "").strip()]
        if not targets:
            raise NodeflowError("Pick at least one column to clean.")
        ops = cfg.get("ops") or []
        cols = _cols_of_rel(cols_of, src)

        def apply_ops(expr):
            for op in ops:
                kind = (op.get("op") or "").strip().lower()
                if kind == "trim":
                    expr = "TRIM(%s)" % expr
                elif kind == "ltrim":
                    expr = "LTRIM(%s)" % expr
                elif kind == "rtrim":
                    expr = "RTRIM(%s)" % expr
                elif kind == "upper":
                    expr = "UPPER(%s)" % expr
                elif kind == "lower":
                    expr = "LOWER(%s)" % expr
                elif kind == "replace":
                    expr = "REPLACE(%s, %s, %s)" % (
                        expr, _strlit(op.get("find") or ""),
                        _strlit(op.get("replace") or ""))
                elif kind == "substring":
                    try:
                        start = int(op.get("start") or 1)
                    except (TypeError, ValueError):
                        start = 1
                    length = op.get("length")
                    if length in (None, ""):
                        expr = "SUBSTR(%s, %d)" % (expr, start)
                    else:
                        try:
                            expr = "SUBSTR(%s, %d, %d)" % (
                                expr, start, int(length))
                        except (TypeError, ValueError):
                            expr = "SUBSTR(%s, %d)" % (expr, start)
                elif kind in ("padleft", "padright"):
                    try:
                        n = int(op.get("n") or 0)
                    except (TypeError, ValueError):
                        n = 0
                    ch = (str(op.get("char") or " ")[:1]) or " "
                    chl = _strlit(ch)
                    if engine == "duckdb":
                        fn = "LPAD" if kind == "padleft" else "RPAD"
                        expr = "%s(%s, %d, %s)" % (fn, expr, n, chl)
                    else:
                        pad = ("substr(replace(hex(zeroblob(%d)), '00', %s), "
                               "1, %d - length(%s))" % (n, chl, n, expr))
                        if kind == "padleft":
                            expr = ("CASE WHEN length(%s) >= %d THEN %s "
                                    "ELSE %s || %s END"
                                    % (expr, n, expr, pad, expr))
                        else:
                            expr = ("CASE WHEN length(%s) >= %d THEN %s "
                                    "ELSE %s || %s END"
                                    % (expr, n, expr, expr, pad))
                elif kind in ("fillnull", "fill"):
                    # fill blanks: replace NULLs with a value or a statistic of
                    # this column (folds in what the old Fill-nulls node did).
                    fm = (op.get("method") or "value").lower()
                    if fm == "avg":
                        fillexpr = "AVG(%s) OVER ()" % expr
                    elif fm == "min":
                        fillexpr = "MIN(%s) OVER ()" % expr
                    elif fm == "max":
                        fillexpr = "MAX(%s) OVER ()" % expr
                    elif fm == "zero":
                        fillexpr = "0"
                    elif fm == "empty":
                        fillexpr = "''"
                    else:
                        v = op.get("value")
                        if v is None or str(v) == "":
                            fillexpr = "''"
                        else:
                            vs = str(v)
                            try:
                                float(vs)
                                fillexpr = vs
                            except Exception:
                                fillexpr = _strlit(vs)
                    expr = "COALESCE(%s, %s)" % (expr, fillexpr)
                # unknown ops are skipped
            return expr

        tset = set(targets)
        proj = []
        for c in cols:
            proj.append("%s AS %s" % (apply_ops(_q(c)), _q(c))
                        if c in tset else _q(c))
        return "SELECT %s FROM %s AS _tc" % (", ".join(proj), src)

    if typ == "antijoin":
        left = need("left")
        right = need("right")
        pairs = [(k.get("left"), k.get("right"))
                 for k in (cfg.get("keys") or [])
                 if k.get("left") and k.get("right")]
        if not pairs:
            raise NodeflowError(
                "Add at least one key pair (left = right) to the anti-join.")
        mode = (cfg.get("mode") or "anti").strip().lower()
        oncond = " AND ".join("a.%s = b.%s" % (_q(l), _q(r))
                              for l, r in pairs)
        if mode == "semi":
            # rows in LEFT that HAVE a match in RIGHT (left columns only, no
            # row multiplication) -- EXISTS keeps it to one row per left row
            return ("SELECT a.* FROM %s AS a WHERE EXISTS "
                    "(SELECT 1 FROM %s AS b WHERE %s)"
                    % (left, right, oncond))
        # anti: rows in LEFT with NO match in RIGHT
        r0 = pairs[0][1]
        return ("SELECT a.* FROM %s AS a LEFT JOIN %s AS b ON %s "
                "WHERE b.%s IS NULL" % (left, right, oncond, _q(r0)))

    if typ == "groupconcat":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a column to concatenate.")
        name = (cfg.get("name") or (col + "_list")).strip() or (col + "_list")
        delim = cfg.get("delim")
        if delim in (None, ""):
            delim = ", "
        groups = [g for g in (cfg.get("group") or []) if g]
        distinct = bool(cfg.get("distinct"))
        if engine == "duckdb":
            inner = "CAST(%s AS VARCHAR)" % _q(col)
            d = ("DISTINCT " if distinct else "")
            agg = "string_agg(%s%s, %s) AS %s" % (
                d, inner, _strlit(delim), _q(name))
        else:
            inner = "CAST(%s AS TEXT)" % _q(col)
            if distinct:
                # SQLite group_concat(DISTINCT x) only supports a comma
                # separator, so the custom delimiter is ignored when distinct
                agg = "group_concat(DISTINCT %s) AS %s" % (inner, _q(name))
            else:
                agg = "group_concat(%s, %s) AS %s" % (
                    inner, _strlit(delim), _q(name))
        if groups:
            gq = ", ".join(_q(g) for g in groups)
            return ("SELECT %s, %s FROM %s AS _gc GROUP BY %s"
                    % (gq, agg, src, gq))
        return "SELECT %s FROM %s AS _gc" % (agg, src)

    if typ == "date":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a date/time column.")
        op = (cfg.get("op") or "part").strip().lower()
        qcol = _q(col)
        if op == "part":
            part = (cfg.get("part") or "year").strip().lower()
            default_name = col + "_" + part
            if engine == "duckdb":
                duck = {"weekday": "dow", "dayofyear": "doy"}.get(part, part)
                expr = "CAST(date_part('%s', %s) AS INTEGER)" % (duck, qcol)
            elif part == "quarter":
                expr = ("((CAST(strftime('%%m', %s) AS INTEGER) + 2) / 3)"
                        % qcol)
            else:
                fmt = {"year": "%Y", "month": "%m", "day": "%d",
                       "hour": "%H", "minute": "%M", "second": "%S",
                       "weekday": "%w", "dayofyear": "%j",
                       "week": "%W"}.get(part)
                if not fmt:
                    raise NodeflowError("Unknown date part: %s" % part)
                expr = "CAST(strftime('%s', %s) AS INTEGER)" % (fmt, qcol)
        elif op == "trunc":
            unit = (cfg.get("unit") or "month").strip().lower()
            default_name = col + "_" + unit
            if engine == "duckdb":
                expr = "date_trunc('%s', %s)" % (unit, qcol)
            else:
                tmap = {"year": "%Y-01-01", "month": "%Y-%m-01",
                        "day": "%Y-%m-%d", "hour": "%Y-%m-%d %H:00:00"}
                f = tmap.get(unit)
                if not f:
                    raise NodeflowError(
                        "Truncate to year, month, day, or hour.")
                expr = "strftime('%s', %s)" % (f, qcol)
        elif op == "diff":
            unit = (cfg.get("unit") or "day").strip().lower()
            other = (cfg.get("other") or "").strip()
            default_name = col + "_diff"
            other_expr = (_q(other) if other and other.lower() != "now"
                          else "CURRENT_TIMESTAMP")
            if engine == "duckdb":
                expr = "date_diff('%s', %s, %s)" % (unit, other_expr, qcol)
            else:
                days = "(julianday(%s) - julianday(%s))" % (qcol, other_expr)
                mult = {"day": "", "hour": " * 24", "minute": " * 1440",
                        "second": " * 86400"}.get(unit, "")
                expr = "CAST(%s%s AS INTEGER)" % (days, mult)
        else:
            raise NodeflowError("Unknown date op: %s" % op)
        name = (cfg.get("name") or default_name).strip() or default_name
        cols = _cols_of_rel(cols_of, src)
        proj = []
        for c in cols:
            proj.append("%s AS %s" % (expr, _q(c)) if c == name else _q(c))
        if name not in cols:
            proj.append("%s AS %s" % (expr, _q(name)))
        return "SELECT %s FROM %s AS _dt" % (", ".join(proj), src)

    if typ == "maprecode":
        src = need("in")
        col = (cfg.get("col") or "").strip()
        if not col:
            raise NodeflowError("Pick a column to remap.")
        name = (cfg.get("name") or col).strip() or col
        mappings = [(m.get("from"), m.get("to"))
                    for m in (cfg.get("mappings") or [])
                    if m.get("from") is not None]
        cols = _cols_of_rel(cols_of, src)
        # compare and emit as text so a CASE over mixed types is well-defined
        base = ("CAST(%s AS VARCHAR)" if engine == "duckdb"
                else "CAST(%s AS TEXT)") % _q(col)
        whens = ["WHEN %s = %s THEN %s"
                 % (base, _strlit("" if f is None else f),
                    _strlit("" if t is None else t))
                 for f, t in mappings]
        if (cfg.get("default") or "passthrough").strip().lower() == "value":
            els = _strlit(cfg.get("default_value") or "")
        else:
            els = base  # passthrough (kept as text)
        expr = ("CASE %s ELSE %s END" % (" ".join(whens), els)) if whens else els
        proj = []
        for c in cols:
            proj.append("%s AS %s" % (expr, _q(c)) if c == name else _q(c))
        if name not in cols:
            proj.append("%s AS %s" % (expr, _q(name)))
        return "SELECT %s FROM %s AS _mr" % (", ".join(proj), src)

    if typ == "parse":
        src = need("in")
        targets = [c for c in (cfg.get("cols") or []) if c]
        if not targets and (cfg.get("col") or "").strip():  # legacy single col
            targets = [(cfg.get("col") or "").strip()]
        if not targets:
            raise NodeflowError("Pick at least one column to parse.")
        to = (cfg.get("to") or "number").strip().lower()
        fmt = (cfg.get("format") or "").strip()
        group = cfg.get("group")
        if group is None:
            group = ","

        def parse_expr(qcol):
            if to in ("date", "datetime", "timestamp"):
                if engine == "duckdb":
                    if fmt:
                        e = "strptime(%s, %s)" % (qcol, _strlit(fmt))
                        return "CAST(%s AS DATE)" % e if to == "date" else e
                    return "CAST(%s AS %s)" % (
                        qcol, "DATE" if to == "date" else "TIMESTAMP")
                # SQLite has no strptime; best-effort ISO parse (format ignored)
                return ("date(%s)" if to == "date" else "datetime(%s)") % qcol
            if to in ("number", "double", "float", "integer", "int"):
                cleaned = qcol
                for ch in [group, "$", " "]:
                    if ch:
                        cleaned = "REPLACE(%s, %s, '')" % (cleaned, _strlit(ch))
                if to in ("integer", "int"):
                    return ("CAST(CAST(%s AS DOUBLE) AS BIGINT)" % cleaned
                            if engine == "duckdb"
                            else "CAST(%s AS INTEGER)" % cleaned)
                return "CAST(%s AS %s)" % (
                    cleaned, "DOUBLE" if engine == "duckdb" else "REAL")
            raise NodeflowError(
                "Parse target must be date, datetime, number, or integer.")

        cols = _cols_of_rel(cols_of, src)
        tset = set(targets)
        proj = []
        for c in cols:
            proj.append("%s AS %s" % (parse_expr(_q(c)), _q(c))
                        if c in tset else _q(c))
        return "SELECT %s FROM %s AS _ps" % (", ".join(proj), src)

    if typ == "topn":
        src = need("in")
        sort = (cfg.get("sort") or "").strip()
        if not sort:
            raise NodeflowError("Pick a column to rank by for top-N.")
        try:
            n = int(cfg.get("n") or 10)
        except (TypeError, ValueError):
            n = 10
        if n < 1:
            n = 1
        desc = bool(cfg.get("desc"))
        groups = [g for g in (cfg.get("group") or []) if g]
        cols = _cols_of_rel(cols_of, src)
        part = ("PARTITION BY " + ", ".join(_q(g) for g in groups) + " "
                if groups else "")
        order = "%s %s" % (_q(sort), "DESC" if desc else "ASC")
        inner = ("SELECT *, ROW_NUMBER() OVER (%sORDER BY %s) AS _tn_rn "
                 "FROM %s AS _tn" % (part, order, src))
        proj = ", ".join(_q(c) for c in cols)
        return ("SELECT %s FROM (%s) AS _tnw WHERE _tn_rn <= %d"
                % (proj, inner, n))

    if typ == "crossjoin":
        left = need("left")
        right = need("right")
        lcols = _cols_of_rel(cols_of, left)
        rcols = _cols_of_rel(cols_of, right)
        # de-dup right aliases against the left columns AND each other so a
        # cross join never emits two columns with one name (mirrors the join /
        # multijoin scheme; a cross join has no keys to exclude).
        lset = {c.lower() for c in lcols}
        used = set(lset)
        sel = ["a.%s" % _q(c) for c in lcols]
        for c in rcols:
            base = c if c.lower() not in lset else ("r_" + c)
            alias = base
            i = 2
            while alias.lower() in used:
                alias = "%s_%d" % (base, i)
                i += 1
            used.add(alias.lower())
            sel.append("b.%s AS %s" % (_q(c), _q(alias)))
        return ("SELECT %s FROM %s AS a CROSS JOIN %s AS b"
                % (", ".join(sel), left, right))

    if typ == "coalesce":
        src = need("in")
        pick = [c for c in (cfg.get("cols") or []) if c]
        if not pick:
            raise NodeflowError(
                "Pick at least one column for the coalesce node.")
        name = (cfg.get("name") or "coalesced").strip() or "coalesced"
        cols = _cols_of_rel(cols_of, src)
        expr = "COALESCE(%s)" % ", ".join(_q(c) for c in pick)
        proj = []
        for c in cols:
            proj.append("%s AS %s" % (expr, _q(c)) if c == name else _q(c))
        if name not in cols:
            proj.append("%s AS %s" % (expr, _q(name)))
        return "SELECT %s FROM %s AS _co" % (", ".join(proj), src)

    if typ == "renamecols":
        src = need("in")
        cols = _cols_of_rel(cols_of, src)
        prefix = cfg.get("prefix") or ""
        suffix = cfg.get("suffix") or ""
        case = (cfg.get("case") or "").strip().lower()
        find = cfg.get("find") or ""
        repl = cfg.get("replace") or ""
        mp = {m.get("from"): m.get("to")
              for m in (cfg.get("mappings") or [])
              if m.get("from") and m.get("to")}
        seen = {}
        sel = []
        for c in cols:
            if c in mp:
                new = mp[c]
            else:
                new = c
                if case == "snake":
                    new = _snake(new)
                elif case == "lower":
                    new = new.lower()
                elif case == "upper":
                    new = new.upper()
                if find:
                    new = new.replace(find, repl)
                new = prefix + new + suffix
            new = (new or "").strip() or c
            # avoid duplicate output names (which SQL would reject)
            base, k = new, 2
            while new in seen:
                new = "%s_%d" % (base, k)
                k += 1
            seen[new] = True
            if needed is None or new.lower() in {str(x).lower() for x in needed}:
                sel.append("%s AS %s" % (_q(c), _q(new)))
        if not sel and cols:
            # An unrecognised requested output should never turn a relation into
            # invalid SELECT-with-no-columns SQL; fall back to the full rename.
            seen = {}
            for c in cols:
                if c in mp:
                    new = mp[c]
                else:
                    new = c
                    if case == "snake":
                        new = _snake(new)
                    elif case == "lower":
                        new = new.lower()
                    elif case == "upper":
                        new = new.upper()
                    if find:
                        new = new.replace(find, repl)
                    new = prefix + new + suffix
                new = (new or "").strip() or c
                base, k = new, 2
                while new in seen:
                    new = "%s_%d" % (base, k)
                    k += 1
                seen[new] = True
                sel.append("%s AS %s" % (_q(c), _q(new)))
        if not sel:
            raise NodeflowError("Connect an input to rename its columns.")
        return "SELECT %s FROM %s AS _rn" % (", ".join(sel), src)

    if typ == "reconcile":
        # The reconcile node's *output* is a per-key reconciliation summary:
        # one row per distinct key (across both inputs) with a status, each
        # side's row count, and -- when a balance column is chosen -- the summed
        # balance per side plus the difference. (The richer field-level report
        # is produced separately by Run reconcile.) Built with a portable
        # UNION-of-three so it works on every SQLite as well as DuckDB; no CTEs
        # (those break when this relation is wrapped as a subquery).
        L0 = need("left")
        R0 = need("right")
        keys = [k for k in (cfg.get("keys") or []) if k]
        if not keys:
            raise NodeflowError(
                "Pick at least one key field to reconcile on.")
        bal = (cfg.get("balance") or "").strip()

        def _num(qcol):
            txt = "CAST(%s AS %s)" % (
                qcol, "VARCHAR" if engine == "duckdb" else "TEXT")
            for ch in ("$", ",", " "):
                txt = "REPLACE(%s, %s, '')" % (txt, _strlit(ch))
            return ("TRY_CAST(%s AS DOUBLE)" % txt if engine == "duckdb"
                    else "CAST(%s AS REAL)" % txt)

        def _agg(subq):
            ksel = ", ".join(_q(k) for k in keys)
            cols = [ksel, "COUNT(*) AS _rows"]
            if bal:
                cols.append("SUM(%s) AS _bal" % _num(_q(bal)))
            return "(SELECT %s FROM %s AS _r GROUP BY %s)" % (
                ", ".join(cols), subq, ksel)

        LA, RA = _agg(L0), _agg(R0)
        on = " AND ".join("LA.%s = RA.%s" % (_q(k), _q(k)) for k in keys)
        on_l = " AND ".join("LA.%s = R.%s" % (_q(k), _q(k)) for k in keys)
        on_r = " AND ".join("RA.%s = L.%s" % (_q(k), _q(k)) for k in keys)
        kL = ", ".join("LA.%s AS %s" % (_q(k), _q(k)) for k in keys)
        kR = ", ".join("RA.%s AS %s" % (_q(k), _q(k)) for k in keys)
        if bal:
            bl, br, bd = _q(bal + "_left"), _q(bal + "_right"), _q(bal + "_diff")
            xm = (", LA._bal AS %s, RA._bal AS %s, "
                  "(COALESCE(LA._bal,0) - COALESCE(RA._bal,0)) AS %s"
                  % (bl, br, bd))
            xl = ", LA._bal AS %s, NULL AS %s, NULL AS %s" % (bl, br, bd)
            xr = ", NULL AS %s, RA._bal AS %s, NULL AS %s" % (bl, br, bd)
        else:
            xm = xl = xr = ""
        matched = (
            "SELECT %s, 'matched' AS reconcile_status, "
            "LA._rows AS left_rows, RA._rows AS right_rows%s "
            "FROM %s AS LA JOIN %s AS RA ON %s" % (kL, xm, LA, RA, on))
        left_only = (
            "SELECT %s, 'left_only' AS reconcile_status, "
            "LA._rows AS left_rows, NULL AS right_rows%s "
            "FROM %s AS LA WHERE NOT EXISTS "
            "(SELECT 1 FROM %s AS R WHERE %s)" % (kL, xl, LA, RA, on_l))
        right_only = (
            "SELECT %s, 'right_only' AS reconcile_status, "
            "NULL AS left_rows, RA._rows AS right_rows%s "
            "FROM %s AS RA WHERE NOT EXISTS "
            "(SELECT 1 FROM %s AS L WHERE %s)" % (kR, xr, RA, LA, on_r))
        return "SELECT * FROM (%s UNION ALL %s UNION ALL %s) AS _rec" % (
            matched, left_only, right_only)

    if typ in ("chart", "browse", "profile"):
        # chart / browse pass their data through unchanged; the chart or the
        # column profile is produced by a preview (run_nodeflow_chart /
        # run_nodeflow_browse), not from this relation
        return "SELECT * FROM %s AS _v" % need("in")

    if typ == "createtable":
        cols = [str(c).strip() for c in (cfg.get("columns") or [])
                if str(c).strip()]
        if not cols:
            raise NodeflowError("Add at least one column to the table node.")
        ncol = len(cols)
        body = []
        for r in (cfg.get("rows") or []):
            vals = list(r)[:ncol] + [None] * (ncol - len(r))
            if all(v is None or str(v).strip() == "" for v in vals):
                continue
            body.append(vals)
        if not body:
            raise NodeflowError("Add at least one row to the table node.")
        import re as _re
        numre = _re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$")

        def _isnum(v):
            return v is not None and bool(numre.match(str(v).strip()))
        numeric = []
        for ci in range(ncol):
            vals = [r[ci] for r in body
                    if r[ci] is not None and str(r[ci]).strip() != ""]
            numeric.append(bool(vals) and all(_isnum(v) for v in vals))

        def _lit(v, isnum):
            if v is None or str(v).strip() == "":
                return "NULL"
            s = str(v)
            if isnum:
                return s.strip()
            return "'" + s.replace("'", "''") + "'"
        selects = []
        for ri, r in enumerate(body):
            if ri == 0:
                cells = ", ".join(
                    "%s AS %s" % (_lit(r[ci], numeric[ci]), _q(cols[ci]))
                    for ci in range(ncol))
            else:
                cells = ", ".join(_lit(r[ci], numeric[ci])
                                  for ci in range(ncol))
            selects.append("SELECT " + cells)
        return " UNION ALL ".join(selects)

    if typ == "text":
        raise NodeflowError("A text note isn't a data step -- it has no "
                            "output to run.")

    if typ == "sql":
        q = (cfg.get("sql") or "").strip()
        while q.endswith(";"):
            q = q[:-1].rstrip()
        if not q:
            raise NodeflowError("Write a SELECT query in the SQL node.")
        _assert_single_sql_fragment(q, "The SQL node query")
        low = q.lower()
        if not (low.startswith("select") or low.startswith("with")):
            raise NodeflowError(
                "The SQL node must be a read query "
                "(SELECT ... or WITH ... SELECT ...).")
        up = get_input("in")
        from_input = re.search(r"(?i)\b(from|join)\s+input\b", q)
        uses_mustache = "{{in}}" in q or "{{input}}" in q
        if (from_input or uses_mustache) and up is None:
            raise NodeflowError(
                "The SQL node reads from `input`, but nothing is connected "
                "to its input.")
        if uses_mustache:
            q = q.replace("{{input}}", up).replace("{{in}}", up)
        if from_input:
            # `input` is the data wired into this node -- splice it in wherever
            # the query does FROM input / JOIN input (leaving the IN operator,
            # column names, etc. untouched)
            q = re.sub(r"(?i)\b(from|join)\s+input\b",
                       lambda m: m.group(1) + " " + up, q)
        return "SELECT * FROM (%s) AS _sql" % q

    if typ == "python":
        # Python nodes materialise via session._materialize_flows (they cannot
        # compile to SQL). This branch exists so port-parity / compile_port
        # callers get a clear error instead of "unsupported type".
        raise NodeflowError(
            "Python nodes run when the flow materialises — use Run or Preview."
        )

    if typ == "write":
        # a sink: passthrough so its upstream can be materialised, then the
        # session writes the materialised relation out as a loaded table.
        return "SELECT * FROM %s AS _w" % need("in")

    if typ == "group":
        # a group is a mini-pipeline. By default it's a linear chain: the
        # group's primary input feeds the first child, each child feeds the
        # next, and the group's output is the last child's output.
        #
        # config["bindings"] = {childId: {childInPort: groupInputPort}} lets a
        # step pull a given input port straight from one of the group's own
        # inputs ("in", "in2", ... "in5") instead of from the step above it --
        # so a join (or any multi-input node) inside the group can be fed two
        # separate inputs. An unbound port falls back to the linear default,
        # so a group with no bindings behaves exactly as before.
        children = [c for c in (cfg.get("children") or []) if c.get("type")]
        if not children:
            return "SELECT * FROM %s AS _grp" % need("in")
        _assert_no_nested_usernode(children, where="group children")
        bindings = cfg.get("bindings") or {}
        _group_input_needs, child_needs = _group_liveness_plan(node, needed)
        cur = None  # running relation as "(...)"; None before the first child
        for idx, child in enumerate(children):
            ctype = child.get("type")
            if ctype == "usernode":
                raise NodeflowError(
                    "Created Node instances cannot live inside a group — "
                    "move them onto the canvas first.")
            cid = child.get("id")
            cnode = {"type": ctype, "config": child.get("config") or {},
                     "id": cid}
            ports = NODE_PORTS.get(ctype, {"in": ["in"], "out": ["out"]})
            in_ports = ports.get("in") or []
            out_ports = ports.get("out") or []
            first_in = in_ports[0] if in_ports else None
            prev = cur
            cbind = bindings.get(cid) or {}

            def _gi(port, _prev=prev, _first=first_in, _idx=idx, _bind=cbind):
                # explicit binding to one of the group's own inputs wins
                gp = _bind.get(port)
                if gp:
                    return get_input(gp)  # None if that group input isn't wired
                # otherwise the linear pipeline: the first input port is the
                # step above (or the group's primary input for the first step);
                # any other input port is left unfed (None) unless bound above
                if _first is not None and port == _first:
                    return _prev if _idx > 0 else need("in")
                return None
            outp = ("inner" if "inner" in out_ports
                    else "out" if "out" in out_ports
                    else (out_ports[0] if out_ports else None))
            # Passing each child's live output set prevents an unused
            # configured field inside a group from forcing the whole input wide.
            child_sql = node_output_sql(
                cnode, outp, _gi, cols_of, engine,
                needed=child_needs.get(idx))
            cur = "(" + child_sql + ")"
        return "SELECT * FROM %s AS _grpout" % cur

    if typ == "dyn_input":
        raise NodeflowError(
            "Dynamic Input is a placeholder for creating a reusable node. "
            "Wire it into a flow, then use Settings → Create a node.")

    if typ == "dyn_output":
        # Passthrough while authoring; created-node expansion starts upstream.
        return "SELECT * FROM %s AS _dynout" % need("in")

    if typ == "usernode":
        return _expand_usernode(node, port, get_input, cols_of, engine, needed)

    if typ == "output":
        return "SELECT * FROM %s AS _o" % need("in")

    if typ == "samqldash":
        # App Dashboard sink: relation passthrough so the Dashboard tab can
        # also run tabular upstreams. Chart / reconcile are handled client-side.
        return "SELECT * FROM %s AS _dash" % need("in")

    if typ == "iterator":
        # the iterator's "out" port reads from its accumulator table (named in
        # the inspector, filled by running the iterator). The loop itself is
        # side-effecting and runs from the iterator's Run button; this lets
        # downstream nodes read the accumulated result by table name so you can
        # build onto the iterator without a separate Input node. If the
        # accumulator hasn't been produced yet, the engine reports the missing
        # table -- run the iterator first.
        accum = sanitize_ident(cfg.get("table"))
        if not accum:
            raise NodeflowError(
                "Name the iterator's accumulator table in its inspector, then "
                "run the iterator to fill it before reading its output.")
        return _project_source(
            'SELECT * FROM "%s" AS _iter' % accum, needed, cols_of)

    if typ == "while":
        # a while/until controller, run from its own Run button; like the
        # iterator it writes into an accumulator table rather than exposing a
        # data port. Reached only if something tries to read it as data.
        raise NodeflowError(
            "Run the Repeat-until controller with its Run button. It writes "
            "results into its accumulator table -- add an Input node pointed "
            "at that table to use them downstream.")

    if typ == "dashboard":
        # a dashboard is a view built client-side from up to four chart inputs;
        # it has no relation of its own. It is saved as an image via an Output
        # node, so this is only reached if it is misused as data.
        raise NodeflowError(
            "A dashboard is a view, not a table -- connect it to an Output "
            "node to save it as an image.")

    raise NodeflowError("This node type isn't supported yet: %s" % typ)


def _expand_usernode(node, port, outer_get_input, cols_of, engine, needed,
                     _depth=0):
    """Compile one output of a user-authored macro node.

    The instance config embeds the authored graph plus port maps that link
    external inN/outN ports to Dynamic Input / Dynamic Output node ids.
    """
    if _depth >= _USERNODE_EXPAND_MAX_DEPTH:
        raise NodeflowError(
            "Created node nesting is too deep (max %d). "
            "Remove nested Created Node instances from the definition."
            % _USERNODE_EXPAND_MAX_DEPTH)
    cfg = node.get("config") or {}
    label = cfg.get("label") or cfg.get("name") or "created node"
    inner = cfg.get("graph") or {}
    if not isinstance(inner, dict) or not (inner.get("nodes") or []):
        raise NodeflowError(
            'The "%s" created node has no saved graph.' % label)
    _assert_no_nested_usernode(inner.get("nodes") or [],
                               where='created node "%s"' % label)

    inputs = cfg.get("inputs") or []
    outputs = cfg.get("outputs") or []
    dyn_in_by_id = {}
    for item in inputs:
        if not isinstance(item, dict):
            continue
        nid = item.get("nodeId")
        p = item.get("port")
        if nid and p:
            dyn_in_by_id[nid] = p
    out_by_port = {}
    for item in outputs:
        if not isinstance(item, dict):
            continue
        p = item.get("port")
        nid = item.get("nodeId")
        if p and nid:
            out_by_port[p] = nid

    dyn_out_id = out_by_port.get(port)
    if not dyn_out_id:
        raise NodeRunError(
            'The "%s" node has no Dynamic Output for port "%s".'
            % (label, port),
            node_id=node.get("id"), node_type="usernode")

    sn, sp = upstream(inner, dyn_out_id, "in")
    if sn is None:
        raise NodeRunError(
            'The "%s" node\'s Dynamic Output ("%s") has nothing connected.'
            % (label, port),
            node_id=node.get("id"), node_type="usernode")

    return _compile_usernode_port(
        inner, sn, sp, cols_of, engine, outer_get_input, dyn_in_by_id,
        needed=needed)


def _compile_usernode_port(graph, node_id, port, cols_of, engine, outer_get,
                           dyn_in_by_id, _stack=None, _memo=None, needed=None):
    """Like compile_port, but Dynamic Input ports read from the outer usernode."""
    nodes = _node_map(graph)
    node = nodes.get(node_id)
    if node is None:
        raise NodeflowError("A node inside this created node is missing.")
    typ = node.get("type")
    if typ == "usernode":
        raise NodeflowError(
            "Nested created nodes are not supported — expand the inner one "
            "into the tab before creating a new node.")
    if typ == "dyn_output":
        raise NodeflowError(
            "Dynamic Output nodes cannot feed other Dynamic Outputs.")

    _stack = _stack or []
    if _memo is None:
        _memo = {}
    key = (node_id, port)
    if key in _stack:
        raise NodeflowError(
            "This created node has a loop — remove the cycle inside it.")
    if key in _memo:
        return _memo[key]
    stack = _stack + [key]

    if typ == "dyn_input":
        ext = dyn_in_by_id.get(node_id)
        if not ext:
            raise NodeflowError(
                "A Dynamic Input inside this created node is not mapped.")
        src = outer_get(ext)
        if src is None:
            raise NodeRunError(
                'Connect input "%s" on the created node.' % ext,
                node_id=node_id, node_type="dyn_input")
        sql = "SELECT * FROM %s AS _udi" % src
        _memo[key] = sql
        return sql

    def get_input(in_port):
        sn, sp = upstream(graph, node_id, in_port)
        if sn is None:
            return None
        return "(" + _compile_usernode_port(
            graph, sn, sp, cols_of, engine, outer_get, dyn_in_by_id,
            stack, _memo) + ")"

    sql = node_output_sql(node, port, get_input, cols_of, engine, needed)
    if len(sql) > _MAX_COMPILED_SQL:
        raise NodeflowError(
            "This created node expands into too much SQL. Materialise a "
            "shared step into a table and read from that instead.")
    _memo[key] = sql
    return sql


def compile_port(graph, node_id, port, cols_of, _stack=None, engine=None,
                 _memo=None):
    """Compose (node, port) and its upstream as nested subqueries.

    .481 audit: memoised by (node_id, port). Without it, a diamond-shaped
    graph (a node fanning out and rejoining) recompiled every shared
    ancestor once per path -- EXPONENTIAL in the number of diamonds
    (a depth-12 lattice made 8191 compile calls). The memo caches each
    port's compiled SQL for the duration of one top-level compile, so a
    shared node is composed exactly once. The cycle guard still uses the
    per-path _stack (a real loop must still raise, not hit the cache)."""
    nodes = _node_map(graph)
    node = nodes.get(node_id)
    if node is None:
        raise NodeflowError("That node no longer exists.")
    _stack = _stack or []
    if _memo is None:
        _memo = {}
    key = (node_id, port)
    if key in _stack:
        raise NodeflowError("This flow has a loop -- remove the cycle.")
    if key in _memo:
        return _memo[key]
    stack = _stack + [key]

    def get_input(in_port):
        sn, sp = upstream(graph, node_id, in_port)
        if sn is None:
            return None
        return "(" + compile_port(graph, sn, sp, cols_of, stack, engine,
                                  _memo) + ")"

    sql = node_output_sql(node, port, get_input, cols_of, engine)
    # .481 audit: even with memoised COMPILATION, a diamond graph inlines
    # a shared subquery once per reference, so the SQL TEXT can still grow
    # exponentially (a deep fan-out lattice reached tens of MB and OOM'd
    # the process). Cap the composed SQL and fail with actionable guidance
    # instead -- the fix for the user is to materialise the shared node
    # into a table (a Create/Output node) and read that.
    if len(sql) > _MAX_COMPILED_SQL:
        raise NodeflowError(
            "This flow expands into too much SQL -- a node feeds several "
            "branches that rejoin, so its query is repeated many times. "
            "Materialise the shared step into a table (Create node) and "
            "read from that instead.")
    _memo[key] = sql
    return sql


# .481 audit: a hard cap on composed SQL size. Past this, a fan-out/
# rejoin graph is inlining a subquery exponentially; we stop with a
# clear message rather than build tens of MB of SQL and OOM.
_MAX_COMPILED_SQL = 4_000_000  # ~4 MB of SQL text


# Port layout per node type -- shared contract with the frontend canvas.
NODE_PORTS = {
    "input": {"in": [], "out": ["out"]},
    "shred": {"in": [], "out": ["out"]},
    "select": {"in": ["in"], "out": ["out"]},
    "filter": {"in": ["in"], "out": ["true", "false"]},
    "formula": {"in": ["in"], "out": ["out"]},
    "summarize": {"in": ["in"], "out": ["out"]},
    "sort": {"in": ["in"], "out": ["out"]},
    "sample": {"in": ["in"], "out": ["out"]},
    "unique": {"in": ["in"], "out": ["out"]},
    "unpivot": {"in": ["in"], "out": ["out"]},
    "window": {"in": ["in"], "out": ["out"]},
    "perioddelta": {"in": ["in"], "out": ["out"]},
    "bin": {"in": ["in"], "out": ["out"]},
    "rank": {"in": ["in"], "out": ["out"]},
    "fill": {"in": ["in"], "out": ["out"]},
    "dedupe": {"in": ["in"], "out": ["out"]},
    "split": {"in": ["in"], "out": ["out"]},
    "validate": {"in": ["in"], "out": ["out"]},
    "jsonextract": {"in": ["in"], "out": ["out"]},
    "explode": {"in": ["in"], "out": ["out"]},
    "textclean": {"in": ["in"], "out": ["out"]},
    "antijoin": {"in": ["left", "right"], "out": ["out"]},
    "groupconcat": {"in": ["in"], "out": ["out"]},
    "date": {"in": ["in"], "out": ["out"]},
    "maprecode": {"in": ["in"], "out": ["out"]},
    "parse": {"in": ["in"], "out": ["out"]},
    "topn": {"in": ["in"], "out": ["out"]},
    "crossjoin": {"in": ["left", "right"], "out": ["out"]},
    "coalesce": {"in": ["in"], "out": ["out"]},
    "renamecols": {"in": ["in"], "out": ["out"]},
    "browse": {"in": ["in"], "out": ["out"]},
    "profile": {"in": ["in"], "out": ["out"]},
    "join": {"in": ["left", "right"], "out": ["left_only", "inner", "right_only"]},
    "multijoin": {"in": ["in1", "in2", "in3", "in4", "in5"],
                  "out": ["out"]},
    "union": {"in": ["in1", "in2", "in3", "in4", "in5",
                     "in6", "in7", "in8", "in9", "in10"],
              "out": ["out"]},
    "pivot": {"in": ["in"], "out": ["out"]},
    "chart": {"in": ["in"], "out": ["out"]},
    "reconcile": {"in": ["left", "right"], "out": ["out"]},
    "createtable": {"in": [], "out": ["out"]},
    "text": {"in": [], "out": []},
    "variable": {"in": [], "out": []},
    "directory": {"in": [], "out": ["out"]},
    "appendfolder": {"in": [], "out": ["out"]},
    "filebrowser": {"in": [], "out": ["out"]},
    "apinode": {"in": [], "out": ["out", "err"]},
    "sqlserver": {"in": [], "out": ["out"]},
    "sharepoint": {"in": [], "out": ["out"]},
    "webscrape": {"in": [], "out": ["out"]},
    "iterator": {"in": ["vars", "in"], "out": ["out"]},
    "while": {"in": ["in"], "out": []},
    "sql": {"in": ["in"], "out": ["out"]},
    "python": {"in": ["in"], "out": ["out"]},
    "write": {"in": ["in"], "out": ["out"]},
    "output": {"in": ["in"], "out": []},
    "samqldash": {"in": ["in"], "out": []},
    "group": {"in": ["in", "in2", "in3", "in4", "in5"], "out": ["out"]},
    "dashboard": {"in": ["in1", "in2", "in3", "in4"], "out": ["out"]},
    "dyn_input": {"in": [], "out": ["out"]},
    "dyn_output": {"in": ["in"], "out": []},
    "usernode": {"in": ["in1", "in2", "in3", "in4", "in5",
                        "in6", "in7", "in8", "in9", "in10"],
                 "out": ["out1", "out2", "out3", "out4", "out5",
                         "out6", "out7", "out8", "out9", "out10"]},
}


# ---- projection pushdown (column liveness) --------------------------------
# Liveness is deliberately conservative: every helper may retain extra columns,
# but it must never drop a field that affects values, row count, ordering, or
# grouping.  The source intersects names with its real schema, so harmless
# over-inclusion is preferable to a false negative.

def _preferred_output_port(node_type):
    outs = list(NODE_PORTS.get(node_type, {}).get("out", ["out"]) or [])
    if "inner" in outs:
        return "inner"
    if "out" in outs:
        return "out"
    return outs[0] if outs else None


def _group_liveness_plan(node, needed_out):
    """Return ``(group_input_needs, child_output_needs)`` for a group node.

    A group is a compact graph encoded as a linear child list plus optional
    bindings from child input ports to the group's own input ports.  Rebuilding
    that tiny graph here lets the normal liveness engine reason through nested
    groups, joins, formulas, filters, and explicit secondary bindings instead
    of treating every group as an opaque ``SELECT *`` boundary.
    """
    cfg = node.get("config") or {}
    children = [c for c in (cfg.get("children") or []) if c.get("type")]
    group_ports = list(NODE_PORTS["group"]["in"])
    if not children:
        return ({p: (needed_out if p == "in" else set())
                 for p in group_ports}, {})
    if needed_out is not None and not needed_out:
        return ({p: set() for p in group_ports},
                {i: set() for i in range(len(children))})

    src_ids = {p: "__grp_src_%s" % p for p in group_ports}
    child_ids = ["__grp_child_%d" % i for i in range(len(children))]
    snodes = [
        {"id": sid, "type": "input", "config": {"table": sid}}
        for sid in src_ids.values()
    ]
    for i, child in enumerate(children):
        snodes.append({
            "id": child_ids[i],
            "type": child.get("type"),
            "config": child.get("config") or {},
        })

    bindings = cfg.get("bindings") or {}
    edges = []
    prev_id = None
    prev_port = None
    out_ports = {}
    for i, child in enumerate(children):
        typ = child.get("type")
        cid = child.get("id")
        sid = child_ids[i]
        ports = NODE_PORTS.get(typ, {"in": ["in"], "out": ["out"]})
        in_ports = list(ports.get("in") or [])
        first_in = in_ports[0] if in_ports else None
        cbind = bindings.get(cid) or {}
        for inp in in_ports:
            gp = cbind.get(inp)
            if gp in src_ids:
                edges.append({
                    "from": {"node": src_ids[gp], "port": "out"},
                    "to": {"node": sid, "port": inp},
                })
            elif inp == first_in:
                if prev_id is not None and prev_port is not None:
                    edges.append({
                        "from": {"node": prev_id, "port": prev_port},
                        "to": {"node": sid, "port": inp},
                    })
                else:
                    edges.append({
                        "from": {"node": src_ids["in"], "port": "out"},
                        "to": {"node": sid, "port": inp},
                    })
        prev_id = sid
        prev_port = _preferred_output_port(typ)
        out_ports[i] = prev_port

    if prev_id is None or prev_port is None:
        return ({p: None for p in group_ports}, {})

    target = (prev_id, prev_port)
    if needed_out is not None:
        # A synthetic select expresses the exact columns the outer group must
        # emit; needed_columns treats an actual target as full by definition.
        select_id = "__grp_live_target"
        snodes.append({
            "id": select_id,
            "type": "select",
            "config": {"fields": [
                {"name": str(c), "keep": True}
                for c in sorted(needed_out, key=lambda x: str(x).lower())
            ]},
        })
        edges.append({
            "from": {"node": prev_id, "port": prev_port},
            "to": {"node": select_id, "port": "in"},
        })
        target = (select_id, "out")

    try:
        live = needed_columns({"nodes": snodes, "edges": edges}, [target])
    except Exception:
        return ({p: None for p in group_ports}, {})
    input_needs = {p: live.get((sid, "out")) for p, sid in src_ids.items()}
    child_needs = {
        i: live.get((child_ids[i], out_ports.get(i) or "out"))
        for i in range(len(children))
    }
    return input_needs, child_needs


def _node_needed_inputs(node, in_port, needed_out):
    """Given the columns needed from this node's OUTPUT (a set, or None=all),
    return the columns it needs from ``in_port`` (a set, or None=all)."""
    typ = node.get("type")
    cfg = node.get("config") or {}

    # A bypassed node is a pure passthrough.
    if cfg.get("disabled"):
        return needed_out

    if typ == "group":
        inputs, _children = _group_liveness_plan(node, needed_out)
        return inputs.get(in_port)

    if typ == "select":
        if in_port != "in":
            return None
        kept = [f for f in (cfg.get("fields") or [])
                if f.get("keep") is not False
                and (f.get("name") or "").strip()]
        if needed_out is None:
            return {(f.get("name") or "").strip() for f in kept}
        want = {str(n).lower() for n in needed_out}
        return {(f.get("name") or "").strip() for f in kept
                if ((f.get("rename") or f.get("name") or "")
                    .strip().lower() in want)}

    if typ == "summarize":
        if in_port != "in":
            return None
        groups = {g for g in (cfg.get("group_by") or []) if g}
        aggs = []
        for a in (cfg.get("aggs") or []):
            col = (a.get("col") or "").strip()
            func = (a.get("func") or "").strip().lower()
            if col and func in _AGG_FUNCS:
                name = (a.get("name") or "").strip() or "%s_%s" % (func, col)
                aggs.append((name, col))
        if needed_out is None:
            return groups | {c for _n, c in aggs}
        want = {str(n).lower() for n in needed_out}
        return groups | {c for n, c in aggs if n.lower() in want}

    if typ == "pivot":
        if in_port != "in":
            return None
        rows = {c for c in (cfg.get("rows") or []) if c}
        cols = cfg.get("cols")
        if cols is None:
            cols = [cfg.get("col")] if cfg.get("col") else []
        dims = rows | {c for c in (cols or []) if c}
        vals = cfg.get("values")
        if vals is None:
            vals = [{"field": cfg.get("value")}] if cfg.get("value") else []
        return dims | {(v.get("field") or "").strip() for v in vals
                       if (v.get("field") or "").strip()}

    if typ == "unpivot":
        if in_port != "in":
            return None
        keep = {c for c in (cfg.get("keep") or []) if c}
        vals = {c for c in (cfg.get("unpivot") or []) if c}
        if needed_out is None:
            return keep | vals
        # The configured value columns are referenced by every UNION branch,
        # even when a later select keeps only identifiers.
        return ({c for c in keep if c in needed_out} | vals)

    if typ == "groupconcat":
        if in_port != "in":
            return None
        deps = {c for c in (cfg.get("group") or []) if c}
        col = (cfg.get("col") or "").strip()
        if col:
            deps.add(col)
        return deps

    if typ == "reconcile":
        if in_port not in ("left", "right"):
            return None
        deps = {c for c in (cfg.get("keys") or []) if c}
        bal = (cfg.get("balance") or "").strip()
        if bal:
            deps.add(bal)
        return deps

    if needed_out is None:
        return None

    want = set(needed_out)
    want_l = {str(n).lower() for n in want}

    if typ in ("chart", "browse", "profile", "validate", "write",
               "output", "sample"):
        return want

    if typ == "filter":
        if in_port != "in":
            return None
        return want | _ident_cols(cfg.get("condition") or "")

    if typ == "sort":
        cols = {(s.get("col") or "").strip()
                for s in (cfg.get("sorts") or []) if (s.get("col") or "").strip()}
        return want | cols

    if typ == "dedupe":
        keys = {k for k in (cfg.get("keys") or []) if k}
        srt = (cfg.get("sort") or "").strip()
        if srt:
            keys.add(srt)
        return want | keys

    if typ == "unique":
        by = [c for c in (cfg.get("by") or []) if c]
        if not by:
            return None
        return want | set(by)

    if typ == "formula":
        deps = set()
        outputs = {}
        for f in (cfg.get("formulas") or []):
            name = (f.get("name") or "").strip()
            expr = (f.get("expr") or "").strip()
            if name and expr:
                outputs[name.lower()] = expr
        for out in want:
            expr = outputs.get(str(out).lower())
            if expr is None:
                deps.add(out)
            else:
                deps |= _ident_cols(expr)
        return deps

    if typ == "python":
        # Opaque user script — pull the full upstream relation when wired.
        if in_port != "in":
            return None
        return None

    if typ == "window":
        produced = {
            str(w.get("name") or "").strip().lower()
            for w in (cfg.get("windows") or [])
        }
        deps = {n for n in want if str(n).lower() not in produced}
        for w in (cfg.get("windows") or []):
            name = (w.get("name") or "").strip()
            if not name or name.lower() not in want_l:
                continue
            col = (w.get("col") or "").strip()
            if col:
                deps.add(col)
            deps |= {c for c in (w.get("partition_by") or []) if c}
            deps |= {(o.get("col") or "").strip()
                     for o in (w.get("order_by") or [])
                     if (o.get("col") or "").strip()}
        return deps

    if typ == "perioddelta":
        out = (cfg.get("out") or "period_change").strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        if out in want_l:
            deps.add((cfg.get("value") or "").strip())
            deps.add((cfg.get("order") or "").strip())
            deps |= {c for c in (cfg.get("partition") or []) if c}
        return {c for c in deps if c}

    if typ == "renamecols":
        if any((cfg.get("prefix"), cfg.get("suffix"), cfg.get("case"),
                cfg.get("find"), cfg.get("replace"))):
            return None
        rev = {str(m.get("to")).lower(): str(m.get("from"))
               for m in (cfg.get("mappings") or [])
               if m.get("from") and m.get("to")}
        return {rev.get(str(n).lower(), n) for n in want}

    if typ in ("join", "antijoin", "crossjoin"):
        pairs = [(k.get("left"), k.get("right"))
                 for k in (cfg.get("keys") or [])
                 if k.get("left") and k.get("right")]
        if typ == "antijoin" and not pairs:
            pairs = [(cfg.get("left_key"), cfg.get("right_key"))]
            pairs = [(l, r) for l, r in pairs if l and r]
        left_keys = {l for l, _r in pairs}
        right_keys = {r for _l, r in pairs}
        # Output aliases can collide (right fields become r_<name>), so pass
        # both original and de-prefixed candidates to each side. Sources
        # intersect the set with their real schemas.
        candidates = want | {str(n)[2:] for n in want
                             if str(n).lower().startswith("r_")}
        if in_port == "left":
            return left_keys | candidates
        if in_port == "right":
            return right_keys | candidates
        return None

    if typ == "multijoin":
        # Output names are schema-dependent: a colliding field from input in2
        # becomes ``in2_<name>`` and may receive a numeric suffix if that alias
        # also exists. Preserve every plausible original/collision candidate on
        # all inputs so projection cannot change the public output names.
        candidates = {str(n) for n in want}
        changed = True
        ports = list(NODE_PORTS.get("multijoin", {}).get("in") or [])
        while changed:
            changed = False
            for name in list(candidates):
                base_name = re.sub(r"_\d+$", "", name)
                if base_name and base_name not in candidates:
                    candidates.add(base_name)
                    changed = True
                for port in ports:
                    prefix = str(port) + "_"
                    if name.lower().startswith(prefix.lower()):
                        bare = name[len(prefix):]
                        if bare and bare not in candidates:
                            candidates.add(bare)
                            changed = True
        deps = set(candidates)
        base = cfg.get("base") or "in1"
        for step in (cfg.get("joins") or []):
            inp = step.get("input")
            against = step.get("against") or base
            for pair in (step.get("on") or []):
                left = pair.get("left")
                right = pair.get("right")
                if against == in_port and left:
                    deps.add(left)
                if inp == in_port and right:
                    deps.add(right)
        return {c for c in deps if c}

    if typ == "union":
        return want

    if typ == "coalesce":
        out = (cfg.get("name") or "coalesced").strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        if out in want_l:
            deps |= {c for c in (cfg.get("cols") or []) if c}
        return deps

    if typ == "rank":
        out = (cfg.get("out") or "rank").strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        if out in want_l or cfg.get("top_n") not in (None, ""):
            deps.add((cfg.get("order") or "").strip())
            deps |= {c for c in (cfg.get("partition") or []) if c}
        return {c for c in deps if c}

    if typ == "topn":
        deps = set(want)
        deps.add((cfg.get("sort") or "").strip())
        deps |= {c for c in (cfg.get("group") or []) if c}
        return {c for c in deps if c}

    if typ == "bin":
        out = (cfg.get("out") or "bucket").strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        col = (cfg.get("col") or "").strip()
        if col:
            deps.add(col)  # current SQL always builds the CASE expression
        return deps

    if typ == "fill":
        return want

    if typ == "split":
        generated = {str(n).strip().lower() for n in (cfg.get("names") or [])
                     if str(n).strip()}
        deps = {n for n in want if str(n).lower() not in generated}
        col = (cfg.get("col") or "").strip()
        if col:
            deps.add(col)  # split SQL always constructs all configured pieces
        return deps

    if typ == "jsonextract":
        generated = {str(e.get("name") or "").strip().lower()
                     for e in (cfg.get("extracts") or [])
                     if (e.get("name") or "").strip()}
        deps = {n for n in want if str(n).lower() not in generated}
        col = (cfg.get("col") or "").strip()
        if col:
            deps.add(col)
        return deps

    if typ == "explode":
        name = (cfg.get("name") or cfg.get("col") or "").strip().lower()
        deps = {n for n in want if str(n).lower() != name}
        col = (cfg.get("col") or "").strip()
        if col:
            base = re.split(r"[\[.\s]", col, 1)[0] or col
            deps.add(base)
        return deps

    if typ in ("textclean", "parse"):
        return want

    if typ == "date":
        col = (cfg.get("col") or "").strip()
        op = (cfg.get("op") or "part").strip().lower()
        if op == "part":
            default_name = col + "_" + (cfg.get("part") or "year").strip().lower()
        elif op == "trunc":
            default_name = col + "_" + (cfg.get("unit") or "month").strip().lower()
        else:
            default_name = col + "_diff"
        out = (cfg.get("name") or default_name).strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        if col:
            deps.add(col)
        other = (cfg.get("other") or "").strip()
        if op == "diff" and other and other.lower() != "now":
            deps.add(other)
        return deps

    if typ == "maprecode":
        col = (cfg.get("col") or "").strip()
        out = (cfg.get("name") or col).strip().lower()
        deps = {n for n in want if str(n).lower() != out}
        if col:
            deps.add(col)
        return deps

    # Unknown nodes remain conservative.
    return None

def needed_columns(graph, targets):
    """Backward column-liveness over the flow DAG. ``targets`` is a list of
    (node_id, port) that will be materialised in full. Returns a dict
    {(node_id, out_port): needed} where needed is a set of column names, or
    None meaning "all columns". Source nodes consult this to read only the
    columns used downstream. Any unrecognised shape falls back to None."""
    nodes = _node_map(graph)
    targetset = {(n, p) for (n, p) in targets}
    out_consumers = {}  # (src_node, src_port) -> [(dst_node, dst_in_port)]
    for e in (graph.get("edges") or []):
        f = e.get("from") or {}
        t = e.get("to") or {}
        if f.get("node") is not None and t.get("node") is not None:
            out_consumers.setdefault(
                (f.get("node"), f.get("port")), []).append(
                    (t.get("node"), t.get("port")))

    out_memo = {}
    in_memo = {}

    def needed_out(node, port, stack):
        key = (node, port)
        if key in out_memo:
            return out_memo[key]
        if key in targetset:
            out_memo[key] = None  # the target is materialised in full
            return None
        if key in stack:  # a cycle: be safe
            return None
        cons = out_consumers.get(key)
        if not cons:
            # produced but read by nothing here -> contributes no needs (an
            # unused port, e.g. a filter's unwired false branch). NOT "all".
            out_memo[key] = set()
            return set()
        acc = set()
        for (cn, cin) in cons:
            ni = needed_in(cn, cin, stack | {key})
            if ni is None:
                out_memo[key] = None
                return None
            acc |= ni
        out_memo[key] = acc
        return acc

    def needed_in(node_id, in_port, stack):
        key = (node_id, in_port)
        if key in in_memo:
            return in_memo[key]
        node = nodes.get(node_id)
        if node is None:
            in_memo[key] = None
            return None
        declared = list(NODE_PORTS.get(node.get("type"), {}).get("out", ["out"]) or [])
        # Some long-lived compatibility ports (notably join ``out``) are
        # accepted by execution even though the palette exposes newer named
        # ports. A requested target port is authoritative and must participate
        # in liveness, otherwise a full target can be mistaken for an unused
        # branch and its inputs pruned down to keys only.
        requested = [p for n, p in targetset if n == node_id]
        connected = [p for n, p in out_consumers if n == node_id]
        outs = list(dict.fromkeys(declared + connected + requested)) or ["out"]
        combined = set()
        for p in outs:
            n_out = needed_out(node_id, p, stack)
            if n_out is None:
                combined = None
                break
            combined |= n_out
        res = _node_needed_inputs(node, in_port, combined)
        res = None if res is None else set(res)
        in_memo[key] = res
        return res

    result = {}
    for node in (graph.get("nodes") or []):
        nid = node.get("id")
        if nid is None:
            continue
        declared = list(NODE_PORTS.get(node.get("type"), {}).get("out", ["out"]) or [])
        requested = [p for n, p in targetset if n == nid]
        connected = [p for n, p in out_consumers if n == nid]
        for p in (list(dict.fromkeys(declared + connected + requested)) or ["out"]):
            result[(nid, p)] = needed_out(nid, p, frozenset())
    return result


# ---- adaptive incremental execution checkpoints ---------------------------
# The first implementation cached only blocking multi-input nodes.  That was a
# good safety baseline, but a long linear flow still reran from the source after
# a downstream edit because every upstream transform had been fused away.  The
# planner below keeps fusion between a small number of strategic boundaries:
# expensive operators, shared branches, the node immediately before each
# target, and every Nth node in a long chain.  Unchanged boundaries have stable
# content fingerprints and are therefore reused on the next run.
_INCREMENTAL_EXPENSIVE_TYPES = frozenset({
    "join", "multijoin", "crossjoin", "antijoin", "union", "reconcile",
    "summarize", "pivot", "window", "perioddelta", "sort", "unique",
    "dedupe", "rank", "topn", "groupconcat", "group",
})
_INCREMENTAL_SOURCE_TYPES = frozenset({
    "input", "directory", "appendfolder", "filebrowser", "apinode",
    "sqlserver", "sharepoint", "webscrape",
    "iterator", "shred", "createtable", "variable", "text",
})
_INCREMENTAL_SINK_TYPES = frozenset({
    "output", "samqldash", "write", "dashboard", "while",
})


def _incremental_node_safe(node):
    """Whether a node is suitable for an automatic materialised checkpoint.

    The final target is still materialised by the normal execution path.  This
    predicate only controls *extra* reusable boundaries, so volatile/random or
    side-effecting steps stay fused/serial and keep their established semantics.
    """
    typ = str((node or {}).get("type") or "").lower()
    cfg = (node or {}).get("config") or {}
    if typ in _INCREMENTAL_SOURCE_TYPES or typ in _INCREMENTAL_SINK_TYPES:
        return False
    if typ == "sample" and str(cfg.get("mode") or "head").lower() == "random":
        return False
    if typ == "sql":
        # A SQL node may contain random(), current_timestamp, external table
        # functions, or other runtime-only state that cannot be proven stable.
        return False
    if typ == "python":
        # Arbitrary Python is opaque and may be non-deterministic.
        return False
    if typ == "group":
        return all(_incremental_node_safe(c)
                   for c in (cfg.get("children") or []) if c.get("type"))
    return bool(typ)


def incremental_checkpoint_nodes(graph, targets, stride=3):
    """Choose reusable NodeFlow boundaries for ``targets``.

    Returns a set of node ids.  The plan is deterministic, target-scoped, and
    deliberately sparse so a cold run still benefits from SQL fusion.  A warm
    run after editing a downstream node can reuse the nearest unchanged
    checkpoint instead of rescanning and recomputing the whole branch.
    """
    nodes = _node_map(graph)
    targets = [(n, p) for n, p in targets if n in nodes]
    if not targets:
        return set()
    try:
        stride = max(2, min(int(stride or 3), 12))
    except Exception:
        stride = 3

    back = {}
    output_consumers = {}
    for edge in (graph.get("edges") or []):
        src = (edge.get("from") or {}).get("node")
        sport = (edge.get("from") or {}).get("port") or "out"
        dst = (edge.get("to") or {}).get("node")
        if src not in nodes or dst not in nodes:
            continue
        back.setdefault(dst, set()).add(src)
        output_consumers[(src, sport)] = output_consumers.get((src, sport), 0) + 1

    # Restrict every rule to nodes that actually feed one of this run's targets.
    ancestors = set()
    stack = [n for n, _p in targets]
    while stack:
        nid = stack.pop()
        if nid in ancestors:
            continue
        ancestors.add(nid)
        stack.extend(back.get(nid, ()))

    checkpoints = set()
    target_ids = {n for n, _p in targets}

    # Existing heavy-operation policy, expanded to the analytic operators that
    # are most expensive to recompute after a small downstream edit.
    for nid in ancestors:
        node = nodes.get(nid) or {}
        if (node.get("type") in _INCREMENTAL_EXPENSIVE_TYPES
                and _incremental_node_safe(node)):
            checkpoints.add(nid)

    # Shared subgraphs are already materialised within one batch.  Make those
    # boundaries content-addressed across batches as well.
    for (nid, _port), count in output_consumers.items():
        if count > 1 and nid in ancestors and _incremental_node_safe(nodes[nid]):
            checkpoints.add(nid)

    # The direct predecessor is the highest-value boundary for the common
    # workflow: edit the terminal select/chart/output and rerun immediately.
    for tid in target_ids:
        for parent in back.get(tid, ()):
            if _incremental_node_safe(nodes[parent]):
                checkpoints.add(parent)

    # Long single chains receive sparse boundaries.  Distance is measured from
    # the nearest target; this remains deterministic when branches merge.
    distance = {tid: 0 for tid in target_ids}
    queue = deque(target_ids)
    while queue:
        cur = queue.popleft()
        d = distance[cur]
        for parent in back.get(cur, ()):
            nd = d + 1
            if parent not in distance or nd < distance[parent]:
                distance[parent] = nd
                queue.append(parent)
    for nid, dist in distance.items():
        if (dist > 0 and dist % stride == 0 and nid in ancestors
                and _incremental_node_safe(nodes[nid])):
            checkpoints.add(nid)

    # Targets are built anyway; adding them to the no-fuse boundary set is
    # redundant.  Sources/sinks are excluded by the safety predicate.
    checkpoints.difference_update(target_ids)
    return checkpoints

def flow_fingerprints(graph, needed_map=None, epoch=0, engine="sqlite",
                      digest_chars=16):
    """Content fingerprints for the incremental flow cache.

    ``fp(node)`` hashes the node's type + config + the set of columns its
    output must carry (the projection from ``needed_columns``) + the
    fingerprints of its inputs, under a global ``(epoch, engine)`` salt.

    Properties this gives us:
      * two nodes whose definition AND projection are identical get the same
        fingerprint -- so they can share one materialised table;
      * editing a node changes its fingerprint and the fingerprint of every
        node downstream of it (which embed it), but nothing upstream;
      * bumping ``epoch`` (any data mutation) changes every fingerprint;
      * a node that must produce more/fewer columns (because a different
        target consumes it) gets a different fingerprint, so a cached table is
        never reused when it would be missing a needed column.

    Cyclic or unresolvable nodes are omitted (those simply won't be cached).
    ``digest_chars`` defaults to the compact 64-bit in-session key. Restart-
    persistent caches request a longer digest because a collision there can
    outlive the process that created it. Returns ``{node_id: hex}``.
    """
    import hashlib
    import json as _json
    needed_map = needed_map or {}
    nodes = {n.get("id"): n for n in (graph.get("nodes") or []) if n.get("id")}
    inedges = {}
    for e in (graph.get("edges") or []):
        t = e.get("to") or {}
        f = e.get("from") or {}
        if t.get("node") is None or f.get("node") is None:
            continue
        inedges.setdefault(t.get("node"), []).append(
            (t.get("port") or "", f.get("node"), f.get("port") or "out"))

    def need_rep(nid):
        # the projection this node's output must carry; None anywhere == all
        outs = [v for (k, v) in needed_map.items() if k[0] == nid]
        if not outs or any(v is None for v in outs):
            return "*"
        s = set()
        for v in outs:
            s |= v
        return sorted(s)

    memo = {}
    visiting = set()
    cyclic = set()

    def subtree(nid):
        if nid in memo:
            return memo[nid]
        if nid in visiting:
            cyclic.add(nid)
            return "<cycle>"
        node = nodes.get(nid)
        if node is None:
            return "<missing>"
        visiting.add(nid)
        ins = sorted(inedges.get(nid, []),
                     key=lambda x: (x[0], str(x[1]), x[2]))
        kids = [tp + ">" + subtree(src) + "@" + sp for (tp, src, sp) in ins]
        rep = _json.dumps(
            {"t": node.get("type"), "c": node.get("config") or {},
             "n": need_rep(nid), "in": kids},
            sort_keys=True, separators=(",", ":"), default=str)
        visiting.discard(nid)
        memo[nid] = rep
        return rep

    try:
        digest_chars = max(16, min(int(digest_chars), 40))
    except Exception:
        digest_chars = 16
    prefix = "v1|%s|%s|" % (epoch, engine)
    out = {}
    for nid in nodes:
        try:
            rep = subtree(nid)
        except Exception:
            continue
        if nid in cyclic or "<cycle>" in rep or "<missing>" in rep:
            continue
        out[nid] = hashlib.sha1(
            (prefix + rep).encode("utf-8")).hexdigest()[:digest_chars]
    return out
