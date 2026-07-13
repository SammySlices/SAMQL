"""Pure, GUI-free type-inference and date-detection helpers.

These power the typed-column loader (SQLite affinity inference) and the
profiler's date-format detection. Lifted directly from the original
single-file application and intentionally conservative for financial
data (identifier-looking columns are never coerced to numbers, so
leading zeros / large IDs survive intact).
"""
import datetime as _dt
import re
from collections import Counter

# Columns whose NAME looks like an identifier are NEVER auto-typed,
# because turning an account number / CUSIP / ZIP into a number silently
# drops leading zeros and breaks text<->number joins.
_IDENT_NAME_RE = re.compile(
    r"(^|_)("
    r"id|ids|code|codes|num|no|number|nbr|"
    r"cusip|isin|sedol|ticker|figi|lei|"
    r"acct|account|customer|client|portfolio|book|"
    r"zip|postal|phone|fax|ssn|ein|tin|"
    r"routing|aba|iban|swift|bic|mic|"
    r"key|guid|uuid|hash|ref"
    r")($|_)", re.IGNORECASE)

# Only PURE-INTEGER columns whose name says "measure" get INTEGER affinity.
_MEASURE_NAME_RE = re.compile(
    r"(^|_)("
    r"amt|amount|amounts|bal|balance|balances|"
    r"value|val|values|qty|quantity|quantities|count|counts|"
    r"total|totals|sum|principal|notional|par|"
    r"mv|marketvalue|market_value|exposure|haircut|"
    r"price|rate|pct|percent|ratio|weight|factor|score|"
    r"volume|shares|units|days|age|num_"
    r")($|_)", re.IGNORECASE)
_INT_RE = re.compile(r"^[+-]?\d+$")
_FLOAT_RE = re.compile(r"^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$")
_LEADING_ZERO_RE = re.compile(r"^[+-]?0\d")


def infer_affinity(name, values):
    """Return 'INTEGER', 'REAL', or '' (=> keep TEXT) for a column."""
    # Values that arrive as *native* numbers -- a JSON number, or a grid cell
    # already coerced to int/float -- are unambiguously numeric, so type them
    # as such no matter what the column is called. The name-based "this might
    # be an identifier" heuristics below exist only to stop us coercing a
    # *string* run of digits (an account number, a zip with a leading zero)
    # that happens to look numeric; once a value is a real int/float there is
    # nothing to second-guess. This also matters for strict engines (DuckDB):
    # a numeric column stored as VARCHAR can't be used in arithmetic, so a
    # formula like `col1 + 1` would fail to bind even though the data is whole
    # numbers.
    non_null = [v for v in values
                if v is not None and not isinstance(v, bool)]
    if non_null and all(isinstance(v, (int, float)) for v in non_null):
        if any(isinstance(v, float) for v in non_null):
            return "REAL"
        # too-wide integers can't round-trip through the engine's 64-bit
        # integer type, so keep those as text (lossless).
        if all(len(str(abs(v))) <= 18 for v in non_null):
            return "INTEGER"
        return ""
    if name and _IDENT_NAME_RE.search(name):
        return ""
    seen = 0
    has_real = False
    for v in values:
        if v is None:
            continue
        if isinstance(v, bool):
            return ""
        if isinstance(v, float):
            seen += 1
            has_real = True
            continue
        if isinstance(v, int):
            seen += 1
            if len(str(abs(v))) > 18:
                return ""
            continue
        s = str(v).strip()
        if not s:
            continue
        seen += 1
        if _LEADING_ZERO_RE.match(s):
            return ""
        body = s.lstrip("+-")
        if _INT_RE.match(s):
            if len(body) > 18:
                return ""
            continue
        if _FLOAT_RE.match(s):
            has_real = True
            continue
        return ""  # non-numeric token -> TEXT
    if seen == 0:
        return ""
    if has_real:
        return "REAL"
    if name and _MEASURE_NAME_RE.search(name):
        return "INTEGER"
    return ""


def infer_affinities(columns, sample_rows):
    """columns: list[str]; sample_rows: list of value-sequences aligned
    to columns. Returns {column: 'INTEGER'|'REAL'|''}."""
    out = {}
    for ci, name in enumerate(columns):
        vals = []
        for r in sample_rows:
            if ci < len(r):
                vals.append(r[ci])
        out[name] = infer_affinity(name, vals)
    return out


DATE_FORMATS = [
    ("%Y-%m-%dT%H:%M:%S.%fZ", "ISO 8601 with ms (Z)"),
    ("%Y-%m-%dT%H:%M:%SZ", "ISO 8601 (Z)"),
    ("%Y-%m-%dT%H:%M:%S.%f", "ISO 8601 with ms"),
    ("%Y-%m-%dT%H:%M:%S", "ISO 8601"),
    ("%Y-%m-%d %H:%M:%S.%f", "YYYY-MM-DD HH:MM:SS.fff"),
    ("%Y-%m-%d %H:%M:%S", "YYYY-MM-DD HH:MM:SS"),
    ("%Y-%m-%d", "YYYY-MM-DD"),
    ("%Y/%m/%d", "YYYY/MM/DD"),
    ("%Y%m%d", "YYYYMMDD (compact)"),
    ("%m/%d/%Y", "MM/DD/YYYY (US)"),
    ("%m-%d-%Y", "MM-DD-YYYY (US)"),
    ("%d/%m/%Y", "DD/MM/YYYY (EU)"),
    ("%d-%m-%Y", "DD-MM-YYYY (EU)"),
    ("%d %b %Y", "DD Mon YYYY (e.g. 09 Aug 2024)"),
    ("%b %d, %Y", "Mon DD, YYYY (e.g. Aug 9, 2024)"),
    ("%d-%b-%Y", "DD-Mon-YYYY"),
]


def try_parse_date(value):
    if value is None:
        return None, None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None, None
    elif isinstance(value, (int, float)):
        try:
            iv = int(value)
        except (TypeError, ValueError):
            return None, None
        if 19000101 <= iv <= 21001231:
            try:
                d = _dt.datetime.strptime(str(iv), "%Y%m%d")
                return d, "%Y%m%d"
            except ValueError:
                pass
        return None, None
    else:
        return None, None
    for fmt, _label in DATE_FORMATS:
        try:
            d = _dt.datetime.strptime(s, fmt)
            if 1900 <= d.year <= 2100:
                return d, fmt
        except (ValueError, TypeError):
            continue
    return None, None


def detect_date_format(samples, threshold=0.9):
    parsed = []
    n_non_null = 0
    for v in samples:
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        n_non_null += 1
        d, fmt = try_parse_date(v)
        if fmt is not None:
            parsed.append(fmt)
    if n_non_null == 0 or not parsed:
        return None
    fmt, count = Counter(parsed).most_common(1)[0]
    if count / n_non_null >= threshold:
        return fmt
    return None


def date_format_label(fmt):
    for f, label in DATE_FORMATS:
        if f == fmt:
            return label
    return fmt
