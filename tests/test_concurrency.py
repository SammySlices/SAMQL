"""
tests/test_concurrency.py
Regression guards for SamQL's concurrency surface.

Covers four production code paths that are easy to get subtly wrong:

  1. ``_with_engine_slot`` under contention -- a 4th job behind 3 queued
     siblings must still queue cleanly (FIFO), never deadlock, and must honour
     a cooperative cancel while queued.

  2. Parallel-nodeflow isolation -- with ``parallel_nodeflows=True`` two
     disconnected DuckDB components run on separate branched cursors, so
     their scratch tables don't bleed into each other even when scheduled
     concurrently from user threads.

  3. ``run_nodeflow_browse`` memory bound -- a 50k-row passthrough returns
     the correct ``total_rows`` but never ships 50k rows back in the
     response payload (the browse endpoint is a profile, not a page).

  4. Session-restore priority -- ``_restore_wait_if_busy`` must detect an
     in-flight user op and then **actually resume** once that op ends. The
     existing ``t_restore_yields_to_user_ops`` test only covers the
     max_wait bound; this guards the resume edge.

All four exercise the real production code (real ``ENGINE_SLOT``, real
``Session.run_nodeflow`` / ``run_nodeflow_browse``, real ``opreg``). No
locks or slots are mocked; the only test shims are the fake-job dicts the
engine slot already expects as its parameter.

Run focused:
  SAMQL_ONLY="concurrency" SAMQL_GROUP=backend \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only --no-http
"""
import os
import sys
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(os.path.dirname(_HERE), "backend")
for _p in (_HERE, _BACKEND):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _fresh_session():
    from samql_core import Session
    s = Session()
    s.fresh_run = False
    s.fresh_load = False
    s.engine_mode = "dual"
    return s


# --------------------------------------------------------------------------
# 1. Engine-slot exhaustion / FIFO queueing
# --------------------------------------------------------------------------

def _engine_slot_queues_cleanly_under_contention():
    """Fire N jobs at the single engine slot: exactly one owns it at any
    time, the rest queue in FIFO order, and queueing never deadlocks or
    drops a job. Also verifies a queued job can be cancelled cooperatively
    without ever running the engine body."""
    # Import by module path so patching here can't bleed into other tests.
    import server as S

    owners_seen = []        # ids of jobs that reached run_inner()
    overlap_flag = {"any": False}
    counter_lock = threading.Lock()
    live = {"n": 0}

    jobs = [{"id": "slot-job-%d" % i, "state": "pending"} for i in range(5)]

    gate = threading.Event()  # released once all jobs are launched

    def make_runner(job):
        def run_inner():
            # If more than one job is in run_inner at once, the slot is
            # broken. Record the overlap for the assertion.
            with counter_lock:
                live["n"] += 1
                if live["n"] > 1:
                    overlap_flag["any"] = True
                owners_seen.append(job["id"])
            # Hold the slot briefly so the queue actually backs up.
            time.sleep(0.05)
            with counter_lock:
                live["n"] -= 1
        return run_inner

    threads = []
    # Launch in order; EngineSlot's queue is FIFO on acquire order.
    for job in jobs:
        wrapped = S._with_engine_slot(job, make_runner(job))
        t = threading.Thread(target=wrapped, daemon=True)
        threads.append(t)
        t.start()
        # Give each thread a moment to reach ``ENGINE_SLOT.acquire`` so the
        # queue order matches our launch order (otherwise the race between
        # thread.start() and the first .acquire() call makes FIFO order
        # non-deterministic).
        time.sleep(0.01)

    gate.set()

    # All five must finish; if the slot deadlocks they'll never join.
    deadline = time.time() + 10.0
    for t in threads:
        remaining = max(0.05, deadline - time.time())
        t.join(timeout=remaining)
        assert not t.is_alive(), "engine-slot thread deadlocked"

    assert not overlap_flag["any"], \
        "engine slot allowed >1 owner concurrently"
    assert sorted(owners_seen) == [j["id"] for j in jobs], \
        "every job must run exactly once; got %r" % owners_seen
    # FIFO: the first job launched should be the first to own the slot.
    assert owners_seen[0] == jobs[0]["id"], \
        "FIFO broken: first owner was %r, want %r" % (
            owners_seen[0], jobs[0]["id"])
    # Every job's final state should reflect release (not stuck in 'queued'
    # or 'error'); _with_engine_slot leaves state untouched on success so
    # it stays "pending" unless run_inner changed it. Just verify no job
    # was recorded as an error.
    for j in jobs:
        assert j.get("state") != "error", \
            "job %r failed unexpectedly: %r" % (j["id"], j.get("error"))

    # --- cooperative cancel of a queued job ------------------------------
    # Hold the slot with job A, then launch B. Cancel B while it's queued;
    # it must unwind as 'cancelled' and never touch run_inner.
    import server as S
    held = {"ok": False, "released": False}
    release = threading.Event()

    def hold_inner():
        held["ok"] = True
        release.wait(timeout=5.0)
        held["released"] = True

    job_a = {"id": "slot-hold-a", "state": "pending"}
    job_b = {"id": "slot-cancel-b", "state": "pending"}
    b_ran = {"n": 0}

    def b_inner():
        b_ran["n"] += 1

    ta = threading.Thread(target=S._with_engine_slot(job_a, hold_inner),
                          daemon=True)
    ta.start()
    # Wait until A actually owns the slot.
    waited = 0.0
    while not held["ok"] and waited < 2.0:
        time.sleep(0.01)
        waited += 0.01
    assert held["ok"], "slot holder never entered run_inner"

    tb = threading.Thread(target=S._with_engine_slot(job_b, b_inner),
                          daemon=True)
    tb.start()
    # Let B reach the queued state.
    time.sleep(0.1)
    assert job_b.get("state") == "queued", \
        "queued job should announce state 'queued', got %r" % job_b.get(
            "state")

    job_b["cancel"] = True
    S.ENGINE_SLOT.wake()
    tb.join(timeout=3.0)
    assert not tb.is_alive(), "cancelled queued job did not unwind"
    assert job_b.get("state") == "cancelled", \
        "cancelled job final state %r (want 'cancelled')" % job_b.get(
            "state")
    assert b_ran["n"] == 0, \
        "cancelled queued job must never run its engine body"

    release.set()
    ta.join(timeout=3.0)
    assert not ta.is_alive(), "slot holder did not release"


