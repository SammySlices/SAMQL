"""WebHDFS connector core -- connect and browse over the WebHDFS REST API.

The HTTP client (:class:`WebHDFSClient`) is a faithful port of the original
desktop tool's HDFS tab: plain ``urllib`` against the WebHDFS REST API, an
optional ``user.name`` query parameter, and *no* Kerberos library -- a path
already known to work against the target cluster. :func:`parse_webhdfs_url`
normalises a pasted URL (a ``/webhdfs/v1`` mount, an ``explorer.html`` link, or
a bare ``host[:port]``) into a ``(base, start_path)`` pair, and
:func:`friendly_hdfs_error` turns transport errors into readable messages.

Browsing (LISTSTATUS) and streaming one file (OPEN) are all this layer does;
loading a browsed CSV is the session's job (stream to a temp file, then a
zero-copy DuckDB view). Stdlib only (``urllib``/``json``); the sole
intra-package import is the shared error formatter.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .errfmt import err_str

DEFAULT_TIMEOUT = 20


# --------------------------------------------------------------------------- #
# URL helpers                                                                 #
# --------------------------------------------------------------------------- #
def parse_webhdfs_url(url):
    """Normalise a pasted WebHDFS / HttpFS / explorer.html URL.

    Returns ``(base, path)`` where *base* ends at ``/webhdfs/v1`` and *path* is
    the in-HDFS path to start browsing from. Faithful port of the original
    tool's parser, plus a bare ``host[:port]`` fallback.
    """
    if not url or not url.strip():
        raise ValueError("URL is empty.")
    url = url.strip()

    # A NameNode "explorer" UI link: host + #fragment is the real HDFS path.
    if "/explorer.html" in url:
        if "#" in url:
            base_part, fragment = url.split("#", 1)
        else:
            base_part, fragment = url, "/"
        parsed = urllib.parse.urlparse(base_part)
        if not parsed.netloc:
            raise ValueError("Could not parse host from the URL.")
        scheme = parsed.scheme or "http"
        path = fragment or "/"
        if not path.startswith("/"):
            path = "/" + path
        return f"{scheme}://{parsed.netloc}/webhdfs/v1", path

    url = url.rstrip("/")
    marker = "/webhdfs/v1"
    idx = url.find(marker)
    if idx >= 0:
        base = url[: idx + len(marker)]
        path = url[idx + len(marker):] or "/"
        if not path.startswith("/"):
            path = "/" + path
        return base, path

    # Bare host[:port] (optionally with a path) -> assume the standard mount.
    parsed = urllib.parse.urlparse(url if "://" in url else "http://" + url)
    if not parsed.netloc:
        raise ValueError("Could not parse host from the URL.")
    scheme = parsed.scheme or "http"
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    return f"{scheme}://{parsed.netloc}/webhdfs/v1", path


class WebHDFSClient:
    """Minimal WebHDFS REST client over ``urllib``.

    *opener* is an injection seam for tests: a callable ``(request, timeout) ->
    response`` used in place of :func:`urllib.request.urlopen`. The response is
    used as a context manager and must expose ``.read()`` and ``.headers``.
    """

    def __init__(self, base_url, user=None, timeout=DEFAULT_TIMEOUT, opener=None):
        self.base_url = (base_url or "").rstrip("/")
        self.user = (user or "").strip()
        self.timeout = timeout
        self._opener = opener

    # -- url + transport ---------------------------------------------------- #
    def build_url(self, path, op, **extra):
        quoted = urllib.parse.quote(path or "/", safe="/")
        if not quoted.startswith("/"):
            quoted = "/" + quoted
        params = {"op": op}
        if self.user:
            params["user.name"] = self.user
        for k, v in extra.items():
            if v is not None:
                params[k] = v
        return f"{self.base_url}{quoted}?{urllib.parse.urlencode(params)}"

    def _urlopen(self, req):
        if self._opener is not None:
            return self._opener(req, self.timeout)
        return urllib.request.urlopen(req, timeout=self.timeout)

    def get_json(self, path, op, **extra):
        url = self.build_url(path, op, **extra)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with self._urlopen(req) as resp:
            ctype = resp.headers.get("Content-Type", "") or ""
            body = resp.read()
        text = body.decode("utf-8", errors="replace").lstrip()
        if text[:1] == "<" or "text/html" in ctype.lower():
            raise ValueError(
                "The server returned HTML, not JSON — the URL is probably the "
                "NameNode web UI rather than the WebHDFS REST API. Use a "
                "/webhdfs/v1/... URL.")
        return json.loads(text) if text else {}

    # -- operations --------------------------------------------------------- #
    def list_dir(self, path):
        """``LISTSTATUS`` -> list of FileStatus dicts (``pathSuffix``, ``type``,
        ``length``…). Returns ``[]`` for an empty or shape-unexpected reply."""
        data = self.get_json(path, "LISTSTATUS")
        try:
            return data["FileStatuses"]["FileStatus"]
        except (KeyError, TypeError):
            return []

    def open_stream(self, path, offset=None, length=None):
        """``OPEN`` the file, optionally a byte range.

        WebHDFS supports ``offset``/``length`` on OPEN, which is what makes a
        Parquet footer + column-chunk read possible without pulling the whole
        file. Returns the raw ``urlopen`` response for the caller to read in
        chunks. (CSV has no such structure, so the loader streams it whole.)
        """
        req = urllib.request.Request(
            self.build_url(path, "OPEN", offset=offset, length=length))
        return self._urlopen(req)


def friendly_hdfs_error(exc):
    """Map a transport error to a short, actionable message for the UI."""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return ("Access was denied by WebHDFS (HTTP %d). The endpoint "
                    "likely needs authentication this tool can't provide over "
                    "raw WebHDFS — a Knox/token gateway, or a 'user' value, may "
                    "be required." % exc.code)
        if exc.code == 404:
            return "That path was not found on HDFS (HTTP 404)."
        return "WebHDFS returned HTTP %d." % exc.code
    if isinstance(exc, urllib.error.URLError):
        return "Couldn't reach WebHDFS: %s" % (getattr(exc, "reason", exc),)
    return err_str(exc)
