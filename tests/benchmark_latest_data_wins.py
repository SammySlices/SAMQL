#!/usr/bin/env python3
r"""Latest-data-wins correctness + timing harness (build 665+).

Proves IDE / Journal / NodeFlow refuse stale caches after underlying data
mutates, then serve the updated rows on re-run.

Surfaces covered
----------------
1. **IDE** — ``run_query`` + ``page``: after INSERT, the old ``result_id``
   expires; a fresh query sees the new row count.
2. **Journal** — DuckDB parquet reuse: ``_reusable_store_path`` goes None
   after mutation (chain-reuse cannot bind old parquet); re-run is current.
3. **NodeFlow** — input→output rematerialize: second run after INSERT returns
   the new total; volatile flow cache is cleared by the write.
4. **FE contracts** — source pins for Journal ``ranDataEpoch``, IDE
   ``dataStale`` chip, NodeFlow preview/chart epoch clears.

CI gate::

    python tests/benchmark_latest_data_wins.py --self-test
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
from samql_core.session import DUCKDB_TARGET, LOCAL_TARGET  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _seed_duck_table(s: Session, name: str, n: int) -> None:
    duck = s.get_duckdb()
    duck.conn.execute(
        "CREATE OR REPLACE TABLE %s AS "
        "SELECT i AS id FROM range(?) AS t(i)" % name,
        [n],
    )
    duck.sync_catalog()


def run_suite(*, self_test: bool) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": False,
        "correctness": {},
        "benchmarks": {},
        "params": {"self_test": self_test},
    }
    if not HAS_DUCKDB:
        return {"ok": False, "skipped": "duckdb not installed"}

    n = 200 if self_test else 5000

    # ---- 1) IDE: page expires after mutation; re-run is current ----
    s = Session()
    try:
        _seed_duck_table(s, "ide_src", n)
        q1 = s.run_query("SELECT id FROM ide_src", target=DUCKDB_TARGET)
        need(not q1.get("error"), "IDE seed select: %s" % q1.get("error"))
        rid = q1["result_id"]
        p1 = s.page(rid, 0, 25)
        need(not p1.get("error"), "IDE fresh page works")
        need(int(p1.get("total_rows") or 0) == n,
             "IDE seed total_rows == %d" % n)
        ep = s._data_epoch

        s.run_query(
            "INSERT INTO ide_src VALUES (%d)" % (n + 1),
            target=DUCKDB_TARGET)
        need(s._data_epoch > ep, "IDE write advances data_epoch")

        expired, expire_ms = timed(lambda: s.page(rid, 0, 25))
        report["benchmarks"]["ide_stale_page_expire_ms"] = round(expire_ms, 3)
        report["correctness"]["ide_stale_page_expires"] = (
            expired.get("error") == "result expired")

        q2, rerun_ms = timed(
            lambda: s.run_query(
                "SELECT id FROM ide_src", target=DUCKDB_TARGET))
        report["benchmarks"]["ide_rerun_after_mutation_ms"] = round(
            rerun_ms, 3)
        need(not q2.get("error"), "IDE re-run: %s" % q2.get("error"))
        p2 = s.page(q2["result_id"], 0, 25)
        need(not p2.get("error"), "IDE fresh page after re-run")
        report["correctness"]["ide_rerun_sees_new_rows"] = (
            int(p2.get("total_rows") or 0) == n + 1)
    finally:
        s.shutdown()

    # ---- 2) Journal: parquet reuse path refuses pre-mutation result_id ----
    s = Session()
    try:
        _seed_duck_table(s, "jrnl_src", n)
        q1 = s.run_query("SELECT id FROM jrnl_src", target=DUCKDB_TARGET)
        need(not q1.get("error"), "Journal seed: %s" % q1.get("error"))
        rid = q1["result_id"]
        path_before = s._reusable_store_path(rid)
        need(path_before is not None,
             "Journal duckdb parquet is reusable before mutation")
        ep = s._data_epoch

        s.run_query(
            "INSERT INTO jrnl_src VALUES (%d)" % (n + 7),
            target=DUCKDB_TARGET)
        need(s._data_epoch > ep, "Journal write advances data_epoch")

        path_after, refuse_ms = timed(lambda: s._reusable_store_path(rid))
        report["benchmarks"]["journal_reuse_refuse_ms"] = round(refuse_ms, 3)
        report["correctness"]["journal_reuse_refuses_stale"] = (
            path_after is None)

        # Server-side reuse map must bounce to reuse_stale for the old rid.
        class _Eng:
            def __init__(self):
                self.table_columns = {}

            def execute(self, sql):
                text = str(sql or "")
                if "information_schema.tables" in text.lower():
                    class _Cur:
                        def fetchall(self):
                            return []
                    return _Cur()
                if "create" in text.lower() and "view" in text.lower():
                    raise AssertionError(
                        "must not create TEMP VIEW over stale rid: %s" % text)
                return None

            @property
            def conn(self):
                return self

        stale, cleanup = s._setup_reuse_views(_Eng(), {"cellA": rid})
        try:
            report["correctness"]["journal_setup_reuse_stale"] = (
                "cellA" in (stale or []))
        finally:
            if callable(cleanup):
                try:
                    cleanup()
                except Exception:
                    pass

        q2 = s.run_query("SELECT id FROM jrnl_src", target=DUCKDB_TARGET)
        need(not q2.get("error"), "Journal re-run: %s" % q2.get("error"))
        p2 = s.page(q2["result_id"], 0, 25)
        report["correctness"]["journal_rerun_sees_new_rows"] = (
            not p2.get("error")
            and int(p2.get("total_rows") or 0) == n + 1)
    finally:
        s.shutdown()

    # ---- 3) NodeFlow: rematerialize after source mutation ----
    s = Session()
    try:
        s.flow_cache = True
        s._flow_cache_clear()
        _seed_duck_table(s, "flow_src", n)
        g = {"nodes": [
            {"id": "n1", "type": "input",
             "config": {"table": "flow_src"}},
            {"id": "n2", "type": "output",
             "config": {"label": "out"}}],
             "edges": [{"from": {"node": "n1", "port": "out"},
                        "to": {"node": "n2", "port": "in"}}]}
        r1, run1_ms = timed(lambda: s.run_nodeflow(g, "n2", "out"))
        report["benchmarks"]["nodeflow_first_run_ms"] = round(run1_ms, 3)
        need(not r1.get("error"), "NodeFlow first run: %s" % r1.get("error"))
        need(int(r1.get("total_rows") or 0) == n,
             "NodeFlow first total_rows")
        cache_before = int(s.flow_cache_info().get("size") or 0)
        ep = s._data_epoch

        s.run_query(
            "INSERT INTO flow_src VALUES (%d)" % (n + 3),
            target=DUCKDB_TARGET)
        need(s._data_epoch > ep, "NodeFlow write advances data_epoch")
        # Global write invalidates counts → clears volatile flow cache.
        report["correctness"]["nodeflow_write_clears_flow_cache"] = (
            int(s.flow_cache_info().get("size") or 0) == 0
            or cache_before == 0)

        r2, run2_ms = timed(lambda: s.run_nodeflow(g, "n2", "out"))
        report["benchmarks"]["nodeflow_rerun_after_mutation_ms"] = round(
            run2_ms, 3)
        need(not r2.get("error"), "NodeFlow re-run: %s" % r2.get("error"))
        report["correctness"]["nodeflow_rerun_sees_new_rows"] = (
            int(r2.get("total_rows") or 0) == n + 1)

        # A result_id minted before a later mutation must expire too.
        q_old = s.run_query(
            "SELECT id FROM flow_src LIMIT 5", target=DUCKDB_TARGET)
        rid_old = q_old.get("result_id")
        need(rid_old, "got a result_id for cross-surface check")
        s.run_query(
            "INSERT INTO flow_src VALUES (%d)" % (n + 9),
            target=DUCKDB_TARGET)
        report["correctness"]["nodeflow_old_result_expires"] = (
            s.page(rid_old, 0, 5).get("error") == "result expired")

        # Chart/pivot/profile must expire the same way (not bypass via _agg_source).
        chart = s.chart_data({
            "result_id": rid_old, "chart_type": "bar",
            "x": "id", "y": "id", "agg": "sum",
        })
        report["correctness"]["ide_stale_chart_expires"] = (
            chart.get("error") == "result expired")
        pivot = s.pivot({
            "result_id": rid_old, "rows": ["id"], "cols": [],
            "vals": [{"field": "id", "agg": "count"}],
        })
        report["correctness"]["ide_stale_pivot_expires"] = (
            pivot.get("error") == "result expired")
    finally:
        s.shutdown()

    # ---- 4) SQLite IDE path (local engine) also expires ----
    s = Session()
    try:
        s.run_query(
            "CREATE TABLE local_src AS SELECT 1 AS id UNION ALL SELECT 2",
            target=LOCAL_TARGET)
        q1 = s.run_query("SELECT id FROM local_src", target=LOCAL_TARGET)
        rid = q1["result_id"]
        need(not s.page(rid, 0, 10).get("error"), "sqlite page ok")
        need(int(q1.get("data_epoch") or -1) == int(s._data_epoch),
             "query response carries snapshot data_epoch")
        report["correctness"]["query_returns_data_epoch"] = (
            "data_epoch" in q1
            and int(q1.get("data_epoch") or -1) == int(
                getattr(s._results.get(rid), "data_epoch", -2)))
        s.run_query("INSERT INTO local_src VALUES (3)", target=LOCAL_TARGET)
        report["correctness"]["sqlite_ide_stale_page_expires"] = (
            s.page(rid, 0, 10).get("error") == "result expired")
        q2 = s.run_query("SELECT id FROM local_src", target=LOCAL_TARGET)
        p2 = s.page(q2["result_id"], 0, 10)
        report["correctness"]["sqlite_ide_rerun_sees_new_rows"] = (
            not p2.get("error") and int(p2.get("total_rows") or 0) == 3)
    finally:
        s.shutdown()

    # ---- 4b) materialize staging bumps data_epoch ----
    s = Session()
    try:
        _seed_duck_table(s, "mat_src", max(10, n // 20))
        q1 = s.run_query("SELECT id FROM mat_src", target=DUCKDB_TARGET)
        rid = q1["result_id"]
        ep = s._data_epoch
        mat = s.materialize(
            "__nb_mat_audit", "SELECT id FROM mat_src",
            target=DUCKDB_TARGET)
        need(not mat.get("error"), "materialize ok: %s" % mat.get("error"))
        report["correctness"]["materialize_advances_data_epoch"] = (
            s._data_epoch > ep)
        report["correctness"]["materialize_expires_prior_result"] = (
            s.page(rid, 0, 5).get("error") == "result expired")
        # Epoch bump reclaims the store from `_results` (not only live-check).
        report["correctness"]["epoch_bump_reclaims_results"] = (
            rid not in s._results)
        w = s.run_query(
            "INSERT INTO mat_src VALUES (%d)" % (n + 99),
            target=DUCKDB_TARGET)
        report["correctness"]["write_response_data_epoch"] = (
            int(w.get("data_epoch") or -1) == int(s._data_epoch))
    finally:
        s.shutdown()

    # ---- 5) FE source contracts (display + reuse guards) ----
    nb = (ROOT / "frontend" / "src" / "lib" / "notebook.ts").read_text(
        encoding="utf-8")
    notebook = (ROOT / "frontend" / "src" / "components"
                / "Notebook.tsx").read_text(encoding="utf-8")
    app = (ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")
    api_ts = (ROOT / "frontend" / "src" / "lib" / "api.ts").read_text(
        encoding="utf-8")
    sql_cell = (
        ROOT / "frontend" / "src" / "components" / "notebook"
        / "SqlNotebookCell.tsx").read_text(encoding="utf-8")
    fe = (ROOT / "frontend" / "src" / "components"
          / "FieldExplorer.tsx").read_text(encoding="utf-8")
    session_py = (ROOT / "backend" / "samql_core"
                  / "session.py").read_text(encoding="utf-8")
    exec_ctrl = (
        ROOT / "frontend" / "src" / "components" / "nodeflow"
        / "useNodeFlowExecutionController.ts").read_text(encoding="utf-8")
    rule = (ROOT / ".cursor" / "rules" / "latest-data-wins.mdc").read_text(
        encoding="utf-8")
    report["correctness"]["fe_journal_epoch_freshness"] = (
        "ranDataEpoch" in nb
        and "dataEpoch === undefined || c.ranDataEpoch === dataEpoch" in nb
        and "dataDrift" in notebook)
    report["correctness"]["fe_ide_data_stale_chip"] = (
        "dataStale" in app
        and "result-data-stale-chip" in app
        and "Data changed — re-run" in app)
    report["correctness"]["fe_stamp_result_epoch"] = (
        "stampResultEpoch" in api_ts
        and "stampResultEpoch" in app
        and "stampResultEpoch" in notebook)
    report["correctness"]["fe_chart_stale_guard"] = (
        "result-data-stale-panel" in app
        and "Data changed — re-run to chart" in app
        and "nb-out-stale" in sql_cell
        and "Data changed — re-run to" in sql_cell)
    report["correctness"]["fe_profile_recon_stale"] = (
        'tab.kind === "profile"' in app
        and 'tab.kind === "recon"' in app
        and "Data changed — re-profile" in app
        and "Data changed — re-run reconcile" in app)
    report["correctness"]["fe_export_blocks_stale"] = (
        "!r.dataStale" in app
        and "disabled={!!props.stale}" in sql_cell
        and "staleById[id]" in notebook)
    report["correctness"]["fe_field_explorer_soft_clear"] = (
        "dataEpoch" in fe
        and "[srcKey, open, dataEpoch]" in fe
        and "setFields(null)" in fe
        and "reloadFields" in fe)
    report["correctness"]["fe_apply_data_epoch"] = (
        "applyDataEpoch" in app and "onDataEpoch" in notebook)
    report["correctness"]["fe_monotonic_data_epoch"] = (
        "nextMonotonicDataEpoch" in app
        and "nextMonotonicDataEpoch" in api_ts
        and "Math.max" in api_ts)
    report["correctness"]["fe_epoch_cancels_pending_pages"] = (
        "resultPaging.cancelPending()" in app
        and "notebookPaging.cancelPending()" in notebook)
    report["correctness"]["be_reclaim_stale_results"] = (
        "def _reclaim_stale_results" in session_py
        and "self._reclaim_stale_results()" in session_py
        and "or 900" in session_py.split("def _reclaim_stale_results", 1)[1]
            .split("def _note_flow_source_tables", 1)[0])
    report["correctness"]["be_invalidate_counts_clears_profiles"] = (
        "self._invalidate_profiles()" in session_py
        and "_invalidate_counts" in session_py
        and session_py.split("def _invalidate_counts", 1)[1]
            .split("def _reclaim_stale_results", 1)[0]
            .count("self._invalidate_profiles()") >= 1)
    report["correctness"]["be_shred_source_epoch_refresh"] = (
        "_shred_at" in session_py
        and "_table_content_epoch" in session_py
        and "content epoch" in session_py.lower())
    report["correctness"]["be_freeform_write_stamps_shred_epoch"] = (
        "def _stamp_shred_sources_content_epoch" in session_py
        and "_mutation_table_names(sql)" in session_py.split(
            "def _run_query_inner", 1)[1].split("\n    def ", 1)[0]
        and "_stamp_shred_sources_content_epoch(ep)" in session_py.split(
            "def _invalidate_counts", 1)[1]
            .split("def _reclaim_stale_results", 1)[0])
    report["correctness"]["be_disk_source_auto_refresh"] = (
        "def _ensure_disk_source_nodes_fresh" in session_py
        and "_ensure_disk_source_nodes_fresh(" in session_py
        and "directory" in session_py.split(
            "def _disk_source_nodes_upstream", 1)[1]
            .split("def _ensure_disk_source_nodes_fresh", 1)[0])
    report["correctness"]["fe_nodeflow_epoch_clears"] = (
        "previewEpochRef" in exec_ctrl
        and "setPreview(null)" in exec_ctrl
        and "setChartData({})" in exec_ctrl
        and "setValidateResults({})" in exec_ctrl
        and "abortAuxRequests()" in exec_ctrl)
    report["correctness"]["latest_data_wins_rule"] = (
        "Updated data is more important than cache hits" in rule)

    report["ok"] = all(bool(v) for v in report["correctness"].values())
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
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
    try:
        from samql_core import BUILD, __version__
        payload["samql_build"] = BUILD
        payload["samql_version"] = __version__
    except Exception:
        pass
    import datetime as _dt
    payload["generated_at"] = _dt.datetime.now(_dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
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