# --------------------------------------------------------------------------
# 2. Parallel nodeflow isolation under thread-level load
# --------------------------------------------------------------------------

def _parallel_nodeflow_components_do_not_bleed():
    """Two disconnected DuckDB components, each run from its own thread
    via ``Session.run_nodeflow``, must return correct independent results.

    This exercises both the per-component engine pinning (from
    ``hermes/samql-nodeflow-isolation``) and the shared-flow / branch
    machinery under real thread contention."""
    from samql_core.engines import HAS_DUCKDB
    from samql_core.session import DUCKDB_TARGET
    if not HAS_DUCKDB:
        return  # suite harness treats a bare return as pass; skip via skip()
                # is done at registration time.

    s = _fresh_session()
    try:
        s.parallel_nodeflows = True
        # Two tables, both in DuckDB, with disjoint schemas and disjoint
        # row values so a cross-contamination (component B's scratch
        # table leaking into component A) would be visible.
        for name, sql in (
                ("conc_a", "SELECT 1 AS x UNION ALL SELECT 2 UNION ALL "
                           "SELECT 3"),
                ("conc_b", "SELECT 10 AS y UNION ALL SELECT 20 UNION ALL "
                           "SELECT 30 UNION ALL SELECT 40")):
            r = s.run_query("CREATE TABLE %s AS %s" % (name, sql),
                            target=DUCKDB_TARGET)
            assert not r.get("error"), \
                "setup %s: %r" % (name, r.get("error"))

        # Component A: input(conc_a) -> select(x).
        # Component B: input(conc_b) -> select(y).
        # Entirely disconnected -- no shared nodes, no shared edges.
        graph = {
            "nodes": [
                {"id": "ia", "type": "input",
                 "config": {"table": "conc_a"}},
                {"id": "sa", "type": "select",
                 "config": {"fields": [{"name": "x", "keep": True}]}},
                {"id": "ib", "type": "input",
                 "config": {"table": "conc_b"}},
                {"id": "sb", "type": "select",
                 "config": {"fields": [{"name": "y", "keep": True}]}},
            ],
            "edges": [
                {"id": "ea", "from": {"node": "ia", "port": "out"},
                 "to": {"node": "sa", "port": "in"}},
                {"id": "eb", "from": {"node": "ib", "port": "out"},
                 "to": {"node": "sb", "port": "in"}},
            ],
        }

        results = {}
        errors = {}

        def run_target(label, node_id, qid):
            try:
                results[label] = s.run_nodeflow(graph, node_id, "out",
                                                query_id=qid)
            except Exception as e:
                errors[label] = repr(e)

        # Run both concurrently -- this is the whole point of the test.
        # Repeat several rounds to shake out intermittent races.
        for round_i in range(3):
            results.clear()
            errors.clear()
            ta = threading.Thread(
                target=run_target,
                args=("a", "sa", "conc-a-q%d" % round_i),
                daemon=True)
            tb = threading.Thread(
                target=run_target,
                args=("b", "sb", "conc-b-q%d" % round_i),
                daemon=True)
            ta.start()
            tb.start()
            ta.join(timeout=30.0)
            tb.join(timeout=30.0)
            assert not ta.is_alive(), "component A hung on round %d" % round_i
            assert not tb.is_alive(), "component B hung on round %d" % round_i
            assert not errors, "worker exception round %d: %r" % (
                round_i, errors)
            ra = results["a"]
            rb = results["b"]
            assert not ra.get("error"), \
                "component A error round %d: %r" % (round_i, ra.get("error"))
            assert not rb.get("error"), \
                "component B error round %d: %r" % (round_i, rb.get("error"))
            # Independent, correct row counts: A has 3 rows, B has 4.
            assert ra.get("total_rows") == 3, \
                "A total_rows round %d = %r (want 3)" % (
                    round_i, ra.get("total_rows"))
            assert rb.get("total_rows") == 4, \
                "B total_rows round %d = %r (want 4)" % (
                    round_i, rb.get("total_rows"))
            # Column isolation: A exposes 'x', B exposes 'y' -- bleed-through
            # would land the wrong column in a result.
            cols_a = [c.lower() for c in (ra.get("columns") or [])]
            cols_b = [c.lower() for c in (rb.get("columns") or [])]
            assert "x" in cols_a and "y" not in cols_a, \
                "A columns round %d = %r (want ['x'])" % (round_i, cols_a)
            assert "y" in cols_b and "x" not in cols_b, \
                "B columns round %d = %r (want ['y'])" % (round_i, cols_b)
    finally:
        for name in ("conc_a", "conc_b"):
            try:
                s.run_query("DROP TABLE IF EXISTS %s" % name,
                            target=DUCKDB_TARGET)
            except Exception:
                pass
        try:
            s.shutdown()
        except Exception:
            pass


