"""File-origin signatures for loaded tables (IDE / Journal / NodeFlow).

Lightweight polling of mtime/size/ctime/inode + bounded content digest —
same posture as directory/appendfolder and filecache. Session poll handlers
reload inputs in place and clear last-run caches (result grids, Journal
pages, NodeFlow reuse) when a signature flips.

Poll path is cheap-stat-first: digest runs only when size/mtime/ctime/ino
changed (or on register / mark_current). Pre-run recheck budgets scale with
file size under a hard cap so large reloads can finish without infinite stall.
"""
from __future__ import annotations

import os
import threading
import time

# Debounce between full origin polls (sidebar /api/tables).
POLL_INTERVAL_SEC = 0.4

# Wall-clock budget for pre-run origin recheck + in-place reload (seconds).
# Tiny files keep the short default; large files scale up to the hard cap.
RECHECK_BUDGET_SEC = 2.0
RECHECK_BUDGET_MIN_SEC = 2.0
RECHECK_BUDGET_MAX_SEC = 45.0
# Extra wait ≈ total_bytes / this rate (on top of MIN). ~8 MiB/s → 80 MiB ≈ 12s.
RECHECK_BUDGET_BYTES_PER_SEC = 8 * 1024 * 1024

# Brief wait for an in-flight run to finish before reload-then-run.
BUSY_WAIT_SEC = 0.35

# Idle poll: at most this many content digests per tick (deep verify / register
# refresh). Cheap-stat short-circuit means most ticks need zero digests.
MAX_DIGESTS_PER_POLL = 8

# Idle watcher sync: reload at most this many tables per tables_tree tick
# (in-use first). Remainder stay badge-pending for the next tick / Run.
MAX_RELOADS_PER_SYNC = 4


def cheap_stat(path):
    """(mtime_ns, size, ctime_ns, ino) or None when unreadable."""
    try:
        if not path or not os.path.isfile(path):
            return None
        st = os.stat(path)
        return (
            int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))),
            int(st.st_size),
            int(getattr(st, "st_ctime_ns", 0) or 0),
            int(getattr(st, "st_ino", 0) or 0),
        )
    except OSError:
        return None


def _digest_for(path, size):
    from . import filecache as _fc
    try:
        return _fc.content_digest(path, int(size))
    except Exception:
        return ""


def file_token(path, *, prior=None, force_digest=False):
    """Stable disk signature for ``path``, or None when unreadable.

    When ``prior`` is a previous token and the cheap stat (size/mtime/ctime/ino)
    is unchanged, reuses ``prior``'s digest without reading file bytes —
    unless ``force_digest`` is set (register / mark_current).
    """
    cheap = cheap_stat(path)
    if cheap is None:
        return None
    mtime_ns, size, ctime_ns, ino = cheap
    if (
        not force_digest
        and prior is not None
        and isinstance(prior, (tuple, list))
        and len(prior) >= 5
        and tuple(prior[:4]) == cheap
    ):
        return (
            mtime_ns, size, ctime_ns, ino, prior[4],
        )
    digest = _digest_for(path, size)
    return (mtime_ns, size, ctime_ns, ino, digest)


def recheck_budget_sec(sizes_bytes=None, *, fallback=None):
    """Wall-clock budget for reload-then-run, scaled by pending file sizes.

    Tiny / unknown → ``RECHECK_BUDGET_MIN_SEC``. Large → grows with total
    bytes, hard-capped at ``RECHECK_BUDGET_MAX_SEC`` (never infinite).
    """
    base = RECHECK_BUDGET_MIN_SEC if fallback is None else float(fallback)
    try:
        base = float(base)
    except Exception:
        base = RECHECK_BUDGET_MIN_SEC
    if base <= 0:
        base = RECHECK_BUDGET_MIN_SEC
    total = 0
    for s in (sizes_bytes or []):
        try:
            total += max(0, int(s or 0))
        except Exception:
            pass
    if total <= 0:
        return min(RECHECK_BUDGET_MAX_SEC, max(RECHECK_BUDGET_MIN_SEC, base))
    rate = float(RECHECK_BUDGET_BYTES_PER_SEC) or float(8 * 1024 * 1024)
    scaled = RECHECK_BUDGET_MIN_SEC + (total / rate)
    return min(RECHECK_BUDGET_MAX_SEC, max(RECHECK_BUDGET_MIN_SEC, scaled))


