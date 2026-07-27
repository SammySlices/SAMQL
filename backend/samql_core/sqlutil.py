"""SQL text utilities: identifier quoting, statement/batch splitting
(string- and comment-aware, SSMS GO semantics), read/write
classification for read-only enforcement, a sort-pushdown wrapper, and
optional sqlglot formatting/transpiling.

Lifted directly from the original single-file application. GUI-free.
"""
import re
from functools import lru_cache

import importlib.util as _ilu

HAS_SQLGLOT = _ilu.find_spec("sqlglot") is not None

_GO_LINE_RE = re.compile(r"^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$", re.IGNORECASE)
# Statements classified by their LEADING keyword. Anchoring on the first
# keyword (rather than searching the whole body) is what makes ``SELECT * FROM
# merge`` a read while ``COPY ... TO`` is a write -- the old anywhere-search both
# missed side-effect leaders (COPY/ATTACH/SET let a "read-only" connection write
# files and mutate engine state) and false-flagged ordinary identifiers named
# merge/bulk/exec/grant.
_WRITE_LEADERS = frozenset((
    "insert", "update", "delete", "merge", "upsert", "truncate", "drop",
    "alter", "create", "replace", "grant", "revoke", "exec", "execute",
    "sp_executesql", "call", "copy", "attach", "detach", "install", "load",
    "set", "reset", "pragma", "checkpoint", "vacuum", "export", "import",
    "use", "backup", "restore", "bulk", "comment", "analyze",
))
# DML that can legitimately follow a leading WITH (CTE) and still write. CREATE/
# DROP/ALTER can't -- they lead the statement themselves -- so they're excluded
# to avoid flagging a CTE literally named "create".
_WITH_WRITE_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT)\b", re.IGNORECASE)
_LEAD_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


@lru_cache(maxsize=4096)
def quote_ident(ident):
    return '"' + str(ident).replace('"', '""') + '"'


def sanitize_column_header(name):
    """Normalize a loaded field header: trim edges, turn each whitespace run
    into a single ``_``.

    Applied on the load path when columns become table schema (DuckDB native
    CSV/JSON/Parquet reads; also via ``_dedupe_columns`` for streaming
    inserts). Does **not** strip punctuation — only whitespace — so headers
    like ``a"b`` stay intact. Multiple spaces / tabs collapse to one ``_``
    (``\"Order  Date\"`` → ``Order_Date``) without turning an already-clean
    ``a__b`` into ``a_b``. Empty / all-whitespace names become ``\"\"`` so
    callers can substitute ``col_N``.
    """
    s = "" if name is None else str(name)
    s = s.strip()
    if not s:
        return ""
    return re.sub(r"\s+", "_", s)


# Backwards-compatible private alias used elsewhere in the codebase.
_q = quote_ident


def wrap_sorted_sql(sql, col, descending):
    """Wrap an arbitrary SELECT so the engine sorts it (enables
    streamed, SQL-side sorted browsing instead of a full client-side
    drain+sort)."""
    inner = sql.strip().rstrip(";")
    direction = "DESC" if descending else "ASC"
    return (f"SELECT * FROM (\n{inner}\n) AS _samql_sort "
            f"ORDER BY {quote_ident(col)} {direction}")


def split_sql_batches(text):
    """Split a T-SQL script on GO batch separators (line-anchored, SSMS
    semantics, supporting 'GO n' repeat counts)."""
    batches = []
    cur = []
    in_str = None
    for line in (text or "").split("\n"):
        if in_str is None:
            m = _GO_LINE_RE.match(line)
            if m:
                batch = "\n".join(cur).strip()
                if batch:
                    n = int(m.group(1) or 1)
                    batches.extend([batch] * max(1, n))
                cur = []
                continue
        i = 0
        while i < len(line):
            ch = line[i]
            if in_str:
                if ch == in_str:
                    if i + 1 < len(line) and line[i + 1] == in_str:
                        i += 1
                    else:
                        in_str = None
            elif ch in ("'", '"'):
                in_str = ch
            elif ch == "-" and line[i:i + 2] == "--":
                break
            i += 1
        cur.append(line)
    tail = "\n".join(cur).strip()
    if tail:
        batches.append(tail)
    return batches