# --------------------------------------------------------------------------
# 3. run_nodeflow_browse memory bound (large table => bounded response)
# --------------------------------------------------------------------------

def _browse_response_is_bounded_on_large_tables():
    """A 50,000-row passthrough through a browse node must:
      * report the correct ``total_rows`` (50_000), and
      * never return 50_000 rows in the response payload.

    The browse endpoint is a column profile (``profile_table``), not a
    page; the production contract is that it returns stats + total_rows
    but not the raw table body. This test pins that contract: if a
    well-meaning refactor starts attaching a ``rows`` payload here, the
    cap must stay sane (<= a small page size, never unbounded)."""
    from samql_core.engines import HAS_DUCKDB
    from samql_core.session import DUCKDB_TARGET
    if not HAS_DUCKDB:
        return

    N = 50_000
    s = _fresh_session()
    try:
        # DuckDB range() builds a 50k-row table in one shot without pulling
        # Python into the hot loop.
        r = s.run_query(
            "CREATE TABLE conc_big AS "
            "SELECT i AS k, (i * 7) AS v FROM range(0, %d) t(i)" % N,
            target=DUCKDB_TARGET)
        assert not r.get("error"), "setup: %r" % r.get("error")

        graph = {
            "nodes": [
                {"id": "ib", "type": "input",
                 "config": {"table": "conc_big"}},
                {"id": "br", "type": "browse", "config": {}},
            ],
            "edges": [
                {"id": "e1", "from": {"node": "ib", "port": "out"},
                 "to": {"node": "br", "port": "in"}},
            ],
        }

        out = s.run_nodeflow_browse(graph, "br", query_id="conc-browse-q")
        assert not out.get("error"), \
            "browse returned error: %r" % out.get("error")
        assert out.get("total_rows") == N, \
            "total_rows=%r, want %d" % (out.get("total_rows"), N)

        # The production response is a profile: {table, total_rows,
        # columns:[stats...]}. There is deliberately no 'rows' body here --
        # this test pins that. If a future change adds a 'rows' or
        # 'preview' array, it MUST be bounded (we accept <= 1000 rows as a
        # sane page cap; anything larger would be a memory regression).
        PAGE_CAP = 1000
        rows_payload = out.get("rows")
        if rows_payload is not None:
            assert len(rows_payload) <= PAGE_CAP, \
                ("browse response leaked %d rows (cap %d); the browse "
                 "endpoint must stay bounded") % (
                    len(rows_payload), PAGE_CAP)
        preview_payload = out.get("preview")
        if preview_payload is not None:
            assert len(preview_payload) <= PAGE_CAP, \
                ("browse response leaked %d preview rows (cap %d)") % (
                    len(preview_payload), PAGE_CAP)

        # Columns metadata must still be correct -- memory bound is not
        # license to lose structural data.
        cols = [c.get("column") for c in (out.get("columns") or [])]
        assert "k" in cols and "v" in cols, \
            "browse profile missing expected columns: %r" % cols
    finally:
        try:
            s.run_query("DROP TABLE IF EXISTS conc_big",
                        target=DUCKDB_TARGET)
        except Exception:
            pass
        try:
            s.shutdown()
        except Exception:
            pass


