#!/usr/bin/env python3
"""Dual-engine (SQLite + DuckDB) tests for SamQL query optimisations:

  * projection pushdown   -- sources/intermediates carry only live columns
  * shared-subgraph       -- a node feeding several Run-all targets is built once
  * incremental execution -- downstream edits reuse safe upstream checkpoints

Run it from anywhere in the repo (it locates ``backend/`` itself):

    python3 tests/test_optimizations_dual_engine.py            # both engines
    python3 tests/test_optimizations_dual_engine.py --sqlite   # SQLite only
    python3 tests/test_optimizations_dual_engine.py --duckdb   # DuckDB only
    python3 tests/test_optimizations_dual_engine.py -v         # show each case

Every case runs identically on each engine, so a green run confirms the two
engines agree. SQLite always runs; DuckDB runs only when ``pip install duckdb``
is present. Exit code is non-zero if any case fails.

The cases are deliberately heavy on "user randomness": columns named with
spaces, SQL keywords, unicode and quotes; columns differing only by case;
columns named like SQL functions; string literals that look like column names;
selects of missing or zero columns; disabled nodes; and a very wide table.
"""

import os
import sys
import argparse
import traceback


# ---- locate and import the backend ----------------------------------------
def _bootstrap():
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", "backend"),
                 os.path.join(here, "backend"),
                 os.path.join(os.getcwd(), "backend")):
        cand = os.path.abspath(cand)
        if os.path.isdir(os.path.join(cand, "samql_core")):
            sys.path.insert(0, cand)
            return
    sys.stderr.write("Could not find backend/samql_core next to this script.\n")
    sys.exit(2)


_bootstrap()
from samql_core import Session  # noqa: E402
from samql_core import nodeflow as nf  # noqa: E402


# ---- tiny test framework ---------------------------------------------------
class Fail(AssertionError):
    pass


def need(cond, msg):
    if not cond:
        raise Fail(msg)


def eq(got, want, msg=""):
    if got != want:
        raise Fail("%s\n      expected: %r\n      got:      %r"
                   % (msg or "values differ", want, got))


def eqset(got, want, msg=""):
    g = None if got is None else set(got)
    w = None if want is None else set(want)
    if g != w:
        raise Fail("%s\n      expected: %r\n      got:      %r" % (msg, w, g))


# ---- engine helpers --------------------------------------------------------
def _coltype(vals):
    seen = [v for v in vals if v is not None]
    if seen and all(isinstance(v, bool) for v in seen):
        return "BOOLEAN"
    if seen and all(isinstance(v, int) and not isinstance(v, bool)
                    for v in seen):
        return "INTEGER"
    if seen and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                    for v in seen):
        return "DOUBLE"
    return "VARCHAR"


def _lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _q(c):
    return '"' + str(c).replace('"', '""') + '"'


class Rig:
    """One engine under test: a Session plus helpers to plant tables in that
    engine and run flows against it. SQLite uses the session's default
    (sqlite) engine; DuckDB uses get_duckdb(). Tables are created directly and
    registered in the engine's table_columns registry so flow routing picks
    the intended engine -- this lets us use arbitrary column names verbatim,
    which a CSV loader might otherwise normalise."""

    def __init__(self, engine):
        self.engine = engine
        self.sess = Session()
        # These tests isolate projection/shared-build behavior from the
        # cross-run flow cache, which is covered by its own regression suite.
        self.sess.flow_cache = False
        self.eng = (self.sess.get_duckdb() if engine == "duckdb"
                    else self.sess.db)

    def close(self):
        try:
            self.sess.shutdown()
        except Exception:
            pass

    def table(self, name, columns, rows):
        coldefs = []
        for i, c in enumerate(columns):
            coldefs.append("%s %s" % (_q(c), _coltype([r[i] for r in rows])))
        self.eng.execute('DROP TABLE IF EXISTS %s' % _q(name))
        self.eng.execute('CREATE TABLE %s (%s)' % (_q(name), ", ".join(coldefs)))
        for r in rows:
            self.eng.execute('INSERT INTO %s VALUES (%s)'
                             % (_q(name), ", ".join(_lit(v) for v in r)))
        # register so _flow_engine_target routes flows to this engine
        self.eng.table_columns[name] = list(columns)
        return name

    def run(self, graph, node, port="out"):
        return self.sess.run_nodeflow(graph, node, port)

    def cols(self, graph, node, port="out"):
        r = self.run(graph, node, port)
        need(not r.get("error"), "flow errored: %s" % r.get("error"))
        return list(r.get("columns") or [])

    def rows(self, graph, node, port="out"):
        r = self.run(graph, node, port)
        need(not r.get("error"), "flow errored: %s" % r.get("error"))
        return r.get("rows") or []

    def source_sql(self, table, needed):
        """The SQL the input node emits for `table` with `needed` columns
        (set or None) -- so we can confirm the source read is narrowed."""
        allcols = list(self.eng.table_columns.get(table) or [])
        return nf.node_output_sql(
            {"type": "input", "config": {"table": table}}, "out",
            lambda p: None, lambda _q2: allcols,
            "duckdb" if self.engine == "duckdb" else "sqlite", needed=needed)

    def materialize(self, graph, targets):
        et = self.sess._flow_engine_target(graph)
        collect = []
        out = self.sess._materialize_flows(graph, targets, et, collect)
        return out, collect, et

    def drop(self, et, names):
        self.sess._drop_flow_temps(et, names)


