#!/usr/bin/env python3
"""SamQL app-window launcher -- the stdlib-only Python twin of
Start-SamQL-AppWindow, built so PyInstaller can bundle it as a
double-clickable, CONSOLE-LESS ``SamQL-AppWindow`` executable (the
second EXE block in backend/samql.spec; --noconsole means no PowerShell
execution policy and no hidden-relaunch dance).

Behavior parity with the PowerShell launcher, v3:
  * probe 127.0.0.1:<port>; reuse a live server, else start one
    (backend/server.py -> SamQL exe beside the launcher -> dist\\
    -> frozen self-serve last)
  * wait for /api/health (not TCP alone) before opening WebView2
  * a borderless, topmost splash (tkinter; degrades to log-only when
    tkinter is unavailable) pumped through every wait
  * open Edge/Chrome as a chromeless app window (--app=)
  * hold the splash until a browser window titled "SamQL" exists
    (ctypes EnumWindows -- a real check, not a sleep), APP_WINDOW_WAIT_S
  * failures show a red splash for ~6 s AND append to the launcher log
    in the samql temp root -- the same file Settings -> Error log reads

Only the standard library is used, so the bundle stays tiny and the
backend's no-new-dependencies rule holds.
"""

import argparse
import atexit
import os
import socket
import subprocess
import sys
import threading
import tempfile
import time

# API nodes may target services on a private/LAN address.  This environment
# override is inherited by the server launched below; cloud-metadata blocking
# remains controlled separately by SAMQL_ALLOW_METADATA_FETCH.
os.environ.setdefault("SAMQL_ALLOW_PRIVATE_FETCH", "1")

# Boot wait for a server WE spawned: idle timeout + absolute ceiling.
# .490/.500/.623/.624: wall-clock alone was raised 60 -> 300 s for OneDrive/AV
# cold starts, but a dead child still burned the whole budget, and a hung-but-
# alive process had no separate guard. Heartbeat wait (.625):
#   * child exit during wait -> fail immediately
#   * process-alive + TCP/health/stage progress reset an idle timer
#   * absolute ceiling still caps hung-but-alive (cannot sit forever)
# One place for both knobs so wait logic and failure messages never disagree.
SERVER_BOOT_TIMEOUT_S = 300          # absolute ceiling (hard max)
SERVER_BOOT_IDLE_TIMEOUT_S = 90      # no heartbeat for this long -> fail

# How long to poll for the visible app window title when branding the
# browser --app fallback (and the native icon stamper). A miss only WARNs;
# the window is still opened. First WebView2 / Edge cold start often exceeds
# the old 12 s cap on managed boxes.
APP_WINDOW_WAIT_S = 75.0

# Match samql_core._brand.CHROME_BG -- kept local so the launcher stays
# stdlib-only when run from source (no samql_core import on the hot path).
# WebView2's default background is white; splash + native window must agree.
CHROME_BG = "#16181d"

# ---------------------------------------------------------------- log

# .532: the app's shell identity -- VERSIONED ON PURPOSE. The Windows
# taskbar caches a group's icon PER AUMID. Earlier identities were stamped
# with browser or malformed opaque art, and that cache outlives every window
# stamp, pin cleanup and registry check. A fresh identity starts with a clean
# cache row. Bump the suffix whenever corrected art must divorce a poisoned
# cache again.
APP_AUMID = "SamQL.App.3"
_LEGACY_AUMIDS = ("SamQL.SamQL", "SamQL.App", "SamQL.App.2")
_AUMID_SET = []   # filled when SetCurrentProcessExplicitAppUserModelID succeeds
# .534: one SamQL at a time -- a named mutex closes the double-click
# race, and a window scan surfaces an already-open SamQL instead of
# opening a second one.
_MUTEX_NAME = "Local\\SamQL.AppWindow"
_MUTEX_HANDLE = []
_MUTEX_WAIT_S = 10.0  # .537: grace for a booting first click's window
# Must track SERVER_BOOT_TIMEOUT_S -- a shorter mutex budget used to treat a
# still-booting first click as stale and start a second server.
_MUTEX_BOOT_WAIT_S = float(SERVER_BOOT_TIMEOUT_S)
# .544/.623/.624: after the first launch's server answers, wait this long for
# its window (WebView2 cold start) before opening a window of our own on that
# server. Scaled with the 300 s boot budget (was 60 s at 180 s).
_MUTEX_WINDOW_GRACE_S = 100.0
# When a healthy SamQL server was ALREADY up at mutex-wait entry and no peer
# AppWindow process exists (Exit → keep server + zombie mutex holder), do not
# burn the full WebView2 cold-start grace waiting for a window that will never
# appear. A short beat still catches a racing first-click about to show.
_MUTEX_RECONNECT_WINDOW_GRACE_S = 2.5
# .546: the launcher supervises the server it started while the window is
# open -- if the backend dies (a standby suspend/kill, a crash), the
# supervisor respawns it so the window's Reconnect finds a live server
# instead of nothing. Off once the window closes; the launcher then stops
# the server it started so nothing is left in Task Manager.
# .629: also refuse to respawn after a clean /api/shutdown (exit code 0)
# and join the supervisor thread on stop so a mid-flight restart cannot
# leave an orphan SamQL.exe in Task Manager after Exit & stop / window close.
_SUPERVISE = {"on": False, "port": None, "restarts": 0, "thread": None}
_SERVER_LOCK = threading.Lock()



def _bundled_asset(name):
    """.500: path to a brand asset bundled INTO this launcher exe (samql.ico for
    the taskbar stamp, logo.png for the splash), or None. Frozen: it sits at the
    _MEIPASS root (the spec adds it there). From source: it lives in the repo
    (backend/samql.ico for the icon, frontend/public/ for logo.png), so the
    launcher shows the same art when run un-frozen. Never raises."""
    try:
        base = getattr(sys, "_MEIPASS", None)
        if base:
            p = os.path.join(base, name)
            if os.path.isfile(p):
                return p
        here = os.path.dirname(os.path.abspath(__file__))
        repo = os.path.dirname(here)
        for p in (os.path.join(here, name),
                  os.path.join(repo, "src", name),
                  os.path.join(repo, "frontend", "public", name)):
            if os.path.isfile(p):
                return p
    except Exception:
        pass
    return None


def _splash_logo_path():
    """Resolve a PNG path for the splash mark.

    Prefer a bundled / drop-in ``logo.png``. If absent (text-only tree or an
    older AppWindow build that omitted the file), soft-import the embedded
    SQ mark from ``samql_core._brand`` into a temp file -- the same art the
    HTTP server already serves for ``/logo.png``. Soft import keeps the
    launcher stdlib-only on the happy path. Returns ``(path, cleanup_path)``
    where ``cleanup_path`` is removed in ``Splash.close`` when set.
    """
    p = _bundled_asset("logo.png")
    if p:
        return p, None
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        from samql_core import _brand
        data = _brand.app_icon_png()
        fd, tmp = tempfile.mkstemp(prefix="samql-splash-", suffix=".png")
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return tmp, tmp
    except Exception:
        return None, None


def _temp_root():
    """Mirror tmputil._ROOT without importing samql_core (importing it
    would drag the whole backend into the launcher bundle)."""
    return os.environ.get("SAMQL_TMP") or os.path.join(
        tempfile.gettempdir(), "samql")


def launcher_log_path():
    return os.path.join(_temp_root(), "launcher.log")


def write_log(msg):
    """Append a timestamped line; trim to the last 200 lines (the same
    contract the PowerShell launcher and the Error-log viewer share)."""
    try:
        root = _temp_root()
        if not os.path.isdir(root):
            os.makedirs(root, exist_ok=True)
        p = launcher_log_path()
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(p, "a", encoding="utf-8", errors="replace") as f:
            f.write("%s %s\n" % (stamp, msg))
        # .440 audit fix: the only bare open() left anywhere -- read
        # under a context manager like everything else.
        with open(p, encoding="utf-8", errors="replace") as _rf:
            lines = _rf.readlines()
        if len(lines) > 200:
            with open(p, "w", encoding="utf-8", errors="replace") as f:
                f.writelines(lines[-200:])
    except Exception:
        pass


# ------------------------------------------------------------- splash

class _NoSplash:
    """Log-only stand-in when tkinter is missing (stripped corp
    Pythons): every method is a no-op so the flow reads identically."""

    def set_text(self, text, error=False):
        pass

    def pump(self, seconds=0.0):
        if seconds:
            time.sleep(seconds)

    def close(self):
        pass


