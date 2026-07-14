"""Execute user Python inside a NodeFlow ``python`` node.

The script runs inside SamQL's own Python process (bundled in packaged
builds), so recipients do not need a separate Python install. An optional
upstream table is exposed as ``columns`` / ``rows`` / ``df``; the script
must assign ``out`` to emit the result table.

Accepted ``out`` shapes:
  * list of row dicts: ``[{"a": 1}, {"a": 2}]``
  * ``{"columns": [...], "rows": [[...], ...]}``
  * pandas ``DataFrame`` when pandas is importable in this build
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any

# Soft cap so a Python node cannot silently pull multi-GB relations into RAM.
_MAX_INPUT_ROWS = 500_000

_ALLOWED_MODULES = frozenset({
    "math", "datetime", "json", "re", "collections", "itertools",
    "statistics", "decimal", "fractions", "functools", "operator",
    "string", "textwrap", "copy", "hashlib", "base64", "uuid",
    "calendar", "heapq", "bisect", "random", "csv", "io",
})

_SAFE_BUILTIN_NAMES = (
    "abs", "all", "any", "bool", "dict", "enumerate", "float", "format",
    "frozenset", "getattr", "hasattr", "int", "isinstance", "issubclass",
    "iter", "len", "list", "map", "max", "min", "next", "object", "pow",
    "print", "range", "repr", "reversed", "round", "set", "slice", "sorted",
    "str", "sum", "tuple", "type", "zip", "Exception", "ValueError",
    "TypeError", "KeyError", "IndexError", "RuntimeError", "StopIteration",
    "True", "False", "None",
)


class PythonNodeError(Exception):
    """User-facing failure from a Python node."""


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = str(name).split(".", 1)[0]
    if root in _ALLOWED_MODULES:
        return __import__(name, globals, locals, fromlist, level)
    if root == "pandas":
        try:
            return __import__(name, globals, locals, fromlist, level)
        except ImportError as exc:
            raise ImportError(
                "pandas is not available in this SamQL build."
            ) from exc
    raise ImportError(
        "Import of %r is not allowed in Python nodes. "
        "Allowed: %s (and pandas when bundled)."
        % (name, ", ".join(sorted(_ALLOWED_MODULES)))
    )


def _restricted_builtins():
    bi: dict[str, Any] = {}
    import builtins as _b
    for name in _SAFE_BUILTIN_NAMES:
        if hasattr(_b, name):
            bi[name] = getattr(_b, name)
    bi["__import__"] = _safe_import
    bi["__build_class__"] = _b.__build_class__
    return bi


def _sanitize_ident(name: str, fallback: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_]", "_", str(name or "").strip()) or fallback
    if s[0].isdigit():
        s = "c_" + s
    return s


def _fetch_input(eng, in_rel: str | None):
    """Return ``(columns, rows)`` or ``(None, None)`` when unwired."""
    if not in_rel:
        return None, None
    sql = "SELECT * FROM %s" % in_rel
    cols, rows = eng.execute(sql)
    if cols is None:
        return [], []
    cols = [str(c) for c in cols]
    rows = list(rows or [])
    if len(rows) > _MAX_INPUT_ROWS:
        raise PythonNodeError(
            "Python node input has %d rows (limit %d). "
            "Filter or sample upstream first."
            % (len(rows), _MAX_INPUT_ROWS)
        )
    return cols, rows


def _rows_as_dicts(columns, rows):
    if columns is None:
        return None
    return [dict(zip(columns, row)) for row in rows]


def _normalize_out(out) -> tuple[list[str], list[tuple]]:
    """Coerce ``out`` into ``(columns, row-tuples)``."""
    if out is None:
        raise PythonNodeError(
            "Assign a table to `out` before the script ends "
            "(list of dicts, {columns, rows}, or a pandas DataFrame)."
        )

    # pandas DataFrame
    try:
        import pandas as pd  # type: ignore
        if isinstance(out, pd.DataFrame):
            cols = [str(c) for c in out.columns.tolist()]
            body = [tuple(r) for r in out.itertuples(index=False, name=None)]
            return cols, body
    except Exception:
        pass

    if isinstance(out, dict) and "columns" in out and "rows" in out:
        cols = [str(c) for c in (out.get("columns") or [])]
        if not cols:
            raise PythonNodeError("`out['columns']` must be a non-empty list.")
        body = []
        for r in out.get("rows") or []:
            vals = list(r) if not isinstance(r, (str, bytes)) else [r]
            if len(vals) < len(cols):
                vals = vals + [None] * (len(cols) - len(vals))
            body.append(tuple(vals[: len(cols)]))
        return cols, body

    if isinstance(out, list):
        if not out:
            return ["_empty"], []
        if all(isinstance(r, dict) for r in out):
            cols: list[str] = []
            seen = set()
            for r in out:
                for k in r.keys():
                    key = str(k)
                    if key not in seen:
                        seen.add(key)
                        cols.append(key)
            if not cols:
                return ["_empty"], []
            body = [tuple(r.get(c) for c in cols) for r in out]
            return cols, body
        raise PythonNodeError(
            "`out` as a list must be a list of row dicts, "
            "or use {\"columns\": [...], \"rows\": [...]}."
        )

    raise PythonNodeError(
        "Unsupported `out` type %s. Use a list of dicts, "
        "{\"columns\", \"rows\"}, or a pandas DataFrame."
        % type(out).__name__
    )


def _quote_ident(name: str) -> str:
    return '"%s"' % str(name).replace('"', '""')


def _create_temp_table(eng, table_name: str, columns: list[str], rows: list[tuple]):
    cols = [
        _sanitize_ident(c, "col_%d" % i)
        for i, c in enumerate(columns or [])
    ]
    # De-dupe after sanitize
    seen: dict[str, int] = {}
    final = []
    for c in cols:
        if c in seen:
            seen[c] += 1
            final.append("%s_%d" % (c, seen[c]))
        else:
            seen[c] = 0
            final.append(c)
    cols = final or ["_empty"]

    try:
        eng.execute("DROP TABLE IF EXISTS %s" % _quote_ident(table_name))
    except Exception:
        pass
    try:
        eng.execute("DROP VIEW IF EXISTS %s" % _quote_ident(table_name))
    except Exception:
        pass

    col_sql = ", ".join("%s VARCHAR" % _quote_ident(c) for c in cols)
    eng.execute(
        "CREATE TEMP TABLE %s (%s)" % (_quote_ident(table_name), col_sql)
    )
    if not rows:
        return cols

    placeholders = ", ".join("?" for _ in cols)
    insert = "INSERT INTO %s (%s) VALUES (%s)" % (
        _quote_ident(table_name),
        ", ".join(_quote_ident(c) for c in cols),
        placeholders,
    )
    coerced = []
    for row in rows:
        vals = []
        for v in row:
            if v is None or isinstance(v, (bool, int, float, str)):
                vals.append(v)
            else:
                vals.append(str(v))
        coerced.append(tuple(vals))

    conn = getattr(eng, "conn", None)
    if conn is None or not hasattr(conn, "executemany"):
        raise PythonNodeError("Engine cannot insert Python node rows.")

    def _write():
        conn.executemany(insert, coerced)
        try:
            conn.commit()
        except Exception:
            pass

    lock = getattr(eng, "write_lock", None)
    if lock is not None:
        with lock:
            _write()
    else:
        _write()
    return cols


def run_script(
    code: str,
    *,
    columns=None,
    rows=None,
    timeout_s: float = 30.0,
) -> tuple[list[str], list[tuple]]:
    """Execute ``code`` and return ``(out_columns, out_rows)``."""
    src = (code or "").strip()
    if not src:
        raise PythonNodeError("Write a Python script in the Python node.")

    try:
        timeout_s = float(timeout_s)
    except (TypeError, ValueError):
        timeout_s = 30.0
    timeout_s = max(1.0, min(timeout_s, 300.0))

    df = _rows_as_dicts(columns, rows) if columns is not None else None
    ns: dict[str, Any] = {
        "__builtins__": _restricted_builtins(),
        "columns": list(columns) if columns is not None else None,
        "rows": list(rows) if rows is not None else None,
        "df": df,
        "out": None,
    }

    box: dict[str, Any] = {"exc": None}

    def _target():
        try:
            compiled = compile(src, "<python-node>", "exec")
            exec(compiled, ns, ns)  # noqa: S102 — intentional user script
        except Exception as exc:
            box["exc"] = exc

    th = threading.Thread(target=_target, name="samql-python-node", daemon=True)
    t0 = time.monotonic()
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        raise PythonNodeError(
            "Python node timed out after %.0f s." % timeout_s
        )
    if box["exc"] is not None:
        exc = box["exc"]
        raise PythonNodeError(
            "%s: %s" % (type(exc).__name__, exc)
        ) from exc
    elapsed = time.monotonic() - t0
    if elapsed > timeout_s:
        raise PythonNodeError(
            "Python node timed out after %.0f s." % timeout_s
        )

    return _normalize_out(ns.get("out"))


def run_into_table(
    eng,
    table_name: str,
    *,
    in_rel: str | None,
    code: str,
    timeout_s: float = 30.0,
) -> list[str]:
    """Fetch optional input, run script, write ``CREATE TEMP TABLE`` result."""
    columns, rows = _fetch_input(eng, in_rel)
    out_cols, out_rows = run_script(
        code, columns=columns, rows=rows, timeout_s=timeout_s
    )
    if len(out_rows) > _MAX_INPUT_ROWS:
        raise PythonNodeError(
            "Python node produced %d rows (limit %d)."
            % (len(out_rows), _MAX_INPUT_ROWS)
        )
    return _create_temp_table(eng, table_name, out_cols, out_rows)