def is_internal_cache_path(path):
    """True when ``path`` is SamQL filecache / instance-temp, not a user file."""
    if not path or not isinstance(path, str):
        return True
    try:
        ap = os.path.abspath(path)
    except Exception:
        return True
    try:
        from . import filecache as _fc
        fc = os.path.abspath(_fc._DIR)
        if os.path.commonpath([fc, ap]) == fc:
            return True
    except Exception:
        pass
    try:
        from . import tmputil
        inst = os.path.abspath(tmputil.instance_dir())
        if os.path.commonpath([inst, ap]) == inst:
            return True
    except Exception:
        pass
    return False


def watchable_path(eng, name, prefer_path=None):
    """Best user-visible source path for a loaded table, or None."""
    if prefer_path and os.path.isfile(prefer_path) \
            and not is_internal_cache_path(prefer_path):
        return prefer_path
    if eng is None or not name:
        return None
    origins = getattr(eng, "table_origins", None) or {}
    sources = getattr(eng, "table_sources", None) or {}
    for cand in (origins.get(name), sources.get(name)):
        if not cand or not isinstance(cand, str):
            continue
        if is_internal_cache_path(cand):
            continue
        try:
            if os.path.isfile(cand):
                return cand
        except Exception:
            continue
    return None


class OriginWatch:
    """Per-session registry of file-backed table signatures."""

    def __init__(self, poll_interval=POLL_INTERVAL_SEC):
        self._lock = threading.Lock()
        self._entries = {}  # (engine, name) -> {path, token, changed, error}
        self._poll_interval = float(poll_interval)
        self._last_poll = 0.0
        # Single-flight: at most one poll walker at a time.
        self._poll_lock = threading.Lock()
        self._poll_inflight = False
        # Test / diagnostics: how many content digests the last poll ran.
        self._last_poll_digests = 0

    def clear(self):
        with self._lock:
            self._entries.clear()

    def register(self, engine, name, path, token=None):
        if not engine or not name or not path:
            return
        tok = token if token is not None else file_token(
            path, force_digest=True)
        if tok is None:
            return
        with self._lock:
            self._entries[(str(engine), str(name))] = {
                "path": path,
                "token": tok,
                "changed": False,
                "error": None,
            }

    def unregister(self, engine, name):
        with self._lock:
            self._entries.pop((str(engine), str(name)), None)

    def rename(self, engine, old, new):
        with self._lock:
            ent = self._entries.pop((str(engine), str(old)), None)
            if ent is not None:
                self._entries[(str(engine), str(new))] = ent

    def mark_current(self, engine, name, path=None):
        """Reset baseline to the live disk token (after Reload)."""
        key = (str(engine), str(name))
        with self._lock:
            ent = self._entries.get(key)
            path = path or (ent or {}).get("path")
        tok = file_token(path, force_digest=True) if path else None
        if tok is None:
            return
        with self._lock:
            self._entries[key] = {
                "path": path, "token": tok, "changed": False, "error": None,
            }

    def set_error(self, engine, name, message):
        """Record a reload failure so the UI can surface it (not silent)."""
        key = (str(engine), str(name))
        msg = (message or "Reload failed").strip() or "Reload failed"
        with self._lock:
            ent = self._entries.get(key)
            if ent is None:
                return
            ent["error"] = msg
            ent["changed"] = True

    def clear_error(self, engine, name):
        with self._lock:
            ent = self._entries.get((str(engine), str(name)))
            if ent is not None:
                ent["error"] = None

    def is_changed(self, engine, name):
        with self._lock:
            ent = self._entries.get((str(engine), str(name)))
            return bool(ent and ent.get("changed"))

    def snapshot_flags(self):
        """Return {(engine, name): changed} without mutating."""
        with self._lock:
            return {k: bool(v.get("changed")) for k, v in self._entries.items()}

    def snapshot_errors(self):
        """Return {(engine, name): error_msg} for entries with a reload error."""
        with self._lock:
            out = {}
            for k, v in self._entries.items():
                err = v.get("error")
                if err:
                    out[k] = str(err)
            return out

    def pending_keys(self):
        """Keys currently flagged changed (pending idle or pre-run reload)."""
        with self._lock:
            return [k for k, v in self._entries.items() if v.get("changed")]

    def sizes_for_keys(self, keys):
        """Best-effort source sizes for budget scaling (missing → 0)."""
        out = []
        with self._lock:
            for key in keys or []:
                try:
                    eng, name = key[0], key[1]
                    k = (str(eng), str(name))
                except Exception:
                    out.append(0)
                    continue
                ent = self._entries.get(k)
                if ent is None:
                    out.append(0)
                    continue
                path = ent.get("path")
                tok = ent.get("token")
                if isinstance(tok, (tuple, list)) and len(tok) >= 2:
                    try:
                        out.append(int(tok[1]))
                        continue
                    except Exception:
                        pass
                try:
                    out.append(int(os.path.getsize(path)) if path else 0)
                except Exception:
                    out.append(0)
        return out

    def poll(self, force=False, priority_names=None):
        """Compare registered paths to disk; set ``changed`` when tokens differ.

        Debounced unless ``force``. Missing files count as changed.
        Cheap-stat first: when size/mtime/ctime/ino match the baseline, skip
        content digest entirely. Cheap mismatch alone marks ``changed``
        (digest is reserved for register / mark_current / file_token).
        ``priority_names`` only orders the walk (in-use first).
        Single-flight: overlapping polls return [] (caller already has
        latest-wins / deferred sync). Returns the list of ``(engine, name)``
        keys that newly became changed (False→True).
        """
        now = time.monotonic()
        if not force and (now - self._last_poll) < self._poll_interval:
            return []
        if not self._poll_lock.acquire(blocking=False):
            return []
        try:
            if self._poll_inflight:
                return []
            self._poll_inflight = True
            self._last_poll = time.monotonic()
            self._last_poll_digests = 0
            with self._lock:
                items = list(self._entries.items())
            pri = {str(n) for n in (priority_names or []) if n}
            if pri:
                items.sort(key=lambda kv: (0 if kv[0][1] in pri else 1))
            dirty = []
            newly_changed = []
            for key, ent in items:
                path = ent.get("path")
                prior = ent.get("token")
                cheap = cheap_stat(path)
                if cheap is None:
                    changed = True
                elif (
                    prior is not None
                    and isinstance(prior, (tuple, list))
                    and len(prior) >= 4
                    and tuple(prior[:4]) == cheap
                ):
                    # Cheap match → unchanged; no content digest.
                    changed = False
                else:
                    # Cheap mismatch (or no baseline) → changed without digest.
                    changed = True
                was = bool(ent.get("changed"))
                if was != changed:
                    dirty.append((key, changed))
                    if changed and not was:
                        newly_changed.append(key)
            if not dirty:
                return []
            with self._lock:
                for key, changed in dirty:
                    ent = self._entries.get(key)
                    if ent is not None:
                        ent["changed"] = changed
                        if not changed:
                            ent["error"] = None
            return newly_changed
        finally:
            self._poll_inflight = False
            self._poll_lock.release()

    def token_for(self, engine, name):
        with self._lock:
            ent = self._entries.get((str(engine), str(name)))
            return None if ent is None else ent.get("token")

    def path_for(self, engine, name):
        with self._lock:
            ent = self._entries.get((str(engine), str(name)))
            return None if ent is None else ent.get("path")
