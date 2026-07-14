"""SharePoint / Microsoft Graph helpers.

Supports:
  - list items (existing)
  - drive browse (folders + files)
  - drive file download (bytes + filename)

Auth is a bearer token from the secret store (never in workflow JSON).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .apiload import validate_outbound_http_url


def _headers(token, *, classic=False):
    h = {
        "Authorization": "Bearer " + token,
        "Accept": "application/json;odata=nometadata" if classic else "application/json",
        "User-Agent": "SamQL-SharePoint/1.0",
    }
    return h


def _http_json(url, token, timeout=60, classic=False):
    validate_outbound_http_url(url, purpose="SharePoint fetch")
    req = urllib.request.Request(url, headers=_headers(token, classic=classic), method="GET")
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


def _http_bytes(url, token, timeout=120):
    validate_outbound_http_url(url, purpose="SharePoint download")
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
            data = resp.read()
            name = None
            cd = resp.headers.get("Content-Disposition") or ""
            if "filename=" in cd:
                name = cd.split("filename=", 1)[1].strip().strip('"')
            return data, name, resp.geturl()
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


def fetch_sharepoint_items(site_url, list_title, bearer_token, timeout=60):
    """Return ``(records, meta)`` where records are dicts ready to flatten."""
    token = (bearer_token or "").strip()
    if not token:
        raise ValueError(
            "Add a SharePoint access token (saved secret) before fetching."
        )
    url = _graph_list_url(site_url, list_title)
    classic = "/_api/" in url
    records = []
    next_url = url
    pages = 0
    while next_url and pages < 50:
        pages += 1
        data, _ = _http_json(next_url, token, timeout=timeout, classic=classic)
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
    }
    return records, meta


def browse_drive(site_url, folder_path, bearer_token, timeout=60):
    """Browse drive folders/files. Returns rows as list-of-dicts + meta."""
    token = (bearer_token or "").strip()
    if not token:
        raise ValueError(
            "Add a SharePoint access token (saved secret) before browsing."
        )
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
        data, _ = _http_json(url, token, timeout=timeout, classic=True)
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
        }

    url = _graph_drive_children_url(site_url, folder_path)
    data, _ = _http_json(url, token, timeout=timeout)
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
    }


def download_drive_item(site_url, item_id, bearer_token, download_url=None,
                        timeout=120):
    """Download one drive item. Returns ``(bytes, filename, meta)``."""
    token = (bearer_token or "").strip()
    if not token:
        raise ValueError(
            "Add a SharePoint access token (saved secret) before downloading."
        )
    if download_url:
        data, name, final = _http_bytes(download_url, token, timeout=timeout)
        return data, name or "sharepoint_file", {
            "url": final, "item_id": item_id, "via": "downloadUrl",
        }

    item_id = (item_id or "").strip()
    if not item_id:
        raise ValueError("Pick a file id (or downloadUrl) to download.")
    _, host, _, _ = _site_parts(site_url)
    if "sharepoint.com" in host or host.endswith("sharepoint.us"):
        base = _graph_site_id_url(site_url)
        # Prefer content endpoint
        url = base + "/drive/items/%s/content" % urllib.parse.quote(item_id, safe="")
        data, name, final = _http_bytes(url, token, timeout=timeout)
        if not name:
            # Probe metadata for the name
            try:
                meta, _ = _http_json(
                    base + "/drive/items/%s" % urllib.parse.quote(item_id, safe=""),
                    token, timeout=30,
                )
                name = (meta or {}).get("name")
            except Exception:
                name = None
        return data, name or "sharepoint_file", {
            "url": final, "item_id": item_id, "via": "content",
        }

    # Classic: item_id may be a server-relative path
    site_url_c, _, _, _ = _site_parts(site_url)
    path = item_id if item_id.startswith("/") else "/" + item_id
    encoded = urllib.parse.quote(path, safe="/'")
    url = "%s/_api/web/GetFileByServerRelativeUrl('%s')/$value" % (
        site_url_c, encoded.replace("'", "''"),
    )
    data, name, final = _http_bytes(url, token, timeout=timeout)
    return data, name or path.rsplit("/", 1)[-1] or "sharepoint_file", {
        "url": final, "item_id": item_id, "via": "classic",
    }


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
