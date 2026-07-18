"""Persistent cache for expensive file->Parquet conversions.

Loading a large JSON/CSV converts it once into a Parquet cache and queries
that in place (engines.load_file_to_parquet_view). Historically that cache
lived in the per-PID temp dir, which the clean-exit lifecycle deliberately
wipes -- so every app start re-paid the full parse of a multi-GB file.

This module keeps those conversions in a STABLE directory
(<system-temp>/samql/filecache/) keyed by the source file's identity
(absolute path + size + mtime_ns + reader kind/options + a format version),
so a restart re-attaches the existing Parquet in milliseconds. The source
changing in any way changes the key, which is a miss -- stale entries are
never served, only aged out.

Budgeted + aged: SAMQL_FILECACHE_GB (default 32) caps total size with
least-recently-USED eviction (a cache hit touches the file's mtime), and
SAMQL_FILECACHE_DAYS (default 14) drops anything unused for that long.
SAMQL_FILECACHE=0 disables the cache entirely (conversions fall back to the
per-instance temp dir exactly as before). Stdlib only.
"""

import hashlib
import os
import tempfile
import time

# Bump when the conversion output could differ for the same source (reader
# changes, COPY options, ...): every existing entry then misses and ages out.
# .431: bumped -- cache WRITES changed (byte-capped row groups),
# and only a freshly written file benefits.
CACHE_VERSION = 2

_ROOT = os.path.join(tempfile.gettempdir(), "samql")
_DIR = os.path.join(_ROOT, "filecache")
_PID = os.getpid()
_SEQ = [0]  # process-local staging counter: same-millisecond begins collide
_SEQ_LOCK = __import__("threading").Lock()
_SWEEP_LOCK = __import__("threading").Lock()
_LAST_SWEEP = [0.0]  # monotonic time of last opportunistic sweep
_SWEEP_MIN_INTERVAL_SEC = 120.0
_CONV_LOCKS = {}
_CONV_LOCKS_MU = __import__("threading").Lock()


def _next_seq():
    with _SEQ_LOCK:
        _SEQ[0] += 1
        return _SEQ[0]


def conversion_lock(key):
    """Per-cache-key lock so two loads of the same file share one conversion.

    Acquire **before** DuckDB ``write_lock`` to avoid lock-order inversion.
    Returns a no-op context when ``key`` is falsy.
    """
    class _Null:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    if not key:
        return _Null()
    with _CONV_LOCKS_MU:
        lk = _CONV_LOCKS.get(key)
        if lk is None:
            lk = __import__("threading").Lock()
            _CONV_LOCKS[key] = lk
        return lk


def maybe_sweep(*, force=False):
    """Throttled mid-session reclaim (startup still calls ``sweep()`` directly).

    Avoids hammering disk after every small commit while still enforcing budget
    during long conversion-heavy sessions.
    """
    if not enabled() and not force:
        return 0
    now = time.monotonic()
    with _SWEEP_LOCK:
        if not force and (now - _LAST_SWEEP[0]) < _SWEEP_MIN_INTERVAL_SEC:
            return 0
        _LAST_SWEEP[0] = now
    return sweep()


def enabled():
    v = (os.environ.get("SAMQL_FILECACHE") or "").strip().lower()
    return v not in ("0", "false", "off", "no")


def _ensure_dir():
    try:
        os.makedirs(_DIR, exist_ok=True)
    except Exception:
        pass


def cache_key(path, kind, extra=""):
    """Identity of one conversion: the source file's stats + how it is read.
    Returns a hex key, or None when the source can't be stat'ed (caller then
    skips the cache for this load)."""
    try:
        st = os.stat(path)
        raw = "\x00".join([
            os.path.abspath(path), str(st.st_size),
            str(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))),
            str(kind or ""), str(extra or ""), "v%d" % CACHE_VERSION,
        ])
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    except Exception:
        return None


def entry_path(key):
    return os.path.join(_DIR, "fc_%s.parquet" % key)


def lookup(key):
    """The cached Parquet for ``key`` if present (touched for LRU), else
    None."""
    if not key or not enabled():
        return None
    p = entry_path(key)
    try:
        if os.path.isfile(p) and os.path.getsize(p) > 0:
            try:
                os.utime(p, None)  # mark as recently used
            except Exception:
                pass
            return p
    except Exception:
        pass
    return None


def begin(key):
    """A temp path (same directory, so commit is an atomic rename) for a
    conversion in progress. Unique per pid+time so two instances converting
    the same file never collide."""
    _ensure_dir()
    return os.path.join(
        _DIR, "fc_%s.tmp%d_%d" % (key, _PID, _next_seq()))


def commit(tmp_path, key):
    """Atomically publish a finished conversion; returns the final path.

    os.replace can transiently fail on Windows when an AV / indexer holds
    the target -- retry briefly before giving up (the caller then falls back
    to a per-instance temp so the LOAD still succeeds, just uncached)."""
    final = entry_path(key)
    last = None
    for _ in range(4):
        try:
            os.replace(tmp_path, final)
            try:
                maybe_sweep()
            except Exception:
                pass
            return final
        except OSError as e:
            last = e
            time.sleep(0.05)
    raise last


def abort(tmp_path):
    try:
        os.unlink(tmp_path)
    except Exception:
        pass


def _budget_bytes():
    from . import load_thresholds as LT
    try:
        gb = float(LT.get_float("filecache_gb"))
    except Exception:
        gb = 32.0
    return max(1, int(gb * (1024 ** 3)))


def _max_age_sec():
    try:
        days = float(os.environ.get("SAMQL_FILECACHE_DAYS") or 14)
    except Exception:
        days = 14.0
    return max(3600.0, days * 86400.0)


def sweep():
    """Reclaim the cache: drop abandoned .tmp files (>1h), entries unused
    longer than the age limit, then least-recently-used entries until the
    total is under budget. Returns how many files were removed."""
    removed = 0
    try:
        names = os.listdir(_DIR)
    except Exception:
        return 0
    now = time.time()
    entries = []  # (mtime, size, path)
    for n in names:
        p = os.path.join(_DIR, n)
        try:
            if not n.startswith("fc_"):
                continue
            m = os.path.getmtime(p)
            if ".tmp" in n:
                if now - m > 3600:
                    os.unlink(p)
                    removed += 1
                continue
            if now - m > _max_age_sec():
                os.unlink(p)
                removed += 1
                continue
            # very recent entries (attached views from a live session) are
            # exempt from BUDGET eviction -- only age can take them
            if now - m < 600:
                continue
            entries.append((m, os.path.getsize(p), p))
        except Exception:
            continue
    total = sum(sz for _m, sz, _p in entries)
    budget = _budget_bytes()
    if total > budget:
        entries.sort()  # oldest (least recently used) first
        for _m, sz, p in entries:
            if total <= budget:
                break
            try:
                os.unlink(p)
                total -= sz
                removed += 1
            except Exception:
                continue
    return removed
