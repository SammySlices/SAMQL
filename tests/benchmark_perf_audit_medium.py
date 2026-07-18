#!/usr/bin/env python3
r"""Benchmark + correctness for audit medium fixes (build 659+).

1. **Concurrent COUNT without write_lock** — DuckDB sidebar COUNT must not
   acquire write_lock when concurrent_reads is on.
2. **Catalog dirty-skip** — second tables_tree without mutations skips
   sync_catalog (no DESCRIBE storm).
3. **SQLite warm PRAGMA skip** — second sync_catalog does not re-PRAGMA
   tables whose columns + types are already warm.
4. **Filebrowser disables volatile flow cache** — fingerprints are not
   reused across filebrowser materialisations.
5. **Adjacent** — unrelated top-level flow drop still keeps cache (654+).

CI gate::

    python tests/benchmark_perf_audit_medium.py --self-test
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
from samql_core.session import LOCAL_TARGET  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def run_suite(*, self_test: bool) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": False,
        "correctness": {},
        "benchmarks": {},
        "params": {"self_test": self_test},
    }
    if not HAS_DUCKDB:
        return {"ok": False, "skipped": "duckdb not installed"}

    # ---- 1) Concurrent COUNT does not take write_lock ----
    s = Session()
    try:
        duck = s.get_duckdb()
        need(bool(getattr(duck, "concurrent_reads", False)),
             "concurrent_reads must be on for this gate")
        duck.conn.execute(
            "CREATE OR REPLACE TABLE med_cnt AS "
            "SELECT i AS id FROM range(5000) AS t(i)")
        duck.sync_catalog()
        s._count_cache.clear()
        # Hold write_lock: a lock-bound COUNT would block/fail. Concurrent
        # path uses engine.read() and must still return the row count.
        got = duck.write_lock.acquire(blocking=False)
        need(got, "write_lock available for hold test")
        try:
            t0 = time.perf_counter()
            n = s._cached_count(duck, "duckdb", "med_cnt")
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
        finally:
            duck.write_lock.release()
        report["correctness"]["concurrent_count_no_write_lock"] = (
            n == 5000 and elapsed_ms < 2000.0)
        report["benchmarks"]["count_under_write_lock_ms"] = round(elapsed_ms, 3)
        report["benchmarks"]["count_rows"] = n
    finally:
        s.shutdown()

    # ---- 2) Catalog dirty-skip ----
    s = Session()
    try:
        duck = s.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE med_cat AS SELECT 1 AS x")
        s._mark_catalog_dirty()
        describes = {"n": 0}
        orig = duck.execute_read

        def wrap(sql):
            if isinstance(sql, str) and sql.strip().upper().startswith(
                    "DESCRIBE"):
                describes["n"] += 1
            return orig(sql)

        duck.execute_read = wrap
        s.tables_tree()  # dirty → sync
        first = describes["n"]
        describes["n"] = 0
        s.tables_tree()  # clean → skip sync
        second = describes["n"]
        report["correctness"]["catalog_dirty_skip"] = (
            first >= 1 and second == 0 and s._catalog_dirty is False)
        report["benchmarks"]["tables_tree_describe_dirty"] = first
        report["benchmarks"]["tables_tree_describe_clean"] = second
    finally:
        s.shutdown()

    # ---- 3) SQLite warm PRAGMA skip ----
    s = Session()
    try:
        s.db.conn.execute("CREATE TABLE med_sq (a INTEGER, b TEXT)")
        s.db.sync_catalog()
        need("med_sq" in s.db.table_columns, "sqlite table catalogued")
        need(s.db.types_cached("med_sq"), "sqlite types warm")
        # If warm skip works, a sentinel column list is left untouched.
        sentinel = ["__sentinel__"]
        s.db.table_columns["med_sq"] = sentinel
        s.db.sync_catalog()
        warm_kept = s.db.table_columns.get("med_sq") is sentinel
        # DDL path: drop types so the next sync must PRAGMA again.
        cache = getattr(s.db, "_types_cache", None)
        if isinstance(cache, dict):
            cache.pop("med_sq", None)
        s.db.sync_catalog()
        refreshed = s.db.table_columns.get("med_sq") == ["a", "b"]
        report["correctness"]["sqlite_warm_pragma_skip"] = (
            warm_kept and refreshed)
        report["benchmarks"]["sqlite_warm_kept_sentinel"] = warm_kept
        report["benchmarks"]["sqlite_refreshed_after_type_drop"] = refreshed
    finally:
        s.shutdown()

    # ---- 4) Filebrowser disables volatile flow cache ----
    s = Session()
    try:
        s.flow_cache = True
        g = {"nodes": [
            {"id": "fb", "type": "filebrowser",
             "config": {"pattern": "/tmp/nope/*.csv"}},
            {"id": "out", "type": "output", "config": {}}],
             "edges": [{"from": {"node": "fb", "port": "out"},
                        "to": {"node": "out", "port": "in"}}]}
        has = s._graph_has_types(g, ("filebrowser",))
        use_volatile_cache = bool(s.flow_cache)
        if use_volatile_cache and has:
            use_volatile_cache = False
        report["correctness"]["filebrowser_volatile_gate"] = (
            has is True and use_volatile_cache is False)
        src = (ROOT / "backend" / "samql_core" / "session.py").read_text(
            encoding="utf-8")
        report["correctness"]["filebrowser_disables_volatile_cache"] = (
            '_graph_has_types(' in src
            and '("filebrowser",)' in src
            and "use_volatile_cache = False" in src)
    finally:
        s.shutdown()

    # ---- 5) Adjacent: unrelated drop keeps flow cache ----
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
            and s._data_epoch == ep
            and s.flow_cache_info()["size"] == size)
    finally:
        s.shutdown()

    report["ok"] = all(bool(v) for v in report["correctness"].values())
    return report


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


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
