"""Local query engines: SQLite (always available, stdlib) and DuckDB
(optional). Both expose the same surface used by the session layer:
``execute``, ``execute_cursor``, ``add_tables``, ``add_table_streaming``,
``drop_table``, ``drop_all``, ``change_column_type``, plus the
``table_columns`` / ``table_sources`` registries.

Lifted directly from the original single-file application and stripped of
all GUI references.
"""
import atexit
import contextlib
import time as _time_mod
import itertools
import json
import os
import shutil
import sys
import sqlite3
import tempfile
import threading
from . import sqlutil

from .inference import infer_affinities
from .rows import DiskBackedRows, spill_rows
from . import progress as opreg


def _is_interrupt(exc):
    """True if an exception came from a query/load being interrupted (a cancel
    via connection.interrupt()). Kept local to avoid importing the session
    layer (which imports this module)."""
    name = exc.__class__.__name__.lower()
    s = str(exc).lower()
    return "interrupt" in name or "interrupt" in s or "cancel" in s


# How long a foreground DB operation will wait for the engine connection lock
# before giving up. A healthy query/load holds the lock only while it actually
# touches the connection (sub-second for typical work; a big load holds it for
# its own duration but *acquires* instantly). So a wait this long means another
# operation is wedged -- a stuck op on a slow/locked on-disk file, a runaway
# background task, a connection left mid-operation. Rather than let the worker
# thread block forever (which strands the UI on a spinner and then surfaces as
# "failed to fetch", and piles up threads), we give up and raise EngineBusy so
# the request fails fast with a clear, retryable message. NB: this bounds the
# *wait* to acquire, never the *holding* -- a legitimately long op that already
# holds the lock runs to completion; only other operations waiting behind it
# are bounded.
ENGINE_LOCK_TIMEOUT = 30.0


class EngineBusy(Exception):
    """A foreground DB operation could not acquire the engine connection lock
    within ENGINE_LOCK_TIMEOUT -- another operation has held it far longer than
    any healthy query should, so the engine is treated as wedged. Surfaced to
    the UI as a clear, retryable error instead of an indefinite hang."""
    pass


class _DeadlineRLock:
    """A re-entrant lock whose *blocking* acquire has a default deadline.

    Used as an engine's connection lock so a foreground operation never waits
    forever on a wedged engine: on timeout it raises EngineBusy. Semantics are
    otherwise a drop-in for threading.RLock:
      * the owning thread re-acquires instantly (re-entrant, no deadline),
      * acquire(blocking=False) is unchanged (the background checkpoint uses it
        and must never wait),
      * `with lock:` acquires with the default deadline and may raise
        EngineBusy -- in which case the body never runs and nothing is held.
    """
    __slots__ = ("_lock", "timeout")

    def __init__(self, timeout=ENGINE_LOCK_TIMEOUT):
        self._lock = threading.RLock()
        self.timeout = timeout

    def acquire(self, blocking=True, timeout=-1):
        if not blocking:
            return self._lock.acquire(blocking=False)
        if timeout is None or timeout < 0:
            timeout = self.timeout
        if self._lock.acquire(blocking=True, timeout=timeout):
            return True
        raise EngineBusy(
            "The database engine is busy: another operation has held it too "
            "long and may be stuck. Please retry in a moment; if it keeps "
            "happening, restart the app.")

    def release(self):
        self._lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._lock.release()
        return False


# Opening a fresh, empty on-disk DuckDB file is sub-second; a wait much longer
# than this means the path is slow or locked -- a stale lock left by a crashed
# instance, or a networked / aggressively-scanned temp dir. Rather than let the
# very first DuckDB operation hang on connect (with nothing printed to the
# terminal), bound the connect and fall back to an in-memory database.
DUCKDB_CONNECT_TIMEOUT = 15.0


def _connect_with_timeout(connect, path, timeout):
    """Call ``connect(path)`` but give up after ``timeout`` seconds. Returns the
    connection, or None if it did not finish in time (the worker thread is left
    to unwind on its own -- we never block on it). Re-raises a genuine connect
    error so the caller's normal fallback handles it."""
    box = {}

    def _worker():
        try:
            box["conn"] = connect(path)
        except BaseException as e:   # report any failure to the caller
            box["err"] = e

    t = threading.Thread(target=_worker, daemon=True, name="duckdb-connect")
    t.start()
    t.join(timeout)
    if t.is_alive():
        return None
    if "conn" in box:
        return box["conn"]
    raise box.get("err", RuntimeError("DuckDB connect failed"))


def _register_sqlite_functions(conn):
    """Give SQLite the regex helpers DuckDB has natively, so a formula or
    filter can use regular expressions on either engine. Names/argument order
    mirror DuckDB: regexp_matches(str, pattern) -> 0/1, regexp_replace(str,
    pattern, replacement) replaces every match, regexp_extract(str, pattern)
    returns the first capture group (or the whole match if there are none).
    A `col REGEXP 'pat'` operator is wired up too. Bad patterns yield NULL
    rather than raising, so one malformed row can't kill a whole query."""
    import re as _re

    def _search(pattern, value):
        if value is None or pattern is None:
            return None
        try:
            return 1 if _re.search(str(pattern), str(value)) else 0
        except _re.error:
            return None

    def regexp_matches(value, pattern):
        return _search(pattern, value)

    def regexp_replace(value, pattern, replacement):
        if value is None or pattern is None:
            return value
        try:
            return _re.sub(str(pattern), str(replacement or ""), str(value))
        except _re.error:
            return str(value)

    def regexp_extract(value, pattern):
        if value is None or pattern is None:
            return None
        try:
            m = _re.search(str(pattern), str(value))
        except _re.error:
            return None
        if not m:
            return None
        return m.group(1) if m.groups() else m.group(0)

    def _regexp_op(pattern, value):  # SQLite REGEXP: pattern is on the left
        return _search(pattern, value)

    funcs = [("regexp_matches", 2, regexp_matches),
             ("regexp_replace", 3, regexp_replace),
             ("regexp_extract", 2, regexp_extract),
             ("regexp", 2, _regexp_op)]
    for name, nargs, fn in funcs:
        try:
            conn.create_function(name, nargs, fn, deterministic=True)
        except TypeError:  # Python without the deterministic kwarg
            conn.create_function(name, nargs, fn)
        except Exception:
            pass

import importlib.util as _ilu

HAS_PYARROW = _ilu.find_spec("pyarrow") is not None
HAS_DUCKDB = _ilu.find_spec("duckdb") is not None
duckdb = None

# Concurrent-reads flag (default ON) routes DuckDB's read-only paths -- the
# tables panel's catalog reconcile, per-table row counts and schema peeks --
# onto a SEPARATE cursor so they don't queue behind a long build/query on the
# main connection. Set SAMQL_CONCURRENT_READS=0 (or Session.set_concurrent_reads)
# to restore serialized main-connection reads for A/B comparison.
CONCURRENT_READS_ENV = "SAMQL_CONCURRENT_READS"


def copy_parquet_options(jumbo=True):
    """COPY ... TO parquet options. .431: a jumbo-nested JSON cache used
    to land as effectively ONE row group (925 rows << the 122k default),
    so every downstream statement decoded the entire multi-GB column
    chunk as a single unit before any pipeline could stream. Capping the
    row group by BYTES keeps decode units small for fat rows and is a
    no-op for normal data. Callers must retry without the byte option if
    the local DuckDB predates it (see exec_copy_parquet)."""
    if jumbo:
        return " (FORMAT PARQUET, ROW_GROUP_SIZE_BYTES '64MB')"
    return " (FORMAT PARQUET)"


def exec_copy_parquet(cur, select_sql, dest_fwd, max_bytes=None,
                      should_cancel=None, interrupt_fn=None):
    """Run COPY (...) TO parquet with byte-capped row groups, falling
    back to plain options when the local DuckDB does not know
    ROW_GROUP_SIZE_BYTES. Returns the SQL that actually ran.

    Optional ``max_bytes`` starts a monitor that polls the destination
    file size (and free disk on its volume). When the file exceeds the
    ceiling — or free disk drops below a small reserve — the monitor
    calls ``interrupt_fn`` (or ``cur.interrupt``) so multi-GB COPYs abort
    before filling the drive. ``should_cancel`` is polled the same way.
    """
    head = "COPY (%s) TO '%s'" % (select_sql, dest_fwd)
    sql = head + copy_parquet_options(jumbo=True)
    stop = threading.Event()
    hit = {"err": None}

    def _interrupt():
        fn = interrupt_fn
        if fn is None:
            fn = getattr(cur, "interrupt", None)
        if callable(fn):
            try:
                fn()
            except Exception:
                pass

    def _monitor():
        # Dest may not exist until DuckDB starts writing.
        dest_path = dest_fwd.replace("/", os.sep)
        reserve = 512 * 1024 * 1024  # keep ~512 MiB free on the volume
        while not stop.wait(0.75):
            try:
                if should_cancel and should_cancel():
                    hit["err"] = "cancelled"
                    _interrupt()
                    return
                if max_bytes and os.path.exists(dest_path):
                    try:
                        sz = os.path.getsize(dest_path)
                    except OSError:
                        sz = 0
                    if sz > max_bytes:
                        hit["err"] = (
                            "Parquet COPY exceeded %.1f GiB ceiling "
                            "(%.1f GiB written)"
                            % (max_bytes / (1024 ** 3), sz / (1024 ** 3)))
                        _interrupt()
                        return
                    try:
                        free = shutil.disk_usage(
                            os.path.dirname(dest_path) or ".").free
                    except Exception:
                        free = None
                    if free is not None and free < reserve:
                        hit["err"] = (
                            "Parquet COPY aborted: only %.1f GiB free on "
                            "temp volume (need headroom for spill)"
                            % (free / (1024 ** 3)))
                        _interrupt()
                        return
            except Exception:
                pass

    mon = None
    if max_bytes or should_cancel:
        mon = threading.Thread(target=_monitor, daemon=True,
                               name="samql-copy-monitor")
        mon.start()
    try:
        try:
            cur.execute(sql)
        except Exception as e:
            if "ROW_GROUP_SIZE_BYTES" not in str(e)                 and "row_group_size_bytes" not in str(e).lower():
                if hit["err"]:
                    raise RuntimeError(hit["err"]) from e
                raise
            sql = head + copy_parquet_options(jumbo=False)
            try:
                cur.execute(sql)
            except Exception as e2:
                if hit["err"]:
                    raise RuntimeError(hit["err"]) from e2
                raise
        if hit["err"]:
            raise RuntimeError(hit["err"])
        return sql
    finally:
        stop.set()
        if mon is not None:
            mon.join(timeout=2.0)


def shred_thread_throttle(conn, write_lock=None):
    """Temporarily cap DuckDB threads for a fat-struct pipeline. .431:
    DuckDB parallelizes a pipeline across threads and EACH thread holds
    vector batches of the fat trade structs, so peak memory multiplies
    by the thread count. The shred statements are exactly that shape;
    two threads keep them moving while cutting the multiplicative peak.
    Returns a restore() closure (best-effort on every path). Set
    SAMQL_SHRED_THREADS=0 to disable, or to another cap to tune."""
    try:
        n = int(os.environ.get("SAMQL_SHRED_THREADS", "2"))
    except Exception:
        n = 2
    if n <= 0 or conn is None:
        return lambda: None

    class _NullLk:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    lk = write_lock if write_lock is not None else _NullLk()
    prev = None
    try:
        with lk:
            row = conn.execute(
                "SELECT current_setting('threads')").fetchone()
            prev = int(row[0]) if row else None
    except Exception:
        prev = None
    if prev is not None and prev <= n:
        return lambda: None
    try:
        with lk:
            conn.execute("SET threads TO %d" % n)
    except Exception:
        return lambda: None

    def _restore():
        try:
            if prev:
                with lk:
                    conn.execute("SET threads TO %d" % prev)
        except Exception:
            pass
    return _restore


def _env_truthy(name, default=False):
    """True if environment variable ``name`` is set to a truthy value
    (1/true/yes/on, case-insensitive); ``default`` when it is unset."""
    import os as _os
    v = _os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _ensure_duckdb():
    global duckdb
    if duckdb is None and HAS_DUCKDB:
        try:
            import duckdb as _dd
            duckdb = _dd
        except ImportError:
            return None
    return duckdb


def _coerce_for_sqlite(v):
    if v is None or isinstance(v, (int, float, str, bytes)):
        return v
    if isinstance(v, bool):
        return int(v)
    return str(v)


# ---------------------------------------------------------------------------
# DuckDB Arrow fast-path (only used when pyarrow is present)
# ---------------------------------------------------------------------------
ARROW_CELL_CAP = 80_000_000


def _arrow_batch_tuples(batch):
    cols = list(batch.columns)
    if cols:
        # A TIMESTAMP WITH TIME ZONE column makes pyarrow attach tzinfo on
        # to_pylist(), which can touch a Python tz database. Separately,
        # DuckDB's native fetch path hard-requires pytz for TIMESTAMPTZ
        # (bundled via requirements-optional / samql.spec REQUIRED). Drop
        # the tz here first (values are already UTC instants): a metadata-
        # only cast that yields naive datetimes and needs no tz database
        # on the Arrow fast-path.
        try:
            import pyarrow as _pa
            import pyarrow.types as _pat
            for i, c in enumerate(cols):
                ty = c.type
                if _pat.is_timestamp(ty) and getattr(ty, "tz", None):
                    try:
                        cols[i] = c.cast(_pa.timestamp(ty.unit))
                    except Exception:
                        try:
                            cols[i] = c.cast(_pa.string())
                        except Exception:
                            pass
        except Exception:
            pass
    colvals = [c.to_pylist() for c in cols]
    if not colvals:
        try:
            m = int(batch.num_rows)
        except Exception:
            m = 0
        return [tuple() for _ in range(m)]
    return [tuple(r) for r in zip(*colvals)]


def _fetch_rows_arrow_or_spill(cur, ncols, cancel=None):
    """.518: the FETCH is cancellable and heartbeats. A monster nested
    result spent minutes here with no cancel check and no opreg beat --
    Cancel interrupted DuckDB (already done executing) and then had nothing
    left to reach, while the watchdog saw an "idle" op. Every batch now
    polls ``cancel`` (raising an interrupt-shaped error `_is_interrupt`
    recognizes) and beats the thread's op with rows-so-far."""
    def _check(total_rows):
        if cancel is not None and cancel.is_set():
            raise InterruptedError(
                "query cancelled during row fetch (%d rows in)" % total_rows)
        try:
            from . import progress as _op
            _op.beat(rows=total_rows)
        except Exception:
            pass
    if not HAS_PYARROW:
        return spill_rows(cur)
    try:
        import pyarrow as _pa
        reader = cur.fetch_record_batch(1_000_000)
    except Exception:
        return spill_rows(cur)
    cap_rows = max(1, ARROW_CELL_CAP // max(1, int(ncols or 1)))
    batches = []
    total = 0
    try:
        for b in reader:
            batches.append(b)
            total += int(b.num_rows)
            _check(total)
            if total > cap_rows:
                store = DiskBackedRows(block=10000)
                for bb in batches:
                    store.extend(_arrow_batch_tuples(bb))
                    _check(total)
                for bb in reader:
                    store.extend(_arrow_batch_tuples(bb))
                    total += int(bb.num_rows)
                    _check(total)
                return store
        if batches:
            tbl = _pa.Table.from_batches(batches)
        else:
            tbl = reader.schema.empty_table()
        # Materialize to plain tuples (small/medium result).
        out = []
        for bb in tbl.to_batches():
            out.extend(_arrow_batch_tuples(bb))
        return out
    except Exception as _e:
        # .518: a CANCEL must propagate -- degrading it into the spill
        # fallback would keep fetching the very rows the user just killed.
        if isinstance(_e, InterruptedError) or _is_interrupt(_e):
            raise
        store = DiskBackedRows(block=10000)
        for bb in batches:
            try:
                store.extend(_arrow_batch_tuples(bb))
            except Exception:
                pass
        return store


def _bind_safe(v):
    """Coerce a value to something sqlite3 can always bind. Big integers
    (beyond 64-bit) and Decimals would otherwise raise; here they fall back
    to a lossless text form. Used as a per-batch recovery so a column whose
    inferred type can't hold a value reverts to storing it as text rather
    than failing the whole load."""
    if v is None or isinstance(v, (str, bytes, float)):
        return v
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, int):
        if -9223372036854775808 <= v <= 9223372036854775807:
            return v
        return str(v)
    try:
        import decimal
        if isinstance(v, decimal.Decimal):
            return str(v)
    except Exception:
        pass
    if isinstance(v, (dict, list)):
        import json as _json
        return _json.dumps(v, default=str)
    return str(v)


