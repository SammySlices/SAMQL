"""
tests/test_ui_freshness.py
Backend contract guards for UI freshness invariants.

Covered contracts:
A  reconcile() returns data_epoch and advances on upstream mutation.
B  run_nodeflow() returns data_epoch and advances on upstream mutation.
C  status() returns the engines shape ActivityShared.tsx depends on.
D  relation_columns() reflects fresh schema after a drop+recreate
   (no stale column cache — Field Explorer freshness invalidation).

Run focused:
  SAMQL_ONLY="ui freshness" SAMQL_GROUP=backend \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only --no-http
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(os.path.dirname(_HERE), "backend")
for _p in (_HERE, _BACKEND):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _fresh_session(**kw):
    from samql_core import Session
    s = Session(**kw)
    s.fresh_run = False
    s.fresh_load = False
    return s


def _replace_table(s, name, cols, rows):
    """Drop ``name`` and recreate it under the same name with new rows.

    Routes DROP through the session (``s.drop_table``) so content mutations
    advance ``_data_epoch`` the way a real UI write would; the engine-level
    ``s.db.drop_table`` skips that bump and lets a stale result read live.
    """
    s.drop_table("sqlite", name)
    s.db.add_table_streaming(name, cols, iter(rows))
    s.db.sync_catalog()


def _reconcile_data_epoch_advances():
    s = _fresh_session()
    try:
        cols = ["id", "amt"]
        s.db.add_table_streaming("ta", cols, iter([(1, 10), (2, 20), (3, 30)]))
        s.db.add_table_streaming("tb", cols, iter([(2, 20), (3, 30), (4, 40)]))
        s.db.sync_catalog()
        spec = {"left": "ta", "right": "tb", "keys": ["id"]}

        res1 = s.reconcile(spec)
        assert "error" not in res1, "first reconcile errored: %r" % (
            res1.get("error"),)
        assert "data_epoch" in res1, (
            "reconcile result is missing data_epoch: keys=%r"
            % sorted(res1))
        assert isinstance(res1["data_epoch"], int), (
            "data_epoch must be int, got %r" % (res1["data_epoch"],))
        ep1 = res1["data_epoch"]
        totals1 = dict(res1["totals"])

        _replace_table(s, "ta", cols,
                       [(2, 20), (3, 30), (4, 40), (5, 50), (6, 60)])

        res2 = s.reconcile(spec)
        assert "error" not in res2, "second reconcile errored: %r" % (
            res2.get("error"),)
        ep2 = res2["data_epoch"]
        assert ep2 > ep1, (
            "data_epoch did not advance after mutating ta: %r -> %r"
            % (ep1, ep2))
        assert res2["totals"] != totals1, (
            "reconcile totals unchanged after mutation (stale read?): %r"
            % (totals1,))
    finally:
        s.shutdown()


def _nodeflow_data_epoch_advances():
    s = _fresh_session()
    try:
        s.flow_cache = False
        # Seed src on SQLite so the whole flow (and the replace below) stays
        # on one engine — the default dest is DuckDB, which would otherwise
        # own `src` and `s.drop_table("sqlite", "src")` would be a no-op.
        s.db.add_table_streaming("src", ["g", "v"],
                                 iter([(1, 10), (2, 20)]))
        s.db.sync_catalog()
        g = {"nodes": [
            {"id": "n1", "type": "input", "config": {"table": "src"}},
            {"id": "n2", "type": "output", "config": {"label": "out"}}],
             "edges": [{"from": {"node": "n1", "port": "out"},
                        "to": {"node": "n2", "port": "in"}}]}

        r1 = s.run_nodeflow(g, "n2", "out")
        assert not r1.get("error"), "first run_nodeflow errored: %r" % (
            r1.get("error"),)
        assert "data_epoch" in r1, (
            "run_nodeflow result is missing data_epoch: keys=%r" % sorted(r1))
        assert isinstance(r1["data_epoch"], int), (
            "data_epoch must be int, got %r" % (r1["data_epoch"],))
        ep1 = r1["data_epoch"]

        _replace_table(s, "src", ["g", "v"], [(3, 30), (4, 40), (5, 50)])

        r2 = s.run_nodeflow(g, "n2", "out")
        assert not r2.get("error"), "second run_nodeflow errored: %r" % (
            r2.get("error"),)
        assert r2["data_epoch"] > ep1, (
            "data_epoch did not advance after mutating src: %r -> %r"
            % (ep1, r2["data_epoch"]))
        assert r2["total_rows"] != r1["total_rows"], (
            "run_nodeflow total_rows unchanged after mutation (stale?): %r"
            % (r1["total_rows"],))
    finally:
        s.shutdown()


def _status_shape_contract():
    s = _fresh_session()
    try:
        st = s.status()
        assert isinstance(st, dict), "status() must return a dict: %r" % (
            type(st),)
        assert isinstance(st.get("engines"), dict), (
            "status()['engines'] must be a dict: %r" % (st.get("engines"),))
        for eng in ("sqlite", "duckdb"):
            info = st["engines"].get(eng)
            assert isinstance(info, dict), (
                "status()['engines'][%r] must be a dict: %r" % (eng, info))
            assert isinstance(info.get("busy"), bool), (
                "status()['engines'][%r]['busy'] must be bool: %r"
                % (eng, info.get("busy")))
        assert st["engines"]["sqlite"]["active"] is True, (
            "sqlite engine must report active=True: %r"
            % (st["engines"]["sqlite"],))
        assert isinstance(st["engines"]["duckdb"].get("active"), bool), (
            "duckdb engine must report a bool 'active': %r"
            % (st["engines"]["duckdb"],))
        assert "operations" in st, "status() missing 'operations'"
        assert isinstance(st.get("threads"), int) and st["threads"] >= 1, (
            "status()['threads'] must be int >= 1: %r" % (st.get("threads"),))
        assert isinstance(st.get("restoring"), bool), (
            "status()['restoring'] must be bool: %r" % (st.get("restoring"),))
    finally:
        s.shutdown()


def _relation_columns_fresh_after_schema_change():
    s = _fresh_session()
    try:
        s.db.add_table_streaming("fe_t", ["id", "name"],
                                 iter([(1, "a"), (2, "b")]))
        s.db.sync_catalog()
        cols1 = s.relation_columns('SELECT * FROM "fe_t"')
        assert cols1 == ["id", "name"], "initial columns wrong: %r" % (cols1,)

        _replace_table(s, "fe_t", ["id", "price", "qty"], [(1, 9.99, 3)])

        cols2 = s.relation_columns('SELECT * FROM "fe_t"')
        assert cols2 == ["id", "price", "qty"], (
            "relation_columns returned stale schema after recreate: %r"
            % (cols2,))
        cols3 = s.relation_columns('SELECT price FROM "fe_t"')
        assert cols3 == ["price"], (
            "projected relation_columns wrong: %r" % (cols3,))
    finally:
        s.shutdown()


_CASES = [
    ("reconcile returns data_epoch and advances on mutation",
     _reconcile_data_epoch_advances),
    ("run_nodeflow returns data_epoch and advances on upstream mutation",
     _nodeflow_data_epoch_advances),
    ("status() shape has engines sqlite+duckdb with busy flags",
     _status_shape_contract),
    ("relation_columns reflects fresh schema after drop+recreate",
     _relation_columns_fresh_after_schema_change),
]


def backend_cases(root, csv, skip):
    return [("ui freshness: %s" % label, fn) for label, fn in _CASES]