class Splash:
    def __init__(self):
        import tkinter as tk
        from tkinter import ttk
        self._tk = tk
        # Guarantee the splash is on screen long enough to be seen even when a
        # warm/reused server makes boot near-instant (otherwise it flashes
        # sub-perceptibly). Enforced in close().
        self._created = time.time()
        self._min_visible = 0.9
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        # .500: show frontend/public/logo.png (bundled) above the text when
        # present; fall back to embedded SQ mark, then plain text splash.
        self._logo = None
        self._logo_cleanup = None
        logo_path, self._logo_cleanup = _splash_logo_path()
        # build.ps1 / build.sh run the logo doctor so public/logo.png ships
        # with REAL alpha (border-connected background cleared). Keep the
        # dark splash chrome -- matching the corner pixel was only a
        # workaround for opaque mattes, and with transparent logos it would
        # sample the (still-white) RGB under alpha 0 and paint a white box
        # again. Tk composites PNG alpha onto this Label background.
        bg, fg = CHROME_BG, "#d7dae0"
        img = None
        if logo_path:
            try:
                img = tk.PhotoImage(file=logo_path)
                factor = max(1, img.width() // 320, img.height() // 96)
                if factor > 1:
                    img = img.subsample(factor, factor)
                self._logo = img  # keep a reference so Tk doesn't GC it
            except Exception:
                self._logo = None
                img = None
        w, h = 380, (200 if self._logo else 118)
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry("%dx%d+%d+%d" % (w, h, (sw - w) // 2,
                                            (sh - h) // 2))
        self.root.configure(bg=bg)
        if self._logo:
            tk.Label(self.root, image=self._logo, bg=bg, borderwidth=0,
                     highlightthickness=0).pack(pady=(18, 4))
        self.label = tk.Label(self.root, text="Starting SamQL...",
                              fg=fg, bg=bg, font=("Segoe UI", 11))
        self.label.pack(pady=(8 if self._logo else 26, 8))
        self._fg = fg
        self.bar = ttk.Progressbar(self.root, mode="indeterminate",
                                   length=300)
        self.bar.pack()
        self.bar.start(12)
        self.root.update()
        self._bring_to_front()

    def _bring_to_front(self):
        """Force the borderless splash to the very top of the z-order.

        The launcher is spawned without foreground rights, so Windows creates
        its topmost window BEHIND a maximized foreground app (the browser or
        editor the user is looking at). The window is WS_VISIBLE but fully
        occluded -- which reads as "no splash at all". Toggling topmost
        re-inserts it at the top of the topmost band even when another topmost
        app currently owns the foreground; a Win32 SetForegroundWindow on the
        toplevel HWND backs it up. Best-effort throughout; never fatal."""
        try:
            self.root.lift()
            self.root.focus_force()
            self.root.update_idletasks()
            self.root.attributes("-topmost", False)
            self.root.attributes("-topmost", True)
        except Exception:
            pass
        try:
            import ctypes
            # overrideredirect windows expose their toplevel HWND via winfo_id.
            hwnd = int(self.root.winfo_id())
            if hwnd:
                ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception:
            pass

    def set_text(self, text, error=False):
        try:
            self.label.configure(
                text=text,
                fg="#c0392b" if error else getattr(self, "_fg", "#d7dae0"))
            self.root.update()
        except Exception:
            pass

    def pump(self, seconds=0.0):
        """Keep the window painting through a wait, re-asserting z-order so a
        native/browser window appearing mid-boot cannot bury the splash."""
        end = time.time() + seconds
        last_lift = 0.0
        while True:
            try:
                self.root.update()
                now = time.time()
                # Re-lift periodically (no focus_force -- that would repeatedly
                # steal focus from the booting app window).
                if now - last_lift > 0.75:
                    self.root.lift()
                    self.root.attributes("-topmost", True)
                    last_lift = now
            except Exception:
                return
            if time.time() >= end:
                return
            time.sleep(0.05)

    def close(self):
        # Hold the splash for a minimum on-screen time so a fast boot does not
        # flash it sub-perceptibly. pump() keeps it painted and on top.
        try:
            shown = time.time() - getattr(self, "_created", 0.0)
            remaining = getattr(self, "_min_visible", 0.0) - shown
            if remaining > 0:
                self.pump(remaining)
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        cleanup = getattr(self, "_logo_cleanup", None)
        if cleanup:
            try:
                os.remove(cleanup)
            except Exception:
                pass


def make_splash():
    try:
        return Splash()
    except Exception as e:
        write_log("WARN splash unavailable (%s); continuing "
                  "log-only" % e.__class__.__name__)
        return _NoSplash()


def fail_visibly(splash, msg):
    write_log("ERROR " + msg)
    splash.set_text(msg, error=True)
    splash.pump(6.0)
    splash.close()
    sys.exit(1)


# ------------------------------------------------------------- server

def port_open(port, host="127.0.0.1", timeout=0.4):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def _here():
    """The directory the launcher lives in: the exe's folder when
    frozen, the repo root when run as a script (this file sits in
    backend/)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def server_candidates(base=None):
    """Match Start-SamQL-AppWindow.ps1: source ``backend/server.py`` first
    (current UI/API), then a SamQL exe beside the launcher, then
    ``dist\\``, then (frozen only) self-serve as last resort.

    Preferring a stale ``dist\\samql.exe`` over source caused cold packaged
    boots and mismatched APIs in checkouts that also had a built exe."""
    base = base or _here()
    out = []
    out.append(("py", os.path.join(base, "backend", "server.py")))
    for nm in ("SamQL.exe", "samql.exe"):
        out.append(("exe", os.path.join(base, nm)))
    for nm in ("SamQL.exe", "samql.exe"):
        out.append(("exe", os.path.join(base, "dist", nm)))
    # .535: LAST resort -- this very launcher, self-spawned with --serve.
    # A lone SamQL-AppWindow.exe (sent to a colleague with nothing beside
    # it) bundles the whole backend now and serves itself.
    if getattr(sys, "frozen", False):
        out.append(("self", sys.executable))
    return out


def clean_child_env(env=None):
    """The environment for CHILD processes, with the frozen launcher's
    PyInstaller runtime scrubbed out (.421). A frozen child (the SamQL
    server exe) that inherits _MEIPASS2 / _PYI_* can latch onto THIS
    launcher's temp extraction and hold it open forever -- the on-box
    "Failed to remove temporary directory: ..._MEIxxxxxx" dialog. Also
    drops the launcher's own _MEIPASS from PATH."""
    out = dict(os.environ if env is None else env)
    out.pop("_MEIPASS2", None)
    for k in [k for k in out if k.startswith("_PYI_")]:
        out.pop(k, None)
    mei = getattr(sys, "_MEIPASS", None)
    if mei and out.get("PATH"):
        parts = [p for p in out["PATH"].split(os.pathsep)
                 if os.path.normcase(p.rstrip("\\/"))
                 != os.path.normcase(mei.rstrip("\\/"))]
        out["PATH"] = os.pathsep.join(parts)
    return out


_SERVER_PROC = None   # .512: the Popen of a server WE spawned (else None)
_BOOT_PORT = [None]             # port of the server WE spawned (exit reaper)
_LEAVE_SERVER_RUNNING = [False]  # intentional keeps (see below)


def _reap_spawned_server_on_exit():
    """Backstop for exit paths that never reach stop_server (a boot failure
    -- hung child, or a child that silently port-hopped off the one we
    probe -- or a browser-spawn failure). A server WE spawned must not
    outlive the launcher as an orphan: Task Manager would keep it, and the
    next launch would spawn a SECOND server beside it (possibly on a port
    no launcher ever probes). Intentional leaves (keep-on-close, browser
    --app window, default-browser tab) set _LEAVE_SERVER_RUNNING first.
    Note sys.exit paths run this; os._exit paths are all intentional."""
    try:
        if _LEAVE_SERVER_RUNNING[0]:
            return
        with _SERVER_LOCK:
            proc = globals().get("_SERVER_PROC")
        if proc is None or proc.poll() is not None:
            return
        port = _BOOT_PORT[0]
        write_log("INFO launcher exiting with our spawned server still "
                  "alive -- stopping it (no orphan in Task Manager)")
        if port:
            try:
                stop_server(port)
                return
            except Exception:
                pass
        _kill_process_tree(getattr(proc, "pid", None))
    except Exception:
        pass


atexit.register(_reap_spawned_server_on_exit)


def start_server(port, splash):
    creation = 0
    startup = None
    if os.name == "nt":
        # .424: CREATE_NO_WINDOW and DETACHED_PROCESS are CONFLICTING
        # console dispositions (hidden console vs no console); combined,
        # Windows honored neither cleanly and the server's terminal
        # stayed on screen after the app window opened. NO_WINDOW alone
        # is the reliable "console app, zero console" flag; NEW_PROCESS_
        # GROUP still keeps the launcher's Ctrl-events out of the child.
        # No STARTUPINFO show-hint either -- there is no window to show.
        creation = (0x08000000   # CREATE_NO_WINDOW
                    | 0x00000200)  # CREATE_NEW_PROCESS_GROUP
    env = clean_child_env()
    env["SAMQL_PORT"] = str(port)
    # Do NOT set SAMQL_PARENT_PID here: the browser --app fallback exits the
    # launcher immediately after opening Edge/Chrome, and a parent-watchdog
    # would kill the server under that window. Native AppWindow close calls
    # stop_server() instead. Embedders may still set SAMQL_PARENT_PID themselves.
    # .527: tell the server WHICH _MEI extraction belongs to this RUNNING
    # launcher, so the storage report can label it "held by the launcher --
    # frees on exit" instead of counting it as an unremovable orphan.
    _own_mei = getattr(sys, "_MEIPASS", None)
    if _own_mei:
        env["SAMQL_LAUNCHER_MEI"] = _own_mei
    with _SERVER_LOCK:
        for kind, path in server_candidates():
            if not os.path.isfile(path):
                continue
            try:
                if kind == "exe":
                    # --no-browser: the LAUNCHER owns window-opening; the
                    # server's own auto-open gave the on-box double window
                    # (a normal tab AND the app window).
                    # Pass --port explicitly -- SAMQL_PORT alone is not read by
                    # server.py, so a non-default launcher --port must be argv.
                    # .512: KEEP the handle -- after revoke/restart we can reap it.
                    globals()["_SERVER_PROC"] = subprocess.Popen(
                        [path, "--no-browser", "--port", str(port)],
                        creationflags=creation,
                        startupinfo=startup, env=env,
                        cwd=os.path.dirname(path))
                elif kind == "self":
                    globals()["_SERVER_PROC"] = subprocess.Popen(
                        [path, "--serve", "--port", str(port)],
                        creationflags=creation,
                        startupinfo=startup, env=env,
                        cwd=os.path.dirname(path))
                else:
                    py = None if getattr(sys, "frozen", False) \
                        else sys.executable
                    if py is None:
                        import shutil as _sh
                        py = _sh.which("python") or _sh.which("py")
                    if not py:
                        continue
                    globals()["_SERVER_PROC"] = subprocess.Popen(
                        [py, path, "--no-browser", "--port", str(port)],
                        creationflags=creation,
                        startupinfo=startup, env=env,
                        cwd=os.path.dirname(
                            os.path.dirname(path)))
                write_log("INFO started server via %s" % path)
                return True
            except Exception as e:
                write_log("WARN could not start %s (%s)" % (path, e))
    return False


def _server_alive_now(port):
    """True when a SamQL server answers on the port (not just any TCP
    listener -- the /api/health app marker, same check the launch ladder
    uses)."""
    try:
        return port_open(port) and _is_samql(port)
    except Exception:
        return False


def restart_server(port):
    """.546: bring the backend back in place. Reuses start_server's
    spawn (clean env, no-window, the same candidate ladder incl. the
    bundled --serve self-spawn), then waits with the same heartbeat
    boot semantics as cold start. Returns True once the server answers.
    Safe to call from the supervisor thread or an API-triggered path;
    never raises.

    .629: refuse to spawn when supervision is off (window closing / Exit
    & stop), and reap anything we started if the flag flipped mid-flight.
    """
    try:
        if _server_alive_now(port):
            return True
        # Refuse to spawn when supervision is off (window closing / Exit &
        # stop). Alive short-circuit above still works for explicit callers.
        if not _SUPERVISE.get("on"):
            return False
        # a dead handle may still be mapped; best-effort reap first
        with _SERVER_LOCK:
            proc = globals().get("_SERVER_PROC")
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=3)
                except Exception:
                    pass
        if not _SUPERVISE.get("on"):
            return False
        if not start_server(port, _NullSplash()):
            write_log("WARN restart_server: nothing to start")
            return False
        # Window closed / Exit & stop while we were spawning -- kill the
        # child immediately so Task Manager does not keep an orphan.
        if not _SUPERVISE.get("on"):
            write_log("INFO restart_server: supervise off; reaping mid-flight spawn")
            with _SERVER_LOCK:
                proc = globals().get("_SERVER_PROC")
                pid = getattr(proc, "pid", None) if proc is not None else None
            _kill_process_tree(pid)
            with _SERVER_LOCK:
                globals()["_SERVER_PROC"] = None
            return False
        err = wait_for_server_ready(port, _NullSplash())
        if err is None:
            if not _SUPERVISE.get("on"):
                write_log("INFO restart_server: supervise off after boot; "
                          "reaping respawn")
                with _SERVER_LOCK:
                    proc = globals().get("_SERVER_PROC")
                    pid = getattr(proc, "pid", None) if proc is not None else None
                _kill_process_tree(pid)
                with _SERVER_LOCK:
                    globals()["_SERVER_PROC"] = None
                return False
            write_log("INFO server is back up on port %d" % port)
            return True
        write_log("WARN restart_server: %s" % err)
        return False
    except Exception as e:
        write_log("WARN restart_server failed (%r)" % (e,))
        return False


class _NullSplash:
    """start_server wants a splash; the supervisor has none."""

    def set_text(self, *_a, **_k):
        pass

    def pump(self, *_a, **_k):
        pass

    def close(self):
        pass


def _supervisor_loop():
    """.546: while the window is open AND we started the server, respawn
    it if it dies. A short grace between checks avoids fighting a
    still-booting server; a burst cap avoids a hot crash-loop (after
    which the window's banner + manual Reconnect take over).

    .629: a clean exit (returncode 0 from /api/shutdown / Exit & stop)
    must NOT respawn -- that was leaving SamQL.exe in Task Manager after
    the user intentionally stopped the server and closed the window.
    """
    consecutive = 0
    backoffs = 0
    while _SUPERVISE["on"]:
        try:
            port = _SUPERVISE["port"]
            # Intentional stop: child exited cleanly -- do not bring it back.
            proc = globals().get("_SERVER_PROC")
            if proc is not None and proc.poll() is not None:
                rc = proc.returncode
                if rc == 0:
                    write_log("INFO supervisor: server exited cleanly "
                              "(code 0); not respawning")
                    _SUPERVISE["on"] = False
                    break
            if port and not _server_alive_now(port):
                # confirm it is really gone (two beats, ~3s) -- a busy
                # server can miss one health check under load
                time.sleep(3.0)
                if not _SUPERVISE["on"]:
                    break
                # Re-check clean exit after the grace (shutdown is async).
                proc = globals().get("_SERVER_PROC")
                if proc is not None and proc.poll() is not None \
                        and proc.returncode == 0:
                    write_log("INFO supervisor: server exited cleanly "
                              "during grace; not respawning")
                    _SUPERVISE["on"] = False
                    break
                if not _server_alive_now(port):
                    consecutive += 1
                    if consecutive > 5:
                        backoffs += 1
                        if backoffs > 3:
                            # Bounded churn, then hand off exactly like the
                            # docstring promises: the window's banner +
                            # manual Reconnect take over. An unbounded loop
                            # just respawned into whatever holds the port.
                            write_log(
                                "WARN supervisor: server still won't stay "
                                "up after repeated respawns -- giving up "
                                "(use Reconnect in the window to retry)")
                            _SUPERVISE["on"] = False
                            break
                        write_log("WARN supervisor: server keeps dying; "
                                  "backing off (use Reconnect in the "
                                  "window)")
                        time.sleep(30.0)
                        consecutive = 0
                        continue
                    if not _SUPERVISE["on"]:
                        break
                    _SUPERVISE["restarts"] += 1
                    write_log("INFO supervisor: server is down -- "
                              "respawning (restart #%d)"
                              % _SUPERVISE["restarts"])
                    restart_server(port)
                else:
                    consecutive = 0
            else:
                consecutive = 0
        except Exception:
            pass
        for _ in range(10):  # ~5s, but responsive to shutdown
            if not _SUPERVISE["on"]:
                break
            time.sleep(0.5)


def start_supervisor(port):
    if _SUPERVISE["on"]:
        return
    _SUPERVISE["on"] = True
    _SUPERVISE["port"] = port
    t = threading.Thread(target=_supervisor_loop, daemon=True,
                         name="samql-server-supervisor")
    _SUPERVISE["thread"] = t
    t.start()
    write_log("INFO server supervisor started (port %d)" % port)


def stop_supervisor():
    """Flip the supervise flag off and wait for the loop to finish.

    Joining matters: a mid-flight ``restart_server`` must finish (and
    then reap itself when it sees supervise-off) before ``stop_server``
    runs, otherwise a newly spawned SamQL.exe can outlive the window.
    """
    _SUPERVISE["on"] = False
    t = _SUPERVISE.get("thread")
    if t is not None and t.is_alive() and t is not threading.current_thread():
        try:
            t.join(timeout=12.0)
        except Exception:
            pass
    _SUPERVISE["thread"] = None


def _kill_process_tree(pid):
    """Best-effort: kill ``pid`` and its children (llama-server sidecar).

    On Windows a plain ``terminate()`` of SamQL.exe leaves grandchild
    llama-server processes in Task Manager; ``taskkill /T`` reaps the tree.
    Never raises."""
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(int(pid))],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5, check=False)
        else:
            try:
                os.kill(int(pid), 9)
            except Exception:
                pass
    except Exception:
        pass


def _pids_listening_on_port(port):
    """Best-effort PIDs with a LISTENING socket on ``port`` (Windows)."""
    pids = set()
    if os.name != "nt" or not port:
        return pids
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "tcp"],
            stderr=subprocess.DEVNULL, text=True, timeout=5,
            errors="replace")
    except Exception:
        return pids
    needle = ":%d" % int(port)
    for line in out.splitlines():
        if "LISTENING" not in line.upper():
            continue
        # TCP    0.0.0.0:8765    0.0.0.0:0    LISTENING    1234
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[1] if parts[0].upper() == "TCP" else ""
        if not local.endswith(needle):
            continue
        try:
            pids.add(int(parts[-1]))
        except Exception:
            pass
    return pids


