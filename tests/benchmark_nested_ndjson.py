#!/usr/bin/env python3
r"""Hostile nested NDJSON load / flatten / query performance suite.

Generates a difficult NDJSON fixture at test time (never committed), then
measures and correctness-checks:

1. **Normal DuckDB load** — ``flatten=False``, ``shred=False`` (SamQL default;
   no silent stream-flatten).
2. **Flatten / shred opt-in load** — ``flatten=False``, ``shred=True`` (Load
   modal Flatten toggle → relational explode).
3. **Query** timing after each load (nested-path / array-aware SQL).
4. **Field Explorer** nested discovery via ``Session.table_field_tree`` (same
   backend path the UI uses) — discovery-only (Parquet / table contents must
   not change as a side effect).

Fan-out contract (see ``generate_hostile_nested_ndjson.py``)::

    15 legs × 10 cashflows × 10 adjustments = 1_500 leaf rows / source record
    2_000 source records × 1_500 = **3_000_000** deepest exploded rows

This is a **benchmark / opt-in performance** harness, not a default CI gate.
``--self-test`` runs a small correctness smoke (tiny byte target, few records)
suitable for the build suite. Full 2 GiB / 3M explode::

    python tests/benchmark_nested_ndjson.py
    python tests/benchmark_nested_ndjson.py --output bench-nested.json

Local smoke with a smaller file (still exact fan-out math for chosen records)::

    set SAMQL_PERF_NDJSON_TARGET_BYTES=8000000
    python tests/benchmark_nested_ndjson.py --records 20 --output smoke.json

Cross-cutting note: this suite only adds tests + a generator. It does not
change flatten/shred defaults, Parquet thresholds, concurrent-reads, join
paths, or Field Explorer product code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
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
    EXPLODED_LEAF_ROWS_DEFAULT,
    FANOUT_PER_RECORD,
    RECORD_COUNT_DEFAULT,
    TARGET_BYTES_DEFAULT,
    fanout_math,
    records_from_env,
    target_bytes_from_env,
    write_ndjson,
)
from samql_core import BUILD, __version__, Session  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _collect_names(fields: list[dict[str, Any]]) -> set[str]:
    return {str(f.get("name") or "") for f in fields if f.get("name")}


def _origin_fingerprint(session: Session, table: str) -> dict[str, Any]:
    """Snapshot Parquet / origin identity for discovery-only checks."""
    duck = session.get_duckdb()
    origins = getattr(duck, "table_origins", {}) or {}
    sources = getattr(duck, "table_sources", {}) or {}
    origin = origins.get(table) or sources.get(table)
    info: dict[str, Any] = {
        "table": table,
        "origin": origin,
        "origin_mtime": None,
        "origin_size": None,
        "origin_sha16": None,
    }
    if origin and isinstance(origin, str) and os.path.isfile(origin):
        st = os.stat(origin)
        info["origin_mtime"] = st.st_mtime_ns
        info["origin_size"] = st.st_size
        # Hash only the first/last 64 KiB — enough to catch mutation without
        # reading multi-GB Parquet into RAM.
        h = hashlib.sha256()
        with open(origin, "rb") as fh:
            head = fh.read(65536)
            h.update(head)
            if st.st_size > 131072:
                fh.seek(-65536, os.SEEK_END)
                h.update(fh.read(65536))
            else:
                h.update(fh.read())
        info["origin_sha16"] = h.hexdigest()[:16]
    # In-engine row count + column list as a second mutation signal.
    try:
        cols = list((duck.table_columns or {}).get(table) or [])
    except Exception:
        cols = []
    info["columns"] = cols
    try:
        n = session.run_query(
            "SELECT COUNT(*) FROM %s" % _q(table),
            target="__duckdb__",
        )["rows"][0][0]
        info["rows"] = int(n)
    except Exception as exc:
        info["rows_error"] = str(exc)
    return info


def _field_tree_all(session: Session, table: str,
                    budget_sec: float = 25.0) -> dict[str, Any]:
    """Call table_field_tree with resume until complete (UI resume path)."""
    fields: list[dict[str, Any]] = []
    after = None
    rounds = 0
    partial = True
    last: dict[str, Any] = {}
    while partial and rounds < 64:
        rounds += 1
        last = session.table_field_tree(
            "duckdb", table, after=after, budget_sec=budget_sec)
        if last.get("error"):
            return last
        chunk = list(last.get("fields") or [])
        if after:
            # Resume returns remaining columns; keep prior rows.
            fields.extend(chunk)
        else:
            fields = chunk
        partial = bool(last.get("partial"))
        after = last.get("next_after")
        if not partial:
            break
        if after is None:
            break
    out = dict(last)
    out["fields"] = fields
    out["resume_rounds"] = rounds
    return out


def _assert_expected_fields(tree_names: set[str], *, context: str) -> list[str]:
    missing = sorted(EXPECTED_FIELD_NAMES - tree_names)
    # Irregular keys are optional — only fail if *core* expected set missing.
    if missing:
        raise AssertionError(
            "%s missing nested/array field names: %r (have %d names)"
            % (context, missing[:40], len(tree_names)))
    return missing


def _count(session: Session, table: str) -> int:
    r = session.run_query(
        "SELECT COUNT(*) FROM %s" % _q(table), target="__duckdb__")
    if r.get("error"):
        raise RuntimeError(r["error"])
    return int(r["rows"][0][0])


def _shred_table_names(loaded: list[dict[str, Any]], base: str) -> set[str]:
    names: set[str] = set()
    for item in loaded:
        n = item.get("name") or item.get("table")
        if n:
            names.add(n)
        for child in (item.get("shredded") or []):
            if child:
                names.add(child)
    # Flatten may replace the base table with <base>_flattened hub.
    names.add(base)
    names.add(base + "_flattened")
    names.add(base + "__root")
    return {n for n in names if n}


def _pick_root_and_leaf(session: Session, loaded: list[dict[str, Any]],
                        base: str, records: int) -> tuple[str, int, str, int]:
    """Return (root_name, root_rows, leaf_name, leaf_rows) after shred."""
    names = _shred_table_names(loaded, base)
    counts: dict[str, int] = {}
    for n in sorted(names):
        try:
            counts[n] = _count(session, n)
        except Exception:
            continue
    if not counts:
        raise AssertionError("no countable shredded tables from %r" % names)

    # Root / hub: prefer exact source-record cardinality.
    root_candidates = [n for n, c in counts.items() if c == records]
    if base + "_flattened" in root_candidates:
        root_name = base + "_flattened"
    elif base in root_candidates:
        root_name = base
    elif root_candidates:
        root_name = sorted(root_candidates)[0]
    else:
        # Fall back to the smallest positive table (hub-like).
        root_name = min(counts, key=lambda k: (counts[k], k))
    root_n = counts[root_name]

    # Prefer the documented deepest fan-out table (legs→cashflows→adjustments).
    adj = [n for n in counts if "adjustments" in n.lower()]
    if adj:
        leaf_name = max(adj, key=lambda k: (counts[k], k))
    else:
        leaf_name = max(counts, key=lambda k: (counts[k], k))
    leaf_n = counts[leaf_name]
    return root_name, root_n, leaf_name, leaf_n


def _table_columns(session: Session, table: str,
                   loaded_item: dict[str, Any] | None = None) -> list[str]:
    cols = list((loaded_item or {}).get("columns") or [])
    if cols:
        return cols
    try:
        duck = session.get_duckdb()
        return list((duck.table_columns or {}).get(table) or [])
    except Exception:
        return []


def _is_json_column_shape(cols: list[str]) -> bool:
    """Large-file flatten-off may fall back to a single ``json`` column."""
    low = [c.lower() for c in cols]
    return low == ["json"] or (len(low) == 1 and low[0] == "json")


def _nested_queries_flatten_off(session: Session, table: str,
                                cols: list[str] | None = None) -> dict[str, Any]:
    """Representative queries against a nested (flatten-off) DuckDB table."""
    out: dict[str, Any] = {}
    cols = cols if cols is not None else _table_columns(session, table)
    json_shape = _is_json_column_shape(cols)
    out["shape"] = "json-column" if json_shape else "struct-columns"

    q_count = "SELECT COUNT(*) AS n FROM %s" % _q(table)
    r, ms = timed(lambda: session.run_query(q_count, target="__duckdb__"))
    if r.get("error"):
        raise RuntimeError(r["error"])
    out["count"] = {"ms": round(ms, 3), "rows": int(r["rows"][0][0])}

    if json_shape:
        q_book = (
            "SELECT COUNT(*) FROM %s WHERE "
            "CAST(json->>'book' AS VARCHAR) = 'HOSTILE-00'" % _q(table)
        )
        probes = [
            ("json_legs_present",
             "SELECT COUNT(*) FROM %s WHERE "
             "json_type(json->'legs') = 'ARRAY'" % _q(table)),
            ("json_deep_leaf",
             "SELECT COUNT(*) FROM %s WHERE "
             "json->>'$.deep.l2.l3.l4.l5_leaf' IS NOT NULL" % _q(table)),
            ("json_rec_id",
             "SELECT COUNT(*) FROM %s WHERE "
             "CAST(json->>'rec_id' AS INTEGER) >= 0" % _q(table)),
        ]
    else:
        q_book = (
            "SELECT COUNT(*) FROM %s WHERE book = 'HOSTILE-00'" % _q(table)
        )
        probes = [
            ("struct_leg_len",
             "SELECT COUNT(*) FROM %s WHERE len(legs) > 0" % _q(table)),
            ("struct_deep_leaf",
             "SELECT COUNT(*) FROM %s WHERE "
             "deep.l2.l3.l4.l5_leaf IS NOT NULL" % _q(table)),
            ("list_extract_leg",
             "SELECT COUNT(*) FROM %s WHERE "
             "legs[1].leg_id IS NOT NULL" % _q(table)),
        ]

    r, ms = timed(lambda: session.run_query(q_book, target="__duckdb__"))
    if r.get("error"):
        raise RuntimeError("book filter failed: %s" % r["error"])
    out["filter_book"] = {"ms": round(ms, 3), "rows": int(r["rows"][0][0])}

    for label, sql in probes:
        r, ms = timed(lambda sql=sql: session.run_query(sql, target="__duckdb__"))
        out[label] = {
            "ms": round(ms, 3),
            "ok": not bool(r.get("error")),
            "error": r.get("error"),
            "rows": (int(r["rows"][0][0])
                     if not r.get("error") and r.get("rows") else None),
        }
    probe_keys = [p[0] for p in probes]
    if not any(out[k]["ok"] for k in probe_keys):
        raise AssertionError(
            "no nested-path query succeeded on flatten-off table: %r" % out)
    return out


def _nested_queries_shredded(session: Session, leaf_table: str,
                             root_table: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    q_leaf = "SELECT COUNT(*) FROM %s" % _q(leaf_table)
    r, ms = timed(lambda: session.run_query(q_leaf, target="__duckdb__"))
    if r.get("error"):
        raise RuntimeError(r["error"])
    out["leaf_count"] = {"ms": round(ms, 3), "rows": int(r["rows"][0][0])}

    # Sample aggregate on the exploded leaf (type/delta columns when present).
    cols = []
    try:
        duck = session.get_duckdb()
        cols = [c.lower() for c in (duck.table_columns or {}).get(leaf_table) or []]
    except Exception:
        pass
    if "delta" in cols:
        sql = ("SELECT COUNT(*), AVG(delta) FROM %s "
               "WHERE delta IS NOT NULL" % _q(leaf_table))
        r, ms = timed(lambda: session.run_query(sql, target="__duckdb__"))
        out["agg_delta"] = {
            "ms": round(ms, 3),
            "ok": not bool(r.get("error")),
            "error": r.get("error"),
        }
    q_root = "SELECT COUNT(*) FROM %s" % _q(root_table)
    r, ms = timed(lambda: session.run_query(q_root, target="__duckdb__"))
    if r.get("error"):
        raise RuntimeError(r["error"])
    out["root_count"] = {"ms": round(ms, 3), "rows": int(r["rows"][0][0])}
    return out


def _fixture_usable(path: Path, records: int, target_bytes: int) -> bool:
    if not path.is_file():
        return False
    try:
        if path.stat().st_size < int(target_bytes):
            return False
        with path.open("rb") as fh:
            lines = sum(1 for _ in fh)
        return lines == int(records)
    except OSError:
        return False


def run_suite(
    *,
    records: int,
    target_bytes: int,
    work_dir: Path,
    keep_file: bool = False,
    exploded_tolerance: float = 0.0,
    reuse_fixture: bool = True,
) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"skipped": "duckdb is not installed"}

    math = fanout_math(records)
    expected_leaf = math["exploded_leaf_rows"]
    ndjson_path = work_dir / "hostile_nested.ndjson"

    reused = False
    if reuse_fixture and _fixture_usable(ndjson_path, records, target_bytes):
        reused = True
        gen_ms = 0.0
        with ndjson_path.open("rb") as fh:
            lines = sum(1 for _ in fh)
        gen_stats = {
            "path": str(ndjson_path.resolve()),
            "records": records,
            "lines": lines,
            "bytes": ndjson_path.stat().st_size,
            "target_bytes": int(target_bytes),
            "reused": True,
            **math,
            "expected_field_names": sorted(EXPECTED_FIELD_NAMES),
        }
    else:
        gen_stats, gen_ms = timed(
            lambda: write_ndjson(
                ndjson_path, records=records, target_bytes=target_bytes))
    if gen_stats["lines"] != records:
        raise AssertionError("generator line count %s != %s"
                             % (gen_stats["lines"], records))
    if gen_stats["bytes"] < target_bytes:
        raise AssertionError("generator size %s < target %s"
                             % (gen_stats["bytes"], target_bytes))

    report: dict[str, Any] = {
        "schema_version": 1,
        "fixture": gen_stats,
        "generate_ms": round(gen_ms, 3),
        "fixture_reused": reused,
        "fanout": math,
        "timings_ms": {},
        "correctness": {},
    }

    # ---- 1) Normal DuckDB load (flatten/shred OFF) ----
    s_off = Session()
    s_off.flatten_on_load = False
    try:
        loaded_off, load_off_ms = timed(
            lambda: s_off.load_file(
                str(ndjson_path), destination="duckdb",
                base_name="hostile_off",
                flatten=False, shred=False))
        report["timings_ms"]["load_flatten_off"] = round(load_off_ms, 3)
        if not loaded_off:
            raise AssertionError("flatten-off load returned nothing")
        root_off = loaded_off[0].get("name") or loaded_off[0].get("table")
        report["correctness"]["flatten_off_tables"] = [
            t.get("name") for t in loaded_off]
        if len(loaded_off) != 1:
            raise AssertionError(
                "flatten-off must stay one catalog table, got %r"
                % report["correctness"]["flatten_off_tables"])
        n_off = _count(s_off, root_off)
        if n_off != records:
            raise AssertionError(
                "flatten-off row count %s != source records %s"
                % (n_off, records))
        report["correctness"]["flatten_off_rows"] = n_off

        # Top-level columns: small files expand keys; multi-GB flatten-off may
        # fall back to a single JSON column (depth=0) — both are valid.
        cols = _table_columns(s_off, root_off, loaded_off[0])
        report["correctness"]["flatten_off_columns"] = cols
        report["correctness"]["flatten_off_json_depth"] = loaded_off[0].get(
            "json_depth")
        json_shape = _is_json_column_shape(cols)
        report["correctness"]["flatten_off_shape"] = (
            "json-column" if json_shape else "struct-columns")
        if not json_shape:
            for must in ("rec_id", "legs", "deep", "meta", "contacts", "tags"):
                if must not in cols and must.lower() not in [
                        c.lower() for c in cols]:
                    raise AssertionError(
                        "flatten-off missing top-level column %r in %r"
                        % (must, cols))
        else:
            need_json = any(c.lower() == "json" for c in cols)
            if not need_json:
                raise AssertionError(
                    "expected single json column on large-file flatten-off, "
                    "got %r" % cols)

        # Field Explorer discovery (UI path) + discovery-only fingerprint.
        fp_before = _origin_fingerprint(s_off, root_off)
        tree, fe_ms = timed(
            lambda: _field_tree_all(s_off, root_off, budget_sec=25.0))
        report["timings_ms"]["field_explorer_flatten_off"] = round(fe_ms, 3)
        if tree.get("error"):
            raise AssertionError("table_field_tree error: %s" % tree["error"])
        names = _collect_names(list(tree.get("fields") or []))
        _assert_expected_fields(names, context="Field Explorer (flatten-off)")
        report["correctness"]["field_explorer_names"] = sorted(names)
        report["correctness"]["field_explorer_field_count"] = len(names)
        report["correctness"]["field_explorer_partial"] = bool(
            tree.get("partial"))
        fp_after = _origin_fingerprint(s_off, root_off)
        if fp_before.get("origin_mtime") != fp_after.get("origin_mtime"):
            raise AssertionError(
                "Field Explorer mutated origin mtime (not discovery-only): "
                "%r -> %r" % (fp_before, fp_after))
        if fp_before.get("origin_size") != fp_after.get("origin_size"):
            raise AssertionError(
                "Field Explorer mutated origin size (not discovery-only)")
        if fp_before.get("origin_sha16") and (
                fp_before.get("origin_sha16") != fp_after.get("origin_sha16")):
            raise AssertionError(
                "Field Explorer mutated Parquet bytes (not discovery-only)")
        if fp_before.get("rows") != fp_after.get("rows"):
            raise AssertionError(
                "Field Explorer changed table row count (not discovery-only)")
        if fp_before.get("columns") != fp_after.get("columns"):
            raise AssertionError(
                "Field Explorer changed column list (not discovery-only)")
        report["correctness"]["discovery_only"] = True

        q_off, q_off_ms = timed(
            lambda: _nested_queries_flatten_off(s_off, root_off, cols))
        report["timings_ms"]["queries_flatten_off"] = round(q_off_ms, 3)
        report["queries_flatten_off"] = q_off
    finally:
        s_off.shutdown()

    # ---- 2) Flatten method (shred opt-in) ----
    s_on = Session()
    s_on.flatten_on_load = False  # per-load shred=True is the UI Flatten path
    try:
        loaded_on, load_on_ms = timed(
            lambda: s_on.load_file(
                str(ndjson_path), destination="duckdb",
                base_name="hostile_flat",
                flatten=False, shred=True))
        report["timings_ms"]["load_flatten_shred"] = round(load_on_ms, 3)
        if not loaded_on:
            raise AssertionError("shred load returned nothing")
        base_on = loaded_on[0].get("name") or loaded_on[0].get("table")
        shredded = list(loaded_on[0].get("shredded") or [])
        report["correctness"]["shred_tables"] = shredded
        if not shredded:
            # Some builds attach child tables as extra load results.
            extra = [t.get("name") for t in loaded_on[1:]]
            report["correctness"]["shred_tables_extra"] = extra
            if len(loaded_on) < 2 and not extra:
                raise AssertionError(
                    "shred=True produced no relational child tables: %r"
                    % loaded_on)

        root_on, root_n, leaf_name, leaf_n = _pick_root_and_leaf(
            s_on, loaded_on, base_on, records)
        report["correctness"]["shred_root_table"] = root_on
        report["correctness"]["shred_root_rows"] = root_n
        report["correctness"]["exploded_leaf_table"] = leaf_name
        report["correctness"]["exploded_leaf_rows"] = leaf_n
        safe_counts = {}
        for n in sorted(_shred_table_names(loaded_on, base_on)):
            try:
                safe_counts[n] = _count(s_on, n)
            except Exception:
                pass
        report["correctness"]["shred_table_counts"] = safe_counts
        tol = max(0.0, float(exploded_tolerance))
        lo = int(expected_leaf * (1.0 - tol))
        hi = int(expected_leaf * (1.0 + tol)) if tol else expected_leaf
        if tol == 0.0:
            if leaf_n != expected_leaf:
                raise AssertionError(
                    "exploded leaf rows %s != expected exact %s "
                    "(fan-out %d×%d×%d × %d records); leaf=%r"
                    % (leaf_n, expected_leaf,
                       math["fanout_legs"], math["fanout_cashflows"],
                       math["fanout_adjustments"], records, leaf_name))
        elif not (lo <= leaf_n <= hi):
            raise AssertionError(
                "exploded leaf rows %s outside tolerance [%s, %s] "
                "(expected ~%s)" % (leaf_n, lo, hi, expected_leaf))

        # Shredded tables must surface adjustment / leg fields as columns.
        duck = s_on.get_duckdb()
        all_cols: set[str] = set()
        for tname in {root_on, leaf_name, *shredded}:
            for c in (duck.table_columns or {}).get(tname) or []:
                all_cols.add(str(c))
                all_cols.add(str(c).lower())
        for must in ("adj_type", "delta", "note", "leg_id", "cf_id"):
            if must not in all_cols and must.lower() not in all_cols:
                # Column may be nested under a different sanitize — accept
                # case-insensitive substring match across shredded DESCRIBE.
                blob = " ".join(sorted(all_cols)).lower()
                if must.lower() not in blob:
                    raise AssertionError(
                        "shredded tables missing field %r in columns %r"
                        % (must, sorted(all_cols)[:80]))

        # FE on the root nested table still lists nested names (discovery).
        if root_on:
            tree_on, fe_on_ms = timed(
                lambda: _field_tree_all(s_on, root_on, budget_sec=25.0))
            report["timings_ms"]["field_explorer_after_shred"] = round(
                fe_on_ms, 3)
            if not tree_on.get("error"):
                names_on = _collect_names(list(tree_on.get("fields") or []))
                # After shred, root may be a hub with fewer nested types;
                # require a solid core rather than the full pre-shred set.
                core = {"rec_id", "book", "legs", "deep", "meta"}
                missing_core = sorted(core - names_on)
                report["correctness"]["field_explorer_after_shred_names"] = (
                    sorted(names_on))
                if missing_core:
                    # Hub tables sometimes inline scalars only — record, don't
                    # fail the explode contract if leaf columns already verified.
                    report["correctness"][
                        "field_explorer_after_shred_missing_core"] = missing_core

        q_on, q_on_ms = timed(
            lambda: _nested_queries_shredded(s_on, leaf_name, root_on))
        report["timings_ms"]["queries_flatten_shred"] = round(q_on_ms, 3)
        report["queries_flatten_shred"] = q_on
        if q_on["root_count"]["rows"] != records:
            raise AssertionError(
                "shred root rows %s != %s" % (q_on["root_count"]["rows"],
                                             records))
    finally:
        s_on.shutdown()

    if not keep_file:
        try:
            ndjson_path.unlink()
        except OSError:
            pass

    report["ok"] = True
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--records", type=int, default=None,
                    help="source NDJSON records (default %d)"
                    % RECORD_COUNT_DEFAULT)
    ap.add_argument("--target-bytes", type=int, default=None,
                    help="minimum fixture size (default %d / env override)"
                    % TARGET_BYTES_DEFAULT)
    ap.add_argument("--work-dir", default=None,
                    help="directory for generated NDJSON (default: temp)")
    ap.add_argument("--keep-file", action="store_true",
                    help="do not delete the generated NDJSON after the run")
    ap.add_argument("--output", help="write JSON report to this path")
    ap.add_argument("--self-test", action="store_true",
                    help="small correctness smoke (not the 2 GiB / 3M run)")
    ap.add_argument("--exploded-tolerance", type=float, default=0.0,
                    help="relative tolerance on exploded leaf rows "
                         "(default 0 = exact 3M for full defaults)")
    args = ap.parse_args(argv)

    if args.self_test:
        # Tiny file, few records — still exact fan-out for those records.
        # 2 records × 1500 = 3000 exploded leaf rows; ~1 MiB target.
        records = 2
        target_bytes = 1_000_000
        tolerance = 0.0
    else:
        records = (args.records if args.records is not None
                   else records_from_env())
        target_bytes = (args.target_bytes if args.target_bytes is not None
                        else target_bytes_from_env())
        tolerance = float(args.exploded_tolerance)

    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_nested_perf_"))
    work.mkdir(parents=True, exist_ok=True)
    own_work = args.work_dir is None

    try:
        result = run_suite(
            records=records,
            target_bytes=target_bytes,
            work_dir=work,
            keep_file=args.keep_file or bool(args.work_dir),
            exploded_tolerance=tolerance,
        )
    finally:
        if own_work and not args.keep_file:
            shutil.rmtree(work, ignore_errors=True)

    envelope = {
        "schema_version": 1,
        "samql_version": __version__,
        "samql_build": BUILD,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "mode": "self-test" if args.self_test else "performance",
        "defaults": {
            "record_count": RECORD_COUNT_DEFAULT,
            "target_bytes": TARGET_BYTES_DEFAULT,
            "exploded_leaf_rows": EXPLODED_LEAF_ROWS_DEFAULT,
            "fanout_per_record": FANOUT_PER_RECORD,
        },
        "result": result,
    }
    text = json.dumps(envelope, indent=2, sort_keys=True)
    print(text)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")

    if result.get("skipped"):
        print("SKIP: %s" % result["skipped"], file=sys.stderr)
        return 0
    if not result.get("ok"):
        return 1
    if args.self_test:
        # Tight checks for the build-gate smoke.
        math = result["fanout"]
        if math["exploded_leaf_rows"] != 2 * FANOUT_PER_RECORD:
            raise SystemExit("self-test fan-out math wrong")
        if result["correctness"].get("exploded_leaf_rows") != math[
                "exploded_leaf_rows"]:
            raise SystemExit("self-test explode count wrong")
        if not result["correctness"].get("discovery_only"):
            raise SystemExit("self-test discovery-only failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