def _strip_sql_literals(sql):
    out = []
    i = 0
    n = len(sql)
    in_str = None
    while i < n:
        ch = sql[i]
        if in_str:
            if ch == in_str:
                if i + 1 < n and sql[i + 1] == in_str:
                    i += 2
                    continue
                in_str = None
            i += 1
            continue
        if ch in ("'", '"'):
            in_str = ch
            i += 1
            continue
        if ch == "-" and sql[i:i + 2] == "--":
            j = sql.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and sql[i:i + 2] == "/*":
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _blank_strings_and_comments(sql):
    """Blank out ``'...'`` literals and comments, PRESERVING ``[..]`` and
    ``".."`` identifiers, replacing each removed character with a space so
    offsets into the original text still line up.

    :func:`_strip_sql_literals` cannot be reused here: it treats ``"..."`` as a
    string, which is wrong for T-SQL (with QUOTED_IDENTIFIER ON, the default,
    ``FROM "Order Items"`` names a table). Blanking rather than deleting keeps
    a stripped span from gluing two tokens together.
    """
    out = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":                      # string literal ('' escapes a quote)
            out.append(" ")
            i += 1
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        out.append("  ")
                        i += 2
                        continue
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if sql[i] == "\n" else " ")
                i += 1
            continue
        if ch == "-" and sql[i:i + 2] == "--":
            j = sql.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
            continue
        if ch == "/" and sql[i:i + 2] == "/*":
            j = sql.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join("\n" if c == "\n" else " " for c in sql[i:j]))
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# A single part of a qualified name: [bracketed], "quoted", or a bare word.
# @ and # lead table variables / temp tables, which are matched so they can be
# recognised and skipped (neither has an INFORMATION_SCHEMA row).
_IDENT_PART_RE = re.compile(r'[A-Za-z_@#][A-Za-z0-9_$@#]*')
# FROM / JOIN both introduce a table reference. The join flavour (INNER, LEFT
# OUTER, CROSS, ...) always precedes the word JOIN, so matching JOIN alone
# covers every kind. APPLY is deliberately absent: CROSS/OUTER APPLY takes a
# table-valued function or derived table, neither of which has columns in
# INFORMATION_SCHEMA.
_FROM_JOIN_RE = re.compile(r'\b(?:FROM|JOIN)\b', re.IGNORECASE)
# WITH <name> [(cols)] AS ( ... ) -- also the ", <name> AS (" continuation of a
# multi-CTE list. Requiring the trailing "AS (" keeps this from firing on
# ordinary aliases.
_CTE_RE = re.compile(
    r'(?:\bWITH\b|,)\s*'
    r'(\[[^\]]*\]|"[^"]*"|[A-Za-z_][A-Za-z0-9_$@#]*)\s*'
    r'(?:\([^()]*\)\s*)?\bAS\b\s*\(',
    re.IGNORECASE)


def _read_ident_part(text, i):
    """Read one identifier part at ``i``; return ``(name, next_i)`` or None.

    An empty part is legal and returned as ``""`` -- T-SQL's ``db..table``
    elides the schema.
    """
    n = len(text)
    if i >= n:
        return None
    ch = text[i]
    if ch in "[\"":
        close = "]" if ch == "[" else '"'
        buf, j = [], i + 1
        while j < n:
            if text[j] == close:
                if j + 1 < n and text[j + 1] == close:   # ]] / "" escape
                    buf.append(close)
                    j += 2
                    continue
                return "".join(buf), j + 1
            buf.append(text[j])
            j += 1
        return None                                       # unterminated
    if ch == ".":
        return "", i                                      # db..table
    m = _IDENT_PART_RE.match(text, i)
    if not m:
        return None
    return m.group(0), m.end()


def _read_qualified_name(text, i):
    """Read a dotted name (``a``, ``a.b``, ``[x].[y].[z]``) at ``i``.

    Returns ``(parts, next_i)`` or None. Whitespace is skipped before the name
    but NOT around the dots -- ``FROM t ORDER BY x`` must stop at ``t``.
    """
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    parts = []
    while True:
        got = _read_ident_part(text, i)
        if got is None:
            return None
        name, i = got
        parts.append(name)
        if i < n and text[i] == ".":
            i += 1
            continue
        break
    if not any(parts):
        return None
    return parts, i


