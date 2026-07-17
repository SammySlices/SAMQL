#!/usr/bin/env python3
"""SamQL local server.

A dependency-free (stdlib-only) HTTP server that exposes the headless
:class:`samql_core.Session` as a small JSON API and serves the built
React frontend as static files. Designed to be friendly to PyInstaller:
nothing here imports a third-party package at module load.

Run it directly::

    python server.py                # serve + open a window/browser
    python server.py --port 8765    # pick a port
    python server.py --no-browser   # just serve (headless)

When frozen by PyInstaller the bundled ``frontend/dist`` is located via
``sys._MEIPASS``; in a source checkout it is found next to this file.
"""
from __future__ import annotations

import argparse
import atexit
import hmac
import json
import mimetypes
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# Make ``samql_core`` importable whether we run from source or frozen.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


# ---- single instance -------------------------------------------------------
# These run *before* the heavy data-engine import below, so a second launch can
# surface the already-running copy and exit fast instead of paying the import.
def _build_arg_parser():
    ap = argparse.ArgumentParser(description="SamQL local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true",
                    help="Serve headlessly; do not open a window/browser.")
    ap.add_argument("--browser", action="store_true",
                    help="Force opening the system browser (no pywebview).")
    ap.add_argument("--window", action="store_true",
                    help="Force a native pywebview window.")
    return ap


def _ui_mode(args):
    if args.no_browser:
        return "none"
    if args.browser:
        return "browser"
    if args.window:
        return "window"
    return "auto"


def _probe_existing(host, port, timeout=0.6):
    """True if a SamQL instance is already serving on host:port (identified by
    the /api/health 'app' marker, so we don't mistake some other server)."""
    import urllib.request as _r
    import json as _j
    try:
        # .509: bypass any system proxy -- it can hijack even localhost on a
        # managed box, making a RUNNING instance look absent (double starts).
        _op = _r.build_opener(_r.ProxyHandler({}))
        with _op.open("http://%s:%s/api/health" % (host, port),
                        timeout=timeout) as resp:
            data = _j.loads(resp.read().decode("utf-8", "replace") or "{}")
        return str(data.get("app", "")).lower() == "samql"
    except Exception:
        return False


def _ask_focus(host, port, timeout=2.0):
    """Ask a running instance to bring its native window forward. Returns True
    only if it reports a window was surfaced."""
    import urllib.request as _r
    import json as _j
    try:
        rq = _r.Request("http://%s:%s/api/focus" % (host, port), data=b"{}",
                        method="POST",
                        headers={"Content-Type": "application/json"})
        with _r.build_opener(_r.ProxyHandler({})).open(
                rq, timeout=timeout) as resp:
            data = _j.loads(resp.read().decode("utf-8", "replace") or "{}")
        return bool(data.get("focused"))
    except Exception:
        return False


def _maybe_attach_to_running():
    """If SamQL is already running on the requested port, surface that instance
    (raise its window, or open a browser to it) and exit -- so double-clicking
    the exe never starts a second server. No-op when serving headlessly.

    Arg parsing here also means --help / bad args exit instantly, before the
    slow data-engine import below."""
    args, _ = _build_arg_parser().parse_known_args()
    mode = _ui_mode(args)
    if mode == "none":
        return
    if not _probe_existing(args.host, args.port):
        return
    url = "http://%s:%s/" % (args.host, args.port)
    focused = False
    if mode == "window":
        focused = _ask_focus(args.host, args.port)
    if not focused:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    print("\n  SamQL is already running at %s -- bringing it to the front.\n"
          % url, flush=True)
    raise SystemExit(0)


# ---- early startup feedback -----------------------------------------------
class _BootBar:
    """A tiny in-place 'loading' animation for the terminal during startup.
    Animates only when stdout is a real terminal; otherwise it just prints
    each phase on its own line so piped logs stay readable."""

    def __init__(self):
        self._stop = threading.Event()
        self._label = "loading"
        self._thread = None
        try:
            self._tty = bool(sys.stdout.isatty())
        except Exception:
            self._tty = False

    def start(self):
        if not self._tty:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def set(self, label):
        self._label = label
        if not self._tty:
            print(f"    - {label}", flush=True)

    def _run(self):
        width, block, pos, step = 24, 6, 0, 1
        while not self._stop.is_set():
            cells = [" "] * width
            for i in range(block):
                if 0 <= pos + i < width:
                    cells[pos + i] = "="
            sys.stdout.write("\r    [" + "".join(cells) + "]  "
                             + self._label.ljust(34))
            sys.stdout.flush()
            pos += step
            if pos <= 0 or pos + block >= width:
                step = -step
                pos = max(0, min(pos, width - block))
            time.sleep(0.07)

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=0.5)
        if self._tty:
            sys.stdout.write("\r" + " " * 68 + "\r")
            sys.stdout.flush()


_BANNER = """
    ____                         ___    _      
   / ___|    __ _   _ __ ___    / _ \\  | |     
   \\___ \\   / _` | | '_ ` _ \\  | | | | | |     
    ___) | | (_| | | | | | | | | |_| | | |___  
   |____/   \\__,_| |_| |_| |_|  \\__\\_\\ |_____| 

        +----------------------+
        |    _____   ____      |
        |   |_   _| |  _ \\     |
        |     | |   | | | |    |
        |     | |   | |_| |    |
        |     |_|   |____/     |
        +----------------------+
"""

_BOOT_BAR = None

# Greet + start the loading bar the instant the process starts. The import just
# below pulls in the data engine (DuckDB), which can take a couple of seconds on
# first launch; without this the user stares at a blank, blinking terminal.
if __name__ == "__main__":
    # Greet immediately, then -- before the slow data-engine import -- surface
    # an already-running copy and exit, so a second double-click doesn't spin
    # up another server. The console stays open for status output and Ctrl+C.
    print(_BANNER, flush=True)
    _maybe_attach_to_running()
    _BOOT_BAR = _BootBar()
    _BOOT_BAR.set("loading data engine — first start takes a few seconds")
    _BOOT_BAR.start()

from samql_core import Session, __version__, BUILD  # noqa: E402
from samql_core import filecache
from samql_core import tmputil  # noqa: E402
from samql_core import _brand  # noqa: E402  (app icon / favicon / manifest)
from samql_core.errfmt import err_str  # noqa: E402
from samql_core.loaders import LoadCancelled  # noqa: E402

# Optional faster JSON encoder; falls back to the stdlib transparently.
try:
    import orjson as _orjson  # type: ignore
except Exception:
    _orjson = None


def _fail_job(job, msg):
    """Mark a background-job dict as failed with ``msg`` (the
    state/error pair set together at every job failure site).

    Also records the failure in the Settings error log once per job so load /
    flatten / optimize failures are inspectable after the toast fades.
    """
    job["state"] = "error"
    job["error"] = msg
    try:
        jid = str(job.get("id") or "")
        if not jid or job.get("_error_logged"):
            return
        job["_error_logged"] = True
        kind = str(job.get("kind") or "job")
        name = str(job.get("name") or "")
        detail_bits = []
        if name:
            detail_bits.append("name=%s" % name)
        if job.get("engine"):
            detail_bits.append("engine=%s" % job.get("engine"))
        if job.get("stage"):
            detail_bits.append("stage=%s" % job.get("stage"))
        log_server_error(
            "JOB",
            "/job/%s/%s" % (kind, jid),
            400,
            "%sError" % "".join(p.title() for p in kind.replace("-", "_").split("_")),
            str(msg),
            detail="; ".join(detail_bits),
        )
    except Exception:
        pass


def _log_soft_result_error(method, path, result, body, ctx):
    """Record HTTP-200 payloads that still carry an application error.

    Query, load, flatten, shred, reconcile and NodeFlow handlers often return
    ``{error: "..."}`` (sometimes with a traceback) instead of raising. Those
    used to vanish from the Settings error log.
    """
    if not isinstance(result, dict):
        return
    err = result.get("error")
    if not isinstance(err, str) or not err.strip():
        return
    if result.get("cancelled") or result.get("state") == "cancelled":
        return
    path = path or ""
    interesting = (
        path.startswith("/api/query")
        or path.startswith("/api/nodeflow/")
        or path.startswith("/api/load/")
        or path.startswith("/api/flatten")
        or path.startswith("/api/shred")
        or path.startswith("/api/reconcile")
        or path.startswith("/api/export")
        or path.startswith("/api/optimize")
    )
    if not interesting:
        return
    # Progress polls only matter once the job has failed (or a sync call
    # returned an error without a state field).
    if "/progress/" in path:
        if result.get("state") != "error":
            return
        jid = str(result.get("id") or "")
        if jid:
            # Prefer the one-shot _fail_job path; skip duplicate poll noise.
            job = JOBS.get(jid)
            if job and job.get("_error_logged"):
                return
    kind = "AppError"
    if path.startswith("/api/query"):
        kind = "QueryError"
    elif path.startswith("/api/load"):
        kind = "LoadError"
    elif path.startswith("/api/flatten") or path.startswith("/api/shred"):
        kind = "FlattenError"
    elif path.startswith("/api/nodeflow"):
        kind = "NodeFlowError"
    elif path.startswith("/api/reconcile"):
        kind = "ReconcileError"
    elif path.startswith("/api/export"):
        kind = "ExportError"
    elif path.startswith("/api/optimize"):
        kind = "OptimizeError"
    tb = result.get("traceback") if isinstance(result.get("traceback"), str) else ""
    detail = _request_detail(body, ctx)
    # Prefer richer server-side detail when present.
    for key in ("detail", "message", "hint", "sqlstate"):
        extra = result.get(key)
        if isinstance(extra, str) and extra.strip() and extra.strip() != err.strip():
            detail = (detail + "; " if detail else "") + "%s=%s" % (key, extra[:400])
            break
    log_server_error(method, path, 400, kind, err.strip(), tb=tb or "",
                     detail=detail)


def _request_detail(body, ctx):
    """A short, size-capped summary of the request, useful for debugging
    without dumping huge payloads. Prefers a SQL string / node-flow target /
    load path if present, else the body's top-level keys."""
    try:
        if isinstance(body, dict):
            for k in ("sql", "expression", "condition"):
                if isinstance(body.get(k), str) and body[k].strip():
                    return "%s=%s" % (k, body[k][:400])
            bits = []
            for k in ("path", "json_path", "table", "engine", "target",
                      "out_dir", "output_dir", "base_name", "node", "node_id",
                      "port", "job_id"):
                v = body.get(k)
                if isinstance(v, str) and v.strip():
                    bits.append("%s=%s" % (k, v.strip()[:200]))
                elif isinstance(v, (int, float, bool)):
                    bits.append("%s=%s" % (k, v))
            files = body.get("files")
            if isinstance(files, list) and files:
                bits.append("files=%d" % len(files))
            if bits:
                return "; ".join(bits)[:400]
            keys = ", ".join(sorted(body.keys()))[:200]
            return "keys: " + keys if keys else ""
        if ctx and ctx.get("fields"):
            return "fields: " + ", ".join(sorted(ctx["fields"].keys()))[:200]
        files = (ctx or {}).get("files") or []
        if files:
            names = [getattr(f, "filename", None) or getattr(f, "name", "") or "?"
                     for f in files[:5]]
            return "upload=%s" % ", ".join(str(n) for n in names)[:400]
    except Exception:
        pass
    return ""


def _task_card(j):
    """Normalize a background-job record into the activity-tray card shape.

    Keeps a coarse state (queued / running / done / error / cancelled) plus the
    job's finer phase, and picks an *honest* progress mode: bytes when the total
    size is known, a step count for iterator passes, otherwise an indeterminate
    spinner (e.g. the atomic Parquet COPY -- never a faked percentage). The X on
    a card cancels through the job's existing per-kind cancel route, so this is
    purely a read view."""
    st = j.get("state")
    state = st if st in ("done", "error", "cancelled", "queued") else "running"
    total = j.get("bytes_total") or 0
    done = j.get("bytes_done") or 0
    kind = j.get("kind") or "load"
    if kind == "iterator":
        mode = "steps"
    elif total > 0 and done > 0:
        # a determinate bar only once bytes actually advance; an atomic engine
        # read (e.g. a DuckDB CREATE TABLE AS read_csv) reports no incremental
        # byte progress, so show a live spinner rather than a bar frozen at 0%.
        mode = "bytes"
    else:
        mode = "spinner"
    return {
        "id": j.get("id"),
        "kind": kind,
        "title": j.get("name") or "",
        "state": state,
        "phase": st,
        "progress": {"mode": mode,
                     "done": done,
                     "total": total},
        "rows": j.get("rows"),
        "note": j.get("note"),
        "error": j.get("error"),
        "engine": j.get("engine"),
        # Flatten outcome (drives the "how it ran" notification): which path
        # produced the tables -- "duckdb-unnest" (fast, in-engine SQL) vs
        # "python" (the dump + Python-flatten fallback) -- and the key column
        # used to link child tables. Present only on a finished flatten job.
        "method": j.get("method"),
        "key": j.get("key"),
        "loaded": j.get("loaded"),
        "cancellable": state in ("queued", "running"),
        "started": j.get("started"),
    }


def _encode_json(payload) -> bytes:
    if _orjson is not None:
        try:
            return _orjson.dumps(payload, default=str)
        except Exception:
            pass
    return json.dumps(payload, default=str).encode("utf-8")


def _compressible(content_type: str) -> bool:
    c = (content_type or "").lower()
    return (
        "json" in c
        or c.startswith("text/")
        or "javascript" in c
        or "svg" in c
        or "xml" in c
    )


# --------------------------------------------------------------------- #
# Static asset resolution (works in source tree and under PyInstaller)
# --------------------------------------------------------------------- #
def _frontend_dir():
    candidates = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        # .467: a frontend_dist folder NEXT TO the executable wins over
        # the frozen bundle, so branding (or a hotfixed UI) can be
        # swapped by dropping files beside SamQL(dot)exe -- no
        # PyInstaller rebuild. Absent, the frozen copy serves as ever.
        try:
            adj = os.path.join(
                os.path.dirname(sys.executable), "frontend_dist")
            # .469: only a REAL dist (it has index.html) may take over
            # the UI -- a folder holding just icons (the 5c.3 flow)
            # must not blank the app. Brand lookups probe it
            # separately below, so icon-only overrides still work.
            if os.path.isfile(os.path.join(adj, "index.html")):
                candidates.append(adj)
        except Exception:
            pass
        candidates.append(os.path.join(base, "frontend_dist"))
        candidates.append(os.path.join(base, "frontend", "dist"))
    candidates.append(os.path.join(_HERE, "..", "frontend", "dist"))
    candidates.append(os.path.join(_HERE, "frontend_dist"))
    candidates.append(os.path.join(_HERE, "static"))
    for c in candidates:
        # Require a real Vite build (index.html). An empty directory used
        # to win the probe and then 404 every route -- or, when PyInstaller
        # omitted an empty tree, fall through to the placeholder page.
        if c and os.path.isdir(c) and os.path.isfile(os.path.join(c, "index.html")):
            return os.path.abspath(c)
    return None


_FRONTEND_DIR = _frontend_dir()


def _frontend_dir_live():
    """.547: the reattach 'Not found' fix. _FRONTEND_DIR was resolved
    ONCE at import from sys._MEIPASS. A persisting server (window closed,
    backend kept alive per .534) can outlive the launcher that spawned
    it; a later launch's _MEI sweep (.544/.545) can then delete THAT
    extraction, leaving the cached frontend path dangling -> every page
    404'd as 'Not found'. So re-verify on use and re-resolve if the
    cached dir disappeared. Cheap: an isdir() stat on the hot path, a
    full re-resolve only after the rare vanish.

    Note: a sticky override may be brand-only (app-icon.png, no
    index.html) for tests / exe-adjacent icon drops -- do not drop it
    just because the SPA shell is absent. Discovery via ``_frontend_dir``
    still requires index.html so empty trees never win the UI probe.
    """
    global _FRONTEND_DIR
    d = _FRONTEND_DIR
    if d and os.path.isdir(d):
        return d
    d2 = _frontend_dir()
    if d2:
        _FRONTEND_DIR = d2
    else:
        _FRONTEND_DIR = None
    return d2

_PNG_ICO_CACHE = {}


_WEBVIEW_CACHE_NAMES = {"Cache", "Code Cache", "GPUCache",
                        "ShaderCache", "GrShaderCache",
                        "DawnGraphiteCache", "DawnWebGPUCache",
                        "CacheStorage"}


def _webview_profile_dir():
    """.527: the native window's Chromium profile (see the launcher's
    _webview_storage_path -- same computation, no import)."""
    base = (os.environ.get("LOCALAPPDATA")
            or os.environ.get("APPDATA")
            or os.path.expanduser("~"))
    return os.path.join(base, "SamQL", "webview")


def _webview_cache_walk(base=None):
    """Yield every FILE that lives under a Chromium cache-class directory
    of the webview profile (never cookies / Local Storage / IndexedDB --
    those are the user's state)."""
    root = base or _webview_profile_dir()
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        if os.path.basename(dirpath) in _WEBVIEW_CACHE_NAMES:
            for f in filenames:
                yield os.path.join(dirpath, f)
            dirnames[:] = []


def _webview_cache_bytes(base=None):
    total = 0
    for f in _webview_cache_walk(base):
        try:
            total += os.path.getsize(f)
        except OSError:
            pass
    return total


def _clear_webview_cache(base=None):
    """Best-effort per-file delete inside the cache-class dirs; a live
    window keeps some files locked -- those stay and clear next time.
    Returns (freed_bytes, locked_count)."""
    freed, locked = 0, 0
    for f in _webview_cache_walk(base):
        try:
            sz = os.path.getsize(f)
            os.unlink(f)
            freed += sz
        except OSError:
            locked += 1
    return freed, locked


def _authoritative_ico():
    """.526: the ONE true window/taskbar mark. Resolution order: the icon
    bundled INTO this exe (_MEIPASS), one next to the exe/backend, the
    repo root SamQL.ico (Sam's source of truth), then None (the caller
    can fall back to the served favicon). This is deliberately NOT the
    web favicon: a stale frontend_dist/favicon.ico must never become the
    taskbar art again."""
    cands = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        cands += [os.path.join(base, "samql.ico"),
                  os.path.join(base, "SamQL.ico")]
    here = os.path.dirname(os.path.abspath(__file__))
    cands += [os.path.join(here, "samql.ico"),
              os.path.join(os.path.dirname(sys.executable or here),
                           "samql.ico")]
    root = os.path.dirname(here)
    cands += [os.path.join(root, "SamQL.ico"),
              os.path.join(root, "samql.ico")]
    for c in cands:
        try:
            if c and os.path.isfile(c):
                return c
        except Exception:
            continue
    return None


def _brand_lookup(basename):
    """Where does a brand image come from? Ladder, strongest first:
    a file in the exe-adjacent frontend_dist (frozen only -- the 5c.3
    no-rebuild override), then a file in the served frontend build.
    Returns (filepath, source) or (None, None)."""
    dirs = []
    if getattr(sys, "_MEIPASS", None):
        try:
            dirs.append((os.path.join(os.path.dirname(sys.executable),
                                      "frontend_dist"),
                         "exe-adjacent"))
        except Exception:
            pass
    live_frontend = _frontend_dir_live()
    if live_frontend:
        dirs.append((live_frontend, "bundled"))
    for d, tag in dirs:
        f = os.path.join(d, basename)
        if os.path.isfile(f):
            return f, tag
    return None, None