def _visible_columns(cols):
    """.472: retype shadows (__samql_orig__*) hold the pre-cast
    originals; they are physical columns but never catalog entries --
    the sidebar, grids, profiler and exports all enumerate from
    table_columns, so filtering here hides them everywhere at once."""
    return [c for c in (cols or [])
            if not str(c).startswith("__samql_orig__")]


def _quote_ident(name):
    """Quote a SQL identifier, escaping embedded double-quotes. A column or
    table name containing a `"` (e.g. from a SQL Server query alias) would
    otherwise break the generated DDL/DML."""
    return '"' + str(name).replace('"', '""') + '"'


def _columnarize(rows, columns, text_cols):
    """Transpose a batch of row-tuples into per-column value lists, stringifying
    ONLY the text columns.

    This is the hot path for writing a flattened table. The previous approach
    called a coercion function once per cell -- O(rows x cols) Python calls --
    which made wide tables (e.g. an 84-column swap root) ~30x slower per row than
    narrow ones even though most columns are numeric and need no coercion at all.
    Here we transpose once (a single C-level zip) and touch only the text
    columns, leaving numeric/None columns to pass straight through to Arrow.

    Returns a list of (values, is_text) in column order. Pure and dependency
    free, so the behaviour is unit-testable without pyarrow/duckdb present."""
    n = len(columns)
    if not rows:
        return [([], c in text_cols) for c in columns]
    cols_data = list(zip(*rows))            # one transpose for the whole batch
    out = []
    for ci in range(n):
        col = cols_data[ci] if ci < len(cols_data) else ()
        cname = columns[ci]
        if cname in text_cols:
            vals = []
            for v in col:
                if v is None or isinstance(v, str):
                    vals.append(v)
                else:
                    sv = _bind_safe(v)
                    vals.append(sv if isinstance(sv, str) else str(sv))
            out.append((vals, True))
        else:
            # numeric/boolean/None: blank strings → NULL so Arrow/DuckDB never
            # hit "Could not convert string '' to INT64" on JSON/CSV empties.
            vals = [_empty_to_null(v) for v in col]
            out.append((vals, False))
    return out


def _dedupe_columns(columns):
    """Return a positional copy of ``columns`` with empty names filled in,
    whitespace in headers turned into ``_`` (see
    :func:`sqlutil.sanitize_column_header`), and duplicates disambiguated, so
    CREATE TABLE never fails on a repeated or blank column name (common from
    joined SQL Server queries or messy CSV headers). Non-whitespace characters
    are otherwise preserved."""
    out, seen = [], set()
    for i, c in enumerate(columns):
        base = sqlutil.sanitize_column_header(c) if c is not None else ""
        if not base:
            base = "col_%d" % (i + 1)
        name, k = base, 2
        while name in seen:
            name = "%s_%d" % (base, k)
            k += 1
        seen.add(name)
        out.append(name)
    return out


def _rewrite_columns_sanitized(exec_conn, table_name, cols, *,
                               as_view=False, view_source_sql=None):
    """Physically rewrite ``table_name`` so its headers match
    :func:`_dedupe_columns` sanitization. No-op when names already match.
    Returns the final column list. For views, ``view_source_sql`` is the
    underlying reader expression (e.g. ``read_csv_auto(...)``).

    Prefer in-place ``ALTER … RENAME COLUMN`` when the new names do not collide
    with other current headers (cheap metadata rename). Fall back to a
    ``CREATE TABLE AS SELECT`` rewrite only when collisions force it — so a
    multi-GB load that only had spaces in headers does not get a full copy.
    """
    raw = list(cols or [])
    new_cols = _dedupe_columns(raw)
    if new_cols == raw:
        return raw
    selects = ", ".join(
        "%s AS %s" % (_quote_ident(old), _quote_ident(new))
        for old, new in zip(raw, new_cols)
    )
    if as_view:
        if not view_source_sql:
            return raw
        exec_conn.execute('DROP VIEW IF EXISTS %s' % _quote_ident(table_name))
        exec_conn.execute(
            'CREATE VIEW %s AS SELECT %s FROM %s AS _hdr'
            % (_quote_ident(table_name), selects, view_source_sql))
        return new_cols
    old_set = set(raw)
    conflict = any(
        old != new and new in old_set
        for old, new in zip(raw, new_cols)
    )
    if not conflict:
        for old, new in zip(raw, new_cols):
            if old == new:
                continue
            exec_conn.execute(
                'ALTER TABLE %s RENAME COLUMN %s TO %s'
                % (_quote_ident(table_name), _quote_ident(old),
                   _quote_ident(new)))
        return new_cols
    tmp = "%s__hdrfix" % table_name
    n = 0
    while True:
        try:
            exec_conn.execute('DROP TABLE IF EXISTS %s' % _quote_ident(tmp))
            break
        except Exception:
            n += 1
            tmp = "%s__hdrfix_%d" % (table_name, n)
    exec_conn.execute(
        'CREATE TABLE %s AS SELECT %s FROM %s'
        % (_quote_ident(tmp), selects, _quote_ident(table_name)))
    exec_conn.execute('DROP TABLE %s' % _quote_ident(table_name))
    exec_conn.execute(
        'ALTER TABLE %s RENAME TO %s'
        % (_quote_ident(tmp), _quote_ident(table_name)))
    return new_cols


class DBManager:
    """SQLite-backed engine. In-memory by default; disk-backed when
    ``disk_backed=True`` (lower peak RAM, spills to a temp file)."""

    def __init__(self, disk_backed=False):
        self.db_path = ":memory:"
        self.disk_backed = bool(disk_backed)
        if disk_backed:
            try:
                from . import tmputil
                fd, self.db_path = tempfile.mkstemp(
                    prefix="samql_", suffix=".sqlite",
                    dir=tmputil.instance_dir())
                os.close(fd)
            except Exception:
                self.db_path = ":memory:"
                self.disk_backed = False
        self.write_lock = _DeadlineRLock()
        # .464 stall fix: execute_cursor (the streaming path every long
        # SELECT rides) holds NO write_lock -- by design, so cancel and
        # progress can reach the engine -- which meant the catalog's
        # busy-probes passed and then parked inside sqlite's
        # per-connection mutex behind the running statement. This
        # counter marks "a statement is stepping RIGHT NOW" for both
        # paths; the catalog walkers consult it and serve their caches
        # instead of joining the queue.
        self.stmt_busy = 0
        self._busy_lock = threading.Lock()
        # .464 rework: one persistent heartbeat per manager (see
        # _BeatDaemon). sqlite has no cancel event; the daemon only
        # beats here, and the session interrupts the conn directly.
        self._beat_depth = 0
        self._beat_tid = None
        self._beat_conn = None
        self._beatd = _BeatDaemon(self)
        self.table_columns = {}
        self.table_sources = {}
        # Original user file path when table_sources points at a converted
        # Parquet cache (so diagnostics / field trees can still sniff JSON).
        self.table_origins = {}
        self.type_inference = True
        self._conn = None
        if self.disk_backed and self.db_path != ":memory:":
            def _cleanup(_self=self):
                try:
                    if _self._conn is not None:
                        _self._conn.close()
                except Exception:
                    pass
                for _ext in ("", "-wal", "-shm", "-journal"):
                    try:
                        os.remove(_self.db_path + _ext)
                    except Exception:
                        pass
            atexit.register(_cleanup)
        self._open()

    def _open(self):
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        _register_sqlite_functions(self._conn)
        try:
            cur = self._conn.cursor()
            if self.disk_backed:
                cur.execute("PRAGMA cache_size = -131072")
                cur.execute("PRAGMA mmap_size = 536870912")
                cur.execute("PRAGMA temp_store = FILE")
                # MEMORY journal: fast for a throwaway DB and, unlike OFF,
                # still supports the SAVEPOINT/ROLLBACK used to recover a
                # bad batch during a bulk load.
                cur.execute("PRAGMA journal_mode = MEMORY")
            else:
                cur.execute("PRAGMA cache_size = -262144")
                cur.execute("PRAGMA mmap_size = 1073741824")
                # The main DB is in-memory, but heavy operations (ORDER BY,
                # DISTINCT, EXCEPT/INTERSECT, hash/merge joins -- e.g. a
                # reconcile over millions of rows) build temporary b-trees.
                # Keep those on disk so they don't balloon RAM; the large
                # page cache above means small/typical temps still stay
                # buffered in memory, so the speed cost is negligible while
                # huge intermediates stay memory-bounded.
                cur.execute("PRAGMA temp_store = FILE")
                cur.execute("PRAGMA journal_mode = MEMORY")
            cur.execute("PRAGMA synchronous = OFF")
            cur.execute("PRAGMA foreign_keys = OFF")
            cur.execute("PRAGMA page_size = 8192")
            self._conn.commit()
        except Exception:
            pass

    @property
    def conn(self):
        if self._conn is None:
            self._open()
        return self._conn


    def change_column_type(self, table, col, new_type):
        ty = (new_type or "").strip().upper()
        if not ty:
            return False
        numeric = ty in ("INTEGER", "BIGINT", "INT", "REAL", "DOUBLE",
                         "FLOAT", "NUMERIC", "DECIMAL")

        def Q(s):
            return '"' + str(s).replace('"', '""') + '"'

        with self.write_lock:
            try:
                cur = self.conn.cursor()
                cur.execute("PRAGMA table_info(" + Q(table) + ")")
                info = cur.fetchall()
            except Exception:
                return False
            names = [r[1] for r in info]
            if not names or col not in names:
                return False
            if col.startswith("__samql_orig__"):
                return False
            # .472: the FIRST retype of a column preserves the original
            # values in a hidden shadow column, and every retype (this
            # one and all later ones) derives FROM the shadow -- so
            # strings -> INTEGER nulls the non-numerics as before, and
            # changing BACK to TEXT restores the original strings
            # instead of casting the nulls. Lossless in any direction,
            # forever. The shadow is filtered from the catalog and
            # never itself retyped.
            shadow = "__samql_orig__" + col
            has_shadow = shadow in names
            src = Q(shadow) if has_shadow else Q(col)
            defs = []
            for r in info:
                cn = r[1]
                ct = ty if cn == col else (r[2] or "")
                defs.append((Q(cn) + " " + ct).strip())
            if not has_shadow:
                defs.append(Q(shadow) + " TEXT")
            if numeric:
                cexpr = (
                    "CASE WHEN " + src + " IS NULL THEN NULL "
                    "WHEN typeof(" + src + ") IN ('integer','real') "
                    "THEN CAST(" + src + " AS " + ty + ") "
                    "WHEN CAST(" + src + " AS TEXT) GLOB '*[0-9]*' "
                    "AND CAST(" + src + " AS TEXT) NOT GLOB '*[^0-9.eE+-]*' "
                    "THEN CAST(" + src + " AS " + ty + ") "
                    "ELSE NULL END")
            else:
                cexpr = "CAST(" + src + " AS " + ty + ")"
            sel = []
            for cn in names:
                sel.append((cexpr + " AS " + Q(cn)) if cn == col else Q(cn))
            if not has_shadow:
                sel.append("CAST(" + Q(col) + " AS TEXT)")
            tmp = "__retype_" + table
            try:
                cur.execute("DROP TABLE IF EXISTS " + Q(tmp))
                cur.execute("CREATE TABLE " + Q(tmp) + " ("
                            + ", ".join(defs) + ")")
                cur.execute("INSERT INTO " + Q(tmp) + " SELECT "
                            + ", ".join(sel) + " FROM " + Q(table))
                cur.execute("DROP TABLE " + Q(table))
                cur.execute("ALTER TABLE " + Q(tmp) + " RENAME TO "
                            + Q(table))
                self.conn.commit()
                return True
            except Exception:
                try:
                    self.conn.rollback()
                except Exception:
                    pass
                try:
                    self.conn.execute("DROP TABLE IF EXISTS " + Q(tmp))
                    self.conn.commit()
                except Exception:
                    pass
                return False

    def recycle(self):
        with self.write_lock:
            if self.disk_backed:
                try:
                    if self._conn is None:
                        self._open()
                    self._conn.execute("VACUUM")
                    self._conn.commit()
                except Exception:
                    pass
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._conn = None
            self.table_columns.clear()
            self.table_sources.clear()
            self.table_origins.clear()

    def add_tables(self, tables_dict, source=""):
        added = []
        with self.write_lock:
            for raw_name, rows in tables_dict.items():
                name = self._unique_name(raw_name)
                cols = self._create_table(name, rows)
                self.table_columns[name] = cols
                self.table_sources[name] = source
                added.append(name)
        for name in added:
            try:
                self._schedule_background_indexes(name)
            except Exception:
                pass
        return added

    _INDEX_EXACT_NAMES = frozenset({
        "id", "uniqueid", "unique_id", "rowid", "pk",
        "accountnumber", "account_number", "accountid", "account_id",
        "certificatecode", "certificate_code",
        "cusip", "isin", "sedol", "ticker",
        "asofdate", "as_of_date", "asof_dt", "business_date",
        "tradeid", "trade_id", "tradedate", "trade_date",
        "customerid", "customer_id", "clientid", "client_id",
        "productid", "product_id", "productcode", "product_code",
        "transactionid", "transaction_id",
        "bookcode", "book_code", "portfolioid", "portfolio_id",
        "businessunit", "business_unit", "businessdate",
        "coa", "coacode", "coa_code",
        "currency", "currencycode", "currency_code",
        "bank", "bankcode", "bank_code",
    })
    _INDEX_SUFFIXES = ("_id", "id", "_code", "code", "_key", "key",
                       "_num", "_no", "number", "_date", "date",
                       "_ts", "_dt", "_time")

    def _looks_indexable(self, col_name):
        if not col_name:
            return False
        low = col_name.lower().replace("-", "_")
        if low in self._INDEX_EXACT_NAMES:
            return True
        for suf in self._INDEX_SUFFIXES:
            if low.endswith(suf):
                return True
        return False

    # Above this row count, skip the post-load auto-indexing pass: on huge
    # tables building an index per column costs more time and memory than
    # it saves, and it would hold the write lock while the user is trying
    # to run their first queries.
    AUTO_INDEX_MAX_ROWS = 2_000_000

    def _schedule_background_indexes(self, table_name, row_count=None):
        if row_count is None:
            try:
                cur = self.conn.execute(
                    f'SELECT COUNT(*) FROM "{table_name}"')
                row = cur.fetchone()
                row_count = row[0] if row else 0
            except Exception:
                row_count = 0
        if row_count and row_count > self.AUTO_INDEX_MAX_ROWS:
            return
        cols = list(self.table_columns.get(table_name, []))
        targets = [c for c in cols if self._looks_indexable(c)]
        if not targets:
            return

        def _worker():
            for col in targets:
                try:
                    idx_name = f"idx_{table_name}_{col}"
                    if len(idx_name) > 120:
                        idx_name = idx_name[:120]
                    with self.write_lock:
                        self.conn.execute(
                            f'CREATE INDEX IF NOT EXISTS '
                            f'"{idx_name}" ON "{table_name}" ("{col}")')
                        self.conn.commit()
                except Exception:
                    pass
            try:
                with self.write_lock:
                    self.conn.execute(f'ANALYZE "{table_name}"')
                    self.conn.commit()
            except Exception:
                pass

        threading.Thread(target=_worker, daemon=True,
                         name=f"idx-{table_name}").start()

    def _unique_name(self, name):
        if name not in self.table_columns:
            return name
        i = 2
        while f"{name}_{i}" in self.table_columns:
            i += 1
        return f"{name}_{i}"

    def _create_table(self, name, rows):
        if not rows:
            self.conn.execute(f'CREATE TABLE "{name}" (_id INTEGER)')
            self.conn.commit()
            return ["_id"]
        cols, seen = [], set()
        for r in rows:
            for c in r.keys():
                if c not in seen:
                    seen.add(c)
                    cols.append(c)
        col_def = ", ".join(f'"{c}"' for c in cols)
        self.conn.execute(f'CREATE TABLE "{name}" ({col_def})')
        ph = ", ".join("?" for _ in cols)
        sample = rows[:100]
        has_nested = False
        for r in sample:
            for v in r.values():
                if isinstance(v, (dict, list)):
                    has_nested = True
                    break
            if has_nested:
                break
        chunk = 50000
        insert_sql = f'INSERT INTO "{name}" ({col_def}) VALUES ({ph})'
        cur = self.conn.cursor()
        try:
            cur.execute("BEGIN")
            if has_nested:
                for i in range(0, len(rows), chunk):
                    batch_chunk = []
                    for r in rows[i:i + chunk]:
                        vals = []
                        for c in cols:
                            v = r.get(c)
                            if isinstance(v, (dict, list)):
                                v = json.dumps(v, default=str,
                                               ensure_ascii=False)
                            vals.append(v)
                        batch_chunk.append(vals)
                    cur.executemany(insert_sql, batch_chunk)
            else:
                for i in range(0, len(rows), chunk):
                    cur.executemany(
                        insert_sql,
                        ([r.get(c) for c in cols]
                         for r in rows[i:i + chunk]))
            cur.execute("COMMIT")
        except Exception:
            try:
                cur.execute("ROLLBACK")
            except Exception:
                pass
            raise
        return cols

    def add_table_streaming(self, raw_name, columns, row_iter,
                            source="", chunk=50000):
        """Create one table and stream rows into it in batches, never
        materializing the whole dataset in Python."""
        with self.write_lock:
            name = self._unique_name(raw_name)
            if not columns:
                self.conn.execute(
                    f'CREATE TABLE {_quote_ident(name)} (_id INTEGER)')
                self.conn.commit()
                self.table_columns[name] = ["_id"]
                self.table_sources[name] = source
                return name, 0
            columns = _dedupe_columns(columns)
            row_iter = iter(row_iter)
            sample = []
            if getattr(self, "type_inference", True):
                for vals in row_iter:
                    sample.append(vals)
                    if len(sample) >= 500:
                        break
                affin = infer_affinities(columns, sample)
            else:
                affin = {}

            def _coldef(c):
                a = affin.get(c)
                return (f'{_quote_ident(c)} {a}' if a
                        else _quote_ident(c))

            create_def = ", ".join(_coldef(c) for c in columns)
            col_list = ", ".join(_quote_ident(c) for c in columns)
            ph = ", ".join("?" for _ in columns)
            self.conn.execute(
                f'CREATE TABLE {_quote_ident(name)} ({create_def})')
            insert_sql = (f'INSERT INTO {_quote_ident(name)} ({col_list}) '
                          f"VALUES ({ph})")
            cur = self.conn.cursor()
            n = 0
            batch = []
            coerce_all = [False]

            def _flush(rows):
                # Try the fast path; on a bind failure (e.g. an int wider
                # than 64-bit, or a Decimal), undo the partially-inserted
                # batch with a savepoint, coerce values to a text-safe form,
                # and retry -- then keep coercing the rest of the load.
                if coerce_all[0]:
                    cur.executemany(
                        insert_sql,
                        [tuple(_bind_safe(v) for v in r) for r in rows])
                    return
                cur.execute("SAVEPOINT _ld")
                try:
                    cur.executemany(insert_sql, rows)
                    cur.execute("RELEASE _ld")
                except (OverflowError, sqlite3.InterfaceError,
                        sqlite3.ProgrammingError, ValueError, TypeError):
                    cur.execute("ROLLBACK TO _ld")
                    cur.execute("RELEASE _ld")
                    coerce_all[0] = True
                    cur.executemany(
                        insert_sql,
                        [tuple(_bind_safe(v) for v in r) for r in rows])

            try:
                cur.execute("BEGIN")
                source_rows = (itertools.chain(sample, row_iter)
                               if sample else row_iter)
                for vals in source_rows:
                    batch.append(vals)
                    if len(batch) >= chunk:
                        _flush(batch)
                        n += len(batch)
                        opreg.beat(rows=n)
                        batch = []
                        # Poll cooperative cancel between batches so Stop is
                        # visible during multi-million-row Python drains.
                        cancel = getattr(self, "_cancel", None)
                        if cancel is not None and cancel.is_set():
                            raise InterruptedError("load cancelled")
                if batch:
                    _flush(batch)
                    n += len(batch)
                    opreg.beat(rows=n)
                    batch = []
                cur.execute("COMMIT")
            except Exception:
                batch = []
                try:
                    cur.execute("ROLLBACK")
                except Exception:
                    pass
                try:
                    self.conn.execute(f'DROP TABLE IF EXISTS "{name}"')
                    self.conn.commit()
                except Exception:
                    pass
                raise
            self.table_columns[name] = list(columns)
            self.table_sources[name] = source
        try:
            self._schedule_background_indexes(name, n)
        except Exception:
            pass
        return name, n


    @staticmethod
    def _split_statements(sql):
        from .sqlutil import split_statements
        return split_statements(sql)

    def _mark_busy(self, delta):
        try:
            with self._busy_lock:
                self.stmt_busy = max(0, self.stmt_busy + delta)
        except Exception:
            pass

    def execute(self, sql):
        # .464 audit: query execution never BEAT the progress registry --
        # only three DuckDB load paths wore the keepalive -- so any query
        # outliving the 90s stall threshold false-flagged as stalled (and
        # the cancel re-nudge never ran). Every execute now beats.
        with self.write_lock, _BeatScope(self, self.conn):
            statements = self._split_statements(sql)
            if not statements:
                return None, None
            cur = self.conn.cursor()
            last_cols, last_rows = None, None
            for s in statements:
                self._mark_busy(+1)
                try:
                    cur.execute(s)
                finally:
                    self._mark_busy(-1)
                if cur.description:
                    last_cols = [d[0] for d in cur.description]
                    last_rows = spill_rows(cur)
                else:
                    last_cols, last_rows = None, None
            self.conn.commit()
            return last_cols, last_rows

    def read(self, sql):
        """Read-only query path. SQLite has a single connection, so reads
        can't run concurrently with a write the way DuckDB's separate cursors
        can -- this just delegates to the (locked) execute() so callers can use
        a uniform engine.read() regardless of engine."""
        return self.execute(sql)

    def execute_cursor(self, sql, batch=1000):
        statements = self._split_statements(sql)
        if not statements:
            return None, None, None
        if len(statements) > 1:
            pre = self.conn.cursor()
            for s in statements[:-1]:
                self._mark_busy(+1)
                try:
                    with _BeatScope(self, self.conn):
                        pre.execute(s)
                finally:
                    self._mark_busy(-1)
            self.conn.commit()
        cur = self.conn.cursor()
        try:
            self._mark_busy(+1)
            try:
                with _BeatScope(self, self.conn):
                    cur.execute(statements[-1])
            finally:
                self._mark_busy(-1)
            if not cur.description:
                self.conn.commit()
                try:
                    cur.close()
                except Exception:
                    pass
                return None, None, None
            cols = [d[0] for d in cur.description]
            first = [tuple(r) for r in cur.fetchmany(batch)]
            if len(first) < batch:
                try:
                    cur.close()
                except Exception:
                    pass
                return cols, first, None
            return cols, first, cur
        except Exception:
            try:
                cur.close()
            except Exception:
                pass
            raise

    def interrupt(self):
        try:
            self.conn.interrupt()
        except Exception:
            pass

    def drop_table(self, name):
        with self.write_lock:
            try:
                self.conn.execute(
                    "DROP TABLE IF EXISTS " + _quote_ident(name))
                self.conn.commit()
            finally:
                self.table_columns.pop(name, None)
                self.table_sources.pop(name, None)
                self.table_origins.pop(name, None)

    def drop_all(self):
        with self.write_lock:
            for n in list(self.table_columns):
                try:
                    self.conn.execute(
                        "DROP TABLE IF EXISTS " + _quote_ident(n))
                except Exception:
                    pass
            self.conn.commit()
            self.table_columns.clear()
            self.table_sources.clear()
            self.table_origins.clear()


    def column_types(self, table):
        """Return {col: declared_type} from PRAGMA table_info.
        .464: computed UNDER the engine lock (this connection is
        shared; an unlocked PRAGMA both blocks behind and interleaves
        with a running statement) and cached."""
        cache = getattr(self, "_types_cache", None)
        if cache is None:
            cache = self._types_cache = {}
        if table in cache:
            return cache[table]
        out = {}
        with self.write_lock:
            try:
                cur = self.conn.cursor()
                cur.execute(f'PRAGMA table_info("{table}")')
                for r in cur.fetchall():
                    out[r[1]] = (r[2] or "").upper()
            except Exception:
                pass
        cache[table] = out
        return out

    def types_cached(self, table):
        """The catalog walker's view of column types: cached value if
        we have one; else compute ONLY if the engine is idle -- a busy
        engine yields {} now and the next refresh fills it in."""
        cache = getattr(self, "_types_cache", None)
        if cache is None:
            cache = self._types_cache = {}
        if table in cache:
            return cache[table]
        if getattr(self, "stmt_busy", 0) > 0:
            return {}
        if not self.write_lock.acquire(blocking=False):
            return {}
        try:
            cur = self.conn.cursor()
            out = {}
            cur.execute(f'PRAGMA table_info("{table}")')
            for r in cur.fetchall():
                out[r[1]] = (r[2] or "").upper()
            cache[table] = out
            return out
        except Exception:
            return {}
        finally:
            self.write_lock.release()

    def sync_catalog(self):
        """Reconcile the in-memory table cache with sqlite_master so
        tables created/dropped by raw SQL (CREATE TABLE, DROP, etc.)
        show up. Preserves known sources; drops vanished tables.

        .464: NON-BLOCKING. If another statement holds the engine (a
        long query, a load), serve the cached catalog instead of
        parking this thread behind it -- the sidebar refresh must
        never hang for the duration of someone's 30M-row CTE. The
        next refresh after the engine frees up reconciles for real."""
        if getattr(self, "stmt_busy", 0) > 0:
            return
        if not self.write_lock.acquire(blocking=False):
            return
        try:
            self._sync_catalog_locked()
        finally:
            self.write_lock.release()

    def _sync_catalog_locked(self):
        if True:
            try:
                cur = self.conn.cursor()
                cur.execute(
                    "SELECT name FROM sqlite_master WHERE type IN "
                    "('table','view') AND name NOT LIKE 'sqlite_%' "
                    "ORDER BY name")
                live = [r[0] for r in cur.fetchall()]
            except Exception:
                return
            live_set = set(live)
            cache = getattr(self, "_types_cache", None)
            if cache is None:
                cache = self._types_cache = {}
            for name in live:
                old = self.table_columns.get(name)
                # Skip PRAGMA when shape is known and types are warm — write
                # SQL drops types for touched tables so DDL still refreshes.
                if old is not None and name in cache:
                    self.table_sources.setdefault(name, "")
                    continue
                try:
                    cur.execute(f'PRAGMA table_info("{name}")')
                    rows = cur.fetchall()
                    cols = [r[1] for r in rows]
                    types = {r[1]: (r[2] or "").upper() for r in rows}
                except Exception:
                    cols = self.table_columns.get(name, [])
                    types = None
                vis = _visible_columns(cols)
                self.table_columns[name] = vis
                self.table_sources.setdefault(name, "")
                if types is not None:
                    vis_set = set(vis)
                    cache[name] = {k: v for k, v in types.items()
                                   if k in vis_set}
            for gone in [n for n in self.table_columns if n not in live_set]:
                self.table_columns.pop(gone, None)
                self.table_sources.pop(gone, None)
                cache.pop(gone, None)
                origins = getattr(self, "table_origins", None)
                if isinstance(origins, dict):
                    origins.pop(gone, None)


