"""Result-row stores that keep large result sets off the Python heap.

``DiskBackedRows`` spills rows into a throwaway on-disk SQLite table
(one typed column per result column); only the requested slice is ever
resident, and ``sorted_view()`` pushes ORDER BY down to SQLite. This is
the same elegant, stdlib-only design used by the original SamQL.

``ArrowRows`` (optional, used only when pyarrow is installed for DuckDB
results) wraps a columnar Arrow table with lazy per-page materialization.

Both are list-like: ``len()``, integer/slice indexing, and iteration.
"""
import datetime as _dt
import os
import sqlite3
import threading
from contextlib import nullcontext

# Past this offset, a sorted/filtered page does the OFFSET scan index-only
# (rowids via the sort index) and then looks up just the page's full rows,
# instead of doing a full-row table lookup for every offset-skipped row.
# Measured ~3-4x faster on deep pages; shallow pages keep the simpler plan.
_DEFER_OFFSET = 5000


class SnapNotReady(Exception):
    """Deep sorted/filtered page requested before the Parquet snap landed.

    Session.page converts this into a short ``pending`` response so HTTP
    threads do not block for up to 120s waiting on background COPY.
    """


class _StoreSortedView:
    """A read-only, sorted projection over a DiskBackedRows store. The
    sort is executed by SQLite (ORDER BY c<ix>), so paging a sorted
    giant never drains+sorts the whole thing in Python."""

    def __init__(self, store, col_ix, descending):
        self._store = store
        self._col_ix = int(col_ix)
        self._desc = bool(descending)
        self._order = (f"ORDER BY c{self._col_ix} "
                       f"{'DESC' if descending else 'ASC'}, i")

    def __len__(self):
        return len(self._store)

    def __getitem__(self, item):
        return self._store._select(item, self._order)

    def __iter__(self):
        return self._store._stream(self._order)


