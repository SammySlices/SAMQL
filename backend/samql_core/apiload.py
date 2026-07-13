"""REST API loader: fetch JSON from an HTTP(S) endpoint (optional basic
auth and query parameters) and flatten it into relational tables, the
same way the original APITab did. Uses only urllib from the stdlib.
"""
import base64
import ipaddress
import json
import os
import random
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from .flatten import _json_loads, JSONFlattener, stream_json_records


# Outbound fetches must not target loopback, link-local, or RFC1918 space by
# default (SSRF). Operators who intentionally load from a private API can set
# SAMQL_ALLOW_PRIVATE_FETCH=1. Cloud metadata (169.254.169.254) stays blocked
# even then unless SAMQL_ALLOW_METADATA_FETCH=1 is also set.
_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)
_METADATA_NETWORKS = tuple(
    ipaddress.ip_network(net)
    for net in ("169.254.169.254/32", "fd00:ec2::254/128")
)


def _env_flag(name):
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")


def validate_outbound_http_url(url, *, allow_private=None, purpose="fetch"):
    """Raise ValueError when ``url`` is not a safe outbound http(s) target."""
    if allow_private is None:
        allow_private = _env_flag("SAMQL_ALLOW_PRIVATE_FETCH")
    allow_metadata = _env_flag("SAMQL_ALLOW_METADATA_FETCH")
    parsed = urllib.parse.urlparse((url or "").strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise ValueError(
            "Only http:// and https:// URLs can be used for %s (got %r)."
            % (purpose, scheme or "no scheme")
        )
    host = parsed.hostname
    if not host:
        raise ValueError("URL is missing a host.")
    candidates = []
    try:
        candidates.append(ipaddress.ip_address(host))
    except ValueError:
        # Hostname: resolve only when enforcing the private-network blocklist.
        # HDFS (allow_private=True) intentionally targets internal NameNodes
        # whose DNS may be environment-specific; still refuse known metadata
        # hostnames without doing a lookup.
        if allow_private:
            if host.lower() in (
                "metadata.google.internal",
                "metadata.google",
                "instance-data.ec2.internal",
            ) and not allow_metadata:
                raise ValueError(
                    "Refusing to %s cloud-metadata host %r." % (purpose, host)
                )
            return
        port = parsed.port or (443 if scheme == "https" else 80)
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ValueError("Could not resolve host %r: %s" % (host, exc)) from exc
        for info in infos:
            candidates.append(ipaddress.ip_address(info[4][0]))
    for ip in candidates:
        if any(ip in net for net in _METADATA_NETWORKS) and not allow_metadata:
            raise ValueError(
                "Refusing to %s cloud-metadata address %s." % (purpose, ip)
            )
        if (not allow_private) and any(ip in net for net in _PRIVATE_NETWORKS):
            raise ValueError(
                "Refusing to %s private/link-local address %s (host %r). "
                "Set SAMQL_ALLOW_PRIVATE_FETCH=1 to override."
                % (purpose, ip, host)
            )


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop against the outbound URL policy."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_outbound_http_url(newurl, purpose="follow redirect to")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_url(base_url, params=None):
    base_url = (base_url or "").strip()
    if not params:
        return base_url
    sep = "&" if "?" in base_url else "?"
    return base_url + sep + urllib.parse.urlencode(params, doseq=True)


class FetchCancelled(Exception):
    """Raised inside the fetch loops when should_cancel() turns true, so a
    Stop press aborts an in-flight API node fetch (between pages, or between
    download chunks) instead of running to completion or the 60s timeout."""


def fetch_json(url, auth_user=None, auth_pass=None, timeout=60,
               max_bytes=512 * 1024 * 1024, headers=None):
    """Fetch and parse JSON from ``url``. Returns
    (status, content_type, data, text, error_str). Only http(s) URLs are
    allowed, private/link-local targets are blocked by default, and the
    response is capped at ``max_bytes`` so a huge or hostile endpoint can't
    exhaust memory. ``headers`` is an optional dict of extra request headers
    (e.g. an API-key header)."""
    status, ctype, raw, error = None, "", b"", None
    try:
        validate_outbound_http_url(url, purpose="fetch")
    except ValueError as exc:
        return (None, "", None, "", str(exc))
    try:
        req = urllib.request.Request(
            url, headers={"Accept": "application/json, */*"})
        for hk, hv in (headers or {}).items():
            if hk and str(hk).strip().lower() != "host":
                req.add_header(str(hk), "" if hv is None else str(hv))
        if auth_user:
            token = base64.b64encode(
                f"{auth_user}:{auth_pass or ''}".encode("utf-8")
            ).decode("ascii")
            req.add_header("Authorization", f"Basic {token}")
        ctx = ssl.create_default_context()
        http_err = None
        opener = urllib.request.build_opener(
            _SafeRedirectHandler(),
            urllib.request.HTTPSHandler(context=ctx),
        )
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as he:
            resp = he
            http_err = he
        try:
            status = getattr(resp, "status", None) or resp.getcode()
            ctype = resp.headers.get("Content-Type", "")
            # read with a hard cap (+1 byte so we can detect an overrun)
            raw = resp.read(max_bytes + 1)
            if len(raw) > max_bytes:
                return (status, ctype, None, "",
                        "The response is larger than the %d MB limit; "
                        "fetch a smaller payload or download it to a file "
                        "and load that instead." % (max_bytes // (1024 * 1024)))
        finally:
            try:
                resp.close()
            except Exception:
                pass
        if http_err is not None and not raw:
            raise http_err
    except Exception as e:
        return None, "", None, "", f"{type(e).__name__}: {e}"

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    data = None
    try:
        data = _json_loads(text)
    except (ValueError, json.JSONDecodeError):
        snip = " ".join((text or "").split())[:180]
        return (status, ctype, None, text,
                _not_json_error(status, ctype, snip,
                                empty=not (text or "").strip()))
    return status, ctype, data, text, None


def _value_at(data, path):
    """Walk a dotted ``path`` into ``data`` and return the scalar found there
    (used to read a 'next cursor' out of a paginated response), or None."""
    if not path:
        return None
    cur = data
    for part in path.split("."):
        part = part.strip()
        if not part:
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


# HTTP statuses worth retrying: request timeout, too-early, rate-limited, and
# the transient 5xx server errors.
_RETRY_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def _retry_plan(retry):
    """Normalize a retry config -> (retries, base, cap). ``retry`` is
    {retries, base_delay, max_delay} (all optional); ``retries`` is the number
    of extra attempts after the first (0 disables retrying)."""
    r = retry or {}

    def _num(key, default, lo, hi):
        try:
            v = float(r.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(v, hi))

    retries = int(_num("retries", 0, 0, 10))
    base = _num("base_delay", 0.5, 0.0, 60.0)
    cap = _num("max_delay", 30.0, base, 300.0)
    return retries, base, cap


def _backoff_delay(attempt, base, cap):
    """Full-jitter exponential backoff for a 1-based failed-attempt number:
    a random wait in [0, min(cap, base * 2**(attempt-1))]."""
    exp = min(cap, base * (2.0 ** max(0, attempt - 1)))
    return random.uniform(0.0, exp) if exp > 0 else 0.0


def _is_transient(status, error):
    """A failure worth retrying: a retryable status, or a network-level error
    (a timeout / reset / DNS failure comes back with no status)."""
    if status in _RETRY_STATUSES:
        return True
    return bool(error) and status is None


def _retry_call(do_call, retry, status_error, on_give_up, sleep=None):
    """Generic transient-retry loop shared by the fetch and spool wrappers,
    which differ only in their result-tuple shapes. ``do_call()`` returns a
    result tuple; ``status_error(result) -> (status, error)`` pulls the parts
    that decide retryability; ``on_give_up(result, status, msg) -> result``
    builds what's returned when a retryable status never recovered (so the
    caller treats giving up as a failure, not as data). ``sleep`` is injectable
    for tests."""
    retries, base, cap = _retry_plan(retry)
    sleep = sleep or time.sleep
    last = None
    for attempt in range(1, retries + 2):       # first try + N retries
        last = do_call()
        status, error = status_error(last)
        if not _is_transient(status, error):
            return last
        if attempt <= retries:
            sleep(_backoff_delay(attempt, base, cap))
            continue
        if error is None and status in _RETRY_STATUSES:
            msg = ("HTTP %s after %d attempt(s); gave up retrying."
                   % (status, retries + 1))
            return on_give_up(last, status, msg)
        return last
    return last


def _fetch_with_retries(do_fetch, retry, sleep=None):
    """Retry a fetch returning (status, ctype, data, text, error); on giving up
    after a retryable status the error field is set so it reads as a failure."""
    return _retry_call(
        do_fetch, retry,
        lambda r: (r[0], r[4]),
        lambda r, status, msg: (status, r[1], None, r[3], msg),
        sleep=sleep)


def _spool_with_retries(do_spool, retry, sleep=None):
    """Retry a spool attempt returning (status, ctype, error, nbytes).
    ``do_spool`` re-opens (truncates) the destination each call, so a partial
    write from a failed attempt is overwritten on retry."""
    return _retry_call(
        do_spool, retry,
        lambda r: (r[0], r[2]),
        lambda r, status, msg: (status, r[1], msg, r[3]),
        sleep=sleep)


def fetch_all_pages(url, params=None, auth_user=None, auth_pass=None,
                    headers=None, json_path=None, pagination=None,
                    fetch=None, max_pages=50, retry=None, sleep=None,
                    should_cancel=None):
    """Fetch one or more pages and concatenate their records. ``pagination`` =
    {kind, ...}; kind is 'none' (a single request, the default), 'page'
    (increment a page-number param until an empty page), 'offset' (advance an
    offset by a page size until a short/empty page), or 'cursor' (send the next
    cursor read from ``cursor_path`` until it's absent). Each page is fetched
    through ``_fetch_with_retries`` (``retry`` config, injectable ``sleep``).
    ``fetch`` is the fetch_json-shaped callable (so this stays testable without
    a network). Returns (status, records, error, pages_fetched)."""
    fetch = fetch or fetch_json
    pag = pagination or {}
    kind = (pag.get("kind") or "none").strip().lower()
    base_params = list(params or [])
    all_records, status, pages = [], None, 0

    page_param = (pag.get("page_param") or "page").strip() or "page"
    try:
        page = int(pag.get("start_page") or 1)
    except (TypeError, ValueError):
        page = 1
    offset_param = (pag.get("offset_param") or "offset").strip() or "offset"
    limit_param = (pag.get("limit_param") or "limit").strip() or "limit"
    try:
        size = int(pag.get("page_size") or 100)
    except (TypeError, ValueError):
        size = 100
    size = max(1, size)
    offset = 0
    cursor_param = (pag.get("cursor_param") or "cursor").strip() or "cursor"
    cursor_path = (pag.get("cursor_path") or "").strip()
    cursor = (str(pag.get("start_cursor") or "").strip() or None)

    try:
        cap = int(max_pages or 50)
    except (TypeError, ValueError):
        cap = 50
    cap = max(1, min(cap, 10000))
    if kind == "none":
        cap = 1

    while pages < cap:
        if should_cancel is not None and should_cancel():
            raise FetchCancelled()
        pg = list(base_params)
        if kind == "page":
            pg.append((page_param, str(page)))
        elif kind == "offset":
            pg.append((offset_param, str(offset)))
            pg.append((limit_param, str(size)))
        elif kind == "cursor" and cursor:
            pg.append((cursor_param, str(cursor)))
        full = build_url(url, pg or None)
        status, ctype, data, text, error = _fetch_with_retries(
            lambda u=full: fetch(u, auth_user=auth_user, auth_pass=auth_pass,
                                 headers=headers),
            retry, sleep=sleep)
        if error:
            return status, all_records, error, pages
        recs = _records_from(data, json_path)
        pages += 1
        if recs:
            all_records.extend(recs)
        if kind == "none" or not recs:
            break
        if kind == "page":
            page += 1
        elif kind == "offset":
            offset += size
            if len(recs) < size:    # a short page is the last page
                break
        elif kind == "cursor":
            nxt = _value_at(data, cursor_path) if cursor_path else None
            if not nxt:
                break
            cursor = str(nxt)
        else:
            break
    return status, all_records, None, pages


def _records_from(data, json_path=None):
    """Optionally walk a dotted ``json_path`` (e.g. 'data.items') into
    ``data`` to reach the array of records, then normalize to a list."""
    if json_path:
        cur = data
        for part in json_path.split("."):
            part = part.strip()
            if not part:
                continue
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                cur = None
                break
        data = cur
    if data is None:
        return []
    return data if isinstance(data, list) else [data]


def _sample_text(records, max_records=20, max_chars=20000):
    """Pretty-print up to ``max_records`` records as JSON for previewing,
    capped at ``max_chars``. Pure (no network).
    Returns (text, char_truncated)."""
    shown = records[:max_records]
    try:
        text = json.dumps(shown, indent=2, ensure_ascii=False, default=str)
    except Exception:
        text = str(shown)
    if len(text) > max_chars:
        return text[:max_chars], True
    return text, False


def _peek_text(path, n=180):
    """First ~n visible characters of a spooled response body (whitespace
    collapsed) -- used to show what a non-JSON reply actually contained."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read(4096)
    except Exception:
        return ""
    txt = raw.decode("utf-8", errors="replace")
    return " ".join(txt.split())[:n]


def _not_json_error(status, ctype, snippet, empty=False):
    """Human-readable error for a reply that wasn't JSON: name the HTTP status
    and content-type, and either say it was empty or show a short snippet of
    what came back. A corporate endpoint that needs auth typically answers with
    an HTML login/redirect page (so the body starts with '<' and fails to parse
    at char 0) rather than JSON."""
    st = ("HTTP %s" % status) if status is not None else "the request"
    ct = (", %s" % ctype.split(";")[0].strip()) if ctype else ""
    if empty or not snippet:
        return ("The endpoint returned an empty response (%s%s) -- there was "
                "no JSON to load. This usually means the URL needs "
                "authentication, redirected to a login page, or the request "
                "matched nothing." % (st, ct))
    return ("The endpoint did not return JSON (%s%s). Got this instead: %r. "
            "Check the URL and any required auth/headers (a corporate endpoint "
            "often returns an HTML login page), or set a Records path if the "
            "JSON is nested." % (st, ct, snippet))


def preview_api(url, auth_user=None, auth_pass=None, params=None,
                json_path=None, max_records=20):
    """Fetch + walk an optional ``json_path`` and return a JSON *sample*
    without loading anything into an engine. Returns
    {ok, status, url, count, shown, truncated, sample, error}."""
    full_url = build_url(url, params)
    status, ctype, data, text, error = fetch_json(
        full_url, auth_user, auth_pass)
    if error:
        return {"ok": False, "status": status, "error": error,
                "url": full_url}
    records = _records_from(data, json_path)
    sample, char_trunc = _sample_text(records, max_records=max_records)
    return {"ok": True, "status": status, "url": full_url,
            "count": len(records), "shown": min(len(records), max_records),
            "truncated": len(records) > max_records or char_trunc,
            "sample": sample}


def spool_response(readable, dest, max_bytes=512 * 1024 * 1024,
                   chunk=1024 * 1024, should_cancel=None):
    """Copy a readable (anything with ``.read(n)``) to ``dest`` in bounded
    chunks so a huge response never lands in memory all at once. Stops at
    ``max_bytes``. Returns (nbytes_written, overrun) where overrun is True if
    the source exceeded the cap. Pure -- the readable can be a socket, an
    HTTP response, or a BytesIO in a test."""
    total, overrun = 0, False
    with open(dest, "wb") as out:
        while True:
            if should_cancel is not None and should_cancel():
                raise FetchCancelled()
            buf = readable.read(chunk)
            if not buf:
                break
            if total + len(buf) > max_bytes:
                out.write(buf[:max_bytes - total])
                total, overrun = max_bytes, True
                break
            out.write(buf)
            total += len(buf)
    return total, overrun


def fetch_to_file(url, dest, auth_user=None, auth_pass=None, headers=None,
                  timeout=60, max_bytes=512 * 1024 * 1024, should_cancel=None):
    """Stream an HTTP(S) JSON response straight to ``dest`` with bounded
    memory (the body is never fully held in RAM). Returns
    (status, content_type, error, nbytes)."""
    scheme = urllib.parse.urlparse((url or "").strip()).scheme.lower()
    if scheme not in ("http", "https"):
        return (None, "", "Only http:// and https:// URLs can be fetched "
                "(got %r)." % (scheme or "no scheme"), 0)
    try:
        req = urllib.request.Request(
            url, headers={"Accept": "application/json, */*"})
        for hk, hv in (headers or {}).items():
            if hk and str(hk).strip().lower() != "host":
                req.add_header(str(hk), "" if hv is None else str(hv))
        if auth_user:
            token = base64.b64encode(
                f"{auth_user}:{auth_pass or ''}".encode("utf-8")
            ).decode("ascii")
            req.add_header("Authorization", f"Basic {token}")
        ctx = ssl.create_default_context()
        http_err = None
        try:
            resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        except urllib.error.HTTPError as he:
            resp, http_err = he, he
        try:
            status = getattr(resp, "status", None) or resp.getcode()
            ctype = resp.headers.get("Content-Type", "")
            nbytes, overrun = spool_response(
                resp, dest, max_bytes=max_bytes, should_cancel=should_cancel)
        finally:
            try:
                resp.close()
            except Exception:
                pass
        if overrun:
            return (status, ctype,
                    "The response is larger than the %d MB limit; fetch a "
                    "smaller payload or download it to a file and load that "
                    "instead." % (max_bytes // (1024 * 1024)), nbytes)
        if http_err is not None and nbytes == 0:
            return (status, ctype, "HTTP %s from the endpoint." % status, 0)
        return (status, ctype, None, nbytes)
    except FetchCancelled:
        raise
    except Exception as e:
        return (None, "", "%s: %s" % (type(e).__name__, e), 0)


def _records_from_file(path, json_path=None):
    """Yield records from a spooled JSON file with bounded memory. Without a
    json_path the file's top-level records stream out (array / NDJSON / single
    object) via the shared streaming reader. With a json_path the nested array
    at that path is streamed with ijson when available, otherwise the file is
    parsed once and navigated in memory."""
    jp = (json_path or "").strip().strip(".")
    if not jp:
        for rec in stream_json_records(path):
            yield rec
        return
    try:
        import ijson  # optional, C-accelerated streaming parser
    except Exception:
        ijson = None
    if ijson is not None:
        yielded = False
        try:
            with open(path, "rb") as fb:
                for item in ijson.items(fb, jp + ".item"):
                    yielded = True
                    yield item
            if yielded:
                return
        except Exception:
            yielded = False  # fall through to the tolerant whole-file parse
        if yielded:
            return
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        data = _json_loads(f.read())
    for rec in _records_from(data, json_path):
        yield rec


def _spill_flattener(base_name):
    """A JSONFlattener that spills per-table row buffers to disk once they
    exceed JSON_SPILL_ROWS, so a large API response doesn't pile every
    flattened row into memory. The spill dir lives under the per-instance temp
    dir (swept on shutdown / next start); the flattener doesn't own it, exactly
    like the file loader's spill."""
    import tempfile as _tf
    try:
        from .loaders import JSON_SPILL_ROWS
    except Exception:
        JSON_SPILL_ROWS = 50_000
    spill_dir = None
    try:
        from . import tmputil
        spill_dir = _tf.mkdtemp(prefix="jf_", dir=tmputil.instance_dir())
    except Exception:
        spill_dir = None  # flattener makes its own temp dir if needed
    return JSONFlattener(root_name=base_name, spill_threshold=JSON_SPILL_ROWS,
                         spill_dir=spill_dir)


def _api_sqlite_emit(session, fl, full_url, status):
    """Stream every table the (already-populated) flattener built into SQLite
    and shape the result dict. Always closes the flattener."""
    descs = []
    try:
        for table in fl.table_names():
            cols = fl.columns(table)
            rows = fl.iter_rows_aligned(table)
            name, n = session.db.add_table_streaming(
                table, cols, rows, source=full_url)
            descs.append({"name": name, "rows": n,
                          "columns": session.db.table_columns.get(name, cols),
                          "engine": "sqlite"})
    finally:
        fl.close()
    return {"ok": True, "status": status,
            "loaded": [{"file": full_url, "tables": descs}],
            "tables": descs, "url": full_url}


def _api_sqlite(session, records, base_name, full_url, status):
    """Flatten a list of records into one or more SQLite tables (used by the
    paginated / in-memory path). Row buffers spill to disk past the threshold.
    Returns {ok, status, loaded, tables, url}."""
    fl = _spill_flattener(base_name)
    fl.flatten(records)
    return _api_sqlite_emit(session, fl, full_url, status)


def _api_sqlite_file(session, path, base_name, full_url, status,
                     json_path=None):
    """Stream records straight from a spooled JSON file into SQLite via the
    flattener, spilling row buffers to disk -- the bounded-memory counterpart
    to _api_sqlite, so neither the parsed records nor the flattened rows are
    ever all held in memory at once. Raises if the body isn't JSON; returns
    None when the file held no records, else the usual result dict."""
    fl = _spill_flattener(base_name)
    n_recs = 0
    try:
        for rec in _records_from_file(path, json_path):
            fl.add_record(rec)
            n_recs += 1
    except Exception:
        fl.close()
        raise
    if n_recs == 0:
        fl.close()
        return None
    return _api_sqlite_emit(session, fl, full_url, status)


def _api_duckdb(session, records, base_name, full_url, status):
    """Hand the JSON to DuckDB's native reader -- one table with DuckDB's
    inferred (possibly nested) types, exactly like loading a .json file with
    destination=duckdb. Returns {ok, status, loaded, tables, url}."""
    import tempfile
    from . import tmputil
    duck = session.get_duckdb()
    fd, tmp = tempfile.mkstemp(prefix="api_", suffix=".json",
                               dir=tmputil.instance_dir())
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(records, f)
        name = duck.create_table_from_file(base_name, tmp, "json")
        cols = duck.table_columns.get(name, [])
        n = None
        try:
            _c, rows = duck.execute('SELECT COUNT(*) FROM "%s"' % name)
            n = int(rows[0][0]) if rows else None
        except Exception:
            n = None
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass
    desc = {"name": name, "rows": n, "columns": cols, "engine": "duckdb"}
    return {"ok": True, "status": status,
            "loaded": [{"file": full_url, "tables": [desc]}],
            "tables": [desc], "url": full_url}


def _api_duckdb_file(session, path, base_name, full_url, status):
    """Hand a spooled JSON file straight to DuckDB's reader -- no Python parse,
    bounded memory -- producing one table with DuckDB's inferred (possibly
    nested) types. Used for the streaming single-response path."""
    duck = session.get_duckdb()
    name = duck.create_table_from_file(base_name, path, "json")
    cols = duck.table_columns.get(name, [])
    n = None
    try:
        _c, rows = duck.execute('SELECT COUNT(*) FROM "%s"' % name)
        n = int(rows[0][0]) if rows else None
    except Exception:
        n = None
    desc = {"name": name, "rows": n, "columns": cols, "engine": "duckdb"}
    return {"ok": True, "status": status,
            "loaded": [{"file": full_url, "tables": [desc]}],
            "tables": [desc], "url": full_url}


def _load_records(session, records, base_name, full_url, status, destination):
    """Load a list of records into one table in the requested engine, falling
    back from DuckDB to SQLite when DuckDB is unavailable."""
    if destination == "duckdb":
        try:
            return _api_duckdb(session, records, base_name, full_url, status)
        except Exception:
            pass   # DuckDB unavailable/failed -> SQLite below
    return _api_sqlite(session, records, base_name, full_url, status)


def load_api(session, url, base_name="api_data", auth_user=None,
             auth_pass=None, params=None, destination="sqlite",
             json_path=None, headers=None, fetch=None, spool=None,
             pagination=None, max_pages=50, retry=None, sleep=None,
             should_cancel=None):
    """Fetch JSON and load it into the requested engine (one table; DuckDB
    keeps nested types, SQLite flattens). ``auto``/``default`` resolve to the
    session's preferred engine.

    Two paths keep this both testable and memory-bounded:
      * an injected ``fetch`` (fetch_json-shaped) or any paginated request
        (pagination kind != 'none') runs in memory via fetch_all_pages, which
        is what tests and the iterator drive and is bounded by max_pages;
      * otherwise a single live response is *streamed to a temp file* (via the
        injected ``spool`` or fetch_to_file) and loaded from disk, so the body
        never lands in RAM as one big string -- DuckDB then reads the file
        directly (no Python parse at all), while SQLite parses records from the
        file (the flattener still buffers the flattened rows in memory).
    Returns {ok, status, loaded, tables, pages, error, url}."""
    src_label = build_url(url, params)
    if destination in (None, "", "auto", "default"):
        try:
            destination = session.default_destination()
        except Exception:
            destination = "sqlite"
    kind = ((pagination or {}).get("kind") or "none").strip().lower()
    streaming = (fetch is None and kind == "none")

    if not streaming:
        try:
            status, records, error, pages = fetch_all_pages(
                url, params=params, auth_user=auth_user, auth_pass=auth_pass,
                headers=headers, json_path=json_path, pagination=pagination,
                fetch=fetch, max_pages=max_pages, retry=retry, sleep=sleep,
                should_cancel=should_cancel)
        except FetchCancelled:
            return {"ok": False, "cancelled": True, "error": "cancelled",
                    "url": src_label}
        if error:
            return {"ok": False, "status": status, "error": error,
                    "url": src_label}
        if not records:
            return {"ok": False, "status": status,
                    "error": "Response contained no records to load.",
                    "url": src_label, "pages": pages}
        res = _load_records(session, records, base_name, src_label, status,
                            destination)
        res["pages"] = pages
        return res

    # streaming single-response path
    import tempfile
    from . import tmputil
    fd, tmp = tempfile.mkstemp(prefix="api_", suffix=".json",
                               dir=tmputil.instance_dir())
    os.close(fd)
    try:
        status, ctype, error, nbytes = _spool_with_retries(
            lambda: (spool or fetch_to_file)(
                src_label, tmp, auth_user=auth_user, auth_pass=auth_pass,
                headers=headers,
                **({} if spool else {"should_cancel": should_cancel})),
            retry, sleep=sleep)
        if error:
            return {"ok": False, "status": status, "error": error,
                    "url": src_label}
        jp = (json_path or "").strip()
        if not nbytes:
            # a 2xx with an empty body (a common "matched nothing" / redirect
            # outcome) -- say so plainly instead of failing to parse "".
            return {"ok": False, "status": status,
                    "error": _not_json_error(status, ctype, "", empty=True),
                    "url": src_label, "pages": 1}
        # DuckDB with no records-path: let DuckDB read the file itself
        if destination == "duckdb" and not jp:
            try:
                res = _api_duckdb_file(session, tmp, base_name, src_label,
                                       status)
                res["pages"] = 1
                return res
            except Exception:
                pass   # fall through to a records-based load
        # SQLite: stream records straight from the spooled file into the
        # flattener with on-disk spill, so neither the parsed records nor the
        # flattened rows are all held in memory. (DuckDB with a records-path
        # falls through to the in-memory list load below.)
        if destination != "duckdb":
            try:
                res = _api_sqlite_file(session, tmp, base_name, src_label,
                                       status, json_path)
            except FetchCancelled:
                raise
            except Exception:
                return {"ok": False, "status": status,
                        "error": _not_json_error(status, ctype,
                                                 _peek_text(tmp)),
                        "url": src_label, "pages": 1}
            if res is None:
                return {"ok": False, "status": status,
                        "error": "Response contained no records to load.",
                        "url": src_label, "pages": 1}
            res["pages"] = 1
            return res
        try:
            # DuckDB + a records-path: parse the nested array out, then load.
            records = list(_records_from_file(tmp, json_path))
        except FetchCancelled:
            raise
        except Exception:
            # the body arrived but isn't JSON (an HTML login/error page, plain
            # text, XML, ...). Surface the status / content-type + a snippet of
            # what came back instead of a raw parser stack-trace fragment.
            return {"ok": False, "status": status,
                    "error": _not_json_error(status, ctype, _peek_text(tmp)),
                    "url": src_label, "pages": 1}
        if not records:
            return {"ok": False, "status": status,
                    "error": "Response contained no records to load.",
                    "url": src_label, "pages": 1}
        res = _load_records(session, records, base_name, src_label, status,
                            destination)
        res["pages"] = 1
        return res
    except FetchCancelled:
        return {"ok": False, "cancelled": True, "error": "cancelled",
                "url": src_label}
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass
