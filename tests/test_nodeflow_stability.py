"""
tests/test_nodeflow_stability.py
Regression guards for NodeFlow long-run cancellation and OOM error envelopes.

These three subsystems were audited for the following defects:

1. Iterator / While cancellation (``run_iterator``, ``run_while``) is a
   cooperative check between iterations.  A loop that only reacted to the
   SQL-level ``INTERRUPT`` would not stop *between* iterations -- the
   interrupt would raise, be caught, and the loop would simply start the next
   pass.  The current code checks ``self._run_is_cancelled(query_id)`` at the
   top of every iteration and returns ``{"error": "cancelled",
   "cancelled": True}`` promptly.
2. DuckDB OOM during a NodeFlow build must surface as a clean error envelope
   (``{"error": ...}``) with the actionable guidance appended by
   ``_duckdb_oom_flow_message`` -- never a raw crash or
   ``{"cancelled": True}`` misclassification.
3. A cancelled run must leave no orphaned ``__nbcache_*`` / ``__nbtmp_*``
   temp tables behind: the ``finally:`` in each per-pass body calls
   ``_drop_flow_temps`` and the loop-level handler calls ``_flow_cleanup``.

Each case runs through the public ``Session`` entry points on the engine the
audit targets (SQLite ``LOCAL_TARGET``; DuckDB when available).

Run focused:
  SAMQL_ONLY="stability" SAMQL_GROUP=backend \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only --no-http
"""
import os
import sys
import threading
import time
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(os.path.dirname(_HERE), "backend")
for _p in (_HERE, _BACKEND):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _session():
    from samql_core import Session
    s = Session()
    s.fresh_run = False
    s.fresh_load = False
    s.engine_mode = "dual"
    return s


# ---------- 1. iterator cancels between passes ------------------------------

def _iterator_cancellation_stops_between_passes():
    """A 500-pass iterator cancelled right after start must stop promptly
    with a ``cancelled`` envelope -- not run all 500 passes to completion."""
    from samql_core.session import LOCAL_TARGET
    s = _session()
    try:
        # Driver: 500 rows -> one pass each. Try DuckDB-style generate_series
        # first; fall back to a streaming SQLite insert so the test runs even
        # when DuckDB isn't available.
        r = s.run_query(
            "CREATE TABLE stab_driver AS "
            "SELECT value AS n FROM generate_series(1, 500) t(value)",
            target=LOCAL_TARGET)
        if r.get("error"):
            s.db.add_table_streaming(
                "stab_driver", ["n"], ((i,) for i in range(1, 501)))
            s.db.sync_catalog()

        # Body: one-row constant table bound by ${n}.  Iterator appends into
        # ``stab_accum_iter``; max 500 passes.
        g = {
            "nodes": [
                {"id": "d", "type": "input",
                 "config": {"table": "stab_driver"}},
                {"id": "body", "type": "sql",
                 "config": {"sql": "SELECT ${n} AS n",
                            "table": "stab_body"}},
                {"id": "it", "type": "iterator",
                 "config": {"table": "stab_accum_iter",
                            "var": "n",
                            "max_passes": 500,
                            "reset_first": True,
                            "driver": {"kind": "rows"}}},
            ],
            "edges": [
                {"id": "ev", "from": {"node": "d", "port": "out"},
                 "to": {"node": "it", "port": "vars"}},
                {"id": "eb", "from": {"node": "body", "port": "out"},
                 "to": {"node": "it", "port": "in"}},
            ],
        }
        qid = "stab-iter-" + uuid.uuid4().hex
        out = {}

        def _run():
            out["res"] = s.run_iterator(g, "it", query_id=qid)

        th = threading.Thread(target=_run)
        t0 = time.monotonic()
        th.start()
        # Let a few passes happen so cancellation is a real mid-run action.
        time.sleep(0.03)
        s.flag_run_cancelled(qid)
        th.join(timeout=15.0)
        dur = time.monotonic() - t0

        assert not th.is_alive(), (
            "iterator did not stop after cancel (ran %.2fs; still alive)"
            % dur)
        res = out.get("res") or {}
        assert res.get("cancelled") is True, (
            "iterator must return cancelled=True after flag_run_cancelled; "
            "got %r" % res)
        assert res.get("error") == "cancelled", (
            "iterator must return error='cancelled'; got %r" % res.get("error"))
        # 500 passes * one SQL node each cannot plausibly finish in 2s on a
        # test VM; the cooperative check is what caps the duration.
        assert dur < 5.0, (
            "iterator took %.2fs to stop after cancel (loop may be ignoring "
            "the between-iterations check)" % dur)
    finally:
        for name in ("stab_driver", "stab_body", "stab_accum_iter"):
            try:
                s.run_query("DROP TABLE IF EXISTS %s" % name,
                            target=LOCAL_TARGET)
            except Exception:
                pass
        try:
            s.shutdown()
        except Exception:
            pass


# ---------- 2. while cancels between iterations and cleans up ---------------