def stop_server(port):
    """.490: gracefully stop the server WE started once the native window
    closes. The launcher owns that server, so 'close the window' should quit
    the app -- and, crucially, a graceful stop lets the frozen server exit
    cleanly so PyInstaller releases its onefile extraction (_MEIxxxxxx). Left
    running, that directory stays locked 'in use' and never clears from temp.

    Also reaps ``_SERVER_PROC``: POST /api/shutdown returns before the child
    actually exits (delayed teardown + ``os._exit``). Wait briefly, then
    kill the process tree so SamQL.exe / python / llama-server never linger
    in Task Manager. Best-effort: every failure swallowed so this never
    crashes the launcher's own exit.

    .629: after the Popen wait, also reap any leftover listener on ``port``
    (supervisor mid-flight respawn / race) so Task Manager cannot keep a
    second SamQL.exe the launcher no longer holds.
    """
    try:
        _local_urlopen(
            "http://127.0.0.1:%d/api/shutdown" % port,
            data=b"{}", method="POST", timeout=3,
            headers={"Content-Type": "application/json"}).read()
        write_log("INFO asked the server to shut down (window closed)")
    except Exception as e:
        write_log("INFO server shutdown request failed (%s)"
                  % e.__class__.__name__)
    with _SERVER_LOCK:
        proc = globals().get("_SERVER_PROC")
        globals()["_SERVER_PROC"] = None
    if proc is not None:
        try:
            # /api/shutdown sleeps ~0.4s then tears down; allow headroom.
            proc.wait(timeout=8)
            write_log("INFO server process exited after shutdown request")
        except Exception:
            write_log("INFO server still alive after shutdown request; "
                      "killing process tree")
            pid = getattr(proc, "pid", None)
            _kill_process_tree(pid)
            try:
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=2)
                except Exception:
                    pass
    # Belt-and-suspenders: anything still LISTENING on our port (a
    # supervisor respawn that swapped _SERVER_PROC, or a stuck child)
    # must die with the window.
    try:
        if port_open(port):
            leftovers = _pids_listening_on_port(port)
            own = os.getpid()
            for pid in leftovers:
                if pid and pid != own:
                    write_log("INFO reaping leftover listener pid %s on "
                              "port %d" % (pid, port))
                    _kill_process_tree(pid)
    except Exception:
        pass


# ------------------------------------------------- single instance

def _pick_samql_hwnd(rows, own_pid):
    """.534/.542: choose the ONE window that is SamQL from enumerated
    top-levels -- rows of (hwnd, pid, title, aumid, cloaked, w, h). Our
    shell identity (the stamped AppUserModelID) is authoritative; an
    exact "SamQL" title is the fallback. Our own process never matches.

    .542 PHANTOMS: IsWindowVisible passes DWM-CLOAKED ghosts -- Edge
    keeps invisible background windows titled by their last page, so a
    dead "SamQL" app-window matched, got "focused", and the launcher
    exited with nothing on screen or the taskbar. Cloaked or
    effectively-sizeless windows are never candidates."""
    wanted = (APP_AUMID,) + _LEGACY_AUMIDS

    def _is_our_exe(path):
        # the ONE thing Explorer / a foreign app can't fake: the owning
        # process image must be a SamQL executable.
        b = os.path.basename((path or "").replace("\\", "/")).lower()
        return b in ("samql-appwindow.exe", "samql.exe")

    # rows: (hwnd, pid, title, aumid, cloaked, w, h, exe); a row shorter
    # than 8 (older callers/tests) yields "" for exe.
    def _exe_of(r):
        return r[7] if len(r) > 7 else ""

    real = [r for r in rows
            if not r[4] and r[5] > 8 and r[6] > 8]
    # AUMID match -- but only when the owning process is really ours
    # (a Start/taskbar shortcut can bleed our AUMID onto an Explorer
    # window that opened a folder named "SamQL").
    for r in real:
        hwnd, pid, _t, aumid = r[0], r[1], r[2], r[3]
        if pid != own_pid and aumid and aumid in wanted \
                and _is_our_exe(_exe_of(r)):
            return hwnd
    # title fallback -- exact "SamQL" AND owned by our exe. Never a
    # substring ("SamQL and 1 more tab - File Explorer" must not match).
    for r in real:
        hwnd, pid, title = r[0], r[1], r[2]
        if pid != own_pid and title == "SamQL" \
                and _is_our_exe(_exe_of(r)):
            return hwnd
    return None


_LAST_MATCH = {}  # .542: diagnostics for the last scan hit (or miss)


def _win_cloaked(hwnd):
    """DWM cloak state (attr 14). Ghost windows -- Edge background
    processes, dying UWP frames -- report visible but cloaked; anything
    nonzero is invisible on screen and off the taskbar."""
    try:
        import ctypes
        v = ctypes.c_int(0)
        ctypes.windll.dwmapi.DwmGetWindowAttribute(
            ctypes.c_void_p(hwnd), 14, ctypes.byref(v),
            ctypes.sizeof(v))
        return int(v.value)
    except Exception:
        return 0


def _proc_image(pid):
    """Best-effort exe path of a pid, for the scan log."""
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(512)
            n = wintypes.DWORD(512)
            if k32.QueryFullProcessImageNameW(h, 0, buf,
                                              ctypes.byref(n)):
                return buf.value
            return ""
        finally:
            k32.CloseHandle(h)
    except Exception:
        return ""


def find_samql_window():
    """Every visible top-level window on the desktop, reduced to the one
    that is an already-open SamQL (AUMID match first, exact title as the
    fallback). Cloaked ghosts and sizeless phantoms are filtered (.542);
    _LAST_MATCH carries the winner's diagnostics for the log. None when
    SamQL isn't open -- or off Windows."""
    global _LAST_MATCH
    _LAST_MATCH = {}
    if os.name != "nt":
        return None
    rows = []
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND,
                                  wintypes.LPARAM)

        def cb(h, _l):
            try:
                if not user32.IsWindowVisible(h):
                    return True
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
                tbuf = ctypes.create_unicode_buffer(128)
                user32.GetWindowTextW(h, tbuf, 128)
                aum = None
                cloak = 0
                w = hgt = 0
                exe = ""
                if tbuf.value and "SamQL" in tbuf.value:
                    # COM/DWM/process reads only for plausible candidates
                    aum = _get_window_prop(int(h), 5)
                    cloak = _win_cloaked(int(h))
                    exe = _proc_image(int(pid.value))
                    rc = wintypes.RECT()
                    if user32.GetWindowRect(int(h), ctypes.byref(rc)):
                        w = rc.right - rc.left
                        hgt = rc.bottom - rc.top
                rows.append((int(h), int(pid.value), tbuf.value, aum,
                             cloak, w, hgt, exe))
            except Exception:
                pass
            return True

        user32.EnumWindows(proc(cb), 0)
    except Exception:
        return None
    hit = _pick_samql_hwnd(rows, os.getpid())
    ghosts = [r for r in rows
              if "SamQL" in (r[2] or "") and (r[4] or r[5] <= 8)]
    if ghosts:
        _LAST_MATCH["ghosts"] = [
            {"hwnd": g[0], "pid": g[1], "title": g[2],
             "exe": _proc_image(g[1]), "cloaked": g[4],
             "rect": "%dx%d" % (g[5], g[6])} for g in ghosts[:4]]
    if hit:
        row = next(r for r in rows if r[0] == hit)
        _LAST_MATCH.update({
            "hwnd": hit, "pid": row[1], "title": row[2],
            "aumid": row[3], "exe": _proc_image(row[1]),
            "cloaked": row[4], "rect": "%dx%d" % (row[5], row[6])})
    return hit


def focus_window(hwnd):
    """Restore + raise a window; True ONLY when the target re-verifies
    as a real window (.542: exists, uncloaked, has a usable rect) --
    "focusing" a ghost used to look like success and the launcher
    exited with nothing on screen. FlashWindowEx highlights the taskbar
    button even when Windows denies foreground to a background
    process."""
    if os.name != "nt" or not hwnd:
        return False
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        if not user32.IsWindow(hwnd) or _win_cloaked(hwnd):
            return False
        rc = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rc)) \
                and (rc.right - rc.left) <= 8:
            return False
        SW_RESTORE = 9
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)

        class _FI(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT),
                        ("hwnd", wintypes.HWND),
                        ("dwFlags", wintypes.DWORD),
                        ("uCount", wintypes.UINT),
                        ("dwTimeout", wintypes.DWORD)]
        fi = _FI(ctypes.sizeof(_FI), hwnd, 0x3, 3, 0)  # FLASHW_ALL
        user32.FlashWindowEx(ctypes.byref(fi))
        return True
    except Exception:
        return False


def _acquire_single_instance():
    """Hold the launcher's named mutex for the life of this process.
    Returns (acquired, already_running) -- the kernel releases it on any
    exit, so a crash can never wedge future launches."""
    if os.name != "nt":
        return True, False
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.CreateMutexW(None, False, _MUTEX_NAME)
        already = (k32.GetLastError() == 183)  # ERROR_ALREADY_EXISTS
        if h:
            _MUTEX_HANDLE.append(h)
        return bool(h), already
    except Exception:
        return True, False


def _peer_appwindow_process_alive():
    """True when another SamQL-AppWindow.exe (not this PID) is running.

    Distinguishes a live first-click still opening WebView2 (wait for its
    window) from a zombie mutex holder after Exit → keep server (reconnect
    immediately). Best-effort; unknown -> False so reconnect stays fast.
    Source ``python launcher_app.py`` runs are not detected (dev-only).
    """
    if os.name != "nt":
        return False
    try:
        own = os.getpid()
        out = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq SamQL-AppWindow.exe",
             "/FO", "CSV", "/NH"],
            stderr=subprocess.DEVNULL, timeout=2.0)
        text = out.decode("utf-8", "replace") if isinstance(out, bytes) \
            else str(out)
        for line in text.splitlines():
            line = line.strip()
            if not line or line.upper().startswith("INFO:"):
                continue
            # CSV: "SamQL-AppWindow.exe","1234","Session Name","0","12,345 K"
            parts = [p.strip().strip('"') for p in line.split(",")]
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[1])
            except (TypeError, ValueError):
                continue
            if pid and pid != own:
                return True
    except Exception:
        return False
    return False


def _keep_server_requested(port):
    """True when Exit → keep server marked this backend via /api/health."""
    data = _fetch_health(port)
    return bool(data) and bool(data.get("keep_on_close"))


def _ping_maintenance(port):
    """.544: fire-and-forget housekeeping on the server we just attached
    to (or booted): reclaim dead-instance temp and the _MEI extractions
    stranded by previous window closes (the frozen hard-exit skips the
    bootloader's own cleanup). Never blocks a launch -- runs on a daemon
    thread so splash → window handoff is not delayed by disk sweeps."""
    def _run():
        try:
            import json as _json
            r = _local_urlopen(
                "http://127.0.0.1:%d/api/maintenance/sweep-temp" % port,
                data=_json.dumps({"mei_min_age": 90}).encode("utf-8"),
                method="POST", timeout=2.5,
                headers={"Content-Type": "application/json"})
            body = _json.loads(r.read().decode("utf-8"))
            if body.get("removed") or body.get("mei_removed"):
                write_log("INFO startup housekeeping: %s stale instance "
                          "dir(s), %s old _MEI extraction(s) reclaimed"
                          % (body.get("removed", 0),
                             body.get("mei_removed", 0)))
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True,
                     name="samql-startup-maintenance").start()


def _read_kept_mei(root):
    """.547: basenames a RUNNING SamQL server published as protected
    (its own onefile extraction, home of the bundled frontend). A
    persisting server can outlive its launcher; without this its dir
    could be swept and every page would 404 'Not found' on reattach."""
    kept = set()
    try:
        p = os.path.join(root, ".samql_keep_mei")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        kept.add(line)
    except Exception:
        pass
    return kept


def _sweep_mei_dir(root, keep_basename, min_age_sec=120, protected=None):
    """.545 core (injectable for tests): remove _MEIxxxxxx dirs under
    ``root`` except ``keep_basename``, any in ``protected`` (a running
    server's published extraction, .547), and any younger than
    min_age_sec. Returns the list of removed basenames. Never raises."""
    import shutil
    import glob
    protected = protected or set()
    removed = []
    now = time.time()
    try:
        cand = glob.glob(os.path.join(root, "_MEI*"))
    except Exception:
        return removed
    for path in cand:
        try:
            base = os.path.basename(path)
            if base == keep_basename or base in protected \
                    or not os.path.isdir(path):
                continue
            if now - os.path.getmtime(path) < min_age_sec:
                continue
            shutil.rmtree(path, ignore_errors=True)
            if not os.path.exists(path):
                removed.append(base)
        except Exception:
            continue
    return removed


def _is_onedir():
    """.549: True when this frozen build is ONEDIR -- the runtime dir
    (sys._MEIPASS) sits beside the exe, NOT under the system temp root.
    Onedir has no per-launch extraction, so the _MEI sweeps + keep-marker
    are no-ops here."""
    mp = getattr(sys, "_MEIPASS", None)
    if not mp:
        return False
    try:
        import tempfile
        troot = os.path.normcase(os.path.abspath(tempfile.gettempdir()))
        here = os.path.normcase(os.path.abspath(mp))
        return not here.startswith(troot)
    except Exception:
        return False


