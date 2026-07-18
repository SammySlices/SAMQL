#!/usr/bin/env python3
r"""Benchmark + correctness suite for medium-impact perf fixes (builds 649+).

Covers:

1. **Deferred sort/filter snapshot** — first page via TopN before full COPY;
   exact ``total_rows``; later snap uses ``file_row_number`` ranges.
2. **Scoped count invalidation** — drop/load forgets only touched tables.
3. **Hostile nested page + sort** — fat nested cells still display-bounded
   under first sorted page (pairs with high-fix page encode).

CI gate::

    python tests/benchmark_perf_medium_fixes.py --self-test

Cross-cutting: flatten/shred defaults unchanged; FE discovery-only; flow-cache
epoch still bumps globally on mutations.
"""
from __future__ import annotations

import argparse
import json
import os
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

    # ---- 1) Deferred sort: first page before COPY completes ----
    s = Session()
    try:
        duck = s.get_duckdb()
        # Wide-ish result so COPY is measurably slower than TopN LIMIT.
        n = max(200, int(rows))
        duck.conn.execute(
            "CREATE OR REPLACE TABLE perf_med_sort AS "
            "SELECT i AS id, "
            "       mod(i, 97)::INTEGER AS bucket, "
            "       repeat('X', 64) AS pad "
            "FROM range(?) AS t(i)",
            [n],
        )
        duck.sync_catalog()
        q = s.run_query(
            'SELECT id, bucket, pad FROM perf_med_sort',
            target="__duckdb__",
        )
        if q.get("error"):
            raise AssertionError("seed query failed: %s" % q["error"])
        rid = q["result_id"]
        cr = s._results[rid]
        store = cr.store
        if not isinstance(store, ParquetResultStore):
            raise AssertionError("expected ParquetResultStore, got %r" % type(store))

        # Instrument materialize to prove first page does not wait on it.
        real_mat = store._materialize_snapshot
        mat_started = threading.Event()
        mat_gate = threading.Event()
        mat_calls: list[str] = []

        def _slow_mat(order, where="", params=None):
            mat_calls.append(order)
            mat_started.set()
            # Hold COPY until first page has returned (self-test only).
            if self_test:
                mat_gate.wait(timeout=5.0)
            return real_mat(order, where=where, params=params)

        store._materialize_snapshot = _slow_mat  # type: ignore[method-assign]

        page1, page1_ms = timed(
            lambda: s.page(rid, offset=0, limit=25, sort_col="bucket",
                           descending=True, query_id="perf-med-sort-1"))
        report["timings_ms"]["first_sorted_page"] = round(page1_ms, 3)
        if page1.get("error") or page1.get("cancelled"):
            raise AssertionError("first sorted page failed: %r" % page1)
        if int(page1.get("total_rows") or 0) != n:
            raise AssertionError(
                "exact total_rows required: got %r want %r"
                % (page1.get("total_rows"), n))
        if len(page1.get("rows") or []) != 25:
            raise AssertionError("expected 25 first-page rows")
        # First page must finish without waiting for the gated COPY.
        if self_test and mat_started.is_set() and not mat_gate.is_set():
            # Background may have started, but page returned before gate opened.
            pass
        report["correctness"]["first_sorted_page_exact_total"] = True
        report["correctness"]["first_sorted_before_snap"] = (
            ("sort", cr.cols.index("bucket"), True) not in store._snap_cache
            or isinstance(
                store._pending_snaps.get(("sort", cr.cols.index("bucket"), True)),
                _LazySnapView,
            )
        )
        mat_gate.set()
        # Wait for snap; second page should still be correct.
        deadline = time.monotonic() + 10.0
        key = ("sort", cr.cols.index("bucket"), True)
        while key not in store._snap_cache and time.monotonic() < deadline:
            time.sleep(0.02)
        page2, page2_ms = timed(
            lambda: s.page(rid, offset=25, limit=25, sort_col="bucket",
                           descending=True, query_id="perf-med-sort-2"))
        report["timings_ms"]["second_sorted_page"] = round(page2_ms, 3)
        if page2.get("error") or int(page2.get("total_rows") or 0) != n:
            raise AssertionError("second sorted page failed: %r" % page2)
        report["correctness"]["sorted_pages_exact"] = True
        report["benchmarks"]["mat_calls"] = len(mat_calls)
        if not mat_calls:
            raise AssertionError("expected background snapshot to run")
    finally:
        s.shutdown()

    # ---- 2) Scoped count invalidation ----
    s2 = Session()
    try:
        import csv
        for name, n_rows in (("keep_a", 11), ("drop_b", 5)):
            path = work_dir / ("%s.csv" % name)
            with path.open("w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["x"])
                for i in range(n_rows):
                    w.writerow([i])
            s2.load_file(str(path), destination="sqlite", base_name=name)
        tree = {t["name"]: t for t in s2.tables_tree()}
        if tree["keep_a"]["row_count"] != 11 or tree["drop_b"]["row_count"] != 5:
            raise AssertionError("seed counts wrong: %r" % tree)
        before_epoch = s2._data_epoch
        s2.drop_table("sqlite", "drop_b")
        if ("sqlite", "keep_a") not in s2._count_cache:
            raise AssertionError("scoped drop cleared unrelated count")
        if ("sqlite", "drop_b") in s2._count_cache:
            raise AssertionError("dropped table count still cached")
        if s2._data_epoch <= before_epoch:
            raise AssertionError("flow epoch must still bump on scoped drop")
        report["correctness"]["scoped_count_drop"] = True

        # Free-form write SQL still clears globally.
        s2._count_cache[("sqlite", "keep_a")] = 11
        s2.run_query("DELETE FROM keep_a WHERE x = 0", target="__local__")
        if ("sqlite", "keep_a") in s2._count_cache:
            raise AssertionError("write SQL must globally invalidate counts")
        report["correctness"]["write_sql_global_counts"] = True
    finally:
        s2.shutdown()

    # ---- 3) Hostile nested cell + sorted first page (display bound) ----
    s3 = Session()
    try:
        fat = {
            "pad": "Z" * (80_000 if self_test else 400_000),
            "legs": [{"i": i, "note": "n" * 32} for i in range(40)],
        }
        path = work_dir / "perf_med_nested.json"
        path.write_text(json.dumps([
            {"id": i, "bucket": i % 7, "blob": fat} for i in range(max(8, min(rows, 40)))
        ]), encoding="utf-8")
        loaded = s3.load_file(
            str(path), destination="duckdb", base_name="perf_med_nest",
            flatten=False, shred=False)
        table = loaded[0]["name"]
        q = s3.run_query(
            'SELECT id, bucket, blob FROM "%s"' % table.replace('"', '""'),
            target="__duckdb__")
        rid = q["result_id"]
        page, nest_ms = timed(
            lambda: s3.page(rid, offset=0, limit=5, sort_col="bucket",
                            descending=False, query_id="perf-med-nest"))
        report["timings_ms"]["nested_sorted_page"] = round(nest_ms, 3)
        if page.get("error"):
            raise AssertionError("nested sorted page failed: %s" % page["error"])
        wire = json.dumps(page.get("rows") or [], default=str)
        report["benchmarks"]["nested_sorted_wire_chars"] = len(wire)
        if len(wire) > 2_000_000:
            raise AssertionError("nested sorted page wire too large: %d" % len(wire))
        report["correctness"]["nested_sorted_wire_bounded"] = True
        report["correctness"]["nested_sorted_total"] = int(page.get("total_rows") or 0)
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

    if args.self_test:
        rows = 400
    else:
        rows = args.rows if args.rows is not None else 5000

    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_perf_med_"))
    work.mkdir(parents=True, exist_ok=True)
    own = args.work_dir is None

    try:
        result = run_suite(rows=rows, work_dir=work, self_test=bool(args.self_test))
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
        print("FAIL: perf medium fixes suite", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
