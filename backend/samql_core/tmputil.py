"""Per-instance temporary storage and cross-instance cleanup.

Every temporary artifact SamQL creates -- the DuckDB on-disk database and
its spill directory, result row stores, Parquet result temporaries and
export files -- lives under a single per-process directory:

    <system-temp>/samql/<pid>/

That makes teardown trivial: a clean exit removes the whole directory. And
it lets a fresh start sweep away the directories of previous instances that
died *without* cleaning up (for example, the terminal window was closed and
the process was killed before it could run its shutdown handler). Each such
directory is named after the process that owns it, so the sweep only deletes
directories whose process is no longer running.
"""
import os
import shutil
import stat
import sys
import tempfile
import threading
import time

_ROOT = os.path.join(tempfile.gettempdir(), "samql")
_PID = os.getpid()
_INSTANCE = os.path.join(_ROOT, str(_PID))
_lock = threading.Lock()
_made = False

# Stray (non-pid) leftovers older than this are swept too.
_MAX_AGE_SEC = 12 * 3600


def _rmtree(path):
    """Remove a directory tree, coping with Windows read-only files: a normal
    rmtree first, then -- if anything survives -- clear the read-only bit on the
    leftovers and retry. (A file with a live open handle still can't be removed
    while open; at real shutdown the engines are closed first, so their db /
    spill files are already released before this runs.)"""
    shutil.rmtree(path, ignore_errors=True)
    if not os.path.exists(path):
        return
    try:
        for root, dirs, files in os.walk(path):
            for name in files + dirs:
                try:
                    os.chmod(os.path.join(root, name), stat.S_IWRITE)
                except Exception:
                    pass
        try:
            os.chmod(path, stat.S_IWRITE)
        except Exception:
            pass
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


def pid_alive(pid):
    """Best-effort check whether a process id is currently running.
    Conservative: when unsure, reports True so we never delete the files
    of a process that might still be live."""
    try:
        pid = int(pid)
    except Exception:
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            PROCESS_QUERY_INFORMATION = 0x0400
            k = ctypes.windll.kernel32
            h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                h = k.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
            if not h:
                return False
            try:
                code = wintypes.DWORD()
                ok = k.GetExitCodeProcess(h, ctypes.byref(code))
                if ok:
                    STILL_ACTIVE = 259
                    return code.value == STILL_ACTIVE
                return True
            finally:
                k.CloseHandle(h)
        except Exception:
            return True
    else:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except Exception:
            return True


def instance_dir():
    """The current process's temp directory (created on first use)."""
    global _made
    if not _made:
        with _lock:
            if not _made:
                try:
                    os.makedirs(_INSTANCE, exist_ok=True)
                except Exception:
                    pass
                _made = True
    return _INSTANCE


def instance_path(name):
    return os.path.join(instance_dir(), name)


def new_tempfile(prefix, suffix):
    """Create a fresh temp file inside this instance's directory and
    return its path (falls back to the system temp dir on error)."""
    try:
        fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix,
                                    dir=instance_dir())
        os.close(fd)
        return path
    except Exception:
        fd, path = tempfile.mkstemp(prefix="samql_" + prefix, suffix=suffix,
                                    dir=None)  # last resort: system temp dir
        os.close(fd)
        return path


def cleanup_instance():
    """Remove this instance's entire temp directory (clean shutdown)."""
    try:
        _rmtree(_INSTANCE)
    except Exception:
        pass


def reset_instance():
    """Wipe this process's temp directory to a clean slate, then recreate it
    empty. Call ONCE at startup, before any temp file is created.

    Guards against PID reuse: sweep_stale() deliberately never touches the live
    PID's directory, so if a previous instance that happened to share this PID
    died without cleaning up, its leftovers would otherwise remain in our
    directory. Wiping it here guarantees a fresh session starts with no stale
    temp data, no matter how the previous one ended."""
    global _made
    with _lock:
        try:
            _rmtree(_INSTANCE)
        except Exception:
            pass
        try:
            os.makedirs(_INSTANCE, exist_ok=True)
        except Exception:
            pass
        _made = True