def _sweep_stale_mei_early():
    """.545: remove _MEIxxxxxx extractions at the TEMP root left by a
    previous SamQL that was killed/slept before its bootloader could
    clean up. Best-effort, silent, and it NEVER touches this process's
    own extraction (sys._MEIPASS) or any dir younger than 2 minutes
    (another instance may be mid-launch). This is what stops the raw
    bootloader "failed to remove temporary directory" warning: the
    stale, still-there dir is gone before the next boot can trip on it."""
    if os.name != "nt" or _is_onedir():
        return
    try:
        import tempfile
        root = tempfile.gettempdir()
        mine = os.path.basename(getattr(sys, "_MEIPASS", "") or "")
        removed = _sweep_mei_dir(root, mine,
                                 protected=_read_kept_mei(root))
        if removed:
            write_log("INFO cleared %d stale _MEI extraction(s) from a "
                      "previous run before boot: %r"
                      % (len(removed), removed))
    except Exception:
        pass


def _run_bundled_server(port):
    """.535: serve from THIS exe. When SamQL-AppWindow.exe travels alone
    (no SamQL.exe beside it), the launcher spawns ITSELF with --serve and
    this branch becomes the server process. Windowed exes ship no stdio,
    so the server's boot prints need a sink first; then the bundled
    server module runs exactly like SamQL.exe --no-browser."""
    import io
    if sys.stdout is None:
        sys.stdout = io.StringIO()
    if sys.stderr is None:
        sys.stderr = io.StringIO()
    try:
        import server as _srv
    except Exception as e:
        write_log("ERROR --serve: the backend is not bundled in this "
                  "build (%s: %s)" % (e.__class__.__name__, e))
        return 1
    # .537: this process IS the running app now -- label OUR extraction
    # (not the exiting parent's) so the storage report reads "held by
    # the running launcher -- frees on exit" for the right directory.
    _mei = getattr(sys, "_MEIPASS", None)
    if _mei:
        os.environ["SAMQL_LAUNCHER_MEI"] = _mei
    write_log("INFO --serve: running the bundled server on port %d"
              % port)
    return _srv.main(["--port", str(port), "--no-browser"]) or 0


# ------------------------------------------------------------ browser

def find_browser(prefer="auto", env=None):
    env = env or os.environ
    pf = env.get("ProgramFiles", r"C:\Program Files")
    pf86 = env.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    lad = env.get("LocalAppData", "")
    edges = [
        os.path.join(pf86, "Microsoft", "Edge", "Application",
                     "msedge.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application",
                     "msedge.exe"),
    ]
    chromes = [
        os.path.join(pf, "Google", "Chrome", "Application",
                     "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application",
                     "chrome.exe"),
        os.path.join(lad, "Google", "Chrome", "Application",
                     "chrome.exe") if lad else "",
    ]
    order = {"edge": edges + chromes,
             "chrome": chromes + edges,
             "auto": edges + chromes}[prefer]
    for p in order:
        if p and os.path.isfile(p):
            return p
    return None


