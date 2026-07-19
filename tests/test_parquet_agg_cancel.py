"""Prove ParquetResultStore._run registers private cursors for Stop.

A bare eng.conn.cursor() is invisible to DuckDBManager.interrupt(); pivot/
chart aggregates must join _native_ops so cancel_query unwinds mid-statement.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.rows import ParquetResultStore  # noqa: E402
from samql_core.session import Session, _CachedResult  # noqa: E402


@unittest.skipUnless(HAS_DUCKDB, "duckdb required")
class ParquetAggCancelTests(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault("SAMQL_HOME", tempfile.mkdtemp(prefix="samql-cc-"))
        self.sess = Session()
        self.duck = self.sess.get_duckdb()
        self.sess._clear_stale_engine_cancel(self.duck)

    def test_run_registers_native_ops_during_execute(self):
        self.duck.execute(
            "CREATE OR REPLACE TABLE t AS "
            "SELECT i AS a, i % 10 AS b, i * 1.0 AS v FROM range(0, 5000000) t(i)"
        )
        path = tempfile.mktemp(suffix=".parquet")
        self.duck.execute(f"COPY t TO '{path}' (FORMAT PARQUET)")
        store = ParquetResultStore(self.duck, path, ["a", "b", "v"], owns_path=True)
        seen = {"registered": False, "done": False}
        barrier = threading.Event()

        def work():
            run, src, _colref, castnum = store._agg_ctx()
            sql = f"SELECT b, sum({castnum('v')}) FROM {src} GROUP BY 1"
            # Observe registration from another thread while GROUP BY runs.
            def watch():
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not seen["done"]:
                    with self.duck._native_ops_lock:
                        if self.duck._native_ops:
                            seen["registered"] = True
                            barrier.set()
                            return
                    time.sleep(0.005)
            watcher = threading.Thread(target=watch)
            watcher.start()
            try:
                run(sql)
            finally:
                seen["done"] = True
                watcher.join(5)

        th = threading.Thread(target=work)
        th.start()
        th.join(60)
        self.assertFalse(th.is_alive())
        self.assertTrue(
            seen["registered"],
            "ParquetResultStore._run must register the private cursor in _native_ops",
        )

    def test_pivot_midflight_cancel_on_parquet_result(self):
        n = 3_000_000
        self.duck.execute(
            "CREATE OR REPLACE TABLE stall AS "
            f"SELECT i AS g, (i % 50) AS bucket, i * 1.5 AS bal "
            f"FROM range(0, {n}) t(i)"
        )
        path = tempfile.mktemp(suffix=".parquet")
        self.duck.execute(
            f"COPY (SELECT bucket, g, bal FROM stall) TO '{path}' (FORMAT PARQUET)"
        )
        store = ParquetResultStore(
            self.duck, path, ["bucket", "g", "bal"], owns_path=True
        )
        rid = 4242
        self.sess._results[rid] = _CachedResult(
            rid,
            ["bucket", "g", "bal"],
            store,
            n,
            "SELECT *",
            "duckdb",
            self.duck,
            data_epoch=getattr(self.sess, "_data_epoch", 0),
        )
        self.sess._results_order.append(rid)

        qid = "pivot-parquet-cancel"
        hold: dict = {}

        def work():
            t0 = time.monotonic()
            hold["r"] = self.sess.pivot(
                {
                    "result_id": rid,
                    "rows": ["bucket"],
                    "cols": ["g"],
                    "values": [{"field": "bal", "agg": "sum"}],
                    "query_id": qid,
                }
            )
            hold["dt"] = time.monotonic() - t0

        th = threading.Thread(target=work)
        th.start()
        # Wait until rebound to DuckDBManager (post _agg_interrupt_target).
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.sess._running_lock:
                entry = self.sess._running.get(qid)
            eng = entry.get("engine") if isinstance(entry, dict) else entry
            if eng is not None and type(eng).__name__ == "DuckDBManager":
                time.sleep(0.15)
                break
            time.sleep(0.01)
        self.sess.cancel_query(qid)
        th.join(60)
        self.assertFalse(th.is_alive(), "pivot worker did not unwind")
        r = hold.get("r") or {}
        err = str(r.get("error") or "").lower()
        self.assertTrue(
            r.get("cancelled") or "interrupt" in err or "cancel" in err,
            "expected cancelled pivot, got %r" % r,
        )
        self.assertLess(
            hold.get("dt", 999),
            8.0,
            "parquet pivot cancel must unwind promptly (%.2fs)" % hold.get("dt", -1),
        )


if __name__ == "__main__":
    unittest.main()
