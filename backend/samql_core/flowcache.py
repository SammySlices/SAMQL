"""Thread-safe byte-budgeted LRU for materialised NodeFlow tables.

The cache owns only registry/accounting state.  The session remains responsible
for estimating a table's size and for physically dropping an evicted table via
the callback supplied here.  Engine work is always performed after releasing
the registry lock, avoiding a cache-lock -> engine-lock inversion.
"""
from collections import OrderedDict
import threading


class FlowCache:
    """Content-addressed LRU with independent entry and byte limits."""

    def __init__(self, max_entries=32, max_bytes=0, drop_entry=None):
        self.max_entries = max(0, int(max_entries or 0))
        self.max_bytes = max(0, int(max_bytes or 0))
        self.drop_entry = drop_entry
        # fingerprint -> (table_name, engine_target, approximate_bytes)
        self.entries = OrderedDict()
        self.bytes_used = 0
        self.stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
            "oversized": 0,
            "stale": 0,
        }
        self.lock = threading.Lock()

    def configure(self, max_entries=None, max_bytes=None):
        """Update limits and immediately trim the existing LRU.

        Engine tables are dropped only after the registry lock is released,
        preserving the cache-lock -> engine-lock ordering guarantee.
        """
        victims = []
        with self.lock:
            if max_entries is not None:
                self.max_entries = max(0, int(max_entries or 0))
            if max_bytes is not None:
                self.max_bytes = max(0, int(max_bytes or 0))
            victims = self._trim_locked()
        for target, table in victims:
            self._drop(target, table)
        return len(victims)

    def _trim_locked(self):
        victims = []
        while self.entries and (
                (self.max_entries and len(self.entries) > self.max_entries) or
                (self.max_bytes and self.bytes_used > self.max_bytes)):
            _fp, (old_table, old_target, old_bytes) = \
                self.entries.popitem(last=False)
            self.bytes_used = max(0, self.bytes_used - int(old_bytes or 0))
            self.stats["evictions"] += 1
            victims.append((old_target, old_table))
        return victims

    def get(self, fingerprint):
        with self.lock:
            ent = self.entries.get(fingerprint)
            if ent is None:
                return None
            self.entries.move_to_end(fingerprint)
            return ent[0]

    def record_hit(self):
        with self.lock:
            self.stats["hits"] += 1

    def record_miss(self):
        with self.lock:
            self.stats["misses"] += 1

    def discard(self, fingerprint, *, drop=False, stale=False):
        """Remove one registry entry, optionally dropping its backing table."""
        victim = None
        with self.lock:
            ent = self.entries.pop(fingerprint, None)
            if ent is not None:
                self.bytes_used = max(0, self.bytes_used - int(ent[2] or 0))
                victim = (ent[1], ent[0])
                if stale:
                    self.stats["stale"] += 1
        if drop and victim is not None:
            self._drop(*victim)
        return ent is not None

    def put(self, fingerprint, table, engine_target, approximate_bytes):
        """Insert an entry and evict old entries.

        Returns ``False`` when the new table alone is larger than the byte
        budget.  Crucially, that table is *not* dropped here: the caller is
        actively using it and must treat it as an ordinary per-run temporary.
        The former insert-then-evict behaviour could evict the just-created
        table and hand a dead relation back to the running flow.
        """
        approximate_bytes = max(0, int(approximate_bytes or 0))
        victims = []
        accepted = True
        with self.lock:
            old = self.entries.pop(fingerprint, None)
            if old is not None:
                self.bytes_used = max(
                    0, self.bytes_used - int(old[2] or 0))
                # A content-addressed replacement normally points at the same
                # deterministic table. If a caller replaces it with a
                # different backing table, reclaim the superseded one after
                # releasing the registry lock.
                if (old[0], old[1]) != (table, engine_target):
                    victims.append((old[1], old[0]))

            if self.max_bytes and approximate_bytes > self.max_bytes:
                self.stats["oversized"] += 1
                accepted = False
            else:
                self.entries[fingerprint] = (
                    table, engine_target, approximate_bytes)
                self.bytes_used += approximate_bytes
                self.entries.move_to_end(fingerprint)

                # Never drops an oversized just-created table: oversized
                # entries are rejected before insertion. Ordinary limit
                # changes evict oldest-first.
                victims.extend(self._trim_locked())

        for target, old_table in victims:
            self._drop(target, old_table)
        return accepted

    def clear(self, reset_stats=False):
        victims = []
        with self.lock:
            victims = [(target, table)
                       for table, target, _size in self.entries.values()]
            self.entries.clear()
            self.bytes_used = 0
            if reset_stats:
                for key in self.stats:
                    self.stats[key] = 0
        for target, table in victims:
            self._drop(target, table)
        return len(victims)

    def info(self):
        with self.lock:
            used = int(self.bytes_used)
            stats = dict(self.stats)
            largest = sorted(
                ((fp, table, target, int(size or 0))
                 for fp, (table, target, size) in self.entries.items()),
                key=lambda x: x[3], reverse=True)[:8]
            lookups = stats.get("hits", 0) + stats.get("misses", 0)
            return {
                "size": len(self.entries),
                "max": self.max_entries,
                "bytes": used,
                "bytes_max": self.max_bytes,
                "mb": round(used / (1024 * 1024), 2),
                "mb_max": round(self.max_bytes / (1024 * 1024), 2),
                "hit_rate": (round(stats.get("hits", 0) / lookups, 4)
                             if lookups else None),
                "largest": [
                    {"fingerprint": fp[:12], "table": table,
                     "engine": target, "bytes": size,
                     "mb": round(size / (1024 * 1024), 2)}
                    for fp, table, target, size in largest
                ],
                **stats,
            }

    def _drop(self, engine_target, table):
        if self.drop_entry is None:
            return
        try:
            self.drop_entry(engine_target, table)
        except Exception:
            # Eviction is best-effort cleanup; a missing/recycled engine table
            # is equivalent to it already having been removed.
            pass


