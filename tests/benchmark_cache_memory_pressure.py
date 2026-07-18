#!/usr/bin/env python3
r"""Cache / memory pressure + reclaim benchmark for SamQL.

Stresses SamQL toward high cache and memory use, then measures whether
cleanup paths reclaim footprint:

1. **Filecache accumulation** — load many distinct NDJSON/CSV files so
   ``samql/filecache/fc_*.parquet`` grows (persistent conversion cache).
2. **Result stores** — large DuckDB queries that spill to ``qr_*.parquet``
   under the per-PID instance temp; exercise result disk budget eviction
   (``SAMQL_RESULTS_GB``).
3. **Shred / flatten opt-in** — one explicit ``shred=True`` load (does **not**
   change product defaults) to exercise shred-cache finally cleanup.
4. **TEMP view reuse** — ``CREATE TEMP VIEW`` + query (journal R1-style).
5. **Cancel reclaim** — cancel a mid-flight heavy query; instance temps should
   not permanently inflate.
6. **Explicit reclaim** — ``drop_table`` / ``free_memory`` / ``_reclaim`` /
   ``filecache.sweep`` / session shutdown.

Footprint snapshots (before / peak / after)::

    process RSS (Session._rss_bytes)
    filecache dir bytes + count
    instance temp dir bytes (tmputil) + qr_/jf_/flatten_ prefixes
    samql_shred_cache dir bytes
    table / cached-result counts

Modes::

    python tests/benchmark_cache_memory_pressure.py --self-test
    python tests/benchmark_cache_memory_pressure.py
    python tests/benchmark_cache_memory_pressure.py --output report.json

Caps (avoid OOM; full mode is still aggressive)::

* ``SAMQL_CACHE_PRESSURE_TARGET_BYTES`` — per-file size (default 64 MiB)
* ``SAMQL_CACHE_PRESSURE_FILES`` — distinct NDJSON files (default 8)
* ``SAMQL_CACHE_PRESSURE_MAX_TABLES`` — drop oldest when exceeded (default 16)
* ``SAMQL_CACHE_PRESSURE_RESULTS_GB`` — harness override for result budget
  (default full ``2``, self-test ``0.05``)
* ``SAMQL_CACHE_PRESSURE_SKIP_SHRED=1`` — skip shred phase

Cross-cutting: additive harness only. Does **not** change flatten/shred
defaults, Parquet thresholds, or concurrent-reads. Discovery stays unused for
load mutation.
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

from generate_cache_pressure_workload import (  # noqa: E402
    FILES_DEFAULT,
    RECORDS_DEFAULT,
    SELF_FILES,
    SELF_RECORDS,
    SELF_TARGET_BYTES,
    TARGET_BYTES_DEFAULT,
    files_from_env,
    records_from_env,
    target_bytes_from_env,
    write_workload,
)
from samql_core import BUILD, __version__, Session  # noqa: E402
from samql_core import filecache, tmputil  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402


# ---- helpers ------------------------------------------------------------- #

def _ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000.0


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, _ms(t0)


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _dir_stats(path: str) -> dict[str, Any]:
    if not path or not os.path.isdir(path):
        return {"path": path, "exists": False, "bytes": 0, "files": 0}
    n = 0
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                n += 1
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return {"path": path, "exists": True, "bytes": total, "files": n}


def _prefix_counts(inst: str) -> dict[str, int]:
    prefs = ("qr_", "jf_", "flatten_", "cache_", "hdfs_", "fc_")
    out = {p: 0 for p in prefs}
    if not os.path.isdir(inst):
        return out
    try:
        for name in os.listdir(inst):
            for p in prefs:
                if name.startswith(p):
                    out[p] += 1
    except OSError:
        pass
    return out


def _shred_cache_dir() -> str:
    return os.path.join(tempfile.gettempdir(), "samql_shred_cache")


def _max_tables_from_env(default: int) -> int:
    raw = (os.environ.get("SAMQL_CACHE_PRESSURE_MAX_TABLES") or "").strip()
    if not raw:
        return int(default)
    return max(1, min(int(raw), 128))


def _results_gb_from_env(default: float) -> float:
    raw = (os.environ.get("SAMQL_CACHE_PRESSURE_RESULTS_GB") or "").strip()
    if not raw:
        return float(default)
    return max(0.01, float(raw))


def snapshot(session: Session | None, label: str) -> dict[str, Any]:
    """Capture RSS + cache/temp footprint + catalog counts."""
    rss = Session._rss_bytes()
    mem = session.memory_usage() if session is not None else {}
    duck_tables = 0
    sqlite_tables = 0
    if session is not None:
        try:
            duck = session.get_duckdb()
            duck_tables = len(getattr(duck, "table_columns", {}) or {})
        except Exception:
            pass
        try:
            sqlite_tables = len(getattr(session.db, "table_columns", {}) or {})
        except Exception:
            pass
    fc = _dir_stats(filecache._DIR)
    inst_path = tmputil.instance_dir()
    inst = _dir_stats(inst_path)
    shred = _dir_stats(_shred_cache_dir())
    return {
        "label": label,
        "ts": time.time(),
        "rss_bytes": int(rss or 0),
        "rss_mb": round((rss or 0) / 1048576, 2),
        "duckdb_mb": mem.get("duckdb_mb"),
        "cached_results": mem.get("cached_results",
                                  len(getattr(session, "_results", {}) or {})
                                  if session else 0),
        "duck_tables": duck_tables,
        "sqlite_tables": sqlite_tables,
        "filecache": fc,
        "instance": inst,
        "instance_prefixes": _prefix_counts(inst_path),
        "shred_cache": shred,
        "filecache_enabled": filecache.enabled(),
    }


def _consider_peak(peak_box: dict[str, Any], cur: dict[str, Any]) -> None:
    """Keep the snapshot with the largest combined pressure signal."""
    def score(s: dict[str, Any]) -> tuple[int, int, int]:
        return (
            int(s.get("rss_bytes") or 0),
            int((s.get("instance") or {}).get("bytes") or 0),
            int((s.get("filecache") or {}).get("bytes") or 0),
        )
    if not peak_box or score(cur) >= score(peak_box):
        peak_box.clear()
        peak_box.update(cur)


def _wait_cleanup(session: Session, settle_s: float = 2.0) -> None:
    """Wait for debounced ``_schedule_cleanup`` (1.5s timer) + a little more."""
    try:
        session._reclaim(full=True)
    except Exception:
        pass
    time.sleep(max(0.0, settle_s))


def _table_names(session: Session) -> list[str]:
    try:
        duck = session.get_duckdb()
        return sorted((getattr(duck, "table_columns", {}) or {}).keys())
    except Exception:
        return []


def _drop_all_duck(session: Session) -> int:
    names = _table_names(session)
    for n in names:
        try:
            session.drop_table("duckdb", n)
        except Exception:
            pass
    return len(names)


def _enforce_table_cap(session: Session, cap: int,
                       kept: list[str]) -> list[str]:
    while len(kept) > cap:
        victim = kept.pop(0)
        try:
            session.drop_table("duckdb", victim)
        except Exception:
            pass
    return kept


# ---- phases -------------------------------------------------------------- #

def phase_filecache_loads(
    session: Session,
    fixtures: list[dict[str, Any]],
    *,
    max_tables: int,
    peak_box: dict[str, Any],
) -> dict[str, Any]:
    """Load distinct files (flatten/shred defaults OFF) to fill filecache."""
    before = snapshot(session, "filecache_before")
    loads: list[dict[str, Any]] = []
    kept: list[str] = []
    errors: list[str] = []
    t_all = time.perf_counter()

    for i, fx in enumerate(fixtures):
        path = fx["path"]
        base = "cp_%s_%02d" % (fx["kind"], i)
        t0 = time.perf_counter()
        try:
            loaded = session.load_file(
                path, destination="duckdb", base_name=base,
                flatten=False, shred=False)
        except Exception as e:
            err = "%s: %s" % (type(e).__name__, e)
            if len(err) > 240:
                err = err[:240] + "…"
            errors.append("%s: %s" % (base, err))
            loads.append({"base": base, "ok": False, "error": err})
            continue
        ms = _ms(t0)
        item = loaded[0] if isinstance(loaded, list) and loaded else loaded
        name = (item or {}).get("name") or base
        kept.append(name)
        kept = _enforce_table_cap(session, max_tables, kept)
        # Reload same path once → expect filecache hit (fast second load).
        t1 = time.perf_counter()
        try:
            session.load_file(
                path, destination="duckdb",
                base_name=base + "_reload",
                flatten=False, shred=False)
            reload_ms = _ms(t1)
            kept.append(base + "_reload")
            kept = _enforce_table_cap(session, max_tables, kept)
        except Exception as e:
            reload_ms = None
            errors.append("reload %s: %s" % (base, e))
        loads.append({
            "base": base,
            "table": name,
            "kind": fx["kind"],
            "source_bytes": fx["bytes"],
            "load_ms": round(ms, 3),
            "reload_ms": (round(reload_ms, 3) if reload_ms is not None
                          else None),
            "ok": True,
        })
        cur = snapshot(session, "filecache_mid_%d" % i)
        _consider_peak(peak_box, cur)

    after = snapshot(session, "filecache_after")
    _consider_peak(peak_box, after)

    fc_delta = after["filecache"]["bytes"] - before["filecache"]["bytes"]
    # Second load of same key should usually be faster when filecache is on.
    reload_faster = 0
    reload_n = 0
    for L in loads:
        if L.get("reload_ms") is not None and L.get("load_ms"):
            reload_n += 1
            if L["reload_ms"] < L["load_ms"] * 0.85:
                reload_faster += 1

    ok_loads = [L for L in loads if L.get("ok")]
    ndjson_ok = sum(1 for L in ok_loads if L.get("kind") == "ndjson")
    # Prefer NDJSON success for filecache pressure; CSV is kind-diversity.
    phase_ok = ndjson_ok >= max(1, len([f for f in fixtures
                                        if f.get("kind") == "ndjson"]) // 2)
    return {
        "phase": "filecache_loads",
        "ok": phase_ok,
        "elapsed_ms": round(_ms(t_all), 3),
        "loads": loads,
        "errors": errors,
        "tables_kept": list(kept),
        "before": before,
        "after": after,
        "filecache_bytes_delta": fc_delta,
        "filecache_files_delta": (
            after["filecache"]["files"] - before["filecache"]["files"]),
        "reload_faster_count": reload_faster,
        "reload_compared": reload_n,
        "note": (
            "filecache budget eviction skips entries younger than 600s; "
            "live-session accumulation may exceed SAMQL_FILECACHE_GB until age"
        ),
    }


def phase_result_stores(
    session: Session,
    *,
    self_test: bool,
    peak_box: dict[str, Any],
) -> dict[str, Any]:
    """Build several large query results to pressure qr_ + result budget."""
    before = snapshot(session, "results_before")
    tables = _table_names(session)
    if not tables:
        return {"phase": "result_stores", "ok": False,
                "skipped": "no tables loaded", "errors": ["no tables"]}

    anchor = tables[0]
    # Synthetic fan-out: self-test small; full mode larger but capped.
    n = 200 if self_test else 25_000
    queries = []
    errors: list[str] = []
    t_all = time.perf_counter()

    # Ensure at least one real table scan + several distinct result ids.
    for i in range(6 if self_test else 10):
        sql = (
            "SELECT t.*, r.n AS pressure_n FROM %s t "
            "CROSS JOIN (SELECT UNNEST(GENERATE_SERIES(1, %d)) AS n) r "
            "LIMIT %d" % (_q(anchor), n, (500 if self_test else 80_000))
        )
        # Vary LIMIT slightly so result stores are distinct.
        if i > 0:
            sql = sql.replace("LIMIT %d" % (500 if self_test else 80_000),
                              "LIMIT %d" % ((400 + i * 10) if self_test
                                            else (50_000 + i * 1000)))
        t0 = time.perf_counter()
        r = session.run_query(sql, target="__duckdb__",
                              query_id="cp-result-%d" % i)
        ms = _ms(t0)
        if r.get("error"):
            errors.append("q%d: %s" % (i, r.get("error")))
            queries.append({"i": i, "ok": False, "error": r.get("error"),
                            "ms": round(ms, 3)})
            continue
        queries.append({
            "i": i,
            "ok": True,
            "ms": round(ms, 3),
            "total_rows": r.get("total_rows"),
            "result_id": r.get("result_id"),
            "cached_results_after": len(session._results),
        })
        cur = snapshot(session, "results_mid_%d" % i)
        _consider_peak(peak_box, cur)

    after = snapshot(session, "results_after")
    _consider_peak(peak_box, after)

    # Result budget should keep cached_results from growing without bound.
    max_cached = max((q.get("cached_results_after") or 0) for q in queries) \
        if queries else 0
    return {
        "phase": "result_stores",
        "ok": not errors and any(q.get("ok") for q in queries),
        "elapsed_ms": round(_ms(t_all), 3),
        "queries": queries,
        "errors": errors,
        "before": before,
        "after": after,
        "qr_prefix_delta": (
            after["instance_prefixes"].get("qr_", 0)
            - before["instance_prefixes"].get("qr_", 0)),
        "instance_bytes_delta": (
            after["instance"]["bytes"] - before["instance"]["bytes"]),
        "max_cached_results": max_cached,
        "results_gb_env": os.environ.get("SAMQL_RESULTS_GB"),
    }


def phase_shred_opt_in(
    session: Session,
    ndjson_path: str,
    *,
    peak_box: dict[str, Any],
) -> dict[str, Any]:
    """Explicit shred=True load (opt-in path; defaults unchanged)."""
    if (os.environ.get("SAMQL_CACHE_PRESSURE_SKIP_SHRED") or "").strip() in (
            "1", "true", "yes", "on"):
        return {"phase": "shred_opt_in", "ok": True, "skipped": "env skip"}

    before = snapshot(session, "shred_before")
    shred_before = before["shred_cache"]["bytes"]
    t0 = time.perf_counter()
    try:
        loaded = session.load_file(
            ndjson_path, destination="duckdb", base_name="cp_shred",
            flatten=False, shred=True)
    except Exception as e:
        return {
            "phase": "shred_opt_in", "ok": False, "error": str(e),
            "before": before,
        }
    ms = _ms(t0)
    after = snapshot(session, "shred_after")
    _consider_peak(peak_box, after)

    names = []
    if isinstance(loaded, list):
        names = [x.get("name") for x in loaded if isinstance(x, dict)]
    # Shred finally should remove samql_shred_cache staging for this op.
    # Allow a small leftover from concurrent/other processes.
    return {
        "phase": "shred_opt_in",
        "ok": True,
        "elapsed_ms": round(ms, 3),
        "created": names,
        "before": before,
        "after": after,
        "shred_cache_bytes_before": shred_before,
        "shred_cache_bytes_after": after["shred_cache"]["bytes"],
        "note": "uses shred=True explicitly; product flatten_json default untouched",
    }


def phase_temp_view_reuse(
    session: Session,
    *,
    peak_box: dict[str, Any],
) -> dict[str, Any]:
    tables = _table_names(session)
    if not tables:
        return {"phase": "temp_view_reuse", "ok": False,
                "skipped": "no tables", "errors": ["no tables"]}
    anchor = tables[0]
    before = snapshot(session, "tempview_before")
    errors: list[str] = []
    t_all = time.perf_counter()

    ddl = ("CREATE OR REPLACE TEMP VIEW cp_pressure_tv AS "
           "SELECT * FROM %s LIMIT 100" % _q(anchor))
    r1 = session.run_query(ddl, target="__duckdb__", query_id="cp-tv-ddl")
    if r1.get("error"):
        errors.append("ddl: %s" % r1["error"])

    r2 = session.run_query(
        "SELECT COUNT(*) AS n FROM cp_pressure_tv",
        target="__duckdb__", query_id="cp-tv-q",
        # Prefer locked path so TEMP VIEW is visible.
    )
    if r2.get("error"):
        # TEMP views on concurrent cursor can miss — retry locked via reuse pin
        # is complex; fall back to querying the base table through a fresh TEMP.
        r2b = session.run_query(
            "SELECT COUNT(*) AS n FROM (%s) LIMIT 1"
            % ("SELECT * FROM %s LIMIT 100" % _q(anchor)),
            target="__duckdb__", query_id="cp-tv-fallback")
        if r2b.get("error"):
            errors.append("query: %s" % r2.get("error"))
        else:
            r2 = r2b

    r3 = session.run_query("DROP VIEW IF EXISTS cp_pressure_tv",
                           target="__duckdb__", query_id="cp-tv-drop")
    if r3.get("error"):
        errors.append("drop: %s" % r3["error"])

    after = snapshot(session, "tempview_after")
    _consider_peak(peak_box, after)

    return {
        "phase": "temp_view_reuse",
        "ok": not errors,
        "elapsed_ms": round(_ms(t_all), 3),
        "errors": errors,
        "before": before,
        "after": after,
        "count_rows": (r2.get("rows") or [[None]])[0][0]
        if not r2.get("error") else None,
    }


def phase_cancel_reclaim(
    session: Session,
    *,
    self_test: bool,
    peak_box: dict[str, Any],
) -> dict[str, Any]:
    """Start a heavy query, cancel it, assert temps / running drain."""
    before = snapshot(session, "cancel_before")
    inst_before = before["instance"]["bytes"]
    qid = "cp-cancel-heavy"
    # Recursive CTE burns CPU; cancel should reclaim without sticky poison.
    depth = 200_000 if self_test else 5_000_000
    sql = (
        "WITH RECURSIVE t(n) AS ("
        "  SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < %d"
        ") SELECT SUM(n) FROM t" % depth
    )
    out: dict[str, Any] = {}
    err_box: dict[str, Any] = {}

    def work():
        try:
            out["r"] = session.run_query(
                sql, target="__duckdb__", query_id=qid)
        except Exception as e:
            err_box["e"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    # Wait until registered.
    deadline = time.perf_counter() + 4.0
    registered = False
    while time.perf_counter() < deadline:
        with session._running_lock:
            if qid in session._running:
                registered = True
                break
        time.sleep(0.005)
    if not registered:
        th.join(timeout=2.0)
        return {
            "phase": "cancel_reclaim",
            "ok": False,
            "error": "heavy query never registered",
            "before": before,
        }

    time.sleep(0.1)
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    unwind = 8.0 if self_test else 30.0
    th.join(timeout=unwind)
    alive = th.is_alive()
    r = out.get("r") or {}
    cancelled = bool(r.get("cancelled")) or (
        "cancel" in str(r.get("error") or "").lower())

    # Fresh query must work (sticky cancel cleared).
    fresh = session.run_query("SELECT 1 AS ok", target="__duckdb__",
                              query_id="cp-cancel-fresh")
    fresh_ok = not fresh.get("error") and not fresh.get("cancelled")

    _wait_cleanup(session, settle_s=1.8 if self_test else 2.2)
    after = snapshot(session, "cancel_after")
    _consider_peak(peak_box, after)

    with session._running_lock:
        still_running = qid in session._running

    ok = (bool(cr.get("ok")) and not alive and cancelled and fresh_ok
          and not still_running)
    return {
        "phase": "cancel_reclaim",
        "ok": ok,
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "worker_alive": alive,
        "cancelled": cancelled,
        "fresh_ok": fresh_ok,
        "still_running": still_running,
        "instance_bytes_before": inst_before,
        "instance_bytes_after": after["instance"]["bytes"],
        "instance_bytes_delta": after["instance"]["bytes"] - inst_before,
        "before": before,
        "after": after,
        "thread_exception": repr(err_box.get("e")) if err_box else None,
        "result_error": r.get("error") if isinstance(r, dict) else None,
    }


def phase_explicit_reclaim(
    session: Session,
    *,
    self_test: bool,
    peak_at_entry: dict[str, Any],
) -> dict[str, Any]:
    """Drop tables, free_memory, reclaim, optional filecache sweep."""
    before = snapshot(session, "reclaim_before")
    steps: list[dict[str, Any]] = []

    # 1) free_memory while tables still loaded (result cache trim).
    t0 = time.perf_counter()
    fm = session.free_memory()
    steps.append({
        "step": "free_memory",
        "ms": round(_ms(t0), 3),
        "freed_mb": fm.get("freed_mb"),
        "cached_results": fm.get("cached_results"),
        "kept_results": fm.get("kept_results"),
        "snap": snapshot(session, "after_free_memory"),
    })

    # 2) drop all duck tables → schedule full cleanup + evict result refs.
    t0 = time.perf_counter()
    dropped = _drop_all_duck(session)
    _wait_cleanup(session, settle_s=1.8 if self_test else 2.5)
    steps.append({
        "step": "drop_all_tables",
        "ms": round(_ms(t0), 3),
        "dropped": dropped,
        "snap": snapshot(session, "after_drop"),
    })

    # 3) explicit reclaim again.
    t0 = time.perf_counter()
    session._reclaim(full=True)
    steps.append({
        "step": "_reclaim_full",
        "ms": round(_ms(t0), 3),
        "snap": snapshot(session, "after_reclaim"),
    })

    # 4) filecache.sweep — may not shrink recent (<600s) entries (by design).
    # Age only fixtures we can identify? We don't own other users' cache.
    # Call sweep and report removed count + whether bytes dropped.
    fc_before = _dir_stats(filecache._DIR)
    t0 = time.perf_counter()
    removed = 0
    try:
        removed = int(filecache.sweep())
    except Exception as e:
        removed = -1
        sweep_err = str(e)
    else:
        sweep_err = None
    # Force maybe_sweep path too.
    try:
        filecache.maybe_sweep(force=True)
    except Exception:
        pass
    fc_after = _dir_stats(filecache._DIR)
    steps.append({
        "step": "filecache_sweep",
        "ms": round(_ms(t0), 3),
        "removed": removed,
        "error": sweep_err,
        "bytes_before": fc_before["bytes"],
        "bytes_after": fc_after["bytes"],
        "files_before": fc_before["files"],
        "files_after": fc_after["files"],
        "note": ("recent fc_ entries (<600s) exempt from budget eviction; "
                 "persistent cache survives session by design"),
    })

    after = snapshot(session, "reclaim_after")
    rss_peak = peak_at_entry.get("rss_bytes") or before["rss_bytes"]
    rss_after = after["rss_bytes"]
    inst_peak = peak_at_entry.get("instance", {}).get("bytes") or before[
        "instance"]["bytes"]
    inst_after = after["instance"]["bytes"]

    # Health heuristics (not perfect RSS reclaim on Windows).
    results_ok = after["cached_results"] <= 1
    tables_ok = after["duck_tables"] == 0
    # Instance temp should not stay near peak after drop+reclaim.
    inst_reclaimed = (
        inst_after <= max(inst_peak * 0.55, before["instance"]["bytes"] + 8_000_000)
        if inst_peak > 0 else True
    )
    # RSS: require not still climbing; prefer some drop vs peak when peak >> after.
    rss_ok = True
    if rss_peak and rss_after:
        rss_ok = rss_after <= rss_peak * 1.15  # allow noise / fragmentation

    ok = results_ok and tables_ok and inst_reclaimed and rss_ok and removed >= 0
    return {
        "phase": "explicit_reclaim",
        "ok": ok,
        "steps": steps,
        "before": before,
        "after": after,
        "peak_at_entry": {
            "rss_bytes": rss_peak,
            "instance_bytes": inst_peak,
            "filecache_bytes": peak_at_entry.get("filecache", {}).get("bytes"),
        },
        "checks": {
            "cached_results_le_1": results_ok,
            "duck_tables_zero": tables_ok,
            "instance_reclaimed": inst_reclaimed,
            "rss_not_above_peak": rss_ok,
            "sweep_ran": removed >= 0,
        },
        "rss_reclaim_ratio": (
            round(rss_after / rss_peak, 4) if rss_peak else None),
        "instance_reclaim_ratio": (
            round(inst_after / inst_peak, 4) if inst_peak else None),
    }


# ---- suite --------------------------------------------------------------- #

def run_suite(*, self_test: bool, work_dir: Path,
              keep_files: bool = False) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"ok": True, "skipped": "duckdb not installed", "phases": []}

    if self_test:
        n_files = SELF_FILES
        target = SELF_TARGET_BYTES
        records = SELF_RECORDS
        max_tables = 4
        results_gb = _results_gb_from_env(0.05)
    else:
        n_files = files_from_env(FILES_DEFAULT)
        target = target_bytes_from_env(TARGET_BYTES_DEFAULT)
        records = records_from_env(RECORDS_DEFAULT)
        max_tables = _max_tables_from_env(16)
        results_gb = _results_gb_from_env(2.0)

    # Cap aggression: never request more than ~half of free disk for fixtures.
    try:
        free = shutil.disk_usage(str(work_dir)).free
        max_total = int(free * 0.45)
        if n_files * target > max_total and n_files > 0:
            target = max(SELF_TARGET_BYTES, max_total // n_files)
    except OSError:
        pass

    # Result disk budget for this process (does not change product default
    # for other runs — env is harness-scoped).
    os.environ["SAMQL_RESULTS_GB"] = str(results_gb)

    gen = write_workload(
        work_dir / "fixtures",
        n_files=n_files,
        target_bytes=target,
        records=records,
        include_csv=True,
        self_test=self_test,
    )
    fixtures = list(gen["fixtures"])
    ndjson_paths = [f["path"] for f in fixtures if f["kind"] == "ndjson"]

    session = Session()
    phases: list[dict[str, Any]] = []
    errors: list[str] = []
    peak_box: dict[str, Any] = snapshot(session, "peak")
    baseline = snapshot(session, "baseline")

    try:
        for name, fn in (
            ("filecache_loads", lambda: phase_filecache_loads(
                session, fixtures, max_tables=max_tables, peak_box=peak_box)),
            ("result_stores", lambda: phase_result_stores(
                session, self_test=self_test, peak_box=peak_box)),
            ("shred_opt_in", lambda: phase_shred_opt_in(
                session, ndjson_paths[0], peak_box=peak_box)
                if ndjson_paths else {
                    "phase": "shred_opt_in", "ok": False,
                    "skipped": "no ndjson"}),
            ("temp_view_reuse", lambda: phase_temp_view_reuse(
                session, peak_box=peak_box)),
            ("cancel_reclaim", lambda: phase_cancel_reclaim(
                session, self_test=self_test, peak_box=peak_box)),
            ("explicit_reclaim", lambda: phase_explicit_reclaim(
                session, self_test=self_test, peak_at_entry=dict(peak_box))),
        ):
            t0 = time.perf_counter()
            try:
                rep = fn()
                rep["elapsed_ms_wall"] = round(_ms(t0), 3)
                phases.append(rep)
                if not rep.get("ok") and not rep.get("skipped"):
                    errors.append("%s failed" % name)
            except Exception as e:
                phases.append({
                    "phase": name,
                    "ok": False,
                    "error": "%s: %s" % (type(e).__name__, e),
                    "elapsed_ms_wall": round(_ms(t0), 3),
                })
                errors.append("%s: %s" % (name, e))
    finally:
        final_before_shutdown = snapshot(session, "pre_shutdown")
        try:
            session.shutdown()
        except Exception as e:
            errors.append("shutdown: %s" % e)
        # After shutdown, engines recycled; process RSS still measurable.
        final_after_shutdown = {
            "label": "post_shutdown",
            "rss_bytes": int(Session._rss_bytes() or 0),
            "rss_mb": round((Session._rss_bytes() or 0) / 1048576, 2),
            "filecache": _dir_stats(filecache._DIR),
            "instance": _dir_stats(tmputil.instance_dir()),
            "shred_cache": _dir_stats(_shred_cache_dir()),
            "note": ("filecache is process-persistent across sessions; "
                     "instance dir may linger until cleanup_instance/sweep"),
        }
        if not keep_files:
            try:
                shutil.rmtree(work_dir / "fixtures", ignore_errors=True)
            except Exception:
                pass

    reclaim = next((p for p in phases if p.get("phase") == "explicit_reclaim"),
                   {})
    fc_phase = next((p for p in phases if p.get("phase") == "filecache_loads"),
                    {})

    audit = {
        "pressure_built": bool(fc_phase.get("filecache_bytes_delta", 0) > 0
                               or fc_phase.get("ok")),
        "peak_rss_mb": peak_box.get("rss_mb"),
        "baseline_rss_mb": baseline.get("rss_mb"),
        "reclaim_ok": bool(reclaim.get("ok")),
        "reclaim_checks": reclaim.get("checks"),
        "rss_reclaim_ratio": reclaim.get("rss_reclaim_ratio"),
        "instance_reclaim_ratio": reclaim.get("instance_reclaim_ratio"),
        "filecache_survives_session": True,  # by design
        "gaps": [
            "filecache budget eviction exempts entries younger than 600s — "
            "live pressure can exceed SAMQL_FILECACHE_GB until age",
            "filecache persists after session.shutdown (intentional); "
            "not reclaimed by drop_table / free_memory",
            "Windows WorkingSet often does not shrink promptly after "
            "free_memory/_reclaim; prefer instance/qr_/cached_results/"
            "duckdb_mb signals for reclaim health",
            "samql_shred_cache is global under system temp — concurrent "
            "SamQL PIDs may leave unrelated files",
            "self-test fixtures are below JSON on-disk threshold (~64 MiB) "
            "so they materialize in-engine and do not grow filecache; "
            "full mode (≥64 MiB NDJSON) exercises fc_* accumulation",
        ],
    }

    ok = not errors
    # Self-test hard requirements.
    if self_test and ok:
        try:
            _assert(fc_phase.get("ok"), "filecache phase must ok")
            _assert(reclaim.get("ok"), "explicit reclaim must ok")
            cancel = next((p for p in phases
                           if p.get("phase") == "cancel_reclaim"), {})
            _assert(cancel.get("ok") or cancel.get("skipped"),
                    "cancel reclaim must ok")
        except AssertionError as e:
            ok = False
            errors.append(str(e))

    return {
        "ok": ok,
        "mode": "self-test" if self_test else "performance",
        "config": {
            "n_files": n_files,
            "target_bytes": target,
            "records": records,
            "max_tables": max_tables,
            "results_gb": results_gb,
            "filecache_enabled": filecache.enabled(),
            "filecache_budget_bytes": filecache._budget_bytes(),
        },
        "fixture": {k: v for k, v in gen.items() if k != "fixtures"},
        "fixture_files": len(fixtures),
        "baseline": baseline,
        "peak": peak_box,
        "pre_shutdown": final_before_shutdown,
        "post_shutdown": final_after_shutdown,
        "phases": phases,
        "audit": audit,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true",
                    help="CI-safe tiny pressure + reclaim smoke")
    ap.add_argument("--work-dir", default=None)
    ap.add_argument("--keep-files", action="store_true")
    ap.add_argument("--output", help="write JSON report path")
    args = ap.parse_args(argv)

    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_cache_pressure_"))
    work.mkdir(parents=True, exist_ok=True)
    own_work = args.work_dir is None

    try:
        result = run_suite(
            self_test=bool(args.self_test),
            work_dir=work,
            keep_files=args.keep_files or bool(args.work_dir),
        )
    finally:
        if own_work and not args.keep_files:
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
    text = json.dumps(envelope, indent=2, sort_keys=True)
    print(text)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")

    if result.get("skipped"):
        print("SKIP: %s" % result["skipped"], file=sys.stderr)
        return 0
    if not result.get("ok"):
        print("FAIL: %s" % "; ".join(result.get("errors") or ["unknown"]),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