def sweep_stale():
    """Remove temp directories left by previous instances whose process is
    no longer running. Safe to call at startup; never touches a live
    instance's directory or this process's own."""
    removed = 0
    try:
        entries = os.listdir(_ROOT)
    except FileNotFoundError:
        return 0
    except Exception:
        return 0
    now = time.time()
    for name in entries:
        if name == str(_PID):
            continue
        if name == "filecache":
            # the persistent conversion cache is NOT per-instance; it manages
            # its own budget + age (filecache.sweep()), so the stray-dir age
            # rule below must never wipe it.
            continue
        path = os.path.join(_ROOT, name)
        try:
            if name.isdigit():
                # A previous instance's directory: delete only if its
                # process has exited.
                if not pid_alive(name):
                    _rmtree(path)
                    removed += 1
            else:
                # Stray file/dir not named after a pid: delete if old.
                age = now - os.path.getmtime(path)
                if age > _MAX_AGE_SEC:
                    if os.path.isdir(path):
                        _rmtree(path)
                    else:
                        os.unlink(path)
                    removed += 1
        except Exception:
            continue
    removed += _sweep_temp_root()
    return removed


def _sweep_temp_root():
    """Reclaim orphaned SamQL temp files left *directly* under the system
    temp dir rather than inside <temp>/samql/ -- e.g. files written by older
    builds, or by the rare instance-dir fallback. They carry no pid, so they
    are swept purely on age, and only when the name carries a known SamQL
    prefix. Never touches the samql/ tree itself."""
    removed = 0
    parent = tempfile.gettempdir()
    now = time.time()
    try:
        entries = os.listdir(parent)
    except Exception:
        return 0
    for name in entries:
        if not name.startswith(("samql_", "jf_export_")):
            continue
        # One-shot flatten/shred staging dirs are wiped on startup via
        # sweep_op_caches(); skip them here so age-based rules do not race
        # a live mid-session flatten.
        if name in ("samql_flatten_cache", "samql_shred_cache"):
            continue
        path = os.path.join(parent, name)
        try:
            if os.path.realpath(path) == os.path.realpath(_ROOT):
                continue  # never the samql/ tree itself
            if now - os.path.getmtime(path) <= _MAX_AGE_SEC:
                continue
            if os.path.isdir(path):
                _rmtree(path)
            else:
                os.unlink(path)
            removed += 1
        except Exception:
            continue
    return removed


def sweep_op_caches():
    """Wipe one-shot flatten/shred staging dirs under system temp.

    Call at process startup only: these caches are per-operation staging
    (not shared across sessions). A crash can leave multi-GB leftovers;
    nothing live holds them across a restart.
    """
    removed = 0
    parent = tempfile.gettempdir()
    for name in ("samql_flatten_cache", "samql_shred_cache"):
        path = os.path.join(parent, name)
        try:
            if os.path.isdir(path):
                _rmtree(path)
                removed += 1
            elif os.path.isfile(path):
                os.unlink(path)
                removed += 1
        except Exception:
            continue
    return removed


def dir_size_bytes(path):
    """Total size of all files under a directory (0 on any error)."""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass
    except Exception:
        pass
    return total


def instance_size_bytes():
    """Disk currently used by this instance's temp directory."""
    return dir_size_bytes(_INSTANCE)


# ---- launch leftovers + liveness (storage audit 2026-07-02) ------------- #
_ALIVE = ".alive"
_ALIVE_MAX_SEC = 48 * 3600


def touch_alive():
    """Refresh this instance's liveness marker. A pid alone can lie on
    Windows (pid reuse makes a dead instance's directory look owned by a
    live process forever); the marker's mtime is the tie-breaker."""
    try:
        p = os.path.join(instance_dir(), _ALIVE)
        with open(p, "a"):
            pass
        os.utime(p, None)
    except Exception:
        pass


def _marker_age(path, now):
    """Seconds since the dir's liveness marker (falls back to the dir's own
    mtime for directories created by builds before the marker existed)."""
    try:
        return now - os.path.getmtime(os.path.join(path, _ALIVE))
    except OSError:
        try:
            return now - os.path.getmtime(path)
        except OSError:
            return 0