def wait_for_app_window(title_contains="SamQL", timeout_s=None,
                        splash=None, owned_by_pid=None,
                        exe_basenames=None):
    """Poll top-level VISIBLE windows for a title containing "SamQL"
    via EnumWindows -- the moment the app window exists, not a blind
    sleep. Non-Windows (and any ctypes surprise) falls back to a short
    pump so the flow still completes.

    ``timeout_s`` defaults to APP_WINDOW_WAIT_S (cold-start budget).

    Ownership filters (.550): branding used to stamp AppUserModelID on
    ANY title match -- a Teams/Explorer window whose title happened to
    contain "SamQL" then joined the SamQL-APP taskbar group. Pass
    ``owned_by_pid`` (native pywebview host) and/or ``exe_basenames``
    (browser --app fallback, e.g. msedge.exe) so foreign HWNDs are
    never returned for AUMID / icon stamping."""
    if timeout_s is None:
        timeout_s = APP_WINDOW_WAIT_S
    if os.name != "nt":
        (splash.pump(1.0) if splash else time.sleep(1.0))
        return False
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND,
                                   wintypes.LPARAM)
        found = {"hit": False}
        exe_want = None
        if exe_basenames:
            exe_want = {str(x).lower() for x in exe_basenames if x}

        def _owner_ok(pid):
            if owned_by_pid is not None and int(pid) != int(owned_by_pid):
                return False
            if exe_want is not None:
                base = os.path.basename(_proc_image(pid) or "").lower()
                if base not in exe_want:
                    return False
            return True

        def _cb(hwnd, _l):
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if title_contains not in buf.value:
                return True
            pid = ctypes.c_ulong(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if not _owner_ok(pid.value):
                return True  # keep looking -- never brand a foreign HWND
            found["hit"] = True
            found["hwnd"] = hwnd  # .461: hand the window back
            return False

        deadline = time.time() + float(timeout_s)
        while time.time() < deadline:
            found["hit"] = False
            user32.EnumWindows(proto(_cb), 0)
            if found["hit"]:
                return found.get("hwnd") or True
            (splash.pump(0.25) if splash else time.sleep(0.25))
        return False
    except Exception as e:
        write_log("WARN window wait unavailable (%s)"
                  % e.__class__.__name__)
        (splash.pump(1.5) if splash else time.sleep(1.5))
        return False


def _set_process_aumid(aumid=APP_AUMID):
    """Set the process-wide AppUserModelID as early as possible.
    Returns True on success. Failures are logged (never silent) -- a
    missed process AUMID is exactly how the taskbar can regroup us."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        fn = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID
        fn.argtypes = [ctypes.c_wchar_p]
        fn.restype = ctypes.HRESULT
        hr = int(fn(str(aumid)))
        if hr == 0:
            _AUMID_SET.append(True)
            return True
        write_log("WARN SetCurrentProcessExplicitAppUserModelID "
                  "hr=0x%08X (aumid=%s)" % (hr & 0xFFFFFFFF, aumid))
        return False
    except Exception as e:
        write_log("WARN process AppUserModelID not set (%r)" % (e,))
        return False


# ------------------------------------------------------ taskbar icon

def fetch_app_icon(port):
    """Pull the multi-size SamQL .ico from the server we just health-
    checked (GET /favicon.ico) and park it in the samql temp root. One
    source of truth (_brand.py) with no samql_core import here -- the
    launcher stays stdlib-only and tiny.

    .500: retry briefly. The window opens as soon as the port is bound, but the
    server can still be a beat from serving routes (or the port check raced a
    dying prior instance -- the on-box WinError 10061). A few short retries turn
    that transient refusal into a successful stamp instead of a generic icon."""
    last = None
    for attempt in range(6):
        # .526: prefer the AUTHORITATIVE mark (/samql.ico -- the icon
        # bundled into the server exe / repo root) over the web favicon,
        # which a stale frontend_dist/favicon.ico can shadow. That stale
        # shadow is exactly how the Edge-era art kept coming back.
        for route in ("/samql.ico", "/favicon.ico"):
            try:
                with _local_urlopen(
                        "http://127.0.0.1:%d%s" % (port, route),
                        timeout=5) as r:
                    data = r.read()
                if not data or data[:4] != b"\x00\x00\x01\x00":
                    write_log("WARN %s did not return an ICO "
                              "(%d bytes)" % (route, len(data or b"")))
                    continue
                path = os.path.join(_temp_root(), "samql.ico")
                with open(path, "wb") as fh:
                    fh.write(data)
                write_log("INFO icon fetched from %s" % route)
                return path
            except Exception as e:
                last = e
        time.sleep(0.5 * (attempt + 1))
    write_log("WARN icon fetch failed after retries (%s)" % last)
    return None


def _disk_brand_ico():
    """.529: the SamQL.ico a rebuild WOULD embed -- repo root next to the
    exe's folder tree, or exe-adjacent. Used only to warn when the art
    bundled into this exe no longer matches the file on disk (a stale
    build)."""
    try:
        here = os.path.dirname(os.path.abspath(
            sys.executable if getattr(sys, "frozen", False)
            else __file__))
        for c in (os.path.join(here, "SamQL.ico"),
                  os.path.join(here, "samql.ico"),
                  os.path.join(os.path.dirname(here), "SamQL.ico"),
                  os.path.join(os.path.dirname(here), "samql.ico")):
            if os.path.isfile(c):
                return c
    except Exception:
        pass
    return None


def _ico_fingerprint(path):
    """.526: sha12 + size of the art we stamp -- the log now PROVES which
    bytes went onto the window (bundled vs fetched vs stale)."""
    try:
        import hashlib
        with open(path, "rb") as fh:
            b = fh.read()
        return "%s (%d bytes)" % (hashlib.sha256(b).hexdigest()[:12],
                                  len(b))
    except Exception:
        return "unreadable"


def _get_window_prop(hwnd, pid):
    """.527: read one string property back from the window's shell
    property store (mirror of _set_window_prop) -- the diagnosis PROVES
    whether the relaunch group actually landed."""
    if os.name != "nt" or not hwnd:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("d1", ctypes.c_ulong),
                        ("d2", ctypes.c_ushort),
                        ("d3", ctypes.c_ushort),
                        ("d4", ctypes.c_ubyte * 8)]

        class PROPERTYKEY(ctypes.Structure):
            _fields_ = [("fmtid", GUID), ("pid", ctypes.c_ulong)]

        class PROPVARIANT(ctypes.Structure):
            _fields_ = [("vt", ctypes.c_ushort),
                        ("r1", ctypes.c_ushort),
                        ("r2", ctypes.c_ushort),
                        ("r3", ctypes.c_ushort),
                        ("pwszVal", ctypes.c_wchar_p),
                        ("pad", ctypes.c_byte * 8)]

        iid = GUID(0x886D8EEB, 0x8CF2, 0x4446,
                   (ctypes.c_ubyte * 8)(0x8D, 0x02, 0xCD, 0xBA,
                                        0x1D, 0xBD, 0xCF, 0x99))
        pkey = PROPERTYKEY(
            GUID(0x9F4C2855, 0x9F79, 0x4B39,
                 (ctypes.c_ubyte * 8)(0xA8, 0xD0, 0xE1, 0xD4,
                                      0x2D, 0xE1, 0xD5, 0xF3)),
            int(pid))
        store = ctypes.c_void_p()
        hr = ctypes.windll.shell32.SHGetPropertyStoreForWindow(
            wintypes.HWND(hwnd), ctypes.byref(iid), ctypes.byref(store))
        if hr != 0 or not store.value:
            return None
        try:
            vtbl = ctypes.cast(
                store, ctypes.POINTER(ctypes.POINTER(
                    ctypes.c_void_p))).contents
            GetValue = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p,
                ctypes.POINTER(PROPERTYKEY),
                ctypes.POINTER(PROPVARIANT))(vtbl[5])
            pv = PROPVARIANT()
            if GetValue(store, ctypes.byref(pkey),
                        ctypes.byref(pv)) != 0:
                return None
            if pv.vt == 31 and pv.pwszVal:   # VT_LPWSTR
                return str(pv.pwszVal)
            return None
        finally:
            Release = ctypes.WINFUNCTYPE(
                ctypes.c_ulong, ctypes.c_void_p)(
                    ctypes.cast(store, ctypes.POINTER(
                        ctypes.POINTER(ctypes.c_void_p))).contents[2])
            Release(store)
    except Exception:
        return None


_LAST_ICON_HANDLES = {}


def ensure_shell_shortcuts(exe_path, ico_path):
    """.531: the diagnosis cleared the window (icons, class, props all
    ours) and found exactly ONE shell object left that can supply the
    taskbar group's art: the Start-menu SamQL-AppWindow.lnk. When the
    app is launched THROUGH a shortcut, the shell prefers the
    SHORTCUT'S own icon for the taskbar button -- an old lnk beats every
    window stamp, forever. So the launcher now OWNS its shortcuts: any
    SamQL*.lnk in the Start menu / Desktop is read (old target + icon
    logged -- that log line IS the audit), then rewritten to point at
    THIS exe with THIS icon and the SamQL.SamQL AppUserModelID, and the
    shell is notified. Pure ctypes COM; every step logs on failure and
    never blocks the launch."""
    if os.name != "nt" or not exe_path:
        return
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("d1", ctypes.c_ulong),
                        ("d2", ctypes.c_ushort),
                        ("d3", ctypes.c_ushort),
                        ("d4", ctypes.c_ubyte * 8)]

        def _guid(a, b, c, tail):
            return GUID(a, b, c, (ctypes.c_ubyte * 8)(*tail))

        CLSID_ShellLink = _guid(0x00021401, 0, 0,
                                (0xC0, 0, 0, 0, 0, 0, 0, 0x46))
        IID_IShellLinkW = _guid(0x000214F9, 0, 0,
                                (0xC0, 0, 0, 0, 0, 0, 0, 0x46))
        IID_IPersistFile = _guid(0x0000010B, 0, 0,
                                 (0xC0, 0, 0, 0, 0, 0, 0, 0x46))
        IID_IPropertyStore = _guid(0x886D8EEB, 0x8CF2, 0x4446,
                                   (0x8D, 0x02, 0xCD, 0xBA,
                                    0x1D, 0xBD, 0xCF, 0x99))

        ole32 = ctypes.windll.ole32
        ole32.CoInitialize(None)

        def _vt(obj, idx, restype, *argtypes):
            vtbl = ctypes.cast(obj, ctypes.POINTER(
                ctypes.POINTER(ctypes.c_void_p))).contents
            return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p,
                                      *argtypes)(vtbl[idx])

        def _fix_one(lnk):
            link = ctypes.c_void_p()
            hr = ole32.CoCreateInstance(
                ctypes.byref(CLSID_ShellLink), None, 1,
                ctypes.byref(IID_IShellLinkW), ctypes.byref(link))
            if hr != 0 or not link.value:
                write_log("WARN shortcut COM create failed (0x%08x)"
                          % (hr & 0xFFFFFFFF))
                return
            try:
                QI = _vt(link, 0, ctypes.c_long, ctypes.POINTER(GUID),
                         ctypes.POINTER(ctypes.c_void_p))
                pf = ctypes.c_void_p()
                if QI(link, ctypes.byref(IID_IPersistFile),
                      ctypes.byref(pf)) != 0:
                    return
                Load = _vt(pf, 5, ctypes.c_long, ctypes.c_wchar_p,
                           ctypes.c_ulong)
                Save = _vt(pf, 6, ctypes.c_long, ctypes.c_wchar_p,
                           ctypes.c_long)
                if Load(pf, lnk, 2) != 0:   # STGM_READWRITE
                    write_log("WARN shortcut load failed: %s" % lnk)
                    return
                # -- audit: what the lnk pointed at BEFORE --
                buf = ctypes.create_unicode_buffer(520)
                GetPath = _vt(link, 3, ctypes.c_long, ctypes.c_wchar_p,
                              ctypes.c_int, ctypes.c_void_p,
                              ctypes.c_ulong)
                GetPath(link, buf, 520, None, 0)
                ibuf = ctypes.create_unicode_buffer(520)
                iidx = ctypes.c_int(0)
                GetIcon = _vt(link, 16, ctypes.c_long,
                              ctypes.c_wchar_p, ctypes.c_int,
                              ctypes.POINTER(ctypes.c_int))
                GetIcon(link, ibuf, 520, ctypes.byref(iidx))
                write_log("AUDIT lnk BEFORE target=%r icon=%r,%d  (%s)"
                          % (buf.value, ibuf.value, iidx.value, lnk))
                # -- rewrite: this exe, this icon, our AUMID --
                SetPath = _vt(link, 20, ctypes.c_long, ctypes.c_wchar_p)
                SetPath(link, exe_path)
                SetWD = _vt(link, 9, ctypes.c_long, ctypes.c_wchar_p)
                SetWD(link, os.path.dirname(exe_path))
                SetIcon = _vt(link, 17, ctypes.c_long,
                              ctypes.c_wchar_p, ctypes.c_int)
                SetIcon(link, exe_path, 0)
                ps = ctypes.c_void_p()
                if QI(link, ctypes.byref(IID_IPropertyStore),
                      ctypes.byref(ps)) == 0 and ps.value:

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
                    pk = PROPERTYKEY(
                        _guid(0x9F4C2855, 0x9F79, 0x4B39,
                              (0xA8, 0xD0, 0xE1, 0xD4,
                               0x2D, 0xE1, 0xD5, 0xF3)), 5)
                    pv = PROPVARIANT()
                    pv.vt = 31
                    pv.pwszVal = APP_AUMID
                    SetVal = _vt(ps, 6, ctypes.c_long,
                                 ctypes.POINTER(PROPERTYKEY),
                                 ctypes.POINTER(PROPVARIANT))
                    Commit = _vt(ps, 7, ctypes.c_long)
                    SetVal(ps, ctypes.byref(pk), ctypes.byref(pv))
                    Commit(ps)
                    _vt(ps, 2, ctypes.c_ulong)(ps)
                if Save(pf, lnk, 1) == 0:
                    write_log("INFO lnk REWRITTEN -> target+icon=this "
                              "exe, AUMID=%s (%s)" % (APP_AUMID, lnk))
                else:
                    write_log("WARN lnk save failed: %s" % lnk)
                _vt(pf, 2, ctypes.c_ulong)(pf)
            finally:
                _vt(link, 2, ctypes.c_ulong)(link)

        ap = os.environ.get("APPDATA", "")
        up = os.path.expanduser("~")
        roots = [os.path.join(ap, "Microsoft", "Windows",
                              "Start Menu", "Programs"),
                 os.path.join(up, "Desktop"),
                 os.path.join(up, "OneDrive", "Desktop")]
        found = 0
        for d in roots:
            if not os.path.isdir(d):
                continue
            for base, _dd, ff in os.walk(d):
                for f in ff:
                    if (f.lower().endswith(".lnk")
                            and "samql" in f.lower()):
                        found += 1
                        try:
                            _fix_one(os.path.join(base, f))
                        except Exception as e:
                            write_log("WARN lnk rewrite failed (%s): %s"
                                      % (e.__class__.__name__, f))
        # nudge the shell to drop its cached art for the exe + lnks
        try:
            SHCNE_UPDATEITEM = 0x00002000
            SHCNF_PATHW = 0x0005
            ctypes.windll.shell32.SHChangeNotify(
                SHCNE_UPDATEITEM, SHCNF_PATHW,
                ctypes.c_wchar_p(exe_path), None)
        except Exception:
            pass
        write_log("INFO shell shortcuts audited: %d SamQL lnk(s)"
                  % found)
    except Exception as e:
        write_log("WARN shortcut audit failed (%s)"
                  % e.__class__.__name__)


def _enum_process_windows():
    """.527: every visible TOP-LEVEL window of THIS process --
    (hwnd, class, title, big-icon handle). The taskbar entry may belong
    to a different hwnd than the one we stamped; this finds it."""
    out = []
    if os.name != "nt":
        return out
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        WM_GETICON = 0x007F
        mypid = os.getpid()
        proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND,
                                  wintypes.LPARAM)

        def cb(h, _l):
            try:
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
                if pid.value != mypid or not user32.IsWindowVisible(h):
                    return True
                buf = ctypes.create_unicode_buffer(128)
                user32.GetClassNameW(h, buf, 128)
                tbuf = ctypes.create_unicode_buffer(128)
                user32.GetWindowTextW(h, tbuf, 128)
                big = user32.SendMessageW(h, WM_GETICON, 1, 0)
                out.append((int(h), buf.value, tbuf.value, int(big or 0)))
            except Exception:
                pass
            return True

        user32.EnumWindows(proc(cb), 0)
    except Exception:
        pass
    return out


def stamp_all_process_windows(ico_path):
    """.527: apply the mark to EVERY visible top-level window this process
    owns -- covers the case where the taskbar's hwnd is not the one the
    shown-callback handed us."""
    n = 0
    for h, _cls, _title, _big in _enum_process_windows():
        if apply_app_icon(h, ico_path):
            n += 1
    if n:
        write_log("INFO stamped %d process window(s)" % n)
    return n


def diagnose_taskbar_icon(hwnd, ico_path):
    """.527: the in-depth readback Sam asked for. Logs, in one block,
    every surface Windows could take the taskbar art from -- so the log
    itself says exactly where a wrong mark is coming from:
      - the .ico file we stamp (sha + parsed entry sizes)
      - the window: class, title, styles, root/owner
      - WM_GETICON big/small/small2 + the CLASS icon (GCLP) read back
      - the window property store: AUMID / RelaunchCommand / DisplayName /
        RelaunchIconResource read back
      - the process AUMID
      - every visible top-level window of this process (+ its icon)
      - the exe's EMBEDDED icon count (0 = built without an icon!)
      - taskbar PINS whose .lnk bytes mention SamQL (a pin's own icon
        overrides everything for the group)"""
    if os.name != "nt":
        return
    try:
        import ctypes
        import hashlib
        import struct
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        W = write_log
        W("==== ICON DIAGNOSIS ====")
        # 1) the art itself
        try:
            with open(ico_path, "rb") as fh:
                b = fh.read()
            n = struct.unpack("<H", b[4:6])[0] if len(b) >= 6 else 0
            sizes = []
            for i in range(min(n, 16)):
                e = b[6 + 16 * i: 6 + 16 * i + 16]
                if len(e) == 16:
                    w0 = e[0] or 256
                    sizes.append(w0)
            W("DIAG ico path=%s sha=%s entries=%d sizes=%r"
              % (ico_path, hashlib.sha256(b).hexdigest()[:12], n,
                 sorted(sizes)))
        except Exception as e:
            W("DIAG ico unreadable: %s" % e)
        # 2) the window
        try:
            cls = ctypes.create_unicode_buffer(128)
            user32.GetClassNameW(hwnd, cls, 128)
            ttl = ctypes.create_unicode_buffer(128)
            user32.GetWindowTextW(hwnd, ttl, 128)
            root = user32.GetAncestor(hwnd, 2)
            owner = user32.GetWindow(hwnd, 4)
            ex = user32.GetWindowLongPtrW(hwnd, -20)
            W("DIAG hwnd=%s class=%s title=%r visible=%s root=%s "
              "owner=%s exstyle=0x%x appwindow=%s toolwindow=%s"
              % (hwnd, cls.value, ttl.value,
                 bool(user32.IsWindowVisible(hwnd)), int(root),
                 int(owner), int(ex), bool(ex & 0x40000),
                 bool(ex & 0x80)))
        except Exception as e:
            W("DIAG window readback failed: %s" % e)
        # 3) icon surfaces on the window
        try:
            WM_GETICON = 0x007F
            gi = [int(user32.SendMessageW(hwnd, WM_GETICON, w, 0) or 0)
                  for w in (1, 0, 2)]
            gcl = [int(user32.GetClassLongPtrW(hwnd, w) or 0)
                   for w in (-14, -34)]
            W("DIAG WM_GETICON big/small/small2=%r  class GCLP "
              "big/small=%r  (0 = unset -> Windows falls back)"
              % (gi, gcl))
            ours = _LAST_ICON_HANDLES.get(int(hwnd), {})
            W("DIAG window icon is OURS: big=%s small=%s  (a False here "
              "= something repainted over the stamp)"
              % (gi[0] == ours.get(1), gi[1] == ours.get(0)))
        except Exception as e:
            W("DIAG icon readback failed: %s" % e)
        # 4) the property store, read back
        props = {pid: _get_window_prop(hwnd, pid)
                 for pid in (5, 2, 4, 3)}
        W("DIAG props aumid=%r relaunch_cmd=%r name=%r icon=%r"
          % (props[5], props[2], props[4], props[3]))
        # 5) process AUMID
        try:
            pw = ctypes.c_wchar_p()
            ctypes.windll.shell32.\
                GetCurrentProcessExplicitAppUserModelID(
                    ctypes.byref(pw))
            W("DIAG process AUMID=%r" % pw.value)
        except Exception as e:
            W("DIAG process AUMID unreadable: %s" % e)
        # 6) every top-level window of this process
        for h, c, t, big in _enum_process_windows():
            W("DIAG toplevel hwnd=%s class=%s title=%r big_icon=%s%s"
              % (h, c, t, big,
                 "  <-- STAMP TARGET" if h == int(hwnd) else ""))
        # 7) the exe's embedded icon
        try:
            exe = sys.executable or ""
            cnt = ctypes.windll.shell32.ExtractIconExW(
                exe, -1, None, None, 0)
            W("DIAG exe=%s embedded_icons=%d%s"
              % (exe, int(cnt),
                 "  <-- BUILT WITHOUT AN ICON" if int(cnt) == 0 else ""))
        except Exception as e:
            W("DIAG exe icon count failed: %s" % e)
        # 7.5) the AUMID registry key -- an OLD experiment that created
        # HKCU\Software\Classes\AppUserModelId\SamQL.SamQL with its own
        # icon makes the shell use THAT art for the whole group, beating
        # every window stamp. If this logs values, delete the key.
        try:
            import winreg
            for _aum in (APP_AUMID,) + _LEGACY_AUMIDS:
                vals = {}
                try:
                    k = winreg.OpenKey(
                        winreg.HKEY_CURRENT_USER,
                        r"Software\Classes\AppUserModelId" + "\\"
                        + _aum)
                    i = 0
                    while True:
                        try:
                            nm, v, _t2 = winreg.EnumValue(k, i)
                            vals[nm] = str(v)
                            i += 1
                        except OSError:
                            break
                    winreg.CloseKey(k)
                    W("DIAG registry AppUserModelId\\%s EXISTS "
                      "values=%r  <-- the shell prefers THIS art; "
                      "delete the key if it points at old/Edge art"
                      % (_aum, vals))
                except FileNotFoundError:
                    W("DIAG registry AppUserModelId\\%s: absent (good)"
                      % _aum)
        except Exception as e:
            W("DIAG registry readback failed: %s" % e)
        # 8) taskbar pins that mention SamQL
        try:
            pin_dir = os.path.join(
                os.environ.get("APPDATA", ""),
                "Microsoft", "Internet Explorer", "Quick Launch",
                "User Pinned", "TaskBar")
            hits = []
            if os.path.isdir(pin_dir):
                for f in os.listdir(pin_dir):
                    if not f.lower().endswith(".lnk"):
                        continue
                    fp = os.path.join(pin_dir, f)
                    try:
                        with open(fp, "rb") as fh:
                            lb = fh.read()
                        if (b"S\x00a\x00m\x00Q\x00L\x00" in lb
                                or b"SamQL" in lb):
                            hits.append(f)
                    except OSError:
                        pass
            W("DIAG taskbar pins mentioning SamQL: %r  (a pin's OWN icon "
              "overrides the window's for the whole group -- unpin + "
              "repin if this lists an old one)" % hits)
        except Exception as e:
            W("DIAG pin scan failed: %s" % e)
        # 9) Start-menu + Desktop shortcuts that mention SamQL -- the
        # shortcut he LAUNCHES FROM supplies the group art when its own
        # AUMID matches; an old one carries old art.
        try:
            spots = []
            ap = os.environ.get("APPDATA", "")
            up = os.path.expanduser("~")
            for d in (
                os.path.join(ap, "Microsoft", "Windows", "Start Menu",
                             "Programs"),
                os.path.join(up, "Desktop"),
                os.path.join(up, "OneDrive", "Desktop"),
            ):
                if not os.path.isdir(d):
                    continue
                for base, _dd, ff in os.walk(d):
                    for f in ff:
                        if not f.lower().endswith(".lnk"):
                            continue
                        fp = os.path.join(base, f)
                        try:
                            with open(fp, "rb") as fh:
                                lb = fh.read()
                            if (b"S\x00a\x00m\x00Q\x00L\x00" in lb
                                    or b"SamQL" in lb):
                                spots.append(fp)
                        except OSError:
                            pass
            W("DIAG shortcuts mentioning SamQL: %r  (re-create any that "
              "predate the current icon)" % spots[:8])
        except Exception as e:
            W("DIAG shortcut scan failed: %s" % e)
        W("==== END ICON DIAGNOSIS ====")
    except Exception as e:
        write_log("WARN icon diagnosis failed (%s)"
                  % e.__class__.__name__)


def apply_app_icon(hwnd, ico_path):
    """Stamp the SamQL mark onto the browser's --app window with
    WM_SETICON (big + small), so the taskbar button and Alt-Tab show
    SamQL instead of the Edge/Chrome logo. Works on any process's
    window; failures only log."""
    if os.name != "nt" or not hwnd or not ico_path:
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        LR_LOADFROMFILE = 0x0010
        IMAGE_ICON = 1
        WM_SETICON = 0x0080
        ICON_SMALL, ICON_BIG = 0, 1
        ok = False
        for which, px in ((ICON_BIG, 32), (ICON_SMALL, 16)):
            h = user32.LoadImageW(None, ico_path, IMAGE_ICON,
                                  px, px, LR_LOADFROMFILE)
            if h:
                user32.SendMessageW(hwnd, WM_SETICON, which, h)
                # .531: remember OUR handle so the diagnosis can prove
                # whether the icon on the window is OURS or a repaint
                _LAST_ICON_HANDLES.setdefault(int(hwnd), {})[
                    int(which)] = int(h)
                ok = True
        # .525 on-box: WM_SETICON brands the WINDOW, but the taskbar and
        # Alt-Tab can sample the CLASS icon of the WinForms host -- which
        # still wore the Edge/WebView2 mark. Stamp the class too
        # (GCLP_HICON / GCLP_HICONSM); per-window on this class object.
        try:
            GCLP_HICON, GCLP_HICONSM = -14, -34
            setcl = getattr(user32, "SetClassLongPtrW", None)
            if setcl is None:
                setcl = user32.SetClassLongW
            hbig = user32.LoadImageW(None, ico_path, IMAGE_ICON,
                                     32, 32, LR_LOADFROMFILE)
            hsm = user32.LoadImageW(None, ico_path, IMAGE_ICON,
                                    16, 16, LR_LOADFROMFILE)
            did = False
            for which, h in ((GCLP_HICON, hbig), (GCLP_HICONSM, hsm)):
                if h:
                    setcl(hwnd, which, h)
                    did = True
            if did:
                write_log("INFO class icon set (GCLP) on hwnd %s" % hwnd)
        except Exception as e:
            write_log("WARN class icon set failed (%s)"
                      % e.__class__.__name__)
        if ok:
            try:
                WM_GETICON = 0x007F
                back = int(user32.SendMessageW(hwnd, WM_GETICON, 1, 0)
                           or 0)
                write_log("INFO app icon applied to hwnd %s "
                          "(readback big=%s)" % (hwnd, back or "UNSET"))
            except Exception:
                write_log("INFO app icon applied to hwnd %s" % hwnd)
        return ok
    except Exception as e:
        write_log("WARN could not apply the app icon (%s)"
                  % e.__class__.__name__)
        return False


def _set_window_prop(hwnd, pid, value):
    """Set one string property (fmtid 9F4C2855..., given pid) on a
    window's shell property store: pid 5 = AppUserModel_ID, pid 3 =
    AppUserModel_RelaunchIconResource. Pure ctypes COM; returns True on
    success. Shared by the AUMID and the taskbar-icon override below."""
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
            _fields_ = [("fmtid", GUID), ("pid", ctypes.c_ulong)]

        class PROPVARIANT(ctypes.Structure):
            _fields_ = [("vt", ctypes.c_ushort),
                        ("r1", ctypes.c_ushort),
                        ("r2", ctypes.c_ushort),
                        ("r3", ctypes.c_ushort),
                        ("pwszVal", ctypes.c_wchar_p),
                        ("pad", ctypes.c_byte * 8)]

        iid = GUID(0x886D8EEB, 0x8CF2, 0x4446,
                   (ctypes.c_ubyte * 8)(0x8D, 0x02, 0xCD, 0xBA,
                                        0x1D, 0xBD, 0xCF, 0x99))
        # PKEY_AppUserModel_* live under one fmtid; only the pid differs.
        pkey = PROPERTYKEY(
            GUID(0x9F4C2855, 0x9F79, 0x4B39,
                 (ctypes.c_ubyte * 8)(0xA8, 0xD0, 0xE1, 0xD4,
                                      0x2D, 0xE1, 0xD5, 0xF3)), pid)
        store = ctypes.c_void_p()
        hr = ctypes.windll.shell32.SHGetPropertyStoreForWindow(
            wintypes.HWND(hwnd), ctypes.byref(iid),
            ctypes.byref(store))
        if hr != 0 or not store:
            return False
        vtbl = ctypes.cast(
            store, ctypes.POINTER(ctypes.POINTER(
                ctypes.c_void_p * 8))).contents.contents
        SetValue = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p,
            ctypes.POINTER(PROPERTYKEY),
            ctypes.POINTER(PROPVARIANT))(vtbl[6])
        Commit = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p)(vtbl[7])
        Release = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p)(vtbl[2])
        pv = PROPVARIANT()
        pv.vt = 31  # VT_LPWSTR
        pv.pwszVal = value
        hr1 = SetValue(store, ctypes.byref(pkey), ctypes.byref(pv))
        hr2 = Commit(store)
        Release(store)
        return hr1 == 0 and hr2 == 0
    except Exception as e:
        write_log("WARN window-prop plumbing failed (%s)"
                  % e.__class__.__name__)
        return False


def set_app_user_model_id(hwnd, aumid=APP_AUMID):
    """Give the --app window its OWN AppUserModelID so the taskbar stops
    grouping it under Edge/Chrome (grouped buttons inherit the HOST's
    icon). Any failure logs and moves on."""
    ok = _set_window_prop(hwnd, 5, aumid)
    write_log(("INFO AppUserModelID set (%s)" % aumid) if ok
              else "WARN AppUserModelID not set")
    return ok


def set_relaunch_icon(hwnd, ico_path):
    """Set the FULL PKEY_AppUserModel relaunch group on the window's
    property store. .527: Windows documents that RelaunchIconResource is
    honored ONLY when RelaunchCommand is also set -- we had been setting
    the icon alone, which the taskbar silently ignored. Now: pid 5
    AppUserModel_ID (window-level, matching the process AUMID), pid 2
    RelaunchCommand (this exe), pid 4 RelaunchDisplayNameResource
    ("SamQL"), pid 3 RelaunchIconResource ("path,0")."""
    okid = _set_window_prop(hwnd, 5, APP_AUMID)
    okc = _set_window_prop(hwnd, 2, '"%s"' % (sys.executable or ""))
    okn = _set_window_prop(hwnd, 4, "SamQL")
    ok = _set_window_prop(hwnd, 3, "%s,0" % ico_path)
    write_log("INFO relaunch icon set" if ok
              else "WARN relaunch icon not set")
    write_log("INFO relaunch props aumid=%s cmd=%s name=%s icon=%s"
              % (okid, okc, okn, ok))
    return ok


# ------------------------------------------------------ native window

def _parse_window_size(spec, default=(1400, 900)):
    """"W,H" -> (int W, int H); the pywebview window's initial size."""
    try:
        w, h = str(spec).split(",")
        return max(400, int(w)), max(300, int(h))
    except Exception:
        return default


def _webview_storage_path():
    """.490: a STABLE per-user folder for the native window's cookies /
    localStorage / IndexedDB, so the app-window build keeps state across
    launches exactly like the browser-tab build (which uses the browser's
    own persistent profile). Without this pywebview runs private_mode and
    nothing survives a restart. Both entry points (this launcher and the
    server's own --window) use the SAME path, so state is shared."""
    base = (os.environ.get("LOCALAPPDATA")
            or os.environ.get("APPDATA")
            or os.path.expanduser("~"))
    path = os.path.join(base, "SamQL", "webview")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path


def _local_urlopen(url, data=None, timeout=3, method=None, headers=None):
    """.509: urlopen for 127.0.0.1 that BYPASSES any system/corporate proxy.
    Plain urllib honors HTTP(S)_PROXY, and on a managed box that can hijack
    even localhost -- the on-box 'server shutdown request failed (URLError)'
    that left a zombie server holding the port. Every launcher HTTP call to
    the local server goes through here."""
    import urllib.request as _r
    req = _r.Request(url, data=data, method=method,
                     headers=dict(headers or {}))
    opener = _r.build_opener(_r.ProxyHandler({}))
    return opener.open(req, timeout=timeout)


def _fetch_health(port):
    """Return /api/health JSON dict, or None on any failure."""
    try:
        import json as _j
        with _local_urlopen("http://127.0.0.1:%d/api/health" % port,
                            timeout=1.5) as r:
            return _j.loads(r.read().decode("utf-8", "replace") or "{}")
    except Exception:
        return None


def _is_samql(port):
    """True when the thing answering on the port identifies as SamQL."""
    data = _fetch_health(port)
    return bool(data) and (data.get("app") or "").lower() == "samql"


def wait_for_server_ready(port, splash=None):
    """Wait until /api/health identifies as SamQL (open window then).

    Heartbeat wait (not a single wall-clock to first health):
      * fail immediately if the server child we spawned has exited
      * process-still-alive and TCP / health-stage progress reset an
        idle timer (SERVER_BOOT_IDLE_TIMEOUT_S)
      * absolute ceiling SERVER_BOOT_TIMEOUT_S still applies so a
        hung-but-alive child cannot sit forever
    ``warming: true`` does not hold the splash -- once health answers
    with app=SamQL we open (session warm continues in the background).
    Optional health ``stage`` (from the server BootBar) is logged and
    shown on the splash when present.

    Returns None on success, or an error message string on failure.
    """
    if splash is None:
        splash = _NullSplash()
    t0 = time.time()
    abs_deadline = t0 + float(SERVER_BOOT_TIMEOUT_S)
    idle_s = float(SERVER_BOOT_IDLE_TIMEOUT_S)
    last_beat = t0
    last_log = 0.0
    saw_tcp = False
    last_stage = None
    write_log(
        "INFO waiting for /api/health on port %d "
        "(idle %ds / absolute %ds)"
        % (port, int(idle_s), int(SERVER_BOOT_TIMEOUT_S))
    )
    splash.set_text("Waiting for SamQL to be ready...")
    while True:
        now = time.time()
        # 1) Child we spawned died -> fail immediately (do not burn budget).
        proc = globals().get("_SERVER_PROC")
        if proc is not None:
            try:
                rc = proc.poll()
            except Exception:
                rc = None
            if rc is not None:
                msg = ("The SamQL server process exited before it was "
                       "ready (exit %s)." % rc)
                write_log("ERROR %s" % msg)
                return msg
            # Process still alive counts as a heartbeat.
            last_beat = now

        # 2) Ready: health identifies as SamQL (even while warming).
        if _server_alive_now(port):
            write_log("INFO server ready on port %d after %.1fs"
                      % (port, now - t0))
            return None

        # 3) Progress heartbeats: TCP bind, health stage text.
        try:
            tcp = port_open(port)
        except Exception:
            tcp = False
        if tcp:
            if not saw_tcp:
                saw_tcp = True
                write_log("INFO TCP bound on port %d (still waiting "
                          "for /api/health)" % port)
            last_beat = now
            health = _fetch_health(port)
            if isinstance(health, dict):
                stage = (health.get("stage") or "").strip()
                if stage and stage != last_stage:
                    last_stage = stage
                    last_beat = now
                    write_log("INFO boot stage: %s" % stage)
                    splash.set_text("Starting SamQL (%s)..." % stage)

        # 4) Idle / absolute ceilings.
        if (now - last_beat) >= idle_s:
            msg = ("The SamQL server stopped making boot progress on "
                   "port %d (no heartbeat for %d s)."
                   % (port, int(idle_s)))
            write_log("ERROR %s" % msg)
            return msg
        if now >= abs_deadline:
            msg = ("The server did not come up on port %d within %d s "
                   "(see the error log in Settings)."
                   % (port, int(SERVER_BOOT_TIMEOUT_S)))
            write_log("ERROR %s" % msg)
            return msg

        elapsed = now - t0
        if elapsed - last_log >= 15.0:
            write_log(
                "INFO still waiting for /api/health on port %d "
                "(%.0fs elapsed, idle %.0fs / abs %ds%s)"
                % (port, elapsed, now - last_beat,
                   int(SERVER_BOOT_TIMEOUT_S),
                   (", stage=%s" % last_stage) if last_stage else "")
            )
            last_log = elapsed
        # Pump the splash (tk message loop). _NullSplash.pump is a no-op,
        # so always yield at least ~250 ms -- restart_server / supervisor
        # must not busy-spin a core while waiting.
        t_pump = time.time()
        splash.pump(0.25)
        remain = 0.25 - (time.time() - t_pump)
        if remain > 0.01:
            time.sleep(remain)


def _log_webview_diag(webview):
    """.508: one launcher.log block that pins WHY a native window does or
    doesn't appear -- pywebview version, whether the WebView2 platform modules
    made it INTO this frozen exe, whether pythonnet/clr can load, whether the
    WebView2 RUNTIME is installed (registry), and the .NET release. All
    best-effort; never raises."""
    try:
        import importlib.util as _ilu
        _ver = getattr(webview, "__version__", None)
        if not _ver:
            try:
                from importlib.metadata import version as _mdv
                _ver = _mdv("pywebview")
            except Exception:
                _ver = "?"
        bits = ["pywebview=%s" % _ver]
        for m in ("webview.platforms.edgechromium",
                  "webview.platforms.winforms", "clr_loader", "pythonnet"):
            try:
                bits.append("%s=%s" % (m.split(".")[-1],
                                       "ok" if _ilu.find_spec(m) else "MISSING"))
            except Exception as e:
                bits.append("%s=ERR(%s)" % (m.split(".")[-1],
                                            e.__class__.__name__))
        try:
            import clr  # noqa: F401 -- pythonnet actually loads?
            bits.append("clr-import=ok")
        except Exception as e:
            bits.append("clr-import=FAIL(%r)" % (e,))
        if os.name == "nt":
            try:
                import winreg
                pv = None
                for hive, key in (
                        (winreg.HKEY_LOCAL_MACHINE,
                         r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"
                         r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                        (winreg.HKEY_CURRENT_USER,
                         r"SOFTWARE\Microsoft\EdgeUpdate\Clients"
                         r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")):
                    try:
                        with winreg.OpenKey(hive, key) as k:
                            pv = winreg.QueryValueEx(k, "pv")[0]
                            break
                    except OSError:
                        continue
                bits.append("webview2-runtime=%s" % (pv or "MISSING"))
            except Exception as e:
                bits.append("webview2-runtime=ERR(%s)" % e.__class__.__name__)
        write_log("INFO webview diag: " + " ".join(bits))
    except Exception:
        pass


def open_native_window(url, args, splash):
    """.485: open SamQL in a NATIVE OS window via pywebview. The launcher
    process OWNS the window. .493: the WebView2 backend does NOT reliably give
    its window THIS exe's embedded icon, so the launcher stamps the SamQL mark
    onto it (WM_SETICON + AppUserModelID + RelaunchIconResource) from a helper
    thread -- the same machinery the browser fallback below uses. pywebview
    drives its own GUI loop on the main thread and blocks until the window is
    closed. Mirrors the server's own --window path (server.main()).

    Returns True if pywebview drove the window (it has already closed by the
    time this returns); False when pywebview isn't available or fails to start,
    so main() falls back to a chromeless Edge/Chrome window. This keeps the
    launcher working on a bare stdlib interpreter -- pywebview is bundled into
    the exe but is NOT required to run from source (the no-new-dependencies
    rule for running from source still holds)."""
    try:
        import webview  # pywebview -- optional, bundled into SamQL-AppWindow.exe
    except Exception as _imp:
        write_log("WARN pywebview not importable (%r); using a browser app "
                  "window" % (_imp,))
        return False
    _log_webview_diag(webview)
    try:
        w, h = _parse_window_size(args.window_size)
        splash.set_text("Opening the SamQL window...")
        # WebView2's default background is white (#FFFFFF). Until HTML/CSS
        # paint, that is the "white unresponsive first-open window" users
        # report -- match the splash / app chrome so the handoff stays dark.
        win = webview.create_window("SamQL", url, width=w, height=h,
                                    min_size=(900, 600),
                                    background_color=CHROME_BG)

        def _set_native_icon(_w=win):
            """.513/.517: schedule Form.Icon branding without blocking the
            GUI thread. Setting the WinForms Form.Icon is the REAL fix --
            frame, taskbar and alt-tab all read it -- where WM_SETICON
            stamping raced WebView2 repaints. .517 (on-box "native icon
            skipped (AttributeError)"): the start-func fires before
            window.native exists, so WAIT for the shown event and for
            .native to appear, then brand through the Form itself -- its
            Handle is the authoritative hwnd, so the AUMID + relaunch
            icon land on the RIGHT window with no title search.

            Critical: this callback runs on the pywebview GUI thread.
            Waiting / sleeping here deadlocks the message pump (shown
            cannot fire while we block) and Windows marks the window
            Not Responding ~5s after open -- reproduced with and without
            a bundled GGUF. Do the wait on a daemon thread; return here
            immediately so first paint stays responsive."""
            def _brand_form_icon():
                try:
                    ip = _bundled_asset("samql.ico")
                    if not ip:
                        write_log("INFO native icon skipped (no bundled ico)")
                        return
                    try:
                        ev = getattr(getattr(_w, "events", None), "shown", None)
                        if ev is not None:
                            ev.wait(10)
                    except Exception:
                        pass
                    native = None
                    for _ in range(50):                    # up to ~10s
                        native = getattr(_w, "native", None)
                        if native is not None:
                            break
                        time.sleep(0.2)
                    if native is None:
                        write_log("INFO native icon skipped (window.native "
                                  "never appeared); stamper will cover")
                        return

                    def _apply():
                        import clr  # noqa: F401  (pythonnet, bundled)
                        from System.Drawing import Icon as _Icon  # type: ignore
                        native.Icon = _Icon(ip)
                        try:
                            native.ShowIcon = True
                        except Exception:
                            pass
                        hwnd = None
                        try:
                            hwnd = int(str(native.Handle))
                        except Exception:
                            hwnd = None
                        if hwnd:
                            # brand the KNOWN hwnd too -- taskbar identity +
                            # pinned relaunch icon, no title-search guesswork
                            set_app_user_model_id(hwnd)
                            apply_app_icon(hwnd, ip)
                            set_relaunch_icon(hwnd, ip)
                        write_log("INFO native WinForms icon set (hwnd=%s)"
                                  % (hwnd or "?"))

                    # Prefer marshaling onto the WinForms UI thread.
                    try:
                        from System import Action  # type: ignore
                        native.BeginInvoke(Action(_apply))
                    except Exception:
                        _apply()
                except Exception as _e:
                    write_log("INFO native icon skipped (%r); stamper will cover"
                              % (_e,))
            threading.Thread(target=_brand_form_icon, daemon=True,
                             name="samql-native-icon").start()
        write_log("INFO opening a native pywebview window (%dx%d)" % (w, h))
        # Close the splash on THIS (main) thread, BEFORE the blocking GUI loop:
        # tkinter is not thread-safe and webview.start() never returns to us
        # until the window closes.
        splash.close()
        # .493: the WebView2 window does NOT reliably inherit the exe's embedded
        # icon -- on box the taskbar button and title bar came up with a generic
        # mark. Stamp SamQL's own icon the way the browser path does (WM_SETICON
        # + AppUserModelID + RelaunchIconResource). webview.start() blocks the
        # main thread, so run it on a daemon thread that waits for the window to
        # appear, then re-stamps a few times (WebView2 repaints the frame late).
        def _brand_native_window():
            try:
                import time as _t
                _t.sleep(0.4)  # let the splash finish tearing down first
                # .550: only our process -- never stamp Teams/Explorer/Edge
                # just because the title contains "SamQL".
                hwnd = wait_for_app_window(
                    "SamQL", APP_WINDOW_WAIT_S, None,
                    owned_by_pid=os.getpid())
                if not hwnd or hwnd is True:
                    write_log("INFO native window not found to stamp its icon "
                              "(waited %.0fs)" % APP_WINDOW_WAIT_S)
                    return
                # .517: name the stamp TARGET -- class + whether the hwnd
                # belongs to THIS process. If the taskbar still shows Edge,
                # this line tells us whether Windows surfaced a WebView2
                # child window instead of our WinForms host.
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(64)
                    ctypes.windll.user32.GetClassNameW(hwnd, buf, 64)
                    pid = ctypes.c_ulong(0)
                    ctypes.windll.user32.GetWindowThreadProcessId(
                        hwnd, ctypes.byref(pid))
                    ours = pid.value == os.getpid()
                    write_log("INFO stamp target hwnd=%s class=%s ours=%s"
                              % (hwnd, buf.value, ours))
                    if not ours:
                        write_log("WARN refusing AUMID stamp on foreign "
                                  "hwnd (pid=%s exe=%r) -- would pull that "
                                  "app into the SamQL taskbar group"
                                  % (pid.value, _proc_image(pid.value)))
                        return
                except Exception:
                    pass
                set_app_user_model_id(hwnd)
                # .500: prefer the SamQL.ico bundled INTO this launcher exe --
                # it needs no server round-trip, so the taskbar wears the user's
                # icon even when the server is slow to serve /favicon.ico (the
                # on-box WinError 10061 icon-fetch failure). Fall back to the
                # server favicon when no icon was bundled.
                _b2 = _bundled_asset("samql.ico")
                ico = _b2 or fetch_app_icon(args.port)
                if ico:
                    write_log("INFO icon art source=%s path=%s sha=%s"
                              % ("bundled" if _b2 else "fetched", ico,
                                 _ico_fingerprint(ico)))
                    ensure_shell_shortcuts(sys.executable or "", ico)
                    _dk = _disk_brand_ico()
                    if _dk and (_ico_fingerprint(_dk)
                                != _ico_fingerprint(ico)):
                        write_log(
                            "WARN the art bundled into this exe differs "
                            "from %s on disk -- STALE BUILD; rebuild the "
                            "exes to refresh the icon" % _dk)
                if not ico:
                    return
                for delay in (0.0, 1.0, 2.0, 4.0, 8.0):
                    _t.sleep(delay)
                    try:
                        apply_app_icon(hwnd, ico)
                        set_relaunch_icon(hwnd, ico)
                        if delay >= 4.0:
                            stamp_all_process_windows(ico)
                    except Exception:
                        return
                write_log("INFO stamped the SamQL icon on the native window")
                # .529: the .527 diagnosis was wired into the BROWSER
                # path only -- Sam's native-path log had no DIAG block at
                # all. Run it HERE, right after the line his log proves
                # is reached, then keep restamping on the long schedule
                # with a second diagnosis at 30s (the readbacks at t+30
                # show whether something repaints our icon later).
                diagnose_taskbar_icon(hwnd, ico)
                for delay in (15.0, 30.0, 60.0):
                    _t.sleep(delay)
                    try:
                        apply_app_icon(hwnd, ico)
                        set_relaunch_icon(hwnd, ico)
                        stamp_all_process_windows(ico)
                        if delay == 30.0:
                            diagnose_taskbar_icon(hwnd, ico)
                    except Exception:
                        return
            except Exception as _e:
                write_log("INFO native icon stamp skipped (%s)"
                          % _e.__class__.__name__)
        threading.Thread(target=_brand_native_window, daemon=True).start()
        # .490: private_mode=False + a stable storage_path give the native
        # window the SAME persistence the browser tab has (localStorage,
        # saved UI state) instead of a throwaway private session.
        # .508: AUTO-DETECT FIRST. The .501 change asked for gui=
        # "edgechromium" up front -- but the .499 on-box log shows plain
        # auto-detect opening the window fine, and forcing a specific
        # renderer that trips on a given pywebview version can leave the GUI
        # half-initialized so even the retry dies to the browser fallback
        # (the on-box "still opens Edge" regression). So: run the proven
        # auto path first and log the renderer it picked; only if THAT fails
        # retry once asking for edgechromium explicitly.
        try:
            webview.start(_set_native_icon, private_mode=False,
                          storage_path=_webview_storage_path())
            _gl = getattr(webview, "guilib", None)
            _gn = (getattr(webview, "gui", None)
                   or getattr(_gl, "__name__", None) or "auto")
            write_log("INFO native window closed (renderer=%s)"
                      % str(_gn).rsplit(".", 1)[-1])
        except Exception as _wg:
            write_log("WARN auto-detect renderer failed (%r); retrying "
                      "with the explicit edgechromium renderer" % (_wg,))
            webview.start(_set_native_icon, gui="edgechromium",
                          private_mode=False,
                          storage_path=_webview_storage_path())
            write_log("INFO native window closed (renderer=edgechromium)")
        return True
    except Exception as e:
        write_log("WARN pywebview window failed (%r); falling back to a "
                  "browser window" % (e,))
        return False


# --------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="Open SamQL in a "
                                 "chromeless app window.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--browser", choices=["auto", "edge", "chrome"],
                    default="auto")
    ap.add_argument("--window-size", default="1400,900")
    ap.add_argument("--no-server", action="store_true",
                    help="never start a server; require a live one")
    ap.add_argument("--serve", action="store_true",
                    help="run the bundled SamQL server (internal: the "
                         "launcher self-spawns this when no server exe "
                         "is found beside it)")
    args = ap.parse_args(argv)

    # .535: self-serve mode -- this process IS the server. Runs before
    # any window/splash/mutex machinery: a server child must never fight
    # the window's single-instance guard.
    if args.serve:
        return _run_bundled_server(args.port)

    # .545: clear any _MEI extraction a sleep-reaped / killed previous
    # SamQL left locked at the temp root, BEFORE anything boots -- that
    # stale dir is what makes the PyInstaller bootloader pop "failed to
    # remove temporary directory" at the next exit.
    _sweep_stale_mei_early()

    # .513: process-wide AppUserModelID FIRST, before any window exists.
    # Per-hwnd property-store stamping (below) races WebView2 repaints; the
    # process-level ID is what Win11 actually groups taskbar buttons by, so
    # the SamQL window gets its OWN button with its OWN icon instead of
    # sheltering under Edge's. .550: never swallow failures silently --
    # a missed process AUMID is how foreign apps can share our taskbar
    # group after a bad window stamp.
    _set_process_aumid(APP_AUMID)
    splash = make_splash()
    write_log("INFO launcher start (port %d)%s"
              % (args.port,
                 (" (process AppUserModelID=%s)" % APP_AUMID)
                 if _AUMID_SET else ""))

    # .534: ONE SamQL at a time. An already-open window is surfaced and
    # this launch stops -- never a second window, never a second server.
    # The mutex closes the double-click race while the first window is
    # still booting (WebView2 cold start).
    h = find_samql_window()
    if h and focus_window(h):
        write_log("INFO SamQL is already open -- brought its window to "
                  "the front (%r)" % (_LAST_MATCH,))
        splash.set_text("SamQL is already open.")
        splash.pump(0.8)
        splash.close()
        return 0
    if h:
        # .542: the scan matched but the target failed re-verification
        # -- a ghost. Say exactly what was seen and CONTINUE the launch;
        # the guard must never strand the user with nothing on screen.
        write_log("WARN ignored a phantom 'SamQL' window and continuing "
                  "the launch: %r" % (_LAST_MATCH,))
    elif _LAST_MATCH.get("ghosts"):
        write_log("INFO window scan skipped cloaked/sizeless ghosts: %r"
                  % (_LAST_MATCH["ghosts"],))
    _ok, _already = _acquire_single_instance()
    if _already:
        # .537: the holder is USUALLY a first click still booting -- wait
        # for its window and focus it. But a launcher that failed to
        # fully exit (a lingering CLR/WinForms thread) holds the mutex
        # with NO window forever; that must never LOCK OUT a launch. So
        # after the grace, treat the mutex as stale, say so in the log,
        # and continue the normal ladder (attach to a live server, or
        # start one).
        splash.set_text("SamQL is already starting...")
        # .544 [Path D audit]: a double-click during a COLD BOOT holds
        # the mutex with no window for up to the server's whole boot
        # budget -- the .537 10s heal then "continued", started a SECOND
        # server, and two windows raced. The wait is port-aware now:
        # once the first launch's server answers as SamQL, this launch
        # keeps waiting for its window (and, failing that, REUSES the
        # live server -- never starts another). Only no-window AND
        # no-server for the full boot budget reads as a stale mutex.
        # Reconnect: if the server was already healthy when we entered
        # (Exit → keep server) and no peer AppWindow is alive, use a
        # short window grace -- do not sit on "SamQL is starting" for
        # the full WebView2 cold-start budget waiting on a ghost.
        t0 = time.time()
        saw_server = False
        server_preexisting = (port_open(args.port)
                              and _is_samql(args.port))
        peer_alive = (_peer_appwindow_process_alive()
                      if server_preexisting else False)
        window_grace = t0 + _MUTEX_WAIT_S
        boot_grace = t0 + _MUTEX_BOOT_WAIT_S
        # A held mutex with NO server and NO live peer launcher is a dead
        # holder (zombie), not a boot-in-progress: break early instead of
        # burning the whole boot budget. Frozen-only: a source-run peer
        # shares the python image name with everything, so the probe would
        # false-negative -- the full boot budget stays the dev behavior.
        peer_check_at = t0 + 5.0
        while True:
            h = find_samql_window()
            if h and focus_window(h):
                write_log("INFO another launch was in progress -- "
                          "focused its window")
                splash.close()
                return 0
            now = time.time()
            if not saw_server and port_open(args.port) \
                    and _is_samql(args.port):
                saw_server = True
                if server_preexisting and not peer_alive:
                    window_grace = now + _MUTEX_RECONNECT_WINDOW_GRACE_S
                    splash.set_text("Reconnecting to SamQL...")
                    write_log("INFO healthy server already on port %d "
                              "with no peer AppWindow -- short "
                              "reconnect wait (%.1fs)"
                              % (args.port,
                                 _MUTEX_RECONNECT_WINDOW_GRACE_S))
                else:
                    window_grace = now + _MUTEX_WINDOW_GRACE_S
                    splash.set_text("SamQL is starting -- waiting for its "
                                    "window...")
                    write_log("INFO waiting for the first launch's server "
                              "on port %d to show its window" % args.port)
            if saw_server and now >= window_grace:
                write_log("WARN the first launch's server is up but its "
                          "window never appeared -- reusing that server "
                          "with a window of our own")
                break
            if not saw_server and now >= boot_grace:
                write_log("WARN the launch mutex is held but no SamQL "
                          "window or server appeared in %.0fs -- "
                          "treating it as stale (a previous launcher "
                          "may not have exited cleanly) and continuing"
                          % _MUTEX_BOOT_WAIT_S)
                break
            if not saw_server and getattr(sys, "frozen", False) \
                    and now >= peer_check_at:
                peer_check_at = now + 5.0
                if not _peer_appwindow_process_alive():
                    write_log("WARN the launch mutex is held but no peer "
                              "launcher process is alive and no server "
                              "answers -- treating it as stale early "
                              "(dead mutex holder) and continuing")
                    break
            if not saw_server and now >= t0 + _MUTEX_WAIT_S:
                splash.set_text("SamQL is starting -- waiting for its "
                                "server...")
            splash.pump(0.3)
        splash.set_text("Opening SamQL...")

    we_started_server = False
    if port_open(args.port):
        # .512: something answers -- make sure it's ACTUALLY SamQL before
        # attaching (a foreign process on 8765 used to get our window
        # pointed at it). The health probe is proxy-free (.509).
        if _is_samql(args.port):
            write_log("INFO reusing the SamQL server already on port %d"
                      % args.port)
            _ping_maintenance(args.port)
        else:
            fail_visibly(splash, "Port %d is in use by something that is "
                         "not SamQL -- close it or use --port." % args.port)
    if not port_open(args.port):
        if args.no_server:
            fail_visibly(splash, "SamQL is not running on port %d "
                         "(--no-server)." % args.port)
        splash.set_text("Starting the SamQL server...")
        if not start_server(args.port, splash):
            fail_visibly(splash, "Nothing to start: no SamQL exe or "
                         "python backend found beside the launcher.")
        we_started_server = True
        _BOOT_PORT[0] = args.port
        # Heartbeat wait for /api/health (not TCP alone, not a single
        # wall-clock). Child exit fails immediately; process-alive +
        # TCP/stage progress reset idle; absolute ceiling still applies.
        # Open once health says SamQL (warming may still be true).
        err = wait_for_server_ready(args.port, splash)
        if err is not None:
            # .500: OneDrive/AV note when the absolute ceiling is the cause.
            try:
                _selfdir = _here()
                if ("onedrive" in (_selfdir or "").lower()
                        and "within" in (err or "")):
                    err += (" It looks like SamQL is running from a OneDrive "
                            "folder, which makes first-run unpack/AV-scan very "
                            "slow -- copy the app to a LOCAL folder (e.g. "
                            "C:\\SamQL) and run it from there.")
            except Exception:
                pass
            fail_visibly(splash, err)
        # .544: our own boot succeeded -- take the previous sessions'
        # leftovers (dead-instance temp + hard-exit _MEI orphans) now.
        _ping_maintenance(args.port)

    url = "http://127.0.0.1:%d/" % args.port

    # .546: if we started the server, supervise it while the window is
    # open -- respawn it in place if standby/a kill/a crash takes it, so
    # the window's Reconnect meets a live server. A reused server (we
    # attached to someone else's) is theirs; we don't supervise it.
    if we_started_server:
        start_supervisor(args.port)

    # .485: prefer a NATIVE window (pywebview) -- the launcher owns it, so it
    # wears SamQL-AppWindow.exe's own icon in the taskbar (no browser, no Edge
    # logo, none of the icon-stamping dance below). Blocks until the window is
    # closed. Falls through to a chromeless Edge/Chrome window when pywebview
    # isn't bundled, so the launcher still works on a bare stdlib interpreter.
    if open_native_window(url, args, splash):
        stop_supervisor()  # .546/.629: window closed -> stop + join supervisor
        write_log("INFO native window closed; launcher done")
        # Window close must not leave SamQL.exe / python / llama-server in
        # Task Manager by default. Stop the server WE started (graceful
        # /api/shutdown + reap) unless Exit → keep server marked the
        # backend (keep_on_close on /api/health) for instant reopen.
        # A server we only reattached to is always left alone.
        # .629: join supervisor BEFORE stop_server so a mid-flight respawn
        # cannot outlive the window after Exit & stop.
        if we_started_server:
            if _keep_server_requested(args.port):
                _LEAVE_SERVER_RUNNING[0] = True
                write_log("INFO window closed; leaving the server on "
                          "port %d running (Exit → keep server) -- "
                          "reopen AppWindow to reconnect" % args.port)
            else:
                stop_server(args.port)
                write_log("INFO window closed; stopped the server on port %d"
                          % args.port)
        # .537: END THE PROCESS. pythonnet/WinForms can leave non-daemon
        # threads after webview.start() returns; a launcher that lingers
        # holds the single-instance mutex (and its _MEI extraction)
        # forever -- the on-box "an existing one is open" + "can't clear
        # _MEI" pair. Frozen builds hard-exit; tests (unfrozen) keep the
        # plain return.
        if getattr(sys, "frozen", False):
            os._exit(0)
        return 0

    bx = find_browser(args.browser)
    if not bx:
        write_log("WARN no Edge/Chrome found; opening the default "
                  "browser tab instead")
        import webbrowser
        webbrowser.open(url)
        # The tab talks to the server we started -- leaving it running is
        # intentional here, so the exit reaper must skip it.
        _LEAVE_SERVER_RUNNING[0] = True
        splash.close()
        return 0

    splash.set_text("Opening the app window...")
    try:
        subprocess.Popen([bx, "--app=" + url,
                          "--window-size=" + args.window_size],
                         env=clean_child_env())
    except Exception as e:
        fail_visibly(splash, "Could not start the browser: %s" % e)

    # .550: Edge single-instance may attach the --app window to an
    # already-running msedge/chrome process -- filter by browser image
    # name (same as the PS1 flow), never by "any SamQL title" (Teams).
    _bx_base = os.path.basename(bx).lower()
    hwnd = wait_for_app_window("SamQL", APP_WINDOW_WAIT_S, splash,
                               exe_basenames=(_bx_base,))
    if not hwnd:
        write_log("WARN app window title not seen within %.0fs "
                  "(opened anyway)" % APP_WINDOW_WAIT_S)
    elif hwnd is not True:
        # .461: brand the window -- its own taskbar identity (so it
        # stops grouping under the browser), then the SamQL mark, and
        # once more after a beat because Edge re-applies the page
        # favicon when the tab finishes loading.
        set_app_user_model_id(hwnd)
        _b = _bundled_asset("samql.ico")
        ico = _b or fetch_app_icon(args.port)
        if ico:
            write_log("INFO icon art source=%s path=%s sha=%s"
                      % ("bundled" if _b else "fetched", ico,
                         _ico_fingerprint(ico)))
            ensure_shell_shortcuts(sys.executable or "", ico)
            _dk = _disk_brand_ico()
            if _dk and _ico_fingerprint(_dk) != _ico_fingerprint(ico):
                write_log("WARN the art bundled into this exe differs "
                          "from %s on disk -- STALE BUILD; rebuild the "
                          "exes to refresh the icon" % _dk)
            apply_app_icon(hwnd, ico)
            # .476: the RelaunchIconResource is what Windows reads for
            # the TASKBAR button icon -- setting it makes the taskbar
            # show SamQL even when WM_SETICON on the frame gets
            # repainted by Edge.
            set_relaunch_icon(hwnd, ico)
            diagnose_taskbar_icon(hwnd, ico)
            splash.pump(2.0)
            apply_app_icon(hwnd, ico)

            # .469: Edge sometimes repaints the frame icon well after
            # navigation settles; a few timed restamps make OUR stamp
            # the last writer. Daemon thread -- never delays exit.
            def _restamp():
                import time as _t
                # .475/.476: a longer schedule, and re-assert BOTH the
                # frame icon and the taskbar RelaunchIconResource.
                for delay in (2.0, 3.0, 5.0, 8.0, 15.0, 30.0, 60.0):
                    _t.sleep(delay)
                    try:
                        apply_app_icon(hwnd, ico)
                        set_relaunch_icon(hwnd, ico)
                        if delay >= 5.0:
                            stamp_all_process_windows(ico)
                        if delay == 30.0:
                            diagnose_taskbar_icon(hwnd, ico)
                    except Exception:
                        return
            threading.Thread(target=_restamp, daemon=True).start()
    # The browser --app window talks to the server we started; the launcher
    # exits now and deliberately leaves it up (the in-app Exit → Stop owns
    # shutdown in this mode), so the exit reaper must skip it.
    _LEAVE_SERVER_RUNNING[0] = True
    splash.close()
    write_log("INFO launcher done")
    return 0


if __name__ == "__main__":
    _rc = main()
    if getattr(sys, "frozen", False):
        os._exit(_rc or 0)  # .537: never zombie on stray threads
    sys.exit(_rc)
