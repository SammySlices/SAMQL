"""Column profiler.

Computes per-column statistics (type, null %, distinct %, min/max,
mean/std, 3-sigma outliers, top values, detected date format),
engine-neutral (works against either the SQLite or DuckDB manager).

Performance: rather than issuing several full-table scans per column
(which is catastrophic on a wide, massive table), the scalar statistics
for *every* column are computed in a single pass over the table, and the
numeric-outlier counts for all numeric columns in one more pass. Only the
per-column "top values" need their own GROUP BY, and on enormous tables
those run against a bounded sample so profiling stays responsive.
"""
import math

from .inference import date_format_label, detect_date_format

# Above this row count, the per-column "top values" are computed from a
# bounded head sample rather than the full table (everything else is still
# exact). Keeps profiling responsive on very large tables.
TOPN_EXACT_MAX_ROWS = 5_000_000
TOPN_SAMPLE_ROWS = 1_000_000


def _q(name):
    return '"' + str(name).replace('"', '""') + '"'


def _stringify(v):
    if v is None:
        return None
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def _infer_type(samples):
    if not samples:
        return "EMPTY"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool)
           for v in samples):
        return "NUMERIC"
    if all(isinstance(v, str) for v in samples):
        return "TEXT"
    return "MIXED"


def profile_table(engine, table, source=None, cancel=None):
    """Profile every column of ``table``. Returns
    {table, total_rows, columns:[stats...]}.

    ``source`` lets the caller profile an arbitrary FROM-expression (e.g. a
    ``(SELECT ...) AS _r`` subquery) instead of a named table, with
    ``table`` used only as the display label. Used by reconcile drill-in
    profiling so the underlying rows of a bucket can be profiled without
    first materializing them as a table."""
    qt = source if source is not None else _q(table)

    # Column names + a single small sample for type/date inference.
    cols, _ = engine.execute(f"SELECT * FROM {qt} LIMIT 0")
    cols = list(cols or [])
    if not cols:
        return {"table": table, "total_rows": 0, "columns": []}
    _c, sample_rows = engine.execute(f"SELECT * FROM {qt} LIMIT 200")
    sample_rows = sample_rows or []

    samples_by_col = {c: [] for c in cols}
    for r in sample_rows:
        for i, c in enumerate(cols):
            v = r[i] if i < len(r) else None
            if v is not None:
                samples_by_col[c].append(v)

    types, date_fmts = {}, {}
    for c in cols:
        s = samples_by_col[c]
        t = _infer_type(s)
        types[c] = t
        date_fmts[c] = detect_date_format(s) if s else None

    # ---- one pass: scalar aggregates for all columns ----
    select_parts = ["COUNT(*)"]
    # Track, per column, which aggregates we asked for and their order.
    layout = []  # list of (col, has_avg)
    for c in cols:
        qc = _q(c)
        select_parts.append(f"COUNT({qc})")
        select_parts.append(f"COUNT(DISTINCT {qc})")
        select_parts.append(f"MIN({qc})")
        select_parts.append(f"MAX({qc})")
        has_avg = types[c] == "NUMERIC"
        if has_avg:
            select_parts.append(f"AVG(CAST({qc} AS REAL))")
            select_parts.append(
                f"AVG(CAST({qc} AS REAL)*CAST({qc} AS REAL))")
        layout.append((c, has_avg))
    if cancel and cancel():
        raise InterruptedError("cancelled")
    _c, srows = engine.execute(
        "SELECT " + ", ".join(select_parts) + f" FROM {qt}")
    flat = list(srows[0]) if srows else [0]
    total = flat[0] or 0

    stats = {}
    pos = 1
    means = {}
    for c, has_avg in layout:
        nonnull = flat[pos] or 0
        distinct = flat[pos + 1] or 0
        mn = flat[pos + 2]
        mx = flat[pos + 3]
        pos += 4
        mean = mean_sq = None
        if has_avg:
            mean = flat[pos]
            mean_sq = flat[pos + 1]
            pos += 2
        nulls = (total - nonnull) if total else 0
        t = types[c]
        std = None
        if has_avg and mean is not None:
            var = (mean_sq or 0) - mean * mean
            std = math.sqrt(var) if var and var > 0 else 0.0
            means[c] = (mean, std)
        display_type = t
        if date_fmts[c]:
            display_type = f"DATE [{date_format_label(date_fmts[c])}]"
        stats[c] = {
            "column": c,
            "type": display_type,
            "raw_type": t,
            "date_fmt": date_fmts[c],
            "nulls": nulls,
            "null_pct": round(100 * nulls / total, 1) if total else 0.0,
            "distinct": distinct,
            "distinct_pct": (round(100 * distinct / total, 1)
                             if total else 0.0),
            "min": mn if t in ("NUMERIC", "TEXT") else None,
            "max": mx if t in ("NUMERIC", "TEXT") else None,
            "mean": mean,
            "std": std,
            "outliers": None,
            "top_values": [],
        }

    # ---- one pass: 3-sigma outlier counts for all numeric columns ----
    out_cols = [(c, m, s) for c, (m, s) in means.items() if s and s > 0]
    if out_cols:
        parts = []
        for c, m, s in out_cols:
            qc = _q(c)
            parts.append(
                f"SUM(CASE WHEN {qc} IS NOT NULL AND "
                f"ABS(CAST({qc} AS REAL) - {m}) > {3 * s} "
                f"THEN 1 ELSE 0 END)")
        try:
            _c, orows = engine.execute(
                "SELECT " + ", ".join(parts) + f" FROM {qt}")
            ovals = list(orows[0]) if orows else []
            for (c, _m, _s), val in zip(out_cols, ovals):
                stats[c]["outliers"] = val or 0
        except Exception:
            pass
    for c, (m, s) in means.items():
        if stats[c]["outliers"] is None and s == 0:
            stats[c]["outliers"] = 0

    # ---- per-column top values (sampled on enormous tables) ----
    sampled = total > TOPN_EXACT_MAX_ROWS
    base = (f"(SELECT * FROM {qt} LIMIT {TOPN_SAMPLE_ROWS})"
            if sampled else qt)
    denom = min(total, TOPN_SAMPLE_ROWS) if sampled else total
    for c in cols:
        if cancel and cancel():
            raise InterruptedError("cancelled")
        qc = _q(c)
        try:
            _c, tvrows = engine.execute(
                f"SELECT {qc}, COUNT(*) c FROM {base} "
                f"WHERE {qc} IS NOT NULL "
                f"GROUP BY {qc} ORDER BY c DESC, {qc} LIMIT 10")
            stats[c]["top_values"] = [
                {"value": _stringify(r[0]), "count": r[1],
                 "pct": round(100 * r[1] / denom, 1) if denom else 0.0}
                for r in (tvrows or [])
            ]
            stats[c]["top_values_sampled"] = sampled
        except Exception:
            stats[c]["top_values"] = []

    return {"table": table, "total_rows": total,
            "columns": [stats[c] for c in cols]}


def profile_column(engine, table, col, total):
    """Single-column profile (fallback / API compatibility)."""
    res = profile_table(engine, table)
    for c in res["columns"]:
        if c["column"] == col:
            return c
    return {"column": col, "type": "EMPTY", "raw_type": "EMPTY",
            "date_fmt": None, "nulls": 0, "null_pct": 0.0,
            "distinct": 0, "distinct_pct": 0.0, "min": None, "max": None,
            "mean": None, "std": None, "outliers": None, "top_values": []}