# Map the SQLite-style affinities from infer_affinities() onto DuckDB column
# types for streamed imports. Anything not numeric becomes VARCHAR; a value
# that doesn't fit its inferred numeric type makes the importer fall back to
# SQLite (which is dynamically typed), so this stays safe when inference is
# imperfect.
_DUCKDB_TYPE = {"INTEGER": "BIGINT", "REAL": "DOUBLE", "": "VARCHAR"}


class _NullCtx:
    """A no-op stand-in for write_lock when a native load runs on its own
    cursor (concurrent loads)."""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _is_type_conversion_error(exc):
    """True when ``exc`` is a DuckDB/SQLite typed-bind failure (e.g. '' → INT).

    These are recoverable by widening the column (or the whole table) to
    VARCHAR/TEXT so a few blank or mixed cells never abort a multi-GB load.
    """
    msg = str(exc or "").lower()
    if not msg:
        return False
    if "could not convert string" in msg:
        return True
    if "conversion error" in msg or "conversionexception" in msg:
        return True
    if "type mismatch" in msg and "convert" in msg:
        return True
    # Arrow / binder phrasing
    if "cannot be converted" in msg or "failed to cast" in msg:
        return True
    return False


def _empty_to_null(v):
    """Blank strings become NULL so typed numeric columns stay valid."""
    if isinstance(v, str) and not v.strip():
        return None
    return v


