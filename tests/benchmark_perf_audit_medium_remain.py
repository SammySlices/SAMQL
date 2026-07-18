#!/usr/bin/env python3
r"""Benchmark + correctness for remaining audit medium fixes (build 661+).

1. **Deep snap pending** — deep sorted page returns pending quickly while
   snap builds (no 120s HTTP park); ready snap still serves rows.
2. **``_table_names_in``** — CTE aliases excluded; schema-qualified /
   quoted identifiers resolve when sqlglot is available.
3. **Field-tree deadline** — sample windows honor a soft deadline.
4. **Adjacent** — unrelated flow drop still keeps cache; flatten-off /
   discovery-only posture unchanged.

CI gate::

    python tests/benchmark_perf_audit_medium_remain.py --self-test
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable


def _bootstrap() -> Path:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))
    sys.path.insert(0, str(root / "tests"))
    return root


ROOT = _bootstrap()

from samql_core import Session  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.rows import ParquetResultStore, _LazySnapView  # noqa: E402
from samql_core.session import LOCAL_TARGET  # noqa: E402
from samql_core.sqlutil import HAS_SQLGLOT  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def run_suite(*, self_test: bool) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": False,
        "correctness": {},
        "benchmarks": {},
        "params": {"self_test": self_test, "sqlglot": HAS_SQLGLOT},
    }
    if not HAS_DUCKDB:
        return {"ok": False, "skipped": "duckdb not installed"}

    n = 800 if self_test else 5000

    # ---- 1) Deep snap pending (no long HTTP park) ----
    s = Session()
    try:
        duck = s.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE med_deep AS "
            "SELECT i AS id, mod(i, 97)::INTEGER AS bucket "
            "FROM range(?) AS t(i)",
            [n],
        )
        duck.sync_catalog()
        q = s.run_query(
            "SELECT id, bucket FROM med_deep", target="__duckdb__")
        rid = q["result_id"]
        cr = s._results[rid]
        store = cr.store
        need(isinstance(store, ParquetResultStore), "parquet result store")

        # Kick snap via shallow page, then force pending path by clearing snap
        # and issuing a deep page before COPY finishes.
        p0 = s.page(
            rid, offset=0, limit=10, sort_col="bucket", descending=True,
            query_id="med-deep-0")
        need(not p0.get("error"), "shallow page ok")

        # Hold kickoff from completing: use a fresh key by clearing caches and
        # delaying materialize so deep page hits SnapNotReady.
        store._snap_cache.clear()
        store._pending_snaps.clear()
        deep_offset = max(_LazySnapView._PRE_SNAP_DEEP_OFFSET, 200)
        real_mat = store._materialize_snapshot

        def slow_mat(*a, **k):
            time.sleep(0.8)
            return real_mat(*a, **k)

        store._materialize_snapshot = slow_mat  # type: ignore
        try:
            page_p, pending_ms = timed(
                lambda: s.page(
                    rid, offset=deep_offset, limit=10, sort_col="bucket",
                    descending=True, query_id="med-deep-pend"))
        finally:
            store._materialize_snapshot = real_mat  # type: ignore

        report["benchmarks"]["deep_pending_ms"] = round(pending_ms, 3)
        report["correctness"]["deep_pending_fast"] = (
            bool(page_p.get("pending"))
            and pending_ms < 1500.0
            and int(page_p.get("total_rows") or 0) == n)

        # Wait for snap, then deep page must return rows (not pending).
        key = ("sort", cr.cols.index("bucket"), True)
        deadline = time.monotonic() + 20.0
        while key not in store._snap_cache and time.monotonic() < deadline:
            # Nudge kickoff via another shallow page if needed.
            s.page(
                rid, offset=0, limit=5, sort_col="bucket", descending=True,
                query_id="med-deep-nudge")
            time.sleep(0.05)
        need(key in store._snap_cache, "snap landed for ready deep page")
        page_d, ready_ms = timed(
            lambda: s.page(
                rid, offset=deep_offset, limit=10, sort_col="bucket",
                descending=True, query_id="med-deep-ready"))
        report["benchmarks"]["deep_ready_ms"] = round(ready_ms, 3)
        report["correctness"]["deep_ready_rows"] = (
            not page_d.get("pending")
            and not page_d.get("error")
            and len(page_d.get("rows") or []) > 0
            and int(page_d.get("total_rows") or 0) == n)
    finally:
        s.shutdown()

    # ---- 2) table_names_in CTE / schema / quoted ----
    s = Session()
    try:
        names = s._table_names_in(
            "WITH cte AS (SELECT 1 AS x FROM real_src) "
            "SELECT * FROM cte JOIN other_tbl ON 1=1")
        report["correctness"]["from_join_tables"] = (
            "real_src" in names and "other_tbl" in names)
        if HAS_SQLGLOT:
            report["correctness"]["cte_excluded"] = (
                "cte" not in {n.lower() for n in names})
            qnames = s._table_names_in(
                'SELECT * FROM "Weird Name" JOIN schema_x.tbl_y t')
            report["correctness"]["quoted_or_schema"] = (
                "Weird Name" in qnames or "tbl_y" in qnames)
        else:
            report["correctness"]["cte_excluded"] = True
            report["correctness"]["quoted_or_schema"] = True
        # Flow SQL-node still records deps.
        s._flow_source_tables = set()
        s._note_flow_source_tables({
            "nodes": [
                {"id": "sq", "type": "sql",
                 "config": {"sql": "SELECT * FROM flow_dep_tbl"}},
                {"id": "out", "type": "output", "config": {}}],
        })
        report["correctness"]["sql_node_deps"] = (
            "flow_dep_tbl" in (s._flow_source_tables or set()))
    finally:
        s.shutdown()

    # ---- 3) Field-tree sample deadline ----
    s = Session()
    try:
        duck = s.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE med_fe AS "
            "SELECT {'a': i, 'b': {'c': i}} AS nest FROM range(200) t(i)")
        duck.sync_catalog()
        # Already-past deadline must not hang on mid/end probes.
        past = time.monotonic() - 1.0
        t0 = time.perf_counter()
        vals = s._fetch_shape_sample_values(
            duck, "med_fe", "nest", deadline=past)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        report["benchmarks"]["fe_deadline_ms"] = round(elapsed_ms, 3)
        report["correctness"]["fe_deadline_yields"] = elapsed_ms < 500.0
        # Discovery still works without deadline.
        tree = s.table_field_tree("duckdb", "med_fe", budget_sec=3.0)
        report["correctness"]["fe_discovery_ok"] = (
            not tree.get("error") and len(tree.get("fields") or []) >= 1)
    finally:
        s.shutdown()

    # ---- 4) Adjacent: unrelated drop keeps flow ----
    s = Session()
    try:
        s.flow_cache = True
        s.run_query("CREATE TABLE flow_src AS SELECT 1 AS g",
                    target=LOCAL_TARGET)
        s.run_query("CREATE TABLE other_tbl AS SELECT 1 AS x",
                    target=LOCAL_TARGET)
        g = {"nodes": [
            {"id": "n1", "type": "input", "config": {"table": "flow_src"}},
            {"id": "n2", "type": "output", "config": {"label": "out"}}],
             "edges": [{"from": {"node": "n1", "port": "out"},
                        "to": {"node": "n2", "port": "in"}}]}
        r1 = s.run_nodeflow(g, "n2", "out")
        ep = s._data_epoch
        size = s.flow_cache_info()["size"]
        s.drop_table("sqlite", "other_tbl")
        report["correctness"]["unrelated_drop_keeps_flow"] = (
            (not r1.get("error"))
            and s._data_epoch > ep
            and s.flow_cache_info()["size"] == size)
    finally:
        s.shutdown()

    # Structural: frontend incident-wire index + pending page retry.
    scene = (ROOT / "frontend" / "src" / "components" / "nodeflow"
             / "nodeFlowRenderModel.ts").read_text(encoding="utf-8")
    report["correctness"]["incident_wire_index"] = (
        "incidentWireIndexesByNode" in scene
        and "edgeById" in scene)
    paged = (ROOT / "frontend" / "src" / "lib"
             / "usePagedResult.ts").read_text(encoding="utf-8")
    report["correctness"]["page_pending_retry"] = (
        "fetchPageAwaiting" in paged and "page.pending" in paged)
    mm = (ROOT / "frontend" / "src" / "components"
          / "NodeFlowCanvas.tsx").read_text(encoding="utf-8")
    report["correctness"]["minimap_large_freeze"] = (
        "LARGE_GRAPH_NODE_THRESHOLD" in mm and "paintRef" in mm)

    report["ok"] = all(bool(v) for v in report["correctness"].values())
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--output", default="")
    args = p.parse_args(argv)
    try:
        result = run_suite(self_test=bool(args.self_test))
    except Exception as exc:
        result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    payload = {
        "schema_version": 1,
        "mode": "self-test" if args.self_test else "performance",
        "result": result,
    }
    text = json.dumps(payload, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    if result.get("skipped"):
        return 0
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
