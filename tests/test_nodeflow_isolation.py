"""
tests/test_nodeflow_isolation.py
Focused RED->GREEN suite for engine pinning scoped to a target's ancestors.

Defect: ``Session._flow_pinned_engine`` scanned every node on the canvas, so
a disconnected component whose inputs live in DuckDB made a run of a
SQLite-only component raise "All input tables in a flow must live in the same
engine" even though the target's ancestor closure is engine-pure. The fix
restricts the scan to the requested targets' ancestor closure.

Run focused:
  SAMQL_ONLY="nodeflow isolation" SAMQL_GROUP=backend \\
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


def _session():
    from samql_core import Session
    s = Session()
    s.fresh_run = False
    s.fresh_load = False
    # A persisted "duckdb" engine preference would route __local__ work to
    # DuckDB; dual mode keeps each table in the engine the test asks for.
    s.engine_mode = "dual"
    return s


def _graph():
    """Two disconnected components: in_a -> sel_a and in_b -> sel_b."""
    return {
        "nodes": [
            {"id": "in_a", "type": "input", "config": {"table": "iso_a"}},
            {"id": "sel_a", "type": "select",
             "config": {"fields": [{"name": "x", "keep": True}]}},
            {"id": "in_b", "type": "input", "config": {"table": "iso_b"}},
            {"id": "sel_b", "type": "select",
             "config": {"fields": [{"name": "y", "keep": True}]}},
        ],
        "edges": [
            {"id": "e1",
             "from": {"node": "in_a", "port": "out"},
             "to": {"node": "sel_a", "port": "in"}},
            {"id": "e2",
             "from": {"node": "in_b", "port": "out"},
             "to": {"node": "sel_b", "port": "in"}},
        ],
    }


def _with_split_tables(fn, skip):
    """Load iso_a into SQLite and iso_b into DuckDB, then run ``fn(s)``."""
    from samql_core.engines import HAS_DUCKDB
    from samql_core.session import DUCKDB_TARGET, LOCAL_TARGET
    if not HAS_DUCKDB:
        skip("duckdb is not installed")
    s = _session()
    try:
        for name, sql, target, want in (
                ("iso_a", "SELECT 1 AS x UNION ALL SELECT 2",
                 LOCAL_TARGET, "sqlite"),
                ("iso_b", "SELECT 3 AS y UNION ALL SELECT 4",
                 DUCKDB_TARGET, "duckdb")):
            r = s.run_query("CREATE TABLE %s AS %s" % (name, sql),
                            target=target)
            assert not r.get("error"), "create %s: %r" % (name, r.get("error"))
            got = s._engine_of_table(name)
            assert got == want, "%s landed in %r, want %r" % (name, got, want)
        fn(s)
    finally:
        for name, target in (("iso_a", LOCAL_TARGET),
                             ("iso_b", DUCKDB_TARGET)):
            try:
                s.run_query("DROP TABLE IF EXISTS %s" % name, target=target)
            except Exception:
                pass
        try:
            s.shutdown()
        except Exception:
            pass


def _sqlite_component_ignores_duckdb_component(s):
    r = s.run_nodeflow(_graph(), "sel_a", "out")
    assert not r.get("error"), "Got error: %r" % r.get("error")
    assert r.get("total_rows") == 2, \
        "Expected 2 rows, got %r" % r.get("total_rows")


def _duckdb_component_ignores_sqlite_component(s):
    r = s.run_nodeflow(_graph(), "sel_b", "out")
    assert not r.get("error"), "Got error: %r" % r.get("error")
    assert r.get("total_rows") == 2, \
        "Expected 2 rows, got %r" % r.get("total_rows")


def _connected_mixed_engines_still_rejected(s):
    # Guard stays intact: a target whose ancestors span both engines.
    g = {
        "nodes": [
            {"id": "in_a", "type": "input", "config": {"table": "iso_a"}},
            {"id": "in_b", "type": "input", "config": {"table": "iso_b"}},
            {"id": "u", "type": "union", "config": {}},
        ],
        "edges": [
            {"id": "e1", "from": {"node": "in_a", "port": "out"},
             "to": {"node": "u", "port": "in1"}},
            {"id": "e2", "from": {"node": "in_b", "port": "out"},
             "to": {"node": "u", "port": "in2"}},
        ],
    }
    r = s.run_nodeflow(g, "u", "out")
    assert "same engine" in str(r.get("error") or ""), \
        "mixed-engine closure must be rejected, got %r" % r.get("error")


_CASES = [
    ("disconnected DuckDB component does not poison a SQLite run",
     _sqlite_component_ignores_duckdb_component),
    ("disconnected SQLite component does not poison a DuckDB run",
     _duckdb_component_ignores_sqlite_component),
    ("connected mixed-engine closure is still rejected",
     _connected_mixed_engines_still_rejected),
]


def backend_cases(root, csv, skip):
    """Register cases in the main backend suite."""
    return [("nodeflow isolation: %s" % label,
             (lambda fn=fn: _with_split_tables(fn, skip)))
            for label, fn in _CASES]
