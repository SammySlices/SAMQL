"""Process-wide registry of in-flight engine operations, with per-operation
progress heartbeats.

Every long-running operation -- a file load, a query, a nodeflow run, an
export -- registers here for the duration of its work and stamps a *heartbeat*
as it makes progress (typically once per flushed batch of rows). Two consumers
read the registry:

  * the activity dashboard (GET /api/status) shows what is running, how many
    rows have been processed, and how long since the last progress -- so a
    stall is visible instead of a mystery;

  * the stall watchdog (session._start_watchdog) is a background thread that,
    when an operation has not advanced in too long, dumps *every* thread's
    stack to a log so a silent hang reveals exactly which call is stuck.

The watchdog only ever *observes* -- it never cancels or interrupts anything.
That is the whole point of tracking progress rather than elapsed time: a load
that legitimately runs for minutes keeps stamping heartbeats every fraction of
a second, so it is never mistaken for a hang. Only an operation whose heartbeat
has genuinely stopped advancing is flagged.

Heartbeats are keyed by the worker thread running the op, so the low-level
engine streaming loops (which do not know the op id) can stamp progress with a
bare ``beat()`` call. Everything here is stdlib-only and safe to import from
any layer.
"""
import itertools
import threading
import time

_LOCK = threading.RLock()
_OPS = {}            # op_id -> _Op
_BY_THREAD = {}      # thread ident -> op_id (the op currently running on it)
_seq = itertools.count(1)


class _Op:
    __slots__ = ("id", "kind", "target", "engine", "thread",
                 "started", "rows", "last_beat", "done", "total", "unit",
                 "cancellable", "surface", "label", "finished_at")

    def __init__(self, op_id, kind, target, engine, thread,
                 total=None, unit=None, cancellable=False, surface=None, label=None):
        now = time.monotonic()
        self.id = op_id
        self.kind = kind or "op"
        self.target = target
        self.engine = engine          # "sqlite" / "duckdb" / None (display)
        self.thread = thread
        self.started = now
        self.rows = 0
        self.last_beat = now
        # Determinate-progress fields. Most ops never set these (a single query
        # has no knowable denominator), so percent stays None and the UI shows
        # an indeterminate bar. Multi-step ops that DO know their size -- an
        # iterator over N rows, a bounded while-loop, a folder of M files --
        # report done/total via advance() and the UI shows a true percentage.
        self.done = None              # units completed so far (int)
        self.total = total            # total units, when known (int)
        self.unit = unit              # "pass" / "iteration" / "file" / ...
        # True iff this op was registered under a real run id (a query id) the
        # rest of the system can target with cancel_query -- i.e. a foreground
        # run / bg op, not an internal one (a load streams under a generated id
        # and is cancelled via its tray job; restore has no id at all).
        self.cancellable = cancellable
        # WHERE the run came from ("ide" / "journal" / "node") and a human
        # label (tab title, cell name, node label) -- the stat modal groups
        # running queries by these.
        self.surface = surface
        self.label = label
        # .516: set when the op COMPLETES. A finished op lingers briefly in
        # the registry (percent pinned terminal) instead of vanishing in the
        # same instant -- so any observer polling on an interval (the
        # Activity tray, the on-box .469b live test) can actually SEE 100%.
        # Registry reads sweep entries older than _LINGER_S; count() and
        # active_kinds() never include finished ops.
        self.finished_at = None

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        pct = None
        if self.total and self.total > 0 and self.done is not None:
            frac = self.done / self.total
            if frac < 0.0:
                frac = 0.0
            elif frac > 1.0:
                frac = 1.0
            pct = round(frac * 100.0, 1)
        return {
            "id": self.id,
            "finished": self.finished_at is not None,
            "kind": self.kind,
            "target": self.target,
            "engine": self.engine,
            "rows": self.rows,
            "done": self.done,
            "total": self.total,
            "unit": self.unit,
            "percent": pct,
            "elapsed_s": round(now - self.started, 1),
            "idle_s": round(now - self.last_beat, 1),
            "cancellable": self.cancellable,
            "surface": self.surface,
            "label": self.label,
        }


def begin(kind, target=None, engine=None, op_id=None, total=None, unit=None,
          surface=None, label=None):
    """Register an in-flight op on the calling thread; return its id. Pass an
    explicit ``op_id`` (e.g. a query id) to make the registry key match an id
    the rest of the system already uses; otherwise one is generated. Pass
    ``total``/``unit`` if the size is known up front so the op reports a true
    percentage from the start."""
    tid = threading.get_ident()
    with _LOCK:
        oid = op_id or ("op-%d" % next(_seq))
        _OPS[oid] = _Op(oid, kind, target, engine, tid, total=total, unit=unit,
                        cancellable=op_id is not None,
                        surface=surface, label=label)
        _BY_THREAD[tid] = oid
        return oid


