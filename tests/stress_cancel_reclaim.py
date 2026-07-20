#!/usr/bin/env python3
r"""Stall / cancel / reclaim stress suite for SamQL.

Builds a stall-prone workload (recursive CTE + nested NDJSON explode), then
verifies that after stall work starts:

1. **Cancel quickly** — ``cancel_query`` returns within a tight budget and the
   worker unwinds within a documented join budget.
2. **Clear frontend and backend state** — ``_running`` drains; sticky engine
   ``_cancel`` does not permanently poison the next op; no orphan user table
   from a cancelled load. (FE UI clearing is noted where only API hooks exist.)
3. **Reclaim cache / temp space** — ``jf_`` spill dirs, ``hdfs_`` staging, and
   other instance-temp artifacts for the cancelled job are gone (or size does
   not permanently inflate).

Surfaces covered (backend / Session / API-level)::

    query · load · flattening · NodeFlow · journal · API load · HDFS
    chart · pivot · dashboard (activity status)

Frontend gaps (no Vitest cancel+reclaim e2e for every surface)::

    * LoadDataModal / Activity tray UI clear — FE-only (``abortInflight``,
      ``cancelAllBgOps``); Field Explorer modal cancel has a component test.
    * NodeFlow ``forceRecoverFromCancel`` — source-guarded in backend suite.
    * Dashboard React cards — covered here via ``Session.status()`` ops drain.

Modes::

    python tests/stress_cancel_reclaim.py --self-test
    python tests/stress_cancel_reclaim.py                  # fuller stall
    set SAMQL_STALL_NDJSON_RECORDS=40
    python tests/stress_cancel_reclaim.py --output report.json

Cancel budgets (documented)::

    | Mode      | cancel_query() return | worker unwind join |
    |-----------|-----------------------|--------------------|
    | self-test | ≤ 500 ms              | ≤ 8 s              |
    | full      | ≤ 1000 ms             | ≤ 30 s             |

Cross-cutting: additive harness only. Does not change flatten/shred defaults,
Parquet thresholds, concurrent-reads, or discovery→load mutation.
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

from generate_stall_workload import (  # noqa: E402
    STALL_CTE_FULL,
    STALL_CTE_SELF,
    write_stall_ndjson,
)
from samql_core import BUILD, __version__, Session  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.loaders import LoadCancelled  # noqa: E402
from samql_core import tmputil  # noqa: E402


# ---- budgets ------------------------------------------------------------- #

CANCEL_RETURN_MS_SELF = 500.0
CANCEL_RETURN_MS_FULL = 1000.0
CANCEL_UNWIND_S_SELF = 8.0
CANCEL_UNWIND_S_FULL = 30.0


def _ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000.0


def _running_ids(session: Session) -> list[str]:
    with session._running_lock:
        return sorted(session._running.keys())


def _temp_prefixes(inst: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {
        "jf_": [], "hdfs_": [], "flatten_": [], "cache_": [], "qr_": [],
    }
    if not os.path.isdir(inst):
        return out
    for name in os.listdir(inst):
        for p in out:
            if name.startswith(p):
                out[p].append(name)
    return out


def _wait_registered(session: Session, qid: str, timeout_s: float = 4.0) -> bool:
    deadline = time.perf_counter() + timeout_s
    while time.perf_counter() < deadline:
        with session._running_lock:
            if qid in session._running:
                return True
        time.sleep(0.005)
    return False


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _is_cancelled_result(r: Any) -> bool:
    if not isinstance(r, dict):
        return False
    if r.get("cancelled"):
        return True
    err = str(r.get("error") or "").lower()
    return ("cancel" in err or "interrupt" in err
            or err.strip() == "not an error"
            or err.endswith(": not an error")
            or "operationalerror: not an error" in err)


# ---- surface probes ------------------------------------------------------ #

def check_query_cancel(
    session: Session, *, stall_sql: str, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    qid = "stall-query"
    before = session.snapshot_table_names()
    out: dict[str, Any] = {}
    err_box: dict[str, Any] = {}

    def work():
        try:
            out["r"] = session.run_query(
                stall_sql, target="auto", query_id=qid)
        except Exception as e:
            err_box["e"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _assert(_wait_registered(session, qid), "query never registered as running")
    time.sleep(0.15)
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    th.join(timeout=unwind_s)
    alive = th.is_alive()
    r = out.get("r") or {}
    report = {
        "surface": "query",
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": alive,
        "cancelled": _is_cancelled_result(r),
        "running_after": _running_ids(session),
        "orphan_tables": sorted(session.snapshot_table_names() - before),
        "result_error": r.get("error") if isinstance(r, dict) else None,
        "thread_exception": repr(err_box.get("e")) if err_box else None,
    }
    _assert(cr.get("ok"), "cancel_query did not report ok")
    _assert(cancel_ms <= cancel_return_ms,
            "cancel_query too slow: %.1f ms > %.1f ms" % (
                cancel_ms, cancel_return_ms))
    _assert(not alive, "cancelled query did not unwind in %.1fs" % unwind_s)
    _assert(report["cancelled"] or err_box,
            "run_query did not report cancelled: %r" % r)
    _assert(qid not in report["running_after"],
            "query id still in _running: %r" % report["running_after"])
    # Sticky cancel must not poison a fresh query.
    r2 = session.run_query("SELECT 1 AS ok", target="auto",
                           query_id="stall-query-fresh")
    _assert(not _is_cancelled_result(r2) and not r2.get("error"),
            "fresh query poisoned after cancel: %r" % r2)
    duck = getattr(session, "duckdb", None)
    if duck is not None and getattr(duck, "_cancel", None) is not None:
        # Fresh run clears sticky cancel at entry.
        _assert(not duck._cancel.is_set(),
                "sticky engine _cancel still set after fresh query")
    report["fresh_query_ok"] = True
    report["ok"] = True
    return report


def check_journal_cancel(
    session: Session, *, stall_sql: str, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    qid = "stall-journal"
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.run_query(
            stall_sql, target="auto", query_id=qid,
            surface="journal", label="stall-cell")

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _assert(_wait_registered(session, qid), "journal run never registered")
    time.sleep(0.15)
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    th.join(timeout=unwind_s)
    r = out.get("r") or {}
    report = {
        "surface": "journal",
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "cancelled": _is_cancelled_result(r),
        "running_after": _running_ids(session),
    }
    _assert(cr.get("ok"), "journal cancel_query not ok")
    _assert(cancel_ms <= cancel_return_ms,
            "journal cancel_query too slow: %.1f ms" % cancel_ms)
    _assert(not th.is_alive(), "journal worker did not unwind")
    _assert(report["cancelled"], "journal run not cancelled: %r" % r)
    _assert(qid not in report["running_after"],
            "journal qid still running: %r" % report["running_after"])
    # Clear keep-cancel residue so later surfaces stay clean.
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    report["ok"] = True
    return report


def check_nodeflow_cancel(
    session: Session, *, stall_sql: str, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    qid = "stall-nodeflow"
    g = {"nodes": [{"id": "Q", "type": "sql", "config": {"sql": stall_sql}}],
         "edges": []}
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.run_nodeflow(g, "Q", "out", query_id=qid)

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _assert(_wait_registered(session, qid, timeout_s=6.0),
            "nodeflow never registered")
    time.sleep(0.2)
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    th.join(timeout=unwind_s)
    r = out.get("r") or {}
    report = {
        "surface": "nodeflow",
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "cancelled": _is_cancelled_result(r),
        "running_after": _running_ids(session),
    }
    _assert(cr.get("ok"), "nodeflow cancel not ok")
    _assert(cancel_ms <= cancel_return_ms,
            "nodeflow cancel too slow: %.1f ms" % cancel_ms)
    _assert(not th.is_alive(), "nodeflow worker did not unwind")
    _assert(report["cancelled"], "nodeflow not cancelled: %r" % r)
    # Health after cancel (same posture as existing .c3f tests).
    healthy = session.run_query("SELECT 2 AS n", target="auto",
                                query_id="nf-health")
    _assert(not _is_cancelled_result(healthy) and not healthy.get("error"),
            "nodeflow layer unhealthy after cancel: %r" % healthy)
    with session._running_lock:
        session._cancelled_runs.discard(qid)
        session._cancelled_runs.discard("nf-health")
    report["fresh_ok"] = True
    report["ok"] = True
    return report


def check_load_cancel(
    session: Session, ndjson_path: Path, *, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    """Cancel a nested NDJSON DuckDB load; no attach + reclaim staging."""
    if not HAS_DUCKDB:
        return {"surface": "load", "skipped": "duckdb not installed", "ok": True}

    before_tables = session.snapshot_table_names()
    before_prefs = _temp_prefixes(tmputil.instance_dir())

    # (1) Deterministic pre-cancel: should_cancel True from the first poll —
    # must raise LoadCancelled and never attach.
    def prog_pre(done=0, total=None):
        return None

    prog_pre.should_cancel = lambda: True  # type: ignore[attr-defined]
    pre_err: dict[str, Any] = {}
    t0 = time.perf_counter()
    try:
        session.load_file(
            str(ndjson_path), destination="duckdb",
            base_name="stall_load_pre", flatten=False, shred=False,
            progress=prog_pre)
    except LoadCancelled:
        pre_err["cancelled"] = True
    except Exception as e:
        pre_err["e"] = e
    pre_ms = _ms(t0)
    pre_attached = "stall_load_pre" in session.snapshot_table_names()
    if pre_attached:
        session.drop_tables_created_since(before_tables)

    # (2) Mid-flight cancel: fire after first progress tick + interrupt.
    flag = {"cancel": False, "ticks": 0}
    out: dict[str, Any] = {}
    err_box: dict[str, Any] = {}

    def prog(done=0, total=None):
        flag["ticks"] += 1
        if flag["ticks"] >= 1:
            flag["cancel"] = True
        return None

    prog.should_cancel = lambda: bool(flag["cancel"])  # type: ignore[attr-defined]

    def work():
        try:
            out["r"] = session.load_file(
                str(ndjson_path), destination="duckdb",
                base_name="stall_load_mid", flatten=False, shred=False,
                progress=prog)
        except LoadCancelled:
            err_box["cancelled"] = True
        except Exception as e:
            err_box["e"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    deadline = time.perf_counter() + min(2.0, unwind_s)
    while time.perf_counter() < deadline and not flag["cancel"]:
        time.sleep(0.01)
    t1 = time.perf_counter()
    try:
        session.interrupt_loads()
    except Exception:
        pass
    cancel_ms = _ms(t1)
    th.join(timeout=unwind_s)
    after_tables = session.snapshot_table_names()
    orphans = sorted(after_tables - before_tables)
    if orphans:
        # Product path (server jobs) calls drop_tables_created_since; Session
        # load_file alone may leave a completed race attach — reclaim here and
        # require the deterministic pre-cancel path for no-attach proof.
        session.drop_tables_created_since(before_tables)
    after_prefs = _temp_prefixes(tmputil.instance_dir())
    new_jf = sorted(set(after_prefs["jf_"]) - set(before_prefs["jf_"]))
    report = {
        "surface": "load",
        "pre_cancel_ms": round(pre_ms, 3),
        "pre_cancel_exc": bool(pre_err.get("cancelled")),
        "pre_attached": pre_attached,
        "mid_cancel_interrupt_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "mid_load_cancelled_exc": bool(err_box.get("cancelled")),
        "mid_progress_ticks": flag["ticks"],
        "orphan_tables_before_cleanup": orphans,
        "jf_spill_left": new_jf,
        "thread_exception": (
            None if err_box.get("cancelled")
            else repr(err_box.get("e")) if err_box.get("e") else None),
        "mid_result": (
            [{"name": t.get("name"), "rows": t.get("rows")}
             for t in out["r"] if isinstance(t, dict)]
            if isinstance(out.get("r"), list) else out.get("r")),
    }
    _assert(pre_err.get("cancelled"),
            "pre-cancel load must raise LoadCancelled: %r" % pre_err)
    _assert(not pre_attached, "pre-cancel load must not attach stall_load_pre")
    _assert(pre_ms <= max(cancel_return_ms * 20, 5000.0),
            "pre-cancel load took too long: %.1f ms" % pre_ms)
    _assert(not th.is_alive(), "mid load worker did not unwind in %.1fs"
            % unwind_s)
    _assert(cancel_ms <= cancel_return_ms,
            "interrupt_loads too slow: %.1f ms" % cancel_ms)
    _assert("stall_load_pre" not in session.snapshot_table_names(),
            "pre-cancel left attached table")
    _assert("stall_load_mid" not in session.snapshot_table_names(),
            "mid-cancel left attached table after reclaim")
    _assert(not new_jf, "jf_ spill dirs left after load cancel: %r" % new_jf)
    report["ok"] = True
    return report


def check_flatten_cancel(
    session: Session, ndjson_path: Path, *, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    """Load nested (flatten off), then cancel relational shred mid-flight."""
    if not HAS_DUCKDB:
        return {"surface": "flattening", "skipped": "duckdb not installed",
                "ok": True}

    before = session.snapshot_table_names()
    before_prefs = _temp_prefixes(tmputil.instance_dir())
    loaded = session.load_file(
        str(ndjson_path), destination="duckdb",
        base_name="stall_flat_src", flatten=False, shred=False)
    _assert(loaded and loaded[0].get("name"),
            "flatten setup load failed: %r" % loaded)
    src = loaded[0]["name"]
    qid = "stall-flatten"
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.flatten_table(src, base=src, query_id=qid)

    th = threading.Thread(target=work, daemon=True)
    th.start()
    registered = _wait_registered(session, qid, timeout_s=8.0)
    # Tiny fixtures may finish before register; cancel anyway.
    time.sleep(0.1)
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    th.join(timeout=unwind_s)
    r = out.get("r") or {}
    # Cleanup any shred tables created before cancel landed.
    session.drop_tables_created_since(before | {src})
    after_prefs = _temp_prefixes(tmputil.instance_dir())
    new_jf = sorted(set(after_prefs["jf_"]) - set(before_prefs["jf_"]))
    report = {
        "surface": "flattening",
        "registered": registered,
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "cancelled": _is_cancelled_result(r),
        "result_keys": sorted(r.keys()) if isinstance(r, dict) else None,
        "jf_spill_left": new_jf,
        "tables_after": sorted(session.snapshot_table_names()),
    }
    _assert(cr.get("ok"), "flatten cancel_query not ok")
    _assert(cancel_ms <= cancel_return_ms,
            "flatten cancel too slow: %.1f ms" % cancel_ms)
    _assert(not th.is_alive(), "flatten worker did not unwind")
    # If flatten finished before cancel (tiny file), require no leftover spill
    # and that a cancelled flag OR completed ok without poisoning session.
    if registered:
        _assert(report["cancelled"] or r.get("ok") or r.get("created") is not None,
                "flatten result unexpected: %r" % r)
    _assert(not new_jf, "jf_ spill left after flatten: %r" % new_jf)
    # Sticky cancel must not poison a follow-up flatten of a trivial table.
    from samql_core.session import DUCKDB_TARGET
    session.run_query(
        'CREATE OR REPLACE TABLE "stall_flat_tiny" AS '
        "SELECT 1 AS a, [{'x': 1}, {'x': 2}] AS arr",
        target=DUCKDB_TARGET)
    fr = session.flatten_table("stall_flat_tiny", base="stall_flat_tiny",
                               query_id="stall-flatten-fresh")
    _assert(not fr.get("cancelled"),
            "fresh flatten poisoned by sticky cancel: %r" % fr)
    with session._running_lock:
        session._cancelled_runs.discard(qid)
        session._cancelled_runs.discard("stall-flatten-fresh")
    report["fresh_flatten_ok"] = True
    report["ok"] = True
    return report


def check_api_load_cancel(session: Session) -> dict[str, Any]:
    """API load honors pre-cancel (no network) and clears the run registry."""
    qid = "stall-api"
    session.cancel_query(qid)
    t0 = time.perf_counter()
    r = session.load_api("http://example.invalid/stall-api",
                         base_name="stall_api", query_id=qid)
    elapsed = _ms(t0)
    report = {
        "surface": "api_load",
        "cancelled": bool(r.get("cancelled")),
        "elapsed_ms": round(elapsed, 3),
        "running_after": _running_ids(session),
        "result": {k: r.get(k) for k in ("cancelled", "error", "ok")},
    }
    _assert(r.get("cancelled"), "load_api must bail when pre-cancelled: %r" % r)
    _assert(qid not in report["running_after"],
            "api load qid still in _running")
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    report["ok"] = True
    return report


def check_hdfs_cancel(session: Session) -> dict[str, Any]:
    """HDFS fetch cancel removes staging temp (mock client)."""
    from samql_core.loaders import LoadCancelled as LC

    class _SlowClient:
        def open_stream(self, path, offset=None, length=None):
            class _Resp:
                def __init__(self):
                    self._n = 0

                def read(self, n):
                    # Yield chunks slowly so cancel can land between reads.
                    if self._n >= 40:
                        return b""
                    self._n += 1
                    time.sleep(0.05)
                    return b"x" * min(n, 4096)

                def close(self):
                    return None

            return _Resp()

    before = set()
    d = tmputil.instance_dir()
    if os.path.isdir(d):
        before = set(f for f in os.listdir(d) if f.startswith("hdfs_"))
    session._hdfs = _SlowClient()
    flag = {"c": False}
    err: dict[str, Any] = {}
    out: dict[str, Any] = {}

    def work():
        try:
            out["r"] = session.hdfs_load_file(
                "/remote/stall.csv", cancel=lambda: flag["c"])
        except LC:
            err["cancelled"] = True
        except Exception as e:
            err["e"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    time.sleep(0.2)
    flag["c"] = True
    t0 = time.perf_counter()
    # Cooperative cancel is via the cancel callable; no cancel_query here.
    th.join(timeout=10.0)
    cancel_wait_ms = _ms(t0)
    after = set()
    if os.path.isdir(d):
        after = set(f for f in os.listdir(d) if f.startswith("hdfs_"))
    left = sorted(after - before)
    report = {
        "surface": "hdfs",
        "cancelled_exc": bool(err.get("cancelled")),
        "worker_alive": th.is_alive(),
        "hdfs_temps_left": left,
        "join_ms": round(cancel_wait_ms, 3),
        "result": out.get("r"),
        "thread_exception": repr(err.get("e")) if err.get("e") else None,
    }
    _assert(not th.is_alive(), "hdfs worker did not unwind")
    _assert(err.get("cancelled"),
            "hdfs cancel must raise LoadCancelled: %r" % err)
    _assert(not left, "hdfs staging left behind: %r" % left)
    session._hdfs = None
    report["ok"] = True
    return report


def _seed_agg_table(session: Session, name: str, rows: int) -> None:
    duck = session.get_duckdb()
    # Clear sticky cancel so seeding after a Stop is not auto-aborted.
    session._clear_stale_engine_cancel(duck)
    duck.execute(
        'CREATE OR REPLACE TABLE "%s" AS '
        "SELECT i AS id, (i %% 20) AS cat, "
        "CAST((i * 3) %% 1000 AS DOUBLE) AS val "
        "FROM range(%d) t(i)" % (name.replace('"', ''), int(rows)))
    duck.table_columns[name] = ["id", "cat", "val"]
    session._invalidate_counts()


def check_chart_cancel(
    session: Session, *, rows: int, cancel_return_ms: float, unwind_s: float,
) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"surface": "chart", "skipped": "duckdb not installed", "ok": True}
    _seed_agg_table(session, "stall_chart", rows)
    qid = "stall-chart"
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.chart_data({
            "table": "stall_chart", "engine": "duckdb",
            "chart_type": "bar", "x": "cat", "y": "val", "agg": "sum",
            "query_id": qid,
        })

    # Pre-cancel path (deterministic) + mid-flight attempt.
    session.cancel_query(qid)
    t0 = time.perf_counter()
    r_pre = session.chart_data({
        "table": "stall_chart", "engine": "duckdb",
        "chart_type": "bar", "x": "cat", "y": "val", "agg": "sum",
        "query_id": qid,
    })
    pre_ms = _ms(t0)
    with session._running_lock:
        session._cancelled_runs.discard(qid)

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _wait_registered(session, qid, timeout_s=3.0)
    t1 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t1)
    th.join(timeout=unwind_s)
    r = out.get("r") or {}
    report = {
        "surface": "chart",
        "pre_cancel_cancelled": _is_cancelled_result(r_pre),
        "pre_cancel_ms": round(pre_ms, 3),
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "mid_cancelled": _is_cancelled_result(r),
        "running_after": _running_ids(session),
    }
    _assert(report["pre_cancel_cancelled"],
            "chart pre-cancel must return cancelled: %r" % r_pre)
    _assert(pre_ms <= cancel_return_ms,
            "chart pre-cancel too slow: %.1f ms" % pre_ms)
    _assert(not th.is_alive(), "chart worker did not unwind")
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    # Fresh chart after sticky interrupt must work.
    duck = session.duckdb
    if duck is not None:
        duck.interrupt()
    fresh = session.chart_data({
        "table": "stall_chart", "engine": "duckdb",
        "chart_type": "bar", "x": "cat", "y": "val", "agg": "sum",
        "query_id": "stall-chart-fresh",
    })
    _assert(not _is_cancelled_result(fresh) and not fresh.get("error"),
            "fresh chart poisoned: %r" % fresh)
    report["fresh_ok"] = True
    report["ok"] = True
    return report


def check_pivot_cancel(
    session: Session, *, rows: int, cancel_return_ms: float, unwind_s: float,
) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"surface": "pivot", "skipped": "duckdb not installed", "ok": True}
    _seed_agg_table(session, "stall_pivot", rows)
    qid = "stall-pivot"
    def _pivot_spec(qid_s: str) -> dict[str, Any]:
        return {
            "table": "stall_pivot", "engine": "duckdb",
            "rows": ["cat"], "cols": [],
            "value": "val", "agg": "sum",
            "query_id": qid_s,
        }

    session.cancel_query(qid)
    t0 = time.perf_counter()
    r_pre = session.pivot(_pivot_spec(qid))
    pre_ms = _ms(t0)
    report = {
        "surface": "pivot",
        "pre_cancel_cancelled": _is_cancelled_result(r_pre),
        "pre_cancel_ms": round(pre_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "running_after": _running_ids(session),
    }
    _assert(report["pre_cancel_cancelled"],
            "pivot pre-cancel must return cancelled: %r" % r_pre)
    _assert(pre_ms <= cancel_return_ms,
            "pivot pre-cancel too slow: %.1f ms" % pre_ms)
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    # Mid-flight cancel on a larger pivot.
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.pivot(_pivot_spec(qid))

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _wait_registered(session, qid, timeout_s=3.0)
    t1 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t1)
    th.join(timeout=unwind_s)
    report.update({
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "worker_alive": th.is_alive(),
        "mid_cancelled": _is_cancelled_result(out.get("r") or {}),
    })
    _assert(not th.is_alive(), "pivot worker did not unwind")
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    fresh = session.pivot(_pivot_spec("stall-pivot-fresh"))
    _assert(not _is_cancelled_result(fresh) and not fresh.get("error"),
            "fresh pivot poisoned: %r" % fresh)
    report["fresh_ok"] = True
    report["ok"] = True
    return report


def check_dashboard_clear(
    session: Session, *, stall_sql: str, cancel_return_ms: float,
    unwind_s: float,
) -> dict[str, Any]:
    """Activity dashboard: cancel drains ops / _running; sticky cleared."""
    qid = "stall-dashboard"
    out: dict[str, Any] = {}

    def work():
        out["r"] = session.run_query(
            stall_sql, target="auto", query_id=qid,
            surface="ide", label="stall-dashboard")

    th = threading.Thread(target=work, daemon=True)
    th.start()
    _assert(_wait_registered(session, qid), "dashboard run never registered")
    st_mid = session.status()
    ops_mid = list(st_mid.get("operations") or [])
    t0 = time.perf_counter()
    cr = session.cancel_query(qid)
    cancel_ms = _ms(t0)
    th.join(timeout=unwind_s)
    # Allow opreg end to settle.
    time.sleep(0.05)
    st_after = session.status()
    running = _running_ids(session)
    report = {
        "surface": "dashboard",
        "cancel_ok": bool(cr.get("ok")),
        "cancel_return_ms": round(cancel_ms, 3),
        "cancel_budget_ms": cancel_return_ms,
        "worker_alive": th.is_alive(),
        "ops_during": len(ops_mid),
        "ops_after": len(st_after.get("operations") or []),
        "running_after": running,
        "cancelled": _is_cancelled_result(out.get("r") or {}),
    }
    _assert(cr.get("ok"), "dashboard cancel not ok")
    _assert(cancel_ms <= cancel_return_ms,
            "dashboard cancel too slow: %.1f ms" % cancel_ms)
    _assert(not th.is_alive(), "dashboard worker did not unwind")
    _assert(qid not in running, "_running not cleared: %r" % running)
    _assert(report["cancelled"], "dashboard run not cancelled")
    with session._running_lock:
        session._cancelled_runs.discard(qid)
    # Simulate sticky cancel then ensure status-path ops still work.
    if session.duckdb is not None:
        session.duckdb.interrupt()
    fresh = session.run_query("SELECT 3 AS n", target="auto",
                              query_id="dash-fresh", surface="ide",
                              label="post-stall")
    _assert(not _is_cancelled_result(fresh) and not fresh.get("error"),
            "dashboard fresh query poisoned: %r" % fresh)
    if session.duckdb is not None:
        _assert(not session.duckdb._cancel.is_set(),
                "sticky _cancel still set after dashboard fresh query")
    report["fresh_ok"] = True
    report["ok"] = True
    report["fe_gap"] = (
        "React Activity tray / Load modal clear is FE-only "
        "(abortInflight + cancelAllBgOps); API drain asserted here"
    )
    return report


# ---- suite --------------------------------------------------------------- #

def run_suite(*, self_test: bool, work_dir: Path,
              keep_file: bool = False) -> dict[str, Any]:
    if not HAS_DUCKDB:
        return {"ok": True, "skipped": "duckdb not installed",
                "surfaces": []}

    cancel_return_ms = (CANCEL_RETURN_MS_SELF if self_test
                        else CANCEL_RETURN_MS_FULL)
    unwind_s = CANCEL_UNWIND_S_SELF if self_test else CANCEL_UNWIND_S_FULL
    stall_sql = STALL_CTE_SELF if self_test else STALL_CTE_FULL
    agg_rows = 50_000 if self_test else 500_000

    ndjson_path = work_dir / ("stall_self.ndjson" if self_test
                              else "stall_full.ndjson")
    gen_stats = write_stall_ndjson(ndjson_path, self_test=self_test)

    session = Session()
    surfaces: list[dict[str, Any]] = []
    errors: list[str] = []
    inst_before = tmputil.instance_size_bytes()

    probes: list[tuple[str, Callable[[], dict[str, Any]]]] = [
        ("query", lambda: check_query_cancel(
            session, stall_sql=stall_sql,
            cancel_return_ms=cancel_return_ms, unwind_s=unwind_s)),
        ("load", lambda: check_load_cancel(
            session, ndjson_path, cancel_return_ms=cancel_return_ms,
            unwind_s=unwind_s)),
        ("flattening", lambda: check_flatten_cancel(
            session, ndjson_path, cancel_return_ms=cancel_return_ms,
            unwind_s=unwind_s)),
        ("nodeflow", lambda: check_nodeflow_cancel(
            session, stall_sql=stall_sql,
            cancel_return_ms=cancel_return_ms, unwind_s=unwind_s)),
        ("journal", lambda: check_journal_cancel(
            session, stall_sql=stall_sql,
            cancel_return_ms=cancel_return_ms, unwind_s=unwind_s)),
        ("api_load", lambda: check_api_load_cancel(session)),
        ("hdfs", lambda: check_hdfs_cancel(session)),
        ("chart", lambda: check_chart_cancel(
            session, rows=agg_rows, cancel_return_ms=cancel_return_ms,
            unwind_s=unwind_s)),
        ("pivot", lambda: check_pivot_cancel(
            session, rows=agg_rows, cancel_return_ms=cancel_return_ms,
            unwind_s=unwind_s)),
        ("dashboard", lambda: check_dashboard_clear(
            session, stall_sql=stall_sql,
            cancel_return_ms=cancel_return_ms, unwind_s=unwind_s)),
    ]

    try:
        for name, fn in probes:
            t0 = time.perf_counter()
            try:
                rep = fn()
                rep["elapsed_ms"] = round(_ms(t0), 3)
                surfaces.append(rep)
                if not rep.get("ok") and not rep.get("skipped"):
                    errors.append("%s failed" % name)
            except Exception as e:
                surfaces.append({
                    "surface": name,
                    "ok": False,
                    "error": "%s: %s" % (type(e).__name__, e),
                    "elapsed_ms": round(_ms(t0), 3),
                })
                errors.append("%s: %s" % (name, e))
    finally:
        try:
            session.shutdown()
        except Exception:
            pass
        if not keep_file:
            try:
                ndjson_path.unlink()
            except OSError:
                pass

    prefs = _temp_prefixes(tmputil.instance_dir())
    report = {
        "ok": not errors,
        "mode": "self-test" if self_test else "performance",
        "budgets": {
            "cancel_return_ms": cancel_return_ms,
            "unwind_s": unwind_s,
            "stall_sql": "STALL_CTE_SELF" if self_test else "STALL_CTE_FULL",
            "agg_rows": agg_rows,
        },
        "fixture": gen_stats,
        "instance_bytes_before": inst_before,
        "instance_bytes_after_suite": tmputil.instance_size_bytes(),
        "temp_prefixes_after": {k: len(v) for k, v in prefs.items()},
        "surfaces": surfaces,
        "errors": errors,
        "fe_gaps": [
            "LoadDataModal / Activity tray React clear (abortInflight, "
            "cancelAllBgOps) — no e2e reclaim assertion here",
            "NodeFlow forceRecoverFromCancel UI — source-guarded elsewhere",
            "Chart/Pivot/Dashboard canvas paint — API cancel+fresh only",
        ],
    }
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true",
                    help="bounded CI smoke (tight cancel budgets)")
    ap.add_argument("--work-dir", default=None)
    ap.add_argument("--keep-file", action="store_true")
    ap.add_argument("--output", help="write JSON report path")
    args = ap.parse_args(argv)

    work = Path(args.work_dir) if args.work_dir else Path(
        tempfile.mkdtemp(prefix="samql_stall_"))
    work.mkdir(parents=True, exist_ok=True)
    own_work = args.work_dir is None

    try:
        result = run_suite(
            self_test=bool(args.self_test),
            work_dir=work,
            keep_file=args.keep_file or bool(args.work_dir),
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
