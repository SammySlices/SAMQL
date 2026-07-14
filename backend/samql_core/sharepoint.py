"""SharePoint / Microsoft Graph helpers.

Supports:
  - list items (existing)
  - drive browse (folders + files)
  - drive file download (bytes + filename)

Auth:
  - bearer token (Graph or classic REST)
  - Windows Integrated (Negotiate/NTLM) for classic on-prem ``_api`` only
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .apiload import validate_outbound_http_url

# Injectable for tests (signature: url, headers=None, timeout=60 -> (bytes, final_url, hdrs))
_WINDOWS_GET = None


def _headers(token, *, classic=False):
    h = {
        "Accept": "application/json;odata=nometadata" if classic else "application/json",
        "User-Agent": "SamQL-SharePoint/1.0",
    }
    if token:
        h["Authorization"] = "Bearer " + token
    return h


def is_graph_host(host: str) -> bool:
    host = (host or "").lower()
    return "sharepoint.com" in host or host.endswith("sharepoint.us")


def _windows_get(url, headers=None, timeout=60):
    """GET with current-user Negotiate/NTLM.

    Prefers ``requests`` + ``requests_negotiate_sspi`` (Windows) or
    ``requests_negotiate``. Tests inject ``_WINDOWS_GET``.
    """
    if _WINDOWS_GET is not None:
        return _WINDOWS_GET(url, headers=headers, timeout=timeout)

    try:
        import requests  # type: ignore
    except ImportError as exc:
        raise ValueError(
            "Windows Integrated Auth needs the 'requests' package "
            "(pip install requests requests-negotiate-sspi)."
        ) from exc

    auth = None
    try:
        from requests_negotiate_sspi import HttpNegotiateAuth  # type: ignore
        auth = HttpNegotiateAuth()
    except ImportError:
        try:
            from requests_negotiate import HttpNegotiateAuth  # type: ignore
            auth = HttpNegotiateAuth()
        except ImportError as exc:
            raise ValueError(
                "Windows Integrated Auth needs "
                "'requests-negotiate-sspi' (Windows) or 'requests-negotiate'. "
                "pip install requests-negotiate-sspi"
            ) from exc

    resp = requests.get(
        url, auth=auth, headers=headers or {}, timeout=timeout,
        allow_redirects=True)
    if resp.status_code >= 400:
        body = (resp.text or "")[:400]
        raise ValueError(
            "SharePoint HTTP %s: %s" % (resp.status_code, body or resp.reason)
        )
    return resp.content, resp.url, dict(resp.headers)


def _http_json(url, token, timeout=60, classic=False, auth_mode="bearer"):
    mode = (auth_mode or "bearer").lower()
    # Classic on-prem SharePoint (especially Windows Integrated) almost always
    # lives on a private network — allow it for SharePoint fetches only.
    allow_private = mode == "windows" or classic
    validate_outbound_http_url(
        url, purpose="SharePoint fetch", allow_private=allow_private)
    if mode == "windows":
        raw, final, _ = _windows_get(
            url, headers=_headers("", classic=classic), timeout=timeout)
        return json.loads(raw.decode("utf-8", errors="replace")), final

    req = urllib.request.Request(
        url, headers=_headers(token, classic=classic), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8", errors="replace")), resp.geturl()
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            body = ""
        raise ValueError(
            "SharePoint HTTP %s: %s" % (exc.code, body or exc.reason)
        ) from exc
    except urllib.error.URLError as exc:
        raise ValueError("SharePoint request failed: %s" % exc.reason) from exc


def _http_stream_to_file(url, token, dest_path, timeout=120,
                         chunk_size=1024 * 1024, auth_mode="bearer"):
    """Stream a SharePoint/Graph download straight to ``dest_path``.

    Never buffers the whole body in RAM (a multi-GB drive item must not be
    ``resp.read()``'d). Returns ``(nbytes, filename_or_None, final_url)``.
    """
    mode = (auth_mode or "bearer").lower()
    allow_private = mode == "windows"
    validate_outbound_http_url(
        url, purpose="SharePoint download", allow_private=allow_private)
    if mode == "windows":
        raw, final, hdrs = _windows_get(
            url,
            headers={
                "User-Agent": "SamQL-SharePoint/1.0",
            },
            timeout=timeout,
        )
        name = None
        cd = (hdrs or {}).get("Content-Disposition") or (hdrs or {}).get(
            "content-disposition") or ""
        if "filename=" in cd:
            name = cd.split("filename=", 1)[1].strip().strip('"')
        with open(dest_path, "wb") as out:
            out.write(raw)
        return len(raw), name, final

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "User-Agent": "SamQL-SharePoint/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            name = None
            cd = resp.headers.get("Content-Disposition") or ""
            if "filename=" in cd:
                name = cd.split("filename=", 1)[1].strip().strip('"')
            total = 0
            with open(dest_path, "wb") as out:
                while True:
                    buf = resp.read(chunk_size)
                    if not buf:
                        break
                    out.write(buf)
                    total += len(buf)
            return total, name, resp.geturl()
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            body = ""
        raise ValueError(
            "SharePoint download HTTP %s: %s" % (exc.code, body or exc.reason)
        ) from exc
    except urllib.error.URLError as exc:
        raise ValueError("SharePoint download failed: %s" % exc.reason) from exc


def _http_bytes(url, token, timeout=120, auth_mode="bearer"):
    """Compatibility wrapper: stream to a temp file then return bytes.

    Prefer ``_http_stream_to_file`` for large downloads. Kept for callers that
    still expect an in-memory body (small Graph metadata probes).
    """
    import tempfile
    import os
    try:
        from . import tmputil
        dest_dir = tmputil.instance_dir()
    except Exception:
        dest_dir = None
    fd, tmp = tempfile.mkstemp(prefix="spdl_", dir=dest_dir)
    os.close(fd)
    try:
        nbytes, name, final = _http_stream_to_file(
            url, token, tmp, timeout=timeout, auth_mode=auth_mode)
        with open(tmp, "rb") as f:
            data = f.read()
        return data, name, final
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def _site_parts(site_url):
    site_url = (site_url or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(site_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("Site URL looks invalid.")
    host = (parsed.netloc or "").lower()
    path = parsed.path or "/"
    return site_url, host, path, parsed


def _graph_list_url(site_url, list_title):
    site_url, host, path, _ = _site_parts(site_url)
    list_title = (list_title or "").strip()
    if not list_title:
        raise ValueError("SharePoint needs a list name.")
    if "sharepoint.com" in host or host.endswith("sharepoint.us"):
        site_path = path if path != "/" else ""
        encoded_list = urllib.parse.quote(list_title, safe="")
        return (
            "https://graph.microsoft.com/v1.0/sites/%s:%s:/lists/%s/items"
            "?$expand=fields&$top=5000"
            % (host, site_path, encoded_list)
        )
    title_q = list_title.replace("'", "''")
    return (
        "%s/_api/web/lists/getbytitle('%s')/items?$top=5000"
        % (site_url, title_q)
    )


def _graph_site_id_url(site_url):
    _, host, path, _ = _site_parts(site_url)
    site_path = path if path != "/" else ""
    return "https://graph.microsoft.com/v1.0/sites/%s:%s:" % (host, site_path)


def _graph_drive_children_url(site_url, folder_path=""):
    """Children of the site default drive at ``folder_path`` (server-relative)."""
    base = _graph_site_id_url(site_url)
    folder = (folder_path or "").strip().strip("/")
    if not folder:
        return base + "/drive/root/children?$top=200"
    encoded = urllib.parse.quote(folder, safe="/")
    return base + "/drive/root:/%s:/children?$top=200" % encoded


def _require_auth(token, auth_mode, *, action="fetching"):
    mode = (auth_mode or "bearer").lower()
    if mode == "windows":
        return ""
    token = (token or "").strip()
    if not token:
        raise ValueError(
            "Add a SharePoint access token (saved secret) or sign in "
            "before %s." % action
        )
    return token


def _reject_windows_on_graph(site_url, auth_mode):
    mode = (auth_mode or "bearer").lower()
    if mode != "windows":
        return
    _, host, _, _ = _site_parts(site_url)
    if is_graph_host(host):
        raise ValueError(
            "Windows Integrated Auth is for classic on-prem SharePoint "
            "(_api). Online sites on sharepoint.com use Sign in / bearer "
            "token with Microsoft Graph."
        )


def fetch_sharepoint_items(site_url, list_title, bearer_token, timeout=60,
                           auth_mode="bearer"):
    """Return ``(records, meta)`` where records are dicts ready to flatten."""
    _reject_windows_on_graph(site_url, auth_mode)
    token = _require_auth(bearer_token, auth_mode, action="fetching")
    url = _graph_list_url(site_url, list_title)
    classic = "/_api/" in url
    if (auth_mode or "").lower() == "windows" and not classic:
        raise ValueError(
            "Windows Integrated Auth only works with classic SharePoint REST."
        )
    records = []
    next_url = url
    pages = 0
    while next_url and pages < 50:
        pages += 1
        data, _ = _http_json(
            next_url, token, timeout=timeout, classic=classic,
            auth_mode=auth_mode)
        if isinstance(data, dict) and "value" in data:
            batch = data.get("value") or []
        elif isinstance(data, dict) and "d" in data:
            d = data.get("d") or {}
            batch = d.get("results") if isinstance(d, dict) else []
            if batch is None and isinstance(d, dict) and "results" not in d:
                batch = [d]
        elif isinstance(data, list):
            batch = data
        else:
            batch = [data] if data else []

        for item in batch:
            if not isinstance(item, dict):
                continue
            fields = item.get("fields")
            if isinstance(fields, dict):
                row = dict(fields)
                if item.get("id") is not None and "id" not in row:
                    row["id"] = item.get("id")
                records.append(row)
            else:
                records.append({
                    k: v for k, v in item.items()
                    if not str(k).startswith("__") and k not in ("odata.type",)
                })

        next_url = None
        if isinstance(data, dict):
            next_url = data.get("@odata.nextLink") or data.get("odata.nextLink")
            if not next_url and isinstance(data.get("d"), dict):
                next_url = data["d"].get("__next")

    meta = {
        "url": url,
        "count": len(records),
        "pages": pages,
        "list": list_title,
        "mode": "list",
        "auth_mode": (auth_mode or "bearer"),
    }
    return records, meta


def browse_drive(site_url, folder_path, bearer_token, timeout=60,
                 auth_mode="bearer"):
    """Browse drive folders/files. Returns rows as list-of-dicts + meta."""
    _reject_windows_on_graph(site_url, auth_mode)
    token = _require_auth(bearer_token, auth_mode, action="browsing")
    _, host, _, _ = _site_parts(site_url)
    if "sharepoint.com" not in host and not host.endswith("sharepoint.us"):
        # Classic: folders via GetFolderByServerRelativeUrl
        site_url_c, _, _, parsed = _site_parts(site_url)
        rel = (folder_path or "").strip() or (parsed.path or "/")
        if not rel.startswith("/"):
            rel = "/" + rel
        encoded = urllib.parse.quote(rel, safe="/'")
        url = (
            "%s/_api/web/GetFolderByServerRelativeUrl('%s')"
            "?$expand=Folders,Files"
            % (site_url_c, encoded.replace("'", "''"))
        )
        data, _ = _http_json(
            url, token, timeout=timeout, classic=True, auth_mode=auth_mode)
        d = data.get("d") if isinstance(data, dict) else data
        rows = []
        folders = ((d or {}).get("Folders") or {}).get("results") or []
        files = ((d or {}).get("Files") or {}).get("results") or []
        for f in folders:
            rows.append({
                "name": f.get("Name"),
                "kind": "folder",
                "id": f.get("UniqueId") or f.get("Name"),
                "size": None,
                "path": f.get("ServerRelativeUrl"),
                "webUrl": f.get("ServerRelativeUrl"),
                "downloadUrl": None,
            })
        for f in files:
            rows.append({
                "name": f.get("Name"),
                "kind": "file",
                "id": f.get("UniqueId") or f.get("Name"),
                "size": f.get("Length"),
                "path": f.get("ServerRelativeUrl"),
                "webUrl": f.get("ServerRelativeUrl"),
                "downloadUrl": f.get("ServerRelativeUrl"),
            })
        return rows, {
            "mode": "drive",
            "path": rel,
            "count": len(rows),
            "url": url,
            "auth_mode": (auth_mode or "bearer"),
        }

    url = _graph_drive_children_url(site_url, folder_path)
    data, _ = _http_json(
        url, token, timeout=timeout, auth_mode=auth_mode)
    batch = (data.get("value") if isinstance(data, dict) else None) or []
    rows = []
    for item in batch:
        if not isinstance(item, dict):
            continue
        is_folder = isinstance(item.get("folder"), dict)
        rows.append({
            "name": item.get("name"),
            "kind": "folder" if is_folder else "file",
            "id": item.get("id"),
            "size": None if is_folder else item.get("size"),
            "path": (item.get("parentReference") or {}).get("path"),
            "webUrl": item.get("webUrl"),
            "downloadUrl": item.get("@microsoft.graph.downloadUrl"),
        })
    return rows, {
        "mode": "drive",
        "path": (folder_path or "").strip() or "/",
        "count": len(rows),
        "url": url,
        "auth_mode": (auth_mode or "bearer"),
    }


def download_drive_item(site_url, item_id, bearer_token, download_url=None,
                        timeout=120, dest_path=None, auth_mode="bearer"):
    """Download one drive item.

    When ``dest_path`` is set, streams the body straight to that path and
    returns ``(nbytes, filename, meta)``. Without ``dest_path``, returns
    ``(bytes, filename, meta)`` for small/compat callers (still streams via a
    temp file so peak RAM is one file copy, not a live socket buffer + write).
    """
    if download_url or (site_url and item_id):
        _reject_windows_on_graph(site_url or "", auth_mode)
    token = _require_auth(bearer_token, auth_mode, action="downloading")

    def _to_dest(url, fallback_name, via):
        if dest_path:
            nbytes, name, final = _http_stream_to_file(
                url, token, dest_path, timeout=timeout, auth_mode=auth_mode)
            return nbytes, name or fallback_name, {
                "url": final, "item_id": item_id, "via": via,
            }
        data, name, final = _http_bytes(
            url, token, timeout=timeout, auth_mode=auth_mode)
        return data, name or fallback_name, {
            "url": final, "item_id": item_id, "via": via,
        }

    if download_url:
        return _to_dest(download_url, "sharepoint_file", "downloadUrl")

    item_id = (item_id or "").strip()
    if not item_id:
        raise ValueError("Pick a file id (or downloadUrl) to download.")
    _, host, _, _ = _site_parts(site_url)
    if "sharepoint.com" in host or host.endswith("sharepoint.us"):
        base = _graph_site_id_url(site_url)
        # Prefer content endpoint
        url = base + "/drive/items/%s/content" % urllib.parse.quote(item_id, safe="")
        nbytes_or_data, name, meta = _to_dest(url, "sharepoint_file", "content")
        if not name or name == "sharepoint_file":
            # Probe metadata for the name
            try:
                meta_j, _ = _http_json(
                    base + "/drive/items/%s" % urllib.parse.quote(item_id, safe=""),
                    token, timeout=30, auth_mode=auth_mode,
                )
                name = (meta_j or {}).get("name") or name
            except Exception:
                pass
        return nbytes_or_data, name or "sharepoint_file", meta

    # Classic: item_id may be a server-relative path
    site_url_c, _, _, _ = _site_parts(site_url)
    path = item_id if item_id.startswith("/") else "/" + item_id
    encoded = urllib.parse.quote(path, safe="/'")
    url = "%s/_api/web/GetFileByServerRelativeUrl('%s')/$value" % (
        site_url_c, encoded.replace("'", "''"),
    )
    return _to_dest(url, path.rsplit("/", 1)[-1] or "sharepoint_file", "classic")


def _cell_value(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:
        return str(v)


def records_to_columns_rows(records):
    """Flatten dict records into a rectangular column/row matrix."""
    flat = [r for r in (records or []) if isinstance(r, dict)]
    if not flat:
        return ["id"], [], {"count": 0}
    keys = []
    seen = set()
    for row in flat:
        for k in row.keys():
            sk = str(k)
            if sk not in seen:
                seen.add(sk)
                keys.append(sk)
    if not keys:
        keys = ["value"]
    out_rows = [[_cell_value(row.get(k)) for k in keys] for row in flat]
    return keys, out_rows, {"count": len(out_rows)}