def advance(done=None, total=None, unit=None, op_id=None):
    """Report determinate progress: ``done`` units of ``total`` complete. With
    no ``op_id`` this updates the op running on the calling thread (so a loop
    can report ``advance(i, n)`` without threading an id through). Counts as a
    heartbeat too, so a steadily-advancing op is never flagged as a stall."""
    with _LOCK:
        oid = op_id or _BY_THREAD.get(threading.get_ident())
        op = _OPS.get(oid) if oid else None
        if op is not None:
            op.last_beat = time.monotonic()
            if done is not None:
                op.done = done
            if total is not None:
                op.total = total
            if unit is not None:
                op.unit = unit


def beat(rows=None, op_id=None):
    """Stamp progress. With no ``op_id`` this updates the op running on the
    calling thread, so a deep engine streaming loop can report progress with a
    bare ``progress.beat(rows=n)`` and never be mistaken for a stall."""
    with _LOCK:
        oid = op_id or _BY_THREAD.get(threading.get_ident())
        op = _OPS.get(oid) if oid else None
        if op is not None:
            op.last_beat = time.monotonic()
            if rows is not None:
                op.rows = rows


def beat_on_thread(tid, rows=None):
    """Stamp a heartbeat on the op running on thread ``tid`` -- NOT the calling
    thread. This lets a *watcher* thread (e.g. one kept alive alongside a long
    native engine call) keep that call's op off the stall list while the call
    is executing on its own worker thread and cannot beat for itself. No-op if
    that thread has no op registered."""
    with _LOCK:
        oid = _BY_THREAD.get(tid)
        op = _OPS.get(oid) if oid else None
        if op is not None:
            op.last_beat = time.monotonic()
            if rows is not None:
                op.rows = rows


_LINGER_S = 1.2   # how long a finished op stays visible to observers


def _sweep(now):
    """Drop finished ops past their linger. Callers hold _LOCK."""
    gone = [oid for oid, op in _OPS.items()
            if op.finished_at is not None
            and now - op.finished_at > _LINGER_S]
    for oid in gone:
        _OPS.pop(oid, None)


def end(op_id=None):
    """Mark an op COMPLETE -- by id, or the op running on the calling
    thread. The op stays visible (finished=True, percent pinned terminal)
    for a short linger so interval pollers observe the terminal state; the
    next registry read past the linger sweeps it."""
    tid = threading.get_ident()
    now = time.monotonic()
    with _LOCK:
        oid = op_id or _BY_THREAD.get(tid)
        op = _OPS.get(oid) if oid else None
        if op is not None:
            op.finished_at = now
            op.last_beat = now
            if op.total and (op.done or 0) < op.total:
                op.done = op.total   # pin percent at 100 for observers
        for t, o in list(_BY_THREAD.items()):
            if o == oid or t == tid:
                _BY_THREAD.pop(t, None)
        _sweep(now)


def snapshot():
    """All in-flight ops (plus just-finished ones inside their linger), each
    as a display dict (rows, elapsed, idle, finished)."""
    now = time.monotonic()
    with _LOCK:
        _sweep(now)
        return [op.snapshot(now) for op in _OPS.values()]


def stale(threshold_s):
    """Ops whose last heartbeat is older than ``threshold_s`` -- candidates the
    watchdog should dump a stack trace for. A progressing op is never here."""
    now = time.monotonic()
    with _LOCK:
        _sweep(now)
        return [op.snapshot(now) for op in _OPS.values()
                if op.finished_at is None
                and now - op.last_beat >= threshold_s]


def active_kinds():
    """Set of op kinds currently in flight (used by restore to yield to real
    user work)."""
    with _LOCK:
        _sweep(time.monotonic())
        return {op.kind for op in _OPS.values()
                if op.finished_at is None}


def count():
    """ACTIVE ops only -- a finished op inside its linger doesn't count."""
    with _LOCK:
        _sweep(time.monotonic())
        return sum(1 for op in _OPS.values() if op.finished_at is None)


def reset_for_tests():
    """Clear the registry. Test-only -- the process otherwise keeps one."""
    with _LOCK:
        _OPS.clear()
        _BY_THREAD.clear()