def _to_number(v):
    """Coerce a filter value to a number, or None if it isn't numeric."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        s = str(v).strip()
        if not s:
            return None
        return float(s)
    except Exception:
        return None


class _StoreFilteredView:
    """A read-only filtered (and optionally sorted) projection over a
    DiskBackedRows store. The WHERE + ORDER BY run in SQLite, so filtering
    a giant result never drains it into Python."""

    def __init__(self, store, where, params, order, total=None):
        self._store = store
        self._where = where
        self._params = list(params)
        self._order = order
        self._total = None if total is None else int(total)

    def __len__(self):
        if self._total is not None:
            return self._total
        return self._store._count_where(self._where, self._params)

    def __getitem__(self, item):
        return self._store._select_where(
            item, self._where, self._params, self._order, total=self._total)

    def __iter__(self):
        return self._store._stream_where(
            self._where, self._params, self._order)


class DiskBackedRows:
    def __init__(self, block=2000):
        from . import tmputil
        self.path = tmputil.new_tempfile("rows_", ".db")
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        try:
            self._conn.execute("PRAGMA journal_mode=OFF")
            self._conn.execute("PRAGMA synchronous=OFF")
            self._conn.execute("PRAGMA cache_size=-16000")
        except Exception:
            pass
        self._lock = threading.RLock()
        self._block = max(100, int(block or 2000))
        self._buf = []
        self._n = 0
        self._ncols = None
        self._closed = False
        self._indexed = set()

    @staticmethod
    def _san(v):
        if isinstance(v, bool):
            return int(v)
        if v is None or isinstance(v, (int, float, str, bytes)):
            return v
        try:
            import decimal as _dec
            if isinstance(v, _dec.Decimal):
                try:
                    return float(v)
                except Exception:
                    return str(v)
        except Exception:
            pass
        if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
            try:
                return v.isoformat()
            except Exception:
                return str(v)
        try:
            return str(v)
        except Exception:
            return "<unrepresentable>"

    def _ensure_table(self, ncols):
        if self._ncols is not None:
            return
        self._ncols = max(1, int(ncols))
        cols = ", ".join(f"c{i}" for i in range(self._ncols))
        self._conn.execute(f"CREATE TABLE r (i INTEGER PRIMARY KEY, {cols})")
        self._ins = ("INSERT INTO r VALUES (?, "
                     + ", ".join("?" * self._ncols) + ")")

    def extend(self, rows):
        with self._lock:
            for r in rows:
                self._buf.append(tuple(r))
                if len(self._buf) >= self._block:
                    self._flush_locked()

    def _flush_locked(self):
        if not self._buf:
            return
        if self._ncols is None:
            self._ensure_table(len(self._buf[0]) or 1)
        nc = self._ncols
        payload = []
        i = self._n
        san = self._san
        for r in self._buf:
            vals = [san(v) for v in r[:nc]]
            if len(vals) < nc:
                vals.extend([None] * (nc - len(vals)))
            payload.append((i, *vals))
            i += 1
        self._conn.executemany(self._ins, payload)
        self._n = i
        self._buf = []

    def _flush(self):
        with self._lock:
            self._flush_locked()

    def __len__(self):
        with self._lock:
            return self._n + len(self._buf)

    def _select(self, item, order):
        self._flush()
        with self._lock:
            n = self._n
            if self._ncols is None:
                if isinstance(item, slice):
                    return []
                raise IndexError(item)
            cols = ", ".join(f"c{i}" for i in range(self._ncols))
            if isinstance(item, slice):
                idxs = range(*item.indices(n))
                if not len(idxs):
                    return []
                keyset = order.strip() == "ORDER BY i"
                if idxs.step == 1:
                    if keyset:
                        # `i` is a 0-based contiguous PRIMARY KEY == row
                        # position, so an index range scan replaces an
                        # O(n) OFFSET on deep pages.
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r "
                            f"WHERE i >= ? AND i < ? ORDER BY i",
                            (idxs.start, idxs.start + len(idxs)))
                    elif idxs.start >= _DEFER_OFFSET:
                        # Deep sorted page: page the rowids index-only (the
                        # sort index covers `i`), then fetch just this page's
                        # full rows. The order carries a deterministic `i`
                        # tiebreaker, so the row set matches the plain plan.
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r WHERE i IN "
                            f"(SELECT i FROM r {order} LIMIT ? OFFSET ?) "
                            f"{order}",
                            (len(idxs), idxs.start))
                    else:
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r {order} LIMIT ? OFFSET ?",
                            (len(idxs), idxs.start))
                    return [tuple(r) for r in cur.fetchall()]
                out = []
                for ix in idxs:
                    if keyset:
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r WHERE i = ?", (ix,))
                    else:
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r {order} LIMIT 1 OFFSET ?",
                            (ix,))
                    row = cur.fetchone()
                    if row is not None:
                        out.append(tuple(row))
                return out
            ix = int(item)
            if ix < 0:
                ix += n
            if ix < 0 or ix >= n:
                raise IndexError(item)
            if order.strip() == "ORDER BY i":
                cur = self._conn.execute(
                    f"SELECT {cols} FROM r WHERE i = ?", (ix,))
            else:
                cur = self._conn.execute(
                    f"SELECT {cols} FROM r {order} LIMIT 1 OFFSET ?", (ix,))
            row = cur.fetchone()
            if row is None:
                raise IndexError(item)
            return tuple(row)

    def __getitem__(self, item):
        return self._select(item, "ORDER BY i")

    def _stream(self, order, chunk=5000):
        """Single forward pass over the spilled rows. Uses a private
        read-only connection to the temp file so a long export streams in
        O(n) without OFFSET re-scans and without blocking concurrent
        paging on the main connection."""
        self._flush()
        with self._lock:
            try:
                self._conn.commit()
            except Exception:
                pass
            ncols = self._ncols
        if ncols is None:
            return
        cols = ", ".join(f"c{i}" for i in range(ncols))
        try:
            conn = sqlite3.connect(self.path, check_same_thread=False)
        except Exception:
            # fall back to chunked offset paging if a 2nd handle fails
            yield from self._iter_chunks(order, chunk)
            return
        try:
            cur = conn.execute(f"SELECT {cols} FROM r {order}")
            while True:
                rows = cur.fetchmany(chunk)
                if not rows:
                    return
                for r in rows:
                    yield tuple(r)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _iter_chunks(self, order, chunk=5000):
        self._flush()
        pos = 0
        while True:
            batch = self._select(slice(pos, pos + chunk), order)
            if not batch:
                return
            for r in batch:
                yield r
            pos += len(batch)

    def __iter__(self):
        return self._stream("ORDER BY i")

    def _agg_ctx(self):
        """Context for SQL-side chart/pivot aggregation over this store."""
        self._flush()

        def run(sql):
            cur = self._conn.execute(sql)
            try:
                return [tuple(r) for r in cur.fetchall()]
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
        return (run, "r", (lambda i: f"c{int(i)}"),
                (lambda e: f"CAST({e} AS REAL)"))

    def sorted_view(self, col_ix, descending=False):
        self._flush()
        ix = int(col_ix)
        # Index the sort column so paging a sorted result uses the index
        # instead of re-sorting the whole table on every page. Build it
        # once (deduped), and only when the table is big enough to matter.
        if ix not in self._indexed and self._n >= 20000:
            try:
                self._conn.execute(
                    f"CREATE INDEX IF NOT EXISTS ix_c{ix} ON r (c{ix})")
                self._indexed.add(ix)
            except Exception:
                pass
        return _StoreSortedView(self, col_ix, descending)

    # ---- filtering (engine-side WHERE) ------------------------------
    def _where(self, terms):
        """Build a SQL WHERE fragment + params from filter terms, each a
        tuple (col_ix, op, value). Unknown ops are skipped."""
        clauses = []
        params = []
        for ix, op, val in terms:
            c = f"c{int(ix)}"
            if op == "is_null":
                clauses.append(f"{c} IS NULL")
            elif op == "not_null":
                clauses.append(f"{c} IS NOT NULL")
            elif op in ("contains", "starts", "ends"):
                t = str(val if val is not None else "")
                pat = {"contains": f"%{t}%", "starts": f"{t}%",
                       "ends": f"%{t}"}[op]
                clauses.append(f"{c} LIKE ?")
                params.append(pat)
            elif op in ("gt", "gte", "lt", "lte"):
                sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
                num = _to_number(val)
                if num is not None:
                    clauses.append(f"CAST({c} AS REAL) {sym} ?")
                    params.append(num)
                else:
                    clauses.append(f"{c} {sym} ?")
                    params.append(str(val))
            elif op == "equals":
                num = _to_number(val)
                if num is not None:
                    clauses.append(f"CAST({c} AS REAL) = ?")
                    params.append(num)
                else:
                    clauses.append(f"{c} = ?")
                    params.append(str(val))
            elif op == "ne":
                num = _to_number(val)
                if num is not None:
                    clauses.append(f"({c} IS NULL OR CAST({c} AS REAL) <> ?)")
                    params.append(num)
                else:
                    clauses.append(f"({c} IS NULL OR {c} <> ?)")
                    params.append(str(val))
        return (" AND ".join(clauses) if clauses else ""), params

    def filtered_view(self, terms, sort_ix=None, descending=False, total=None):
        self._flush()
        if (sort_ix is not None and int(sort_ix) not in self._indexed
                and self._n >= 20000):
            try:
                self._conn.execute(
                    f"CREATE INDEX IF NOT EXISTS ix_c{int(sort_ix)} "
                    f"ON r (c{int(sort_ix)})")
                self._indexed.add(int(sort_ix))
            except Exception:
                pass
        order = ("ORDER BY i" if sort_ix is None
                 else f"ORDER BY c{int(sort_ix)} "
                      f"{'DESC' if descending else 'ASC'}, i")
        where, params = self._where(terms)
        return _StoreFilteredView(self, where, params, order, total=total)

    def count_view(self, terms):
        where, params = self._where(terms)
        return self._count_where(where, params)

    def _count_where(self, where, params):
        self._flush()
        with self._lock:
            if self._ncols is None:
                return 0
            if not where:
                return self._n
            cur = self._conn.execute(
                f"SELECT COUNT(*) FROM r WHERE {where}", params)
            return int(cur.fetchone()[0])

    def _select_where(self, item, where, params, order, total=None):
        self._flush()
        with self._lock:
            if self._ncols is None:
                if isinstance(item, slice):
                    return []
                raise IndexError(item)
            cols = ", ".join(f"c{i}" for i in range(self._ncols))
            wsql = (" WHERE " + where) if where else ""
            if isinstance(item, slice):
                n = (int(total) if total is not None
                     else self._count_where(where, params))
                idxs = range(*item.indices(n))
                if not len(idxs):
                    return []
                if idxs.step == 1:
                    if idxs.start >= _DEFER_OFFSET:
                        # Deep filtered page: index-only rowid OFFSET scan over
                        # the filtered set, then fetch just this page's rows.
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r WHERE i IN "
                            f"(SELECT i FROM r{wsql} {order} LIMIT ? OFFSET ?)"
                            f" {order}",
                            (*params, len(idxs), idxs.start))
                    else:
                        cur = self._conn.execute(
                            f"SELECT {cols} FROM r{wsql} {order} "
                            f"LIMIT ? OFFSET ?",
                            (*params, len(idxs), idxs.start))
                    return [tuple(r) for r in cur.fetchall()]
                out = []
                for ix in idxs:
                    cur = self._conn.execute(
                        f"SELECT {cols} FROM r{wsql} {order} LIMIT 1 OFFSET ?",
                        (*params, ix))
                    row = cur.fetchone()
                    if row is not None:
                        out.append(tuple(row))
                return out
            ix = int(item)
            if ix < 0:
                n = (int(total) if total is not None
                     else self._count_where(where, params))
                ix += n
            cur = self._conn.execute(
                f"SELECT {cols} FROM r{wsql} {order} LIMIT 1 OFFSET ?",
                (*params, ix))
            row = cur.fetchone()
            if row is None:
                raise IndexError(item)
            return tuple(row)

    def _stream_where(self, where, params, order, chunk=5000):
        self._flush()
        with self._lock:
            try:
                self._conn.commit()
            except Exception:
                pass
            ncols = self._ncols
        if ncols is None:
            return
        cols = ", ".join(f"c{i}" for i in range(ncols))
        wsql = (" WHERE " + where) if where else ""
        try:
            conn = sqlite3.connect(self.path, check_same_thread=False)
        except Exception:
            pos = 0
            while True:
                batch = self._select_where(
                    slice(pos, pos + chunk), where, params, order)
                if not batch:
                    return
                for r in batch:
                    yield r
                pos += len(batch)
            return
        try:
            cur = conn.execute(
                f"SELECT {cols} FROM r{wsql} {order}", params)
            while True:
                rows = cur.fetchmany(chunk)
                if not rows:
                    return
                for r in rows:
                    yield tuple(r)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._conn.close()
        except Exception:
            pass
        try:
            os.unlink(self.path)
        except Exception:
            pass



class _NativeOpsCursor:
    """Thin handle around a DuckDB cursor that unregisters on close.

    DuckDB's cursor ``.close`` cannot be reassigned; callers of
    ``ParquetResultStore._run`` always ``close()`` in ``finally``, so this
    keeps ``_native_ops`` accurate through execute + fetch.
    """

    __slots__ = ("_cur", "_unregister", "_closed")

    def __init__(self, cur, unregister):
        self._cur = cur
        self._unregister = unregister
        self._closed = False

    def fetchall(self):
        return self._cur.fetchall()

    def fetchone(self):
        return self._cur.fetchone()

    def fetchmany(self, size=None):
        if size is None:
            return self._cur.fetchmany()
        return self._cur.fetchmany(size)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._unregister()
        finally:
            try:
                self._cur.close()
            except Exception:
                pass

    def __getattr__(self, name):
        return getattr(self._cur, name)


class ParquetResultStore:
    """A query result materialized to a temporary Parquet file by DuckDB.

    Paging and sorting are served by DuckDB reading the Parquet directly
    (columnar, compressed, with projection + LIMIT pushdown), so a giant
    result never lands in Python memory or a row-oriented temp database.
    A hidden ``__rn`` column (written by the producer) gives a stable row
    order for unsorted paging and as a tiebreak when sorting.

    Reads use independent cursors (no shared lock), so a long export or
    scroll never blocks other queries. List-like: ``len()``,
    integer/slice indexing, and iteration.
    """

    def __init__(self, engine, path, cols, owns_path=True):
        # owns_path=False marks a BORROWED file (the .399 zero-copy result
        # serves the table's SOURCE cache parquet directly): close() must
        # never unlink it, or evicting/releasing the result deletes the
        # loaded table's backing ("No files found that match the pattern").
        self._owns_path = bool(owns_path)
        self._engine = engine
        self._path = path
        self._fwd = path.replace("\\", "/").replace("'", "''")
        self._cols = list(cols)            # display columns (excludes __rn)
        self._n = None
        self._closed = False
        # Materialized sort/filter snapshots (path -> ParquetResultStore).
        # First sorted/filtered page is served via TopN; a background COPY
        # builds the snapshot so later pages use file_row_number ranges.
        self._snap_cache = {}
        # In-flight deferred views keyed like _snap_cache (singleflight).
        self._pending_snaps = {}

    def parquet_path(self):
        """The backing parquet file -- exports and save-as-table copy
        straight from it engine-side (.472) instead of round-tripping
        every row through Python."""
        return None if self._closed else self._path

    def _src(self):
        # The stable "__rn" paging/tiebreak column is synthesized at READ time
        # from parquet's file_row_number (1-based to match the old
        # row_number() contract), so the producer's COPY never pays a global
        # window over the whole result. Every consumer keeps ordering /
        # filtering by "__rn" unchanged.
        return (f"(SELECT * EXCLUDE (file_row_number), "
                f'file_row_number + 1 AS "__rn" '
                f"FROM read_parquet('{self._fwd}', file_row_number = true))")

    def _collist(self):
        return ", ".join('"' + str(c).replace('"', '""') + '"'
                         for c in self._cols)

    def _run(self, sql, params=None):
        """Execute SQL on a private DuckDB cursor that Stop can interrupt.

        A bare ``conn.cursor()`` is its own connection — ``DuckDBManager.interrupt``
        only reaches the main connection plus ``_native_ops``. Register here
        (same posture as ``execute_read``) so pivot/chart/page/export cancel
        mid-statement. Unregister when the caller closes the returned handle
        (DuckDB cursor ``.close`` is read-only, so we wrap).
        """
        eng = self._engine
        cur = eng.conn.cursor()
        tid = threading.get_ident()
        ops = getattr(eng, "_native_ops", None)
        lk = getattr(eng, "_native_ops_lock", None)
        registered = False
        if ops is not None:
            try:
                if lk is not None:
                    with lk:
                        ops[tid] = cur
                else:
                    ops[tid] = cur
                registered = True
            except Exception:
                registered = False

        def _unregister():
            if not registered:
                return
            try:
                if lk is not None:
                    with lk:
                        if ops.get(tid) is cur:
                            ops.pop(tid, None)
                elif ops.get(tid) is cur:
                    ops.pop(tid, None)
            except Exception:
                pass

        try:
            try:
                from .engines import _BeatScope
                scope = _BeatScope(eng, cur)
            except Exception:
                scope = nullcontext()
            with scope:
                if params:
                    cur.execute(sql, list(params))
                else:
                    cur.execute(sql)
        except Exception:
            _unregister()
            try:
                cur.close()
            except Exception:
                pass
            raise
        if not registered:
            return cur
        return _NativeOpsCursor(cur, _unregister)

    def __len__(self):
        if self._n is None:
            cur = self._run(f"SELECT count(*) FROM {self._src()}")
            try:
                row = cur.fetchone()
                self._n = int(row[0]) if row else 0
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
        return self._n

    _STABLE_ORDER = 'ORDER BY "__rn"'

    def _fetch(self, order, limit, offset, where="", params=None):
        w = ("WHERE %s " % where) if where else ""
        if order == self._STABLE_ORDER and not where:
            # FAST PATH (stall fix, on-box 2026-07-02): "__rn" is a
            # synthesized expression, so ORDER BY it defeats pruning and a
            # 200-row page ran a TopN across EVERY row group of a giant
            # nested file -- minutes of native scan the interrupt can miss.
            # file_row_number itself is prunable: a range predicate skips
            # whole row groups, so an unsorted page reads only the group(s)
            # it lands in. Same rows, same order, tiny read.
            sql = (f"SELECT {self._collist()} "
                   f"FROM read_parquet('{self._fwd}', "
                   f"file_row_number = true) "
                   f"WHERE file_row_number >= {int(offset)} "
                   f"AND file_row_number < {int(offset) + int(limit)} "
                   f"ORDER BY file_row_number")
            params = None
        else:
            # a USER sort (and/or filter) is a genuine TopN over the data
            sql = (f"SELECT {self._collist()} FROM {self._src()} "
                   f"{w}{order} LIMIT {int(limit)} OFFSET {int(offset)}")
        cur = self._run(sql, params)
        try:
            rows = [tuple(r) for r in cur.fetchall()]
        finally:
            try:
                cur.close()
            except Exception:
                pass
        # Nested / JSON Parquet caches have occasionally returned COUNT>0 but
        # an empty file_row_number window. Fall back to LIMIT/OFFSET through
        # the synthesized __rn source so the grid never shows a blank page
        # for a non-empty result.
        if (not rows and limit > 0 and order == self._STABLE_ORDER
                and not where and offset < len(self)):
            sql = (f"SELECT {self._collist()} FROM {self._src()} "
                   f"{order} LIMIT {int(limit)} OFFSET {int(offset)}")
            cur = self._run(sql)
            try:
                rows = [tuple(r) for r in cur.fetchall()]
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
        return rows

    def _stream(self, order, chunk=5000):
        if order == self._STABLE_ORDER:
            # exports in file order: order by the RAW prunable column, not
            # the synthesized alias, so no global sort is planned
            sql = (f"SELECT {self._collist()} "
                   f"FROM read_parquet('{self._fwd}', "
                   f"file_row_number = true) "
                   f"ORDER BY file_row_number")
        else:
            sql = f"SELECT {self._collist()} FROM {self._src()} {order}"
        cur = self._run(sql)
        try:
            while True:
                rows = cur.fetchmany(chunk)
                if not rows:
                    return
                for r in rows:
                    yield tuple(r)
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def _slice(self, item, order):
        n = len(self)
        if isinstance(item, slice):
            start, stop, step = item.indices(n)
            if start >= stop:
                return []
            if (step or 1) == 1:
                return self._fetch(order, stop - start, start)
            return [r for j, r in enumerate(self._stream(order))
                    if start <= j < stop and (j - start) % step == 0]
        ix = int(item)
        if ix < 0:
            ix += n
        if ix < 0 or ix >= n:
            raise IndexError(item)
        rows = self._fetch(order, 1, ix)
        if not rows:
            raise IndexError(item)
        return rows[0]

    def __getitem__(self, item):
        return self._slice(item, 'ORDER BY "__rn"')

    def __iter__(self):
        return self._stream('ORDER BY "__rn"')

    def _agg_ctx(self):
        """Context for SQL-side chart/pivot aggregation over this Parquet
        result, served by DuckDB reading the file directly."""
        def run(sql):
            cur = self._run(sql)
            try:
                return [tuple(r) for r in cur.fetchall()]
            finally:
                try:
                    cur.close()
                except Exception:
                    pass

        def colref(i):
            c = str(self._cols[int(i)]).replace('"', '""')
            return f'"{c}"'
        return (run, self._src(), colref,
                (lambda e: f"TRY_CAST({e} AS DOUBLE)"))

    def _qcol(self, ix):
        return '"' + str(self._cols[int(ix)]).replace('"', '""') + '"'

    def _where(self, terms):
        """Build a DuckDB WHERE fragment + params from filter terms, each a
        tuple (col_ix, op, value). Mirrors the SQLite DiskBackedRows logic
        with DuckDB-safe casts (TRY_CAST -> NULL on non-numeric)."""
        clauses, params = [], []
        for ix, op, val in terms:
            c = self._qcol(ix)
            if op == "is_null":
                clauses.append(f"{c} IS NULL")
            elif op == "not_null":
                clauses.append(f"{c} IS NOT NULL")
            elif op in ("contains", "starts", "ends"):
                t = str(val if val is not None else "")
                pat = {"contains": f"%{t}%", "starts": f"{t}%",
                       "ends": f"%{t}"}[op]
                clauses.append(f"CAST({c} AS VARCHAR) LIKE ?")
                params.append(pat)
            elif op in ("gt", "gte", "lt", "lte"):
                sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
                num = _to_number(val)
                if num is not None:
                    clauses.append(f"TRY_CAST({c} AS DOUBLE) {sym} ?")
                    params.append(num)
                else:
                    clauses.append(f"CAST({c} AS VARCHAR) {sym} ?")
                    params.append(str(val))
            elif op == "equals":
                num = _to_number(val)
                if num is not None:
                    clauses.append(f"TRY_CAST({c} AS DOUBLE) = ?")
                    params.append(num)
                else:
                    clauses.append(f"CAST({c} AS VARCHAR) = ?")
                    params.append(str(val))
            elif op == "ne":
                num = _to_number(val)
                if num is not None:
                    clauses.append(
                        f"({c} IS NULL OR TRY_CAST({c} AS DOUBLE) <> ?)")
                    params.append(num)
                else:
                    clauses.append(
                        f"({c} IS NULL OR CAST({c} AS VARCHAR) <> ?)")
                    params.append(str(val))
        return (" AND ".join(clauses) if clauses else ""), params

    def _count_where(self, where, params):
        w = f"WHERE {where} " if where else ""
        cur = self._run(f"SELECT count(*) FROM {self._src()} {w}", params)
        try:
            row = cur.fetchone()
            return int(row[0]) if row else 0
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def _materialize_snapshot(self, order, where="", params=None):
        """COPY a sorted/filtered projection to a temp Parquet once.

        File order matches ``order``, so subsequent paging uses the fast
        ``file_row_number`` range path instead of repeating TopN/OFFSET.
        """
        from . import tmputil
        from .engines import _ExecKeepalive
        import threading
        path = tmputil.new_tempfile("qv_", ".parquet")
        try:
            os.unlink(path)
        except Exception:
            pass
        fwd = path.replace("\\", "/").replace("'", "''")
        w = ("WHERE %s " % where) if where else ""
        sql = ("COPY (SELECT %s FROM %s %s%s) TO '%s' (FORMAT PARQUET)"
               % (self._collist(), self._src(), w, order, fwd))
        eng = self._engine
        cancel = getattr(eng, "_cancel", None)
        # Prefer a private cursor so SET + COPY do not hold write_lock and
        # stall loads/DDL. Fall back to the locked main connection.
        # Register in _native_ops so cancel_query interrupts THIS cursor
        # (keepalive alone only helps after eng._cancel is set).
        own_cur = None
        exec_conn = eng.conn
        lock = getattr(eng, "write_lock", None)
        tid = threading.get_ident()
        ops = getattr(eng, "_native_ops", None)
        ops_lk = getattr(eng, "_native_ops_lock", None)
        registered = False
        if getattr(eng, "concurrent_reads", True):
            try:
                own_cur = eng.conn.cursor()
                exec_conn = own_cur
                lock = None
                if ops is not None:
                    if ops_lk is not None:
                        with ops_lk:
                            ops[tid] = own_cur
                    else:
                        ops[tid] = own_cur
                    registered = True
            except Exception:
                own_cur = None
                exec_conn = eng.conn
                lock = getattr(eng, "write_lock", None)
                registered = False
        ctx = lock if lock is not None else nullcontext()
        try:
            with ctx:
                try:
                    exec_conn.execute("SET preserve_insertion_order = true")
                except Exception:
                    pass
                try:
                    with _ExecKeepalive(exec_conn, cancel, tid,
                                        interval=0.25):
                        if params:
                            exec_conn.execute(sql, list(params))
                        else:
                            exec_conn.execute(sql)
                finally:
                    try:
                        exec_conn.execute(
                            "SET preserve_insertion_order = false")
                    except Exception:
                        pass
        finally:
            if registered and ops is not None:
                try:
                    if ops_lk is not None:
                        with ops_lk:
                            if ops.get(tid) is own_cur:
                                ops.pop(tid, None)
                    elif ops.get(tid) is own_cur:
                        ops.pop(tid, None)
                except Exception:
                    pass
            if own_cur is not None:
                try:
                    own_cur.close()
                except Exception:
                    pass
        snap = ParquetResultStore(eng, path, self._cols, owns_path=True)
        try:
            snap._n = len(snap)
        except Exception:
            pass
        return snap

    def _deferred_snap_view(self, key, order, *, where="", params=None,
                            total=None):
        """Return a view that serves TopN pages until a snap is ready."""
        hit = self._snap_cache.get(key)
        if hit is not None and not getattr(hit, "_closed", False):
            return hit
        pending = getattr(self, "_pending_snaps", None)
        if pending is None:
            self._pending_snaps = pending = {}
        view = pending.get(key)
        if view is not None and not getattr(view, "_closed", False):
            return view
        view = _LazySnapView(
            self, key, order, where=where, params=params, total=total)
        pending[key] = view
        return view

    def sorted_view(self, col_ix, descending=False):
        col = str(self._cols[col_ix]).replace('"', '""')
        order = (f'ORDER BY "{col}" {"DESC" if descending else "ASC"}, '
                 f'"__rn"')
        key = ("sort", int(col_ix), bool(descending))
        return self._deferred_snap_view(key, order, total=len(self))

    def filtered_view(self, terms, sort_ix=None, descending=False, total=None):
        if sort_ix is None:
            order = 'ORDER BY "__rn"'
        else:
            col = str(self._cols[int(sort_ix)]).replace('"', '""')
            order = (f'ORDER BY "{col}" {"DESC" if descending else "ASC"}, '
                     f'"__rn"')
        where, params = self._where(terms)
        key = ("filt", where, tuple(params), order)
        hit = self._snap_cache.get(key)
        if hit is not None and not getattr(hit, "_closed", False):
            return hit
        # Empty filter → just sorted snapshot (or self for stable order).
        if not where and order == 'ORDER BY "__rn"':
            return self
        # Prefer caller-supplied total (CachedResult already counted once).
        if total is None:
            total = self._count_where(where, params) if where else len(self)
        return self._deferred_snap_view(
            key, order, where=where, params=params, total=total)

    def count_view(self, terms):
        where, params = self._where(terms)
        return self._count_where(where, params)

    def close(self):
        if self._closed:
            return
        self._closed = True
        for snap in list(getattr(self, "_snap_cache", {}).values()):
            try:
                snap.close()
            except Exception:
                pass
        self._snap_cache = {}
        for view in list(getattr(self, "_pending_snaps", {}).values()):
            try:
                view._closed = True
            except Exception:
                pass
        self._pending_snaps = {}
        if not getattr(self, "_owns_path", True):
            return   # borrowed source file: never ours to delete
        try:
            os.unlink(self._path)
        except Exception:
            pass


class _LazySnapView:
    """Serve first sort/filter pages via TopN; build Parquet snap in background.

    Exact ``len()`` / ``total_rows`` stay exact. Later pages use the snap's
    ``file_row_number`` ranges once COPY finishes. Sticky cancel still
    interrupts the COPY via the engine cancel flag.

    Deep pages (offset past ``_PRE_SNAP_DEEP_OFFSET``) wait for the snap
    instead of paying a huge TopN+OFFSET over the full file.
    """

    # Shallow first-page window: TopN is fine. Past this, await the snap.
    _PRE_SNAP_DEEP_OFFSET = 200

    def __init__(self, store, key, order, *, where="", params=None, total=None):
        import threading
        self._store = store
        self._key = key
        self._order = order
        self._where = where or ""
        self._params = list(params) if params else None
        self._total = total
        self._snap = None
        self._closed = False
        self._lock = threading.Lock()
        self._started = False
        self._ready = threading.Event()

    def __len__(self):
        if self._snap is not None and not getattr(self._snap, "_closed", False):
            return len(self._snap)
        if self._total is not None:
            return int(self._total)
        return len(self._store)

    def _kickoff(self):
        import threading
        if self._started or self._closed:
            return
        with self._lock:
            if self._started or self._closed:
                return
            self._started = True
            # A prior failed build left _ready set; clear so awaiters wait for
            # this generation instead of returning immediately.
            self._ready.clear()

        def _build():
            try:
                if self._closed or getattr(self._store, "_closed", False):
                    return
                snap = self._store._materialize_snapshot(
                    self._order, where=self._where, params=self._params)
                if self._closed or getattr(self._store, "_closed", False):
                    try:
                        snap.close()
                    except Exception:
                        pass
                    return
                with self._lock:
                    self._snap = snap
                    cache = getattr(self._store, "_snap_cache", None)
                    if cache is not None:
                        cache[self._key] = snap
                    pending = getattr(self._store, "_pending_snaps", None)
                    if isinstance(pending, dict):
                        pending.pop(self._key, None)
            except Exception:
                with self._lock:
                    self._started = False
                pending = getattr(self._store, "_pending_snaps", None)
                if isinstance(pending, dict):
                    pending.pop(self._key, None)
            finally:
                self._ready.set()

        threading.Thread(target=_build, daemon=True, name="samql-qv-snap").start()

    def _await_snap(self, timeout=120.0):
        """Wait for background COPY; used for deep pages to avoid OFFSET TopN."""
        import time
        snap = self._snap
        if snap is not None and not getattr(snap, "_closed", False):
            return snap
        self._kickoff()
        # If kickoff could not start (closed), nothing to wait for.
        if self._closed:
            return None
        self._ready.wait(timeout=max(0.05, float(timeout)))
        snap = self._snap
        if snap is not None and not getattr(snap, "_closed", False):
            return snap
        return None

    def _slice(self, item):
        snap = self._snap
        if snap is not None and not getattr(snap, "_closed", False):
            return snap[item]
        n = len(self)
        if isinstance(item, slice):
            start, stop, step = item.indices(n)
            if start >= stop:
                self._kickoff()
                return []
            deep = start >= self._PRE_SNAP_DEEP_OFFSET
            if deep:
                # Brief wait only — do not park the HTTP worker for minutes.
                snap = self._await_snap(timeout=0.4)
                if snap is not None:
                    return snap[item]
                raise SnapNotReady(
                    "sorted/filtered snapshot still building")
            if (step or 1) != 1:
                self._kickoff()
                rows = []
                for j in range(start, stop, step):
                    chunk = self._store._fetch(
                        self._order, 1, j,
                        where=self._where, params=self._params)
                    if chunk:
                        rows.append(chunk[0])
                return rows
            rows = self._store._fetch(
                self._order, stop - start, start,
                where=self._where, params=self._params)
            self._kickoff()
            return rows
        ix = int(item)
        if ix < 0:
            ix += n
        if ix < 0 or ix >= n:
            raise IndexError(item)
        if ix >= self._PRE_SNAP_DEEP_OFFSET:
            snap = self._await_snap(timeout=0.4)
            if snap is not None:
                return snap[ix]
            raise SnapNotReady(
                "sorted/filtered snapshot still building")
        rows = self._store._fetch(
            self._order, 1, ix, where=self._where, params=self._params)
        self._kickoff()
        if not rows:
            raise IndexError(item)
        return rows[0]

    def __getitem__(self, item):
        return self._slice(item)

    def __iter__(self):
        snap = self._snap
        if snap is not None and not getattr(snap, "_closed", False):
            yield from snap
            return
        # Prefer snap when it lands quickly; else stream ordered rows.
        self._kickoff()
        snap = self._await_snap(timeout=2.0)
        if snap is not None:
            yield from snap
            return
        where = self._where
        params = self._params
        order = self._order
        store = self._store
        w = ("WHERE %s " % where) if where else ""
        sql = f"SELECT {store._collist()} FROM {store._src()} {w}{order}"
        cur = store._run(sql, params)
        try:
            while True:
                rows = cur.fetchmany(5000)
                if not rows:
                    return
                for r in rows:
                    yield tuple(r)
        finally:
            try:
                cur.close()
            except Exception:
                pass


class _ParquetSortedView:
    def __init__(self, store, order):
        self._store = store
        self._order = order

    def __len__(self):
        return len(self._store)

    def __getitem__(self, item):
        return self._store._slice(item, self._order)

    def __iter__(self):
        return self._store._stream(self._order)


class _ParquetFilteredView:
    """Legacy filtered view stub (unused after deferred snap path)."""

    def __init__(self, store, where, params, order):
        self._store = store
        self._where = where
        self._params = list(params)
        self._order = order

    def __len__(self):
        return self._store._count_where(self._where, self._params)

    def __getitem__(self, item):
        raise NotImplementedError("use ParquetResultStore.filtered_view")

    def __iter__(self):
        raise NotImplementedError("use ParquetResultStore.filtered_view")


def spill_rows(cur, threshold=200000, batch=10000):
    """Fetch all remaining rows from a cursor: a plain list for ordinary
    sizes, spilling into a DiskBackedRows store past `threshold` so huge
    fetches never fully materialize as Python objects."""
    out = []
    store = None
    while True:
        chunk = cur.fetchmany(batch)
        if not chunk:
            break
        chunk = [tuple(r) for r in chunk]
        if store is not None:
            store.extend(chunk)
            continue
        out.extend(chunk)
        if len(out) >= threshold:
            store = DiskBackedRows(block=batch)
            store.extend(out)
            out = []
    return store if store is not None else out


# ---------------------------------------------------------------------------
# SQL-side aggregation primitives for charts and pivots.
#
# Charting or pivoting a large result used to pull every row through Python
# and aggregate in a loop -- tens of seconds and unbounded memory for a
# multi-million-row result. These helpers push the GROUP BY / binning into
# whatever engine backs the store (SQLite for a spilled DiskBackedRows,
# DuckDB for a Parquet result, or the source table's own engine), so only
# the small aggregated output crosses back into Python.
#
# A "context" is a 4-tuple (run, src, colref, castnum):
#   run(sql)   -> list[tuple]      execute and return rows
#   src        -> str             FROM source (a table name or read_parquet)
#   colref(i)  -> str             SQL reference for column index i
#   castnum(e) -> str             wrap expression e as a numeric cast
# ---------------------------------------------------------------------------

def _num_lit(x):
    # round-trippable numeric literal for embedding in SQL
    return repr(float(x))


def agg_group_multi(ctx, dim_ixs, value_ix, agg, cap=100000):
    """GROUP BY the given dimension columns, aggregating one value column.
    Returns rows of (dim values..., aggregated_value)."""
    run, src, colref, castnum = ctx
    dimsel = ", ".join(colref(i) for i in dim_ixs)
    if agg == "count":
        expr = ("count(*)" if value_ix is None
                else f"count({castnum(colref(value_ix))})")
    elif value_ix is None:
        expr = "count(*)"
    else:
        fn = {"sum": "sum", "avg": "avg", "min": "min",
              "max": "max"}.get(agg, "sum")
        expr = f"{fn}({castnum(colref(value_ix))})"
    sql = f"SELECT {dimsel}, {expr} FROM {src} GROUP BY {dimsel}"
    if cap:
        sql += f" LIMIT {int(cap)}"
    return run(sql)


def agg_minmax(ctx, value_ix):
    """Return (lo, hi) over the numeric values of a column, or (None, None)."""
    run, src, colref, castnum = ctx
    v = castnum(colref(value_ix))
    rows = run(f"SELECT min({v}), max({v}) FROM {src} WHERE {v} IS NOT NULL")
    if not rows or rows[0][0] is None:
        return (None, None)
    return (float(rows[0][0]), float(rows[0][1]))


def agg_histogram(ctx, value_ix, lo, hi, nbins):
    """Return a list of nbins counts binning the column over [lo, hi]."""
    run, src, colref, castnum = ctx
    v = castnum(colref(value_ix))
    width = (hi - lo) / nbins
    binexpr = (
        f"CASE WHEN {v} >= {_num_lit(hi)} THEN {nbins - 1} "
        f"WHEN {v} <= {_num_lit(lo)} THEN 0 "
        f"ELSE CAST(({v} - {_num_lit(lo)}) / {_num_lit(width)} AS INTEGER) "
        f"END")
    rows = run(f"SELECT {binexpr} AS b, count(*) FROM {src} "
               f"WHERE {v} IS NOT NULL GROUP BY b")
    counts = [0] * nbins
    for b, c in rows:
        try:
            bi = int(b)
        except (TypeError, ValueError):
            continue
        if 0 <= bi < nbins:
            counts[bi] = int(c)
    return counts


def agg_xy(ctx, xi, yi, cap=5000):
    """Return up to cap (x, y) numeric pairs with both values non-null."""
    run, src, colref, castnum = ctx
    xs, ys = castnum(colref(xi)), castnum(colref(yi))
    rows = run(f"SELECT {xs}, {ys} FROM {src} "
               f"WHERE {xs} IS NOT NULL AND {ys} IS NOT NULL "
               f"LIMIT {int(cap)}")
    out = []
    for a, b in rows:
        try:
            out.append((float(a), float(b)))
        except (TypeError, ValueError):
            pass
    return out
