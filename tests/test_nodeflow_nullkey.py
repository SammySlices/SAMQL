"""
tests/test_nodeflow_nullkey.py
Focused RED->GREEN suite for NULL-safe key matching in the reconcile node.

Defect: the reconcile node joined its per-key aggregates with ``LA.k = RA.k``.
SQL ``=`` yields NULL (not TRUE) when either side is NULL, so a NULL key that
exists on both sides was reported as left_only + right_only instead of
matched. The fix uses ``IS`` (SQLite) / ``IS NOT DISTINCT FROM`` (DuckDB).

Every case runs through the public ``Session.run_nodeflow`` path on SQLite and,
when installed, on DuckDB (the engine is pinned by where the input tables live).

Run focused:
  SAMQL_ONLY="nodeflow_nullkey" SAMQL_GROUP=backend \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only
"""
import os
import sys

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
    # A persisted "duckdb" engine preference would route __local__ work to
    # DuckDB; dual mode keeps each table in the engine the test asks for.
    s.engine_mode = "dual"
    return s


def _reconcile(engine, left_sql, right_sql, keys, skip):
    """Load two tables into ``engine`` and run a reconcile node over them.

    Returns the result rows as dicts keyed by column name.
    """
    from samql_core.session import DUCKDB_TARGET, LOCAL_TARGET
    if engine == "duckdb":
        from samql_core.engines import HAS_DUCKDB
        if not HAS_DUCKDB:
            skip("duckdb is not installed")
    target = DUCKDB_TARGET if engine == "duckdb" else LOCAL_TARGET
    s = _session()
    try:
        for name, sql in (("nk_left", left_sql), ("nk_right", right_sql)):
            r = s.run_query("CREATE TABLE %s AS %s" % (name, sql),
                            target=target)
            assert not r.get("error"), "create %s: %r" % (name, r.get("error"))
            got = s._engine_of_table(name)
            assert got == engine, "%s landed in %r, want %r" % (
                name, got, engine)
        g = {"nodes": [
            {"id": "l", "type": "input", "config": {"table": "nk_left"}},
            {"id": "r", "type": "input", "config": {"table": "nk_right"}},
            {"id": "rc", "type": "reconcile", "config": {"keys": keys}},
        ], "edges": [
            {"id": "e1", "from": {"node": "l", "port": "out"},
             "to": {"node": "rc", "port": "left"}},
            {"id": "e2", "from": {"node": "r", "port": "out"},
             "to": {"node": "rc", "port": "right"}},
        ]}
        res = s.run_nodeflow(g, "rc", "out")
        assert not res.get("error"), "reconcile run: %r" % res.get("error")
        page = s.page(res["result_id"], offset=0, limit=1000)
        cols = [c if isinstance(c, str) else c.get("name")
                for c in (page.get("columns") or res.get("columns") or [])]
        return [dict(zip(cols, row)) for row in page["rows"]]
    finally:
        for name in ("nk_left", "nk_right"):
            try:
                s.run_query("DROP TABLE IF EXISTS %s" % name, target=target)
            except Exception:
                pass
        try:
            s.shutdown()
        except Exception:
            pass


def _summary(rows, keys):
    return [(tuple(r[k] for k in keys), r["reconcile_status"],
             r["left_rows"], r["right_rows"]) for r in rows]


def _expect(rows, keys, want, label):
    got = _summary(rows, keys)
    want = sorted(want, key=repr)
    got = sorted(got, key=repr)
    assert got == want, "%s:\n  got  %r\n  want %r" % (label, got, want)


def _null_both_sides(engine, skip):
    rows = _reconcile(
        engine,
        "SELECT CAST(NULL AS VARCHAR) AS k, 1 AS v",
        "SELECT CAST(NULL AS VARCHAR) AS k, 2 AS v",
        ["k"], skip)
    _expect(rows, ["k"], [((None,), "matched", 1, 1)],
            "NULL key on both sides must be matched")


def _null_left_only(engine, skip):
    rows = _reconcile(
        engine,
        "SELECT CAST(NULL AS VARCHAR) AS k, 1 AS v "
        "UNION ALL SELECT 'a', 2",
        "SELECT 'a' AS k, 3 AS v",
        ["k"], skip)
    _expect(rows, ["k"], [((None,), "left_only", 1, None),
                          (("a",), "matched", 1, 1)],
            "NULL key only on left must be left_only")


def _null_right_only(engine, skip):
    rows = _reconcile(
        engine,
        "SELECT 'a' AS k, 1 AS v",
        "SELECT CAST(NULL AS VARCHAR) AS k, 2 AS v "
        "UNION ALL SELECT 'a', 3",
        ["k"], skip)
    _expect(rows, ["k"], [((None,), "right_only", None, 1),
                          (("a",), "matched", 1, 1)],
            "NULL key only on right must be right_only")


def _non_null_regression(engine, skip):
    rows = _reconcile(
        engine,
        "SELECT 'a' AS k, 1 AS v UNION ALL SELECT 'a', 2 "
        "UNION ALL SELECT 'b', 3",
        "SELECT 'a' AS k, 4 AS v UNION ALL SELECT 'c', 5",
        ["k"], skip)
    _expect(rows, ["k"], [(("a",), "matched", 2, 1),
                          (("b",), "left_only", 1, None),
                          (("c",), "right_only", None, 1)],
            "non-NULL keys still reconcile")


def _multikey_partial_null(engine, skip):
    # Left (x, NULL) vs right (x, 'y'): first key matches, second does not
    # (NULL vs a value) -- a partial match is not a match.
    rows = _reconcile(
        engine,
        "SELECT 'x' AS k1, CAST(NULL AS VARCHAR) AS k2, 1 AS v",
        "SELECT 'x' AS k1, 'y' AS k2, 2 AS v",
        ["k1", "k2"], skip)
    _expect(rows, ["k1", "k2"], [(("x", None), "left_only", 1, None),
                                 (("x", "y"), "right_only", None, 1)],
            "multi-key with one NULL key must not match")


_CASES = [
    ("NULL key on both sides is matched", _null_both_sides),
    ("NULL key only on left is left_only", _null_left_only),
    ("NULL key only on right is right_only", _null_right_only),
    ("non-NULL keys still reconcile", _non_null_regression),
    ("multi-key partial NULL match is left_only", _multikey_partial_null),
]


def backend_cases(root, csv, skip):
    """Register cases in the main backend suite."""
    out = []
    for engine in ("sqlite", "duckdb"):
        for label, fn in _CASES:
            out.append((
                "nodeflow_nullkey [%s]: reconcile %s" % (engine, label),
                (lambda fn=fn, engine=engine: fn(engine, skip))))
    return out
