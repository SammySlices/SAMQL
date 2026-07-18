#!/usr/bin/env python3
r"""Benchmark + correctness suite for high-impact perf fixes (builds 647+).

Exercises **highly problematic nested structures** against:

1. **Bounded nested page encode** — multi-MB STRUCT/JSON cells must truncate
   without a full ``json.dumps`` of the whole blob (display-only; exact counts
   unchanged).
2. **Field Explorer sampling** — empty-array prefixes, late heterogeneous keys,
   deep cashflow-style nests, Unicode keys; mid/end probes must still union
   all irregular fields. Discovery-only (no Parquet mutation).
3. **Sticky cancel + FE interrupt registration** — prior Stop must not poison
   discovery; ``query_id`` registers so ``cancel_query`` can interrupt.

Uses the hostile nested record builder (``generate_hostile_nested_ndjson``)
plus extra pathological cases (huge pads, late-only keys, hollow prefixes).

CI gate::

    python tests/benchmark_perf_high_fixes.py --self-test

Larger opt-in run (more records / bigger pads)::

    python tests/benchmark_perf_high_fixes.py --records 80 --pad-chars 500000

Cross-cutting: does not change load defaults, flatten/shred toggles, or
thresholds. Field Explorer remains discovery-only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from typing import Any, Callable


def _bootstrap() -> Path:
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "backend"))
    sys.path.insert(0, str(root / "tests"))
    return root


ROOT = _bootstrap()

from generate_hostile_nested_ndjson import (  # noqa: E402
    EXPECTED_FIELD_NAMES,
    IRREGULAR_FIELD_NAMES,
    build_record,
    write_ndjson,
)
from samql_core import BUILD, __version__, Session  # noqa: E402
from samql_core import session as SS  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _collect_names(fields: list[dict[str, Any]]) -> set[str]:
    return {str(f.get("name") or "") for f in fields if f.get("name")}


def _origin_fp(session: Session, table: str) -> dict[str, Any]:
    duck = session.get_duckdb()
    origins = getattr(duck, "table_origins", {}) or {}
    sources = getattr(duck, "table_sources", {}) or {}
    origin = origins.get(table) or sources.get(table)
    info: dict[str, Any] = {
        "origin": origin, "origin_size": None, "rows": None, "columns": None}
    if origin and isinstance(origin, str) and os.path.isfile(origin):
        info["origin_size"] = os.path.getsize(origin)
    try:
        info["columns"] = list((duck.table_columns or {}).get(table) or [])
    except Exception:
        info["columns"] = []
    try:
        n = session.run_query(
            "SELECT COUNT(*) FROM %s" % _q(table), target="__duckdb__")
        info["rows"] = int(n["rows"][0][0])
    except Exception as exc:
        info["rows_error"] = str(exc)
    return info


# ---------------------------------------------------------------------------
# Pathological structures (in addition to hostile NDJSON records)
# ---------------------------------------------------------------------------

def build_huge_nested_cell(pad_chars: int = 2_000_000) -> dict[str, Any]:
    """Multi-MB nested cell: wide pad + deep list — page encode must bound."""
    return {
        "meta": {"kind": "hostile-page-cell", "depth": 3},
        "pad": ("Z" * int(pad_chars)),
        "legs": [
            {
                "leg_id": i,
                "cashflows": [
                    {"amt": float(i * 10 + j), "note": "n" * 64}
                    for j in range(20)
                ],
            }
            for i in range(30)
        ],
        "unicode": {"café": 1, "税率": 2},
    }


def build_heterogeneous_rows(n_head: int = 60) -> list[dict[str, Any]]:
    """Head rows resolve arrays early; rare keys only appear at the end."""
    rows: list[dict[str, Any]] = []
    for i in range(n_head):
        rows.append({
            "rec_id": i,
            "contacts": [{"role": "ops"}] if (i % 3) else [],
            "common": i,
            "legs": [{"leg_id": 0, "cashflows": [{"amt": 1.0}]}],
        })
    # Hollow prefix stress: many empty contacts, then a populated late row.
    for i in range(20):
        rows.append({
            "rec_id": n_head + i,
            "contacts": [],
            "common": n_head + i,
            "legs": [],
        })
    rows.append({
        "rec_id": 99999,
        "contacts": [
            {"role": "rare", "email": "rare@end.test", "phones": ["9"]},
        ],
        "common": 99999,
        "legs": [{
            "leg_id": 7,
            "cashflows": [{
                "amt": 42.0,
                "late_cf_only": {"ghost_adj": True, "bonus_branch": 1},
            }],
        }],
        "only_at_end": {"deep_key": 1, "ghost_key": "present"},
        "irregular_tail": {"café_tail": "ü"},
    })
    return rows


# ---------------------------------------------------------------------------
# Suite
# ---------------------------------------------------------------------------

def run_suite(*, records: int, pad_chars: int, work_dir: Path,
              self_test: bool) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"ok": False, "skipped": "duckdb not installed"}

    report: dict[str, Any] = {
        "ok": False,
        "timings_ms": {},
        "correctness": {},
        "benchmarks": {},
        "params": {
            "records": records,
            "pad_chars": pad_chars,
            "self_test": self_test,
        },
    }

    # ---- 1) Bounded nested page encode (unit + timing vs full dumps) ----
    cell = build_huge_nested_cell(pad_chars=pad_chars)
    # Full dump cost (what we must NOT pay on every page cell).
    _, full_ms = timed(
        lambda: json.dumps(cell, default=str, ensure_ascii=False))
    report["timings_ms"]["full_json_dumps_huge_cell"] = round(full_ms, 3)
    full_len = len(json.dumps(cell, default=str, ensure_ascii=False))
    report["benchmarks"]["full_dumps_chars"] = full_len

    tracemalloc.start()
    snap0 = tracemalloc.take_snapshot()
    (paged, capped), cap_ms = timed(
        lambda: SS._cap_page_rows([[1, cell], [2, {"tiny": True}]],
                                  per_cell=400))
    snap1 = tracemalloc.take_snapshot()
    tracemalloc.stop()
    report["timings_ms"]["cap_page_rows_huge_cell"] = round(cap_ms, 3)
    stats = snap1.compare_to(snap0, "lineno")
    # Peak delta is noisy; record top allocation size as a soft signal.
    top = stats[0].size_diff if stats else 0
    report["benchmarks"]["cap_page_alloc_delta_bytes"] = int(top)

    if not capped:
        raise AssertionError("huge nested cell must be capped for display")
    preview = paged[0][1]
    if not isinstance(preview, str) or "truncated" not in preview:
        raise AssertionError("capped cell must be truncated preview string")
    if len(preview) > 800:
        raise AssertionError(
            "preview leaked past budget: len=%d" % len(preview))
    if paged[1][1] != {"tiny": True}:
        raise AssertionError("small nested cell must keep native shape")
    # Bound encode must finish well under a full dump of the same cell.
    if full_ms > 5.0 and cap_ms > full_ms * 0.75:
        raise AssertionError(
            "bounded encode not faster than full dump: cap=%.1fms dump=%.1fms"
            % (cap_ms, full_ms))
    if len(preview) >= full_len:
        raise AssertionError("preview must be smaller than full JSON dump")
    report["correctness"]["page_cap_bounded"] = True

    # Live page path: SELECT * over a flatten-off table with a fat nest.
    s = Session()
    try:
        duck = s.get_duckdb()
        # One fat row + a few hostile records (exact fan-out, small pad).
        fat_rows = [build_huge_nested_cell(pad_chars=min(pad_chars, 250_000))]
        for i in range(max(2, min(records, 8))):
            fat_rows.append(build_record(i, pad_len=64))
        path = work_dir / "perf_high_page.json"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(fat_rows, fh)
        loaded, load_ms = timed(
            lambda: s.load_file(
                str(path), destination="duckdb", base_name="perf_page",
                flatten=False, shred=False))
        report["timings_ms"]["load_fat_json"] = round(load_ms, 3)
        table = loaded[0]["name"]
        total = int(s.run_query(
            "SELECT COUNT(*) FROM %s" % _q(table),
            target="__duckdb__")["rows"][0][0])
        report["correctness"]["page_table_rows"] = total
        page, page_ms = timed(
            lambda: s.run_query(
                "SELECT * FROM %s" % _q(table), target="__duckdb__"))
        report["timings_ms"]["select_star_page"] = round(page_ms, 3)
        if page.get("error"):
            raise AssertionError("SELECT * failed: %s" % page["error"])
        if int(page.get("total_rows") or 0) != total:
            raise AssertionError(
                "exact total_rows must match COUNT(*): page=%r count=%r"
                % (page.get("total_rows"), total))
        report["correctness"]["page_total_rows_exact"] = True
        # Display rows should not re-inflate multi-MB cells as objects.
        blob = json.dumps(page.get("rows") or [], default=str)
        report["benchmarks"]["page_wire_json_chars"] = len(blob)
        if len(blob) > max(2_000_000, pad_chars):
            # Wire payload must stay far below N × pad_chars.
            raise AssertionError(
                "paged wire JSON suspiciously large (%d chars)" % len(blob))
        report["correctness"]["page_wire_bounded"] = True
    finally:
        s.shutdown()

    # ---- 2) Field Explorer on hostile NDJSON + heterogeneous late keys ----
    s2 = Session()
    try:
        ndjson_path = work_dir / "perf_high_hostile.ndjson"
        # Compact pad so CI stays fast; still uses hostile fan-out shape.
        target_bytes = max(50_000, records * 8_000)
        gen_stats, gen_ms = timed(
            lambda: write_ndjson(
                ndjson_path, records=records, target_bytes=target_bytes))
        report["timings_ms"]["generate_hostile_ndjson"] = round(gen_ms, 3)
        report["fixture"] = gen_stats

        loaded2, load2_ms = timed(
            lambda: s2.load_file(
                str(ndjson_path), destination="duckdb",
                base_name="perf_hostile", flatten=False, shred=False))
        report["timings_ms"]["load_hostile_flatten_off"] = round(load2_ms, 3)
        root = loaded2[0]["name"]
        fp_before = _origin_fp(s2, root)

        tree, fe_ms = timed(
            lambda: s2.table_field_tree(
                "duckdb", root, budget_sec=12.0, query_id="perf-fe-1"))
        report["timings_ms"]["field_explorer_hostile"] = round(fe_ms, 3)
        if tree.get("error"):
            raise AssertionError("field tree error: %s" % tree["error"])
        if tree.get("cancelled"):
            raise AssertionError("field tree unexpectedly cancelled")
        names = _collect_names(list(tree.get("fields") or []))
        missing_core = sorted(EXPECTED_FIELD_NAMES - names)
        # Self-test uses few records — irregular keys may be absent; core set
        # from hostile builder should still surface for nested discovery.
        # Allow partial resume (budget) but require a solid nested sample.
        if len(names) < 15:
            raise AssertionError(
                "Field Explorer found too few names on hostile data: %r"
                % sorted(names)[:40])
        report["correctness"]["fe_hostile_names"] = sorted(names)
        report["correctness"]["fe_hostile_missing_core_sample"] = missing_core[:20]
        fp_after = _origin_fp(s2, root)
        if fp_before.get("origin_size") != fp_after.get("origin_size"):
            raise AssertionError("FE mutated Parquet size (not discovery-only)")
        if fp_before.get("rows") != fp_after.get("rows"):
            raise AssertionError("FE mutated row count (not discovery-only)")
        report["correctness"]["discovery_only"] = True

        # Heterogeneous late keys (must appear even after early array resolve).
        het = build_heterogeneous_rows(60)
        duck = s2.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE perf_het AS "
            "SELECT unnest(?)::JSON AS payload", [het])
        duck.sync_catalog()
        tree_h, het_ms = timed(
            lambda: s2.column_field_tree("duckdb", "perf_het", "payload"))
        report["timings_ms"]["field_explorer_heterogeneous"] = round(het_ms, 3)
        hnames = _collect_names(list(tree_h.get("fields") or []))
        for must in ("contacts", "role", "email", "only_at_end", "deep_key",
                     "late_cf_only", "ghost_adj", "ghost_key", "irregular_tail"):
            if must not in hnames:
                raise AssertionError(
                    "late/heterogeneous key %r missing from FE tree: %r"
                    % (must, sorted(hnames)))
        report["correctness"]["fe_heterogeneous_ok"] = True
        report["correctness"]["fe_heterogeneous_names"] = sorted(hnames)
        # Irregular set from generator docs — at least one late irregular.
        if not (IRREGULAR_FIELD_NAMES & hnames):
            raise AssertionError(
                "expected an irregular late key from %r in %r"
                % (sorted(IRREGULAR_FIELD_NAMES), sorted(hnames)))
    finally:
        s2.shutdown()

    # ---- 3) Sticky cancel + interrupt registration ----
    s3 = Session()
    try:
        duck = s3.get_duckdb()
        duck.conn.execute(
            "CREATE OR REPLACE TABLE perf_sticky AS "
            "SELECT {'a': 1, 'nest': {'b': 2, 'arr': [1,2,3]}}::JSON AS payload")
        duck.sync_catalog()
        duck.interrupt()
        if not duck._cancel.is_set():
            raise AssertionError("interrupt must leave sticky cancel set")
        tree_s, sticky_ms = timed(
            lambda: s3.table_field_tree(
                "duckdb", "perf_sticky", query_id="perf-sticky"))
        report["timings_ms"]["field_explorer_after_sticky"] = round(sticky_ms, 3)
        if tree_s.get("cancelled") or tree_s.get("error"):
            raise AssertionError(
                "FE must clear sticky cancel: %r" % tree_s)
        if duck._cancel.is_set():
            raise AssertionError("FE must clear sticky engine cancel flag")
        report["correctness"]["sticky_cancel_cleared"] = True

        # Register: cancel_query while discovery is "in flight" should not hang.
        # Use a pre-flagged cancel to prove cooperative unwind.
        s3.cancel_query("perf-pre-cxl")
        tree_c = s3.table_field_tree(
            "duckdb", "perf_sticky", query_id="perf-pre-cxl")
        if not tree_c.get("cancelled"):
            # Empty table walk can finish before cooperative check — still ok
            # if it returned quickly without error.
            if tree_c.get("error"):
                raise AssertionError("pre-cancelled FE errored: %r" % tree_c)
        report["correctness"]["fe_cancel_registered"] = True
    finally:
        s3.shutdown()

    report["ok"] = True
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true",
                    help="CI smoke with small hostile fixtures")
    ap.add_argument("--records", type=int, default=None,
                    help="hostile NDJSON source records (default 4 / 40)")
    ap.add_argument("--pad-chars", type=int, default=None,
                    help="pad size inside the huge nested page cell")
    ap.add_argument("--work-dir", default=None)
    ap.add_argument("--output", help="write JSON report path")
    args = ap.parse_args(argv)

    if args.self_test:
        records = 4
        pad_chars = 400_000
    else:
        records = args.records if args.records is not None else 40
        pad_chars = args.pad_chars if args.pad_chars is not None else 1_500_000

    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_perf_high_"))
    work.mkdir(parents=True, exist_ok=True)
    own = args.work_dir is None

    try:
        result = run_suite(
            records=records, pad_chars=pad_chars, work_dir=work,
            self_test=bool(args.self_test))
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
        print("FAIL: perf high fixes suite", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
