"""
tests/test_nodeflow_node_coverage.py
run_nodeflow coverage for 11 node types that previously had no flow-execution
tests: date, dedupe, explode, fill, jsonextract, maprecode, parse,
perioddelta, textclean, validate, while.

SKIP notes
----------
* while -- The ``while`` node raises NodeflowError when read as a data port
  (``node_output_sql`` explicitly rejects it with "Run with its Run button").
  Its actual execution goes through ``Session.run_while()``, NOT
  ``run_nodeflow``.  A ``while`` test is included below using ``run_while``,
  which is the correct and only public API for this node.  It therefore
  appears in the SAMQL_ONLY="node coverage" filter group but NOT in the
  duplicated "nodeflow" group (because run_while is a separate entrypoint).

Engine note
-----------
All fixture tables are created with ``target="__local__"`` to pin them to
the SQLite engine regardless of whether DuckDB is the session default.  This
keeps the tests self-contained and fast; the SQLite path of every node under
test is well exercised.  DuckDB-path coverage for the same nodes is left to
the DuckDB-specific suites and integration tests.

Run focused:
  SAMQL_ONLY="node coverage" SAMQL_GROUP=backend \\
      /root/workspace/SAMQL/.samql-test-venv/bin/python \\
      tests/run_tests.py --backend-only --no-http

  SAMQL_ONLY="nodeflow" SAMQL_GROUP=backend \\
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

_LOCAL = "__local__"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _fresh_session():
    from samql_core import Session
    s = Session()
    s.fresh_run = False
    s.fresh_load = False
    return s


def _make_table(sess, name, sql):
    """Create a table pinned to SQLite (``__local__``)."""
    r = sess.run_query(
        "CREATE TABLE %s AS %s" % (name, sql), target=_LOCAL)
    assert not r.get("error"), "create %s: %r" % (name, r.get("error"))


def _simple_graph(input_table, node_id, node_type, node_cfg):
    """Build a minimal input -> node graph."""
    return {
        "nodes": [
            {"id": "inp", "type": "input", "config": {"table": input_table}},
            {"id": node_id, "type": node_type, "config": node_cfg},
        ],
        "edges": [
            {
                "id": "e1",
                "from": {"node": "inp", "port": "out"},
                "to": {"node": node_id, "port": "in"},
            }
        ],
    }


def _run(sess, graph, node_id, port="out"):
    return sess.run_nodeflow(graph, node_id, port)


# ---------------------------------------------------------------------------
# date — part
# ---------------------------------------------------------------------------

def t_date_part_year():
    s = _fresh_session()
    try:
        # Use DATE() to ensure the column is stored as a date integer in SQLite,
        # not as plain text -- the date node uses strftime() which works on both.
        _make_table(s, "nc_date_part_yr",
                    "SELECT DATE('2024-06-15') AS dt, 42 AS v")
        g = _simple_graph("nc_date_part_yr", "dn", "date",
                          {"col": "dt", "op": "part", "part": "year"})
        r = _run(s, g, "dn")
        assert not r.get("error"), "date part year: %r" % r.get("error")
        assert r.get("total_rows") == 1, \
            "expected 1 row, got %r" % r.get("total_rows")
        rows = r.get("rows") or []
        assert any(2024 in row for row in rows), \
            "expected year=2024 in rows, got: %r" % rows
    finally:
        s.shutdown()


def t_date_part_month():
    s = _fresh_session()
    try:
        _make_table(s, "nc_date_part_mo",
                    "SELECT DATE('2024-06-15') AS ts, 1 AS id")
        g = _simple_graph("nc_date_part_mo", "dm", "date",
                          {"col": "ts", "op": "part", "part": "month"})
        r = _run(s, g, "dm")
        assert not r.get("error"), "date part month: %r" % r.get("error")
        assert r.get("total_rows") == 1
        rows = r.get("rows") or []
        assert any(6 in row for row in rows), \
            "expected month=6 in rows, got: %r" % rows
    finally:
        s.shutdown()


def t_date_trunc():
    s = _fresh_session()
    try:
        _make_table(s, "nc_date_trunc_mo",
                    "SELECT DATE('2024-06-15') AS dt, 'x' AS lbl "
                    "UNION ALL SELECT DATE('2024-06-20'), 'y'")
        g = _simple_graph("nc_date_trunc_mo", "dtr", "date",
                          {"col": "dt", "op": "trunc", "unit": "month"})
        r = _run(s, g, "dtr")
        assert not r.get("error"), "date trunc: %r" % r.get("error")
        assert r.get("total_rows") == 2, \
            "expected 2 rows, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# dedupe
# ---------------------------------------------------------------------------

def t_dedupe_basic():
    s = _fresh_session()
    try:
        _make_table(s, "nc_dedupe_basic",
                    "SELECT 'alice' AS name, 1 AS score "
                    "UNION ALL SELECT 'alice', 2 "
                    "UNION ALL SELECT 'bob', 3")
        g = _simple_graph("nc_dedupe_basic", "dd", "dedupe",
                          {"keys": ["name"]})
        r = _run(s, g, "dd")
        assert not r.get("error"), "dedupe basic: %r" % r.get("error")
        assert r.get("total_rows") == 2, \
            "dedupe should keep 2 distinct names, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


def t_dedupe_multi_key():
    s = _fresh_session()
    try:
        _make_table(s, "nc_dedupe_mkey",
                    "SELECT 'A' AS cat, 1 AS sub, 10 AS v "
                    "UNION ALL SELECT 'A', 1, 20 "
                    "UNION ALL SELECT 'A', 2, 30 "
                    "UNION ALL SELECT 'B', 1, 40")
        g = _simple_graph("nc_dedupe_mkey", "ddm", "dedupe",
                          {"keys": ["cat", "sub"]})
        r = _run(s, g, "ddm")
        assert not r.get("error"), "dedupe multi-key: %r" % r.get("error")
        assert r.get("total_rows") == 3, \
            "dedupe (cat,sub) should yield 3 rows, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# explode — json mode (SQLite json_each) and delim mode
# ---------------------------------------------------------------------------

def t_explode_delim():
    s = _fresh_session()
    try:
        _make_table(s, "nc_explode_dlm",
                    "SELECT 1 AS id, 'a,b,c' AS tags "
                    "UNION ALL SELECT 2, 'x,y'")
        g = _simple_graph("nc_explode_dlm", "ex", "explode",
                          {"col": "tags", "mode": "delim", "delim": ","})
        r = _run(s, g, "ex")
        assert not r.get("error"), "explode delim: %r" % r.get("error")
        assert r.get("total_rows") == 5, \
            "explode delim should produce 5 rows, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


def t_explode_json():
    """Explode a JSON-array column (SQLite json_each path)."""
    s = _fresh_session()
    try:
        _make_table(s, "nc_explode_jsn",
                    "SELECT 1 AS id, '[\"apple\",\"banana\"]' AS items "
                    "UNION ALL SELECT 2, '[\"cat\"]'")
        g = _simple_graph("nc_explode_jsn", "exj", "explode",
                          {"col": "items", "mode": "json", "name": "item"})
        r = _run(s, g, "exj")
        assert not r.get("error"), "explode json: %r" % r.get("error")
        # 2 items from row 1 + 1 from row 2 = 3 total
        assert r.get("total_rows") == 3, \
            "explode json should produce 3 rows, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# fill
# ---------------------------------------------------------------------------

def t_fill_value():
    s = _fresh_session()
    try:
        _make_table(s, "nc_fill_val",
                    "SELECT 1 AS id, NULL AS score "
                    "UNION ALL SELECT 2, 5.0 "
                    "UNION ALL SELECT 3, NULL")
        g = _simple_graph("nc_fill_val", "fi", "fill",
                          {"fills": [{"col": "score", "method": "value",
                                      "value": "0"}]})
        r = _run(s, g, "fi")
        assert not r.get("error"), "fill value: %r" % r.get("error")
        assert r.get("total_rows") == 3
        # NULLs should be replaced
        rows = r.get("rows") or []
        cols = r.get("columns") or []
        score_idx = next(
            (i for i, c in enumerate(cols)
             if (c if isinstance(c, str) else c.get("name", "")) == "score"),
            None)
        if score_idx is not None:
            assert all(row[score_idx] is not None for row in rows), \
                "fill value left NULLs: %r" % rows
    finally:
        s.shutdown()


def t_fill_avg():
    s = _fresh_session()
    try:
        _make_table(s, "nc_fill_avg",
                    "SELECT 1 AS id, 10.0 AS score "
                    "UNION ALL SELECT 2, NULL "
                    "UNION ALL SELECT 3, 20.0")
        g = _simple_graph("nc_fill_avg", "fa", "fill",
                          {"fills": [{"col": "score", "method": "avg"}]})
        r = _run(s, g, "fa")
        assert not r.get("error"), "fill avg: %r" % r.get("error")
        assert r.get("total_rows") == 3
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# jsonextract
# ---------------------------------------------------------------------------

def t_jsonextract_single_field():
    s = _fresh_session()
    try:
        _make_table(s, "nc_jex_sngl",
                    "SELECT 1 AS id, '{\"name\":\"alice\",\"age\":30}' AS payload "
                    "UNION ALL SELECT 2, '{\"name\":\"bob\",\"age\":25}'")
        g = _simple_graph("nc_jex_sngl", "jx", "jsonextract",
                          {"col": "payload",
                           "extracts": [{"path": "$.name", "name": "person_name"},
                                        {"path": "$.age", "name": "person_age"}]})
        r = _run(s, g, "jx")
        assert not r.get("error"), "jsonextract: %r" % r.get("error")
        assert r.get("total_rows") == 2
        cols = [c if isinstance(c, str) else c.get("name", "")
                for c in (r.get("columns") or [])]
        assert "person_name" in cols, \
            "expected person_name in columns: %r" % cols
    finally:
        s.shutdown()


def t_jsonextract_nested_path():
    s = _fresh_session()
    try:
        _make_table(s, "nc_jex_nest",
                    "SELECT 1 AS id, '{\"addr\":{\"city\":\"NY\"}}' AS data")
        g = _simple_graph("nc_jex_nest", "jxb", "jsonextract",
                          {"col": "data",
                           "extracts": [{"path": "$.addr.city", "name": "city"}]})
        r = _run(s, g, "jxb")
        assert not r.get("error"), "jsonextract nested: %r" % r.get("error")
        assert r.get("total_rows") == 1
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "NY" in flat, "expected city=NY in %r" % flat
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# maprecode
# ---------------------------------------------------------------------------

def t_maprecode_basic():
    s = _fresh_session()
    try:
        _make_table(s, "nc_mr_basic",
                    "SELECT 'M' AS gender, 1 AS id "
                    "UNION ALL SELECT 'F', 2 "
                    "UNION ALL SELECT 'X', 3")
        g = _simple_graph("nc_mr_basic", "mr", "maprecode",
                          {"col": "gender",
                           "name": "gender",
                           "mappings": [{"from": "M", "to": "Male"},
                                        {"from": "F", "to": "Female"}],
                           "default": "passthrough"})
        r = _run(s, g, "mr")
        assert not r.get("error"), "maprecode: %r" % r.get("error")
        assert r.get("total_rows") == 3
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "Male" in flat and "Female" in flat, \
            "remap values not found: %r" % flat
    finally:
        s.shutdown()


def t_maprecode_default_value():
    s = _fresh_session()
    try:
        _make_table(s, "nc_mr_dflt",
                    "SELECT 'A' AS code, 10 AS n "
                    "UNION ALL SELECT 'Z', 20")
        g = _simple_graph("nc_mr_dflt", "mrb", "maprecode",
                          {"col": "code",
                           "name": "code",
                           "mappings": [{"from": "A", "to": "Alpha"}],
                           "default": "value",
                           "default_value": "Other"})
        r = _run(s, g, "mrb")
        assert not r.get("error"), "maprecode default value: %r" % r.get("error")
        assert r.get("total_rows") == 2
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "Alpha" in flat and "Other" in flat, \
            "expected Alpha and Other in rows: %r" % flat
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# parse
# ---------------------------------------------------------------------------

def t_parse_number():
    s = _fresh_session()
    try:
        _make_table(s, "nc_parse_num",
                    "SELECT '1,234.56' AS amount, 'a' AS tag "
                    "UNION ALL SELECT '2,000.00', 'b'")
        g = _simple_graph("nc_parse_num", "pn", "parse",
                          {"cols": ["amount"], "to": "number", "group": ","})
        r = _run(s, g, "pn")
        assert not r.get("error"), "parse number: %r" % r.get("error")
        assert r.get("total_rows") == 2
    finally:
        s.shutdown()


def t_parse_date():
    s = _fresh_session()
    try:
        _make_table(s, "nc_parse_dt",
                    "SELECT '2024-01-15' AS dt, 1 AS v "
                    "UNION ALL SELECT '2024-03-20', 2")
        g = _simple_graph("nc_parse_dt", "pd", "parse",
                          {"cols": ["dt"], "to": "date"})
        r = _run(s, g, "pd")
        assert not r.get("error"), "parse date: %r" % r.get("error")
        assert r.get("total_rows") == 2
    finally:
        s.shutdown()


def t_parse_integer():
    s = _fresh_session()
    try:
        _make_table(s, "nc_parse_int",
                    "SELECT '42' AS qty, 'x' AS lbl "
                    "UNION ALL SELECT '100', 'y'")
        g = _simple_graph("nc_parse_int", "pi", "parse",
                          {"cols": ["qty"], "to": "integer"})
        r = _run(s, g, "pi")
        assert not r.get("error"), "parse integer: %r" % r.get("error")
        assert r.get("total_rows") == 2
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# perioddelta
# ---------------------------------------------------------------------------

def t_perioddelta_absolute():
    s = _fresh_session()
    try:
        _make_table(s, "nc_pd_abs",
                    "SELECT 1 AS period, 100.0 AS revenue "
                    "UNION ALL SELECT 2, 120.0 "
                    "UNION ALL SELECT 3, 110.0")
        g = _simple_graph("nc_pd_abs", "pda", "perioddelta",
                          {"value": "revenue", "order": "period",
                           "mode": "absolute", "out": "chg"})
        r = _run(s, g, "pda")
        assert not r.get("error"), "perioddelta absolute: %r" % r.get("error")
        assert r.get("total_rows") == 3
        cols = [c if isinstance(c, str) else c.get("name", "")
                for c in (r.get("columns") or [])]
        assert "chg" in cols, "expected 'chg' column in %r" % cols
    finally:
        s.shutdown()


def t_perioddelta_percent():
    s = _fresh_session()
    try:
        _make_table(s, "nc_pd_pct",
                    "SELECT 1 AS period, 100.0 AS revenue "
                    "UNION ALL SELECT 2, 150.0")
        g = _simple_graph("nc_pd_pct", "pdp", "perioddelta",
                          {"value": "revenue", "order": "period",
                           "mode": "percent", "out": "pct_chg"})
        r = _run(s, g, "pdp")
        assert not r.get("error"), "perioddelta percent: %r" % r.get("error")
        assert r.get("total_rows") == 2
    finally:
        s.shutdown()


def t_perioddelta_running_total():
    s = _fresh_session()
    try:
        _make_table(s, "nc_pd_run",
                    "SELECT 1 AS period, 10.0 AS v "
                    "UNION ALL SELECT 2, 20.0 "
                    "UNION ALL SELECT 3, 5.0")
        g = _simple_graph("nc_pd_run", "pdrt", "perioddelta",
                          {"value": "v", "order": "period",
                           "mode": "running_total", "out": "cumsum"})
        r = _run(s, g, "pdrt")
        assert not r.get("error"), \
            "perioddelta running_total: %r" % r.get("error")
        assert r.get("total_rows") == 3
        cols = [c if isinstance(c, str) else c.get("name", "")
                for c in (r.get("columns") or [])]
        assert "cumsum" in cols, "expected 'cumsum' column in %r" % cols
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# textclean
# ---------------------------------------------------------------------------

def t_textclean_trim_upper():
    s = _fresh_session()
    try:
        _make_table(s, "nc_tc_trup",
                    "SELECT '  hello  ' AS name, 1 AS id "
                    "UNION ALL SELECT ' world ', 2")
        g = _simple_graph("nc_tc_trup", "tc", "textclean",
                          {"cols": ["name"],
                           "ops": [{"op": "trim"}, {"op": "upper"}]})
        r = _run(s, g, "tc")
        assert not r.get("error"), "textclean trim+upper: %r" % r.get("error")
        assert r.get("total_rows") == 2
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "HELLO" in flat and "WORLD" in flat, \
            "expected HELLO and WORLD in %r" % flat
    finally:
        s.shutdown()


def t_textclean_replace():
    s = _fresh_session()
    try:
        _make_table(s, "nc_tc_repl",
                    "SELECT 'foo-bar' AS slug, 10 AS n "
                    "UNION ALL SELECT 'baz-qux', 20")
        g = _simple_graph("nc_tc_repl", "tcb", "textclean",
                          {"cols": ["slug"],
                           "ops": [{"op": "replace", "find": "-",
                                    "replace": "_"}]})
        r = _run(s, g, "tcb")
        assert not r.get("error"), "textclean replace: %r" % r.get("error")
        assert r.get("total_rows") == 2
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "foo_bar" in flat, "expected foo_bar in %r" % flat
    finally:
        s.shutdown()


def t_textclean_lower():
    s = _fresh_session()
    try:
        _make_table(s, "nc_tc_lowr",
                    "SELECT 'HELLO' AS word, 1 AS id "
                    "UNION ALL SELECT 'WORLD', 2")
        g = _simple_graph("nc_tc_lowr", "tcc", "textclean",
                          {"cols": ["word"],
                           "ops": [{"op": "lower"}]})
        r = _run(s, g, "tcc")
        assert not r.get("error"), "textclean lower: %r" % r.get("error")
        assert r.get("total_rows") == 2
        rows = r.get("rows") or []
        flat = [str(v) for row in rows for v in row]
        assert "hello" in flat and "world" in flat, \
            "expected lowercase in %r" % flat
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# validate — passes data through; run_nodeflow returns rows unchanged
# ---------------------------------------------------------------------------

def t_validate_passthrough():
    s = _fresh_session()
    try:
        _make_table(s, "nc_val_pass",
                    "SELECT 1 AS id, 'alice' AS name "
                    "UNION ALL SELECT 2, 'bob' "
                    "UNION ALL SELECT 3, 'carol'")
        # validate node just passes data through; config can be empty
        g = _simple_graph("nc_val_pass", "vl", "validate",
                          {"rules": []})
        r = _run(s, g, "vl")
        assert not r.get("error"), "validate passthrough: %r" % r.get("error")
        assert r.get("total_rows") == 3, \
            "validate passthrough must keep all rows, got %r" % r.get("total_rows")
    finally:
        s.shutdown()


def t_validate_passthrough_columns_intact():
    s = _fresh_session()
    try:
        _make_table(s, "nc_val_cols",
                    "SELECT 10 AS x, 20 AS y, 30 AS z")
        g = _simple_graph("nc_val_cols", "vlb", "validate", {})
        r = _run(s, g, "vlb")
        assert not r.get("error"), "validate cols: %r" % r.get("error")
        assert r.get("total_rows") == 1
        cols = [c if isinstance(c, str) else c.get("name", "")
                for c in (r.get("columns") or [])]
        for col in ("x", "y", "z"):
            assert col in cols, \
                "validate lost column %r: cols=%r" % (col, cols)
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# while — uses Session.run_while(), not run_nodeflow
# ---------------------------------------------------------------------------

def t_while_bounded():
    """
    The while node runs via Session.run_while(), NOT run_nodeflow.
    Build a simple bounded body: source -> while controller.
    Cap at 1 iteration so the loop is guaranteed to stop.

    The body is just an input node connected to the while controller;
    on iteration 1 the source rows are appended into the accumulator.
    Since the body always returns all source rows (no convergence guard),
    the loop hits the 1-iteration cap and stops normally.
    """
    s = _fresh_session()
    try:
        _make_table(s, "nc_while_src",
                    "SELECT 1 AS n "
                    "UNION ALL SELECT 2 "
                    "UNION ALL SELECT 3")
        # Accumulator table starts empty
        r0 = s.run_query(
            "CREATE TABLE nc_while_acc AS SELECT 0 AS n WHERE 1=0",
            target=_LOCAL)
        assert not r0.get("error"), "create accum: %r" % r0.get("error")

        # Minimal body: input node -> while controller
        body_graph = {
            "nodes": [
                {"id": "src", "type": "input",
                 "config": {"table": "nc_while_src"}},
                {"id": "wh", "type": "while",
                 "config": {
                     "table": "nc_while_acc",
                     "max_iters": 1,        # guaranteed termination
                     "reset_first": True,   # clear accum before running
                     "accumulate": "append",
                 }},
            ],
            "edges": [
                {"id": "e1",
                 "from": {"node": "src", "port": "out"},
                 "to": {"node": "wh", "port": "in"}},
            ],
        }
        result = s.run_while(body_graph, "wh")
        assert not result.get("error"), \
            "run_while error: %r" % result.get("error")
        assert result.get("ok"), \
            "run_while must return ok=True: %r" % result
        assert result.get("iterations", 0) >= 1, \
            "run_while must complete at least 1 iteration: %r" % result
        assert result.get("rows", 0) >= 3, \
            "accumulator must have >= 3 rows after 1 iteration: %r" % result
    finally:
        s.shutdown()


# ---------------------------------------------------------------------------
# Case registry — mirrors test_nodeflow_nullkey.py pattern
# ---------------------------------------------------------------------------

_CASES = [
    # date
    ("node coverage: date part year",      t_date_part_year),
    ("node coverage: date part month",     t_date_part_month),
    ("node coverage: date trunc month",    t_date_trunc),
    # dedupe
    ("node coverage: dedupe basic",        t_dedupe_basic),
    ("node coverage: dedupe multi-key",    t_dedupe_multi_key),
    # explode
    ("node coverage: explode delim",       t_explode_delim),
    ("node coverage: explode json array",  t_explode_json),
    # fill
    ("node coverage: fill value",          t_fill_value),
    ("node coverage: fill avg",            t_fill_avg),
    # jsonextract
    ("node coverage: jsonextract single field",  t_jsonextract_single_field),
    ("node coverage: jsonextract nested path",   t_jsonextract_nested_path),
    # maprecode
    ("node coverage: maprecode basic",           t_maprecode_basic),
    ("node coverage: maprecode default value",   t_maprecode_default_value),
    # parse
    ("node coverage: parse number",              t_parse_number),
    ("node coverage: parse date",                t_parse_date),
    ("node coverage: parse integer",             t_parse_integer),
    # perioddelta
    ("node coverage: perioddelta absolute",      t_perioddelta_absolute),
    ("node coverage: perioddelta percent",       t_perioddelta_percent),
    ("node coverage: perioddelta running_total", t_perioddelta_running_total),
    # textclean
    ("node coverage: textclean trim+upper",      t_textclean_trim_upper),
    ("node coverage: textclean replace",         t_textclean_replace),
    ("node coverage: textclean lower",           t_textclean_lower),
    # validate
    ("node coverage: validate passthrough",      t_validate_passthrough),
    ("node coverage: validate passthrough columns intact",
     t_validate_passthrough_columns_intact),
    # while (via run_while — not run_nodeflow)
    ("node coverage: while bounded accumulate",  t_while_bounded),
]

# The nodeflow-labelled group exposes the same tests under "nodeflow" so the
# SAMQL_ONLY="nodeflow" run covers them.  The while test is excluded from
# this duplicate group (run_while != run_nodeflow).
_NODEFLOW_CASES = [
    ("nodeflow " + label.split(": ", 1)[1], fn)
    for label, fn in _CASES
    if "while" not in label
]


def backend_cases(root, csv, skip):
    """Register cases in the main backend suite."""
    return list(_CASES) + list(_NODEFLOW_CASES)