# ---- graph builders --------------------------------------------------------
def gin(nid, table):
    return {"id": nid, "type": "input", "config": {"table": table}}


def gsel(nid, *names, **cfg):
    cfg["fields"] = [{"name": x, "keep": True} for x in names]
    return {"id": nid, "type": "select", "config": cfg}


def gout(nid):
    return {"id": nid, "type": "output", "config": {}}


def gnode(nid, typ, **cfg):
    return {"id": nid, "type": typ, "config": cfg}


def ed(a, ap, b, bp="in"):
    return {"from": {"node": a, "port": ap}, "to": {"node": b, "port": bp}}


def graph(nodes, edges):
    return {"nodes": nodes, "edges": edges}


WIDE_COLS = ["a", "b", "c", "d", "e"]
WIDE_ROWS = [[1, "x", 100, "d1", "e1"],
             [2, "y", 5, "d2", "e2"],
             [3, "z", 200, "d3", "e3"]]


def _wide(rig, name="wide"):
    return rig.table(name, WIDE_COLS, WIDE_ROWS)


# ============================================================================
# PROJECTION PUSHDOWN
# ============================================================================
def t_pushdown_select_prunes_source(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p", "a", "b"), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "b"},
          "liveness: select prunes source to {a,b}")
    need("_proj" in rig.source_sql("wide", {"a", "b"}),
         "source SQL is projected to the needed columns")
    eq(rig.cols(g, "o"), ["a", "b"], "select[a,b] -> only a,b")
    eq(sorted(r[0] for r in rig.rows(g, "o")), [1, 2, 3], "values intact")


def t_pushdown_filter_column_survives(rig):
    # the filter references c, which is NOT in the output; pushing the
    # projection down must NOT drop c or the filter breaks.
    _wide(rig)
    g = graph([gin("s", "wide"),
               gnode("f", "filter", condition="c > 50"),
               gsel("p", "a", "b"), gout("o")],
              [ed("s", "out", "f"), ed("f", "true", "p"),
               ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "b", "c"},
          "filter-only column c survives pruning")
    eq(rig.cols(g, "o"), ["a", "b"], "output still a,b")
    eq(sorted(r[0] for r in rig.rows(g, "o")), [1, 3], "filter c>50 correct")


def t_pushdown_through_sort(rig):
    _wide(rig)
    g = graph([gin("s", "wide"),
               gnode("so", "sort", sorts=[{"col": "c", "dir": "desc"}]),
               gsel("p", "a", "b"), gout("o")],
              [ed("s", "out", "so"), ed("so", "out", "p"),
               ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "b", "c"}, "sort key c kept")
    eq(rig.cols(g, "o"), ["a", "b"], "cols a,b")
    eq([r[0] for r in rig.rows(g, "o")], [3, 1, 2], "order by c desc preserved")