def _json_object_cap_bytes(memory_limit_mb=None):
    """DuckDB JSON parser object ceiling.

    DuckDB reserves parser buffers in multiples of ``maximum_object_size``;
    setting that option to 1 GiB can therefore request a 2 GiB allocation even
    for a tiny NDJSON file and fail on a normally configured 2 GiB engine. A
    256 MiB default keeps ordinary loads bounded while still allowing unusually
    large records through an explicit environment / UI override.

    When the live DuckDB ``memory_limit`` is known, the cap is also clamped so
    a ~2x parser reservation still fits under that budget. Adaptive resources
    can leave the engine at the 512 MiB floor; without this clamp the default
    256 MiB object size alone requests a 512 MiB allocation and the nested
    (non-flatten) JSON load fails before any rows are read.
    """
    from . import load_thresholds as LT
    mb = int(LT.get_int("json_object_mb"))
    mb = max(1, min(1024, mb))
    try:
        lim = int(memory_limit_mb) if memory_limit_mb else 0
    except Exception:
        lim = 0
    if lim > 0:
        # Leave headroom for the table / spill buffers: 2 * cap <= ~half limit.
        mb = min(mb, max(16, lim // 4))
    return mb * 1024 * 1024


def _json_readers(fwd, ndjson=False, memory_limit_mb=None, maximum_depth=None):
    """Ordered DuckDB JSON readers to try for a file load, most-specific first.

    ``fwd`` is the file path, already forward-slashed and single-quote-escaped.
    For NDJSON (newline-delimited JSON -- ``.ndjson`` / ``.jsonl``) we read with
    an explicit ``format='newline_delimited'`` so DuckDB skips the format-
    sniffing pre-scan; on a very large file that scan is pure overhead. We then
    fall back to a tolerant newline-delimited pass that skips unparseable lines,
    and finally to plain auto-detect in case the extension was wrong. For other
    JSON (a single object, or an array) we auto-detect, then retry tolerantly.
    Every reader caps the per-object size so one giant record can't blow the
    parser. ``SAMQL_JSON_OBJECT_MB`` tunes the cap (default 256, max 1024);
    ``memory_limit_mb`` further clamps it to the live engine budget.

    ``maximum_depth`` (optional int) is DuckDB's nested-type expansion ceiling.
    Depth 2 keeps top-level scalars typed and leaves deeper objects/arrays as
    JSON -- the flatten-off path for multi-GB nested files. Depth 0 lands a
    single ``json`` column via ``read_ndjson_objects`` / ``read_json_objects``.
    """
    cap = "maximum_object_size=%d" % _json_object_cap_bytes(memory_limit_mb)
    depth = None
    if maximum_depth is not None:
        try:
            depth = int(maximum_depth)
        except Exception:
            depth = None
    if depth is not None and depth <= 0:
        # Safest nested-off shape: one JSON value per row, no STRUCT explosion.
        if ndjson:
            return [
                f"read_ndjson_objects('{fwd}')",
                f"read_json_objects('{fwd}', format='newline_delimited')",
            ]
        return [
            f"read_json_objects_auto('{fwd}')",
            f"read_json_objects('{fwd}', auto_detect=true)",
        ]
    depth_arg = (", maximum_depth=%d" % depth) if depth is not None else ""
    if ndjson:
        return [
            f"read_json('{fwd}', format='newline_delimited', {cap}{depth_arg})",
            f"read_json('{fwd}', format='newline_delimited', "
            f"ignore_errors=true, {cap}{depth_arg})",
            f"read_json_auto('{fwd}', ignore_errors=true, {cap}{depth_arg})",
            # Last resort: one JSON value per row (no typed STRUCT/scalar
            # inference) so '' → INT never aborts a multi-GB load.
            f"read_ndjson_objects('{fwd}')",
        ]
    return [
        f"read_json_auto('{fwd}', {cap}{depth_arg})",
        f"read_json('{fwd}', auto_detect=true, ignore_errors=true, "
        f"{cap}{depth_arg})",
        f"read_json_objects_auto('{fwd}')",
    ]


def _json_shallow_depth_default():
    """Default ``maximum_depth`` for flatten-off nested JSON loads.

    Depth 2: top-level scalars stay BIGINT/VARCHAR/BOOLEAN; nested objects and
    arrays become JSON / JSON[] instead of deep STRUCTs that OOM on multi-GB
    files. Set via Storage & memory → JSON & flatten (``json_max_depth``) or
    the ``SAMQL_JSON_MAX_DEPTH`` env var (``0`` = single json column). Read
    fresh each load so UI changes apply to the next load without a restart.
    """
    try:
        from . import load_thresholds as LT
        return max(0, LT.get_int("json_max_depth"))
    except Exception:
        pass
    raw = os.environ.get("SAMQL_JSON_MAX_DEPTH", "2")
    try:
        return max(0, int(raw))
    except Exception:
        return 2


def _is_duckdb_oom(exc):
    """True when ``exc`` looks like a DuckDB out-of-memory failure."""
    msg = str(exc or "").lower()
    return ("out of memory" in msg
            or "failed to allocate" in msg
            or "could not allocate" in msg)


def _json_oom_hint(path, memory_limit_mb=None):
    lim = ""
    try:
        if memory_limit_mb:
            lim = " (engine budget ~%d MiB)" % int(memory_limit_mb)
    except Exception:
        lim = ""
    return (
        "DuckDB could not load %s: out of memory while reading nested JSON%s. "
        "Try View mode, enable Flatten on load, convert to .ndjson/.jsonl, "
        "set SAMQL_DUCKDB_MEMORY_GB higher, or lower SAMQL_JSON_OBJECT_MB "
        "if individual records are not huge."
        % (path, lim)
    )


def _csv_readers(fwd, delimiter=None):
    """Ordered DuckDB CSV reader expressions to try, most-specific first.

    ``fwd`` is the file path, already forward-slashed and single-quote-escaped.
    The first is a fast typed read: DuckDB sniffs types from a bounded head
    sample (not the whole file) and reads in parallel, avoiding the costly
    full-file inference scan that ``sample_size=-1`` forces on multi-GB files.
    ``nullstr=''`` turns blank cells into NULL so ``""`` never fails a
    BIGINT/DOUBLE column. The second is a tolerant all-VARCHAR fallback for
    rows that still cannot bind. ``delimiter`` pins the column separator when
    the caller knows it (e.g. a ``.tsv``)."""
    delim_arg = ""
    if delimiter:
        lit = "\\t" if delimiter == "\t" \
            else str(delimiter).replace("'", "''")
        delim_arg = ", delim='%s'" % lit
    return [
        f"read_csv_auto('{fwd}', sample_size=204800, nullstr=''{delim_arg})",
        f"read_csv_auto('{fwd}', all_varchar=true, "
        f"ignore_errors=true, sample_size=204800{delim_arg})",
    ]


def _is_ndjson_path(path):
    """True for newline-delimited JSON file extensions (.ndjson / .jsonl)."""
    return path.lower().endswith((".ndjson", ".jsonl"))


def _json_stream_min_bytes():
    """JSON files at/above this size get the streaming array/concat->NDJSON
    pre-pass; smaller files read fine directly. The pre-pass is not just a
    memory guard: it is the finely-cancellable, heartbeating read path (DuckDB
    reads a raw top-level array as one native call that only observes a Stop
    after it has read the whole array), so the threshold is deliberately modest
    so a mid-size array that a user might want to cancel takes the streaming
    path. Override via Storage & memory → Load thresholds or SAMQL_JSON_STREAM_MB."""
    from . import load_thresholds as LT
    mb = float(LT.get_float("json_stream_mb"))
    return int(max(1, mb) * 1024 * 1024)


def _json_stream_flatten_min_bytes():
    """Single-object JSON at/above this size uses the Python streaming flattener
    into DuckDB instead of a native nested materialise. A multi-GB single
    document cannot be buffered as one DuckDB STRUCT; the streamer spills and
    emits relational tables with bounded memory. Override via Load thresholds
    or ``SAMQL_JSON_STREAM_FLATTEN_MB`` (``0`` disables)."""
    from . import load_thresholds as LT
    mb = float(LT.get_float("json_stream_flatten_mb"))
    if mb <= 0:
        return None
    return int(max(1, mb) * 1024 * 1024)


def _ondisk_min_bytes():
    """Files at/above this size are loaded to an on-disk Parquet cache exposed
    as a query-in-place view (bounded memory for the whole lifecycle -- the rows
    never materialise in the engine), instead of an in-memory table. Returns the
    byte threshold, or None to disable the *soft* threshold (the hard floor in
    ``_ondisk_hard_floor_bytes`` still applies). Override via Load thresholds or
    SAMQL_ONDISK_MB; set it to 0 to disable the soft threshold."""
    from . import load_thresholds as LT
    mb = float(LT.get_float("ondisk_mb"))
    if mb <= 0:
        return None
    return int(mb * 1024 * 1024)


def _ondisk_hard_floor_bytes():
    """Absolute size floor for on-disk Parquet conversion.

    Multi-GB CSVs (e.g. ~6 GiB / ~9M rows) must never land as in-engine CTAS
    even when ``SAMQL_ONDISK_MB=0``. Default 256 MiB; set
    ``SAMQL_ONDISK_HARD_MB=0`` (or Load thresholds) to disable."""
    from . import load_thresholds as LT
    mb = float(LT.get_float("ondisk_hard_mb"))
    if mb <= 0:
        return None
    return int(mb * 1024 * 1024)


def _json_ondisk_min_bytes():
    """On-disk Parquet threshold for nested JSON loads.

    Nested JSON expands far beyond file size once DuckDB materialises structs /
    lists, so the generic 512 MiB file threshold is too late -- a few hundred
    MiB of nested JSON can OOM a tight engine budget. Prefer the Parquet-cache
    path sooner. Override via Load thresholds or ``SAMQL_JSON_ONDISK_MB``
    (default 64; ``0`` disables the JSON-specific floor)."""
    from . import load_thresholds as LT
    mb = float(LT.get_float("json_ondisk_mb"))
    if mb <= 0:
        return None
    return int(max(1, mb) * 1024 * 1024)


def _sniff_json_format(path, sample_size=1024 * 1024):
    """Classify a JSON file from a bounded head sample.

    Returns one of ``ndjson``, ``array``, ``concat``, ``object``, or
    ``unknown``. Used to decide whether DuckDB can read the file natively or
    whether we must rewrite it to NDJSON first (arrays and concatenated
    top-level values both need the rewrite on multi-GB files).
    """
    if _is_ndjson_path(path):
        return "ndjson"
    try:
        with open(path, "r", encoding="utf-8-sig", errors="strict") as f:
            data = f.read(max(4096, int(sample_size)))
    except Exception:
        return "unknown"
    i = 0
    n = len(data)
    while i < n and data[i].isspace():
        i += 1
    if i >= n:
        return "unknown"
    first = data[i]
    decoder = json.JSONDecoder()

    def _skip_ws(pos):
        while pos < n and data[pos].isspace():
            pos += 1
        return pos

    if first == "[":
        try:
            _, end = decoder.raw_decode(data, i)
        except json.JSONDecodeError:
            return "array"  # incomplete in sample: still a top-level array
        j = _skip_ws(end)
        if j < n and data[j] in "[{":
            return "concat"
        return "array"
    if first == "{":
        try:
            _, end = decoder.raw_decode(data, i)
        except json.JSONDecodeError:
            return "object"  # pretty-printed / larger than sample
        j = _skip_ws(end)
        if j >= n:
            return "object"
        if data[j] not in "{[":
            return "object"
        gap = data[end:j]
        if "\n" in gap or "\r" in gap:
            return "ndjson"
        return "concat"
    return "unknown"


def ensure_large_file_engine_memory(duck, path, min_size_mb=64):
    """Raise DuckDB's memory ceiling for a large file load when the machine
    has spare RAM. Explicit ``SAMQL_DUCKDB_MEMORY_GB`` always wins. Targets
    multi-GB CSV / JSON loads (e.g. ~6 GiB CSVs) that otherwise sit on a tight
    adaptive floor and thrash during COPY → Parquet."""
    if duck is None or os.environ.get("SAMQL_DUCKDB_MEMORY_GB"):
        return False
    try:
        size_mb = os.path.getsize(path) / (1024 * 1024)
    except OSError:
        return False
    if size_mb < float(min_size_mb):
        return False
    try:
        from . import resourcebudget
        snap = resourcebudget.recommend()
        avail = float(snap.get("memory_available_mb") or 0)
        total = float(snap.get("memory_total_mb") or 0)
    except Exception:
        avail = total = 0.0
    # Aim for enough headroom to parse + spill: at least 2 GiB, up to 75% of
    # RAM (capped), never more than ~70% of currently available RAM.
    want = int(max(2048, min(262144, size_mb * 2)))
    if total > 0:
        want = int(min(want, max(2048, total * 0.75)))
    if avail > 0:
        want = int(min(want, max(2048, avail * 0.70)))
    current = int(getattr(duck, "_applied_resource_memory_mb", 0) or 0)
    if want <= current:
        return False
    try:
        return bool(duck.apply_resource_memory_mb(want))
    except Exception:
        return False


def ensure_json_engine_memory(duck, path):
    """Raise DuckDB's memory ceiling for a large JSON load (see
    ``ensure_large_file_engine_memory``)."""
    return ensure_large_file_engine_memory(duck, path, min_size_mb=64)


def ensure_heavy_op_engine_memory(duck):
    """Raise DuckDB memory before flatten / shred CTAS over nested JSON.

    After a large flatten-off load, OS "available" RAM dips because DuckDB's
    own buffer pool already holds the table. Clamping the ceiling to
    available*0.7 left engines stuck around ~3–4 GiB (``3.4 of 3.4 GiB
    used``) so the next 64 MiB UNNEST/CTAS allocation failed. Size from
    **total** RAM only (~75%), and wait briefly for the write lock so the
    raise lands even when a prior statement just released it.
    """
    if duck is None or os.environ.get("SAMQL_DUCKDB_MEMORY_GB"):
        return False
    try:
        from . import resourcebudget
        snap = resourcebudget.recommend()
        total = float(snap.get("memory_total_mb") or 0)
    except Exception:
        total = 0.0
    # Do NOT clamp to OS available — that value is depressed by DuckDB's
    # own pool after a load and is the wrong signal for memory_limit.
    want = 8192
    if total > 0:
        want = int(max(4096, min(262144, total * 0.75)))
    current = int(getattr(duck, "_applied_resource_memory_mb", 0) or 0)
    if want <= current:
        return False
    try:
        return bool(duck.apply_resource_memory_mb(want, wait=True))
    except Exception:
        return False


def total_physical_ram_bytes():
    """Best-effort total physical RAM in bytes (0 if undetectable). Stdlib only,
    across Linux, macOS and Windows -- the single source of truth for machine
    RAM, read by both the DuckDB memory cap and the low-memory heuristics."""
    # POSIX (Linux, most macOS): pages * page size
    try:
        b = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        if b > 0:
            return b
    except Exception:
        pass
    # macOS fallback: sysctl hw.memsize
    try:
        import subprocess
        out = subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], timeout=2)
        b = int(out.strip())
        if b > 0:
            return b
    except Exception:
        pass
    # Windows: GlobalMemoryStatusEx
    try:
        import ctypes

        class _MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = _MS()
        m.dwLength = ctypes.sizeof(m)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return int(m.ullTotalPhys)
    except Exception:
        pass
    return 0


def _file_starts_with_array(path):
    """True if the first non-whitespace character of the file is ``[`` -- i.e.
    the file is a single top-level JSON array (the shape DuckDB must buffer
    whole). A single object or newline-delimited JSON starts with ``{`` and is
    left for DuckDB to read natively. Reads only the first few bytes."""
    try:
        with open(path, "r", encoding="utf-8-sig", errors="strict") as f:
            while True:
                c = f.read(1)
                if c == "":
                    return False
                if not c.isspace():
                    return c == "["
    except Exception:
        return False


def _json_dumps_default(obj):
    """orjson / stdlib default for values the streaming JSON reader may emit.

    ijson's yajl backend yields ``decimal.Decimal`` for numbers; without this
    ``orjson.dumps`` raises and the array→NDJSON rewrite aborts on the first
    record, forcing the flatten-off path into a multi-GB Python stream-flatten
    that looks like a stall.
    """
    import decimal
    if isinstance(obj, decimal.Decimal):
        try:
            if obj == obj.to_integral_value():
                return int(obj)
        except Exception:
            pass
        try:
            f = float(obj)
            if f == f and f not in (float("inf"), float("-inf")):
                return f
        except Exception:
            pass
        return str(obj)
    if isinstance(obj, (bytes, bytearray)):
        return obj.decode("utf-8", "replace")
    if hasattr(obj, "isoformat"):
        try:
            return obj.isoformat()
        except Exception:
            pass
    raise TypeError("Type is not JSON serializable: %s" % type(obj).__name__)


def _write_ndjson_from_stream(src_path, dst_path, should_cancel=None):
    """Rewrite a JSON file to newline-delimited JSON (one compact value per
    line) using the shared streaming reader (``flatten.stream_json_records`` --
    ijson-accelerated when installed, pure-stdlib otherwise), so DuckDB can
    stream it instead of buffering a whole top-level array. Bounded memory
    regardless of file size; returns the number of records written.

    Serialization requires ``orjson`` when installed (distribution builds and
    ``backend/requirements.txt`` always include it). Falls back to stdlib
    ``json.dumps`` only if orjson is missing, with a one-time stderr hint.
    Both paths accept ``decimal.Decimal`` from ijson via ``_json_dumps_default``.

    ``should_cancel`` (optional) is polled on every record here and, through the
    shared reader, on every raw chunk read -- so a Stop aborts promptly even in
    the middle of one very large record, raising ``InterruptedError`` (which the
    load path treats as a cancel) rather than running the file to completion.
    The reader also stamps a heartbeat while reading, so this pre-pass no longer
    looks like a stall on a slow (e.g. ijson-less) box."""
    from .flatten import stream_json_records
    try:
        import orjson as _orjson

        def _dumps(rec):
            # orjson returns bytes; decode once for the text writer.
            return _orjson.dumps(
                rec, default=_json_dumps_default).decode("utf-8")
    except Exception:
        import json as _json
        sys.stderr.write(
            "[samql] orjson is not installed — JSON loads will be slower. "
            "Install with: pip install orjson  (or: pip install -r "
            "backend/requirements.txt)\n")

        def _dumps(rec):
            return _json.dumps(rec, separators=(",", ":"),
                               ensure_ascii=False,
                               default=_json_dumps_default)

    n = 0
    with open(dst_path, "w", encoding="utf-8", newline="\n") as out:
        for rec in stream_json_records(src_path, should_cancel=should_cancel):
            if should_cancel is not None and should_cancel():
                raise InterruptedError("load cancelled during JSON read")
            out.write(_dumps(rec))
            out.write("\n")
            n += 1
    return n


def _struct_expand_select(col, typ):
    """If a one-column JSON load came back as a single STRUCT -- or a *list* of
    STRUCT, e.g. NDJSON whose lines are ``[{...}]`` arrays -- return the SELECT
    expression that expands it into proper, named columns so the loaded table
    shows the JSON keys as headers instead of one opaque column. Otherwise
    None.

    A list of structs is unnested (one row per element, struct fields become
    columns); a bare struct is star-expanded. Anything else (a scalar, a list
    of scalars, or an opaque JSON value whose keys aren't known) is left
    alone."""
    t = (typ or "").strip().upper()
    q = '"' + str(col).replace('"', '""') + '"'
    if t.startswith("STRUCT") and t.endswith("[]"):
        return f"UNNEST({q}, recursive := true)"
    if t.startswith("STRUCT"):
        return f"{q}.*"
    return None


class _ExecKeepalive:
    """Keep a long, blocking native engine call (a big ``CREATE TABLE AS
    SELECT * FROM read_json/read_csv/...``) from looking like a stall, and nudge
    it to stop once cancel is requested.

    A single ``conn.execute`` runs entirely in C with no way to stamp progress
    from Python, so a multi-minute load would (a) trip the stall watchdog after
    its threshold and (b) show no sign of life. This runs a small daemon thread
    for the duration of the call that, every ``interval`` seconds:

      * stamps a heartbeat on the op running on the *worker* thread (the one
        doing the execute), so the watchdog sees the load as alive; and
      * if the engine's cancel flag is set, re-issues ``conn.interrupt()`` --
        some reads only observe an interrupt at a later checkpoint, so nudging
        repeatedly makes a Stop take effect as soon as the engine reaches one.

    Beating only while an execute is in flight preserves real hang detection for
    everything else: a Python-side loop that genuinely wedges still stops
    beating and is still flagged. Used as a context manager around the execute.
    """

    def __init__(self, conn, cancel_event, worker_tid, interval=3.0):
        self._conn = conn
        self._cancel = cancel_event
        self._tid = worker_tid
        self._interval = interval
        self._stop = threading.Event()
        self._t = None

    def __enter__(self):
        self._t = threading.Thread(target=self._run, daemon=True,
                                   name="samql-exec-keepalive")
        self._t.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        t = self._t
        if t is not None:
            t.join(timeout=1.0)
        return False

    def _run(self):
        while not self._stop.wait(self._interval):
            try:
                opreg.beat_on_thread(self._tid)
            except Exception:
                pass
            if self._cancel is not None and self._cancel.is_set():
                try:
                    self._conn.interrupt()
                except Exception:
                    pass