def sweep_zombie_instances():
    """Remove pid-named instance dirs whose process LOOKS alive but whose
    liveness marker is ancient -- the Windows pid-reuse case. Own dir is
    never touched; genuinely live instances refresh their marker."""
    removed = 0
    now = time.time()
    try:
        entries = os.listdir(_ROOT)
    except OSError:
        return 0
    for name in entries:
        if name == str(_PID) or name == "filecache" or not name.isdigit():
            continue
        path = os.path.join(_ROOT, name)
        try:
            if pid_alive(name) and _marker_age(path, now) > _ALIVE_MAX_SEC:
                _rmtree(path)
                removed += 1
        except Exception:
            continue
    return removed


def mei_root():
    """Where PyInstaller onefile extracts (_MEIxxxxxx dirs): the system temp
    dir. A hook so tests can point it elsewhere."""
    return tempfile.gettempdir()


def _kept_mei_names(root):
    """Basenames a live server published as protected via `.samql_keep_mei`
    under the temp root (one per line) -- a second, still-running server's
    extraction must never be swept even when it is older than the age
    threshold."""
    out = set()
    try:
        with open(os.path.join(root, ".samql_keep_mei"),
                  encoding="utf-8", errors="replace") as fh:
            for line in fh:
                name = line.strip()
                if name.startswith("_MEI"):
                    out.add(name)
    except Exception:
        pass
    return out


def sweep_mei_orphans(min_age_sec=3600):
    """Remove orphaned PyInstaller onefile extractions.

    A onefile exe unpacks a few hundred MB to <temp>/_MEIxxxxxx on EVERY
    launch; a kill / crash / Citrix reset leaves that directory behind
    forever, and nothing else ever cleans it -- the classic 'my disk keeps
    shrinking' culprit. Sweeps every _MEI* sibling except the one THIS
    process is running from, any published as protected by a live server
    (`.samql_keep_mei`), and any younger than ``min_age_sec`` (another
    instance may be mid-launch). Locked dirs are skipped silently.
    Returns (removed_count, freed_bytes)."""
    root = mei_root()
    current = os.path.basename(getattr(sys, "_MEIPASS", "") or "")
    kept = _kept_mei_names(root)
    removed, freed = 0, 0
    now = time.time()
    try:
        entries = os.listdir(root)
    except OSError:
        return 0, 0
    for name in entries:
        if not name.startswith("_MEI") or name == current or name in kept:
            continue
        path = os.path.join(root, name)
        try:
            if not os.path.isdir(path):
                continue
            if now - os.path.getmtime(path) < min_age_sec:
                continue
            size = dir_size(path)
            _rmtree(path)
            if not os.path.exists(path):
                removed += 1
                freed += size
        except Exception:
            continue
    return removed, freed


def dir_size(path):
    """Total bytes under ``path`` (best-effort; 0 for a missing path)."""
    total = 0
    try:
        for base, _dirs, names in os.walk(path):
            for n in names:
                try:
                    total += os.path.getsize(os.path.join(base, n))
                except OSError:
                    pass
    except Exception:
        pass
    return total


def win_known_folder(key_name):
    """Resolve a Windows shell folder (Desktop / Personal / Downloads) from the
    registry so OneDrive-redirected locations are honoured."""
    import winreg
    sub = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
    # Downloads has no friendly name -- it's stored under its known-folder GUID
    name = ("{374DE290-123F-4565-9164-39C4925E467B}"
            if key_name == "Downloads" else key_name)
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub) as k:
        val, _ = winreg.QueryValueEx(k, name)
    return os.path.expandvars(val)


def downloads_dir():
    """.539: the user's Downloads folder, one resolution for EVERY
    server-side save. SAMQL_DOWNLOADS_DIR overrides for tests. Registry
    known-folder on Windows (OneDrive redirection honoured), ~/Downloads
    elsewhere, home as the last resort."""
    envd = os.environ.get("SAMQL_DOWNLOADS_DIR")
    if envd and os.path.isdir(envd):
        return envd
    dl = None
    if os.name == "nt":
        try:
            dl = win_known_folder("Downloads")
        except Exception:
            dl = None
    if not dl or not os.path.isdir(dl):
        cand = os.path.join(os.path.expanduser("~"), "Downloads")
        dl = cand if os.path.isdir(cand) else os.path.expanduser("~")
    return dl