def _skip_ws(text, i):
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    return i


def _skip_balanced_parens(text, i):
    """Skip the parenthesised group at ``i``; returns the index just past it."""
    n, depth = len(text), 0
    while i < n:
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _skip_alias_and_hints(text, i):
    """Skip what may follow a table name before the FROM list continues:
    ``AS``, the alias itself, and a ``WITH (NOLOCK)``-style table hint."""
    n = len(text)
    while True:
        j = _skip_ws(text, i)
        if j >= n:
            return j
        if text[j] == "(":                       # table hint / function args
            i = _skip_balanced_parens(text, j)
            continue
        got = _read_ident_part(text, j)
        if got is None or not got[0]:
            return j
        word, after = got
        if word.lower() in ("as", "with"):       # keep looking for the alias
            i = after
            continue
        j2 = _skip_ws(text, after)               # the alias itself
        if j2 < n and text[j2] == "(":
            return _skip_balanced_parens(text, j2)
        return after


def sql_source_tables(sql):
    """``(catalog, schema, table)`` for every table named in a FROM / JOIN
    clause, in order of appearance.

    Powers the SQL Server node's "Get columns", which declares the columns of
    the underlying TABLES rather than of the query's projection -- an explicit
    ``SELECT o.id`` still yields every column of ``Orders`` and of each joined
    table, so downstream nodes can be built on the full set.

    Occurrences are preserved rather than de-duplicated: a self-join names the
    table twice and so contributes its columns twice, exactly as ``SELECT *``
    over the same FROM clause would.

    Skipped, because none has an INFORMATION_SCHEMA row: derived tables and
    subqueries (``FROM (SELECT ...) x``), CTE names declared in the same
    statement, table-valued functions (a name followed by ``(``), table
    variables (``@t``) and temp tables (``#t``).
    """
    body = _blank_strings_and_comments(sql or "")
    ctes = set()
    for m in _CTE_RE.finditer(body):
        raw = m.group(1)
        if raw[:1] in "[\"":
            raw = raw[1:-1]
        ctes.add(raw.lower())
    refs = []
    for m in _FROM_JOIN_RE.finditer(body):
        # Only FROM takes a comma-separated list (the ANSI-89 "FROM A a, B b"
        # join). JOIN takes exactly one table, and scanning past it would walk
        # into the ON predicate.
        comma_list = body[m.start():m.end()].lower() == "from"
        i = m.end()
        while True:
            got = _read_qualified_name(body, i)
            if got is None:            # derived table / subquery / garbage
                break
            parts, i = got
            # A name followed by '(' is a table-valued function, not a table.
            if body[_skip_ws(body, i):_skip_ws(body, i) + 1] != "(":
                table = parts[-1]
                if (table and table[0] not in "@#"     # not @var / #temp
                        and not (len(parts) == 1 and table.lower() in ctes)):
                    refs.append((parts[-3] if len(parts) > 2 else "",
                                 parts[-2] if len(parts) > 1 else "",
                                 table))
            if not comma_list:
                break
            i = _skip_alias_and_hints(body, i)
            j = _skip_ws(body, i)
            if j >= len(body) or body[j] != ",":
                break
            i = j + 1
    return refs


def classify_sql_statement(sql):
    """'read' / 'write' / 'empty' for read-only enforcement.

    Classifies on the statement's LEADING keyword after stripping string
    literals and comments. A leading write/side-effect keyword (INSERT, COPY,
    ATTACH, SET, PRAGMA, ...) is a write; everything else -- SELECT, VALUES,
    DuckDB FROM-first, DESCRIBE/SHOW/EXPLAIN, a parenthesised SELECT -- is a
    read. A leading WITH is a CTE: it's a write only when a top-level DML
    keyword follows, and a read otherwise (the common ``WITH ... SELECT``).

    Uncertain cases resolve toward 'write' so the read-only guard fails closed.
    """
    body = _strip_sql_literals(sql or "").strip()
    if not body:
        return "empty"
    # Skip a leading '(' so a parenthesised SELECT / VALUES reads as a read.
    m = _LEAD_WORD_RE.search(body)
    if not m:
        return "read"
    lead = m.group(0).lower()
    if lead in _WRITE_LEADERS:
        return "write"
    if lead == "with":
        return "write" if _WITH_WRITE_RE.search(body) else "read"
    return "read"