class _BeatDaemon:
    """ONE persistent, daemon heartbeat thread per engine manager --
    the .464 rework of the first fix. The first version wrapped every
    execute in _ExecKeepalive, which spawned and joined a thread PER
    STATEMENT while holding write_lock; that widened every lock hold
    just enough for the non-blocking catalog probes to start landing
    inside the background indexer's holds (row counts flickered to
    blank). This version costs each execute two attribute writes: the
    execute site enters a _beat_scope, and this thread -- started once
    at manager init -- beats the executing thread's op every interval
    while any scope is open, and re-nudges conn.interrupt() while a
    cancel is pending (some engine reads only honor an interrupt at a
    later checkpoint). It also covers cursor STREAMING tails, which
    the per-execute wrapper never did."""

    def __init__(self, mgr, interval=3.0):
        # .465: hold the manager WEAKLY and self-terminate when it is
        # collected. Without this, every Session the test suite spun up
        # left two ticking daemon threads behind forever -- hundreds by
        # the suite's tail, and the timing-heavy stations crawled (the
        # 464b gauntlet went from ~110s to ~250s). A weak reference
        # needs no lifecycle plumbing: a recycled-then-reused engine
        # keeps its heartbeat, a dropped one loses its thread within
        # one interval tick, and the two runtime managers keep exactly
        # two threads for the life of the process.
        import weakref
        self._mgr = weakref.ref(mgr)
        self._interval = interval
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True,
                                   name="samql-beat-%s"
                                   % getattr(mgr, "ENGINE_KIND", "eng"))
        self._t.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(self._interval):
            m = self._mgr()
            if m is None:
                return  # manager collected -> this thread retires
            try:
                if getattr(m, "_beat_depth", 0) > 0:
                    tid = getattr(m, "_beat_tid", None)
                    if tid:
                        try:
                            opreg.beat_on_thread(tid)
                        except Exception:
                            pass
                    cancel = getattr(m, "_cancel", None)
                    conn = getattr(m, "_beat_conn", None)
                    if (cancel is not None and cancel.is_set()
                            and conn is not None):
                        try:
                            conn.interrupt()
                        except Exception:
                            pass
            except Exception:
                pass


class _BeatScope:
    """Featherweight context: marks 'this thread is executing on this
    connection' for the manager's _BeatDaemon. Pure attribute writes --
    no thread creation, no locks -- so it adds nothing measurable to a
    write_lock hold."""

    __slots__ = ("_m", "_conn")

    def __init__(self, mgr, conn):
        self._m = mgr
        self._conn = conn

    def __enter__(self):
        m = self._m
        m._beat_tid = threading.get_ident()
        m._beat_conn = self._conn
        m._beat_depth = getattr(m, "_beat_depth", 0) + 1
        return self

    def __exit__(self, *exc):
        m = self._m
        m._beat_depth = max(0, getattr(m, "_beat_depth", 1) - 1)
        if m._beat_depth == 0:
            m._beat_conn = None
        return False




class _DuckBranchCursor:
    """Manager-shaped adapter around a DuckDB cursor/child connection.

    DuckDB's documented threading model is one cursor per worker thread.  The
    adapter keeps Session's ``eng.execute -> (columns, rows)`` contract while
    allowing independent NodeFlow branches to create distinct persistent hidden
    tables concurrently.
    """

    def __init__(self, manager, cursor):
        self.manager = manager
        self.conn = cursor

    def execute(self, sql):
        with _BeatScope(self.manager, self.conn):
            cur = self.conn.execute(sql)
        if cur.description is None:
            return None, None
        cols = [d[0] for d in cur.description]
        return cols, [tuple(r) for r in cur.fetchall()]

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


