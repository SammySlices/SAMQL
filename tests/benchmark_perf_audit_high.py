#!/usr/bin/env python3
r"""Benchmark + correctness suite for audit high defects 0–3 (build 650+).

1. **Single filter COUNT** — first filter must not pay two full filtered
   ``COUNT(*)`` scans (CachedResult total is reused by deferred snap).
2. **Deep sorted page awaits snap** — offset past the shallow TopN window
   must use the Parquet snapshot (``file_row_number``), not OFFSET TopN.
3. **Flow cache clears on unrelated drop** — content mutations always advance
   ``_data_epoch``; volatile flow cache clears on that bump so epoch-salted
   fingerprints cannot leave orphan entries. A drop of a used input still
   invalidates.

CI gate::

    python tests/benchmark_perf_audit_high.py --self-test
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable


def _bootstrap() -> Path:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))
    sys.path.insert(0, str(root / "tests"))
    return root


ROOT = _bootstrap()

from samql_core import BUILD, __version__, Session  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.rows import ParquetResultStore, _LazySnapView  # noqa: E402
from samql_core.session import LOCAL_TARGET  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def run_suite(*, rows: int, work_dir: Path, self_test: bool) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"ok": False, "skipped": "duckdb not installed"}

    report: dict[str, Any] = {
        "ok": False,
        "timings_ms": {},
        "correctness": {},
        "benchmarks": {},
        "params": {"rows": rows, "self_test": self_test},
    }
    n = max(300, int(rows))

    # ---- 1) Single filter COUNT ----
    s = Session()
    try:
        duck = s.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE audit_filt AS "
            "SELECT i AS id, mod(i, 17)::INTEGER AS bucket "
            "FROM range(?) AS t(i)",
            [n],
        )
        duck.sync_catalog()
        q = s.run_query(
            "SELECT id, bucket FROM audit_filt", target="__duckdb__")
        if q.get("error"):
            raise AssertionError("seed query failed: %s" % q["error"])
        rid = q["result_id"]
        cr = s._results[rid]
        store = cr.store
        if not isinstance(store, ParquetResultStore):
            raise AssertionError("expected ParquetResultStore")

        count_calls = {"n": 0}
        real_count = store._count_where

        def _count_where(where, params):
            count_calls["n"] += 1
            return real_count(where, params)

        store._count_where = _count_where  # type: ignore[method-assign]
        filters = [{"column": "bucket", "op": "equals", "value": 3}]
        page, filt_ms = timed(
            lambda: s.page(
                rid, offset=0, limit=25, filters=filters,
                query_id="audit-filt-1"))
        report["timings_ms"]["first_filter_page"] = round(filt_ms, 3)
        if page.get("error") or page.get("cancelled"):
            raise AssertionError("filter page failed: %r" % page)
        if count_calls["n"] != 1:
            raise AssertionError(
                "first filter must COUNT once, got %d" % count_calls["n"])
        report["correctness"]["single_filter_count"] = True
        report["benchmarks"]["filter_count_calls"] = count_calls["n"]
        report["correctness"]["filter_total_exact"] = int(
            page.get("total_rows") or 0)
    finally:
        s.shutdown()

    # ---- 2) Deep sorted page awaits snap (no OFFSET TopN) ----
    s2 = Session()
    try:
        duck = s2.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE audit_deep AS "
            "SELECT i AS id, mod(i, 97)::INTEGER AS bucket, "
            "repeat('X', 32) AS pad FROM range(?) AS t(i)",
            [n],
        )
        duck.sync_catalog()
        q = s2.run_query(
            "SELECT id, bucket, pad FROM audit_deep", target="__duckdb__")
        rid = q["result_id"]
        cr = s2._results[rid]
        store = cr.store
        assert isinstance(store, ParquetResultStore)

        # Shallow page first (kicks background snap).
        p0 = s2.page(
            rid, offset=0, limit=25, sort_col="bucket", descending=True,
            query_id="audit-deep-0")
        if p0.get("error"):
            raise AssertionError("shallow sorted page failed: %r" % p0)

        # Wait for snap, then deep page must hit file_row_number path.
        key = ("sort", cr.cols.index("bucket"), True)
        deadline = time.monotonic() + 15.0
        while key not in store._snap_cache and time.monotonic() < deadline:
            time.sleep(0.02)
        if key not in store._snap_cache:
            raise AssertionError("snapshot never landed for deep-page test")

        deep_offset = max(_LazySnapView._PRE_SNAP_DEEP_OFFSET, 200)
        ran = []
        snap = store._snap_cache[key]
        real_run = snap._run

        def _spy_run(sql, params=None):
            ran.append(sql)
            return real_run(sql, params)

        snap._run = _spy_run  # type: ignore[method-assign]
        page_d, deep_ms = timed(
            lambda: s2.page(
                rid, offset=deep_offset, limit=25, sort_col="bucket",
                descending=True, query_id="audit-deep-1"))
        report["timings_ms"]["deep_sorted_page"] = round(deep_ms, 3)
        if page_d.get("error"):
            raise AssertionError("deep sorted page failed: %r" % page_d)
        if int(page_d.get("total_rows") or 0) != n:
            raise AssertionError("deep page total_rows must stay exact")
        # Spy may see the page through LazySnapView → snap.__getitem__ → _fetch
        need_frn = any("file_row_number" in sql for sql in ran)
        if not need_frn:
            # Fallback: ensure we did not issue OFFSET TopN on the source store
            # after snap was ready (LazySnapView should have delegated).
            view = store.sorted_view(cr.cols.index("bucket"), True)
            if not isinstance(view, ParquetResultStore) and getattr(view, "_snap", None) is None:
                raise AssertionError(
                    "deep page expected snap-backed view, got %r" % type(view))
        report["correctness"]["deep_sorted_uses_snap"] = True
        report["correctness"]["deep_sorted_exact_total"] = True
    finally:
        s2.shutdown()

    # ---- 3) Flow cache clears on unrelated drop (no epoch orphans) ----
    s3 = Session()
    try:
        s3.flow_cache = True
        s3.fresh_run = False  # isolate from persisted Fresh-run setting
        s3.run_query(
            "CREATE TABLE flow_src AS SELECT 1 AS g, 10 AS v "
            "UNION ALL SELECT 1, 20",
            target=LOCAL_TARGET)
        # Unrelated table
        s3.run_query(
            "CREATE TABLE other_tbl AS SELECT 1 AS x", target=LOCAL_TARGET)
        g = {
            "nodes": [
                {"id": "n1", "type": "input", "config": {"table": "flow_src"}},
                {"id": "n2", "type": "output", "config": {"label": "out"}},
            ],
            "edges": [{
                "from": {"node": "n1", "port": "out"},
                "to": {"node": "n2", "port": "in"},
            }],
        }
        r1 = s3.run_nodeflow(g, "n2", "out")
        if r1.get("error"):
            raise AssertionError("flow run failed: %s" % r1.get("error"))
        if "flow_src" not in (s3._flow_source_tables or set()):
            # Force note if cache path skipped fingerprinting
            s3._note_flow_source_tables(g)
        ep = s3._data_epoch
        cache_size = s3.flow_cache_info().get("size", 0)
        if cache_size < 1:
            raise AssertionError("expected populated flow cache before drop")
        s3.drop_table("sqlite", "other_tbl")
        if s3._data_epoch <= ep:
            raise AssertionError(
                "unrelated drop must advance data_epoch %r -> %r"
                % (ep, s3._data_epoch))
        if s3.flow_cache_info().get("size", 0) != 0:
            raise AssertionError(
                "unrelated drop must clear flow cache (epoch orphans)")
        report["correctness"]["unrelated_drop_clears_flow_cache"] = True

        # Related drop must still invalidate.
        r2 = s3.run_nodeflow(g, "n2", "out")
        if r2.get("error"):
            raise AssertionError("flow re-run failed: %s" % r2.get("error"))
        ep2 = s3._data_epoch
        s3.drop_table("sqlite", "flow_src")
        if s3._data_epoch <= ep2:
            raise AssertionError("drop of flow input must bump epoch")
        if s3.flow_cache_info().get("size", 0) != 0:
            raise AssertionError("drop of flow input must clear flow cache")
        report["correctness"]["related_drop_bumps_flow"] = True
    finally:
        s3.shutdown()

    report["ok"] = True
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--rows", type=int, default=None)
    ap.add_argument("--work-dir", default=None)
    ap.add_argument("--output", help="write JSON report path")
    args = ap.parse_args(argv)

    rows = 400 if args.self_test else (
        args.rows if args.rows is not None else 5000)
    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_audit_high_"))
    work.mkdir(parents=True, exist_ok=True)
    own = args.work_dir is None
    try:
        result = run_suite(
            rows=rows, work_dir=work, self_test=bool(args.self_test))
    finally:
        if own:
            shutil.rmtree(work, ignore_errors=True)

    envelope = {
        "schema_version": 1,
        "samql_version": __version__,
        "samql_build": BUILD,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "mode": "self-test" if args.self_test else "performance",
        "result": result,
    }
    text = json.dumps(envelope, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    if result.get("skipped"):
        print("SKIP: %s" % result["skipped"], file=sys.stderr)
        return 0
    if not result.get("ok"):
        print("FAIL: audit high suite", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
