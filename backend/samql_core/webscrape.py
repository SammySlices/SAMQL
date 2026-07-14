"""Fetch a public HTML/JSON page and flatten chosen content into tabular rows.

Uses only the stdlib (urllib + html.parser). Shares SSRF guards with apiload.
"""
from __future__ import annotations

import html.parser
import json
import re
import urllib.error
import urllib.request

from .apiload import validate_outbound_http_url


class _TableParser(html.parser.HTMLParser):
    """Collect every HTML table, including nested ones, without losing the
    outer table's remaining rows/cells when an inner ``<table>`` closes.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        # Stack of {rows, row, cell, buf} for the parent context while a nested
        # table is being parsed. ``rows`` is the list already appended to
        # ``self.tables``.
        self._stack = []
        self._rows = None
        self._row = None
        self._cell = False
        self._buf = []
        self._ignore = 0  # script/style depth — drop their text from cells

    def handle_starttag(self, tag, attrs):
        t = (tag or "").lower()
        if t in ("script", "style"):
            self._ignore += 1
            return
        if self._ignore:
            return
        if t == "table":
            # Push parent cell/row state so nested tables don't wipe it.
            self._stack.append(
                {
                    "rows": self._rows,
                    "row": self._row,
                    "cell": self._cell,
                    "buf": self._buf,
                }
            )
            self._rows = []
            self.tables.append(self._rows)
            self._row = None
            self._cell = False
            self._buf = []
        elif t == "tr" and self._rows is not None:
            self._row = []
            self._rows.append(self._row)
            self._cell = False
            self._buf = []
        elif t in ("td", "th") and self._row is not None:
            self._cell = True
            self._buf = []

    def handle_endtag(self, tag):
        t = (tag or "").lower()
        if t in ("script", "style"):
            if self._ignore:
                self._ignore -= 1
            return
        if self._ignore:
            return
        if t in ("td", "th") and self._cell:
            text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            if self._row is not None:
                self._row.append(text)
            self._cell = False
            self._buf = []
        elif t == "tr":
            self._row = None
            self._cell = False
            self._buf = []
        elif t == "table":
            # Close the current table and restore the parent context (if any).
            if self._stack:
                saved = self._stack.pop()
                self._rows = saved["rows"]
                self._row = saved["row"]
                self._cell = saved["cell"]
                self._buf = saved["buf"]
            else:
                self._rows = None
                self._row = None
                self._cell = False
                self._buf = []

    def handle_data(self, data):
        if self._ignore:
            return
        if self._cell:
            self._buf.append(data)


class _LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self._href = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if (tag or "").lower() != "a":
            return
        href = ""
        for k, v in attrs or []:
            if (k or "").lower() == "href":
                href = v or ""
                break
        self._href = href
        self._buf = []

    def handle_endtag(self, tag):
        if (tag or "").lower() != "a" or self._href is None:
            return
        text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self.links.append((text, self._href))
        self._href = None
        self._buf = []

    def handle_data(self, data):
        if self._href is not None:
            self._buf.append(data)


_SCRIPT_JSON_RE = re.compile(
    r"""<script[^>]*\btype\s*=\s*["']application/(?:ld\+)?json["'][^>]*>(.*?)</script>""",
    re.IGNORECASE | re.DOTALL,
)


