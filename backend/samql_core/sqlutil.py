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
_SQL_WRITE_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|"
    r"GRANT|REVOKE|EXEC|EXECUTE|sp_executesql|BACKUP|RESTORE|"
    r"BULK)\b", re.IGNORECASE)


@lru_cache(maxsize=4096)
def quote_ident(ident):
    return '"' + str(ident).replace('"', '""') + '"'


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


def classify_sql_statement(sql):
    """'read' / 'write' / 'empty' for read-only enforcement. String
    literals and comments are stripped first."""
    body = _strip_sql_literals(sql or "").strip()
    if not body:
        return "empty"
    if _SQL_WRITE_RE.search(body):
        return "write"
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