def split_sql_statements_spans(text):
    """Split SQL into statements on semicolons and GO batch lines
    (string- and comment-aware), returning (start, end, stmt) spans with
    offsets into the original text. Powers run-statement-at-cursor."""
    spans = []
    t = text or ""
    n = len(t)
    i = 0
    seg_start = 0
    in_str = None
    line_start = True

    def emit(a, b):
        chunk = t[a:b]
        if chunk.strip():
            spans.append((a, b, chunk))

    while i < n:
        ch = t[i]
        if in_str:
            if ch == in_str:
                if i + 1 < n and t[i + 1] == in_str:
                    i += 2
                    continue
                in_str = None
            i += 1
            line_start = False
            continue
        if line_start:
            j = t.find("\n", i)
            line = t[i:(n if j < 0 else j)]
            if _GO_LINE_RE.match(line):
                emit(seg_start, i)
                i = n if j < 0 else j + 1
                seg_start = i
                line_start = True
                continue
        if ch == "'" or ch == '"':
            in_str = ch
            i += 1
            line_start = False
            continue
        if ch == "$":
            # .447 [PLAN PASS 4] fix: dollar-quoted bodies ($$...$$ or
            # $tag$...$tag$, DuckDB macros) were split on their inner
            # semicolons -- CREATE MACRO broke when run statement-by-
            # statement. Skip to the matching closer.
            m = re.match(r"\$[A-Za-z_]*\$", t[i:])
            if m:
                tag = m.group(0)
                j = t.find(tag, i + len(tag))
                i = n if j < 0 else j + len(tag)
                line_start = False
                continue
        if ch == "-" and t[i:i + 2] == "--":
            j = t.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and t[i:i + 2] == "/*":
            # .447: block comments NEST in DuckDB -- a ; inside the
            # outer of /* a /* b */ ; */ used to split the statement.
            depth, i = 1, i + 2
            while i < n and depth:
                if t[i:i + 2] == "/*":
                    depth += 1
                    i += 2
                elif t[i:i + 2] == "*/":
                    depth -= 1
                    i += 2
                else:
                    i += 1
            line_start = False
            continue
        if ch == ";":
            emit(seg_start, i + 1)
            seg_start = i + 1
            i += 1
            line_start = False
            continue
        line_start = (ch == "\n")
        i += 1
    emit(seg_start, n)
    return spans


def find_statement_at(spans, pos):
    """Pick the span containing pos; a cursor in the GAP after a
    semicolon belongs to the statement just finished (the PRECEDING
    span), not the next or the last one -- so clicking below your first
    query and hitting Statement runs THAT query. Before the first
    statement, pick the first."""
    prev = None
    for s, e, st in spans:
        if s <= pos <= e:
            return (s, e, st)
        if e <= pos:
            prev = (s, e, st)
    if prev is not None:
        return prev
    return spans[0] if spans else None


def split_statements(sql):
    """Split SQL into executable statements on semicolons (string- and
    comment-aware). Mirrors DBManager._split_statements."""
    out, cur, in_str = [], [], None
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if in_str:
            cur.append(ch)
            if ch == in_str:
                if i + 1 < n and sql[i + 1] == in_str:
                    cur.append(sql[i + 1])
                    i += 2
                    continue
                in_str = None
            i += 1
            continue
        if ch in ("'", '"'):
            in_str = ch
            cur.append(ch)
        elif ch == "-" and i + 1 < n and sql[i + 1] == "-":
            cur.append(ch)
            i += 1
            while i < n and sql[i] != "\n":
                cur.append(sql[i])
                i += 1
            continue
        elif ch == "/" and i + 1 < n and sql[i + 1] == "*":
            # block comment: copy it verbatim (so a ';' inside it can't split
            # the statement) up to and including the closing '*/'.
            cur.append(ch)
            cur.append(sql[i + 1])
            i += 2
            while i < n and not (sql[i] == "*" and i + 1 < n
                                 and sql[i + 1] == "/"):
                cur.append(sql[i])
                i += 1
            if i + 1 < n:
                cur.append(sql[i])
                cur.append(sql[i + 1])
                i += 2
            else:
                i = n
            continue
        elif ch == ";":
            stmt = "".join(cur).strip()
            if stmt:
                out.append(stmt)
            cur = []
        else:
            cur.append(ch)
        i += 1
    last = "".join(cur).strip()
    if last:
        out.append(last)
    return out


