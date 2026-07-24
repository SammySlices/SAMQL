"""Background stall watchdog.

Periodically asks the progress registry which in-flight operations have stopped
advancing (heartbeat older than a threshold) and, for each newly-stuck one,
dumps *every* thread's stack to a log file. A silent hang -- the kind that
prints nothing to the terminal and leaves no error -- then reveals exactly
which call is blocked (e.g. a DuckDB ``connect``/``execute`` or a file write).

It is deliberately progress-based, not time-based: an operation that keeps
making progress (a multi-minute load flushing batches) resets its heartbeat
constantly and is never flagged, so the watchdog cannot mistake a slow load for
a hang. And it is observe-only -- it never cancels, interrupts, or touches an
engine. The only action it takes is writing a diagnostic dump.
"""
import faulthandler
import os
import threading
import time

from . import progress

_started = False
_start_lock = threading.Lock()
_state = {"last_stall": None, "log_path": None}
_dumped = set()
_dumped_lock = threading.Lock()
_scan_lock = threading.RLock()
_thread = None
_stop_event = None


def _decide_dumps(stale_ids, already):
    """Pure decision step (unit-tested directly): given the ids currently
    stale and the set already dumped, return (ids_to_dump_now, new_already).

    An op is dumped once per stall episode. Ids that are no longer stale are
    forgotten, so if the same op wedges again later it is dumped again."""
    stale_ids = set(stale_ids)
    to_dump = stale_ids - set(already)
    return to_dump, stale_ids


def _write_dump(log_path, op):
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("\n==== STALL %s ====\n"
                    % time.strftime("%Y-%m-%d %H:%M:%S"))
            f.write("stuck op: %r\n" % (op,))
            f.write("(no progress for %.0fs; dumping all thread stacks)\n"
                    % op.get("idle_s", 0))
            faulthandler.dump_traceback(file=f, all_threads=True)
            f.write("==== end stall ====\n")
    except Exception:
        pass


def scan_once(threshold_s, log_path):
    """One watchdog pass. Returns the list of currently-stale ops. Also called
    directly by tests (with a tiny threshold) to assert dump behaviour.

    Passes are serialized. The production loop is normally the sole caller,
    but diagnostics and tests can invoke this function directly; allowing two
    scans to update ``_dumped`` concurrently can make one scanner forget the
    other's stall episode and write duplicate stack dumps.
    """
    global _dumped
    with _scan_lock:
        stale = progress.stale(threshold_s)
        ids = [o["id"] for o in stale]
        with _dumped_lock:
            to_dump, _dumped = _decide_dumps(ids, _dumped)
        if not stale and _state.get("last_stall") is not None:
            # RECOVERY (on-box ask 2026-07-02): the stall record is CURRENT
            # state, not history -- once nothing is stale (the op finished,
            # was cancelled, or an engine reset unwedged it) the flag drops,
            # so the UI stops saying "stalled" within one scan.
            _state["last_stall"] = None
        for o in stale:
            if o["id"] in to_dump:
                if log_path:
                    _write_dump(log_path, o)
                _state["last_stall"] = dict(o, at=time.time())
        # ESCALATION (on-box 2026-07-02): a stalled op the user already
        # CANCELLED means the first interrupt never landed (a native fetch can
        # miss it). Re-fire the engine interrupt on every pass until the thread
        # frees -- idempotent, cheap, and it is exactly what a second Stop
        # click would do.
        hook = _state.get("reinterrupt")
        if hook:
            for o in stale:
                try:
                    if hook(o["id"]):
                        _log_line(log_path,
                                  "re-interrupt fired for stalled cancelled "
                                  "op %s (%.0fs idle)" % (o["id"],
                                                          o.get("idle_s", 0)))
                except Exception:
                    pass
        return stale


def set_reinterrupt(fn):
    """Install the session hook the escalation uses: fn(op_id) -> bool
    (True when the op was cancel-requested and an interrupt was re-fired)."""
    _state["reinterrupt"] = fn


def _log_line(log_path, msg):
    if not log_path:
        return
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def last_stall():
    return _state.get("last_stall")


def clear_stall():
    """Forget the recorded stall AND the dumped-ids memory, so the state
    reflects a fresh check. Called on engine reset: the very next scan
    re-flags (and re-dumps) if the stall genuinely persists -- otherwise
    the UI stops saying "stalled"."""
    global _dumped
    with _scan_lock:
        with _dumped_lock:
            _dumped = set()
        _state["last_stall"] = None


def log_path():
    return _state.get("log_path")


def start(threshold_s=90.0, interval_s=15.0, log_path=None):
    """Start the watchdog loop once per process (idempotent).

    The loop owns a stop event so the test reset can terminate it cleanly.
    Previously ``reset_for_tests`` cleared the state but left the daemon alive;
    that old scanner could run between two deterministic ``scan_once`` calls,
    clear ``_dumped`` with its different threshold, and make the same stall get
    dumped twice.
    """
    global _started, _thread, _stop_event
    if log_path is None:
        try:
            from . import tmputil
            log_path = tmputil.instance_path("stall_watchdog.log")
        except Exception:
            import tempfile
            log_path = os.path.join(tempfile.gettempdir(),
                                    "samql_stall_watchdog.log")

    stop_event = threading.Event()

    def loop():
        while not stop_event.is_set():
            try:
                scan_once(threshold_s, log_path)
            except Exception:
                pass
            if stop_event.wait(interval_s):
                break

    worker = threading.Thread(target=loop, daemon=True,
                              name="samql-watchdog")
    with _start_lock:
        if _started:
            return
        _state["log_path"] = log_path
        _stop_event = stop_event
        _thread = worker
        _started = True
        worker.start()


def stop():
    """Stop the daemon thread (production shutdown path; also used by tests
    via _stop_background_for_tests). Safe to call more than once."""
    _stop_background_for_tests()


def _stop_background_for_tests():
    """Stop the daemon and wait until any in-progress scan has left its
    critical section. Test-only; the production process keeps one watchdog for
    its lifetime (and stops it via stop() during _graceful_shutdown)."""
    global _started, _thread, _stop_event
    with _start_lock:
        worker = _thread
        stop_event = _stop_event
        if stop_event is not None:
            stop_event.set()

    # This lock is a barrier: after the stop event is set, once we can acquire
    # it the old loop has finished any scan it may already have entered and it
    # cannot begin another one.
    with _scan_lock:
        pass

    if worker is not None and worker is not threading.current_thread():
        worker.join(timeout=5.0)

    with _start_lock:
        if _thread is worker:
            _thread = None
            _stop_event = None
            _started = False


def reset_for_tests():
    global _dumped
    _stop_background_for_tests()
    with _scan_lock:
        with _dumped_lock:
            _dumped = set()
        _state["last_stall"] = None
        _state["log_path"] = None