def _png_to_ico_cached(png_path):
    """Wrap a PNG file into a one-entry .ico (PNG payload). Windows
    scales the single image for small slots; a hand-tuned multi-size
    ico shipped as favicon.ico still wins outright. Cached per
    (path, mtime, size) so the per-request cost is a stat."""
    try:
        st = os.stat(png_path)
        key = (png_path, st.st_mtime_ns, st.st_size)
        hit = _PNG_ICO_CACHE.get(png_path)
        if hit and hit[0] == key:
            return hit[1]
        with open(png_path, "rb") as fh:
            png = fh.read()
        if png[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        import struct as _st2
        w, h = _st2.unpack(">II", png[16:24])
        wb = 0 if w >= 256 else min(w, 255)
        hb = 0 if h >= 256 else min(h, 255)
        ico = (_st2.pack("<HHH", 0, 1, 1)
               + _st2.pack("<BBBBHHII", wb, hb, 0, 0, 1, 32,
                           len(png), 22)
               + png)
        _PNG_ICO_CACHE[png_path] = (key, ico)
        return ico
    except Exception:
        return None

def _favicon_ico_bytes():
    """Resolve the exact favicon bytes and source tag used by the server.

    Keep this in one helper so live serving, launchers and regression tests all
    agree when a user supplies ``favicon.ico`` or only a PNG. Malformed custom
    icon files are ignored instead of replacing the known-good embedded mark.
    """
    bundled, src_tag = _brand_lookup("favicon.ico")
    if bundled:
        try:
            with open(bundled, "rb") as fh:
                data = fh.read()
            if data[:4] == b"\x00\x00\x01\x00":
                return data, "%s favicon.ico" % src_tag
        except OSError:
            pass
    for src_png in ("app-icon.png", "logo.png"):
        png, ptag = _brand_lookup(src_png)
        if png:
            data = _png_to_ico_cached(png)
            if data and data[:4] == b"\x00\x00\x01\x00":
                return data, "derived from %s %s" % (ptag, src_png)
    return _brand.app_ico(), "embedded"


# A friendly placeholder shown when the frontend has not been built yet.
_PLACEHOLDER_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SamQL - backend running</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:16px/1.6 system-ui,Segoe UI,Roboto,sans-serif;
         background:#16181c; color:#e7e9ee;
         display:flex; min-height:100vh; align-items:center;
         justify-content:center; }
  .card { max-width:680px; padding:40px; }
  h1 { color:#54b949; margin:0 0 8px; font-size:28px; }
  code { background:#23262d; padding:2px 7px; border-radius:6px;
         color:#9ad; font-size:14px; }
  .ok { color:#54b949; } .muted { color:#9aa3b2; }
  ol { padding-left:22px; } li { margin:6px 0; }
  a { color:#54b949; }
</style></head><body><div class="card">
<h1>SamQL</h1>
<p class="ok">&#10003; The Python backend is running and healthy.</p>
<p class="muted">The React frontend has not been built yet. To build it:</p>
<ol>
  <li><code>cd frontend</code></li>
  <li><code>npm install</code></li>
  <li><code>npm run build</code></li>
  <li>Reload this page.</li>
</ol>
<p class="muted">During development you can instead run
<code>npm run dev</code> in <code>frontend/</code> and open the Vite URL
&mdash; it proxies <code>/api</code> here automatically.</p>
<p class="muted">API health check:
<a href="/api/health">/api/health</a></p>
</div></body></html>"""


# --------------------------------------------------------------------- #
# Minimal multipart/form-data parser (stdlib `cgi` is deprecated/removed)
# --------------------------------------------------------------------- #
class _SpooledPart:
    """A streamed file part: the bytes live in a temp FILE, never in RAM.
    ``path`` is under the instance temp dir (swept on shutdown); ``data`` is
    a compatibility property for small consumers -- big paths should move or
    read the file, not touch it."""

    __slots__ = ("name", "filename", "content_type", "path", "size")

    def __init__(self, name, filename, content_type, path, size):
        self.name = name
        self.filename = filename
        self.content_type = content_type
        self.path = path
        self.size = size

    @property
    def data(self):
        with open(self.path, "rb") as f:
            return f.read()


def stream_multipart(stream, content_type, total, chunk=65536,
                     field_cap=1_000_000):
    """Parse multipart/form-data from ``stream`` WITHOUT buffering the body
    (audit 2026-07-02 B, wave 2): file parts spool straight to temp files,
    so a multi-GB drag-drop costs disk, not RAM. Field values stay in memory
    (capped). Returns (fields: dict, files: list[_SpooledPart]).

    Raises ValueError on a malformed/truncated body -- the dispatcher turns
    that into a clean 400."""
    from samql_core import tmputil
    m = re.search(r"boundary=([^;]+)", content_type or "", re.IGNORECASE)
    if not m:
        raise ValueError("multipart boundary is missing")
    raw_boundary = m.group(1).strip().strip('"')
    if (not raw_boundary or len(raw_boundary) > 200
            or "\r" in raw_boundary or "\n" in raw_boundary):
        raise ValueError("multipart boundary is invalid")
    try:
        boundary = raw_boundary.encode("latin-1")
    except UnicodeEncodeError:
        raise ValueError("multipart boundary is invalid")
    first = b"--" + boundary
    marker = b"\r\n--" + boundary           # separates a part from the next
    remaining = [int(total or 0)]

    def more(n):
        if remaining[0] <= 0:
            return b""
        data = stream.read(min(n, remaining[0]))
        remaining[0] -= len(data)
        return data

    buf = bytearray()

    def fill(n):
        while len(buf) < n:
            data = more(chunk)
            if not data:
                return False
            buf.extend(data)
        return True

    # seek the FIRST boundary (no leading CRLF at body start)
    while True:
        i = bytes(buf).find(first)
        if i >= 0:
            del buf[:i + len(first)]
            break
        if len(buf) > len(first):
            del buf[:len(buf) - len(first)]
        if not fill(len(buf) + 1):
            raise ValueError("multipart body has no boundary")
    fields, files, spooled = {}, [], []
    try:
        while True:
            if not fill(2):
                raise ValueError("truncated multipart body")
            if bytes(buf[:2]) == b"--":
                break                       # closing boundary: all done
            if bytes(buf[:2]) == b"\r\n":
                del buf[:2]
            # headers (small; hard cap so garbage can't balloon the buffer)
            while True:
                j = bytes(buf).find(b"\r\n\r\n")
                if j >= 0:
                    break
                if len(buf) > 65536 or not fill(len(buf) + 1):
                    raise ValueError("malformed multipart headers")
            head = bytes(buf[:j]).decode("latin-1", "replace")
            del buf[:j + 4]
            disp, ctype = "", "application/octet-stream"
            for line in head.splitlines():
                low = line.lower()
                if low.startswith("content-disposition:"):
                    disp = line
                elif low.startswith("content-type:"):
                    ctype = line.split(":", 1)[1].strip()
            name = _disp_param(disp, "name")
            filename = _disp_param(disp, "filename")
            if not disp or name is None:
                raise ValueError("multipart part is missing a form-data name")
            sink = None
            path = None
            size = 0
            small = bytearray()
            if filename is not None:
                suffix = os.path.splitext(filename or "")[1] or ".dat"
                path = tmputil.new_tempfile("up_", suffix)
                sink = open(path, "wb")
                # track the HANDLE too: Windows refuses to unlink an open
                # file, so failure cleanup must close before it deletes
                spooled.append((sink, path))

            def emit(b):
                nonlocal size
                if not b:
                    return
                size += len(b)
                if sink is not None:
                    sink.write(b)
                else:
                    if size > field_cap:
                        raise ValueError("multipart field is too large")
                    small.extend(b)
            # stream the content until the next boundary marker
            while True:
                k = bytes(buf).find(marker)
                if k >= 0:
                    emit(bytes(buf[:k]))
                    del buf[:k + len(marker)]
                    break
                keep = len(marker) - 1
                if len(buf) > keep:
                    emit(bytes(buf[:len(buf) - keep]))
                    del buf[:len(buf) - keep]
                if not fill(len(buf) + 1):
                    raise ValueError("truncated multipart body")
            if sink is not None:
                sink.close()
                files.append(_SpooledPart(name or "file", filename, ctype,
                                          path, size))
            elif name is not None:
                fields[name] = bytes(small).decode("utf-8", "replace")
    except Exception:
        _close_and_unlink(spooled)
        raise
    return fields, files


def _close_and_unlink(spooled):
    """Failure cleanup for streamed uploads: CLOSE first, then unlink.
    Order matters on Windows, which refuses to delete an open file --
    unlink-while-open only ever worked on posix."""
    for sink, p in spooled:
        try:
            if sink is not None and not sink.closed:
                sink.close()
        except Exception:
            pass
        try:
            os.unlink(p)
        except OSError:
            pass


def _upload_cap_bytes():
    """Drag-drop ceiling (SAMQL_UPLOAD_MB / Load thresholds). Uploads stream
    to disk, but a finite default still prevents an unauthenticated or
    accidental request from filling the drive. Default 16 GiB so multi-GB
    CSVs can drag-drop; set 0 to disable. Prefer Load-by-path for the
    largest files."""
    try:
        from samql_core import load_thresholds as LT
        mb = int(LT.get_int("upload_mb"))
    except Exception:
        mb = 16384
    return max(0, mb) * 1024 * 1024


def _json_body_cap_bytes():
    """Maximum ordinary JSON request size (SAMQL_JSON_BODY_MB).

    JSON bodies are buffered before parsing, unlike streamed multipart
    uploads, so keep a conservative finite default. Set 0 explicitly to
    disable the limit for a trusted local workflow.
    """
    try:
        mb = int(os.environ.get("SAMQL_JSON_BODY_MB", "32"))
    except Exception:
        mb = 32
    return max(0, mb) * 1024 * 1024


def _new_api_token():
    configured = (os.environ.get("SAMQL_API_TOKEN") or "").strip()
    if configured:
        return configured
    return secrets.token_urlsafe(32)


def _token_meta(token):
    # token_urlsafe/configured tokens are header values; escape the only
    # characters that could break an HTML attribute when an admin supplies one.
    return (str(token).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _api_token_set_cookie(token):
    """HttpOnly cookie carries the capability; it must not appear in HTML."""
    return ("samql_api_token=%s; Path=/; HttpOnly; SameSite=Strict"
            % str(token))


def _token_from_cookie_header(header):
    raw = str(header or "")
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "samql_api_token" and value:
            return value
    return ""


def _inject_api_token_html(data, token):
    """Deprecated no-op: capability is delivered via HttpOnly cookie only.

    Kept as a named hook so older call sites and contract greps stay stable
    while the HTML shell no longer embeds the secret.
    """
    return data


def _env_truthy(name):
    return (os.environ.get(name) or "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _is_loopback_host(host):
    h = (host or "").strip().lower()
    return h in ("127.0.0.1", "localhost", "::1", "") or h.startswith("127.")


def _unlink_with_retry(path, attempts=8, base_delay=0.025):
    """Remove a temporary file despite short-lived Windows AV/EDR locks.

    Corporate endpoint scanners commonly open a newly-created upload spool for
    a few milliseconds.  A single best-effort ``unlink`` therefore leaks files
    even though the request is already finished.  Retry with a small bounded
    backoff; missing files are success, and a final failure is surfaced in the
    server error log instead of being silently swallowed.
    """
    if not path:
        return True
    last = None
    for i in range(max(1, int(attempts))):
        try:
            os.unlink(path)
            return True
        except FileNotFoundError:
            return True
        except OSError as e:
            last = e
            if i + 1 < attempts:
                time.sleep(base_delay * (i + 1))
    try:
        log_server_error("CLEANUP", path, 500, "TempCleanup", err_str(last))
    except Exception:
        pass
    return False


def _cleanup_uploaded_parts(parts):
    """Remove multipart spool files the route did not take ownership of.

    Successful load handlers move each path with ``os.replace``; unlinking the
    old path is then a harmless no-op. Keeping this at the dispatcher boundary
    also covers unknown routes, wrong methods and handler exceptions. Cleanup
    is completed before an unmatched-route response is returned, and retries
    absorb the short file locks created by Windows antivirus products.
    """
    ok = True
    for part in parts or ():
        path = getattr(part, "path", None)
        if path and not _unlink_with_retry(path):
            ok = False
    return ok


def _shred_note(job, loaded):
    """Surface flatten-toggle output on the job -- ALL branches (.423).
    Success was the only surfaced outcome; errors, "nothing to shred"
    notes, and cancels were stamped on items and shown NOWHERE -- the
    on-box "still not flattening!!" with the reason swallowed."""
    try:
        items = [t for t in (loaded or []) if isinstance(t, dict)]
        err = next((t["shred_error"] for t in items
                    if t.get("shred_error")), None)
        if err:
            job["note"] = "flatten failed: %s" % err
            # .425: a flatten failure also lands in the Error Dashboard
            # (the .409 store), not just the card -- same visibility as
            # any server error, with the table named.
            tname = next((t.get("name") for t in items
                          if t.get("shred_error")), "")
            log_server_error("JOB", "/load/flatten", 500, "flatten",
                             err, detail="table %s" % tname)
            return
        if any(t.get("shred_cancelled") for t in items):
            job["note"] = "flatten cancelled (tables so far kept)"
            return
        _st = next((t["root_id_stats"] for t in items
                    if t.get("root_id_stats")), None)
        if _st:
            job["root_id_stats"] = _st
        n = sum(len(t.get("shredded") or []) for t in items)
        if n:
            job["note"] = "+%d relational table%s" % (n, "" if n == 1 else "s")
            if _st:
                if _st.get("duplicated"):
                    job["note"] += (" -- root_id NOT unique: %s records, "
                                    "%s distinct (%s duplicated)"
                                    % (_st["records"], _st["distinct"],
                                       _st["duplicated"]))
                else:
                    job["note"] += (" -- root_id unique (%s distinct)"
                                    % _st["distinct"])
            return
        note = next((t["shred_note"] for t in items
                     if t.get("shred_note")), None)
        if note:
            job["note"] = "flatten: %s" % note
        elif job.get("shred"):
            job["note"] = ("flatten requested but no DuckDB table came "
                           "back eligible")
    except Exception:
        pass


def _disp_param(disposition: str, key: str):
    m = re.search(key + r'="([^"]*)"', disposition)
    if m:
        return m.group(1)
    m = re.search(key + r"=([^;]+)", disposition)
    if m:
        return m.group(1).strip()
    return None


# --------------------------------------------------------------------- #
# Response helpers
# --------------------------------------------------------------------- #
class FileDownload:
    """Marker return value: stream a file back as an attachment."""

    def __init__(self, path, filename, content_type="application/octet-stream",
                 cleanup=True):
        self.path = path
        self.filename = filename
        self.content_type = content_type
        self.cleanup = cleanup


def _reqdict(body, key, what=None):
    """.454 fuzz fix: a REQUIRED OBJECT field (a graph, a spec) or a
    400 -- string/None graphs were reaching .get() and 500ing."""
    v = (body or {}).get(key)
    if not isinstance(v, dict):
        raise ApiError(400, "%s is required and must be an object."
                       % (what or key))
    return v


def _reqstr(body, key, what=None):
    """.442 fuzz fix: pull a REQUIRED STRING field or raise a 400 --
    missing/None/wrong-typed fields were reaching str methods and
    500ing as AttributeError/TypeError."""
    v = (body or {}).get(key)
    if not isinstance(v, str) or not v.strip():
        raise ApiError(400, "%s is required and must be a string."
                       % (what or key))
    return v


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------- #
# Error log: a process-wide ring buffer of recent server-side failures so the
# UI can surface a debuggable history (and the user can export it). Capped so
# it can never grow without bound. Unexpected errors carry a full traceback;
# handled ApiErrors carry their status + message.
# --------------------------------------------------------------------- #
_ERROR_LOG = []
_ERROR_LOG_LOCK = threading.Lock()
_ERROR_LOG_MAX = 300
_ERROR_SEQ = [0]


def log_server_error(method, path, status, kind, error, tb="", detail=""):
    try:
        with _ERROR_LOG_LOCK:
            _ERROR_SEQ[0] += 1
            _ERROR_LOG.append({
                "id": _ERROR_SEQ[0],
                "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                "epoch": time.time(),
                "method": method,
                "path": path,
                "status": status,
                "kind": kind,
                "error": error,
                "traceback": tb or "",
                "detail": detail or "",
            })
            if len(_ERROR_LOG) > _ERROR_LOG_MAX:
                del _ERROR_LOG[:len(_ERROR_LOG) - _ERROR_LOG_MAX]
    except Exception:
        pass  # logging must never itself break a request
    _append_error_file(method, path, status, kind, error, tb)


def _error_file_path():
    return os.path.join(tmputil.instance_dir(), "error.log")


def _launcher_log_path():
    return os.path.join(tmputil._ROOT, "launcher.log")


def _append_error_file(method, path, status, kind, error, tb=""):
    """The on-disk twin of the in-memory ring (.409): survives restarts,
    lives in the samql temp tree, bounded to ~512 KB (trimmed to the
    last 256 KB on a line boundary). Never allowed to break a request."""
    try:
        fp = _error_file_path()
        line = "%s [%s] %s %s -> %s: %s\n" % (
            time.strftime("%Y-%m-%d %H:%M:%S"), kind, method, path,
            status, error)
        if tb:
            line += "".join("    | " + t + "\n"
                            for t in tb.rstrip().split("\n"))
        with open(fp, "a", encoding="utf-8", errors="replace") as f:
            f.write(line)
        if os.path.getsize(fp) > 512 * 1024:
            with open(fp, "rb") as f:
                f.seek(-256 * 1024, os.SEEK_END)
                keep = f.read()
            nl = keep.find(b"\n")
            if nl >= 0:
                keep = keep[nl + 1:]
            with open(fp, "wb") as f:
                f.write(keep)
    except Exception:
        pass


def _tail_text(path, max_bytes=64 * 1024):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(-max_bytes, os.SEEK_END)
            raw = f.read()
        txt = raw.decode("utf-8", errors="replace")
        if size > max_bytes:
            nl = txt.find("\n")
            if nl >= 0:
                txt = txt[nl + 1:]
        return {"path": path, "size": size, "text": txt}
    except OSError:
        return {"path": path, "size": 0, "text": ""}


# A single process-wide session shared across worker threads. The Session
# itself serializes mutating DB work with internal locks.
SESSION = None
SESSION_LOCK = threading.Lock()

# --- robust teardown: clear temp data on any exit path we can catch ---
_HTTPD = None
_SHUTDOWN_DONE = False
_SHUTDOWN_LOCK = threading.Lock()


def _focus_window():
    """Bring this instance's native window (if any) to the front. Best-effort,
    used by a second launch to surface the running copy. Returns True only if a
    pywebview window exists to surface."""
    try:
        import webview
    except Exception:
        return False
    wins = list(getattr(webview, "windows", None) or [])
    if not wins:
        return False
    w = wins[0]
    try:
        w.restore()  # un-minimise if needed
    except Exception:
        pass
    try:  # a quick on-top toggle reliably raises it across platforms
        w.on_top = True
        w.on_top = False
    except Exception:
        pass
    return True


def _destroy_window():
    """Close this instance's native window(s), if any. Lets a UI-initiated
    shutdown actually close the app instead of leaving a dead window."""
    try:
        import webview
    except Exception:
        return
    for w in list(getattr(webview, "windows", None) or []):
        try:
            w.destroy()
        except Exception:
            pass


def _graceful_shutdown(*_args):
    """Stop the server, clear the session (caches + on-disk DuckDB), and
    delete this instance's temp directory. Idempotent, so it is safe to
    call from a signal handler, atexit, and the main loop's finally."""
    global _SHUTDOWN_DONE
    with _SHUTDOWN_LOCK:
        if _SHUTDOWN_DONE:
            return
        _SHUTDOWN_DONE = True
    # Stop the local llama-server sidecar BEFORE session teardown / os._exit
    # so Task Manager never keeps an orphaned assistant process after close.
    try:
        from samql_core import assistant as _asst
        _asst.stop_server(SESSION)
    except Exception as exc:
        print("[samql] shutdown: assistant stop failed: %s" % exc,
              file=sys.stderr)
    try:
        if _HTTPD is not None:
            _HTTPD.shutdown()
    except Exception as exc:
        print("[samql] shutdown: httpd.shutdown failed: %s" % exc, file=sys.stderr)
    if SESSION is not None:
        try:
            SESSION.shutdown()
        except Exception as exc:
            print("[samql] shutdown: session.shutdown failed: %s" % exc,
                  file=sys.stderr)
    try:
        tmputil.cleanup_instance()
    except Exception as exc:
        print("[samql] shutdown: temp cleanup failed: %s" % exc, file=sys.stderr)
    # Also tidy any directories left behind by previous instances that were
    # killed before they could clean up, so a clean exit never leaves temp
    # directories accumulating across runs.
    try:
        tmputil.sweep_stale()
    except Exception as exc:
        print("[samql] shutdown: stale sweep failed: %s" % exc, file=sys.stderr)
    # Close the native window last, so stopping the server from the UI closes
    # the app. When the window goes, webview.start() on the main thread returns.
    try:
        _destroy_window()
    except Exception as exc:
        print("[samql] shutdown: window destroy failed: %s" % exc, file=sys.stderr)


def _install_exit_handlers():
    """Run cleanup on Ctrl+C, SIGTERM, SIGHUP (POSIX), and Windows console
    close/logoff/shutdown -- in addition to normal interpreter exit."""
    atexit.register(_graceful_shutdown)
    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _graceful_shutdown)
            except (ValueError, OSError, RuntimeError):
                pass  # e.g. not in main thread / unsupported
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
            def _console_handler(ctrl_type):
                # CTRL_CLOSE_EVENT=2, CTRL_LOGOFF=5, CTRL_SHUTDOWN=6
                if ctrl_type in (2, 5, 6):
                    _graceful_shutdown()
                return False  # let default processing continue

            # Keep a reference so it isn't garbage collected.
            global _WIN_CONSOLE_HANDLER
            _WIN_CONSOLE_HANDLER = _console_handler
            ctypes.windll.kernel32.SetConsoleCtrlHandler(
                _console_handler, True)
        except Exception:
            pass


_WIN_CONSOLE_HANDLER = None

# Background file-load jobs, keyed by id, so the UI can show a progress bar.
JOBS = {}
JOBS_LOCK = threading.Lock()


class EngineSlot:
    """A single-owner FIFO gate that serializes background jobs' ENGINE phases
    (a load's CREATE TABLE, a convert's COPY) while leaving their IO phases
    (an HDFS download, a JSON read) free to overlap.

    Foreground queries do NOT use this -- they contend on the engine's own
    write-lock as before -- so a plain SELECT never becomes a tray task. One
    global slot keeps cancellation unambiguous: only the single owner is ever
    mid-statement, so interrupting the engine can only hit that one job, and
    everything queued cancels cooperatively (it never touched the engine)."""

    def __init__(self):
        self._cv = threading.Condition()
        self._queue = []      # FIFO of waiting job ids (head = next to run)
        self._owner = None    # job id currently holding the slot

    def acquire(self, job):
        """Wait (FIFO) until this job owns the slot. While waiting it is
        'queued' and cancellable: a cancel raises LoadCancelled and it never
        runs the engine. Returns once this job owns the slot."""
        token = job["id"]
        with self._cv:
            self._queue.append(token)
            try:
                announced = False
                while self._owner is not None or self._queue[0] != token:
                    if job.get("cancel"):
                        raise LoadCancelled()
                    if not announced:
                        job["state"] = "queued"   # reflect the wait in the feed
                        announced = True
                    self._cv.wait(timeout=0.2)
                if job.get("cancel"):
                    raise LoadCancelled()
                self._owner = token
                self._queue.pop(0)
            except BaseException:
                # leave the queue on cancel/error so we never wedge the others
                try:
                    self._queue.remove(token)
                except ValueError:
                    pass
                self._cv.notify_all()
                raise

    def release(self, job):
        with self._cv:
            if self._owner == job.get("id"):
                self._owner = None
            self._cv.notify_all()

    def owner(self):
        with self._cv:
            return self._owner

    def wake(self):
        """Nudge waiters to re-check their cancel flag, so a cancelled queued
        job unwinds at once instead of after the wait timeout."""
        with self._cv:
            self._cv.notify_all()


ENGINE_SLOT = EngineSlot()


def _with_engine_slot(job, run_inner):
    """Wrap a pure-engine background job's body so it holds the single engine
    slot for its run: FIFO-queue (cancellable while queued) -> run -> release.

    Used by the load rail (load / folder / multipart / convert), whose work is
    all engine work. IO-heavy jobs (an HDFS download, an API fetch) instead
    acquire the slot only around their engine phase, so their IO overlaps."""
    def wrapped():
        try:
            ENGINE_SLOT.acquire(job)
        except LoadCancelled:
            job["state"] = "cancelled"
            job["done_at"] = time.time()
            return
        except BaseException as e:
            _fail_job(job, err_str(e))
            job["done_at"] = time.time()
            return
        try:
            run_inner()
        finally:
            ENGINE_SLOT.release(job)
    return wrapped


def _flag_all_jobs():
    """Flag every in-flight background job so its card unwinds as cancelled
    (its partial table rolled back), not a raw interrupt error. Shared by the
    global Stop (query_cancel) and the explicit cancel-all halt."""
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.get("state") not in ("done", "error", "cancelled"):
                j["cancel"] = True


def _normalize_user_path(path):
    """Clean a path pasted from Explorer / a browser before os.path checks.

    Strips wrapping quotes, ``file:`` URLs, and expands ``~`` / ``%VARS%`` so a
    coworker who pastes ``\"C:\\Users\\...\\file.csv\"`` or
    ``file:///C:/Users/.../file.csv`` gets the same result as Browse….
    """
    if not isinstance(path, str):
        return path
    p = path.strip().strip('"').strip("'").strip()
    if not p:
        return p
    lower = p[:8].lower()
    if lower.startswith("file:"):
        try:
            from urllib.parse import unquote, urlparse
            parsed = urlparse(p)
            raw = unquote(parsed.path or "")
            if os.name == "nt":
                # file:///C:/Users/... -> /C:/Users/... ; file://server/share
                if parsed.netloc and parsed.netloc not in ("localhost", "127.0.0.1"):
                    p = "\\\\" + parsed.netloc + raw.replace("/", "\\")
                else:
                    if raw.startswith("/") and len(raw) >= 3 and raw[2] == ":":
                        raw = raw[1:]
                    p = raw.replace("/", "\\")
            else:
                p = raw or p
        except Exception:
            pass
    try:
        p = os.path.expandvars(os.path.expanduser(p))
    except Exception:
        pass
    return p


def _list_dir(path):
    """List a directory on the server's local filesystem for the file
    browser. Returns folders first, then files. Localhost-only tool, so
    direct filesystem access is acceptable (same as load-by-path)."""
    import string
    sep = os.sep
    drives = []
    if os.name == "nt":
        drives = [f"{d}:\\" for d in string.ascii_uppercase
                  if os.path.exists(f"{d}:\\")]
    if not path:
        path = os.path.expanduser("~")
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        path = os.path.dirname(path) or path
    parent = os.path.dirname(path)
    if parent == path:
        parent = None
    try:
        names = os.listdir(path)
    except Exception as e:
        return {"path": path, "parent": parent, "sep": sep,
                "drives": drives, "entries": [],
                "error": err_str(e)}
    dirs, files = [], []
    for name in names:
        full = os.path.join(path, name)
        try:
            is_dir = os.path.isdir(full)
        except Exception:
            continue
        if is_dir:
            dirs.append({"name": name, "path": full, "is_dir": True,
                         "size": None, "ext": ""})
        else:
            try:
                size = os.path.getsize(full)
            except Exception:
                size = None
            ext = os.path.splitext(name)[1].lower().lstrip(".")
            files.append({"name": name, "path": full, "is_dir": False,
                          "size": size, "ext": ext})
    dirs.sort(key=lambda e: e["name"].lower())
    files.sort(key=lambda e: e["name"].lower())
    entries = (dirs + files)[:3000]
    return {"path": path, "parent": parent, "sep": sep,
            "drives": drives, "entries": entries,
            "home": os.path.expanduser("~"), "shortcuts": _user_shortcuts()}


def _downloads_dir():
    """.539: the user's Downloads folder -- shared ladder in
    ``samql_core.tmputil.downloads_dir`` (registry / OneDrive / env)."""
    return tmputil.downloads_dir()


def _downloads_filename(dl, name):
    """A sanitized, collision-safe path inside the Downloads dir."""
    import re as _re
    name = _re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_",
                   (name or "").strip())[:150]
    if not name:
        name = "samql_download.txt"
    base, ext = os.path.splitext(name)
    out = os.path.join(dl, name)
    n = 1
    while os.path.exists(out) and n < 100:
        out = os.path.join(dl, "%s_%d%s" % (base, n, ext))
        n += 1
    return out


def _win_known_folder(key_name):
    """Resolve a Windows shell folder -- shared with tmputil."""
    return tmputil.win_known_folder(key_name)


def _user_shortcuts():
    """Quick-access folders for the file browser: Home, Desktop, Documents,
    Downloads -- de-duplicated and limited to ones that actually exist."""
    home = os.path.expanduser("~")
    pairs = [("Home", home)]
    if os.name == "nt":
        for label, key in (("Desktop", "Desktop"),
                           ("Documents", "Personal"),
                           ("Downloads", "Downloads")):
            try:
                pairs.append((label, _win_known_folder(key)))
            except Exception:
                pairs.append((label, os.path.join(home, label)))
    else:
        for label in ("Desktop", "Documents", "Downloads"):
            pairs.append((label, os.path.join(home, label)))
    out, seen = [], set()
    for label, p in pairs:
        if not p:
            continue
        ap = os.path.abspath(p)
        if ap in seen or not os.path.isdir(ap):
            continue
        seen.add(ap)
        out.append({"label": label, "path": ap})
    return out


def get_session() -> Session:
    global SESSION
    if SESSION is None:
        with SESSION_LOCK:
            if SESSION is None:
                SESSION = Session()
                # rebuild the previously-loaded tables in the background
                try:
                    SESSION.restore_session()
                except Exception:
                    pass
    return SESSION


def _boot_stage_label():
    """Cheap BootBar phase string for /api/health ``stage`` (launcher splash/logs)."""
    bar = _BOOT_BAR
    if bar is None:
        return None
    try:
        label = getattr(bar, "_label", None)
        if label:
            return str(label)
    except Exception:
        pass
    return None


def _health_payload(session=None):
    """Build the /api/health JSON body.

    When ``session`` is None the payload is the lightweight launcher
    readiness marker only -- ``app`` / version / build / frontend_built.
    Full feature flags require a live Session. This split matters because
    ``serve_forever`` starts BEFORE ``get_session()``; if health blocked on
    Session() construction, AppWindow cold starts (AV, assistant prefs,
    first DuckDB open) could burn the whole boot budget and fail once,
    then succeed on retry when imports/AV were warm.

    Optional ``stage`` mirrors the terminal BootBar label so AppWindow
    splash/logs can show more than static "Waiting..." text. ``warming``
    remains True until a Session exists; the launcher opens once ``app``
    is SamQL and does not wait for warming to clear.
    """
    base = {
        "ok": True,
        "app": "SamQL",
        "version": __version__,
        "build": BUILD,
        "frontend_built": _FRONTEND_DIR is not None,
    }
    stage = _boot_stage_label()
    if session is None:
        base["features"] = {}
        base["warming"] = True
        base["restoring"] = False
        base["restored"] = 0
        base["stage"] = stage or "starting"
        return base
    base["features"] = session.optional_features()
    base["concurrent_reads"] = session.concurrent_reads_enabled()
    base["flatten_json"] = session.flatten_json_enabled()
    base["restoring"] = bool(getattr(session, "restoring", False))
    base["restored"] = int(getattr(session, "_restored_count", 0))
    base["warming"] = False
    base["stage"] = stage or "ready"
    return base


# --------------------------------------------------------------------- #
# Route table: each entry is (method, compiled-regex, handler-name)
# Handlers take (session, match, body_dict, ctx) and return a JSON-able
# dict, or a FileDownload, or raise ApiError.
# --------------------------------------------------------------------- #
class Api:
    """Namespace of endpoint handlers operating on a Session."""

    # ---- health & capabilities -------------------------------------
    @staticmethod
    def health(s, m, body, ctx):
        return _health_payload(s)

    @staticmethod
    def features(s, m, body, ctx):
        return s.optional_features()

    @staticmethod
    def status(s, m, body, ctx):
        # Live activity for the dashboard + a one-click diagnostics view: what's
        # running, rows so far, seconds since last progress, which engine locks
        # are held, thread count, restore flag, and the last recorded stall.
        st = s.status()
        # The error log lives here in the server (not the session), so attach
        # the most recent failure -- the heartbeat monitor turns red when a
        # failure happened recently (age_s lets the UI decide "recent").
        try:
            with _ERROR_LOG_LOCK:
                last = _ERROR_LOG[-1] if _ERROR_LOG else None
            if last:
                st["last_error"] = {
                    "ts": last.get("ts"),
                    "error": last.get("error"),
                    "kind": last.get("kind"),
                    "status": last.get("status"),
                    "route": ("%s %s" % (last.get("method") or "",
                                         last.get("path") or "")).strip(),
                    "age_s": round(max(0.0, time.time()
                                       - (last.get("epoch") or 0.0)), 1),
                }
        except Exception:
            pass
        return st

    @staticmethod
    def engine_reset(s, m, body, ctx):
        # Recover a wedged engine without restarting the app: fresh engines +
        # background rebuild of loaded tables from the manifest.
        which = (body or {}).get("which", "all")
        return s.reset_engines(which=which)

    @staticmethod
    def concurrent_reads(s, m, body, ctx):
        # Toggle DuckDB concurrent reads at runtime (so the tables panel / row
        # counts / schema peeks run on a separate cursor instead of queuing
        # behind a build). Lets the flag be A/B'd live without a restart; the
        # SAMQL_CONCURRENT_READS env var sets the startup default. POST {on:
        # bool} sets it; POST {} just reports the current state.
        b = body or {}
        if "on" in b:
            s.set_concurrent_reads(bool(b.get("on")))
        return {"concurrent_reads": s.concurrent_reads_enabled()}

    @staticmethod
    def flatten_json_setting(s, m, body, ctx):
        # Toggle 'flatten JSON on load'. Off (default): DuckDB keeps a single
        # nested table (fast for multi-GB files). On: shred into relational
        # tables after load (SQLite always flattens). Persisted; applies to the
        # next load on every entry point that does not pass an explicit flag
        # (drag/drop, modal, folder, path). POST {on: bool} sets it; POST {}
        # reports state.
        b = body or {}
        if "on" in b:
            s.set_flatten_json(bool(b.get("on")))
        return {"flatten_json": s.flatten_json_enabled()}

    @staticmethod
    def docs_functions(s, m, body, ctx):
        # .433: the Documentation modal's SQL-functions tab -- live from
        # both engines, cached per session.
        return s.list_functions()

    @staticmethod
    def diagnostics(s, m, body, ctx):
        # List the diagnostics available to the Error log -> Diagnostics tab,
        # plus a ready environment report so the tab has content on open.
        from samql_core import diagnostics as _diag
        return {"diagnostics": _diag.list_diagnostics(),
                "environment": _diag.env_report(s)}

    @staticmethod
    def diagnostics_run(s, m, body, ctx):
        # Run one diagnostic by name with the given params. Diagnostics never
        # raise -- a failure comes back as {ok: False, error, traceback}.
        from samql_core import diagnostics as _diag
        b = body or {}
        name = b.get("name") or ""
        params = b.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        # only string keys, and never let a param shadow the session argument
        params = {k: v for k, v in params.items()
                  if isinstance(k, str) and k != "session"}
        return _diag.run(name, s, **params)

    # ---- tables ----------------------------------------------------
    @staticmethod
    def tables(s, m, body, ctx):
        return {"tables": s.tables_tree()}

    @staticmethod
    def tables_reorder(s, m, body, ctx):
        """Persist Loaded-tables drag order for the session."""
        return s.set_table_ui_order((body or {}).get("order") or [])

    @staticmethod
    def column_fields(s, m, body, ctx):
        # The nested field tree for one column, fetched lazily when the user
        # expands a nested column in the tables tree.
        b = body or {}
        return s.column_field_tree(b.get("engine", "duckdb"),
                                   b.get("table", ""), b.get("column", ""))

    @staticmethod
    def table_fields(s, m, body, ctx):
        """Unified Field Explorer tree for one loaded table (all columns)."""
        b = body or {}
        name = unquote(m.group("name"))
        return s.table_field_tree(b.get("engine", "duckdb"), name)

    @staticmethod
    def column_access_preview(s, m, body, ctx):
        """Validate Field Explorer SQL by executing First (LIMIT 1) with fallbacks."""
        b = body or {}
        return s.preview_column_access(
            b.get("engine", "duckdb"),
            b.get("table", ""),
            b.get("column", ""),
            field_idx=b.get("field_idx"),
            field_path=b.get("field_path"))

    @staticmethod
    def table_profile(s, m, body, ctx):
        name = unquote(m.group("name"))
        engine = (body or {}).get("engine", "sqlite")
        _REQ_LOCAL.qid = (body or {}).get("query_id")
        try:
            return s.profile(name, engine=engine,
                             query_id=(body or {}).get("query_id"))
        except Exception as e:
            # .454 fuzz fix: profiling a missing table bubbled the
            # OperationalError as a 500 -- it is a client mistake.
            if "no such table" in str(e).lower():
                raise ApiError(404, "No such table: %s" % name)
            raise

    @staticmethod
    def profile_field(s, m, body, ctx):
        # profile_field self-registers against the agg interrupt target
        # (result-store conn/engine) -- do not wrap with _run_op (None eng).
        b = body or {}
        _REQ_LOCAL.qid = b.get("query_id")
        return s.profile_field(b)

    @staticmethod
    def table_rename(s, m, body, ctx):
        b = body or {}
        return s.rename_table(b.get("engine", "sqlite"),
                              _reqstr(b, "old"), _reqstr(b, "new"))

    @staticmethod
    def table_drop(s, m, body, ctx):
        b = body or {}
        return s.drop_table(b.get("engine", "sqlite"),
                            _reqstr(b, "name", "table name"))

    @staticmethod
    def table_change_type(s, m, body, ctx):
        b = body or {}
        return s.change_column_type(b.get("engine", "sqlite"),
                                    b.get("table"), b.get("col"),
                                    b.get("new_type"),
                                    query_id=b.get("query_id"))

    @staticmethod
    def materialize(s, m, body, ctx):
        b = body or {}
        return s.materialize(_reqstr(b, "name"), _reqstr(b, "sql"),
                             b.get("target", "auto"),
                             query_id=b.get("query_id"),
                             from_result=b.get("from_result"))

    @staticmethod
    def clear_all(s, m, body, ctx):
        return s.clear_all(clear_manifest=True)

    @staticmethod
    def shutdown(s, m, body, ctx):
        """Stop the server gracefully. The actual teardown runs on a short
        delay in a background thread so this HTTP response can flush first;
        ``_graceful_shutdown`` then stops the server, clears the session and
        deletes this instance's temp directory."""
        def _later():
            time.sleep(0.4)
            _graceful_shutdown()
            # .512: teardown is COMPLETE (HTTP stopped, session closed, temp
            # cleaned) -- end the process unconditionally. Relying on "main
            # falls off the end" left the exe alive whenever any straggler
            # thread wasn't a daemon; that is the Task-Manager zombie.
            os._exit(0)
        threading.Thread(target=_later, daemon=True).start()
        return {"ok": True, "stopping": True}

    @staticmethod
    def about(s, m, body, ctx):
        """.538: the About page -- version, build, runtime, engines, and
        every optional package with its installed version (or absent).
        Everything best-effort; a probe failure reads "unknown"."""
        import platform as _pl
        import sqlite3 as _sq
        try:
            from importlib import metadata as _md
        except Exception:
            _md = None

        def _ver(pkg):
            try:
                if _md is None:
                    raise RuntimeError()
                return _md.version(pkg)
            except Exception:
                try:
                    mod = __import__(pkg)
                    return getattr(mod, "__version__", None)
                except Exception:
                    return None

        pkgs = []
        for name, why in (
            ("duckdb", "analytical engine"),
            ("pyarrow", "columnar loads + Parquet"),
            ("openpyxl", "xlsx read/write"),
            ("sqlglot", "SQL dialect translation"),
            ("orjson", "fast JSON parse"),
            ("ijson", "streaming JSON reads"),
            ("pyodbc", "ODBC connections"),
            ("pywebview", "the native app window"),
        ):
            v = _ver(name)
            pkgs.append({"name": name, "version": v,
                         "installed": v is not None, "role": why})
        duck_v = _ver("duckdb")
        return {
            "ok": True,
            "app": "SamQL",
            "version": __version__,
            "build": BUILD,
            "python": sys.version.split()[0],
            "platform": _pl.platform(),
            "engines": {
                "duckdb": duck_v or "not installed",
                "sqlite": _sq.sqlite_version,
            },
            "frontend": "React 18 + Vite 5 (bundled)",
            "packages": pkgs,
        }

    @staticmethod
    def table_properties(s, m, body, ctx):
        eng = _reqstr(body, "engine")
        name = _reqstr(body, "table")
        res = s.table_properties(eng, name)
        if res.get("error"):
            raise ApiError(404, res["error"])
        res["ok"] = True
        return res

    @staticmethod
    def focus(s, m, body, ctx):
        """Bring this instance's native window to the front. A second launch
        calls this so double-clicking the exe surfaces the running copy
        instead of starting another server. ``focused`` is False when there's
        no native window (e.g. running in a browser), so the caller can open a
        browser tab to this server instead."""
        return {"ok": True, "focused": _focus_window()}

    # ---- memory --------------------------------------------------
    @staticmethod
    def memory(s, m, body, ctx):
        return s.memory_usage()

    @staticmethod
    def engine_tuning(s, m, body, ctx):
        # R4: read/adjust DuckDB's memory_limit / threads LIVE (SET works at
        # runtime). Non-blocking on the engine lock so this can never queue
        # behind a build; if the engine is busy it says so instead of hanging.
        b = body or {}
        duck = s.duckdb
        if duck is None:
            return {"error": "DuckDB isn't available in this session."}
        try:
            got = duck.write_lock.acquire(blocking=False)
        except Exception:
            got = False
        if not got:
            return {"busy": True,
                    "error": "The engine is busy right now — apply tuning "
                             "after the current build/query finishes."}
        try:
            applied = {}
            if b.get("memory_gb") is not None:
                gb = max(1, min(int(float(b["memory_gb"])), 1024))
                duck.conn.execute(f"SET memory_limit = '{gb}GB'")
                applied["memory_gb"] = gb
            if b.get("threads") is not None:
                th = max(1, min(int(b["threads"]), 256))
                duck.conn.execute(f"SET threads TO {th}")
                applied["threads"] = th
            cur = duck.conn.execute(
                "SELECT current_setting('memory_limit'), "
                "current_setting('threads')").fetchone()
            return {"ok": True, "applied": applied,
                    "memory_limit": str(cur[0]) if cur else None,
                    "threads": int(cur[1]) if cur else None,
                    "note": "Applies to this session; set "
                            "SAMQL_DUCKDB_MEMORY_GB to persist across "
                            "restarts."}
        except Exception as e:
            return {"error": err_str(e)}
        finally:
            try:
                duck.write_lock.release()
            except Exception:
                pass

    @staticmethod
    def load_preflight(s, m, body, ctx):
        """Advise before starting a large file load (UI pre-check)."""
        b = body or {}
        path = _normalize_user_path(b.get("path") or "")
        return s.load_preflight(path)

    @staticmethod
    def load_thresholds_settings(s, m, body, ctx):
        """GET/POST load-file size thresholds (Storage & memory → Load)."""
        if m == "GET":
            return s.load_thresholds_info()
        b = body or {}
        if b.get("reset"):
            return s.configure_load_thresholds(reset=True)
        updates = b.get("thresholds") if isinstance(b.get("thresholds"), dict) \
            else b
        # Ignore non-field keys like ok / reset
        from samql_core import load_thresholds as LT
        cleaned = {k: v for k, v in (updates or {}).items()
                   if k in LT.FIELDS}
        return s.configure_load_thresholds(updates=cleaned)

    @staticmethod
    def flow_cache_settings(s, m, body, ctx):
        if m == "GET":
            return {"ok": True, **s.flow_cache_info()}
        b = body or {}
        enabled = b.get("enabled") if "enabled" in b else None
        if enabled is not None and not isinstance(enabled, bool):
            raise ApiError(400, "enabled must be true or false")
        bool_fields = ("adaptive_resources", "parallel_nodeflows",
                       "persistent_enabled", "clear", "reset_stats",
                       "clear_persistent")
        for key in bool_fields:
            if key in b and not isinstance(b.get(key), bool):
                raise ApiError(400, "%s must be true or false" % key)
        try:
            max_entries = (int(b["max_entries"])
                           if b.get("max_entries") is not None else None)
            max_mb = (int(b["max_mb"])
                      if b.get("max_mb") is not None else None)
            parallel_workers = (int(b["parallel_workers"])
                                if b.get("parallel_workers") is not None
                                else None)
            persistent_max_mb = (int(b["persistent_max_mb"])
                                 if b.get("persistent_max_mb") is not None
                                 else None)
            persistent_days = (int(b["persistent_days"])
                               if b.get("persistent_days") is not None
                               else None)
        except (TypeError, ValueError):
            raise ApiError(400, "cache limits and worker counts must be integers")
        for key, value in (("max_entries", max_entries), ("max_mb", max_mb),
                           ("persistent_max_mb", persistent_max_mb),
                           ("persistent_days", persistent_days)):
            if value is not None and value < 0:
                raise ApiError(400, "%s must be zero or greater" % key)
        if parallel_workers is not None and parallel_workers < 1:
            raise ApiError(400, "parallel_workers must be one or greater")
        return s.configure_flow_cache(
            enabled=enabled, max_entries=max_entries, max_mb=max_mb,
            clear=b.get("clear", False),
            reset_stats=b.get("reset_stats", False),
            adaptive_resources=b.get("adaptive_resources"),
            parallel_nodeflows=b.get("parallel_nodeflows"),
            parallel_workers=parallel_workers,
            persistent_enabled=b.get("persistent_enabled"),
            persistent_max_mb=persistent_max_mb,
            persistent_days=persistent_days,
            clear_persistent=b.get("clear_persistent", False))

    @staticmethod
    def memory_free(s, m, body, ctx):
        return s.free_memory()

    @staticmethod
    def maintenance_sweep_temp(s, m, body, ctx):
        # Reclaim temp left by previous instances whose process has exited.
        # Never touches this session's live temp (active tables), so it is
        # always safe to run; reports how many stale dirs went and how much
        # temp this session is currently holding. .544: an optional
        # mei_min_age also reclaims recent onefile extractions -- the
        # launcher's frozen hard-exit (.537) skips the bootloader's own
        # cleanup, so every window close strands one; each next launch
        # asks us to take the previous ones.
        b = body or {}
        removed = tmputil.sweep_stale()
        mei = None
        if b.get("mei_min_age") is not None:
            try:
                age = max(60, int(b.get("mei_min_age")))
            except (TypeError, ValueError):
                raise ApiError(400, "mei_min_age must be an integer.")
            mei = tmputil.sweep_mei_orphans(min_age_sec=age)
        out = {"removed": removed,
               "instance_bytes": tmputil.instance_size_bytes()}
        if mei is not None:
            out["mei_removed"], out["mei_freed_bytes"] = mei
        return out

    @staticmethod
    def run_tests(s, m, body, ctx):
        # Convenience dev lever (Settings -> Run tests). Runs the backend test
        # suite in a separate process. Only works when running from source; the
        # packaged executable can't relaunch itself as a test runner.
        if getattr(sys, "frozen", False):
            return {"available": False,
                    "reason": "Running tests is only available when SamQL is "
                              "run from source, not from the packaged app."}
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(here)
        runner = os.path.join(root, "tests", "run_tests.py")
        if not os.path.isfile(runner):
            return {"available": False,
                    "reason": "Test suite (tests/run_tests.py) was not found "
                              "next to this build."}
        try:
            proc = subprocess.run(
                [sys.executable, runner, "--backend-only", "--no-http"],
                cwd=root, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            return {"available": True, "ok": False,
                    "reason": "Test run timed out after 180s."}
        except Exception as e:  # pragma: no cover - defensive
            return {"available": True, "ok": False, "reason": str(e)}
        out = (proc.stdout or "") + "\n" + (proc.stderr or "")
        passed = failed = skipped = None
        mt = re.search(
            r"TOTAL:\s*(\d+)\s+passed,\s*(\d+)\s+failed,\s*(\d+)\s+skipped", out)
        if mt:
            passed, failed, skipped = (int(mt.group(1)), int(mt.group(2)),
                                       int(mt.group(3)))
        tail = "\n".join(out.splitlines()[-25:])
        return {"available": True, "ok": proc.returncode == 0,
                "returncode": proc.returncode, "passed": passed,
                "failed": failed, "skipped": skipped, "summary": tail}

    # ---- json flatten --------------------------------------------
    @staticmethod
    def table_flatten(s, m, body, ctx):
        name = unquote(m.group("name"))
        engine = (body or {}).get("engine", "duckdb")
        res = s.flatten_json(name, engine=engine,
                             query_id=(body or {}).get("query_id"))
        if res.get("error"):
            raise ApiError(400, res["error"])
        return res

    # ---- loading ---------------------------------------------------
    @staticmethod
    def load_files(s, m, body, ctx):
        """multipart upload -> temp files -> load each into an engine."""
        files = ctx.get("files") or []
        fields = ctx.get("fields") or {}
        if not files:
            raise ApiError(400, "No files in upload.")
        destination = fields.get("destination") or "auto"
        delimiter = fields.get("delimiter")
        sheet = fields.get("sheet")
        mode = (fields.get("mode") or "materialize").strip().lower()
        exclude = [t.strip() for t in (fields.get("exclude") or "").split(",")
                   if t.strip()] or None
        _fl = (fields.get("flatten") or "").strip().lower()
        flatten = (None if _fl == "" else _fl in ("1", "true", "on", "yes"))
        shred = (fields.get("shred") or "").strip().lower() in (
            "1", "true", "on", "yes")
        root_id = None
        _ridf = fields.get("root_id")
        if _ridf:
            try:
                _ridp = json.loads(_ridf)
                if isinstance(_ridp, dict):
                    root_id = _ridp
            except Exception:
                root_id = None
        try:
            header_row = int(fields.get("header_row") or 1)
        except Exception:
            header_row = 1
        import tempfile
        results = []
        for part in files:
            suffix = os.path.splitext(part.filename or "")[1] or ".dat"
            # "view" (query-in-place) keeps reading the file on every query, so
            # the upload has to live on -- park it in the instance temp dir
            # (swept on shutdown). "materialize" copies the data into a table,
            # so its upload is a throwaway removed right after the load.
            if mode == "view":
                tmp = tmputil.new_tempfile("up_", suffix)
            else:
                fd, tmp = tempfile.mkstemp(prefix="samql_up_", suffix=suffix,
                                           dir=tmputil.instance_dir())
                os.close(fd)
            keep = False
            try:
                # streamed upload: the bytes are already ON DISK -- move,
                # never re-write through memory
                os.replace(part.path, tmp)
                base = os.path.splitext(
                    os.path.basename(part.filename or "data"))[0]
                loaded = s.load_file(tmp, destination=destination,
                                     base_name=base, delimiter=delimiter,
                                     mode=mode, sheet=sheet,
                                     header_row=header_row, exclude=exclude,
                                     flatten=flatten, shred=shred,
                                     root_id=root_id)
                # only a registered view needs the file kept on disk; a
                # materialized load (including the no-DuckDB fallback) has
                # already copied the data, so its upload can go.
                keep = isinstance(loaded, list) and any(
                    isinstance(t, dict) and t.get("view") for t in loaded)
                results.append({"file": part.filename, "tables": loaded})
            except Exception as e:
                results.append({"file": part.filename,
                                "error": err_str(e)})
            finally:
                if not keep:
                    try:
                        os.unlink(tmp)
                    except Exception:
                        pass
        return {"loaded": results, "tables": s.tables_tree()}

    @staticmethod
    def load_files_start(s, m, body, ctx):
        """multipart upload -> temp files -> a background job that loads each,
        so a big dropped file can be cancelled mid-load (same progress/cancel
        machinery as the path + folder loaders). The upload itself is local and
        quick; the slow parse + insert runs in the job. Returns a job_id to
        poll via /api/load/progress and cancel via /api/load/cancel."""
        files = ctx.get("files") or []
        fields = ctx.get("fields") or {}
        if not files:
            raise ApiError(400, "No files in upload.")
        destination = fields.get("destination") or "auto"
        delimiter = fields.get("delimiter")
        sheet = fields.get("sheet")
        mode = (fields.get("mode") or "materialize").strip().lower()
        exclude = [t.strip() for t in (fields.get("exclude") or "").split(",")
                   if t.strip()] or None
        _fl = (fields.get("flatten") or "").strip().lower()
        flatten = (None if _fl == "" else _fl in ("1", "true", "on", "yes"))
        shred = (fields.get("shred") or "").strip().lower() in (
            "1", "true", "on", "yes")
        root_id = None
        _ridf = fields.get("root_id")
        if _ridf:
            try:
                _ridp = json.loads(_ridf)
                if isinstance(_ridp, dict):
                    root_id = _ridp
            except Exception:
                root_id = None
        try:
            header_row = int(fields.get("header_row") or 1)
        except Exception:
            header_row = 1
        import tempfile
        saved = []  # (tmp_path, original_name)
        total = 0
        pending_tmp = None
        try:
            for part in files:
                suffix = os.path.splitext(part.filename or "")[1] or ".dat"
                # "view" keeps reading the file on every query, so it must live
                # on (instance temp dir, swept on shutdown); "materialize"
                # copies the data into a table, so its upload is a throwaway.
                if mode == "view":
                    pending_tmp = tmputil.new_tempfile("up_", suffix)
                else:
                    fd, pending_tmp = tempfile.mkstemp(
                        prefix="samql_up_", suffix=suffix,
                        dir=tmputil.instance_dir())
                    os.close(fd)
                os.replace(part.path, pending_tmp)  # already on disk
                saved.append((pending_tmp, part.filename or "data"))
                pending_tmp = None
                total += int(getattr(part, "size", 0) or 0)
        except Exception:
            for tmp, _name in saved:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            if pending_tmp:
                try:
                    os.unlink(pending_tmp)
                except OSError:
                    pass
            raise
        cum = [0]
        for tmp, _name in saved:
            try:
                cum.append(cum[-1] + os.path.getsize(tmp))
            except Exception:
                cum.append(cum[-1])
        count = len(saved)
        first_name = os.path.basename(saved[0][1])
        name0 = first_name if count == 1 else f"{first_name} (0/{count})"
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "load", "state": "starting",
               "shred": bool(locals().get("shred")), "bytes_done": 0,
               "bytes_total": total, "rows": None, "name": name0,
               "error": None, "engine": destination, "started": time.time(),
               "loaded": None, "root_id": root_id, "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job

        before = s.snapshot_table_names()

        def run():
            job["tid"] = threading.get_ident()
            job["state"] = "reading"
            all_loaded = []
            kept = set()  # temp files turned into a view -> must be kept
            try:
                for i, (tmp, original) in enumerate(saved):
                    if job.get("cancel"):
                        raise LoadCancelled()
                    base = os.path.splitext(os.path.basename(original))[0]
                    if count > 1:
                        job["name"] = (f"{os.path.basename(original)} "
                                       f"({i + 1}/{count})")

                    def prog(done, total_b=None, _i=i):
                        if job.get("cancel"):
                            raise LoadCancelled()
                        job["bytes_done"] = cum[_i] + done
                        if (job["bytes_total"]
                                and job["bytes_done"] >= job["bytes_total"]):
                            job["state"] = "finalizing"
                    # Non-raising cancel probe the JSON reader can poll on every
                    # chunk, so a Stop lands inside the read (even mid-record)
                    # instead of only at the flattener's 5000-row checkpoints.
                    prog.should_cancel = lambda: bool(job.get("cancel"))

                    loaded = s.load_file(
                        tmp, destination=destination, base_name=base,
                        progress=prog, delimiter=delimiter, mode=mode,
                        sheet=sheet, header_row=header_row, exclude=exclude,
                        flatten=flatten, shred=shred,
                        root_id=job.get("root_id"))
                    if isinstance(loaded, list) and any(
                            isinstance(t, dict) and t.get("view")
                            for t in loaded):
                        kept.add(tmp)
                    all_loaded.extend(loaded)
                    job["bytes_done"] = cum[i + 1]
                job["loaded"] = all_loaded
                _shred_note(job, all_loaded)
                job["rows"] = sum((t.get("rows") or 0) for t in all_loaded)
                if all_loaded:
                    job["engine"] = all_loaded[0].get("engine", destination)
                job["bytes_done"] = job["bytes_total"]
                job["state"] = "done"
                job["name"] = first_name if count == 1 else f"{count} files"
                # .538: record the LANDED table name -- Properties and the
                # restore replay both key on it.
                s.record_load("file", saved[0][0], destination,
                              base_name=(all_loaded[0].get("name")
                                         if all_loaded else None),
                              origin=saved[0][1])
            except LoadCancelled:
                job["state"] = "cancelled"
                s.drop_tables_created_since(before)
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                else:
                    _fail_job(job, err_str(e))
            finally:
                # drop every temp upload we didn't keep as a view (covers a
                # clean finish, an error, and an early cancel alike)
                for tmp, _o in saved:
                    if tmp not in kept:
                        try:
                            os.unlink(tmp)
                        except Exception:
                            pass
                job["done_at"] = time.time()

        try:
            threading.Thread(target=_with_engine_slot(job, run),
                             daemon=True).start()
        except Exception:
            with JOBS_LOCK:
                JOBS.pop(job_id, None)
            for tmp, _name in saved:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            raise
        return {"job_id": job_id, "bytes_total": total,
                "name": job["name"], "files": count}

    @staticmethod
    def excel_sheets(s, m, body, ctx):
        """List the sheet names of a workbook already on the server's disk."""
        b = body or {}
        path = _normalize_user_path(b.get("path"))
        if not path or not os.path.isfile(path):
            raise ApiError(400, f"File not found: {path}")
        from samql_core.loaders import excel_sheet_names
        try:
            return {"sheets": excel_sheet_names(path)}
        except Exception as e:
            raise ApiError(400, err_str(e))

    @staticmethod
    def json_fields(s, m, body, ctx):
        """Discover the nested fields (arrays -> child tables, objects -> nested
        columns) in a JSON file on disk, so the load UI can offer a skip
        checkbox per field. Time-boxed: on a huge file it scans as far as the
        budget allows and reports whether it finished."""
        b = body or {}
        path = _normalize_user_path(b.get("path"))
        if not path or not os.path.isfile(path):
            raise ApiError(400, f"File not found: {path}")
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext not in ("json", "ndjson", "jsonl"):
            raise ApiError(400, "Field discovery is for JSON files only.")
        from samql_core.diagnostics import discover_load_fields
        try:
            budget = int(b.get("budget") or 25)
        except Exception:
            budget = 25
        try:
            sample = int(b.get("sample") or 0)
        except Exception:
            sample = 0
        try:
            return discover_load_fields(path, sample=sample,
                                        time_budget_s=budget)
        except Exception as e:
            raise ApiError(400, err_str(e))

    @staticmethod
    def excel_peek(s, m, body, ctx):
        """List the sheet names of an *uploaded* workbook (multipart) without
        loading it -- used by the drag-and-drop sheet picker. The temp copy is
        read for its sheet list and then deleted."""
        files = ctx.get("files") or []
        if not files:
            raise ApiError(400, "No file in upload.")
        from samql_core.loaders import excel_sheet_names
        import tempfile
        part = files[0]
        suffix = os.path.splitext(part.filename or "")[1] or ".xlsx"
        fd, tmp = tempfile.mkstemp(prefix="samql_peek_", suffix=suffix,
                                   dir=tmputil.instance_dir())
        os.close(fd)
        try:
            os.replace(part.path, tmp)   # streamed: already on disk
            return {"sheets": excel_sheet_names(tmp)}
        except Exception as e:
            raise ApiError(400, err_str(e))
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass

    # ---- file browser (server-side filesystem) -------------------
    @staticmethod
    def fs_list(s, m, body, ctx):
        q = ctx.get("query") or {}
        path = (q.get("path") or [None])[0]
        return _list_dir(path)

    # ---- background load with progress ---------------------------
    @staticmethod
    def load_start(s, m, body, ctx):
        b = body or {}
        path = _normalize_user_path(b.get("path"))
        if not path or not os.path.isfile(path):
            raise ApiError(400, f"File not found: {path}")
        dest = b.get("destination") or "auto"
        delimiter = b.get("delimiter")
        mode = b.get("mode") or "materialize"
        sheet = b.get("sheet")
        header_row = b.get("header_row") or 1
        # optional selective flattening (JSON): list or comma-separated string
        # of keys/paths to skip. Skipping a heavy nested array drops its rows +
        # child table, so a huge nested file loads a subset far faster.
        flatten = b.get("flatten")       # tri-state: None = legacy default
        root_id = b.get("root_id") if isinstance(b.get("root_id"), dict) \
            else None                    # .521: validated again server-side
        shred = bool(b.get("shred"))
        _exc = b.get("exclude")
        if isinstance(_exc, str):
            _exc = [t.strip() for t in _exc.split(",") if t.strip()]
        exclude = [str(t).strip() for t in (_exc or []) if str(t).strip()] or None
        try:
            total = os.path.getsize(path)
        except Exception:
            total = 0
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "load", "state": "starting",
               "shred": bool(locals().get("shred")), "bytes_done": 0,
               "bytes_total": total, "rows": None,
               "name": os.path.basename(path), "error": None,
               "engine": dest, "started": time.time(), "loaded": None,
               "root_id": root_id, "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job

        before = s.snapshot_table_names()

        def run():
            job["tid"] = threading.get_ident()
            job["state"] = "reading"

            def prog(done, total_b=None):
                if job.get("cancel"):
                    raise LoadCancelled()
                job["bytes_done"] = done
                if total_b:
                    job["bytes_total"] = total_b
                # once the bytes are all read, the table write + row count still
                # run with no byte signal -- flip to "finalizing" so the UI keeps
                # showing progress instead of a bar frozen at 100%.
                if (job["state"] == "reading" and job["bytes_total"]
                        and done >= job["bytes_total"]):
                    job["state"] = "finalizing"
            prog.should_cancel = lambda: bool(job.get("cancel"))

            try:
                loaded = s.load_file(path, destination=dest, progress=prog,
                                     delimiter=delimiter, mode=mode,
                                     sheet=sheet, header_row=header_row,
                                     exclude=exclude, flatten=flatten,
                                     shred=shred,
                                     root_id=job.get("root_id"))
                job["loaded"] = loaded
                _shred_note(job, loaded)
                job["rows"] = sum((t.get("rows") or 0) for t in loaded)
                if loaded:
                    job["engine"] = loaded[0].get("engine", dest)
                job["bytes_done"] = job["bytes_total"]
                job["state"] = "done"
                s.record_load("file", path, dest,
                              base_name=(loaded[0].get("name")
                                         if loaded else None),
                              origin=path)
            except LoadCancelled:
                job["state"] = "cancelled"
                s.drop_tables_created_since(before)
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=_with_engine_slot(job, run), daemon=True).start()
        return {"job_id": job_id, "bytes_total": total, "name": job["name"]}

    @staticmethod
    def load_folder_start(s, m, body, ctx):
        b = body or {}
        path = _normalize_user_path(b.get("path") or b.get("dir"))
        if not path or not os.path.isdir(path):
            raise ApiError(400, f"Folder not found: {path}")
        dest = b.get("destination") or "auto"
        recursive = bool(b.get("recursive"))
        delimiter = b.get("delimiter")
        files = s.find_loadable_files(path, recursive)
        if not files:
            raise ApiError(
                400, "No CSV / JSON / Parquet files found in that folder.")
        sizes, total = [], 0
        for fp in files:
            try:
                sz = os.path.getsize(fp)
            except Exception:
                sz = 0
            sizes.append(sz)
            total += sz
        cum = [0]
        for sz in sizes:
            cum.append(cum[-1] + sz)
        folder_name = os.path.basename(os.path.normpath(path)) or path
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "folder", "state": "starting", "bytes_done": 0,
               "bytes_total": total, "rows": None,
               "name": f"{folder_name} (0/{len(files)})", "error": None,
               "engine": dest, "started": time.time(), "loaded": None,
               "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job

        def on_file(i, count, name):
            job["bytes_done"] = cum[i] if i < len(cum) else total
            job["name"] = f"{folder_name} ({i + 1}/{count}: {name})"

        before = s.snapshot_table_names()

        def run():
            job["tid"] = threading.get_ident()
            job["state"] = "reading"
            try:
                res = s.load_folder(path, destination=dest,
                                    recursive=recursive, on_file=on_file,
                                    delimiter=delimiter,
                                    should_cancel=lambda: job.get("cancel"))
                if res.get("cancelled") or job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                elif res.get("error"):
                    _fail_job(job, res["error"])
                else:
                    loaded = res.get("loaded") or []
                    errs = res.get("errors") or []
                    job["loaded"] = loaded
                    _shred_note(job, loaded)
                    job["rows"] = res.get("rows", 0)
                    if loaded:
                        s.record_load("folder", path, dest,
                                      recursive=recursive, origin=path)
                    if loaded:
                        job["engine"] = loaded[0].get("engine", dest)
                    job["bytes_done"] = job["bytes_total"]
                    if errs and not loaded:
                        job["state"] = "error"
                        job["error"] = "; ".join(
                            "%s: %s" % (e["file"], e["error"])
                            for e in errs[:4])
                    else:
                        job["state"] = "done"
                        if errs:
                            job["name"] = (f"{folder_name} ({len(loaded)} "
                                           f"loaded, {len(errs)} failed)")
                            job["error"] = ("Some files failed: " + "; ".join(
                                e["file"] for e in errs[:6]))
                        else:
                            job["name"] = (f"{folder_name} "
                                           f"({len(loaded)} table(s))")
            except LoadCancelled:
                job["state"] = "cancelled"
                s.drop_tables_created_since(before)
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=_with_engine_slot(job, run), daemon=True).start()
        return {"job_id": job_id, "bytes_total": total,
                "name": job["name"], "files": len(files)}

    @staticmethod
    def load_progress(s, m, body, ctx):
        job = JOBS.get(m.group("job"))
        if not job:
            raise ApiError(404, "Unknown load job")
        out = {k: job[k] for k in ("id", "state", "bytes_done",
                                   "bytes_total", "rows", "name",
                                   "error", "engine")}
        if job.get("note"):
            out["note"] = job["note"]
        if job.get("root_id_stats"):
            out["root_id_stats"] = job["root_id_stats"]
        out["elapsed_ms"] = int((time.time() - job["started"]) * 1000)
        if job["state"] in ("done", "cancelled"):
            out["loaded"] = job.get("loaded")
            out["tables"] = s.tables_tree()
        return out

    @staticmethod
    def nuke(s, m, body, ctx):
        """.523: the Activity-modal NUCLEAR RESET. Every load job is
        cancelled and forgotten, the error-dashboard buffer empties, and
        the session tears itself down to launch-empty (see
        Session.nuclear_reset). The frontend hard-reloads right after."""
        with JOBS_LOCK:
            jobs = len(JOBS)
            for j in JOBS.values():
                try:
                    j["cancel"] = True
                except Exception:
                    pass
            JOBS.clear()
        with _ERROR_LOG_LOCK:
            errs = len(_ERROR_LOG)
            try:
                _ERROR_LOG.clear()
            except Exception:
                del _ERROR_LOG[:]
        r = s.nuclear_reset()
        r["jobs_killed"] = jobs
        r["errors_cleared"] = errs
        return r

    @staticmethod
    def load_sniff(s, m, body, ctx):
        """.521: pre-load schema sniff -- the Load modal's optional
        unique-identifier (root_id) dropdown. Body: {path}. Returns
        {ok, promote, candidates:[{label, steps, in_list, map, type,
        keys?}]} or {error}."""
        files = (ctx or {}).get("files") or []
        if files:
            # drag-drop: the client uploads only a PREFIX of the file --
            # the session repairs the truncation to whole records.
            part = files[0]
            try:
                with open(part.path, "rb") as fh:
                    raw = fh.read(2 * 1024 * 1024)
            finally:
                try:
                    os.remove(part.path)
                except OSError:
                    pass
            return s.sniff_root_sample(raw, part.filename or "sample.json")
        b = body or {}
        path = b.get("path")
        if not isinstance(path, str) or not path.strip():
            return {"error": "path or sample required"}
        # .526 on-box: sniffing the file DIRECTLY made DuckDB parse the
        # whole thing when the top level is one giant record (the sophis
        # wrapper object) -- the modal timed out at 20s. Sample a PREFIX
        # of the file instead, exactly like drag-drop: the repair keeps
        # whole records (and closes a truncated wrapper), so any file
        # size sniffs in milliseconds.
        pth = path.strip()
        try:
            with open(pth, "rb") as fh:
                raw = fh.read(2 * 1024 * 1024)
        except OSError as e:
            return {"error": "could not read the file: %s" % e}
        return s.sniff_root_sample(raw, os.path.basename(pth))

    @staticmethod
    def load_cancel(s, m, body, ctx):
        """Request cancellation of an in-flight load job. Sets the job's cancel
        flag (the load's progress callback raises to unwind it) and, if this job
        is the one currently holding the engine slot, interrupts its statement
        so a big DuckDB read or long SQLite insert stops promptly. A queued job,
        or one still in its IO phase (e.g. an HDFS download), just gets the flag
        and unwinds cooperatively -- so cancelling one card never aborts another
        task's engine work. Partial tables are rolled back / dropped by the job.
        Idempotent + safe on a finished job."""
        job_id = m.group("job")
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job:
            return {"ok": False, "cancelled": False, "error": "No such job."}
        if job.get("state") in ("done", "error", "cancelled"):
            return {"ok": True, "cancelled": False, "state": job["state"]}
        job["cancel"] = True
        # Scoped interrupt: only abort the engine if THIS job currently owns the
        # slot (it's the one mid-statement). Otherwise the cancel is cooperative
        # -- interrupting here would abort whichever job holds the engine now.
        try:
            qid = job.get("query_id")
            if qid:
                s.flag_run_cancelled(qid)   # a run-job's loop stops between passes
            tid = job.get("tid")
            duck = getattr(s, "duckdb", None)
            hit = False
            if tid is not None and duck is not None:
                try:
                    with duck._native_ops_lock:
                        h = duck._native_ops.get(tid)
                    if h is not None:
                        h.interrupt()
                        hit = True
                except Exception:
                    pass
            if not hit and ENGINE_SLOT.owner() == job_id:
                # no own-cursor statement to hit: the old slot-holder
                # interrupt (main-connection load) still applies
                s.interrupt_loads()
            ENGINE_SLOT.wake()   # nudge a queued job to unwind at once
        except Exception:
            pass
        return {"ok": True, "cancelled": True, "state": "cancelling"}

    @staticmethod
    def load_jobs(s, m, body, ctx):
        """List recent/active load jobs so the UI can reattach to a load
        still running after a page reload."""
        with JOBS_LOCK:
            items = list(JOBS.values())
        items.sort(key=lambda j: j.get("started", 0))
        jobs = [{k: j.get(k) for k in ("id", "state", "bytes_done",
                                       "bytes_total", "rows", "name",
                                       "error", "engine")}
                for j in items]
        return {"jobs": jobs}

    @staticmethod
    def tasks(s, m, body, ctx):
        """Unified activity feed: every background job (load / folder / HDFS /
        convert / flatten)
        normalized into one card shape for the activity tray. Read-only; the
        client polls this in place of the per-task progress modals and
        re-discovers still-running work after a reload. A card's X cancels via
        that job's existing per-kind cancel route -- nothing here resets the
        engine."""
        with JOBS_LOCK:
            items = list(JOBS.values())
        items.sort(key=lambda j: j.get("started", 0))
        try:
            from samql_core import progress as _opreg
            from samql_core import watchdog as _wd
            ops = _opreg.count()
            stalled = bool(_wd.last_stall())
        except Exception:
            ops, stalled = 0, False
        return {"tasks": [_task_card(j) for j in items],
                "operations": ops, "stalled": stalled}

    @staticmethod
    def task_dismiss(s, m, body, ctx):
        """Permanently drop one finished task card (done/error/cancelled) from
        the activity feed, so it stays gone after the modal is reopened and in
        every place the feed is shown. A running task is never dropped here --
        use its cancel. Returns {ok}."""
        tid = m.group("tid")
        with JOBS_LOCK:
            j = JOBS.get(tid)
            if j is not None and j.get("state") in ("done", "error",
                                                    "cancelled"):
                JOBS.pop(tid, None)
        return {"ok": True}

    @staticmethod
    def tasks_clear_completed(s, m, body, ctx):
        """Drop every finished task card at once (done/error/cancelled),
        leaving anything still running untouched. Backs the 'Clear all'
        button in both the activity modal and the stat popover. Returns
        {ok, cleared}."""
        with JOBS_LOCK:
            done_ids = [k for k, j in JOBS.items()
                        if j.get("state") in ("done", "error", "cancelled")]
            for k in done_ids:
                JOBS.pop(k, None)
        return {"ok": True, "cleared": len(done_ids)}

    # ---- query / results -------------------------------------------
    @staticmethod
    def query(s, m, body, ctx):
        b = body or {}
        _sql = b.get("sql", "")
        if not isinstance(_sql, str):
            # .442 fuzz fix: a non-string sql 500'd inside run_query
            raise ApiError(400, "sql must be a string.")
        if b.get("per_statement"):
            # .458: Run-all with a per-statement result ledger.
            return s.run_script(_sql,
                                target=b.get("target", "auto"),
                                read_only=bool(b.get("read_only",
                                                     False)),
                                query_id=b.get("query_id"),
                                dialect=b.get("dialect"),
                                surface=b.get("surface"),
                                label=b.get("label"))
        # .514: remember which op this REQUEST THREAD serves -- the bounded
        # response writer polls it so Cancel aborts even the send phase.
        _REQ_LOCAL.qid = b.get("query_id")
        try:
            return s.run_query(_sql,
                               target=b.get("target", "auto"),
                               read_only=bool(b.get("read_only", False)),
                               query_id=b.get("query_id"),
                               dialect=b.get("dialect"),
                               reuse=b.get("reuse"),
                               surface=b.get("surface"),
                               label=b.get("label"),
                               preview_limit=b.get("preview_limit"))
        finally:
            pass  # qid intentionally stays set until the response is sent

    _storage_cache = {"t": 0.0, "data": None}

    @staticmethod
    def storage_report(s, m, body, ctx):
        """Everything SamQL keeps on disk, by class, with byte sizes -- the
        answer to 'why is my drive shrinking'. Pure filesystem; safe while
        anything runs.

        .510: cached for 20s. dir_size() walks every instance/_MEI tree; on
        OneDrive/AV-heavy temp a single walk can take many seconds, and the
        Activity poller re-entering it piled threads during the on-box
        first-query stall. The report is informational -- 20s staleness is
        free; the walk runs at most once per window."""
        import time as _time
        c = Api._storage_cache
        if not (body or {}).get("fresh") \
                and c["data"] is not None \
                and _time.time() - c["t"] < 20:
            return c["data"]
        import glob as _glob
        root = tmputil._ROOT
        inst = tmputil.instance_dir()

        def dsz(p):
            return tmputil.dir_size(p)
        results = sum(os.path.getsize(f) for f in
                      _glob.glob(os.path.join(inst, "qr_*"))
                      if os.path.isfile(f))
        spill = dsz(os.path.join(inst, "duckdb_spill"))
        others, others_bytes, dead = 0, 0, 0
        try:
            for name in os.listdir(root):
                if name == "filecache" or name == str(os.getpid()):
                    continue
                p = os.path.join(root, name)
                if name.isdigit() and os.path.isdir(p):
                    others += 1
                    others_bytes += dsz(p)
                    if not tmputil.pid_alive(name):
                        dead += 1
        except OSError:
            pass
        fc_dir = filecache._DIR
        fc_files = [f for f in _glob.glob(os.path.join(fc_dir, "fc_*"))
                    if os.path.isfile(f)]
        fc_bytes = sum(os.path.getsize(f) for f in fc_files)
        mei_root = tmputil.mei_root()
        cur = os.path.basename(getattr(sys, "_MEIPASS", "") or "")
        # .527 on-box: the RUNNING launcher's own extraction is locked by
        # Windows for as long as the launcher lives -- it is NOT an
        # orphan and can never be cleared from here. Label it separately
        # so the toast math and the panel stop implying it should go.
        live = os.path.basename(
            os.environ.get("SAMQL_LAUNCHER_MEI", "") or "")
        mei, mei_bytes = 0, 0
        live_bytes = 0
        try:
            for name in os.listdir(mei_root):
                if not name.startswith("_MEI") or name == cur:
                    continue
                p = os.path.join(mei_root, name)
                if not os.path.isdir(p):
                    continue
                if live and name == live:
                    live_bytes = dsz(p)
                    continue
                mei += 1
                mei_bytes += dsz(p)
        except OSError:
            pass
        out = {
            "instance": {"path": inst, "bytes": dsz(inst),
                         "results_bytes": results, "spill_bytes": spill},
            "other_instances": {"count": others, "bytes": others_bytes,
                                "dead": dead},
            "filecache": {"path": fc_dir, "count": len(fc_files),
                          "bytes": fc_bytes,
                          "budget_gb": (filecache._budget_bytes()
                                        / (1024 ** 3))},
            "mei_orphans": {"count": mei, "bytes": mei_bytes},
            "mei_live_launcher": {"present": bool(live_bytes),
                                  "bytes": live_bytes},
            "webview_cache": {"path": _webview_profile_dir(),
                              "bytes": _webview_cache_bytes()},
        }
        c["data"], c["t"] = out, _time.time()
        return out

    @staticmethod
    def storage_clean(s, m, body, ctx):
        """Reclaim by class: orphans (dead instances, zombies, _MEI launch
        leftovers) and/or the conversion cache (explicit -- clearing it makes
        the next load of each file reconvert). Returns freed bytes."""
        # .510: the report cache must never feed the CLEAN decision, and the
        # post-clean world has different sizes -- drop it on both sides.
        Api._storage_cache["data"] = None

        b = body or {}
        freed = {"orphans": 0, "filecache": 0, "webview_cache": 0}
        note = None
        if b.get("orphans"):
            before = Api.storage_report(s, m, {"fresh": 1}, ctx)
            tmputil.sweep_stale()
            tmputil.sweep_zombie_instances()
            # a USER-CLICKED clean may take young leftovers too (60s guard
            # against an actively-extracting launch); the automatic sweep at
            # open keeps its cautious hour
            tmputil.sweep_mei_orphans(min_age_sec=60)
            after = Api.storage_report(s, m, {"fresh": 1}, ctx)
            freed["orphans"] = max(0, (
                before["other_instances"]["bytes"]
                + before["mei_orphans"]["bytes"]
                - after["other_instances"]["bytes"]
                - after["mei_orphans"]["bytes"]))
            left = (after["other_instances"]["bytes"]
                    + after["mei_orphans"]["bytes"])
            if left:
                note = ("%.0f MB couldn't be removed: those files are in "
                        "use (a running instance, or Windows still holds "
                        "them) or seconds old. They clear once released -- "
                        "or at the next open." % (left / 1e6))
            _lv = after.get("mei_live_launcher") or {}
            if _lv.get("present"):
                extra = ("%.0f MB is the RUNNING launcher's own "
                         "extraction (_MEI) -- Windows locks it while the "
                         "app is open; it frees on exit."
                         % (_lv["bytes"] / 1e6))
                note = (note + " " + extra) if note else extra
        if b.get("filecache"):
            import glob as _glob
            # IN-USE GUARD (on-box 2026-07-02): loaded tables are VIEWS over
            # these cache files -- deleting one breaks every query on the
            # table ("No files found that match the pattern"). Skip any file
            # a live table still points at and SAY so.
            in_use = set()
            try:
                mgr = getattr(s, "duckdb", None)
                for src in (getattr(mgr, "table_sources", {}) or {}).values():
                    if src:
                        in_use.add(os.path.normcase(
                            os.path.abspath(str(src))))
            except Exception:
                pass
            kept = 0
            for f in _glob.glob(os.path.join(filecache._DIR, "fc_*")):
                if os.path.normcase(os.path.abspath(f)) in in_use:
                    kept += 1
                    continue
                try:
                    sz = os.path.getsize(f)
                    os.unlink(f)
                    freed["filecache"] += sz
                except OSError:
                    pass
            if kept:
                extra = ("%d cache file%s kept: loaded table%s still use%s "
                         "them (drop the table or reload to release)."
                         % (kept, "s" if kept != 1 else "",
                            "s" if kept != 1 else "",
                            "" if kept != 1 else "s"))
                note = (note + " " + extra) if note else extra
        if b.get("webview_cache"):
            fr, locked = _clear_webview_cache()
            freed["webview_cache"] = fr
            if locked:
                extra = ("%d window-cache file%s still locked by the open "
                         "window; they clear next time."
                         % (locked, "s" if locked != 1 else ""))
                note = (note + " " + extra) if note else extra
        Api._storage_cache["data"] = None
        return {"ok": True, "freed": freed, "note": note}

    @staticmethod
    def shred_preflight(s, m, body, ctx):
        q = ctx["query"]
        return s.shred_preflight((q.get("engine") or ["duckdb"])[0],
                                 (q.get("table") or [""])[0])

    @staticmethod
    def shred_plan(s, m, body, ctx):
        b = body or {}
        return s.shred_plan(b.get("engine", "duckdb"), b.get("table", ""),
                            b.get("column", ""), base=b.get("base"))

    @staticmethod
    def shred_run(s, m, body, ctx):
        b = body or {}
        return s.shred_run(b.get("engine", "duckdb"), b.get("table", ""),
                           b.get("column", ""), base=b.get("base"),
                           tables=b.get("tables"),
                           query_id=b.get("query_id"))

    @staticmethod
    def result_cell(s, m, body, ctx):
        # The full value of one truncated grid cell, under the grid's current
        # sort/filter view.
        b = body or {}
        _rid = b.get("result_id", "")
        if not isinstance(_rid, str):
            raise ApiError(400, "result_id must be a string.")
        return s.cell_value(_rid, b.get("row", -1),
                            b.get("column", ""), sort_col=b.get("sort_col"),
                            descending=bool(b.get("descending")),
                            filters=b.get("filters"))

    @staticmethod
    def query_cancel(s, m, body, ctx):
        # The global Stop / panic button. As well as the engine hammer
        # (cancel_query interrupts every engine), flag every in-flight
        # background task so its card unwinds as "cancelled" -- the interrupt
        # then lands as a rollback (partial table dropped), not a raw interrupt
        # error -- and wake the engine queue so anything still waiting for the
        # Per-run by default (.411): with loads, flattens, shreds, and
        # queries all running concurrently, Stop on one tab must not kill
        # the rest. scope="all" in the body restores the old sweep (and
        # flags every job) for the Stop-everything affordances.
        scope = (body or {}).get("scope") or "run"
        out = s.cancel_query(m.group("qid"), scope=scope)
        if scope == "all":
            _flag_all_jobs()
        ENGINE_SLOT.wake()
        return out

    @staticmethod
    def cancel_all(s, m, body, ctx):
        """A global halt for BACKGROUND jobs (loads, conversions, flattens)
        with no single foreground query in flight. The NodeFlow Stop calls
        this so it also halts tray tasks even when no foreground run is
        active.

        .554: this must NOT blanket-interrupt the engines. A bare
        ``s.interrupt_loads()`` calls DuckDB's ``interrupt()``, which aborts
        WHATEVER statement is executing on that connection right now -- so a
        Stop pressed on one surface would kill a concurrent IDE query or
        Journal cell mid-run. Instead, flag every job cooperatively (its
        loop unwinds + partial table rolls back) and interrupt the engine
        ONLY for the job that currently owns the engine slot -- exactly the
        owner-scoped pattern the per-job cancel uses. The blanket engine
        hammer now lives only in the nuclear reset (/api/nuke), the
        deliberate "nuke everything" affordance.
        """
        _flag_all_jobs()
        try:
            owner = ENGINE_SLOT.owner()
            if owner:
                with JOBS_LOCK:
                    job = JOBS.get(owner)
                # only the slot owner's in-flight statement is interrupted;
                # prefer its own-cursor handle, else the main-connection
                # load interrupt (still scoped: it IS the running load).
                tid = (job or {}).get("tid")
                duck = getattr(s, "duckdb", None)
                hit = False
                if tid is not None and duck is not None:
                    try:
                        with duck._native_ops_lock:
                            h = duck._native_ops.get(tid)
                        if h is not None:
                            h.interrupt()
                            hit = True
                    except Exception:
                        pass
                if not hit:
                    # the slot owner is a main-connection load with no
                    # own-cursor handle: interrupting the engine aborts
                    # exactly that load (it holds the slot), which is what
                    # we want -- no concurrent foreground query can hold
                    # the slot at the same time.
                    s.interrupt_loads()
        except Exception:
            pass
        ENGINE_SLOT.wake()
        return {"ok": True}

    @staticmethod
    def result_page(s, m, body, ctx):
        rid = m.group("rid")
        b = body if isinstance(body, dict) else {}
        # .520: tag this response thread with the originating run id so a
        # cancel aborts a giant page's SEND too (the .514 chunk poller),
        # not just the run response.
        _q = b.get("query_id")
        if _q:
            _REQ_LOCAL.qid = _q
        # Let Session.page perform its guarded integer coercion. Converting
        # here used to turn malformed offset/limit values into route-level
        # 500s before the clean validation path could run.
        return s.page(rid,
                      offset=b.get("offset", 0),
                      limit=b.get("limit", 5000),
                      sort_col=b.get("sort_col"),
                      descending=bool(b.get("descending", False)),
                      filters=b.get("filters"),
                      columns=b.get("columns"),
                      query_id=b.get("query_id"))

    @staticmethod
    def result_materialize(s, m, body, ctx):
        b = body or {}
        return s.materialize_result(
            m.group("rid"), b.get("name"), b.get("target", "auto"),
            query_id=b.get("query_id"))

    @staticmethod
    def result_discard(s, m, body, ctx):
        rid = m.group("rid")
        s.discard_result(rid)
        return {"ok": True}

    @staticmethod
    def result_export(s, m, body, ctx):
        rid = m.group("rid")
        b = body or {}
        fmt = (b.get("fmt") or "csv").lower()
        res = s.export(rid, fmt,
                       sort_col=b.get("sort_col"),
                       descending=bool(b.get("descending", False)),
                       query_id=b.get("export_id") or None)
        if res.get("cancelled"):
            return {"ok": False, "cancelled": True}
        if not res.get("ok"):
            raise ApiError(400, res.get("error", "Export failed."))
        ext = {"excel": "xlsx"}.get(fmt, fmt)
        ctypes = {
            "csv": "text/csv",
            "tsv": "text/tab-separated-values",
            "json": "application/json",
            "ndjson": "application/x-ndjson",
            "xlsx": ("application/vnd.openxmlformats-officedocument."
                     "spreadsheetml.sheet"),
            "parquet": "application/vnd.apache.parquet",
        }
        fname = f"samql_export.{ext}"
        if b.get("save"):
            # .510: SAVE SERVER-SIDE to the user's Downloads folder. In the
            # native pywebview window a blob-anchor "download" has no
            # download manager behind it -- the UI said "Exported" while
            # nothing reached disk. Writing the file ourselves works the
            # same in the window and a browser, and the toast can show the
            # real path. Downloads resolves via the registry (OneDrive
            # redirection honoured) with sensible fallbacks.
            import shutil as _sh
            import datetime as _dt
            dl = _downloads_dir()  # .539: the one shared ladder
            stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            out = os.path.join(dl, "samql_export_%s.%s" % (stamp, ext))
            _sh.copyfile(res["path"], out)
            try:
                if res.get("cleanup", True):
                    os.remove(res["path"])
            except Exception:
                pass
            return {"ok": True, "path": out,
                    "filename": os.path.basename(out)}
        return FileDownload(res["path"], fname,
                            ctypes.get(fmt, "application/octet-stream"))

    @staticmethod
    def save_download(s, m, body, ctx):
        """.539: write a client-composed file into the user's Downloads.
        Every text export that used a blob-anchor "download" (mapping
        templates, recon/profile CSVs, the journal graph, diagnostics,
        the error log) goes through here now -- the anchor has no
        download manager behind it in the native window, so files were
        silently never written (the .510 class, everywhere it remained).
        Text OR base64 bytes; sanitized name; collision-suffixed."""
        b = body or {}
        name = _reqstr(b, "filename")
        text = b.get("text")
        b64 = b.get("b64")
        if (text is None) == (b64 is None):
            raise ApiError(400,
                           "provide exactly one of 'text' or 'b64'.")
        if text is not None:
            if not isinstance(text, str):
                raise ApiError(400, "text must be a string.")
            raw = text.encode("utf-8")
        else:
            if not isinstance(b64, str):
                raise ApiError(400, "b64 must be a string.")
            import base64 as _b64
            try:
                raw = _b64.b64decode(b64, validate=True)
            except Exception:
                raise ApiError(400, "b64 is not valid base64.")
        if len(raw) > 64 << 20:
            raise ApiError(400, "file too large (64 MB cap).")
        dl = _downloads_dir()
        out = _downloads_filename(dl, name)
        with open(out, "wb") as fh:
            fh.write(raw)
        return {"ok": True, "path": out,
                "filename": os.path.basename(out)}

    # ---- SQL helpers -----------------------------------------------
    @staticmethod
    def sql_format(s, m, body, ctx):
        return s.format_sql((body or {}).get("sql", ""))

    @staticmethod
    def sql_statement_at(s, m, body, ctx):
        b = body or {}
        _sql = b.get("sql", "")
        if not isinstance(_sql, str):
            raise ApiError(400, "sql must be a string.")
        try:
            _pos = int(b.get("pos", 0))
        except (TypeError, ValueError):
            raise ApiError(400, "pos must be an integer.")
        return s.statement_at_cursor(_sql, _pos)

    # ---- Local SQL assistant (optional llama.cpp pack) -------------
    @staticmethod
    def assistant_models_settings(s, m, body, ctx):
        # Registered GGUF library + API endpoint + active selection
        # (ConfigStore / SecretStore). Assistant only — does not touch
        # load/join/flatten.
        if m == "GET" or body is None:
            return s.assistant_models_info()
        b = body or {}
        try:
            return s.configure_assistant_models(
                add=b.get("add"),
                remove_id=b.get("remove_id"),
                selected_id=b.get("selected_id") if "selected_id" in b else None,
                use_default=bool(b.get("use_default")),
                clear=bool(b.get("clear")),
                # Explicit key (even null) means update selection; omit = leave as-is.
                update_selected=True if "selected_id" in b else (
                    True if b.get("use_default") else False
                ),
                mode=b.get("mode") if "mode" in b else None,
                api=b.get("api") if isinstance(b.get("api"), dict) else None,
                clear_api=bool(b.get("clear_api")),
                test_api=bool(b.get("test_api")),
            )
        except ValueError as e:
            raise ApiError(400, str(e))

    @staticmethod
    def assistant_status(s, m, body, ctx):
        from samql_core import assistant as _asst
        # Keep preferred path / API runtime aligned with Settings.
        try:
            s._sync_assistant_preferred()
        except Exception:
            pass
        try:
            s._sync_assistant_api()
        except Exception:
            pass
        return _asst.status(s)

    @staticmethod
    def assistant_chat(s, m, body, ctx):
        # English → DuckDB/SparkSQL via local llama-server or configured
        # OpenAI-compatible API. Refuses while DuckDB is busy; never mutates
        # load/join/flatten state.
        from samql_core import assistant as _asst
        b = body or {}
        question = b.get("question", "")
        if not isinstance(question, str):
            raise ApiError(400, "question must be a string.")
        dialect = b.get("dialect", "native")
        if not isinstance(dialect, str):
            dialect = "native"
        return _asst.chat(s, question, dialect=dialect)

    @staticmethod
    def assistant_cancel(s, m, body, ctx):
        from samql_core import assistant as _asst
        return _asst.cancel()

    # ---- history / saved -------------------------------------------
    @staticmethod
    def history_get(s, m, body, ctx):
        return {"history": s.history_all()}

    @staticmethod
    def history_clear(s, m, body, ctx):
        return s.history_clear()

    @staticmethod
    def errors_get(s, m, body, ctx):
        # newest first; the buffer is small and copied under the lock
        with _ERROR_LOG_LOCK:
            items = list(reversed(_ERROR_LOG))
        return {"errors": items, "count": len(items),
                "version": __version__,
                "file": _tail_text(_error_file_path()),
                "launcher": _tail_text(_launcher_log_path())}

    @staticmethod
    def errors_clear(s, m, body, ctx):
        try:
            os.unlink(_error_file_path())
        except OSError:
            pass
        with _ERROR_LOG_LOCK:
            _ERROR_LOG.clear()
        return {"ok": True}

    @staticmethod
    def saved_get(s, m, body, ctx):
        return {"saved": s.saved_all()}

    @staticmethod
    def saved_upsert(s, m, body, ctx):
        b = body or {}
        return s.saved_upsert(b.get("name"), b.get("sql"), b.get("tags"))

    @staticmethod
    def saved_delete(s, m, body, ctx):
        return s.saved_delete((body or {}).get("name"))

    # ---- saved NodeFlow workflows ----------------------------------
    @staticmethod
    def workflows_get(s, m, body, ctx):
        return s.workflows_all()

    @staticmethod
    def workflow_load(s, m, body, ctx):
        b = body or {}
        return s.workflow_get(b.get("name"), b.get("kind") or "node")

    @staticmethod
    def workflow_save(s, m, body, ctx):
        b = body or {}
        return s.workflow_save(b.get("name"), b.get("graph"),
                               b.get("kind") or "node")

    @staticmethod
    def workflow_delete(s, m, body, ctx):
        b = body or {}
        return s.workflow_delete(b.get("name"), b.get("kind") or "node")

    # ---- read/write a workflow file anywhere on disk (Save As / Open) ----
    @staticmethod
    def workspace_save_file(s, m, body, ctx):
        b = body or {}
        path = _reqstr(b, "path").strip()
        content = b.get("content")
        if not path:
            raise ApiError(400, "No file path was given.")
        if not isinstance(content, str):
            raise ApiError(400, "Nothing to save.")
        if len(content) > 50_000_000:
            raise ApiError(400, "That file is too large to save.")
        parent = os.path.dirname(path) or "."
        if not os.path.isdir(parent):
            raise ApiError(400, "That folder does not exist: %s" % parent)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            raise ApiError(400, "Could not write the file: %s" % e)
        return {"ok": True, "path": path, "name": os.path.basename(path)}

    @staticmethod
    def workspace_open_file(s, m, body, ctx):
        b = body or {}
        path = _reqstr(b, "path").strip()
        if not path or not os.path.isfile(path):
            raise ApiError(400, "File not found: %s" % path)
        try:
            if os.path.getsize(path) > 50_000_000:
                raise ApiError(400, "That file is too large to open.")
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as e:
            raise ApiError(400, "Could not read the file: %s" % e)
        return {"ok": True, "path": path, "name": os.path.basename(path),
                "content": content}

    # ---- analytics: chart / pivot / reconcile ----------------------
    @staticmethod
    def chart_data(s, m, body, ctx):
        b = dict(body or {})
        if not isinstance(b.get("table", ""), str):
            raise ApiError(400, "table must be a string.")
        # chart_data self-registers against the agg interrupt target -- do
        # not wrap with _run_op (would discard the cancelled flag mid-send).
        if not b.get("query_id"):
            b["query_id"] = "chart-%s" % uuid.uuid4().hex[:10]
        _REQ_LOCAL.qid = b.get("query_id")
        return s.chart_data(b)

    @staticmethod
    def pivot(s, m, body, ctx):
        b = body or {}
        if not isinstance(b.get("table", ""), str):
            raise ApiError(400, "table must be a string.")
        _REQ_LOCAL.qid = b.get("query_id")
        return s.pivot(b)

    @staticmethod
    def reconcile(s, m, body, ctx):
        b = body or {}
        _REQ_LOCAL.qid = b.get("query_id")
        return s.reconcile(b)

    @staticmethod
    def reconcile_drilldown(s, m, body, ctx):
        b = body or {}
        _REQ_LOCAL.qid = b.get("query_id")
        return s.reconcile_drilldown(b)

    @staticmethod
    def reconcile_failures(s, m, body, ctx):
        """.540: the FULL failed-values CSV -- every mismatching key +
        field with its left/right values (the union of the per-field
        drill-downs), written straight into the user's Downloads."""
        b = body or {}
        res = s.reconcile_failures_export(
            b, query_id=b.get("export_id") or None)
        if res.get("cancelled"):
            return {"ok": False, "cancelled": True}
        if not res.get("ok"):
            raise ApiError(400, res.get("error", "Export failed."))
        import re as _re
        import shutil as _sh

        def _safe(t):
            return _re.sub(r"[^A-Za-z0-9_.-]+", "_", str(t or ""))[:40]

        dl = _downloads_dir()
        name = "recon_failures_%s_vs_%s.csv" % (_safe(b.get("left")),
                                                _safe(b.get("right")))
        out = _downloads_filename(dl, name)
        _sh.copyfile(res["path"], out)
        try:
            os.remove(res["path"])
        except OSError:
            pass
        return {"ok": True, "path": out, "rows": res.get("rows", 0),
                "fields": res.get("fields", 0)}

    @staticmethod
    def reconcile_profile(s, m, body, ctx):
        # reconcile_profile self-registers -- do not wrap with _run_op.
        b = body or {}
        _REQ_LOCAL.qid = b.get("query_id")
        return s.reconcile_profile(b)

    # ---- REST API loader -------------------------------------------
    @staticmethod
    def api_fetch(s, m, body, ctx):
        b = body or {}
        pwd = b.get("auth_pass")
        sk = b.get("secret_key")
        if not pwd and sk:
            pwd = s.secrets.get(sk)
        _REQ_LOCAL.qid = b.get("query_id")
        return s.load_api(b.get("url", ""),
                          base_name=b.get("base_name", "api_data"),
                          auth_user=b.get("auth_user"),
                          auth_pass=pwd,
                          json_path=b.get("json_path"),
                          params=b.get("params"),
                          destination=b.get("destination") or "auto",
                          query_id=b.get("query_id"))

    @staticmethod
    def api_node_fetch(s, m, body, ctx):
        # the graph API node: fetch + load into the node's hidden table,
        # resolving ${vars} from the graph and the password from the store.
        b = body or {}
        return s.fetch_api_node(b.get("node_id"), b.get("config") or {},
                                graph=b.get("graph"),
                                query_id=b.get("query_id"))

    @staticmethod
    def node_source_fetch(s, m, body, ctx):
        """Fetch for SQL Server / SharePoint / Web scrape (and API) source nodes."""
        b = body or {}
        return s.fetch_source_node(
            b.get("type") or "",
            b.get("node_id"),
            b.get("config") or {},
            graph=b.get("graph"),
            query_id=b.get("query_id"),
        )

    @staticmethod
    def sharepoint_download(s, m, body, ctx):
        b = body or {}
        return s.download_sharepoint_file(
            b.get("config") or b, query_id=b.get("query_id"))

    @staticmethod
    def sharepoint_auth_capabilities(s, m, body, ctx):
        return s.sharepoint_auth_capabilities()

    @staticmethod
    def sharepoint_auth_device_start(s, m, body, ctx):
        b = body or {}
        return s.sharepoint_auth_device_start(b.get("config") or b)

    @staticmethod
    def sharepoint_auth_device_poll(s, m, body, ctx):
        b = body or {}
        return s.sharepoint_auth_device_poll(
            b.get("flow_id") or "", block=bool(b.get("block")))

    @staticmethod
    def sharepoint_auth_interactive(s, m, body, ctx):
        b = body or {}
        return s.sharepoint_auth_interactive(b.get("config") or b)

    @staticmethod
    def iterator_run(s, m, body, ctx):
        # the iterator node: loop a driver's values, run the body each pass with
        # the loop variable set, and append into one accumulator table.
        b = body or {}
        return s.run_iterator(_reqdict(b, "graph"), b.get("node_id"),
                              query_id=b.get("query_id"))

    @staticmethod
    def while_run(s, m, body, ctx):
        # the while/until controller: repeat the body until an iteration adds no
        # new rows (a fixpoint) or the iteration cap is hit.
        b = body or {}
        return s.run_while(_reqdict(b, "graph"), b.get("node_id"),
                           query_id=b.get("query_id"))

    @staticmethod
    def api_preview(s, m, body, ctx):
        b = body or {}
        pwd = b.get("auth_pass")
        sk = b.get("secret_key")
        if not pwd and sk:
            pwd = s.secrets.get(sk)
        return s.preview_api(b.get("url", ""),
                             auth_user=b.get("auth_user"),
                             auth_pass=pwd,
                             json_path=b.get("json_path"),
                             params=b.get("params"))

    # ---- saved secrets (DPAPI-encrypted passwords) -----------------
    @staticmethod
    def secrets_available(s, m, body, ctx):
        return {"available": s.secrets.available}

    @staticmethod
    def secrets_set(s, m, body, ctx):
        b = body or {}
        ok = s.secrets.set(b.get("key"), b.get("value"))
        return {"ok": ok, "available": s.secrets.available}

    @staticmethod
    def secrets_delete(s, m, body, ctx):
        b = body or {}
        return {"ok": s.secrets.delete(b.get("key"))}

    @staticmethod
    def secrets_status(s, m, body, ctx):
        b = body or {}
        keys = b.get("keys") or []
        return {"available": s.secrets.available,
                "saved": {k: s.secrets.has(k) for k in keys}}

    # ---- named connection profiles (fields + DPAPI secret by key) ----
    @staticmethod
    def connection_profiles_list(s, m, body, ctx):
        return {"profiles": s.connection_profiles.list(secrets=s.secrets),
                "secrets_available": s.secrets.available}

    @staticmethod
    def connection_profiles_upsert(s, m, body, ctx):
        b = body or {}
        kind = b.get("kind") or ""
        name = b.get("name") or ""
        fields = b.get("fields") if isinstance(b.get("fields"), dict) else {}
        try:
            entry = s.connection_profiles.upsert(kind, name, fields)
        except ValueError as e:
            raise ApiError(400, str(e))
        key = entry.get("key")
        password = b.get("password")
        if password is not None and password != "" and key:
            s.secrets.set(key, password)
        return {"ok": True, "profile": entry,
                "has_secret": bool(key and s.secrets.has(key)),
                "secrets_available": s.secrets.available}

    @staticmethod
    def connection_profiles_delete(s, m, body, ctx):
        b = body or {}
        key = b.get("key") or ""
        ok = s.connection_profiles.delete(key)
        if key:
            s.secrets.delete(key)
        return {"ok": ok}

    @staticmethod
    def connection_profiles_get(s, m, body, ctx):
        b = body or {}
        key = b.get("key") or ""
        entry = s.connection_profiles.get(key)
        if not entry:
            raise ApiError(404, "No connection profile named %r." % key)
        return {"profile": entry,
                "has_secret": s.secrets.has(key),
                "secrets_available": s.secrets.available}

    # ---- MSSQL (optional) ------------------------------------------
    @staticmethod
    def mssql_drivers(s, m, body, ctx):
        from samql_core.mssql import odbc_drivers, HAS_PYODBC
        return {"available": HAS_PYODBC, "drivers": odbc_drivers()}

    @staticmethod
    def mssql_connect(s, m, body, ctx):
        from samql_core.mssql import (SQLServerConnection,
                                      build_mssql_conn_str,
                                      split_domain_user,
                                      classify_mssql_error, HAS_PYODBC)
        if not HAS_PYODBC:
            raise ApiError(400, "pyodbc is not installed on the server.")
        b = dict(body or {})
        # Named profile: merge stored non-secret fields, then pull password
        # from DPAPI via secret_key / profile_key.
        pk = b.get("profile_key") or ""
        if pk:
            prof = s.connection_profiles.get(pk)
            if prof:
                for k, v in (prof.get("fields") or {}).items():
                    if b.get(k) in (None, ""):
                        b[k] = v
                if not b.get("secret_key"):
                    b["secret_key"] = pk
                if not b.get("name"):
                    b["name"] = prof.get("name") or pk
        name = b.get("name") or b.get("server") or "mssql"
        auth = b.get("auth", "windows")
        # Password: use the one supplied, else fall back to a DPAPI-saved
        # secret for this profile (so a saved profile connects with a blank
        # password field).
        pwd = b.get("pwd", "")
        if not pwd and b.get("secret_key"):
            pwd = s.secrets.get(b.get("secret_key")) or ""
        # 'Alternate Windows account' authenticates via LogonUser /netonly
        # impersonation -- the connection string stays Trusted, the alternate
        # identity is applied around connect/execute.
        alt_creds = None
        if auth == "windows_alt":
            domain, user = split_domain_user(b.get("user", ""))
            alt_creds = (domain, user, pwd)
        try:
            conn_str = b.get("conn_str") or build_mssql_conn_str(
                b.get("driver"), b.get("server"), b.get("port", ""),
                auth, b.get("user", ""),
                pwd, bool(b.get("encrypt", True)),
                bool(b.get("trust", True)),
                bool(b.get("multi_subnet", False)), b.get("extra", ""))
            conn = SQLServerConnection(
                name, conn_str, alt_creds=alt_creds,
                login_timeout=int(b.get("login_timeout", 15)),
                stmt_timeout=int(b.get("stmt_timeout", 0)),
                read_only=bool(b.get("read_only", True)))
        except Exception as e:
            cause, fix = classify_mssql_error(str(e))
            from samql_core.errfmt import err_str, redact_secrets
            raise ApiError(
                400,
                "%s\n%s\n%s" % (err_str(e), redact_secrets(cause), redact_secrets(fix)),
            )
        s.connections[name] = conn
        return {"ok": True, "name": name, "spid": getattr(conn, "spid", None),
                "databases": conn.list_databases()}

    @staticmethod
    def mssql_disconnect(s, m, body, ctx):
        name = (body or {}).get("name")
        conn = s.connections.pop(name, None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        s.forget_catalog(name)  # drop its catalog tables from the panel
        return {"ok": True}

    @staticmethod
    def mssql_catalog(s, m, body, ctx):
        b = body or {}
        return s.load_catalog(b.get("name"), b.get("database") or None)

    @staticmethod
    def flatten_start(s, m, body, ctx):
        """Run a JSON flatten+export in the background so the UI can show a
        progress bar (reading bytes, then writing CSVs)."""
        b = body or {}
        src = b.get("json_path") or b.get("path")
        out_dir = b.get("out_dir") or b.get("output_dir")
        base_name = b.get("base_name") or None
        if not src or not os.path.isfile(src):
            raise ApiError(400, f"JSON file not found: {src}")
        try:
            total = os.path.getsize(src)
        except Exception:
            total = 0
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "flatten", "state": "starting",
               "stage": "reading", "bytes_done": 0, "bytes_total": total,
               "records": 0, "tables_done": 0, "tables_total": 0,
               "detail": "", "name": os.path.basename(src),
               "started": time.time(), "result": None, "error": None,
               "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job

        def run():
            job["state"] = "running"

            def prog(info):
                st = info.get("stage")
                if st:
                    job["stage"] = st
                for k in ("bytes_done", "bytes_total", "records",
                          "tables_done", "tables_total", "detail"):
                    if k in info:
                        job[k] = info[k]

            try:
                res = s.flatten_json_to_csv_dir(
                    src, out_dir, base_name, progress=prog,
                    cancel=lambda: bool(job.get("cancel")))
                if res.get("error"):
                    _fail_job(job, res["error"])
                else:
                    job["result"] = res
                    job["stage"] = "done"
                    job["state"] = "done"
            except LoadCancelled:
                job["state"] = "cancelled"
                job["stage"] = "cancelled"
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    job["stage"] = "cancelled"
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=run, daemon=True).start()
        return {"job_id": job_id, "bytes_total": total, "name": job["name"]}

    @staticmethod
    def flatten_progress(s, m, body, ctx):
        job = JOBS.get(m.group("job"))
        if not job or job.get("kind") != "flatten":
            raise ApiError(404, "Unknown flatten job")
        out = {k: job[k] for k in ("id", "state", "stage", "bytes_done",
                                   "bytes_total", "records", "tables_done",
                                   "tables_total", "detail", "name", "error")}
        out["elapsed_ms"] = int((time.time() - job["started"]) * 1000)
        if job["state"] == "done":
            out["result"] = job.get("result")
        return out

    @staticmethod
    def flatten_cancel(s, m, body, ctx):
        """Request cancellation of an in-flight flatten job. Sets the cancel flag
        (the worker checks it between records and tables, unwinds with
        LoadCancelled, and removes the CSVs it had written this run). Idempotent
        + safe on a finished job."""
        job_id = m.group("job")
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job or job.get("kind") != "flatten":
            return {"ok": False, "cancelled": False, "error": "No such job."}
        if job.get("state") in ("done", "error", "cancelled"):
            return {"ok": True, "cancelled": False, "state": job["state"]}
        job["cancel"] = True
        return {"ok": True, "cancelled": True, "state": "cancelling"}

    @staticmethod
    def flatten_table_start(s, m, body, ctx):
        """Flatten a selected nest into relational tables in the background
        (Field Explorer / activity tray). Keeps the source table; scopes to
        optional ``column`` / ``path``. Accepts ``root_id`` so every family
        table carries ``root_id`` and Master_Keys + Join_Keys tables are built.
        Returns {job_id, name}."""
        name = unquote(m.group("name"))
        b = body or {}
        engine = b.get("engine", "duckdb")
        root_id = b.get("root_id")
        if root_id is not None and not isinstance(root_id, dict):
            raise ApiError(400, "root_id must be an object.")
        column = b.get("column")
        if column is not None and not isinstance(column, str):
            raise ApiError(400, "column must be a string.")
        path = b.get("path")
        if path is not None and not isinstance(path, (str, list)):
            raise ApiError(400, "path must be a string or list.")
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "flatten", "state": "starting",
               "bytes_done": 0, "bytes_total": 0, "rows": 0,
               "name": name, "engine": engine, "started": time.time(),
               "query_id": job_id, "loaded": None, "error": None,
               "cancel": False, "column": column, "path": path}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job

        def run():
            job["state"] = "running"
            try:
                # Field Explorer: keep the nested source table; only the
                # selected nest becomes a family (+ Master_Keys). Load-time
                # flatten still uses session.flatten_table without
                # keep_source (replaces by design).
                res = s.flatten_table(
                    name, query_id=job_id, root_id=root_id,
                    keep_source=True, column=column, path=path)
                if res.get("cancelled"):
                    job["state"] = "cancelled"
                elif res.get("error"):
                    _fail_job(job, res["error"])
                else:
                    created = res.get("created") or []
                    job["loaded"] = created
                    job["rows"] = sum(int(c.get("rows") or 0) for c in created)
                    job["method"] = "flatten_table"
                    job["key"] = "root_id" if root_id else None
                    job["root_id"] = res.get("root_id")
                    job["kept_source"] = True
                    job["state"] = "done"
            except LoadCancelled:
                job["state"] = "cancelled"
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=run, daemon=True).start()
        return {"job_id": job_id, "name": name}

    @staticmethod
    def table_root_id_options(s, m, body, ctx):
        b = body or {}
        name = unquote(m.group("name"))
        return s.table_root_id_options(b.get("engine", "duckdb"), name)

    @staticmethod
    def table_root_id_stats(s, m, body, ctx):
        b = body or {}
        name = unquote(m.group("name"))
        rid = b.get("root_id")
        if not isinstance(rid, dict):
            raise ApiError(400, "root_id is required.")
        return s.table_root_id_stats(b.get("engine", "duckdb"), name, rid)

    @staticmethod
    def nodeflow_run(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.run_nodeflow(
            graph, b.get("node"), b.get("port") or "out",
            query_id=b.get("query_id"), preview=bool(b.get("preview")),
            preview_limit=b.get("preview_limit"))

    @staticmethod
    def nodeflow_run_batch(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.run_nodeflows(
            graph, b.get("requests") or [],
            query_id=b.get("query_id"), preview=bool(b.get("preview")),
            preview_limit=b.get("preview_limit"))

    @staticmethod
    def nodeflow_columns(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.nodeflow_columns(graph, b.get("node"), b.get("port") or "out")

    @staticmethod
    def nodeflow_columns_batch(s, m, body, ctx):
        b = body or {}
        graph = _reqdict(b, "graph") if b.get("graph") is not None \
            else {}
        return s.nodeflow_columns_batch(graph, b.get("requests") or [])

    @staticmethod
    def nodeflow_chart(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.run_nodeflow_chart(graph, b.get("node"), b.get("spec") or {},
                                    query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_browse(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.run_nodeflow_browse(graph, b.get("node"),
                                     query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_validate(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.validate_nodeflow(graph, b.get("node"), b.get("checks") or [],
                                   query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_reconcile(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.run_nodeflow_reconcile(
            graph, b.get("node"), b.get("keys") or [],
            b.get("compare") or [], b.get("balance"),
            query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_export(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.export_nodeflow(graph, b.get("node"),
                                 b.get("out_dir") or b.get("output_dir"),
                                 b.get("format") or b.get("fmt") or "csv",
                                 b.get("base_name"),
                                 query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_export_many(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") or {}
        return s.export_nodeflow_many(graph, b.get("items") or [],
                                      query_id=b.get("query_id"))

    @staticmethod
    def nodeflow_lineage(s, m, body, ctx):
        b = body or {}
        graph = _reqdict(b, "graph") if b.get("graph") is not None \
            else {}
        res = s.nodeflow_lineage(graph)
        if not res.get("ok"):
            raise ApiError(400, res.get("error", "Lineage export failed."))
        if b.get("save"):
            # .539: same .510 rule as every export -- write it to
            # Downloads ourselves; the blob anchor is a no-op in the
            # native window.
            import shutil as _sh
            dl = _downloads_dir()
            out = _downloads_filename(dl, "samql_lineage.xlsx")
            _sh.copyfile(res["path"], out)
            try:
                os.remove(res["path"])
            except OSError:
                pass
            return {"ok": True, "path": out,
                    "filename": os.path.basename(out)}
        return FileDownload(
            res["path"], "samql_lineage.xlsx",
            "application/vnd.openxmlformats-officedocument."
            "spreadsheetml.sheet")

    @staticmethod
    def nodeflow_column_lineage(s, m, body, ctx):
        b = body or {}
        graph = b.get("graph") if isinstance(b.get("graph"), dict) else {}
        column = (b.get("column") or "").strip()
        if not column:
            raise ApiError(400, "column is required.")
        node = (b.get("node") or b.get("node_id") or "").strip() or None
        port = (b.get("port") or "").strip() or None
        row_index = b.get("row_index")
        if row_index is None:
            row_index = b.get("rowIndex")
        cell_value = b.get("cell_value")
        if cell_value is None and "cellValue" in b:
            cell_value = b.get("cellValue")
        return s.nodeflow_column_lineage(
            graph, column, node_id=node, port=port,
            row_index=row_index, cell_value=cell_value)

    @staticmethod
    def nodeflow_write(s, m, body, ctx):
        b = body or {}
        graph = _reqdict(b, "graph")
        return s.run_nodeflow_to_table(
            graph, b.get("node"), b.get("name") or "flow_result",
            query_id=b.get("query_id"))

    @staticmethod
    def mssql_tables(s, m, body, ctx):
        b = body or {}
        conn = s.connections.get(b.get("name"))
        if conn is None:
            raise ApiError(400, "Connection is not active.")
        tbls = conn.list_tables(b.get("database") or None)
        return {"tables": [{"schema": sch, "name": nm} for sch, nm in tbls]}

    @staticmethod
    def mssql_import(s, m, body, ctx):
        b = body or {}
        _REQ_LOCAL.qid = b.get("query_id")
        return s.import_from_connection(
            b.get("name"), b.get("query", ""), b.get("base_name", "import"),
            destination=b.get("destination", "duckdb"),
            query_id=b.get("query_id"))

    @staticmethod
    def catalog_columns(s, m, body, ctx):
        q = ctx.get("query") or {}
        name = (q.get("name") or [""])[0]
        return s.catalog_columns(name)

    @staticmethod
    def catalog_import(s, m, body, ctx):
        b = body or {}
        return s.import_catalog_table(b.get("name"))

    @staticmethod
    def table_create(s, m, body, ctx):
        b = body or {}
        return s.create_table_from_grid(
            b.get("name", "table"), b.get("columns", []), b.get("rows", []),
            destination=b.get("destination", "auto"))

    @staticmethod
    def directory_read(s, m, body, ctx):
        b = body or {}
        return s.load_directory_file(b.get("path") or "",
                                     query_id=b.get("query_id"))

    @staticmethod
    def folder_read(s, m, body, ctx):
        b = body or {}
        return s.load_folder_files(b.get("folder") or "",
                                   query_id=b.get("query_id"))

    @staticmethod
    def export_image(s, m, body, ctx):
        b = body or {}
        return s.write_image(
            b.get("dir") or "", b.get("base_name") or "chart",
            b.get("format") or "png", b.get("data_url") or "")

    @staticmethod
    def hdfs_connect(s, m, body, ctx):
        b = body or {}
        return s.hdfs_connect(b.get("url") or "", user=b.get("user") or None)

    @staticmethod
    def hdfs_browse(s, m, body, ctx):
        b = body or {}
        return s.hdfs_browse(b.get("path") or "/")

    @staticmethod
    def hdfs_load_file_start(s, m, body, ctx):
        """Stream ONE browsed HDFS file (CSV/TSV/JSON/Parquet) and load it -- by default a
        zero-copy DuckDB view (mode='view') so big files are queried in place,
        not held in memory -- on the shared load job rail. The progress window
        shows the download by bytes and its Cancel / X stop it (reuses
        /api/load/progress + /api/load/cancel). Body: {path, destination?,
        mode?, base_name?}."""
        b = body or {}
        rp = (_reqstr(b, "path")).strip()
        if not rp:
            raise ApiError(400, "No HDFS file path given.")
        if s._hdfs is None:
            raise ApiError(400, "Not connected to HDFS.")
        destination = b.get("destination") or "auto"
        mode = b.get("mode") or "view"
        base_name = b.get("base_name") or None
        total = 0   # best-effort size -> a determinate progress bar
        try:
            st = s._hdfs.get_json(rp, "GETFILESTATUS") or {}
            total = int(((st.get("FileStatus") or {}).get("length")) or 0)
        except Exception:
            total = 0
        job_id = uuid.uuid4().hex[:12]
        nm = os.path.basename(rp.rstrip("/")) or rp
        job = {"id": job_id, "kind": "hdfs", "state": "starting", "bytes_done": 0,
               "bytes_total": total, "rows": None, "name": nm,
               "error": None, "engine": destination, "started": time.time(),
               "loaded": None, "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job
        before = s.snapshot_table_names()

        def run():
            job["tid"] = threading.get_ident()
            job["state"] = "reading"
            try:
                def prog(done):
                    if job.get("cancel"):
                        raise LoadCancelled()
                    job["bytes_done"] = done
                    if (job["bytes_total"]
                            and job["bytes_done"] >= job["bytes_total"]):
                        job["state"] = "finalizing"

                res = s.hdfs_load_file(
                    rp, destination=destination, mode=mode, base_name=base_name,
                    cancel=lambda: bool(job.get("cancel")), progress=prog)
                if res.get("error"):
                    _fail_job(job, res["error"])
                else:
                    loaded = res.get("tables") or []
                    job["loaded"] = loaded
                    _shred_note(job, loaded)
                    job["rows"] = sum((t.get("rows") or 0) for t in loaded)
                    if loaded:
                        job["engine"] = loaded[0].get("engine", destination)
                    job["bytes_done"] = job["bytes_total"] or job["bytes_done"]
                    job["state"] = "done"
                    s.record_load("hdfs", rp, destination)
            except LoadCancelled:
                job["state"] = "cancelled"
                s.drop_tables_created_since(before)
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=run, daemon=True).start()
        return {"job_id": job_id, "bytes_total": total, "name": nm}

    @staticmethod
    def table_optimize_start(s, m, body, ctx):
        """Convert ONE file-backed DuckDB view (e.g. an HDFS CSV/JSON loaded as
        a zero-copy view) into columnar Parquet and re-point it -- on the shared
        load job rail, so the progress window's Cancel / X stop it. The COPY is
        a single statement, so a Stop aborts it via interrupt (reuses
        /api/load/progress + /api/load/cancel); the partial Parquet is removed
        and the original view is left intact. Body: {name}. DuckDB-only."""
        b = body or {}
        name = (b.get("name") or "").strip()
        if not name:
            raise ApiError(400, "No table name given.")
        if s.duckdb is None:
            raise ApiError(400, "Converting to Parquet needs the DuckDB engine.")
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": "convert", "state": "starting", "bytes_done": 0,
               "bytes_total": 0, "rows": None, "name": name,
               "error": None, "engine": "duckdb", "started": time.time(),
               "loaded": None, "cancel": False}
        with JOBS_LOCK:
            for k, v in list(JOBS.items()):
                if v.get("done_at") and time.time() - v["done_at"] > 300:
                    JOBS.pop(k, None)
            JOBS[job_id] = job
        before = s.snapshot_table_names()

        def run():
            job["tid"] = threading.get_ident()
            job["state"] = "reading"
            try:
                res = s.optimize_to_parquet(
                    name, cancel=lambda: bool(job.get("cancel")))
                if res.get("error"):
                    _fail_job(job, res["error"])
                else:
                    job["name"] = res.get("name", name)
                    job["state"] = "done"
            except LoadCancelled:
                job["state"] = "cancelled"
                s.drop_tables_created_since(before)
            except Exception as e:
                if job.get("cancel"):
                    job["state"] = "cancelled"
                    s.drop_tables_created_since(before)
                else:
                    _fail_job(job, err_str(e))
            finally:
                job["done_at"] = time.time()

        threading.Thread(target=_with_engine_slot(job, run), daemon=True).start()
        return {"job_id": job_id, "bytes_total": 0, "name": name}



ROUTES = [
    ("GET", r"^/api/health$", Api.health),
    ("GET", r"^/api/features$", Api.features),
    ("GET", r"^/api/status$", Api.status),
    ("GET", r"^/api/docs/functions$", Api.docs_functions),
    ("GET", r"^/api/diagnostics$", Api.diagnostics),
    ("POST", r"^/api/diagnostics/run$", Api.diagnostics_run),
    ("POST", r"^/api/engine/reset$", Api.engine_reset),
    ("POST", r"^/api/settings/concurrent-reads$", Api.concurrent_reads),
    ("POST", r"^/api/settings/flatten-json$", Api.flatten_json_setting),
    ("GET", r"^/api/settings/load-thresholds$", Api.load_thresholds_settings),
    ("POST", r"^/api/settings/load-thresholds$", Api.load_thresholds_settings),
    ("GET", r"^/api/tables$", Api.tables),
    ("POST", r"^/api/tables/reorder$", Api.tables_reorder),
    ("POST", r"^/api/column/fields$", Api.column_fields),
    ("POST", r"^/api/column/access-preview$", Api.column_access_preview),
    ("POST", r"^/api/load/files$", Api.load_files),
    ("POST", r"^/api/load/files-start$", Api.load_files_start),
    ("POST", r"^/api/excel/sheets$", Api.excel_sheets),
    ("POST", r"^/api/json/fields$", Api.json_fields),
    ("POST", r"^/api/excel/peek$", Api.excel_peek),
    ("GET", r"^/api/fs/list$", Api.fs_list),
    ("POST", r"^/api/load/preflight$", Api.load_preflight),
    ("POST", r"^/api/load/start$", Api.load_start),
    ("POST", r"^/api/load/folder$", Api.load_folder_start),
    ("GET", r"^/api/load/jobs$", Api.load_jobs),
    ("GET", r"^/api/tasks$", Api.tasks),
    ("POST", r"^/api/tasks/clear-completed$", Api.tasks_clear_completed),
    ("POST", r"^/api/tasks/(?P<tid>[^/]+)/dismiss$", Api.task_dismiss),
    ("GET", r"^/api/load/progress/(?P<job>[^/]+)$", Api.load_progress),
    ("POST", r"^/api/load/cancel/(?P<job>[^/]+)$", Api.load_cancel),
    ("POST", r"^/api/load/sniff$", Api.load_sniff),
    ("POST", r"^/api/nuke$", Api.nuke),
    ("POST", r"^/api/query$", Api.query),
    ("POST", r"^/api/query/(?P<qid>[^/]+)/cancel$", Api.query_cancel),
    ("POST", r"^/api/result/cell$", Api.result_cell),
    ("GET", r"^/api/storage/report$", Api.storage_report),
    ("POST", r"^/api/storage/clean$", Api.storage_clean),
    ("GET", r"^/api/shred/preflight$", Api.shred_preflight),
    ("POST", r"^/api/shred/plan$", Api.shred_plan),
    ("POST", r"^/api/shred/run$", Api.shred_run),
    ("POST", r"^/api/cancel-all$", Api.cancel_all),
    ("POST", r"^/api/result/(?P<rid>[^/]+)/page$", Api.result_page),
    ("POST", r"^/api/result/(?P<rid>[^/]+)/export$", Api.result_export),
    ("POST", r"^/api/result/(?P<rid>[^/]+)/materialize$",
     Api.result_materialize),
    ("DELETE", r"^/api/result/(?P<rid>[^/]+)$", Api.result_discard),
    ("POST", r"^/api/table/(?P<name>[^/]+)/profile$", Api.table_profile),
    ("POST", r"^/api/profile/field$", Api.profile_field),
    ("POST", r"^/api/table/(?P<name>[^/]+)/flatten$", Api.table_flatten),
    ("POST", r"^/api/table/(?P<name>[^/]+)/flatten-start$", Api.flatten_table_start),
    ("POST", r"^/api/table/(?P<name>[^/]+)/root-id-options$",
     Api.table_root_id_options),
    ("POST", r"^/api/table/(?P<name>[^/]+)/root-id-stats$",
     Api.table_root_id_stats),
    ("POST", r"^/api/table/(?P<name>[^/]+)/fields$", Api.table_fields),
    ("POST", r"^/api/table/rename$", Api.table_rename),
    ("POST", r"^/api/table/drop$", Api.table_drop),
    ("POST", r"^/api/table/optimize-start$", Api.table_optimize_start),
    ("POST", r"^/api/table/change-type$", Api.table_change_type),
    ("POST", r"^/api/materialize$", Api.materialize),
    ("POST", r"^/api/clear$", Api.clear_all),
    ("POST", r"^/api/shutdown$", Api.shutdown),
    ("POST", r"^/api/focus$", Api.focus),
    ("GET", r"^/api/about$", Api.about),
    ("POST", r"^/api/table/properties$", Api.table_properties),
    ("GET", r"^/api/memory$", Api.memory),
    ("POST", r"^/api/memory/free$", Api.memory_free),
    ("POST", r"^/api/engine/tuning$", Api.engine_tuning),
    ("GET", r"^/api/settings/flow-cache$", Api.flow_cache_settings),
    ("POST", r"^/api/settings/flow-cache$", Api.flow_cache_settings),
    ("POST", r"^/api/maintenance/sweep-temp$", Api.maintenance_sweep_temp),
    ("POST", r"^/api/run-tests$", Api.run_tests),
    ("POST", r"^/api/sql/format$", Api.sql_format),
    ("POST", r"^/api/sql/statement-at$", Api.sql_statement_at),
    ("GET", r"^/api/assistant/status$", Api.assistant_status),
    ("POST", r"^/api/assistant/chat$", Api.assistant_chat),
    ("POST", r"^/api/assistant/cancel$", Api.assistant_cancel),
    ("GET", r"^/api/settings/assistant-models$", Api.assistant_models_settings),
    ("POST", r"^/api/settings/assistant-models$", Api.assistant_models_settings),
    ("GET", r"^/api/history$", Api.history_get),
    ("DELETE", r"^/api/history$", Api.history_clear),
    ("GET", r"^/api/errors$", Api.errors_get),
    ("DELETE", r"^/api/errors$", Api.errors_clear),
    ("GET", r"^/api/saved$", Api.saved_get),
    ("POST", r"^/api/saved$", Api.saved_upsert),
    ("DELETE", r"^/api/saved$", Api.saved_delete),
    ("GET", r"^/api/workflows$", Api.workflows_get),
    ("POST", r"^/api/workflows$", Api.workflow_save),
    ("POST", r"^/api/workflows/load$", Api.workflow_load),
    ("DELETE", r"^/api/workflows$", Api.workflow_delete),
    ("POST", r"^/api/workspace/save-file$", Api.workspace_save_file),
    ("POST", r"^/api/workspace/open-file$", Api.workspace_open_file),
    ("POST", r"^/api/chart/data$", Api.chart_data),
    ("POST", r"^/api/pivot$", Api.pivot),
    ("POST", r"^/api/reconcile$", Api.reconcile),
    ("POST", r"^/api/reconcile/drilldown$", Api.reconcile_drilldown),
    ("POST", r"^/api/reconcile/profile$", Api.reconcile_profile),
    ("POST", r"^/api/reconcile/failures$", Api.reconcile_failures),
    ("POST", r"^/api/api-fetch$", Api.api_fetch),
    ("POST", r"^/api/node-api-fetch$", Api.api_node_fetch),
    ("POST", r"^/api/node-source-fetch$", Api.node_source_fetch),
    ("POST", r"^/api/sharepoint/download$", Api.sharepoint_download),
    ("POST", r"^/api/sharepoint/auth/capabilities$",
     Api.sharepoint_auth_capabilities),
    ("POST", r"^/api/sharepoint/auth/device/start$",
     Api.sharepoint_auth_device_start),
    ("POST", r"^/api/sharepoint/auth/device/poll$",
     Api.sharepoint_auth_device_poll),
    ("POST", r"^/api/sharepoint/auth/interactive$",
     Api.sharepoint_auth_interactive),
    ("POST", r"^/api/iterator/run$", Api.iterator_run),
    ("POST", r"^/api/while/run$", Api.while_run),
    ("POST", r"^/api/api-preview$", Api.api_preview),
    ("POST", r"^/api/secrets/available$", Api.secrets_available),
    ("POST", r"^/api/secrets/set$", Api.secrets_set),
    ("POST", r"^/api/secrets/delete$", Api.secrets_delete),
    ("POST", r"^/api/secrets/status$", Api.secrets_status),
    ("POST", r"^/api/connection-profiles/list$", Api.connection_profiles_list),
    ("POST", r"^/api/connection-profiles/upsert$", Api.connection_profiles_upsert),
    ("POST", r"^/api/connection-profiles/delete$", Api.connection_profiles_delete),
    ("POST", r"^/api/connection-profiles/get$", Api.connection_profiles_get),
    ("GET", r"^/api/mssql/drivers$", Api.mssql_drivers),
    ("POST", r"^/api/mssql/connect$", Api.mssql_connect),
    ("POST", r"^/api/mssql/tables$", Api.mssql_tables),
    ("POST", r"^/api/mssql/catalog$", Api.mssql_catalog),
    ("POST", r"^/api/flatten/start$", Api.flatten_start),
    ("GET", r"^/api/flatten/progress/(?P<job>[^/]+)$", Api.flatten_progress),
    ("POST", r"^/api/flatten/cancel/(?P<job>[^/]+)$", Api.flatten_cancel),
    ("POST", r"^/api/nodeflow/run$", Api.nodeflow_run),
    ("POST", r"^/api/nodeflow/run-batch$", Api.nodeflow_run_batch),
    ("POST", r"^/api/nodeflow/columns$", Api.nodeflow_columns),
    ("POST", r"^/api/nodeflow/columns-batch$", Api.nodeflow_columns_batch),
    ("POST", r"^/api/nodeflow/chart$", Api.nodeflow_chart),
    ("POST", r"^/api/nodeflow/browse$", Api.nodeflow_browse),
    ("POST", r"^/api/nodeflow/validate$", Api.nodeflow_validate),
    ("POST", r"^/api/nodeflow/reconcile$", Api.nodeflow_reconcile),
    ("POST", r"^/api/nodeflow/export$", Api.nodeflow_export),
    ("POST", r"^/api/nodeflow/export-many$", Api.nodeflow_export_many),
    ("POST", r"^/api/nodeflow/lineage$", Api.nodeflow_lineage),
    ("POST", r"^/api/nodeflow/column-lineage$", Api.nodeflow_column_lineage),
    ("POST", r"^/api/save/download$", Api.save_download),
    ("POST", r"^/api/nodeflow/write$", Api.nodeflow_write),
    ("POST", r"^/api/mssql/import$", Api.mssql_import),
    ("GET", r"^/api/catalog/columns$", Api.catalog_columns),
    ("POST", r"^/api/catalog/import$", Api.catalog_import),
    ("POST", r"^/api/table/create$", Api.table_create),
    ("POST", r"^/api/directory/read$", Api.directory_read),
    ("POST", r"^/api/folder/read$", Api.folder_read),
    ("POST", r"^/api/export/image$", Api.export_image),
    ("DELETE", r"^/api/mssql/connection$", Api.mssql_disconnect),
    ("POST", r"^/api/hdfs/connect$", Api.hdfs_connect),
    ("POST", r"^/api/hdfs/browse$", Api.hdfs_browse),
    ("POST", r"^/api/hdfs/load-file-start$", Api.hdfs_load_file_start),
]
_COMPILED = [(meth, re.compile(pat), fn) for meth, pat, fn in ROUTES]


# --------------------------------------------------------------------- #
# Request handler
# --------------------------------------------------------------------- #
_REQ_LOCAL = threading.local()   # .514: the op id whose response this thread
                                 # is currently sending (cancel can abort it)


def _send_cancelled():
    """True when the op whose response THIS thread is writing has been
    cancelled -- a Cancel click then aborts the send within one chunk
    instead of pushing megabytes to a client that no longer wants them."""
    qid = getattr(_REQ_LOCAL, "qid", None)
    if not qid:
        return False
    try:
        return bool(SESSION is not None
                    and SESSION._run_is_cancelled(qid))
    except Exception:
        return False


def _write_all_bounded(wfile, sock, data, per_send=15.0, total=30.0,
                       chunk=256 * 1024):
    """Write ``data`` to ``wfile`` without letting a client that has STOPPED
    READING wedge the request thread forever.

    SamQL serves on loopback, so a healthy browser drains a response instantly;
    a send that can't finish within these bounds means the client is frozen
    (e.g. its JS thread is blocked parsing a huge page) or gone. The default
    single-shot ``wfile.write(data)`` on such a client blocks in ``sendall``
    with no way out -- and enough of those saturate the browser's ~6-connection
    per-host pool, starving the very status/cancel polls the user needs. So:
    bound EACH send with a short socket timeout AND the TOTAL with a deadline (a
    slow-drip client that trickles a few bytes keeps resetting the per-send
    timer, so the per-send bound alone isn't enough), then raise on either --
    the caller (`_send_bytes`) catches OSError/TimeoutError and retires the
    connection, freeing the thread and the pool slot. The socket's prior timeout
    is always restored. Pure/​injectable -> unit testable with fake sock/wfile."""
    if not data:
        return
    mv = memoryview(data)
    n = len(mv)
    try:
        prev = sock.gettimeout()
    except Exception:
        prev = None
    start = time.monotonic()
    try:
        try:
            sock.settimeout(per_send)
        except Exception:
            pass
        i = 0
        while i < n:
            if time.monotonic() - start > total:
                raise TimeoutError(
                    "response send stalled (> %.0fs); client not reading"
                    % total)
            # .514: a cancelled op's response is aborted mid-send -- the
            # thread frees within one chunk instead of finishing a payload
            # nobody wants (the on-box "cancel does nothing" while a thread
            # sat in socket write).
            if _send_cancelled():
                raise TimeoutError("response send cancelled")
            wfile.write(mv[i:i + chunk])
            i += chunk
        try:
            wfile.flush()
        except Exception:
            pass
    finally:
        try:
            sock.settimeout(prev)
        except Exception:
            pass


def _csv_env(name):
    return {item.strip().lower() for item in
            (os.environ.get(name) or "").split(",") if item.strip()}


def _host_name(value):
    """Return a normalized hostname from a Host header / URL netloc."""
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        return (urlparse("//" + raw).hostname or "").rstrip(".").lower()
    except Exception:
        return ""


def _origin_netloc(value):
    try:
        parsed = urlparse((value or "").strip())
    except Exception:
        return ""
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return parsed.netloc.lower()


class Handler(BaseHTTPRequestHandler):
    # a dead/wedged client socket must never hold a request thread forever
    # (on-box 2026-07-02: a thread sat in socket close after a cancel)
    timeout = 60
    server_version = "SamQL/" + __version__
    protocol_version = "HTTP/1.1"
    # The UI fires many tiny requests (progress polls, column batches, run
    # status). Send small packets immediately instead of letting Nagle's
    # algorithm coalesce them -- on a loopback API that only adds latency, so
    # TCP_NODELAY keeps every interaction snappy. (Bandwidth isn't a concern
    # locally; round-trip latency is.)
    disable_nagle_algorithm = True

    # quieter logging
    def log_message(self, fmt, *args):
        if os.environ.get("SAMQL_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- low-level write helpers -----------------------------------
    def _drain_body(self, length, cap=64 * 1024 * 1024):
        """Best-effort read-and-discard of an unconsumed request body so the
        response lands cleanly and the connection can close gracefully.
        Bounded by ``cap``; a stalled sender hits the socket timeout."""
        try:
            left = min(int(length or 0), cap)
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
        except Exception:
            pass
        self.close_connection = True

    def _send_json(self, status, payload):
        try:
            self._send_bytes(status, _encode_json(payload),
                             "application/json; charset=utf-8")
        finally:
            # .514: this thread's send is over -- drop the op tag so a
            # keep-alive follow-up on the same thread can't inherit it
            try:
                _REQ_LOCAL.qid = None
            except Exception:
                pass

    def _send_bytes(self, status, data, content_type, extra_headers=None):
        headers = dict(extra_headers or {})
        if str(content_type or "").lower().startswith("text/html"):
            token = str(getattr(self.server, "samql_api_token", "") or "")
            if token and "Set-Cookie" not in headers:
                headers["Set-Cookie"] = _api_token_set_cookie(token)
        enc = None
        # Transparently gzip large, compressible payloads when the client
        # asks for it (result pages and the JS bundle compress a lot;
        # level 1 keeps CPU negligible). Never for small bodies.
        try:
            accepts = "gzip" in (self.headers.get("Accept-Encoding") or "")
        except Exception:
            accepts = False
        # .514: never gzip huge bodies -- level-1 on tens of MB holds the
        # GIL long enough to starve every other request (cancel, health).
        if (accepts and 4096 <= len(data) <= 32 * 1024 * 1024
                and _compressible(content_type)
                and "Content-Encoding" not in headers):
            try:
                import gzip as _gz
                data = _gz.compress(data, 1)
                enc = "gzip"
            except Exception:
                enc = None
        try:
            self._send_bytes_raw(status, data, content_type, headers, enc)
        except (BrokenPipeError, ConnectionResetError,
                ConnectionAbortedError, OSError):
            # the client went away mid-response (a cancelled fetch, a closed
            # tab) OR stopped reading so the bounded write timed out (a frozen
            # tab -- TimeoutError is an OSError). Never let this escape: an
            # escaped write error tears the keep-alive socket mid-frame and the
            # browser's NEXT request on it fails as an opaque "Failed to fetch".
            # Retire the connection instead; the browser opens a fresh one.
            self.close_connection = True

    def _send_bytes_raw(self, status, data, content_type, headers, enc):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if enc:
            self.send_header("Content-Encoding", enc)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers.items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            _write_all_bounded(self.wfile, getattr(self, "connection", None),
                               data)

    def _send_file_download(self, fd: FileDownload):
        try:
            size = os.path.getsize(fd.path)
            self.send_response(200)
            self.send_header("Content-Type", fd.content_type)
            self.send_header("Content-Length", str(size))
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{fd.filename}"')
            self._cors()
            self.end_headers()
            if self.command != "HEAD":
                with open(fd.path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError,
                                ConnectionAbortedError, OSError):
                            self.close_connection = True
                            break
        finally:
            if fd.cleanup:
                try:
                    os.unlink(fd.path)
                except Exception:
                    pass

    def _request_host_allowed(self):
        """Block DNS-rebinding and unintended remote access by default.

        Loopback names are always valid. A non-loopback bind address is valid
        when the server was started on that exact host. Additional names can be
        supplied through SAMQL_ALLOWED_HOSTS as a comma-separated allowlist.
        Wildcard binds (0.0.0.0 / ::) do not implicitly trust every Host.
        """
        host = _host_name(self.headers.get("Host"))
        if not host:
            return False
        allowed = {"localhost", "127.0.0.1", "::1"}
        allowed.update(_csv_env("SAMQL_ALLOWED_HOSTS"))
        try:
            bound = str(self.server.server_address[0]).rstrip(".").lower()
            configured = str(getattr(self.server, "samql_bind_host", "")) \
                .rstrip(".").lower()
        except Exception:
            bound = configured = ""
        for candidate in (bound, configured):
            if candidate and candidate not in ("0.0.0.0", "::", ""):
                allowed.add(candidate)
        return host in allowed

    def _request_origin_allowed(self):
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return True  # CLI/native clients do not send Origin.
        if origin.lower() == "null":
            return False
        origin_netloc = _origin_netloc(origin)
        request_netloc = (self.headers.get("Host") or "").strip().lower()
        if origin_netloc and origin_netloc == request_netloc:
            return True
        return origin.lower() in _csv_env("SAMQL_ALLOWED_ORIGINS")

    def _api_token_required(self, method, path):
        # Health is used by launch/reuse probes before any HTML exists.
        # Focus stays token-free only for loopback peers (second-launch attach).
        # Shutdown is token-free on loopback so the app-window launcher (and
        # Exit → Stop server from a fresh curl) can stop the backend without
        # first scraping the HTML-injected cookie -- remote clients still need
        # the token.
        if path == "/api/health" and method in ("GET", "HEAD"):
            return False
        if path == "/api/focus" and method == "POST":
            return not self._client_is_loopback()
        if path == "/api/shutdown" and method == "POST":
            return not self._client_is_loopback()
        return True

    def _client_is_loopback(self):
        try:
            addr = self.client_address[0]
        except Exception:
            return False
        return _is_loopback_host(str(addr))

    def _request_api_token_allowed(self):
        expected = str(getattr(self.server, "samql_api_token", "") or "")
        if not expected:
            return False
        supplied = str(self.headers.get("X-SamQL-Token") or "")
        if not supplied:
            supplied = _token_from_cookie_header(self.headers.get("Cookie"))
        return bool(supplied and hmac.compare_digest(expected, supplied))

    def _emit_api_token_cookie(self):
        token = str(getattr(self.server, "samql_api_token", "") or "")
        if token:
            self.send_header("Set-Cookie", _api_token_set_cookie(token))

    def _request_boundary_allowed(self):
        return self._request_host_allowed() and self._request_origin_allowed()

    def _cors(self):
        # Same-origin requests need no CORS header. For an explicitly approved
        # development origin, echo that exact value -- never use a wildcard.
        origin = (self.headers.get("Origin") or "").strip()
        if origin and self._request_origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, X-SamQL-Token")

    # ---- verbs ------------------------------------------------------
    def do_OPTIONS(self):
        if not self._request_boundary_allowed():
            self._send_json(403, {"error": "Request origin or host is not allowed."})
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    # ---- core dispatch ---------------------------------------------
    def _content_length(self):
        raw = (self.headers.get("Content-Length") or "0").strip()
        try:
            length = int(raw, 10)
        except Exception as exc:
            raise ValueError("Invalid Content-Length header.") from exc
        if length < 0:
            raise ValueError("Invalid Content-Length header.")
        return length

    def _read_body(self, length):
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _reject_request(self, status, payload):
        """Reject a request without leaving unread bytes on HTTP/1.1.

        Windows resets a connection that is closed with an unread POST body.
        That can erase the intended 403/413 response and desynchronise a later
        request on the same socket. Drain the declared body first (bounded by
        ``_drain_body``), then send the response and retire the connection.
        """
        try:
            length = self._content_length()
        except ValueError:
            length = 0
        self._drain_body(length)
        self._send_json(status, payload)

    def _dispatch(self, method):
        if not self._request_boundary_allowed():
            self._reject_request(
                403, {"error": "Request origin or host is not allowed."})
            return
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            if (self._api_token_required(method, path)
                    and not self._request_api_token_allowed()):
                self._reject_request(
                    403, {"error": "Missing or invalid SamQL API token."})
                return
            self._dispatch_api(method, parsed)
            return
        # everything else -> static frontend
        if method == "GET":
            if self._serve_brand(path):
                return
            self._serve_static(path)
        else:
            self._send_json(405, {"error": "Method not allowed"})

    def _dispatch_api(self, method, parsed):
        ctx = {"query": parse_qs(parsed.query)}
        try:
            return self._dispatch_api_inner(method, parsed, ctx)
        finally:
            _cleanup_uploaded_parts(ctx.get("files"))

    def _dispatch_api_inner(self, method, parsed, ctx):
        path = parsed.path
        # Launcher / second-instance probes only need the app marker. Answer
        # BEFORE get_session() so a long cold Session()+restore cannot make
        # every /api/health probe time out and trip AppWindow's boot budget.
        # Static UI assets also do not need the session; API routes below
        # still wait on get_session() as before.
        if path == "/api/health" and method in ("GET", "HEAD"):
            self._send_json(200, _health_payload(SESSION))
            return
        body = None
        raw = b""
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" in ctype:
            # STREAMED (audit 2026-07-02 B, wave 2): the body is never
            # buffered -- file parts spool straight to temp, so a multi-GB
            # drop costs disk, not RAM. An optional ceiling remains for
            # admins (SAMQL_UPLOAD_MB; finite by default, 0 disables),
            # checked from the header alone.
            try:
                length = self._content_length()
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                self.close_connection = True
                return
            cap = _upload_cap_bytes()
            if cap and length > cap:
                self._drain_body(length)
                self._send_json(413, {"error": (
                    "That upload is %.1f GB, above the configured %d MB "
                    "limit (SAMQL_UPLOAD_MB). Load it by file path instead "
                    "(Load a Table \u2192 File)."
                    % (length / 1e9, cap // (1024 * 1024)))})
                return
            try:
                fields, files = stream_multipart(self.rfile, ctype, length)
            except Exception as e:
                # A malformed/oversized multipart body must not escape this
                # handler -- an unhandled exception here closes the socket
                # with no response, which the browser reports as the opaque
                # "Failed to fetch". Return a clear 400 instead.
                log_server_error(method, path, 400, "BadUpload",
                                 err_str(e))
                # DRAIN before responding (on-box 2026-07-02): the unread
                # request body desyncs the keep-alive stream, and Windows
                # RSTs a close-with-unread-data -- killing the 400 in
                # flight ("a parse failure must not drop the connection").
                # Read out what's left (bounded), answer cleanly, retire.
                self._drain_body(length)
                self._send_json(400, {
                    "error": "Could not read the uploaded data "
                             "(malformed multipart body)."})
                self.close_connection = True
                return
            ctx["fields"] = fields
            ctx["files"] = files
            body = {}
        else:
            try:
                length = self._content_length()
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                self.close_connection = True
                return
            cap = _json_body_cap_bytes()
            if cap and length > cap:
                # Reject before buffering. Drain the declared body first so a
                # managed-Windows TCP stack does not reset the connection and
                # erase the 413 while the client is still finishing its write.
                self._drain_body(length)
                self._send_json(413, {"error": (
                    "JSON request body is above the configured %d MB limit "
                    "(SAMQL_JSON_BODY_MB)." % (cap // (1024 * 1024)))})
                return
            try:
                raw = self._read_body(length)
            except Exception:
                raw = b""
        if body is None and raw:
            if "application/json" in ctype or raw[:1] in (b"{", b"["):
                try:
                    body = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json(400, {"error": "Invalid JSON body."})
                    return
                # .442 fuzz fix: an ARRAY or scalar body reached every
                # handler's body.get() and 500'd with AttributeError.
                # Reject the whole class here, once.
                if body is not None and not isinstance(body, dict):
                    self._send_json(
                        400, {"error": "JSON body must be an object."})
                    return
            else:
                body = {}
        # Match a route.
        for meth, rx, fn in _COMPILED:
            if meth != method:
                continue
            mobj = rx.match(path)
            if not mobj:
                continue
            try:
                s = get_session()
                result = fn(s, mobj, body, ctx)
            except ApiError as e:
                log_server_error(method, path, e.status, "ApiError",
                                 e.message, detail=_request_detail(body, ctx))
                self._send_json(e.status, {"error": e.message})
                return
            except Exception as e:
                tb = traceback.format_exc()
                if os.environ.get("SAMQL_VERBOSE"):
                    sys.stderr.write(tb + "\n")
                log_server_error(method, path, 500, "ServerError",
                                 err_str(e), tb=tb,
                                 detail=_request_detail(body, ctx))
                self._send_json(500, {"error": err_str(e)})
                self.close_connection = True
                return
            if isinstance(result, FileDownload):
                self._send_file_download(result)
            else:
                try:
                    _log_soft_result_error(method, path, result, body, ctx)
                except Exception:
                    pass
                self._send_json(200, result)
            return
        # Do not send the 404 until streamed multipart spools are gone.
        # Otherwise the client can observe the response before the dispatcher's
        # outer ``finally`` has reclaimed the file (especially on Windows).
        if ctx.get("files"):
            _cleanup_uploaded_parts(ctx.get("files"))
            ctx["files"] = []
        self._send_json(404, {"error": f"No route for {method} {path}"})

    # ---- brand assets (favicon / manifest) -------------------------
    def _serve_brand(self, path):
        """Serve the SamQL app icon, favicon and web manifest, so the browser
        tab shows the SamQL mark and an installed-app manifest is available.

        A real file bundled in the frontend build wins -- drop your own PNG into
        frontend/public/app-icon.png to override; otherwise the embedded asset
        is used, so the icon still works from a text-only source transfer that
        shipped no binary. The response is sent ``no-store``: the icon is tiny,
        and this keeps a freshly rebuilt logo from being masked by a cached copy
        (browsers cache favicons aggressively). Returns True when handled
        here."""
        if path == "/samql.ico":
            ap = _authoritative_ico()
            if ap:
                try:
                    with open(ap, "rb") as fh:
                        self._send_bytes(200, fh.read(), "image/x-icon",
                                         {"Cache-Control": "max-age=60",
                                          "X-SamQL-Brand": "authoritative"})
                    return True
                except OSError:
                    pass
            self._send_bytes(404, b"no authoritative icon",
                             "text/plain", {})
            return True
        images = ("/favicon.ico", "/app-icon.png", "/logo.png",
                  "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png")
        manifests = ("/manifest.webmanifest", "/manifest.json")
        if path not in images and path not in manifests:
            return False
        # .469: no-store STARVED Edge's favicon service -- an --app
        # window adopts the page icon only once the favicon cache may
        # keep it, so the window and taskbar fell back to the Edge
        # logo. Sixty seconds still turns a rebuilt logo around fast.
        headers = {"Cache-Control": "max-age=60"}
        # A real file overrides the embedded one: exe-adjacent
        # frontend_dist first (frozen), then the served build.
        bundled, src_tag = _brand_lookup(os.path.basename(path))
        if path in manifests:
            if bundled:
                return False  # a real manifest was shipped; let static serve it
            data = json.dumps(_brand.web_manifest()).encode("utf-8")
            self._send_bytes(200, data, "application/manifest+json", headers)
            return True
        if path.endswith(".ico"):
            # One resolver owns the exact favicon bytes. It handles a real
            # multi-size ICO, derives one from either supported PNG name, and
            # rejects malformed overrides before falling back to the embedded
            # multi-size SQ mark.
            data, brand_src = _favicon_ico_bytes()
        else:
            brand_src = "embedded"
            if bundled:
                with open(bundled, "rb") as fh:
                    data = fh.read()
                brand_src = "%s %s" % (src_tag, os.path.basename(path))
            else:
                data = _brand.app_icon_png()
        if not data:
            return False  # nothing to serve -> let static/SPA handle it
        # .469: name the source so the launch scripts (and a human with
        # curl) can see AT A GLANCE whether custom art is being served.
        headers["X-SamQL-Brand"] = brand_src
        ctype = "image/x-icon" if path.endswith(".ico") else "image/png"
        self._send_bytes(200, data, ctype, headers)
        return True

    # ---- static serving --------------------------------------------
    def _serve_static(self, path):
        frontend_dir = _frontend_dir_live()
        if frontend_dir is None:
            # No build yet: serve placeholder for the root, 404 otherwise.
            if path in ("/", "/index.html"):
                data = _inject_api_token_html(
                    _PLACEHOLDER_HTML.encode("utf-8"),
                    getattr(self.server, "samql_api_token", ""))
                self._send_bytes(200, data, "text/html; charset=utf-8")
            else:
                self._send_bytes(404, b"Not found", "text/plain")
            return
        rel = path.lstrip("/")
        if rel == "":
            rel = "index.html"
        # Prevent sibling-prefix traversal and symlink escapes. String-prefix
        # checks are not containment checks (``dist_evil`` starts with ``dist``).
        root = os.path.realpath(frontend_dir)
        full = os.path.realpath(os.path.join(root, rel))
        try:
            contained = os.path.commonpath([root, full]) == root
        except (ValueError, OSError):
            contained = False
        if not contained:
            self._send_bytes(403, b"Forbidden", "text/plain")
            return
        if not os.path.isfile(full):
            # SPA fallback: serve index.html for client-side routes.
            full = os.path.join(frontend_dir, "index.html")
            if not os.path.isfile(full):
                self._send_bytes(404, b"Not found", "text/plain")
                return
        ctype, _ = mimetypes.guess_type(full)
        ctype = ctype or "application/octet-stream"
        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception:
            self._send_bytes(500, b"Read error", "text/plain")
            return
        headers = {}
        # long-cache fingerprinted assets, no-cache the HTML shell
        if "/assets/" in path:
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            headers["Cache-Control"] = "no-cache"
        if ctype == "text/html":
            data = _inject_api_token_html(
                data, getattr(self.server, "samql_api_token", ""))
        if ctype.startswith("text/") or ctype in (
                "application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send_bytes(200, data, ctype, headers)


# --------------------------------------------------------------------- #
# Server lifecycle / launcher
# --------------------------------------------------------------------- #
def _find_free_port(host, preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 50)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sk:
            sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sk.bind((host, port))
                return port
            except OSError:
                continue
    return preferred


class _QuietServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that doesn't dump a traceback when the *client*
    drops the connection mid-response.

    The browser does this constantly and harmlessly: it cancels in-flight
    requests when you navigate, supersedes a running query, or stops polling a
    progress endpoint while a reply is still being written. The work already
    finished server-side -- only delivering the response failed -- so the write
    raises a ConnectionError ([WinError 10053] / ECONNRESET / broken pipe) that
    is nothing to act on. Swallow that family quietly; let every other error
    print as usual so genuine bugs still surface.
    """
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], ConnectionError):
            return  # client went away before we finished writing -- benign
        super().handle_error(request, client_address)


def make_server(host="127.0.0.1", port=8765):
    if not _is_loopback_host(host) and not _env_truthy("SAMQL_ALLOW_REMOTE"):
        raise SystemExit(
            "Refusing to bind SamQL to non-loopback host %r without "
            "SAMQL_ALLOW_REMOTE=1 (filesystem and outbound-fetch APIs are "
            "powerful on a shared network)." % (host,)
        )
    port = _find_free_port(host, port)
    httpd = _QuietServer((host, port), Handler)
    # Port 0 asks the OS for an ephemeral port. Return the ACTUAL bound port,
    # not the requested zero -- subprocess tests and embedders otherwise try
    # to connect to port 0 even though the server is listening elsewhere.
    port = int(httpd.server_address[1])
    httpd.samql_bind_host = host
    httpd.samql_api_token = _new_api_token()
    httpd.daemon_threads = True
    return httpd, port


def _chromium_candidates(env=None):
    """Ordered list of likely Chrome/Edge executable paths. Chrome is preferred
    (the browser we open the UI in); Edge follows because it is almost always
    present on managed/Citrix Windows. Built from the standard install roots,
    the registry App Paths, and PATH, so it copes with per-user installs and
    non-default locations."""
    env = os.environ if env is None else env
    roots = [env.get("PROGRAMFILES"), env.get("PROGRAMFILES(X86)"),
             env.get("PROGRAMW6432"), env.get("LOCALAPPDATA")]
    rel = [("chrome", os.path.join("Google", "Chrome", "Application",
                                   "chrome.exe")),
           ("edge", os.path.join("Microsoft", "Edge", "Application",
                                 "msedge.exe"))]
    out = []
    for name, tail in rel:
        for root in roots:
            if root:
                out.append(os.path.join(root, tail))
        try:
            import winreg  # Windows only; ignored elsewhere
            exe = "chrome.exe" if name == "chrome" else "msedge.exe"
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    key = winreg.OpenKey(
                        hive,
                        r"SOFTWARE\Microsoft\Windows\CurrentVersion"
                        r"\App Paths" + "\\" + exe)
                    val, _ = winreg.QueryValueEx(key, None)
                    if val:
                        out.append(val)
                except OSError:
                    pass
        except Exception:
            pass
    import shutil as _sh
    for cand in ("chrome", "google-chrome", "chromium", "msedge"):
        p = _sh.which(cand)
        if p:
            out.append(p)
    seen, uniq = set(), []
    for p in out:
        if p and p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def _find_chromium(exists=os.path.isfile, env=None):
    """First existing Chrome/Edge executable on this machine, or None."""
    for p in _chromium_candidates(env):
        try:
            if exists(p):
                return p
        except Exception:
            pass
    return None


def _launch_browser_window(url):
    """Open ``url`` in a normal Chrome/Edge browser window (tabs + address
    bar), preferring Chrome and falling back to Edge. Returns True if a browser
    was launched, False when none is found -- the caller then falls back to the
    system default browser.

    This is an ordinary window using the user's regular browser profile, so the
    UI's localStorage (saved views, preferences, panel sizes) persists there as
    it would in any tab. It is *not* a process we own or wait on: launching may
    just open a tab in an already-running browser and return immediately, so the
    server's lifetime is governed by Ctrl+C / the console close handler, not by
    this window."""
    exe = _find_chromium()
    if not exe:
        return False
    try:
        subprocess.Popen([exe, url])
        return True
    except Exception:
        return False


def _webview_storage_path():
    """.490: a STABLE per-user folder for the native window's cookies /
    localStorage / IndexedDB, so `--window` keeps state across launches like
    a browser tab (which uses the browser's own persistent profile) instead
    of pywebview's throwaway private session. Same path the SamQL-AppWindow
    launcher uses, so both entry points share persisted state."""
    base = (os.environ.get("LOCALAPPDATA")
            or os.environ.get("APPDATA")
            or os.path.expanduser("~"))
    path = os.path.join(base, "SamQL", "webview")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path


def _open_window_or_browser(url, mode):
    """Open the UI.

      'auto'    -- open a normal browser window, preferring Chrome, then Edge,
                   then the system default browser.
      'browser' -- force the system default browser.
      'window'  -- open a native pywebview window if pywebview is installed,
                   otherwise fall back to the default browser.
      'none'    -- open nothing.

    Returns a tag the main loop waits on:
      ("webview", webview, url) -- run the pywebview loop
      None -- nothing to wait on (a browser window/tab, or headless)
    """
    if mode == "none":
        return None
    if mode == "window":
        try:
            import webview  # pywebview, optional
            return ("webview", webview, url)
        except Exception as _imp:
            print("pywebview not importable (%r); opening the default "
                  "browser instead." % (_imp,))
            try:
                webbrowser.open(url)
            except Exception:
                pass
            return None
    # 'auto' opens a normal Chrome/Edge window when one is present; 'auto'
    # without a Chromium browser, and 'browser', fall through to the default.
    if mode == "auto" and _launch_browser_window(url):
        return None
    try:
        webbrowser.open(url)
    except Exception:
        pass
    return None


def main(argv=None):
    args = _build_arg_parser().parse_args(argv)
    mode = _ui_mode(args)

    # Defensive re-check (the module entry point also checks before the heavy
    # import): if a copy started in the meantime, surface it and stop.
    if mode != "none" and _probe_existing(args.host, args.port):
        url = "http://%s:%s/" % (args.host, args.port)
        if not (mode == "window" and _ask_focus(args.host, args.port)):
            try:
                webbrowser.open(url)
            except Exception:
                pass
        print("\n  SamQL is already running at %s -- brought it to the front.\n"
              % url, flush=True)
        return

    # .547: publish OUR onefile extraction as PROTECTED so a later
    # launch's _MEI sweep can't delete the dir our bundled frontend is
    # served from (the reattach 'Not found'). Best-effort marker file
    # under the temp root; the launcher's early sweep reads it.
    try:
        _mp = getattr(sys, "_MEIPASS", None)
        # .549: onefile only. In onedir _MEIPASS is a permanent
        # _internal/ dir beside the exe (under no temp root), never
        # swept -- no protection marker needed.
        _troot = os.path.normcase(os.path.abspath(tempfile.gettempdir()))
        _here = os.path.normcase(os.path.abspath(_mp)) if _mp else ""
        if _mp and _here.startswith(_troot):
            keep = os.path.join(tempfile.gettempdir(),
                                ".samql_keep_mei")
            with open(keep, "w", encoding="utf-8") as _fh:
                _fh.write(os.path.basename(_mp) + "\n")
    except Exception:
        pass

    # The greeting + loading bar are started before the heavy import near the
    # top of this file. Reuse that bar (or start one, if main() was invoked
    # without going through the module entry point) and advance it per phase.
    global _BOOT_BAR
    bar = _BOOT_BAR
    if bar is None:
        bar = _BootBar()
        bar.set("starting up")
        bar.start()

    # Clean up after any previous instance that didn't exit cleanly
    # (e.g. the terminal was closed before the server was stopped). First wipe
    # our OWN instance dir to a clean slate (guards the rare PID-reuse case
    # where a dead same-PID instance left files sweep_stale won't touch), then
    # sweep the directories of other instances whose process has exited. Runs
    # before the engine warms, so no live temp is at risk.
    try:
        tmputil.reset_instance()
    except Exception:
        pass
    try:
        n = tmputil.sweep_stale()
    except Exception:
        n = 0
    try:
        # persistent conversion cache: reclaim abandoned temps, aged entries,
        # and least-recently-used overflow past the budget
        from samql_core import filecache
        filecache.sweep()
        tmputil.touch_alive()
        # .544: past sessions clean on EVERY start. A crash never reaches
        # the exit sweep, so dead-pid instance dirs (spill stores, family
        # dbs) used to wait for the NEXT clean exit or a manual Storage
        # clean; now startup reclaims them too.
        tmputil.sweep_stale()
        tmputil.sweep_zombie_instances()
        # onefile launch leftovers: a kill/crash strands a few hundred MB of
        # _MEI* extraction in the system temp EVERY time -- reclaim them
        tmputil.sweep_mei_orphans()
        from samql_core import watchdog as _wd
        _wd.set_reinterrupt(
            lambda qid: get_session().reinterrupt_if_cancelled(qid))
    except Exception:
        pass

    bar.set("starting local server")
    global _HTTPD
    httpd, port = make_server(args.host, args.port)
    _HTTPD = httpd
    url = f"http://{args.host}:{port}/"

    _install_exit_handlers()

    # Accept HTTP as soon as the port is bound. get_session() can take
    # seconds on a cold frozen exe; if we warm it BEFORE serve_forever,
    # the launcher sees port_open, opens WebView2, and the first navigation
    # hangs in the listen backlog -- a white / "Not Responding" window.
    # SESSION_LOCK makes concurrent first-request construction safe.
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    bar.set("warming up data engine")
    get_session()  # warm the session so the first query is snappy

    # .510: WARM the heavy imports in the background so the FIRST query
    # doesn't pay the frozen-exe import tax (PyInstaller onefile + AV
    # rescans -- the on-box 97s "Query 1" stall was a thread stuck inside
    # pyimod02_importers.find_spec at query time). By the time a query
    # arrives these are already in sys.modules.
    def _warm_imports():
        import importlib
        import time as _t
        t0 = _t.time()
        got = []
        for _m in ("duckdb", "pyarrow", "sqlglot", "openpyxl",
                   "ijson", "orjson"):
            try:
                importlib.import_module(_m)
                got.append(_m)
            except Exception:
                pass
        print("  warmed imports (%s) in %.1fs"
              % (", ".join(got) or "none", _t.time() - t0), flush=True)
    threading.Thread(target=_warm_imports, daemon=True,
                     name="import-warm").start()

    # .512: when the LAUNCHER spawned us it tags SAMQL_PARENT_PID. Tie our
    # life to it: if the launcher dies for ANY reason (crash, kill, logoff)
    # this server exits too, instead of orphaning in Task Manager. Windows
    # waits on the process HANDLE (no polling); elsewhere we poll liveness.
    _ppid = os.environ.get("SAMQL_PARENT_PID")
    if _ppid and _ppid.isdigit():
        def _parent_watchdog(pid=int(_ppid)):
            try:
                if os.name == "nt":
                    import ctypes
                    k32 = ctypes.windll.kernel32
                    SYNCHRONIZE = 0x00100000
                    h = k32.OpenProcess(SYNCHRONIZE, False, pid)
                    if not h:
                        return  # already gone or inaccessible: fall through
                    k32.WaitForSingleObject(h, 0xFFFFFFFF)  # INFINITE
                else:
                    while True:
                        try:
                            os.kill(pid, 0)
                        except OSError:
                            break
                        time.sleep(2.0)
                print("  launcher (pid %d) is gone; shutting down." % pid,
                      flush=True)
                _graceful_shutdown()
            finally:
                os._exit(0)
        threading.Thread(target=_parent_watchdog, daemon=True,
                         name="parent-watchdog").start()

    def _heartbeat():
        while True:
            time.sleep(6 * 3600)
            tmputil.touch_alive()
    threading.Thread(target=_heartbeat, daemon=True,
                     name="alive-marker").start()

    bar.stop()  # clear the animation before printing the final status
    if n:
        print(f"    - cleaned up {n} leftover instance(s)", flush=True)
    print(f"    - ready  ->  {url}   (build {BUILD})", flush=True)
    print(
        "    frontend: " +
        ("built" if _FRONTEND_DIR else "NOT built (placeholder shown)"),
        flush=True)
    print("\n  SamQL is running. Press Ctrl+C to stop.\n", flush=True)

    launched = _open_window_or_browser(url, mode)
    try:
        if launched and launched[0] == "webview":
            _, webview, _url = launched
            try:
                # .519: SamQL.exe --window carries the SAME taskbar identity
                # as the AppWindow launcher -- process-level AUMID first,
                # then the Form icon set inside the GUI loop.
                if os.name == "nt":
                    try:
                        import ctypes as _ct
                        _fn = _ct.windll.shell32.\
                            SetCurrentProcessExplicitAppUserModelID
                        _fn.argtypes = [_ct.c_wchar_p]
                        _fn.restype = _ct.HRESULT
                        _hr = int(_fn("SamQL.App.2"))  # .532: lockstep
                        # with launcher_app.APP_AUMID -- the old
                        # identities carry an Edge-poisoned icon cache
                        if _hr != 0:
                            print("  WARN process AppUserModelID hr="
                                  "0x%08X" % (_hr & 0xFFFFFFFF,),
                                  flush=True)
                    except Exception as _ae:
                        print("  WARN process AppUserModelID not set "
                              "(%r)" % (_ae,), flush=True)

                def _srv_ico():
                    base = getattr(sys, "_MEIPASS", None)
                    cands = []
                    if base:
                        cands.append(os.path.join(base, "samql.ico"))
                    here = os.path.dirname(os.path.abspath(__file__))
                    cands.append(os.path.join(here, "samql.ico"))
                    for c in cands:
                        if os.path.isfile(c):
                            return c
                    return None

                def _srv_set_window_aumid(hwnd, aumid="SamQL.App.2"):
                    """.550: window-level AUMID on the Form HWND so the
                    taskbar identity cannot drift to a foreign window."""
                    if os.name != "nt" or not hwnd:
                        return False
                    try:
                        import ctypes
                        from ctypes import wintypes

                        class GUID(ctypes.Structure):
                            _fields_ = [("d1", ctypes.c_ulong),
                                        ("d2", ctypes.c_ushort),
                                        ("d3", ctypes.c_ushort),
                                        ("d4", ctypes.c_ubyte * 8)]

                        class PROPERTYKEY(ctypes.Structure):
                            _fields_ = [("fmtid", GUID),
                                        ("pid", ctypes.c_ulong)]

                        class PROPVARIANT(ctypes.Structure):
                            _fields_ = [("vt", ctypes.c_ushort),
                                        ("r1", ctypes.c_ushort),
                                        ("r2", ctypes.c_ushort),
                                        ("r3", ctypes.c_ushort),
                                        ("pwszVal", ctypes.c_wchar_p),
                                        ("pad", ctypes.c_byte * 8)]

                        iid = GUID(0x886D8EEB, 0x8CF2, 0x4446,
                                   (ctypes.c_ubyte * 8)(
                                       0x8D, 0x02, 0xCD, 0xBA,
                                       0x1D, 0xBD, 0xCF, 0x99))
                        pkey = PROPERTYKEY(
                            GUID(0x9F4C2855, 0x9F79, 0x4B39,
                                 (ctypes.c_ubyte * 8)(
                                     0xA8, 0xD0, 0xE1, 0xD4,
                                     0x2D, 0xE1, 0xD5, 0xF3)), 5)
                        store = ctypes.c_void_p()
                        hr = ctypes.windll.shell32.\
                            SHGetPropertyStoreForWindow(
                                wintypes.HWND(hwnd), ctypes.byref(iid),
                                ctypes.byref(store))
                        if hr != 0 or not store:
                            return False
                        vtbl = ctypes.cast(
                            store, ctypes.POINTER(ctypes.POINTER(
                                ctypes.c_void_p))).contents
                        SetValue = ctypes.CFUNCTYPE(
                            ctypes.c_long, ctypes.c_void_p,
                            ctypes.POINTER(PROPERTYKEY),
                            ctypes.POINTER(PROPVARIANT))(vtbl[6])
                        Commit = ctypes.CFUNCTYPE(
                            ctypes.c_long, ctypes.c_void_p)(vtbl[7])
                        Release = ctypes.CFUNCTYPE(
                            ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
                        pv = PROPVARIANT()
                        pv.vt = 31  # VT_LPWSTR
                        pv.pwszVal = aumid
                        ok = (SetValue(store, ctypes.byref(pkey),
                                       ctypes.byref(pv)) == 0
                              and Commit(store) == 0)
                        Release(store)
                        return ok
                    except Exception:
                        return False

                # Match launcher / _brand.CHROME_BG: WebView2 defaults to
                # white until content paints.
                _win = webview.create_window("SamQL", _url,
                                             width=1280, height=860,
                                             background_color=_brand.CHROME_BG)

                def _set_srv_icon(_w=_win):
                    """.519: mirror of the launcher's icon landing -- wait
                    for shown + .native, set Form.Icon/ShowIcon.

                    Must not block the pywebview GUI thread: waiting here
                    deadlocks the message pump and surfaces as Not
                    Responding on first open (same fix as launcher_app)."""
                    def _brand_form_icon():
                        try:
                            ip = _srv_ico()
                            if not ip:
                                return
                            try:
                                ev = getattr(getattr(_w, "events", None),
                                             "shown", None)
                                if ev is not None:
                                    ev.wait(10)
                            except Exception:
                                pass
                            native = None
                            for _ in range(50):
                                native = getattr(_w, "native", None)
                                if native is not None:
                                    break
                                time.sleep(0.2)
                            if native is None:
                                return

                            def _apply():
                                import clr  # noqa: F401
                                from System.Drawing import Icon as _I  # type: ignore
                                native.Icon = _I(ip)
                                try:
                                    native.ShowIcon = True
                                except Exception:
                                    pass
                                try:
                                    _hwnd = int(str(native.Handle))
                                    if _srv_set_window_aumid(_hwnd):
                                        print("  native window AppUserModelID "
                                              "set.", flush=True)
                                except Exception:
                                    pass
                                print("  native window icon set.", flush=True)

                            try:
                                from System import Action  # type: ignore
                                native.BeginInvoke(Action(_apply))
                            except Exception:
                                _apply()
                        except Exception as _ie:
                            print("  native window icon skipped (%r)."
                                  % (_ie,), flush=True)
                    threading.Thread(target=_brand_form_icon, daemon=True,
                                     name="samql-srv-native-icon").start()
                # Blocks until the window closes. .490: private_mode=False + a
                # stable storage_path persist localStorage/cookies across runs.
                # .508: AUTO-DETECT FIRST (the .499 on-box log shows the
                # plain path opening the window fine); forcing gui=
                # "edgechromium" up front (.501) can trip on a pywebview
                # version and leave the GUI half-initialized so even the
                # retry dies to the browser fallback. Explicit edgechromium
                # is now the RETRY, not the opener.
                try:
                    webview.start(_set_srv_icon, private_mode=False,
                                  storage_path=_webview_storage_path())
                    _gl = getattr(webview, "guilib", None)
                    _gn = (getattr(webview, "gui", None)
                           or getattr(_gl, "__name__", None) or "auto")
                    print("  native window closed (renderer=%s)."
                          % str(_gn).rsplit(".", 1)[-1], flush=True)
                except Exception as _wg:
                    print("  auto-detect renderer failed (%r); retrying "
                          "with the explicit edgechromium renderer."
                          % (_wg,), flush=True)
                    webview.start(_set_srv_icon, gui="edgechromium",
                                  private_mode=False,
                                  storage_path=_webview_storage_path())
            except Exception as _wv:
                # .498: the pywebview backend (Edge WebView2 via pythonnet) can
                # fail to initialise on a box that lacks it. Don't crash the app
                # after the server is already up -- report the REAL cause and
                # fall back to a browser window so SamQL still opens.
                print("  native window unavailable (%r); opening a browser "
                      "window instead." % (_wv,), flush=True)
                try:
                    if not _launch_browser_window(_url):
                        webbrowser.open(_url)
                except Exception:
                    pass
                while True:
                    server_thread.join(1.0)
                    if not server_thread.is_alive():
                        break
        else:
            # No native window (a browser window/tab, or headless): block the
            # main thread until interrupted (Ctrl+C, a signal, or the console
            # close handler), which is what stops the server.
            while True:
                server_thread.join(1.0)
                if not server_thread.is_alive():
                    break
    except KeyboardInterrupt:
        pass
    finally:
        print("\nShutting down...", flush=True)
        _graceful_shutdown()


if __name__ == "__main__":
    main()