def sqlglot_transform(text, read=None, write=None, pretty=True):
    """Format or transpile SQL via sqlglot when installed. Returns
    (ok, result_or_error)."""
    if not HAS_SQLGLOT:
        return False, ("sqlglot is not installed. "
                       "Install with:  pip install sqlglot")
    try:
        import sqlglot
        out = sqlglot.transpile(text, read=read, write=write, pretty=pretty)
        return True, ";\n\n".join(out)
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


# SQL keywords for the editor's syntax highlighting / autocomplete.
SQL_KEYWORDS = sorted(set((
    "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER ON USING "
    "GROUP BY HAVING ORDER LIMIT OFFSET AS AND OR NOT NULL IS "
    "IN BETWEEN LIKE GLOB ESCAPE INSERT UPDATE DELETE REPLACE "
    "INTO VALUES SET CREATE DROP ALTER TABLE INDEX VIEW TRIGGER "
    "IF EXISTS TEMP TEMPORARY DEFAULT PRIMARY KEY FOREIGN "
    "REFERENCES UNIQUE CHECK CONSTRAINT AUTOINCREMENT "
    "CASE WHEN THEN ELSE END DISTINCT UNION ALL EXCEPT INTERSECT "
    "WITH RECURSIVE EXISTS CAST COLLATE PRAGMA BEGIN COMMIT "
    "ROLLBACK TRANSACTION SAVEPOINT RELEASE EXPLAIN VACUUM ANALYZE "
    "COUNT SUM AVG MIN MAX TOTAL GROUP_CONCAT "
    "COALESCE NULLIF IFNULL ABS ROUND TRIM SUBSTR LENGTH UPPER "
    "LOWER STRFTIME DATE TIME DATETIME JULIANDAY ROW_NUMBER "
    "RANK DENSE_RANK NTILE LAG LEAD OVER PARTITION "
    "ASC DESC TRUE FALSE"
).split()))


def sql_path(p):
    """A filesystem path as a DuckDB SQL string literal body: forward
    slashes (Windows-safe) with single quotes doubled. One
    implementation (.413) for what a dozen call sites hand-rolled."""
    return str(p).replace("\\", "/").replace("'", "''")


# ISO date / datetime shapes typed into filters (Pivot, NodeFlow Filter,
# {{var}} substitution). Kept engine-agnostic (plain string literals) so
# SQLite text dates and DuckDB DATE columns both accept them.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_DT_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}"
    r"(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$")


def is_iso_temporal(s):
    """True when ``s`` is an ISO date or datetime filter string."""
    if not s:
        return False
    return bool(_ISO_DATE_RE.match(s) or _ISO_DT_RE.match(s))


def unwrap_sql_quoted_temporal(value):
    """Normalize a filter/literal value before SQL quoting.

    Strips one layer of matching quotes when the interior is an ISO
    date/datetime -- users often paste ``'2026-01-26'`` from SQL, and a
    naive ``'...'`` wrap would emit ``'''2026-01-26'''`` (DuckDB then
    fails DATE cast with ``invalid date field format: "'2026-01-26'"``).

    Non-temporal values pass through byte-for-byte: edge whitespace is
    significant in literals (create-table cells, split/textclean
    delimiters, replace targets) and must survive quoting.

    Returns ``None`` when ``value`` is ``None``; otherwise a str.
    """
    if value is None:
        return None
    s = str(value)
    t = s.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "'\"":
        inner = t[1:-1].strip()
        if is_iso_temporal(inner):
            return inner
    return s


def sql_str_literal(value):
    """Render a value as a single-quoted SQL string literal.

    ISO dates that arrive already SQL-quoted (``'2026-01-26'``) are
    unwrapped first so they are not double-quoted into
    ``'''2026-01-26'''``. Embedded quotes are escaped as ``''``.
    ``None`` becomes the literal text ``None`` (callers that need SQL
    NULL must handle that themselves).
    """
    if value is None:
        s = "None"
    else:
        s = unwrap_sql_quoted_temporal(value)
    return "'" + str(s).replace("'", "''") + "'"