def _fetch_url(url, timeout=30, user_agent=None, accept=None, max_bytes=None):
    """Fetch a URL with a hard body-size cap.

    Web scrape is for HTML tables / small JSON pages — not multi-GB payloads.
    Override with ``SAMQL_WEBSCRAPE_MB`` (default 32). ``0`` disables the cap.
    """
    import os
    validate_outbound_http_url(url, purpose="web scrape")
    if max_bytes is None:
        try:
            mb = float(os.environ.get("SAMQL_WEBSCRAPE_MB", "32"))
        except Exception:
            mb = 32.0
        max_bytes = None if mb <= 0 else int(mb * 1024 * 1024)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent
            or "SamQL-WebScrape/1.0 (+https://github.com/slauricella1/SAMQL)",
            "Accept": accept
            or "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            if max_bytes is None:
                raw = resp.read()
            else:
                raw = resp.read(max_bytes + 1)
                if len(raw) > max_bytes:
                    raise ValueError(
                        "Page larger than %d MiB — too big for web scrape. "
                        "Download the file and use Load, or raise "
                        "SAMQL_WEBSCRAPE_MB." % (max_bytes // (1024 * 1024)))
            ctype = (resp.headers.get_content_type() or "").lower()
            return (
                raw.decode(charset, errors="replace"),
                resp.geturl(),
                ctype,
            )
    except urllib.error.HTTPError as exc:
        raise ValueError("HTTP %s fetching %s" % (exc.code, url)) from exc
    except urllib.error.URLError as exc:
        raise ValueError("Could not fetch %s: %s" % (url, exc.reason)) from exc


def _looks_json(text):
    t = (text or "").lstrip()
    return bool(t) and t[0] in "{["


def _parse_json_text(text):
    try:
        return json.loads(text)
    except Exception:
        return None


def _extract_embedded_json(html_text):
    """Pull JSON from ``application/ld+json`` / ``application/json`` script tags."""
    found = []
    for m in _SCRIPT_JSON_RE.finditer(html_text or ""):
        raw = (m.group(1) or "").strip()
        if not raw:
            continue
        data = _parse_json_text(raw)
        if data is not None:
            found.append(data)
    return found


def _cell_value(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:
        return str(v)


def _records_to_columns_rows(records):
    """Flatten dict (or scalar) records into a rectangular column/row matrix."""
    recs = list(records or [])
    if not recs:
        raise ValueError("No JSON records found.")
    dicts = [r for r in recs if isinstance(r, dict)]
    if dicts:
        keys = []
        seen = set()
        for row in dicts:
            for k in row.keys():
                sk = str(k)
                if sk not in seen:
                    seen.add(sk)
                    keys.append(sk)
        if not keys:
            keys = ["value"]
        out_rows = [[_cell_value(row.get(k)) for k in keys] for row in dicts]
        return keys, out_rows, {"count": len(out_rows)}
    # primitives / arrays → single value column
    return (
        ["value"],
        [[_cell_value(r)] for r in recs],
        {"count": len(recs)},
    )


def _json_payload_to_columns_rows(data, json_path=None):
    from .apiload import _records_from

    records = _records_from(data, json_path)
    cols, rows, meta = _records_to_columns_rows(records)
    meta = dict(meta)
    if json_path:
        meta["json_path"] = json_path
    return cols, rows, meta


def _tables_from_html(html_text, table_index=0):
    p = _TableParser()
    p.feed(html_text or "")
    # Drop empty placeholder tables (e.g. layout chrome with no cells).
    tables = [t for t in p.tables if any(len(r) for r in t)]
    if not tables:
        raise ValueError("No HTML tables found on that page.")
    try:
        idx = int(table_index or 0)
    except (TypeError, ValueError):
        idx = 0
    if idx < 0 or idx >= len(tables):
        raise ValueError(
            "table_index %s is out of range (page has %d table(s))."
            % (idx, len(tables))
        )
    table = tables[idx]
    width = max((len(r) for r in table), default=0)
    if width == 0:
        raise ValueError("The chosen HTML table is empty.")
    header = None
    body = table
    if table and all(isinstance(c, str) for c in table[0]):
        # Prefer first row as header when it looks non-numeric-heavy.
        nums = sum(
            1
            for c in table[0]
            if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", c or "")
        )
        if nums * 2 < len(table[0]):
            header = [c or ("col_%d" % (i + 1)) for i, c in enumerate(table[0])]
            body = table[1:]
    if not header:
        header = ["col_%d" % (i + 1) for i in range(width)]
    # Unique column names
    seen = {}
    cols = []
    for name in header:
        base = (name or "col").strip() or "col"
        n = seen.get(base, 0)
        seen[base] = n + 1
        cols.append(base if n == 0 else "%s_%d" % (base, n + 1))
    # Pad header width if body rows are wider than the header row.
    width = max(width, len(cols))
    if len(cols) < width:
        for i in range(len(cols), width):
            cols.append("col_%d" % (i + 1))
    rows = []
    for r in body:
        cells = list(r) + [""] * (width - len(r))
        rows.append(cells[:width])
    return cols, rows, {
        "mode": "tables",
        "table_index": idx,
        "table_count": len(tables),
        "count": len(rows),
    }


def content_to_columns_rows(
    text,
    mode="tables",
    table_index=0,
    json_path=None,
    content_type="",
    final_url="",
):
    """Pure parse path (no network) — used by scrape + unit tests."""
    mode = (mode or "tables").strip().lower()
    ctype = (content_type or "").lower()
    meta_base = {"url": final_url or ""}

    if mode == "links":
        p = _LinkParser()
        p.feed(text or "")
        cols = ["text", "href"]
        rows = [[t, h] for t, h in p.links]
        meta = dict(meta_base)
        meta.update({"mode": "links", "count": len(rows)})
        return cols, rows, meta

    if mode == "text":
        body = text or ""
        body = re.sub(r"(?is)<script.*?>.*?</script>", " ", body)
        body = re.sub(r"(?is)<style.*?>.*?</style>", " ", body)
        body = re.sub(r"(?s)<[^>]+>", " ", body)
        body = re.sub(r"\s+", " ", body).strip()
        meta = dict(meta_base)
        meta.update({"mode": "text", "count": 1})
        return ["text"], [[body]], meta

    if mode == "json":
        data = None
        source = None
        if "json" in ctype or _looks_json(text):
            data = _parse_json_text(text)
            if data is not None:
                source = "body"
        if data is None:
            embedded = _extract_embedded_json(text)
            if not embedded:
                raise ValueError(
                    "No JSON found (body is not JSON and no "
                    "application/ld+json or application/json script tags)."
                )
            data = embedded[0] if len(embedded) == 1 else embedded
            source = "embedded"
        cols, rows, meta = _json_payload_to_columns_rows(data, json_path=json_path)
        meta = dict(meta)
        meta.update(meta_base)
        meta["mode"] = "json"
        meta["json_source"] = source
        return cols, rows, meta

    # tables (default) — if the response is JSON, load it as records instead of
    # failing with "No HTML tables".
    if "json" in ctype or (_looks_json(text) and "<table" not in (text or "").lower()):
        data = _parse_json_text(text)
        if data is not None:
            cols, rows, meta = _json_payload_to_columns_rows(
                data, json_path=json_path
            )
            meta = dict(meta)
            meta.update(meta_base)
            meta["mode"] = "json"
            meta["json_source"] = "body"
            meta["note"] = "Response was JSON; loaded as records (use mode=json)."
            return cols, rows, meta

    try:
        cols, rows, meta = _tables_from_html(text, table_index=table_index)
    except ValueError as exc:
        # Last chance: embedded JSON objects on an HTML page with no tables.
        embedded = _extract_embedded_json(text)
        if embedded:
            data = embedded[0] if len(embedded) == 1 else embedded
            cols, rows, meta = _json_payload_to_columns_rows(
                data, json_path=json_path
            )
            meta = dict(meta)
            meta.update(meta_base)
            meta["mode"] = "json"
            meta["json_source"] = "embedded"
            meta["note"] = "No HTML tables; loaded embedded JSON instead."
            return cols, rows, meta
        raise exc
    meta = dict(meta)
    meta.update(meta_base)
    return cols, rows, meta


def scrape_to_columns_rows(
    url,
    mode="tables",
    table_index=0,
    timeout=30,
    json_path=None,
):
    """Return ``(columns, rows, meta)`` for loading into an engine table."""
    mode_l = (mode or "tables").strip().lower()
    accept = (
        "application/json,text/json;q=0.9,*/*;q=0.8"
        if mode_l == "json"
        else "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    )
    text, final_url, ctype = _fetch_url(url, timeout=timeout, accept=accept)
    return content_to_columns_rows(
        text,
        mode=mode_l,
        table_index=table_index,
        json_path=json_path,
        content_type=ctype,
        final_url=final_url,
    )
