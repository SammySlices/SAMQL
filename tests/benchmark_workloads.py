#!/usr/bin/env python3
r"""Repeatable SamQL workload benchmark.

The harness measures the operations that most affect interactive feel:

* a filtered wide-table query;
* fast preview versus a normal full result;
* a projection-heavy NodeFlow flow;
* warm flow-cache reuse;
* period-over-period analytics.

It uses synthetic deterministic data by default, so results are comparable
between builds and machines. Results are printed as JSON and can also be saved
with ``--output``.

Examples::

    python tests/benchmark_workloads.py --engine both --rows 250000
    python tests/benchmark_workloads.py --engine duckdb --rows 1700000 --output bench.json
    python tests/benchmark_workloads.py --self-test
    python tests/benchmark_workloads.py --input "D:\data\trades.json" --destination duckdb
    python tests/benchmark_workloads.py --input trades.parquet --mode view --output real.json

This is a benchmark, not a tight CI timing assertion. ``--self-test`` is the
small correctness smoke test suitable for a build gate.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable


def _bootstrap() -> Path:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))
    return root


ROOT = _bootstrap()
from samql_core import BUILD, __version__, Session  # noqa: E402


def q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def edge(a: str, ap: str, b: str, bp: str = "in") -> dict[str, Any]:
    return {"from": {"node": a, "port": ap}, "to": {"node": b, "port": bp}}


def timed(fn: Callable[[], Any], iterations: int) -> dict[str, Any]:
    samples: list[float] = []
    last: Any = None
    for _ in range(max(1, iterations)):
        t0 = time.perf_counter()
        last = fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    return {
        "median_ms": round(statistics.median(samples), 3),
        "min_ms": round(min(samples), 3),
        "max_ms": round(max(samples), 3),
        "samples_ms": [round(x, 3) for x in samples],
        "last": last,
    }


class Bench:
    def __init__(self, engine: str, rows: int):
        self.engine = engine
        self.rows = rows
        self.s = Session()
        self.eng = self.s.get_duckdb() if engine == "duckdb" else self.s.db
        self.target = "__duckdb__" if engine == "duckdb" else "__local__"
        self.table = "__samql_bench"

    def close(self) -> None:
        try:
            self.s.shutdown()
        except Exception:
            pass

    def seed(self) -> None:
        self.eng.execute(f"DROP TABLE IF EXISTS {q(self.table)}")
        names = [
            "row_id", "day", "grp", "value", "qty", "unused_text",
            *[f"wide_{i}" for i in range(16)],
        ]
        if self.engine == "duckdb":
            wide = ", ".join(
                "CAST((i * %d) %% 997 AS DOUBLE) AS wide_%d" % (j + 3, j)
                for j in range(16)
            )
            sql = (
                "CREATE TABLE %s AS "
                "SELECT CAST(i AS INTEGER) AS row_id, "
                "CAST(i %% 365 AS INTEGER) AS day, "
                "printf('g%%02d', i %% 20) AS grp, "
                "CAST(((i * 17) %% 10000) / 10.0 AS DOUBLE) AS value, "
                "CAST((i %% 11) + 1 AS INTEGER) AS qty, "
                "'unused-' || CAST(i AS VARCHAR) AS unused_text, %s "
                "FROM range(%d) AS t(i)"
                % (q(self.table), wide, int(self.rows))
            )
            self.eng.execute(sql)
        else:
            cols = [
                "row_id INTEGER", "day INTEGER", "grp VARCHAR", "value DOUBLE",
                "qty INTEGER", "unused_text VARCHAR",
            ] + [f"wide_{i} DOUBLE" for i in range(16)]
            self.eng.execute(f"CREATE TABLE {q(self.table)} ({', '.join(cols)})")
            batch = 10000
            insert = f"INSERT INTO {q(self.table)} VALUES ({','.join(['?'] * len(cols))})"
            conn = self.eng.conn
            for start in range(0, self.rows, batch):
                stop = min(self.rows, start + batch)
                data = []
                for i in range(start, stop):
                    row = [
                        i, i % 365, "g%02d" % (i % 20),
                        float((i * 17) % 10000) / 10.0,
                        (i % 11) + 1, "unused-%d" % i,
                    ]
                    row.extend(float((i * (j + 3)) % 997) for j in range(16))
                    data.append(tuple(row))
                conn.executemany(insert, data)
            try:
                conn.commit()
            except Exception:
                pass
        self.eng.table_columns[self.table] = names
        self.s._invalidate_counts()

    def query(self, preview: int | None = None) -> dict[str, Any]:
        sql = (
            f"SELECT day, grp, value, qty FROM {q(self.table)} "
            "WHERE value >= 250 ORDER BY day, row_id"
        )
        r = self.s.run_query(sql, target=self.target, preview_limit=preview)
        if r.get("error"):
            raise RuntimeError(r["error"])
        return {
            "rows": r.get("total_rows"),
            "preview": bool(r.get("preview")),
            "engine_ms": r.get("elapsed_ms"),
        }

    def flow_graph(self) -> dict[str, Any]:
        return {
            "nodes": [
                {"id": "src", "type": "input", "config": {"table": self.table}},
                {"id": "fx", "type": "formula", "config": {
                    "formulas": [
                        {"name": "notional", "expr": "value * qty"},
                        {"name": "dead_formula", "expr": "wide_15 * 99"},
                    ]}},
                {"id": "flt", "type": "filter", "config": {"condition": "notional > 1000"}},
                {"id": "sum", "type": "summarize", "config": {
                    "group_by": ["day", "grp"],
                    "aggs": [
                        {"col": "notional", "func": "sum", "name": "total"},
                        {"col": "wide_14", "func": "max", "name": "dead_agg"},
                    ]}},
                {"id": "pick", "type": "select", "config": {
                    "fields": [
                        {"name": "day", "keep": True},
                        {"name": "grp", "keep": True},
                        {"name": "total", "keep": True},
                    ]}},
            ],
            "edges": [
                edge("src", "out", "fx"), edge("fx", "out", "flt"),
                edge("flt", "true", "sum"), edge("sum", "out", "pick"),
            ],
        }

    def flow(self, preview: int | None = None) -> dict[str, Any]:
        r = self.s.run_nodeflow(
            self.flow_graph(), "pick", "out",
            preview=preview is not None, preview_limit=preview,
        )
        if r.get("error"):
            raise RuntimeError(r["error"])
        info = self.s.flow_cache_info()
        return {
            "rows": r.get("total_rows"),
            "preview": bool(r.get("preview")),
            "cache_hits": info.get("hits"),
            "cache_misses": info.get("misses"),
            "cache_bytes": info.get("bytes"),
        }

    def period_delta(self) -> dict[str, Any]:
        g = {
            "nodes": [
                {"id": "src", "type": "input", "config": {"table": self.table}},
                {"id": "sum", "type": "summarize", "config": {
                    "group_by": ["day"],
                    "aggs": [{"col": "value", "func": "sum", "name": "daily_value"}],
                }},
                {"id": "delta", "type": "perioddelta", "config": {
                    "value": "daily_value", "order": "day", "mode": "percent",
                    "offset": 1, "out": "change_pct", "partition": [],
                }},
                {"id": "pick", "type": "select", "config": {"fields": [
                    {"name": "day", "keep": True},
                    {"name": "daily_value", "keep": True},
                    {"name": "change_pct", "keep": True},
                ]}},
            ],
            "edges": [
                edge("src", "out", "sum"), edge("sum", "out", "delta"),
                edge("delta", "out", "pick"),
            ],
        }
        r = self.s.run_nodeflow(g, "pick", "out")
        if r.get("error"):
            raise RuntimeError(r["error"])
        return {"rows": r.get("total_rows"), "columns": r.get("columns")}


def run_one(engine: str, rows: int, iterations: int, preview_limit: int = 5000) -> dict[str, Any]:
    b = Bench(engine, rows)
    try:
        seeded = timed(b.seed, 1)
        full = timed(lambda: b.query(None), iterations)
        preview = timed(lambda: b.query(preview_limit), iterations)
        flow_cold = timed(lambda: b.flow(None), 1)
        flow_warm = timed(lambda: b.flow(None), iterations)
        flow_preview = timed(lambda: b.flow(preview_limit), iterations)
        period = timed(b.period_delta, iterations)
        return {
            "engine": engine,
            "rows": rows,
            "seed": seeded,
            "query_full": full,
            "query_preview": {**preview, "limit": preview_limit},
            "flow_cold": flow_cold,
            "flow_warm": flow_warm,
            "flow_preview": {**flow_preview, "limit": preview_limit},
            "period_delta": period,
        }
    finally:
        b.close()



def run_input_file(path: str, destination: str, mode: str, iterations: int,
                   preview_limit: int, date_column: str | None = None,
                   value_column: str | None = None,
                   group_column: str | None = None) -> dict[str, Any]:
    """Benchmark an actual user file without assuming a particular schema.

    The load itself, exact COUNT(*), bounded preview, a projection-only flow,
    and cold/warm aggregate flow are always measured. Period change is added
    when both ``date_column`` and ``value_column`` are supplied.
    """
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError("benchmark input not found: %s" % source)
    s = Session()
    try:
        if destination == "auto":
            destination = s.default_destination()
        if destination == "duckdb" and not s.optional_features().get("duckdb"):
            raise RuntimeError("DuckDB is not installed; choose sqlite or install duckdb")

        loaded: list[dict[str, Any]] = []
        def _load() -> dict[str, Any]:
            nonlocal loaded
            loaded = s.load_file(
                str(source), destination=destination,
                base_name="__samql_real_bench", mode=mode,
            )
            if not loaded:
                raise RuntimeError("the input produced no tables")
            return {"tables": len(loaded), "table": loaded[0].get("name")}

        memory_before = s.memory_usage()
        load_result = timed(_load, 1)
        memory_after_load = s.memory_usage()
        desc = loaded[0]
        table = str(desc.get("name") or "")
        columns = [c.get("name") if isinstance(c, dict) else str(c)
                   for c in (desc.get("columns") or [])]
        columns = [c for c in columns if c]
        if not table or not columns:
            raise RuntimeError("the loaded table has no usable columns")
        target = "__duckdb__" if destination == "duckdb" else "__local__"

        def _query(sql: str, preview: int | None = None) -> dict[str, Any]:
            r = s.run_query(sql, target=target, preview_limit=preview)
            if r.get("error"):
                raise RuntimeError(r["error"])
            return {
                "rows": r.get("total_rows"),
                "preview": bool(r.get("preview")),
                "engine_ms": r.get("elapsed_ms"),
                "first_row": (r.get("rows") or [None])[0],
            }

        count = timed(lambda: _query("SELECT COUNT(*) AS n FROM %s" % q(table)),
                      iterations)
        preview = timed(
            lambda: _query("SELECT * FROM %s" % q(table), preview_limit),
            iterations,
        )

        selected = columns[:min(4, len(columns))]
        graph = {
            "nodes": [
                {"id": "src", "type": "input", "config": {"table": table}},
                {"id": "pick", "type": "select", "config": {"fields": [
                    {"name": c, "keep": True} for c in selected
                ]}},
            ],
            "edges": [edge("src", "out", "pick")],
        }
        def _preview_flow() -> dict[str, Any]:
            r = s.run_nodeflow(graph, "pick", "out", preview_limit=preview_limit)
            if r.get("error"):
                raise RuntimeError(r["error"])
            return {"rows": r.get("total_rows"), "columns": r.get("columns"),
                    "preview": bool(r.get("preview"))}
        projected_preview = timed(_preview_flow, iterations)

        # A tiny aggregate output is safe even for a multi-GB source and gives
        # the reusable flow cache a realistic cold/warm scan to measure.
        aggregate_graph = {
            "nodes": [
                {"id": "src", "type": "input", "config": {"table": table}},
                {"id": "agg", "type": "summarize", "config": {
                    "group_by": [],
                    "aggs": [{"col": selected[0], "func": "count", "name": "row_count"}],
                }},
            ],
            "edges": [edge("src", "out", "agg")],
        }
        def _aggregate_flow() -> dict[str, Any]:
            r = s.run_nodeflow(aggregate_graph, "agg", "out")
            if r.get("error"):
                raise RuntimeError(r["error"])
            info = s.flow_cache_info()
            return {"rows": r.get("rows"), "cache_hits": info.get("hits"),
                    "cache_misses": info.get("misses"), "cache_bytes": info.get("bytes")}
        aggregate_cold = timed(_aggregate_flow, 1)
        aggregate_warm = timed(_aggregate_flow, iterations)

        period = None
        if date_column or value_column:
            if not date_column or not value_column:
                raise ValueError("--date-column and --value-column must be supplied together")
            missing = [c for c in (date_column, value_column, group_column)
                       if c and c not in columns]
            if missing:
                raise ValueError("period columns not found: %s" % ", ".join(missing))
            groups = [date_column] + ([group_column] if group_column else [])
            period_graph = {
                "nodes": [
                    {"id": "src", "type": "input", "config": {"table": table}},
                    {"id": "sum", "type": "summarize", "config": {
                        "group_by": groups,
                        "aggs": [{"col": value_column, "func": "sum", "name": "period_value"}],
                    }},
                    {"id": "delta", "type": "perioddelta", "config": {
                        "value": "period_value", "order": date_column,
                        "partition": ([group_column] if group_column else []),
                        "mode": "percent", "offset": 1, "out": "change_pct",
                    }},
                ],
                "edges": [edge("src", "out", "sum"), edge("sum", "out", "delta")],
            }
            def _period() -> dict[str, Any]:
                r = s.run_nodeflow(period_graph, "delta", "out")
                if r.get("error"):
                    raise RuntimeError(r["error"])
                return {"rows": r.get("total_rows"), "columns": r.get("columns")}
            period = timed(_period, iterations)

        return {
            "input": str(source),
            "input_bytes": source.stat().st_size,
            "destination": destination,
            "mode": mode,
            "table": table,
            "table_rows_reported_at_load": desc.get("rows"),
            "column_count": len(columns),
            "selected_columns": selected,
            "load": load_result,
            "memory_before": memory_before,
            "memory_after_load": memory_after_load,
            "memory_final": s.memory_usage(),
            "count": count,
            "preview": {**preview, "limit": preview_limit},
            "projected_preview": {**projected_preview, "limit": preview_limit},
            "aggregate_cold": aggregate_cold,
            "aggregate_warm": aggregate_warm,
            "period_delta": period,
            "flow_cache": s.flow_cache_info(),
        }
    finally:
        s.shutdown()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engine", choices=("sqlite", "duckdb", "both"), default="both")
    ap.add_argument("--input", help="benchmark a real CSV/JSON/Parquet/Excel file instead of synthetic data")
    ap.add_argument("--destination", choices=("auto", "sqlite", "duckdb"), default="auto")
    ap.add_argument("--mode", choices=("materialize", "view"), default="materialize")
    ap.add_argument("--date-column", help="date/order field for an optional real-data period-change benchmark")
    ap.add_argument("--value-column", help="numeric field for an optional real-data period-change benchmark")
    ap.add_argument("--group-column", help="optional partition field for the period-change benchmark")
    ap.add_argument("--rows", type=int, default=100000)
    ap.add_argument("--iterations", type=int, default=3)
    ap.add_argument("--output", help="write the JSON report to this path")
    ap.add_argument("--self-test", action="store_true", help="small correctness smoke test")
    args = ap.parse_args()
    if args.self_test:
        args.rows = min(max(1000, args.rows), 2500)
        args.iterations = 1
    if args.input and args.self_test:
        ap.error("--input and --self-test are separate modes")
    preview_limit = min(5000, max(100, args.rows // 4)) if args.self_test else 5000
    if args.input:
        report = {
            "schema_version": 1,
            "samql_version": __version__,
            "samql_build": BUILD,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "real_workload": run_input_file(
                args.input, args.destination, args.mode,
                max(1, args.iterations), preview_limit,
                args.date_column, args.value_column, args.group_column,
            ),
        }
        text = json.dumps(report, indent=2, sort_keys=True)
        print(text)
        if args.output:
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        return 0

    engines = [args.engine] if args.engine != "both" else ["sqlite", "duckdb"]
    probe = Session()
    try:
        features = probe.optional_features()
    finally:
        probe.shutdown()
    reports = []
    for engine in engines:
        if engine == "duckdb" and not features.get("duckdb"):
            reports.append({"engine": "duckdb", "skipped": "duckdb is not installed"})
            continue
        result = run_one(engine, max(1, args.rows), max(1, args.iterations), preview_limit)
        if args.self_test:
            for key in ("query_preview", "flow_preview"):
                last = result[key]["last"]
                if not last.get("preview") or int(last.get("rows") or 0) > preview_limit:
                    raise RuntimeError("%s did not enforce preview limit %s" % (key, preview_limit))
        reports.append(result)
    report = {
        "schema_version": 1,
        "samql_version": __version__,
        "samql_build": BUILD,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "results": reports,
    }
    text = json.dumps(report, indent=2, sort_keys=True)
    print(text)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    if args.self_test:
        for r in reports:
            if r.get("skipped"):
                continue
            if not r["query_preview"]["last"].get("preview"):
                raise SystemExit("preview marker missing")
            if r["query_preview"]["last"].get("rows", 0) > r["query_preview"]["limit"]:
                raise SystemExit("preview exceeded its row limit")
            if "change_pct" not in (r["period_delta"]["last"].get("columns") or []):
                raise SystemExit("period-delta output missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