def t_pushdown_through_dedupe(rig):
    rig.table("dd", ["k", "v", "extra"],
              [[1, "a", "p"], [1, "b", "q"], [2, "c", "r"]])
    g = graph([gin("s", "dd"),
               gnode("d", "dedupe", keys=["k"], sort="v", keep="first"),
               gsel("p", "v"), gout("o")],
              [ed("s", "out", "d"), ed("d", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    need("k" in live.get(("s", "out")) and "v" in live.get(("s", "out")),
         "dedupe keys + sort col kept at source")
    eq(rig.cols(g, "o"), ["v"], "cols v")
    eq(sorted(r[0] for r in rig.rows(g, "o")), ["a", "c"],
       "dedupe keep-first correct after pruning")


def t_pushdown_through_unique(rig):
    rig.table("uq", ["k", "v"], [[1, "a"], [1, "a"], [2, "b"]])
    g = graph([gin("s", "uq"), gnode("u", "unique", by=["k"]),
               gsel("p", "k"), gout("o")],
              [ed("s", "out", "u"), ed("u", "out", "p"), ed("p", "out", "o")])
    eq(rig.cols(g, "o"), ["k"], "cols k")
    eq(sorted(r[0] for r in rig.rows(g, "o")), [1, 2], "unique by k correct")


def t_pushdown_renamecols_inverts_explicit_mapping(rig):
    _wide(rig)
    g = graph([gin("s", "wide"),
               gnode("r", "renamecols", mappings=[{"from": "a", "to": "A1"}]),
               gsel("p", "A1"), gout("o")],
              [ed("s", "out", "r"), ed("r", "out", "p"),
               ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a"},
          "explicit rename maps the downstream name back to its source")
    eq(rig.cols(g, "o"), ["A1"], "only the renamed field is emitted")
    eq([r[0] for r in rig.rows(g, "o")], [1, 2, 3], "rename values intact")


def t_pushdown_renamecols_bulk_is_conservative(rig):
    _wide(rig)
    g = graph([gin("s", "wide"),
               gnode("r", "renamecols", prefix="x_"),
               gsel("p", "x_a"), gout("o")],
              [ed("s", "out", "r"), ed("r", "out", "p"),
               ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eq(live.get(("s", "out")), None,
       "bulk renames stay conservative because suffix collisions are dynamic")
    eq(rig.cols(g, "o"), ["x_a"], "bulk rename still executes")


def t_pushdown_multi_consumer_union(rig):
    # a source feeding two different selects: the source must keep the UNION
    # of what each branch needs, and (being multi-consumer) is materialised
    # once with exactly that union.
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p1", "a"), gsel("p2", "b"),
               gout("o1"), gout("o2")],
              [ed("s", "out", "p1"), ed("s", "out", "p2"),
               ed("p1", "out", "o1"), ed("p2", "out", "o2")])
    live = nf.needed_columns(g, [("o1", "out"), ("o2", "out")])
    eqset(live.get(("s", "out")), {"a", "b"},
          "source keeps union {a,b} across both consumers")
    out, collect, et = rig.materialize(g, [("o1", "out"), ("o2", "out")])
    src_temps = [c for c in collect if c.endswith("_s__out")]
    eq(len(src_temps), 1, "shared source materialised once")
    cols = rig.sess.run_query('SELECT * FROM "%s" LIMIT 0' % src_temps[0],
                              target=et).get("columns")
    eqset(cols, {"a", "b"}, "shared source temp has only the union columns")
    rig.drop(et, collect)


def t_pushdown_join_splits_inputs(rig):
    rig.table("jl", ["id", "left_value", "unused_l"],
              [[1, "a", "x"], [2, "b", "y"]])
    rig.table("jr", ["id", "right_value", "unused_r"],
              [[1, 10, "p"], [2, 20, "q"]])
    g = graph([gin("l", "jl"), gin("r", "jr"),
               gnode("j", "join", how="inner",
                     keys=[{"left": "id", "right": "id"}]),
               gsel("p", "right_value"), gout("o")],
              [ed("l", "out", "j", "left"), ed("r", "out", "j", "right"),
               ed("j", "inner", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("l", "out")), {"id", "right_value"},
          "join propagates selected names conservatively to the left")
    eqset(live.get(("r", "out")), {"id", "right_value"},
          "right keeps its join key plus selected value")
    eq(rig.cols(g, "o"), ["right_value"], "selected right value emitted")
    eq([r[0] for r in rig.rows(g, "o")], [10, 20], "join result intact")


def t_pushdown_formula_dependencies(rig):
    _wide(rig)
    g = graph([gin("s", "wide"),
               gnode("fm", "formula", formulas=[
                   {"name": "z", "expr": "a + c"},
                   {"name": "unused", "expr": "a + 999"},
               ]),
               gsel("p", "z"), gout("o")],
              [ed("s", "out", "fm"), ed("fm", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "c"},
          "formula retains only identifiers used by selected expressions")
    eq(rig.cols(g, "o"), ["z"], "only requested formula emitted")
    eq([r[0] for r in rig.rows(g, "o")], [101, 7, 203], "formula correct")


def t_pushdown_summarize_dependencies(rig):
    rig.table("sm", ["grp", "val", "other"],
              [["a", 1, 100], ["a", 2, 200], ["b", 3, 300]])
    g = graph([gin("s", "sm"),
               gnode("g", "summarize", group_by=["grp"], aggs=[
                   {"col": "val", "func": "sum", "name": "total"},
                   {"col": "other", "func": "sum", "name": "unused_total"},
               ]),
               gsel("p", "total"), gout("o")],
              [ed("s", "out", "g"), ed("g", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"grp", "val"},
          "summarize retains grouping keys and selected aggregate inputs")
    eq(rig.cols(g, "o"), ["total"], "unused aggregate is not emitted")
    eq(sorted(r[0] for r in rig.rows(g, "o")), [3, 3], "aggregate correct")


def t_pushdown_window_dependencies(rig):
    rig.table("win", ["day", "grp", "val", "unused"],
              [[1, "a", 10, "x"], [2, "a", 15, "y"], [1, "b", 7, "z"]])
    g = graph([gin("s", "win"),
               gnode("w", "window", windows=[{
                   "func": "lag", "col": "val", "name": "prev",
                   "partition_by": ["grp"],
                   "order_by": [{"col": "day", "dir": "asc"}],
               }]),
               gsel("p", "prev"), gout("o")],
              [ed("s", "out", "w"), ed("w", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"day", "grp", "val"},
          "window keeps value, partition and order dependencies")
    eq(rig.cols(g, "o"), ["prev"], "only requested window output emitted")


def t_pushdown_group_pipeline(rig):
    rig.table("grp_src", ["a", "c", "unused"],
              [[1, 10, "x"], [2, -1, "y"], [3, 20, "z"]])
    grouped = gnode("g", "group", children=[
        {"id": "gf", "type": "filter",
         "config": {"condition": "c > 0"}},
        {"id": "gm", "type": "formula", "config": {"formulas": [
            {"name": "z", "expr": "a + c"},
            {"name": "unused_calc", "expr": "c * 100"},
        ]}},
    ])
    g = graph([gin("s", "grp_src"), grouped, gsel("p", "z"), gout("o")],
              [ed("s", "out", "g"), ed("g", "out", "p"),
               ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "c"},
          "group liveness walks through filter + formula children")
    eqset(live.get(("g", "out")), {"z"},
          "group checkpoint carries only its consumed output")
    eq(rig.cols(g, "o"), ["z"], "group emits only selected derived field")
    eq([r[0] for r in rig.rows(g, "o")], [11, 23],
       "group filter + formula remains correct after pruning")


def t_pushdown_group_multi_input_bindings(rig):
    rig.table("grp_left", ["oid", "cust", "left_extra"],
              [[1, 10, "x"], [2, 11, "y"], [3, 99, "z"]])
    rig.table("grp_right", ["cust", "region", "right_extra"],
              [[10, "E", "p"], [11, "W", "q"]])
    grouped = gnode("g", "group", children=[
        {"id": "j", "type": "join", "config": {
            "keys": [{"left": "cust", "right": "cust"}]}},
        {"id": "sel", "type": "select", "config": {"fields": [
            {"name": "oid", "keep": True},
            {"name": "region", "keep": True},
        ]}},
    ], bindings={"j": {"left": "in", "right": "in2"}})
    g = graph([gin("l", "grp_left"), gin("r", "grp_right"), grouped,
               gsel("p", "region"), gout("o")],
              [ed("l", "out", "g", "in"), ed("r", "out", "g", "in2"),
               ed("g", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("l", "out")), {"cust", "region"},
          "bound group left keeps the join key (extra candidate is harmless)")
    eqset(live.get(("r", "out")), {"cust", "region"},
          "bound group right keeps key + selected field")
    eq(rig.cols(g, "o"), ["region"],
       "multi-input group emits only the downstream field")
    eq([r[0] for r in rig.rows(g, "o")], ["E", "W"],
       "bound join inside group stays correct under pushdown")


def t_pushdown_union_inputs(rig):
    rig.table("u1", ["id", "value", "left_extra"],
              [[1, "a", "x"], [2, "b", "y"]])
    rig.table("u2", ["id", "value", "right_extra"],
              [[3, "c", "z"]])
    g = graph([gin("l", "u1"), gin("r", "u2"),
               gnode("u", "union", mode="all"),
               gsel("p", "value"), gout("o")],
              [ed("l", "out", "u", "in1"), ed("r", "out", "u", "in2"),
               ed("u", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("l", "out")), {"value"},
          "union left input is narrowed independently")
    eqset(live.get(("r", "out")), {"value"},
          "union right input is narrowed independently")
    eq([r[0] for r in rig.rows(g, "o")], ["a", "b", "c"],
       "union result survives per-input projection")


def t_pushdown_multijoin_alias_stability(rig):
    # Projection must not change the collision-driven public alias. The base
    # already owns both ``value`` and ``in2_value``; input 2's ``value`` is
    # therefore exposed as ``in2_value_2``.
    rig.table("mj1", ["id", "value", "in2_value", "unused_l"],
              [[1, "base", "reserved", "x"]])
    rig.table("mj2", ["id", "value", "unused_r"],
              [[1, "joined", "y"]])
    g = graph([gin("l", "mj1"), gin("r", "mj2"),
               gnode("mj", "multijoin", base="in1", joins=[{
                   "input": "in2", "against": "in1",
                   "on": [{"left": "id", "right": "id"}],
               }]), gsel("p", "in2_value_2"), gout("o")],
              [ed("l", "out", "mj", "in1"),
               ed("r", "out", "mj", "in2"),
               ed("mj", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    need("in2_value" in (live.get(("l", "out")) or set()),
         "base collision column is retained to keep alias names stable")
    need("value" in (live.get(("r", "out")) or set()),
         "prefixed/suffixed alias resolves back to input 2's value")
    eq(rig.cols(g, "o"), ["in2_value_2"],
       "multi-join public alias is stable under projection")
    eq(rig.rows(g, "o"), [["joined"]],
       "multi-join selected value remains correct")


def t_pushdown_reconcile_inputs(rig):
    rig.table("rec_l", ["id", "amount", "left_extra"],
              [[1, 10, "x"], [2, 20, "y"]])
    rig.table("rec_r", ["id", "amount", "right_extra"],
              [[1, 10, "p"], [3, 30, "q"]])
    g = graph([gin("l", "rec_l"), gin("r", "rec_r"),
               gnode("rec", "reconcile", keys=["id"], balance="amount"),
               gsel("p", "reconcile_status"), gout("o")],
              [ed("l", "out", "rec", "left"),
               ed("r", "out", "rec", "right"),
               ed("rec", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("l", "out")), {"id", "amount"},
          "reconcile left keeps only keys + balance")
    eqset(live.get(("r", "out")), {"id", "amount"},
          "reconcile right keeps only keys + balance")
    eq(sorted(r[0] for r in rig.rows(g, "o")),
       ["left_only", "matched", "right_only"],
       "reconcile output remains correct after pruning")


def t_shared_checkpoint_is_narrow(rig):
    rig.table("narrow", ["a", "b", "c", "unused"],
              [[1, 10, 1, "x"], [2, 20, -1, "y"], [3, 30, 1, "z"]])
    g = graph([gin("s", "narrow"),
               gnode("f", "filter", condition="c > 0"),
               gsel("pa", "a"), gsel("pb", "b")],
              [ed("s", "out", "f"), ed("f", "true", "pa"),
               ed("f", "true", "pb")])
    out, collect, et = rig.materialize(g, [("pa", "out"), ("pb", "out")])
    need(len(out) == 2, "both shared-filter targets materialized")
    filt = [name for name in collect if name.endswith("_f__true")]
    eq(len(filt), 1, "shared filter checkpoint is built once")
    cols = rig.sess.run_query('SELECT * FROM "%s" LIMIT 0' % filt[0],
                              target=et).get("columns")
    eqset(cols, {"a", "b"},
          "condition-only c is dropped before the reusable checkpoint")
    rig.drop(et, collect)


def t_incremental_checkpoint_plan(rig):
    nodes = [gin("s", "unused")]
    edges = []
    prev = "s"
    for i in range(1, 8):
        nid = "n%d" % i
        typ = "sort" if i == 2 else "formula"
        cfg = ({"sorts": [{"col": "a"}]} if typ == "sort" else
               {"formulas": [{"name": "x%d" % i, "expr": "a + %d" % i}]})
        nodes.append({"id": nid, "type": typ, "config": cfg})
        edges.append(ed(prev, "out", nid))
        prev = nid
    nodes.append(gout("o")); edges.append(ed(prev, "out", "o"))
    plan = nf.incremental_checkpoint_nodes(graph(nodes, edges), [("o", "out")])
    need("n2" in plan, "expensive sort becomes an incremental boundary")
    need("n7" in plan, "direct predecessor of target becomes a boundary")
    need(any(n in plan for n in ("n3", "n4", "n5")),
         "a long linear branch gets a sparse stride boundary")
    need("s" not in plan and "o" not in plan,
         "source and terminal target are never redundant checkpoints")
    volatile = graph([gin("vs", "unused"),
                      gnode("random", "sample", mode="random", n=5),
                      gnode("rawsql", "sql", sql="SELECT * FROM {{in}}"),
                      gout("vo")],
                     [ed("vs", "out", "random"),
                      ed("random", "out", "rawsql"),
                      ed("rawsql", "out", "vo")])
    volatile_plan = nf.incremental_checkpoint_nodes(
        volatile, [("vo", "out")], stride=2)
    need("random" not in volatile_plan and "rawsql" not in volatile_plan,
         "random samples and free-form SQL are never automatic checkpoints")


def t_incremental_downstream_edit_reuses_upstream(rig):
    rig.table("inc", ["a", "c"], [[1, 10], [2, 20], [3, 30]])
    rig.sess.flow_cache = True
    base_nodes = [gin("s", "inc"),
                  gnode("fm", "formula", formulas=[
                      {"name": "z", "expr": "a + c"}]),
                  gnode("f", "filter", condition="z > 15"),
                  gsel("p", "z"), gout("o")]
    edges = [ed("s", "out", "fm"), ed("fm", "out", "f"),
             ed("f", "true", "p"), ed("p", "out", "o")]
    g1 = graph(base_nodes, edges)
    eq([r[0] for r in rig.rows(g1, "o")], [22, 33],
       "cold incremental run is correct")
    hits1 = int(rig.sess.flow_cache_info().get("hits") or 0)
    # Only a downstream filter changes. The formula checkpoint fingerprint is
    # unchanged and should be reused instead of rescanning/recomputing it.
    g2 = graph([dict(n, config=dict(n.get("config") or {})) for n in base_nodes],
               edges)
    next(n for n in g2["nodes"] if n["id"] == "f")["config"]["condition"] = "z > 25"
    eq([r[0] for r in rig.rows(g2, "o")], [33],
       "downstream edit returns the new answer")
    hits2 = int(rig.sess.flow_cache_info().get("hits") or 0)
    need(hits2 > hits1,
         "downstream edit reuses an unchanged upstream checkpoint")
    # An upstream formula edit must invalidate that checkpoint and every
    # descendant; correctness is the non-negotiable guard against stale reuse.
    g3 = graph([dict(n, config=dict(n.get("config") or {})) for n in g2["nodes"]],
               edges)
    next(n for n in g3["nodes"] if n["id"] == "fm")["config"]["formulas"] = [
        {"name": "z", "expr": "a + c + 100"}]
    eq([r[0] for r in rig.rows(g3, "o")], [111, 122, 133],
       "upstream edit invalidates descendants; no stale cache result leaks")


def t_perioddelta_and_pushdown(rig):
    rig.table("pd", ["day", "grp", "val", "unused"],
              [[1, "a", 10, "x"], [2, "a", 15, "y"], [3, "a", 12, "z"]])
    g = graph([gin("s", "pd"),
               gnode("d", "perioddelta", value="val", order="day",
                     partition=["grp"], mode="absolute", out="change"),
               gsel("p", "change"), gout("o")],
              [ed("s", "out", "d"), ed("d", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"day", "grp", "val"},
          "period delta keeps only value/order/partition dependencies")
    eq(rig.cols(g, "o"), ["change"], "period delta output emitted")
    vals = [r[0] for r in rig.rows(g, "o")]
    eq(vals[1:], [5, -3], "absolute period changes are correct")


# ---- edge cases ------------------------------------------------------------
def t_edge_no_select_keeps_all(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gout("o")], [ed("s", "out", "o")])
    eq(rig.cols(g, "o"), WIDE_COLS, "no projection anywhere -> all columns")


def t_edge_select_all_no_prune(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p", *WIDE_COLS), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), set(WIDE_COLS), "all columns needed")
    need("_proj" not in rig.source_sql("wide", set(WIDE_COLS)),
         "no projection wrapper when every column is kept")
    eq(rig.cols(g, "o"), WIDE_COLS, "all columns out")


def t_edge_chained_selects(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p1", "a", "b", "c"),
               gsel("p2", "a", "b"), gout("o")],
              [ed("s", "out", "p1"), ed("p1", "out", "p2"),
               ed("p2", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "b"},
          "chained selects compose down to {a,b}")
    eq(rig.cols(g, "o"), ["a", "b"], "final cols a,b")


def t_edge_select_then_formula_readds(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p", "a", "b"),
               gnode("fm", "formula", formulas=[{"name": "x", "expr": "a * 2"}]),
               gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "fm"), ed("fm", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"a", "b"},
          "select still prunes source even though a formula follows")
    cols = rig.cols(g, "o")
    need("x" in cols and "a" in cols and "b" in cols,
         "formula re-adds a derived column on top of the projection")


# ---- out-of-ordinary / user randomness ------------------------------------
ODD_COLS = ["first name", "select", "café", "Name", "amount"]
ODD_ROWS = [["al", 1, "x", "AL", 100], ["bo", 2, "y", "BO", 5]]


def t_odd_weird_names(rig):
    rig.table("odd", ODD_COLS, ODD_ROWS)
    g = graph([gin("s", "odd"), gsel("p", "first name", "select", "café"),
               gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"first name", "select", "café"},
          "spaced / keyword / unicode names tracked by liveness")
    eq(rig.cols(g, "o"), ["first name", "select", "café"],
       "odd names kept verbatim through pruning")


def t_odd_spaced_name_in_filter(rig):
    rig.table("odd", ODD_COLS, ODD_ROWS)
    g = graph([gin("s", "odd"),
               gnode("f", "filter", condition='[first name] = \'al\''),
               gsel("p", "amount"), gout("o")],
              [ed("s", "out", "f"), ed("f", "true", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    need("first name" in live.get(("s", "out")),
         "bracketed spaced name in a filter survives pruning")
    eq([r[0] for r in rig.rows(g, "o")], [100], "spaced-name filter correct")


def t_odd_string_literal_not_a_column(rig):
    # 'first name' here is a STRING LITERAL, not the column. The real column
    # refs ("select", "Name") are kept; the literal text is not required.
    rig.table("odd", ODD_COLS, ODD_ROWS)
    cond = '"select" = 1 OR "Name" = \'first name\''
    g = graph([gin("s", "odd"), gnode("f", "filter", condition=cond),
               gsel("p", "amount"), gout("o")],
              [ed("s", "out", "f"), ed("f", "true", "p"), ed("p", "out", "o")])
    r = rig.run(g, "o")
    need(not r.get("error"),
         "string literal that looks like a name doesn't break pruning: %s"
         % r.get("error"))
    live = nf.needed_columns(g, [("o", "out")])
    need("select" in live.get(("s", "out")),
         "real column ref kept; literal text not mistaken for a column")


def t_odd_case_insensitive(rig):
    # the select references columns in a different case than declared; engines
    # match case-insensitively and pruning must too (never drop a real ref).
    rig.table("ci", ["ID", "Name", "Amount"],
              [[1, "al", 10], [2, "bo", 20]])
    g = graph([gin("s", "ci"), gsel("p", "id", "name"), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    r = rig.run(g, "o")
    need(not r.get("error"), "case-mismatched select runs: %s" % r.get("error"))
    eq(len(r.get("columns") or []), 2, "two columns out despite case mismatch")


def t_odd_function_like_names(rig):
    # columns named like SQL functions must be treated as columns, not calls.
    rig.table("fn", ["lower", "abs", "keep"],
              [["A", -1, "p"], ["B", 2, "q"]])
    g = graph([gin("s", "fn"), gnode("f", "filter", condition='"abs" > 0'),
               gsel("p", "lower"), gout("o")],
              [ed("s", "out", "f"), ed("f", "true", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    need("abs" in live.get(("s", "out")) and "lower" in live.get(("s", "out")),
         "function-like column names tracked as columns")
    r = rig.run(g, "o")
    need(not r.get("error"), "function-like names run: %s" % r.get("error"))
    eq([row[0] for row in rig.rows(g, "o")], ["B"], "filter on \"abs\" correct")


def t_odd_single_column(rig):
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p", "c"), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    eq(rig.cols(g, "o"), ["c"], "single-column select")
    eq(sorted(r[0] for r in rig.rows(g, "o")), [5, 100, 200], "values intact")


def t_odd_select_missing_column(rig):
    # Selecting a column that doesn't exist must behave IDENTICALLY whether or
    # not pushdown is on -- pushdown must never change semantics. Whether the
    # missing column is an error (DuckDB, strict) or SQLite's quoted-identifier
    # -as-string-literal quirk is the engine's call, not the optimiser's.
    _wide(rig)
    g = graph([gin("s", "wide"), gsel("p", "nope"), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    rig.sess.project_pushdown = True
    on = rig.run(g, "o")
    rig.sess.project_pushdown = False
    off = rig.run(g, "o")
    rig.sess.project_pushdown = True
    eq(bool(on.get("error")), bool(off.get("error")),
       "pushdown doesn't change whether a missing column errors")
    eq(on.get("columns"), off.get("columns"),
       "pushdown doesn't change columns for a missing-column select")
    eq(on.get("rows"), off.get("rows"),
       "pushdown doesn't change rows for a missing-column select")


def t_odd_empty_select(rig):
    _wide(rig)
    g = graph([gin("s", "wide"),
               {"id": "p", "type": "select", "config": {"fields": []}},
               gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    r = rig.run(g, "o")
    need(r.get("error"), "a select with nothing kept reports an error")


def t_odd_disabled_node(rig):
    # a DISABLED select is a passthrough -> must NOT prune.
    _wide(rig)
    g = graph([gin("s", "wide"),
               {"id": "p", "type": "select",
                "config": {"disabled": True,
                           "fields": [{"name": "a", "keep": True}]}},
               gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eq(live.get(("s", "out")), None, "disabled select passes through (no prune)")
    eq(rig.cols(g, "o"), WIDE_COLS, "disabled select keeps all columns")


def t_odd_very_wide(rig):
    cols = ["c%d" % i for i in range(60)]
    rig.table("vw", cols, [list(range(60)), [i * 2 for i in range(60)]])
    g = graph([gin("s", "vw"), gsel("p", "c0", "c1"), gout("o")],
              [ed("s", "out", "p"), ed("p", "out", "o")])
    live = nf.needed_columns(g, [("o", "out")])
    eqset(live.get(("s", "out")), {"c0", "c1"},
          "60-column source pruned to the 2 used columns")
    need("_proj" in rig.source_sql("vw", {"c0", "c1"}),
         "wide source SQL is projected")
    eq(rig.cols(g, "o"), ["c0", "c1"], "two columns out of sixty")


# ============================================================================
# SHARED-SUBGRAPH MATERIALISATION
# ============================================================================
def _base(rig, name="base"):
    return rig.table(name, ["k", "v"], [[1, 10], [2, 20], [3, 30]])


def t_shared_built_once(rig):
    _base(rig)
    g = graph([gin("s", "base"),
               gnode("X", "sort", sorts=[{"col": "k", "dir": "asc"}]),
               gsel("p1", "k"), gsel("p2", "v")],
              [ed("s", "out", "X"), ed("X", "out", "p1"), ed("X", "out", "p2")])
    out, collect, et = rig.materialize(g, [("p1", "out"), ("p2", "out")])
    need(("p1", "out") in out and ("p2", "out") in out, "both targets built")
    eq(len([c for c in collect if c.endswith("_X__out")]), 1,
       "node shared by two targets is materialised exactly once")
    _c1, rows1 = rig.eng.execute(
        'SELECT * FROM "%s" ORDER BY 1' % out[("p1", "out")])
    _c2, rows2 = rig.eng.execute(
        'SELECT * FROM "%s" ORDER BY 1' % out[("p2", "out")])
    eq([row[0] for row in rows1], [1, 2, 3], "p1 -> k values")
    eq([row[0] for row in rows2], [10, 20, 30], "p2 -> v values")
    rig.drop(et, collect)


def t_shared_vs_separate(rig):
    _base(rig)
    g = graph([gin("s", "base"),
               gnode("X", "sort", sorts=[{"col": "k"}]),
               gsel("p1", "k"), gsel("p2", "v")],
              [ed("s", "out", "X"), ed("X", "out", "p1"), ed("X", "out", "p2")])
    c1, c2 = [], []
    et = rig.sess._flow_engine_target(g)
    rig.sess._materialize_flow(g, "p1", "out", et, c1)
    rig.sess._materialize_flow(g, "p2", "out", et, c2)
    eq(len([c for c in (c1 + c2) if c.endswith("_X__out")]), 2,
       "two separate passes build the shared node twice (the gap closed)")
    rig.drop(et, c1)
    rig.drop(et, c2)


def t_shared_three_target_diamond(rig):
    _base(rig)
    g = graph([gin("s", "base"),
               gnode("X", "sort", sorts=[{"col": "k"}]),
               gsel("p1", "k"), gsel("p2", "v"),
               gnode("p3", "filter", condition="k > 1")],
              [ed("s", "out", "X"), ed("X", "out", "p1"),
               ed("X", "out", "p2"), ed("X", "out", "p3")])
    out, collect, et = rig.materialize(
        g, [("p1", "out"), ("p2", "out"), ("p3", "true")])
    eq(len([c for c in collect if c.endswith("_X__out")]), 1,
       "node feeding three targets is materialised once")
    eq(len(out), 3, "all three targets built")
    rig.drop(et, collect)


def t_shared_independent_no_false_sharing(rig):
    _base(rig)
    rig.table("base2", ["k", "v"], [[9, 90]])
    g = graph([gin("s1", "base"), gsel("p", "k"),
               gin("s2", "base2"), gsel("q", "v")],
              [ed("s1", "out", "p"), ed("s2", "out", "q")])
    out, collect, et = rig.materialize(g, [("p", "out"), ("q", "out")])
    need(out[("p", "out")] != out[("q", "out")],
         "independent targets get distinct temps (no false sharing)")
    rig.drop(et, collect)


def t_shared_cycle_detected(rig):
    _base(rig)
    g = graph([gnode("a", "sort", sorts=[{"col": "k"}]),
               gnode("b", "sort", sorts=[{"col": "k"}])],
              [ed("a", "out", "b"), ed("b", "out", "a")])
    et = rig.sess._flow_engine_target(g)
    try:
        rig.sess._materialize_flows(g, [("a", "out")], et, [])
        raise Fail("a cyclic flow should raise")
    except Fail:
        raise
    except Exception as e:
        need("loop" in str(e).lower() or "cycle" in str(e).lower(),
             "cycle is detected and reported clearly: %s" % e)


# ---- registry --------------------------------------------------------------
PUSHDOWN_TESTS = [
    ("select prunes source", t_pushdown_select_prunes_source),
    ("filter-only column survives", t_pushdown_filter_column_survives),
    ("prune through sort", t_pushdown_through_sort),
    ("prune through dedupe", t_pushdown_through_dedupe),
    ("prune through unique", t_pushdown_through_unique),
    ("explicit rename inverts", t_pushdown_renamecols_inverts_explicit_mapping),
    ("bulk rename remains conservative", t_pushdown_renamecols_bulk_is_conservative),
    ("multi-consumer union", t_pushdown_multi_consumer_union),
    ("join splits input requirements", t_pushdown_join_splits_inputs),
    ("formula dependency pruning", t_pushdown_formula_dependencies),
    ("summarize dependency pruning", t_pushdown_summarize_dependencies),
    ("window dependency pruning", t_pushdown_window_dependencies),
    ("group pipeline dependency pruning", t_pushdown_group_pipeline),
    ("group multi-input binding pruning", t_pushdown_group_multi_input_bindings),
    ("union per-input pruning", t_pushdown_union_inputs),
    ("multi-join alias-stable pruning", t_pushdown_multijoin_alias_stability),
    ("reconcile dependency pruning", t_pushdown_reconcile_inputs),
    ("period delta + dependency pruning", t_perioddelta_and_pushdown),
    ("shared intermediate checkpoint is narrow", t_shared_checkpoint_is_narrow),
    ("edge: no select keeps all", t_edge_no_select_keeps_all),
    ("edge: select-all no prune", t_edge_select_all_no_prune),
    ("edge: chained selects", t_edge_chained_selects),
    ("edge: select then formula re-adds", t_edge_select_then_formula_readds),
    ("odd: weird names", t_odd_weird_names),
    ("odd: spaced name in filter", t_odd_spaced_name_in_filter),
    ("odd: string literal not a column", t_odd_string_literal_not_a_column),
    ("odd: case-insensitive match", t_odd_case_insensitive),
    ("odd: function-like names", t_odd_function_like_names),
    ("odd: single column", t_odd_single_column),
    ("odd: missing column is pushdown-transparent", t_odd_select_missing_column),
    ("odd: empty select errors", t_odd_empty_select),
    ("odd: disabled node passthrough", t_odd_disabled_node),
    ("odd: very wide table", t_odd_very_wide),
]

SHARED_TESTS = [
    ("shared node built once", t_shared_built_once),
    ("separate passes build twice", t_shared_vs_separate),
    ("three-target diamond", t_shared_three_target_diamond),
    ("independent targets, no false sharing",
     t_shared_independent_no_false_sharing),
    ("cycle detected", t_shared_cycle_detected),
]


INCREMENTAL_TESTS = [
    ("adaptive checkpoint plan", t_incremental_checkpoint_plan),
    ("downstream edit reuses upstream",
     t_incremental_downstream_edit_reuses_upstream),
]


def run_engine(engine, verbose):
    rig = Rig(engine)
    passed = failed = 0
    fails = []
    try:
        for group, tests in (("pushdown", PUSHDOWN_TESTS),
                             ("shared", SHARED_TESTS),
                             ("incremental", INCREMENTAL_TESTS)):
            for name, fn in tests:
                label = "[%s] %s :: %s" % (engine, group, name)
                try:
                    fn(rig)
                    passed += 1
                    if verbose:
                        print("  PASS  " + label)
                except Exception as e:
                    failed += 1
                    fails.append((label, e))
                    print("  FAIL  " + label)
                    if isinstance(e, Fail):
                        print("        " + str(e).replace("\n", "\n        "))
                    else:
                        print("        " + "".join(
                            traceback.format_exception_only(type(e), e)).strip())
    finally:
        rig.close()
    return passed, failed, fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", action="store_true", help="SQLite only")
    ap.add_argument("--duckdb", action="store_true", help="DuckDB only")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="print every case")
    args = ap.parse_args()

    feats = Session().optional_features()
    engines = []
    if args.sqlite and not args.duckdb:
        engines = ["sqlite"]
    elif args.duckdb and not args.sqlite:
        engines = ["duckdb"]
    else:
        engines = ["sqlite", "duckdb"]

    total_p = total_f = 0
    for eng in engines:
        if eng == "duckdb" and not feats.get("duckdb"):
            print("\n== DuckDB == SKIPPED (pip install duckdb to run)")
            continue
        print("\n== %s ==" % eng.upper())
        p, f, _ = run_engine(eng, args.verbose)
        total_p += p
        total_f += f
        print("  %d passed, %d failed" % (p, f))

    print("\n" + "=" * 56)
    print("  TOTAL: %d passed, %d failed" % (total_p, total_f))
    print("=" * 56)
    sys.exit(1 if total_f else 0)


if __name__ == "__main__":
    main()