class DuckDBManager:
    """DuckDB-backed engine (optional; requires the duckdb package).
    Used for Parquet/large-CSV scans and analytical SQL."""

    ENGINE_KIND = "duckdb"

    def __init__(self, low_memory=False, on_disk=False, memory_limit_mb=None):
        self._low_memory = bool(low_memory)
        self._on_disk = bool(on_disk or low_memory)
        try:
            self._resource_memory_mb = (max(512, int(memory_limit_mb))
                                        if memory_limit_mb else None)
        except Exception:
            self._resource_memory_mb = None
        self._applied_resource_memory_mb = None
        # Cached DuckDB function names whose result is not stable across
        # separate executions. Persistent NodeFlow intermediates consult this
        # before publishing a graph that contains SQL expressions.
        self._unstable_functions = None
        self._db_path = None
        self._conn = None
        self.write_lock = _DeadlineRLock()
        # own-cursor native loads in flight (concurrent loads):
        # interrupt() sweeps these so Stop / reset reaches them
        self._native_ops = {}
        self._native_ops_lock = threading.Lock()
        # names picked but not yet CREATEd by own-cursor ops (.406):
        # reservations make concurrent name-picking race-free
        self._reserved_names = set()
        # Serializes only the in-memory catalog-cache reconcile (fast dict work)
        # on the concurrent-reads path, so two refreshes can't race it without
        # taking write_lock (which a build holds).
        self._catalog_lock = threading.Lock()
        # Concurrent read cursors for SELECT peeks during long COPYs.
        # On by default so catalog/page peeks do not queue behind multi-GB
        # writes. Every concurrent path falls back to the locked read on
        # failure. SAMQL_CONCURRENT_READS=0 restores full serialization.
        self.concurrent_reads = _env_truthy(CONCURRENT_READS_ENV, True)
        # Cap simultaneous read CURSORS (each is a live DuckDB connection):
        # spamming Run must degrade gracefully to the locked path, never
        # exhaust connections. SAMQL_READ_CURSORS overrides (1..64).
        try:
            _slots = int(os.environ.get("SAMQL_READ_CURSORS") or 4)
        except Exception:
            _slots = 4
        self._read_slots = threading.BoundedSemaphore(
            max(1, min(_slots, 64)))
        self.table_columns = {}
        self.table_sources = {}
        # Original user file path when table_sources points at a converted
        # Parquet cache (so diagnostics / field trees can still sniff JSON).
        self.table_origins = {}
        self._counter = 0
        self.view_backing = {}
        # Set by interrupt() so a Python-side read loop (the large-JSON-array
        # pre-pass) can observe a cancel -- conn.interrupt() only aborts a
        # running DuckDB statement, not our own read.
        self._cancel = threading.Event()
        self._beat_depth = 0
        self._beat_tid = None
        self._beat_conn = None
        self._beatd = _BeatDaemon(self)
        self._open()

    @staticmethod
    def _total_ram_gb():
        """Best-effort total physical RAM in GiB (0.0 if undetectable)."""
        return total_physical_ram_bytes() / (1024 ** 3)

    @classmethod
    def _mem_limit_gb(cls):
        """Pick a DuckDB memory cap sized to this machine. Smaller boxes
        get a more conservative fraction (leave room for the OS and the
        rest of the app); large boxes are capped so a single query can't
        try to grab everything. DuckDB spills to its temp dir past this.

        An explicit SAMQL_DUCKDB_MEMORY_GB env var overrides the auto-sizing
        (clamped to 1..1024 GB) so an admin can tune it per machine."""
        try:
            ov = os.environ.get("SAMQL_DUCKDB_MEMORY_GB")
            if ov:
                return max(1, min(int(float(ov)), 1024))
        except Exception:
            pass
        ram = cls._total_ram_gb()
        if ram <= 0:
            return 8  # unknown: workable default for nested flatten
        if ram <= 6:
            frac = 0.65
        elif ram <= 32:
            frac = 0.75
        else:
            frac = 0.80
        # Cap high enough that multi-GB nested flatten/shred is not aborted
        # by an artificial 48 GiB ceiling on large workstations.
        return max(2, min(int(ram * frac), 256))

    @staticmethod
    def _thread_count(low_memory=False):
        """Threads for DuckDB, never over-subscribing the CPU. Low-memory
        mode stays small to limit per-thread buffer pressure.

        Leaves TWO cores free (was one): the on-box 2026-07-02 stall dump
        showed the interpreter starved so hard during a giant nested COPY
        that Thread.start() itself stalled -- the HTTP acceptor couldn't
        spawn request threads and every poll timed out. DuckDB's internal
        pool is invisible to the dump; the headroom keeps Python (server,
        watchdog, cancels) responsive no matter what the engine chews.
        SAMQL_DUCKDB_THREADS overrides."""
        env = os.environ.get("SAMQL_DUCKDB_THREADS")
        if env:
            try:
                return max(1, int(env))
            except ValueError:
                pass
        n = os.cpu_count() or 4
        if low_memory:
            return max(1, min(2, n))
        return max(1, min(n - 2 if n > 2 else 1, 32))

    def _open(self):
        low_memory = self._low_memory
        dd = _ensure_duckdb()
        if dd is None:
            raise RuntimeError(
                "DuckDB is not installed. Install with: pip install duckdb")
        if self._on_disk:
            # A throwaway on-disk database so DuckDB's buffer manager can
            # keep only the working set in memory and spill cold table data
            # to this file (its own format, with statistics) instead of
            # holding everything in RAM. Lives in the per-instance temp dir
            # and is removed on recycle/shutdown/next-start sweep.
            try:
                from . import tmputil
                self._db_path = tmputil.instance_path(
                    f"duck_{id(self)}.duckdb")
                for stale in (self._db_path, self._db_path + ".wal"):
                    try:
                        os.unlink(stale)
                    except Exception:
                        pass
                conn = _connect_with_timeout(dd.connect, self._db_path,
                                             DUCKDB_CONNECT_TIMEOUT)
                if conn is None:
                    # connect wedged on a slow/locked path -> use in-memory so
                    # the app stays usable instead of hanging on first use.
                    self._db_path = None
                    self._conn = dd.connect(":memory:")
                else:
                    self._conn = conn
            except Exception:
                self._db_path = None
                self._conn = dd.connect(":memory:")
        else:
            self._conn = dd.connect(":memory:")

        def _try(_sql):
            try:
                self._conn.execute(_sql)
            except Exception:
                pass

        # An explicit administrator override remains authoritative. Otherwise
        # Session's adaptive resource policy supplies a live machine/pressure-
        # aware ceiling. Low-memory mode never exceeds 1 GiB.
        explicit = bool(os.environ.get("SAMQL_DUCKDB_MEMORY_GB"))
        if not explicit and self._resource_memory_mb:
            mb = min(self._resource_memory_mb, 1024) if low_memory \
                else self._resource_memory_mb
            _try(f"SET memory_limit = '{max(512, int(mb))}MB'")
            self._applied_resource_memory_mb = max(512, int(mb))
        elif low_memory:
            _try("SET memory_limit = '1GB'")
            self._applied_resource_memory_mb = 1024
        else:
            gb = self._mem_limit_gb()
            _try(f"SET memory_limit = '{gb}GB'")
            self._applied_resource_memory_mb = gb * 1024
        try:
            from . import tmputil
            spill = tmputil.instance_path("duckdb_spill")
            os.makedirs(spill, exist_ok=True)
            spill = spill.replace("\\", "/")
            _try(f"SET temp_directory = '{spill}'")
        except Exception as e:
            # Never fall back to a bare <temp>/duckdb_spill outside the
            # per-pid instance dir -- that path survives sweep_stale and
            # leaks across runs. Skip the SET if instance temp is unavailable.
            print("[samql] DuckDB spill dir unavailable (%s); "
                  "leaving engine default temp_directory" % e,
                  file=sys.stderr)
        _try(f"SET threads TO {self._thread_count(low_memory)}")
        _try("SET enable_object_cache = true")
        _try("SET preserve_insertion_order = false")

    @property
    def conn(self):
        if self._conn is None:
            self._open()
        return self._conn

    def purge_shadow_temp_views(self, names=None):
        """.513: drop TEMP views whose names COLLIDE with main-catalog
        relations. DuckDB resolves unqualified names temp-first, and temp
        objects are per-connection -- so one orphaned reuse view (a cancel
        storm can interrupt its own cleanup DROP) makes every query on the
        main connection read a stale result snapshot while cursors (the
        sidebar, counts) see the real table: the on-box 925-vs-22,704
        split-brain. A colliding temp view is never legitimate -- reuse
        views are only ever created for NON-colliding names -- so dropping
        them is always safe. Returns the dropped names."""
        dropped = []
        try:
            with self.write_lock:
                cur = self.conn.execute(
                    "SELECT view_name FROM duckdb_views() "
                    "WHERE temporary AND lower(view_name) IN ("
                    "SELECT lower(table_name) FROM information_schema.tables "
                    "WHERE table_schema='main')")
                hits = [r[0] for r in cur.fetchall()]
                if names is not None:
                    want = {str(n).lower() for n in names}
                    hits = [h for h in hits if h.lower() in want]
                for h in hits:
                    try:
                        self.conn.execute(
                            'DROP VIEW IF EXISTS "temp"."main"."%s"'
                            % h.replace('"', '""'))
                        dropped.append(h)
                    except Exception:
                        pass
        except Exception:
            return dropped
        if dropped:
            print("  dropped %d shadowing temp view(s): %s"
                  % (len(dropped), ", ".join(sorted(dropped))), flush=True)
        return dropped

    def execute(self, sql):
        # Hold the connection lock so a foreground query can never run on the
        # DuckDB connection at the same time as the background CHECKPOINT
        # (DuckDB connections are not safe for concurrent use). This is what
        # made a reconcile fail right after a drill-down result was closed.
        # .513: self-heal name shadowing first (throttled) -- an orphaned
        # temp view must never answer for a real table.
        now = _time_mod.time()
        if now - getattr(self, "_shadow_purge_t", 0.0) > 3.0:
            self._shadow_purge_t = now
            try:
                self.purge_shadow_temp_views()
            except Exception:
                pass
        with self.write_lock, _BeatScope(self, self.conn):
            cur = self.conn.execute(sql)
            if cur.description is None:
                return None, None
            cols = [d[0] for d in cur.description]
            rows = _fetch_rows_arrow_or_spill(cur, len(cols),
                                              cancel=self._cancel)
            return cols, rows

    def execute_cursor(self, sql, batch=1000, same_conn=False):
        # A DuckDB cursor() is a SEPARATE connection with its own temporary
        # schema, so it cannot see TEMP tables created on this connection. When
        # the caller must read such a table (the export streams one the flow
        # just materialised) it passes same_conn=True to run on the main
        # connection instead. The caller is then responsible for serialising
        # access (holding write_lock) for the cursor's lifetime, and must NOT
        # close it -- closing would close the engine's own connection.
        cur = self.conn if same_conn else self.conn.cursor()
        tid = threading.get_ident()
        registered = False
        if not same_conn:
            # Private cursor must join _native_ops so cancel_query / Stop can
            # interrupt the statement (same as execute_read / ParquetResultStore).
            try:
                with self._native_ops_lock:
                    self._native_ops[tid] = cur
                registered = True
            except Exception:
                registered = False

        def _unregister():
            if not registered:
                return
            try:
                with self._native_ops_lock:
                    if self._native_ops.get(tid) is cur:
                        self._native_ops.pop(tid, None)
            except Exception:
                pass

        def _close():
            _unregister()
            if not same_conn:
                try:
                    cur.close()
                except Exception:
                    pass

        try:
            with _BeatScope(self, self.conn if same_conn else cur):
                cur.execute(sql)
            if cur.description is None:
                _close()
                return None, None, None
            cols = [d[0] for d in cur.description]
            first = [tuple(r) for r in cur.fetchmany(batch)]
            if len(first) < batch:
                _close()
                return cols, first, None
            # Caller drains the live cursor — wrap so unregister runs on close
            # (DuckDB cursor.close is read-only; cannot reassign).
            if registered and not same_conn:
                from .rows import _NativeOpsCursor
                return cols, first, _NativeOpsCursor(cur, _unregister)
            return cols, first, cur
        except Exception:
            _close()
            raise

    def cursor(self):
        return self.conn.cursor()

    def apply_resource_memory_mb(self, memory_mb, allow_decrease=False,
                                 wait=False):
        """Apply an adaptive memory ceiling without waiting behind a query.

        Explicit ``SAMQL_DUCKDB_MEMORY_GB`` configuration always wins. A busy
        engine simply keeps its current limit until the next budget sync
        (unless ``wait=True``, used by flatten/shred so a raise is not
        skipped the instant a CTAS releases the lock).

        By default adaptive sync only RAISES the ceiling. Shrinking after a
        large load (when "available" RAM dips) made flatten/shred CTAS fail
        with OutOfMemory; pass ``allow_decrease=True`` only for explicit UI
        / low-memory mode.
        """
        if os.environ.get("SAMQL_DUCKDB_MEMORY_GB") or self._conn is None:
            return False
        try:
            mb = max(512, min(int(memory_mb or 0), 1024 * 1024))
        except Exception:
            return False
        if self._low_memory:
            mb = min(mb, 1024)
            allow_decrease = True
        current = int(self._applied_resource_memory_mb or 0)
        if mb == current:
            return True
        if not allow_decrease and current and mb < current:
            return False
        try:
            got = self.write_lock.acquire(blocking=False)
        except Exception:
            got = False
        if not got and wait:
            try:
                got = self.write_lock.acquire(blocking=True)
            except Exception:
                got = False
        if not got:
            return False
        try:
            self.conn.execute(f"SET memory_limit = '{mb}MB'")
            self._resource_memory_mb = mb
            self._applied_resource_memory_mb = mb
            return True
        except Exception:
            return False
        finally:
            try:
                self.write_lock.release()
            except Exception:
                pass

    def unstable_function_names(self):
        """Return DuckDB functions unsafe for restart-persistent results.

        ``CONSISTENT_WITHIN_QUERY`` functions (for example ``now`` and
        ``current_date``) are deterministic only inside one statement, not
        across application restarts, so they are deliberately treated as
        unstable alongside VOLATILE/side-effecting functions. Unknown macros
        and table functions are also conservative misses when invoked from a
        node expression.
        """
        cached = self._unstable_functions
        if cached is not None:
            return cached
        with self.write_lock:
            cached = self._unstable_functions
            if cached is not None:
                return cached
            rows = self.conn.execute(
                "SELECT DISTINCT lower(function_name) "
                "FROM duckdb_functions() "
                "WHERE coalesce(stability, 'UNKNOWN') <> 'CONSISTENT' "
                "OR coalesce(has_side_effects, false)"
            ).fetchall()
            cached = frozenset(str(r[0]).lower() for r in rows if r and r[0])
            self._unstable_functions = cached
            return cached

    def branch_cursor(self):
        """Return a registered child connection for one worker thread.

        The caller must close it.  Registration lets per-query cancellation
        interrupt the exact branch connection rather than only the main engine.
        """
        cur = self.conn.cursor()
        tid = threading.get_ident()
        with self._native_ops_lock:
            self._native_ops[tid] = cur
        adapter = _DuckBranchCursor(self, cur)
        original_close = adapter.close

        def _close():
            with self._native_ops_lock:
                if self._native_ops.get(tid) is cur:
                    self._native_ops.pop(tid, None)
            original_close()
        adapter.close = _close
        return adapter

    def execute_read(self, sql):
        """Run a read-only query on a SEPARATE cursor -- its own connection --
        so it does NOT take write_lock and can run concurrently with a long
        build/query holding the main connection. This is DuckDB's documented
        multithreading model (one cursor per thread, MVCC snapshot reads) and
        the same primitive the streaming export already uses. A fresh
        connection only sees COMMITTED, persistent tables, not TEMP tables on
        the main connection, so callers use read()/their own fallback to the
        locked execute() when a fresh cursor can't satisfy the query."""
        cur = self.conn.cursor()
        # .471: register this thread's read cursor so a precise cancel
        # (_interrupt_entry's tid path) can interrupt THE STATEMENT --
        # a separate cursor is its own connection, so the engine-level
        # interrupt never reached it. Reconcile's summary reads ride
        # this path.
        _tid = threading.get_ident()
        with self._native_ops_lock:
            self._native_ops[_tid] = cur
        try:
            with _BeatScope(self, cur):
                c = cur.execute(sql)
                if c.description is None:
                    return None, None
                cols = [d[0] for d in c.description]
                rows = [tuple(r) for r in c.fetchall()]
                return cols, rows
        finally:
            with self._native_ops_lock:
                if self._native_ops.get(_tid) is cur:
                    self._native_ops.pop(_tid, None)
            try:
                cur.close()
            except Exception:
                pass

    def read(self, sql):
        """Read-only query dispatcher for the tables panel / counts / schema
        peeks. With concurrent reads enabled, run on a separate cursor (no
        write_lock) so the read proceeds while a build holds the main
        connection; otherwise -- and on ANY failure from the concurrent path
        (e.g. a TEMP table a fresh cursor can't see) -- fall back to the
        serialized execute(). Read paths only ever pass metadata / COUNT(*)
        queries here, never a large result scan."""
        if self.concurrent_reads:
            try:
                return self.execute_read(sql)
            except Exception:
                pass
        return self.execute(sql)

    @contextlib.contextmanager
    def native_op_cursor(self):
        """Yield ``(exec_conn, lock_ctx)`` for a LONG catalog-writing op
        (flatten/shred CREATEs, dump COPYs -- the .404 audit). Own cursor
        + no lock when concurrent reads are on: DuckDB's MVCC takes
        writers to DIFFERENT tables, so these ops overlap with queries,
        loads, and each other instead of serializing the app. The cursor
        registers in _native_ops so interrupt()/Stop/reset reaches it;
        any cursor failure falls back to (self.conn, write_lock). Brief
        DDL (DROP/RENAME/reuse maintenance) intentionally stays on the
        locked main connection."""
        handle = None
        exec_conn = self.conn
        lock_ctx = self.write_lock
        if getattr(self, "concurrent_reads", False):
            try:
                handle = self.conn.cursor()
                exec_conn = handle
                lock_ctx = _NullCtx()
                with self._native_ops_lock:
                    self._native_ops[threading.get_ident()] = handle
            except Exception:
                handle = None
                exec_conn = self.conn
                lock_ctx = self.write_lock
        try:
            yield exec_conn, lock_ctx
        finally:
            if handle is not None:
                with self._native_ops_lock:
                    self._native_ops.pop(threading.get_ident(), None)
                try:
                    handle.close()
                except Exception:
                    pass

    def interrupt(self):
        # Trip the cooperative flag first so a Python-side read (the JSON-array
        # pre-pass) stops even though there's no DuckDB statement to interrupt,
        # then interrupt any statement that *is* running.
        try:
            self._cancel.set()
        except Exception:
            pass
        try:
            if self._conn is not None:
                self._conn.interrupt()
        except Exception:
            pass
        try:
            with self._native_ops_lock:
                handles = list(self._native_ops.values())
            for h in handles:
                try:
                    h.interrupt()
                except Exception:
                    pass
        except Exception:
            pass

    def memory_bytes(self):
        """Best-effort DuckDB memory total that NEVER blocks on the write lock.

        The memory widget polls this every few seconds. execute() serializes on
        write_lock, so during a big load (which holds the lock for its whole
        duration) a blocking probe would hang for the entire load; several such
        hung polls then occupy every slot in the browser's per-host connection
        pool and starve the lock-free /api/status poll -- the app then shows
        "checking..." and feels frozen. So if the engine is busy we report None
        (unknown) rather than queue behind it. Runs on a fresh cursor under the
        lock (never the shared cursor a build may be mid-scan on)."""
        conn = self._conn
        if conn is None:
            return None
        try:
            got = self.write_lock.acquire(blocking=False)
        except Exception:
            return None
        if not got:
            return None
        try:
            cur = conn.cursor()
            cur.execute("SELECT sum(memory_usage_bytes) FROM duckdb_memory()")
            row = cur.fetchone()
            if row and row[0] is not None:
                return int(row[0])
        except Exception:
            pass
        finally:
            try:
                self.write_lock.release()
            except Exception:
                pass
        return None

    def add_tables(self, tables_dict, source=""):
        added = []
        with self.write_lock:
            for raw_name, rows in tables_dict.items():
                name = self._unique_name(raw_name)
                cols = self._create_table(name, rows)
                self.table_columns[name] = cols
                self._types_cache_drop(name)
                self.table_sources[name] = source
                added.append(name)
        return added

    def add_table_from_parquet(self, raw_name, columns, parquet_path,
                                source="result"):
        """.472: save-as-table from a parquet-backed result with ONE
        engine statement (CREATE TABLE AS read_parquet) instead of
        round-tripping every row through Python and executemany --
        that Python loop was the reported minutes."""
        with self.write_lock:
            name = self._unique_name(raw_name)
            qcols = ", ".join(_quote_ident(c) for c in columns)
            fwd = sqlutil.sql_path(parquet_path)
            with _BeatScope(self, self.conn):
                self.conn.execute(
                    "CREATE TABLE %s AS SELECT %s FROM read_parquet('%s')"
                    % (_quote_ident(name), qcols, fwd))
                n = self.conn.execute(
                    "SELECT COUNT(*) FROM " + _quote_ident(name)
                ).fetchone()[0]
            self.table_columns[name] = list(columns)
            self.table_sources[name] = source
            self._types_cache_drop(name)
            return name, int(n)

    def add_table_streaming(self, raw_name, columns, row_iter,
                            source="", chunk=50000):
        """Stream (columns, row-tuples) into a new DuckDB table in batches,
        never materializing the whole dataset in Python. Column types are
        inferred from a sample and mapped to DuckDB types (BIGINT / DOUBLE /
        VARCHAR). The whole operation is atomic: if any batch fails to bind,
        the partial table is dropped and the error re-raised so the caller can
        fall back to SQLite. Mirrors DBManager.add_table_streaming so a remote
        import can target either engine."""
        with self.write_lock:
            name = self._unique_name(raw_name)
            if not columns:
                self.conn.execute(
                    f'CREATE TABLE {_quote_ident(name)} (_id INTEGER)')
                self.table_columns[name] = ["_id"]
                self._types_cache_drop(name)
                self.table_sources[name] = source
                return name, 0
            columns = _dedupe_columns(columns)
            row_iter = iter(row_iter)
            sample = []
            for vals in row_iter:
                sample.append(vals)
                if len(sample) >= 500:
                    break
            affin = infer_affinities(columns, sample)
            types = {c: _DUCKDB_TYPE.get(affin.get(c) or "", "VARCHAR")
                     for c in columns}
            text_cols = {c for c in columns if types[c] == "VARCHAR"}
            widen_all = [False]

            def _coerce(c, v):
                if v is None:
                    return None
                if c in text_cols or widen_all[0]:
                    if isinstance(v, str):
                        return v
                    sv = _bind_safe(v)
                    return sv if isinstance(sv, str) else str(sv)
                # Typed numeric column: blank JSON/CSV cells → NULL, not ''.
                return _empty_to_null(v)

            def _stringify_rows(rows):
                out = []
                for r in rows:
                    cells = []
                    for v in r:
                        if v is None:
                            cells.append(None)
                        elif isinstance(v, str):
                            cells.append(v)
                        else:
                            sv = _bind_safe(v)
                            cells.append(sv if isinstance(sv, str) else str(sv))
                    out.append(tuple(cells))
                return out

            def _widen_table_to_varchar():
                """Rebuild the live table as all-VARCHAR after a conversion
                failure so remaining rows (and prior rows) stay loadable."""
                nonlocal types, text_cols, col_def, insert_sql
                casts = ", ".join(
                    "CAST(%s AS VARCHAR) AS %s"
                    % (_quote_ident(c), _quote_ident(c)) for c in columns)
                tmp = name + "__varchar"
                self.conn.execute(
                    f'DROP TABLE IF EXISTS {_quote_ident(tmp)}')
                self.conn.execute(
                    f'CREATE TABLE {_quote_ident(tmp)} AS '
                    f'SELECT {casts} FROM {_quote_ident(name)}')
                self.conn.execute(
                    f'DROP TABLE {_quote_ident(name)}')
                self.conn.execute(
                    f'ALTER TABLE {_quote_ident(tmp)} '
                    f'RENAME TO {_quote_ident(name)}')
                types = {c: "VARCHAR" for c in columns}
                text_cols = set(columns)
                widen_all[0] = True
                col_def = ", ".join(
                    f'{_quote_ident(c)} VARCHAR' for c in columns)
                insert_sql = (
                    f'INSERT INTO {_quote_ident(name)} ({col_list}) '
                    f"VALUES ({ph})")

            col_def = ", ".join(f'{_quote_ident(c)} {types[c]}'
                                for c in columns)
            col_list = ", ".join(_quote_ident(c) for c in columns)
            ph = ", ".join("?" for _ in columns)
            self.conn.execute(
                f'CREATE TABLE {_quote_ident(name)} ({col_def})')
            insert_sql = (f'INSERT INTO {_quote_ident(name)} ({col_list}) '
                          f"VALUES ({ph})")
            n = 0
            batch = []

            def _coerce_rows(rows):
                return [tuple(_coerce(c, v) for c, v in zip(columns, r))
                        for r in rows]

            def _flush(rows):
                if HAS_PYARROW and rows and not widen_all[0]:
                    try:
                        import pyarrow as _pa
                        prepared = _columnarize(rows, columns, text_cols)
                        arrays = [
                            _pa.array(vals, type=_pa.string()) if is_text
                            else _pa.array(vals)
                            for (vals, is_text) in prepared]
                        _at = _pa.table(arrays, names=list(columns))
                        self.conn.register("_samql_arrow_ins", _at)
                        try:
                            self.conn.execute(
                                f'INSERT INTO {_quote_ident(name)} '
                                f'SELECT * FROM _samql_arrow_ins')
                        finally:
                            try:
                                self.conn.unregister("_samql_arrow_ins")
                            except Exception:
                                pass
                        return
                    except Exception as e:
                        try:
                            self.conn.unregister("_samql_arrow_ins")
                        except Exception:
                            pass
                        if _is_type_conversion_error(e):
                            _widen_table_to_varchar()
                            self.conn.executemany(
                                insert_sql, _stringify_rows(rows))
                            return
                try:
                    self.conn.executemany(insert_sql, _coerce_rows(rows))
                except Exception as e:
                    if widen_all[0] or not _is_type_conversion_error(e):
                        raise
                    _widen_table_to_varchar()
                    self.conn.executemany(insert_sql, _stringify_rows(rows))

            try:
                source_rows = (itertools.chain(sample, row_iter)
                               if sample else row_iter)
                for vals in source_rows:
                    batch.append(vals)
                    if len(batch) >= chunk:
                        _flush(batch)
                        n += len(batch)
                        opreg.beat(rows=n)
                        batch = []
                        if self._cancel.is_set():
                            raise InterruptedError("load cancelled")
                if batch:
                    _flush(batch)
                    n += len(batch)
                    opreg.beat(rows=n)
            except Exception:
                try:
                    self.conn.execute(f'DROP TABLE IF EXISTS "{name}"')
                except Exception:
                    pass
                raise
            self.table_columns[name] = list(columns)
            self._types_cache_drop(name)
            self.table_sources[name] = source
            return name, n

    def _unique_name(self, name):
        taken = set(self.table_columns) | getattr(
            self, "_reserved_names", set())
        if name not in taken:
            return name
        i = 2
        while f"{name}_{i}" in taken:
            i += 1
        return f"{name}_{i}"

    def reserve_table_name(self, name):
        """Atomically pick a unique table name AND reserve it, so two
        concurrent own-cursor ops (.402 loads, .404 flatten/shred) can
        never pick the same name -- _unique_name alone is a lock-free
        read. Reservations self-prune once the table exists; a failed
        op should call release_table_name()."""
        with self.write_lock:
            self._reserved_names = {
                n for n in getattr(self, "_reserved_names", set())
                if n not in self.table_columns}
            final = self._unique_name(name)
            self._reserved_names.add(final)
            return final

    def release_table_name(self, name):
        """Free a reservation whose op failed before CREATE."""
        try:
            self._reserved_names.discard(name)
        except Exception:
            pass

    def _create_table(self, name, rows):
        if not rows:
            self.conn.execute(f'CREATE TABLE "{name}" (_id INTEGER)')
            return ["_id"]
        cols, seen = [], set()
        for r in rows:
            for c in r.keys():
                if c not in seen:
                    seen.add(c)
                    cols.append(c)
        col_def = ", ".join(f'"{c}" VARCHAR' for c in cols)
        self.conn.execute(f'CREATE TABLE "{name}" ({col_def})')
        col_names = ", ".join(f'"{c}"' for c in cols)
        placeholders = ", ".join("?" for _ in cols)
        insert_sql = (f'INSERT INTO "{name}" ({col_names}) '
                      f"VALUES ({placeholders})")
        has_nested = False
        for r in rows[:100]:
            for v in r.values():
                if isinstance(v, (dict, list)):
                    has_nested = True
                    break
            if has_nested:
                break
        chunk = 50000
        if has_nested:
            for i in range(0, len(rows), chunk):
                batch = []
                for r in rows[i:i + chunk]:
                    vals = []
                    for c in cols:
                        v = r.get(c)
                        if v is None:
                            vals.append(None)
                        elif isinstance(v, (dict, list)):
                            vals.append(json.dumps(v, default=str,
                                                   ensure_ascii=False))
                        else:
                            vals.append(str(v))
                    batch.append(vals)
                self.conn.executemany(insert_sql, batch)
        else:
            for i in range(0, len(rows), chunk):
                batch = []
                for r in rows[i:i + chunk]:
                    vals = [None if r.get(c) is None else str(r.get(c))
                            for c in cols]
                    batch.append(vals)
                self.conn.executemany(insert_sql, batch)
        return cols

    def _maybe_expand_json_struct(self, final):
        """If a JSON load produced a single STRUCT / list-of-STRUCT column,
        rebuild the table so the struct's keys become real columns (so the grid
        shows proper headers instead of one ``[{...}]`` column). Best effort: on
        any error the original table is kept. Returns the column list. Caller
        must already hold ``write_lock``."""
        cur = self.conn.execute(f'SELECT * FROM "{final}" LIMIT 0')
        cols = [d[0] for d in cur.description] if cur.description else []
        if len(cols) != 1:
            return cols
        try:
            row = self.conn.execute(
                f'SELECT typeof("{cols[0]}") FROM "{final}" LIMIT 1'
            ).fetchone()
            typ = (row[0] if row else "") or ""
        except Exception:
            return cols
        expand = _struct_expand_select(cols[0], typ)
        if not expand:
            return cols
        tmp = self._unique_name(final + "__exp")
        try:
            self.conn.execute(f'DROP TABLE IF EXISTS "{tmp}"')
            self.conn.execute(
                f'CREATE TABLE "{tmp}" AS SELECT {expand} FROM "{final}"')
            self.conn.execute(f'DROP TABLE "{final}"')
            self.conn.execute(f'ALTER TABLE "{tmp}" RENAME TO "{final}"')
            cur = self.conn.execute(f'SELECT * FROM "{final}" LIMIT 0')
            return [d[0] for d in cur.description] if cur.description else cols
        except Exception:
            try:
                self.conn.execute(f'DROP TABLE IF EXISTS "{tmp}"')
            except Exception:
                pass
            return cols

    def _json_source_for_read(self, path):
        """Decide what file DuckDB should actually read for a JSON load.

        Every non-NDJSON shape is rewritten to a temp NDJSON file through the
        shared bounded-memory reader so DuckDB always ingests
        ``format='newline_delimited'`` (and then usually COPY to Parquet).
        That covers top-level arrays, concatenated values, and single objects
        with one code path. True NDJSON / ``.ndjson`` / ``.jsonl`` is read in
        place. Returns ``(read_path, is_ndjson, cleanup_path_or_None)``.
        A cancel during the rewrite raises. For large non-NDJSON files a
        rewrite failure propagates (falling back to the raw array would
        make DuckDB buffer the whole document). Small files still fall
        back to the original path so quirky tiny fixtures keep loading."""
        fmt = _sniff_json_format(path)
        if fmt == "ndjson" or _is_ndjson_path(path):
            return path, True, None
        # Rewrite array / concat / object / unknown so every JSON format
        # shares the NDJSON → Parquet conversion pipeline.
        dst = None
        try:
            import uuid
            from . import tmputil
            dst = tmputil.instance_path("arr_" + uuid.uuid4().hex + ".ndjson")
            _write_ndjson_from_stream(path, dst, should_cancel=self._cancel.is_set)
        except InterruptedError:
            # user cancelled mid-read: drop the partial temp and abort the load
            if dst:
                try:
                    os.unlink(dst)
                except Exception:
                    pass
            raise
        except Exception:
            if dst:
                try:
                    os.unlink(dst)
                except Exception:
                    pass
            # Large non-NDJSON: do not hand DuckDB the raw file (buffers the
            # whole array). Let the caller recover via stream-flatten / depth-0.
            try:
                sz = os.path.getsize(path)
            except OSError:
                sz = 0
            stream_floor = _json_stream_min_bytes()
            if sz >= stream_floor:
                raise
            return path, False, None
        return dst, True, dst

    def create_table_from_file(self, name, path, kind, delimiter=None,
                               json_depth=None, cancel=None):
        """Materialize a file into a real DuckDB table.

        Unlike a file-backed view (which re-parses the source on every
        query), this reads the file once into DuckDB's columnar storage,
        so subsequent queries on large CSV/JSON files are fast. DuckDB
        reads the file natively (multithreaded C++), streaming and
        spilling to the temp directory when it exceeds memory.

        For messy real-world CSVs it retries with an error-tolerant,
        all-text read so a few malformed rows never abort the load --
        mirroring the SQLite loader's "everything as TEXT" tolerance.

        ``delimiter`` (CSV only) forces a single-character field separator
        instead of DuckDB's auto-sniffer -- needed for separators the
        sniffer won't guess on its own (e.g. ``~``).

        ``json_depth`` (JSON only) caps DuckDB nested-type expansion
        (``maximum_depth``). Used by flatten-off loads so deep nesting
        stays as JSON instead of exploding into STRUCTs.

        ``cancel`` (optional callable -> bool) is the load-job Stop flag.
        Sticky ``_cancel`` from a *prior* Stop is cleared once at entry;
        a Stop that lands while waiting for the lock is honored and must
        not attach a table.
        """
        from .loaders import LoadCancelled
        # CONCURRENT LOADS (on-box 2026-07-02: a second load queued behind
        # a running conversion for its whole duration). A cursor is its own
        # connection; DuckDB's MVCC takes two writers to DIFFERENT tables,
        # and _unique_name guarantees different tables. Cursor failure
        # falls back to the locked path; interrupt() sweeps _native_ops so
        # Stop / reset still reaches an own-cursor load.
        handle = None
        exec_conn = self.conn
        lock_ctx = self.write_lock
        if getattr(self, "concurrent_reads", False):
            try:
                handle = self.conn.cursor()
                exec_conn = handle
                lock_ctx = _NullCtx()
                with self._native_ops_lock:
                    self._native_ops[threading.get_ident()] = handle
            except Exception:
                handle = None
                exec_conn = self.conn
                lock_ctx = self.write_lock
        final = self.reserve_table_name(name)
        cleanup = None
        landed = False
        try:
          # Fresh load: clear sticky cancel from a prior Stop once. Do NOT
          # clear again after lock wait — that erased Stop during the wait.
          self._cancel.clear()

          def _cancelled():
              if cancel and cancel():
                  return True
              try:
                  return bool(self._cancel.is_set())
              except Exception:
                  return False

          if _cancelled():
              raise LoadCancelled()
          # NDJSON rewrite is filesystem-only; keep it outside write_lock so a
          # large array rewrite does not serialize the whole engine when
          # concurrent_reads is off (NullCtx path was already unlocked).
          fwd = sqlutil.sql_path(path)
          mem_mb = self._applied_resource_memory_mb
          if kind == "parquet":
              readers = [f"read_parquet('{fwd}')"]
          elif kind == "json":
              read_path, is_nd, cleanup = self._json_source_for_read(path)
              rfwd = read_path.replace("\\", "/").replace("'", "''")
              readers = _json_readers(
                  rfwd, ndjson=is_nd, memory_limit_mb=mem_mb,
                  maximum_depth=json_depth)
          else:  # csv / delimited text
              readers = _csv_readers(fwd, delimiter)
          if _cancelled():
              raise LoadCancelled()
          with lock_ctx:
            # Honor Stop that landed while waiting for the lock.
            if _cancelled():
                raise LoadCancelled()
            try:
                with _ExecKeepalive(exec_conn, self._cancel,
                                    threading.get_ident()):
                    last = None
                    for rdr in readers:
                        try:
                            if _cancelled():
                                raise LoadCancelled()
                            exec_conn.execute(
                                f'DROP TABLE IF EXISTS "{final}"')
                            exec_conn.execute(
                                f'CREATE TABLE "{final}" AS SELECT * FROM {rdr}')
                            cur = exec_conn.execute(
                                f'SELECT * FROM "{final}" LIMIT 0')
                            cols = ([d[0] for d in cur.description]
                                    if cur.description else [])
                            if kind == "json":
                                # Expand a single STRUCT / STRUCT[] column so
                                # JSON keys become headers -- for both full
                                # nested loads and shallow flatten-off CTAS.
                                # No-op when the table already has real columns.
                                self.table_columns[final] = cols
                                self._types_cache_drop(final)
                                cols = self._maybe_expand_json_struct(final)
                            cols = _rewrite_columns_sanitized(
                                exec_conn, final, cols)
                            if _cancelled():
                                try:
                                    exec_conn.execute(
                                        f'DROP TABLE IF EXISTS "{final}"')
                                except Exception:
                                    pass
                                raise LoadCancelled()
                            self.table_columns[final] = cols
                            self._types_cache_drop(final)
                            self.table_sources[final] = path
                            landed = True
                            return final
                        except LoadCancelled:
                            raise
                        except Exception as e:
                            # A cancel interrupts the running read. Do NOT fall
                            # through to the tolerant reader -- that would quietly
                            # finish the very load the user asked to stop (the
                            # "Cancelling..." that never cancels). Drop any
                            # partial table and abort.
                            if _is_interrupt(e):
                                try:
                                    exec_conn.execute(
                                        f'DROP TABLE IF EXISTS "{final}"')
                                except Exception:
                                    pass
                                raise
                            last = e
                            continue
                    if kind == "json" and _is_duckdb_oom(last):
                        raise RuntimeError(
                            _json_oom_hint(path, mem_mb)) from last
                    raise RuntimeError(
                        f"DuckDB could not load {path}: {last}")
            finally:
                if cleanup:
                    try:
                        os.unlink(cleanup)
                    except Exception:
                        pass
                    cleanup = None
        finally:
            if cleanup:
                try:
                    os.unlink(cleanup)
                except Exception:
                    pass
            # CTAS partial: last-reader rewrite failure / cancel after CREATE
            # must not leave an orphan table under the reserved name.
            if not landed:
                try:
                    exec_conn.execute(f'DROP TABLE IF EXISTS "{final}"')
                except Exception:
                    pass
                for reg in ("table_columns", "table_sources", "view_backing",
                            "table_origins"):
                    try:
                        getattr(self, reg, {}).pop(final, None)
                    except Exception:
                        pass
                try:
                    self._types_cache_drop(final)
                except Exception:
                    pass
            self.release_table_name(final)
            if handle is not None:
                with self._native_ops_lock:
                    self._native_ops.pop(threading.get_ident(), None)
                try:
                    handle.close()
                except Exception:
                    pass

    def create_view_from_file(self, name, path, kind, delimiter=None):
        """Create a DuckDB *view* over a file instead of materializing it
        into a table -- "query the file in place".

        Queries re-read the file through the same native ``read_*`` readers,
        so nothing is copied into DuckDB storage: load is instant and memory
        stays low. For Parquet this is also *fast* (column + row-group
        pushdown); for CSV it re-parses on every query, trading query speed
        for instant load. Uses the fast typed reader, falling back to the
        tolerant all-text reader so messy files still open. The file must
        stay on disk for the view to keep working -- the caller registers a
        real, persistent path (not a temp upload).
        """
        with self.write_lock:
            final = self._unique_name(name)
            fwd = sqlutil.sql_path(path)
            if kind == "parquet":
                readers = [f"read_parquet('{fwd}')"]
            elif kind == "json":
                readers = _json_readers(
                    fwd, ndjson=(_sniff_json_format(path) == "ndjson"
                                 or _is_ndjson_path(path)),
                    memory_limit_mb=self._applied_resource_memory_mb)
            else:  # csv / delimited text
                readers = _csv_readers(fwd, delimiter)
            last = None
            for rdr in readers:
                try:
                    self.conn.execute(f'DROP VIEW IF EXISTS "{final}"')
                    self.conn.execute(f'DROP TABLE IF EXISTS "{final}"')
                    self.conn.execute(
                        f'CREATE VIEW "{final}" AS SELECT * FROM {rdr}')
                    cur = self.conn.execute(
                        f'SELECT * FROM "{final}" LIMIT 0')
                    cols = ([d[0] for d in cur.description]
                            if cur.description else [])
                    cols = _rewrite_columns_sanitized(
                        self.conn, final, cols,
                        as_view=True, view_source_sql=rdr)
                    self.table_columns[final] = cols
                    self._types_cache_drop(final)
                    self.table_sources[final] = path
                    # Keep persistent filecache entries alive while a view
                    # is attached so budget sweep cannot unlink them.
                    try:
                        from . import filecache as _fc
                        if path and _fc.enabled() and os.path.dirname(
                                os.path.realpath(path)) == os.path.realpath(
                                    _fc._DIR):
                            _fc.hold(path)
                    except Exception:
                        pass
                    return final
                except Exception as e:
                    if _is_interrupt(e):
                        for obj in ("VIEW", "TABLE"):
                            try:
                                self.conn.execute(
                                    f'DROP {obj} IF EXISTS "{final}"')
                            except Exception:
                                pass
                        raise
                    last = e
                    continue
            raise RuntimeError(
                f"DuckDB could not open {path} as a view: {last}")

    def drop_all(self):
        with self.write_lock:
            for n in list(self.table_columns):
                for obj in ("VIEW", "TABLE"):
                    try:
                        self.conn.execute(f'DROP {obj} IF EXISTS "{n}"')
                    except Exception:
                        pass
            self.table_columns.clear()
            self.table_sources.clear()
            self.table_origins.clear()

    def recycle(self):
        with self.write_lock:
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._conn = None
            self.table_columns.clear()
            self.table_sources.clear()
            self.table_origins.clear()
            if self._db_path:
                for f in (self._db_path, self._db_path + ".wal"):
                    try:
                        os.unlink(f)
                    except Exception:
                        pass

    def checkpoint(self):
        """Flush the WAL and reclaim space in the on-disk database (no-op for
        an in-memory database). Cheap to call when idle.

        Uses a NON-BLOCKING lock acquire. This runs on a background timer and a
        DuckDB connection is not safe for concurrent use, so the checkpoint
        must hold the connection lock -- but it must never *wait* for it. If a
        foreground query/flow already holds the lock, skip this pass (return
        False) rather than queue up behind the query and then seize the
        connection the instant it is released -- that is what could leave the
        next run sitting on "Running ..." while a slow on-disk checkpoint runs.
        DuckDB auto-checkpoints the WAL on its own and the caller reschedules,
        so a skipped pass is harmless. Returns True iff the checkpoint ran."""
        if not self.write_lock.acquire(blocking=False):
            return False
        try:
            self.conn.execute("CHECKPOINT")
            return True
        except Exception:
            return False
        finally:
            self.write_lock.release()

    def load_file_to_parquet_view(self, name, path, kind, delimiter=None,
                                  cancel=None, json_depth=None):
        """Stream a (large) file straight into a Parquet cache and expose it as
        a read_parquet view. The rows are never materialised in the engine, so
        memory stays bounded for the whole lifecycle -- ingest AND queries --
        while the columnar cache gives repeat queries column + row-group
        pushdown (and cached Parquet metadata). Returns the view name.

        Cancellation works without a Python loop here: the COPY is one
        statement that interrupt() aborts, the JSON-array pre-pass polls the
        cooperative flag, and the optional ``cancel`` pre-check catches a stop
        that lands first. On cancel or failure the partial cache is removed and
        the exception propagates (the caller may fall back to an in-memory
        load). A cancelled same-file waiter must not attach a newly cached
        view after ``conversion_lock`` / ``write_lock`` wait.

        ``json_depth`` (JSON only) is included in the file-cache key so a
        shallow flatten-off conversion never collides with a full nested one.
        """
        from .loaders import LoadCancelled
        from . import tmputil
        from . import filecache
        # Fresh load: clear sticky cancel from a prior Stop once. Do NOT
        # clear again after lock waits — that erased Stop during the wait
        # and let cancelled waiters attach tables/views.
        try:
            self._cancel.clear()
        except Exception:
            pass

        def _cancelled():
            if cancel and cancel():
                return True
            try:
                return bool(self._cancel.is_set())
            except Exception:
                return False

        if _cancelled():
            raise LoadCancelled()
        # Persistent conversion cache: if this exact file (path+size+mtime,
        # same reader) was converted before -- even by a previous app run --
        # attach the existing Parquet and skip the whole parse. The key
        # changes whenever the source changes, so a stale entry can't be
        # served; SAMQL_FILECACHE=0 restores the old per-instance behavior.
        extra = delimiter or ""
        if kind == "json" and json_depth is not None:
            extra = "%s|depth=%s" % (extra, json_depth)
        fc_key = filecache.cache_key(path, kind, extra=extra) \
            if filecache.enabled() else None
        hit = filecache.lookup(fc_key)
        if hit:
            if _cancelled():
                raise LoadCancelled()
            final = self.create_view_from_file(name, hit, "parquet")
            DuckDBManager._remember_origin(self, final, path)
            return final
        # Single-flight per cache key (acquire before write_lock). A waiter
        # re-looks up after the leader commits instead of duplicating COPY.
        with filecache.conversion_lock(fc_key):
            if _cancelled():
                raise LoadCancelled()
            hit = filecache.lookup(fc_key)
            if hit:
                if _cancelled():
                    raise LoadCancelled()
                final = self.create_view_from_file(name, hit, "parquet")
                DuckDBManager._remember_origin(self, final, path)
                return final
            if fc_key:
                cache = filecache.begin(fc_key)
            else:
                cache = tmputil.new_tempfile("cache_", ".parquet")
            cfwd = cache.replace("\\", "/").replace("'", "''")
            cleanup = None
            try:
                # NDJSON rewrite is pure filesystem work — do it outside write_lock
                # so concurrent reads / peeks / cancel bookkeeping are not blocked
                # for the whole multi-GB stream rewrite. COPY still takes the lock.
                fwd = sqlutil.sql_path(path)
                if kind == "parquet":
                    readers = [f"read_parquet('{fwd}')"]
                elif kind == "json":
                    read_path, is_nd, cleanup = self._json_source_for_read(path)
                    rfwd = read_path.replace("\\", "/").replace("'", "''")
                    readers = _json_readers(
                        rfwd, ndjson=is_nd,
                        memory_limit_mb=self._applied_resource_memory_mb,
                        maximum_depth=json_depth)
                else:  # csv / delimited text
                    readers = _csv_readers(fwd, delimiter)
                if _cancelled():
                    raise LoadCancelled()
                with self.write_lock:
                    # Honor Stop that landed while waiting for the lock.
                    if _cancelled():
                        raise LoadCancelled()
                    # Try every reader (typed → tolerant), same ladder as CTAS.
                    # A single first-reader failure used to abort the whole
                    # on-disk path and refuse the load.
                    last = None
                    copied = False
                    for reader in readers:
                        try:
                            try:
                                if os.path.exists(cache):
                                    os.unlink(cache)
                            except OSError:
                                pass
                            if _cancelled():
                                raise LoadCancelled()
                            with _ExecKeepalive(self.conn, self._cancel,
                                                threading.get_ident()):
                                exec_copy_parquet(
                                    self.conn,
                                    "SELECT * FROM %s" % reader, cfwd,
                                    should_cancel=_cancelled,
                                    interrupt_fn=getattr(
                                        self.conn, "interrupt", None))
                            copied = True
                            break
                        except LoadCancelled:
                            raise
                        except Exception as e:
                            if _is_interrupt(e):
                                raise
                            last = e
                            continue
                    if not copied:
                        raise RuntimeError(
                            "DuckDB could not COPY %s to Parquet: %s"
                            % (path, last)) from last
            except BaseException:
                try:
                    os.unlink(cache)
                except OSError:
                    pass
                raise
            finally:
                if cleanup:
                    try:
                        os.unlink(cleanup)
                    except OSError:
                        pass
            if _cancelled():
                try:
                    os.unlink(cache)
                except OSError:
                    pass
                raise LoadCancelled()
            if fc_key:
                try:
                    # publish atomically so a crash mid-COPY never leaves a half
                    # entry under the final name
                    cache = filecache.commit(cache, fc_key)
                except Exception:
                    # couldn't publish (e.g. an AV scanner pinned the target):
                    # the LOAD must still succeed -- move the finished conversion
                    # to a per-instance temp and use it uncached
                    fallback = tmputil.new_tempfile("cache_", ".parquet")
                    try:
                        os.replace(cache, fallback)
                    except OSError:
                        import shutil as _sh
                        _sh.copyfile(cache, fallback)
                        filecache.abort(cache)
                    cache = fallback
            if _cancelled():
                try:
                    os.unlink(cache)
                except OSError:
                    pass
                raise LoadCancelled()
            # Expose the cache as a query-in-place view (reuses the parquet path).
            # Keep the ORIGINAL file path so diagnostics / nested field trees can
            # still sniff JSON after table_sources points at the Parquet cache.
            final = self.create_view_from_file(name, cache, "parquet")
            DuckDBManager._remember_origin(self, final, path)
            return final


    def _remember_origin(self, name, path):
        """Record the original load path when it differs from the live source."""
        if not name or not path:
            return
        origins = getattr(self, "table_origins", None)
        if not isinstance(origins, dict):
            try:
                self.table_origins = {}
                origins = self.table_origins
            except Exception:
                return
        try:
            src = (getattr(self, "table_sources", {}) or {}).get(name)
            if src and os.path.normcase(os.path.abspath(str(src))) == \
                    os.path.normcase(os.path.abspath(str(path))):
                return
        except Exception:
            pass
        try:
            if os.path.exists(str(path)):
                origins[name] = str(path)
        except Exception:
            origins[name] = str(path)

    def view_to_parquet(self, view_name, parquet_path, cancel=None):
        """Materialise an existing view/table into a Parquet file (columnar +
        compressed) so repeat queries get column + row-group pushdown instead
        of re-parsing text. Reads through the source's own reader, so it works
        whatever the view is over (csv/tsv/json). DuckDB streams the COPY
        (bounded memory, spilling to its temp dir).

        Cancellation: this is a single SQL statement, so there is no Python
        loop to weave a check into -- a Stop aborts it through interrupt()
        (load_cancel -> interrupt_loads -> this manager's connection), which
        unblocks the COPY. The cooperative pre-check below additionally catches
        a cancel that lands before the statement starts. The caller deletes the
        partial Parquet on cancel/error.
        """
        from .loaders import LoadCancelled
        if cancel and cancel():
            raise LoadCancelled()
        fwd = parquet_path.replace("\\", "/").replace("'", "''")
        with self.write_lock:
            if cancel and cancel():
                raise LoadCancelled()
            with _ExecKeepalive(self.conn, self._cancel,
                                threading.get_ident()):
                # .431: byte-capped row groups with an old-DuckDB retry
                exec_copy_parquet(self.conn,
                                  'SELECT * FROM "%s"' % view_name, fwd)

    def drop_table(self, name):
        self._types_cache_drop(name)
        backing = None
        src = None
        with self.write_lock:
            kind = None
            try:
                cur = self.conn.cursor()
                cur.execute(
                    "SELECT table_type FROM information_schema.tables "
                    "WHERE table_name = ? LIMIT 1", [name])
                row = cur.fetchone()
                if row:
                    kind = (row[0] or "").upper()
            except Exception:
                kind = None
            order = (("VIEW", "TABLE") if kind == "VIEW"
                     else ("TABLE", "VIEW"))
            for obj in order:
                try:
                    self.conn.execute(
                        f"DROP {obj} IF EXISTS " + _quote_ident(name))
                    break
                except Exception:
                    continue
            self.table_columns.pop(name, None)
            src = self.table_sources.pop(name, None)
            self.table_origins.pop(name, None)
            backing = getattr(self, "view_backing", {}).pop(name, None)
        if src:
            try:
                from . import filecache as _fc
                if _fc.enabled() and os.path.dirname(
                        os.path.realpath(src)) == os.path.realpath(_fc._DIR):
                    _fc.release(src)
            except Exception:
                pass
        if backing:
            try:
                os.unlink(backing)
            except Exception:
                pass

    def change_column_type(self, table, col, new_type):
        ty = (new_type or "").strip()
        if not ty:
            return False
        # normalise a few SQLite-ish names to DuckDB equivalents; anything
        # else (DATE, TIMESTAMP, BOOLEAN, DECIMAL, ...) is passed through.
        alias = {"INT": "INTEGER", "REAL": "DOUBLE", "FLOAT": "DOUBLE",
                 "NUMERIC": "DOUBLE", "TEXT": "VARCHAR", "STRING": "VARCHAR"}
        ty = alias.get(ty.upper(), ty)

        def Q(s):
            return '"' + str(s).replace('"', '""') + '"'

        with self.write_lock:
            types = self.column_types(table)  # {name: TYPE}
            if not types or col not in types:
                return False
            is_view = False
            try:
                cur = self.conn.cursor()
                cur.execute(
                    "SELECT table_type FROM information_schema.tables "
                    "WHERE table_name = ? LIMIT 1", [table])
                row = cur.fetchone()
                is_view = bool(row) and (row[0] or "").upper() == "VIEW"
            except Exception:
                is_view = False
            if col.startswith("__samql_orig__"):
                return False
            # .472: the first retype preserves the originals in a
            # hidden shadow column; every retype derives FROM the
            # shadow, so changing a column back restores the original
            # values instead of re-casting the NULLs (see the SQLite
            # twin above). TRY_CAST yields NULL where a value can't be
            # coerced (instead of aborting the whole statement).
            shadow = "__samql_orig__" + col
            has_shadow = shadow in types
            src = Q(shadow) if has_shadow else Q(col)
            sel = []
            for cn in types.keys():
                sel.append(f"TRY_CAST({src} AS {ty}) AS {Q(cn)}"
                           if cn == col else Q(cn))
            if not has_shadow:
                sel.append(f"CAST({Q(col)} AS VARCHAR) AS {Q(shadow)}")
            select_sql = "SELECT " + ", ".join(sel) + " FROM " + Q(table)
            tmp = "__retype_" + table
            try:
                self.conn.execute(
                    f"CREATE OR REPLACE TABLE {Q(tmp)} AS {select_sql}")
                self.conn.execute(
                    f'DROP {"VIEW" if is_view else "TABLE"} IF EXISTS {Q(table)}')
                self.conn.execute(
                    f"ALTER TABLE {Q(tmp)} RENAME TO {Q(table)}")
                if is_view:
                    self.view_backing.pop(table, None)
                try:
                    self.table_columns[table] = _visible_columns(
                        self.column_types(table).keys())
                    self._types_cache_drop(table)
                except Exception:
                    pass
                return True
            except Exception:
                try:
                    self.conn.execute(f"DROP TABLE IF EXISTS {Q(tmp)}")
                except Exception:
                    pass
                return False

    def column_types(self, table):
        # Upper-cased types for display / hint detection; the raw-case types
        # (needed to build correct nested field paths) come from the raw helper.
        return {k: (v or "").upper()
                for k, v in self._column_types_raw(table).items()}

    # .464: catalog-walker alias -- the raw helper already caches and
    # already reads on a separate cursor first, so it never queues
    # behind a build; the sqlite twin gained the same contract.
    types_cached = column_types


    def _types_cache_drop(self, name=None):
        """Invalidate cached column types (one table, or everything)."""
        try:
            if name is None:
                self._types_cache.clear()
            else:
                self._types_cache.pop(name, None)
        except Exception:
            pass

    def _column_types_raw(self, table):
        """Column types with their ORIGINAL case preserved (struct field names
        can be case-sensitive when quoted, so the tree's field paths must not be
        upper-cased). Same DESCRIBE + typeof-fallback strategy as column_types.

        CACHED per table: the sidebar tree and the field explorer call this on
        every expand, and the typeof() fallback reads a live row -- on a
        multi-GB nested view that is an expensive probe to repeat. The cache
        is dropped for tables a write/DDL touches (see Session write path)
        and for tables whose column *list* changes during incremental
        sync_catalog. Unchanged tables keep a warm cache so tables_tree
        does not re-DESCRIBE every refresh. DML that only changes VALUES
        cannot change TYPES, so a cached answer stays current until DDL.
        """
        cache = getattr(self, "_types_cache", None)
        if cache is None:
            cache = self._types_cache = {}
        hit = cache.get(table)
        if hit is not None:
            return dict(hit)
        out = {}
        # Always TRY the separate-cursor read first, even when concurrent
        # reads are off: DESCRIBE on a fresh cursor is safe for persistent
        # tables and means the tables panel / field explorer never queue 30s
        # behind a build holding the main connection. A TEMP table (invisible
        # to a fresh cursor) or any failure falls through to the locked read.
        if hasattr(self, "execute_read"):
            try:
                _c, rows = self.execute_read(f'DESCRIBE "{table}"')
                for r in (rows or []):
                    if r[1]:
                        out[r[0]] = r[1]
            except Exception:
                out = {}
        if not out:
            try:
                cur = self.conn.execute(f'DESCRIBE "{table}"')
                for r in cur.fetchall():
                    if r[1]:
                        out[r[0]] = r[1]
            except Exception:
                pass
        # DESCRIBE can return a BLANK type for a column of a view over deeply
        # nested Parquet/JSON (the big flatten-off "json" column), which would
        # leave the tree showing "?" and suppress its query hint. typeof() is
        # evaluated on a real row, so it yields the true STRUCT/LIST/JSON type
        # even then -- use it to fill in any column DESCRIBE couldn't type.
        missing = [c for c in getattr(self, "table_columns", {}).get(table, [])
                   if not out.get(c)]
        if missing:
            try:
                sel = ", ".join('typeof("%s")' % c.replace('"', '""')
                                for c in missing)
                got = None
                if hasattr(self, "execute_read"):
                    try:
                        _c, rows = self.execute_read(
                            f'SELECT {sel} FROM "{table}" LIMIT 1')
                        got = rows[0] if rows else None
                    except Exception:
                        got = None
                if got is None:
                    cur = self.conn.execute(
                        f'SELECT {sel} FROM "{table}" LIMIT 1')
                    got = cur.fetchone()
                for c, t in zip(missing, got or []):
                    if t:
                        out[c] = str(t)
            except Exception:
                pass
        cache[table] = dict(out)
        return out

    def sync_catalog(self):
        """Reconcile the cache with DuckDB's information_schema so views
        and tables created by raw SQL are reflected.

        Incremental: list live tables and column names from
        ``information_schema``, then ``DESCRIBE`` only tables that are new
        or whose visible column list changed, or whose types cache was
        dropped (write/DDL paths drop types for touched tables before
        sync so ``CREATE OR REPLACE`` with the same column names still
        refreshes). DESCRIBE results seed ``_types_cache`` so
        ``tables_tree`` does not pay a second DESCRIBE per table.
        """
        if not self.concurrent_reads:
            # .464: same non-blocking rule as the sqlite twin -- a busy
            # engine serves the cached catalog rather than stalling.
            if not self.write_lock.acquire(blocking=False):
                return
            try:
                # Class-bound so tests that bind sync_catalog onto a stub
                # still resolve the incremental helpers.
                DuckDBManager._duck_sync_catalog(self, use_read=False)
            finally:
                self.write_lock.release()
            return
        # Concurrent path: information_schema + selective DESCRIBE on
        # separate cursors (no write_lock), then reconcile under
        # _catalog_lock so two refreshes cannot race dict mutation.
        DuckDBManager._duck_sync_catalog(self, use_read=True)

    def _duck_fetch_catalog_lists(self, use_read):
        """Return ``(live_names, cols_by_name)`` from information_schema."""
        tables_sql = (
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema NOT IN ('information_schema') "
            "ORDER BY table_name")
        cols_sql = (
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema NOT IN ('information_schema') "
            "ORDER BY table_name, ordinal_position")
        try:
            if use_read:
                _c, rows = self.execute_read(tables_sql)
                live = [r[0] for r in (rows or [])]
                _c2, crows = self.execute_read(cols_sql)
                col_rows = crows or []
            else:
                cur = self.conn.execute(tables_sql)
                live = [r[0] for r in cur.fetchall()]
                cur = self.conn.execute(cols_sql)
                col_rows = cur.fetchall()
        except Exception:
            return None, None
        cols_by = {}
        for row in col_rows:
            if not row:
                continue
            tname, cname = row[0], row[1]
            cols_by.setdefault(tname, []).append(cname)
        return live, cols_by

    def _duck_describe_table(self, name, use_read):
        """Return ``(column_names, types_by_col)`` from DESCRIBE."""
        rows = None
        try:
            if use_read:
                _c, rows = self.execute_read(f'DESCRIBE "{name}"')
            else:
                cur = self.conn.execute(f'DESCRIBE "{name}"')
                rows = cur.fetchall()
        except Exception:
            rows = None
        cols, types = [], {}
        for r in (rows or []):
            if not r:
                continue
            cols.append(r[0])
            if len(r) > 1 and r[1]:
                types[r[0]] = r[1]
        return cols, types

    def _duck_sync_catalog(self, use_read):
        live, cols_by = DuckDBManager._duck_fetch_catalog_lists(self, use_read)
        if live is None:
            return
        live_set = set(live)
        cache = getattr(self, "_types_cache", None)
        if cache is None:
            cache = self._types_cache = {}

        # Decide which tables need DESCRIBE (new, column-list change, or
        # missing types). Unchanged tables with a warm types cache skip.
        need_describe = []
        planned_cols = {}
        for name in live:
            info_cols = _visible_columns(cols_by.get(name) or [])
            planned_cols[name] = info_cols
            old = self.table_columns.get(name)
            if old == info_cols and name in cache and info_cols:
                continue
            need_describe.append(name)

        described = {}
        for name in need_describe:
            cols, types = DuckDBManager._duck_describe_table(
                self, name, use_read)
            if not cols:
                # Fall back to information_schema names when DESCRIBE fails.
                cols = list(planned_cols.get(name) or
                            self.table_columns.get(name) or [])
            described[name] = (cols, types)

        def _apply():
            for name in live:
                self.table_sources.setdefault(name, "")
                if name in described:
                    cols, types = described[name]
                    vis = _visible_columns(cols)
                    self.table_columns[name] = vis
                    vis_set = set(vis)
                    cache[name] = {k: v for k, v in types.items()
                                   if k in vis_set}
                # else: unchanged shape + warm types — leave caches as-is
            for gone in [n for n in list(self.table_columns)
                         if n not in live_set]:
                self.table_columns.pop(gone, None)
                self.table_sources.pop(gone, None)
                cache.pop(gone, None)
                origins = getattr(self, "table_origins", None)
                if isinstance(origins, dict):
                    origins.pop(gone, None)

        if use_read:
            with self._catalog_lock:
                _apply()
        else:
            _apply()