class PersistentFlowCache:
    """Disk-backed, restart-safe cache for deterministic DuckDB relations.

    Each content fingerprint maps to one Parquet file.  The fingerprint already
    includes the resolved graph, required projection, engine, cache format and
    stable source signatures, so no mutable manifest is required.  File mtime is
    the LRU clock; publication is atomic (temporary file + replace).
    """

    FORMAT_VERSION = 1

    def __init__(self, directory, max_bytes=0, max_age_days=14):
        from pathlib import Path
        self.directory = Path(directory)
        self.max_bytes = max(0, int(max_bytes or 0))
        self.max_age_days = max(0, int(max_age_days or 0))
        self.lock = threading.RLock()
        self.stats = {"hits": 0, "misses": 0, "writes": 0,
                      "evictions": 0, "oversized": 0, "skips": 0,
                      "errors": 0}
        # path -> active-reader refcount. Restore pins a parquet while DuckDB
        # opens/copies it so a concurrent budget trim or Clear cannot unlink it
        # mid-read (especially important on Windows and parallel Run all).
        self._pins = {}
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                self.directory.chmod(0o700)
            except Exception:
                pass
        except Exception:
            pass
        self.prune()

    def record_skip(self):
        """Count a graph deliberately excluded from persistent reuse."""
        with self.lock:
            self.stats["skips"] += 1

    def configure(self, max_bytes=None, max_age_days=None):
        with self.lock:
            if max_bytes is not None:
                self.max_bytes = max(0, int(max_bytes or 0))
            if max_age_days is not None:
                self.max_age_days = max(0, int(max_age_days or 0))
        return self.prune()

    def _path(self, fingerprint):
        safe = "".join(ch for ch in str(fingerprint) if ch.isalnum())[:64]
        return self.directory / ("nf_%s_v%d.parquet" %
                                 (safe, self.FORMAT_VERSION))

    def _valid_locked(self, fingerprint):
        import time
        p = self._path(fingerprint)
        try:
            if not p.is_file() or p.stat().st_size <= 0:
                return None
            if self.max_age_days:
                age = time.time() - p.stat().st_mtime
                if age > self.max_age_days * 86400:
                    if not self._pins.get(str(p)):
                        try:
                            p.unlink()
                        except Exception:
                            pass
                        self.stats["evictions"] += 1
                    return None
            return p
        except Exception:
            self.stats["errors"] += 1
            return None

    def get(self, fingerprint):
        """Return a cache path for a short, immediate lookup.

        Restore code should use :meth:`acquire`/:meth:`release` so trimming
        cannot delete the file while DuckDB is reading it.
        """
        import os
        with self.lock:
            p = self._valid_locked(fingerprint)
            if p is None:
                self.stats["misses"] += 1
                return None
            try:
                os.utime(p, None)
            except Exception:
                pass
            self.stats["hits"] += 1
            return str(p)

    def acquire(self, fingerprint):
        """Pin and return a valid cache file until ``release`` is called."""
        import os
        with self.lock:
            p = self._valid_locked(fingerprint)
            if p is None:
                self.stats["misses"] += 1
                return None
            sp = str(p)
            self._pins[sp] = self._pins.get(sp, 0) + 1
            try:
                os.utime(p, None)
            except Exception:
                pass
            self.stats["hits"] += 1
            return sp

    def release(self, path):
        if not path:
            return
        with self.lock:
            n = int(self._pins.get(str(path), 0))
            if n <= 1:
                self._pins.pop(str(path), None)
            else:
                self._pins[str(path)] = n - 1

    def discard(self, fingerprint):
        """Delete one invalid entry unless an active restore currently pins it."""
        p = self._path(fingerprint)
        with self.lock:
            if self._pins.get(str(p)):
                return False
            try:
                p.unlink()
                self.stats["evictions"] += 1
                return True
            except FileNotFoundError:
                return False
            except Exception:
                self.stats["errors"] += 1
                return False

    def publish(self, fingerprint, writer):
        """Atomically publish ``writer(tmp_path)`` without serialising COPYs.

        The potentially long engine COPY happens outside the registry lock, so
        independent NodeFlow branches can materialise and persist concurrently.
        Only validation/replace/accounting is locked. A positive byte ceiling
        rejects an individually oversized entry before it can become visible.
        """
        import os
        import secrets
        p = self._path(fingerprint)
        tmp = p.with_name(p.name + ".%s.tmp" % secrets.token_hex(4))
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            writer(str(tmp))
            if not tmp.is_file() or tmp.stat().st_size <= 0:
                raise RuntimeError("persistent cache writer produced no data")
            size = int(tmp.stat().st_size)
            with self.lock:
                if self.max_bytes and size > self.max_bytes:
                    self.stats["oversized"] += 1
                    try:
                        tmp.unlink()
                    except Exception:
                        pass
                    return False
                # Another worker may have published the identical content while
                # this writer was running. Keep the first valid atomic result.
                try:
                    if p.is_file() and p.stat().st_size > 0:
                        try:
                            tmp.unlink()
                        except Exception:
                            pass
                        os.utime(p, None)
                        return True
                except Exception:
                    pass
                os.replace(str(tmp), str(p))
                try:
                    p.chmod(0o600)
                except Exception:
                    pass
                self.stats["writes"] += 1
        except Exception:
            with self.lock:
                self.stats["errors"] += 1
            try:
                tmp.unlink()
            except Exception:
                pass
            return False
        self.prune(protect={str(p)})
        return True

    def clear(self, reset_stats=False):
        n = 0
        with self.lock:
            try:
                paths = list(self.directory.glob("nf_*_v*.parquet"))
            except Exception:
                paths = []
            for p in paths:
                if self._pins.get(str(p)):
                    continue
                try:
                    p.unlink()
                    n += 1
                except Exception:
                    pass
            if reset_stats:
                for k in self.stats:
                    self.stats[k] = 0
        return n

    def prune(self, protect=None):
        import time
        protect = set(protect or ())
        removed = 0
        with self.lock:
            try:
                items = []
                now = time.time()
                for p in self.directory.glob("nf_*_v*.parquet"):
                    sp = str(p)
                    try:
                        st = p.stat()
                    except Exception:
                        continue
                    if sp in protect or self._pins.get(sp):
                        continue
                    if self.max_age_days and now - st.st_mtime > \
                            self.max_age_days * 86400:
                        try:
                            p.unlink()
                            removed += 1
                            self.stats["evictions"] += 1
                        except Exception:
                            pass
                        continue
                    items.append((st.st_mtime, st.st_size, p))
                total = 0
                # Budget includes protected/pinned files even though they cannot
                # be removed in this pass.
                for p in self.directory.glob("nf_*_v*.parquet"):
                    try:
                        total += p.stat().st_size
                    except Exception:
                        pass
                if self.max_bytes:
                    for _mtime, size, p in sorted(items):
                        if total <= self.max_bytes:
                            break
                        try:
                            p.unlink()
                            total -= size
                            removed += 1
                            self.stats["evictions"] += 1
                        except Exception:
                            pass
            except Exception:
                self.stats["errors"] += 1
        return removed

    def info(self):
        with self.lock:
            entries = []
            total = 0
            try:
                for p in self.directory.glob("nf_*_v*.parquet"):
                    try:
                        st = p.stat()
                    except Exception:
                        continue
                    total += st.st_size
                    entries.append((st.st_size, p.name, st.st_mtime))
            except Exception:
                pass
            entries.sort(reverse=True)
            return {
                "path": str(self.directory),
                "size": len(entries),
                "bytes": int(total),
                "mb": round(total / (1024 * 1024), 2),
                "bytes_max": self.max_bytes,
                "mb_max": round(self.max_bytes / (1024 * 1024), 2),
                "max_age_days": self.max_age_days,
                "pinned": sum(self._pins.values()),
                "largest": [
                    {"file": name, "bytes": size,
                     "mb": round(size / (1024 * 1024), 2)}
                    for size, name, _mtime in entries[:8]
                ],
                **dict(self.stats),
            }