def _while_cancellation_stops_and_cleans_up():
    """A while/until controller that never converges (${i} produces a fresh
    row every iteration) must stop promptly on cancel AND leave no orphaned
    nodeflow temp tables.  Guards both the cooperative between-iteration check
    and the ``_flow_cleanup`` / ``_drop_flow_temps`` wiring."""
    from samql_core.session import LOCAL_TARGET
    s = _session()
    try:
        before = set(getattr(s.db, "table_columns", {}) or {})
        duck = getattr(s, "duckdb", None)
        if duck is not None:
            before |= set(getattr(duck, "table_columns", {}) or {})

        # Body is a constant 1-row SELECT bound by the loop variable, so
        # ``after > before`` every pass -> the while loop never converges.
        # Max iters is high enough that an unbounded run would clearly exceed
        # the cancellation deadline.
        g = {
            "nodes": [
                {"id": "step", "type": "sql",
                 "config": {"sql": "SELECT ${i} AS n",
                            "table": "stab_while_body"}},
                {"id": "w", "type": "while",
                 "config": {"table": "stab_accum_while",
                            "max_iters": 500,
                            "reset_first": True,
                            "var": "i"}},
            ],
            "edges": [
                {"id": "e", "from": {"node": "step", "port": "out"},
                 "to": {"node": "w", "port": "in"}},
            ],
        }
        qid = "stab-while-" + uuid.uuid4().hex
        out = {}

        def _run():
            out["res"] = s.run_while(g, "w", query_id=qid)

        th = threading.Thread(target=_run)
        t0 = time.monotonic()
        th.start()
        time.sleep(0.03)
        s.flag_run_cancelled(qid)
        th.join(timeout=15.0)
        dur = time.monotonic() - t0

        assert not th.is_alive(), (
            "while loop did not stop after cancel (ran %.2fs)" % dur)
        res = out.get("res") or {}
        assert res.get("cancelled") is True, (
            "while must return cancelled=True; got %r" % res)
        assert res.get("error") == "cancelled", (
            "while must return error='cancelled'; got %r" % res.get("error"))
        assert dur < 5.0, (
            "while took %.2fs to stop after cancel (between-iteration check "
            "may be missing)" % dur)

        # Verify no orphaned flow temp tables were left behind.  The accum
        # table (``stab_accum_while``) is intentional user state and may or
        # may not exist depending on when the cancel landed; the regression
        # we are guarding is leftover ``__nbtmp_*`` / ``__nbcache_*`` / ``__nf_*``
        # scratch tables accumulating across cancelled runs.
        after = set(getattr(s.db, "table_columns", {}) or {})
        if duck is not None:
            after |= set(getattr(duck, "table_columns", {}) or {})
        leftover = sorted(
            n for n in (after - before)
            if n.startswith(("__nbcache_", "__nbtmp_", "__nf_", "__flow_")))
        assert not leftover, (
            "cancelled while loop left orphan temp tables: %r" % leftover)
    finally:
        for name in ("stab_while_body", "stab_accum_while"):
            try:
                s.run_query("DROP TABLE IF EXISTS %s" % name,
                            target=LOCAL_TARGET)
            except Exception:
                pass
        try:
            s.shutdown()
        except Exception:
            pass


# ---------- 3. OOM returns a clean error envelope ---------------------------

def _oom_returns_clean_error_envelope():
    """An out-of-memory failure deep inside _materialize_flow must surface
    as a clean ``{"error": ...}`` envelope with the actionable guidance from
    ``_duckdb_oom_flow_message`` appended -- never a crash and never a
    ``{"cancelled": True}`` misclassification (the two are different: cancel
    is a user action, OOM is a resource failure)."""
    from samql_core.session import LOCAL_TARGET
    s = _session()
    try:
        s.run_query("CREATE TABLE stab_oom_seed AS SELECT 1 AS v",
                    target=LOCAL_TARGET)

        class _FakeOOM(Exception):
            pass

        orig = s._materialize_flow

        def boom(*a, **kw):
            # Message text matches DuckDB's OOM wording so
            # ``_duckdb_oom_flow_message`` recognises it and appends guidance.
            raise _FakeOOM(
                "Out of Memory Error: failed to allocate "
                "16777216 bytes")

        s._materialize_flow = boom
        g = {
            "nodes": [
                {"id": "a", "type": "input",
                 "config": {"table": "stab_oom_seed"}},
                {"id": "o", "type": "output", "config": {}},
            ],
            "edges": [
                {"id": "e", "from": {"node": "a", "port": "out"},
                 "to": {"node": "o", "port": "in"}},
            ],
        }
        try:
            res = s.run_nodeflow(g, "o", "out")
        finally:
            s._materialize_flow = orig

        assert isinstance(res, dict), "expected dict envelope; got %r" % type(res)
        assert res.get("cancelled") is not True, (
            "OOM must not be misclassified as cancellation; got %r" % res)
        err = res.get("error") or ""
        assert err, "OOM must produce a non-empty error envelope; got %r" % res
        low = err.lower()
        assert "out of memory" in low or "failed to allocate" in low, (
            "OOM error text must preserve the original message; got %r" % err)
        # ``_duckdb_oom_flow_message`` appends the user-facing guidance.
        assert "working-memory" in low or "memory limit" in low or (
                "flow, add a filter" in low), (
            "OOM envelope must carry actionable guidance from "
            "_duckdb_oom_flow_message; got %r" % err)
    finally:
        try:
            s.run_query("DROP TABLE IF EXISTS stab_oom_seed",
                        target=LOCAL_TARGET)
        except Exception:
            pass
        try:
            s.shutdown()
        except Exception:
            pass


_CASES = [
    ("iterator cancellation stops between passes",
     _iterator_cancellation_stops_between_passes),
    ("while cancellation stops between iterations and cleans up temps",
     _while_cancellation_stops_and_cleans_up),
    ("OOM returns a clean error envelope with guidance (not cancelled)",
     _oom_returns_clean_error_envelope),
]


def backend_cases(root, csv, skip):
    """Register cases in the main backend suite."""
    out = []
    for label, fn in _CASES:
        out.append(("nodeflow_stability: " + label, fn))
    return out