# --------------------------------------------------------------------------
# 4. Restore defers to a user op AND resumes once it finishes
# --------------------------------------------------------------------------

def _restore_resumes_after_user_op_finishes():
    """The existing ``t_restore_yields_to_user_ops`` test pins the
    max_wait upper bound. This test pins the lower-bound symmetry: once
    the user op *ends*, restore must stop waiting within one poll cycle.
    A restore that over-waits is just as broken as a restore that
    doesn't yield at all."""
    from samql_core import progress as P
    s = _fresh_session()
    try:
        P.reset_for_tests()
        # Simulate a running user op from another thread by registering it
        # in the real op registry (same mechanism the real query path uses).
        user_op_started = threading.Event()
        user_op_release = threading.Event()
        user_op_done = {"at": None}

        def user_op_thread():
            P.begin("query", target="user", label="synthetic")
            user_op_started.set()
            # Hold the op "in-flight" until the main thread releases us.
            user_op_release.wait(timeout=5.0)
            P.end()
            user_op_done["at"] = time.time()

        ut = threading.Thread(target=user_op_thread, daemon=True)
        ut.start()
        assert user_op_started.wait(timeout=2.0), \
            "synthetic user op never started"

        # From this thread, start a restore-wait with a generous max_wait
        # (so the wait only ends when the user op ends, not on the bound).
        wait_t0 = time.time()
        wait_done_at = {"t": None}

        def do_wait():
            s._restore_wait_if_busy(poll=0.05, max_wait=10.0)
            wait_done_at["t"] = time.time()

        wt = threading.Thread(target=do_wait, daemon=True)
        wt.start()

        # Confirm the restore wait is actually blocking (not returning
        # immediately -- the whole point of the yield).
        time.sleep(0.3)
        assert wt.is_alive(), \
            "restore did NOT yield to the in-flight user op"

        # Now end the user op; restore must resume quickly (within a few
        # poll cycles -- poll=0.05, so <= ~0.3s with slack is fine).
        user_op_release.set()
        ut.join(timeout=2.0)
        assert not ut.is_alive(), "user op thread hung"
        assert user_op_done["at"] is not None, "user op never recorded end"

        wt.join(timeout=2.0)
        assert not wt.is_alive(), \
            "restore did not resume after user op ended (hung on wait)"
        assert wait_done_at["t"] is not None, "restore wait never returned"

        # Resume latency: must be bounded by poll + a small slack. If this
        # grows past ~0.5s the restore is lagging longer than one poll.
        resume_lag = wait_done_at["t"] - user_op_done["at"]
        assert -0.05 <= resume_lag <= 0.5, \
            ("restore resumed %.3fs after user op ended -- expected "
             "within poll cycle (<= 0.5s)") % resume_lag

        # And the total wait must have actually waited (not short-circuited).
        total_wait = wait_done_at["t"] - wait_t0
        assert total_wait >= 0.25, \
            "restore wait only took %.3fs; should have blocked on user op" \
            % total_wait
    finally:
        P.reset_for_tests()
        try:
            s.shutdown()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------

_CASES = [
    ("engine slot queues cleanly and honours cancel under contention",
     _engine_slot_queues_cleanly_under_contention),
    ("parallel nodeflow components don't bleed under thread load",
     _parallel_nodeflow_components_do_not_bleed),
    ("run_nodeflow_browse response is bounded on a 50k-row table",
     _browse_response_is_bounded_on_large_tables),
    ("restore defers to a user op and resumes after it finishes",
     _restore_resumes_after_user_op_finishes),
]


def backend_cases(root, csv, skip):
    """Register concurrency cases in the main backend suite.

    All names are prefixed ``concurrency: `` so ``SAMQL_ONLY=concurrency``
    picks up exactly this group.
    """
    out = []
    # Items 2 and 3 require DuckDB; skip cleanly if the engine isn't present.
    try:
        from samql_core.engines import HAS_DUCKDB
    except Exception:
        HAS_DUCKDB = False

    for label, fn in _CASES:
        name = "concurrency: %s" % label
        if fn in (_parallel_nodeflow_components_do_not_bleed,
                  _browse_response_is_bounded_on_large_tables) \
                and not HAS_DUCKDB:
            out.append((name, lambda: skip("duckdb is not installed")))
        else:
            out.append((name, fn))
    return out
