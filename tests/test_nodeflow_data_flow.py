#!/usr/bin/env python3
"""Executed tests for NodeFlow data flow and cross-surface data freshness.

Three questions, answered against both engines (SQLite and DuckDB):

1. Isolation -- nodes that are not connected to a run target never affect
   that target: not its rows, not its fingerprint, not its cache entries,
   and a broken disconnected node never blocks a valid chain.
2. Completeness and accuracy -- data flowing through connected nodes is
   complete (every row, every port, every hop) and every calculation
   (filters, formulas, aggregates, joins, unions, windows, ranks, top-N,
   dedupe, SQL nodes) matches an independent Python ground truth computed
   from the same source rows.
3. Latest data wins -- NodeFlow, the IDE query surface and the Journal
   (chained-cell reuse) all serve the newest loaded data after SQL writes,
   write-node overwrites, file reloads, drops and mid-run mutations; stale
   cached snapshots are refused instead of served.

Run directly:  python tests/test_nodeflow_data_flow.py [-v]
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

# Isolate from the developer's persisted SamQL config (Fresh run / cache
# toggles) and give the persistent flow cache its own scratch directory.
_SANDBOX = tempfile.mkdtemp(prefix="samql_dataflow_")
os.environ["HOME"] = os.path.join(_SANDBOX, "home")
os.makedirs(os.environ["HOME"], exist_ok=True)
os.environ["SAMQL_PERSISTENT_FLOW_CACHE_DIR"] = os.path.join(_SANDBOX, "pcache")
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

from samql_core import Session, nodeflow  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.session import DUCKDB_TARGET, LOCAL_TARGET  # noqa: E402

VERBOSE = "-v" in sys.argv or bool(os.environ.get("SAMQL_TB"))


class Failure(AssertionError):
    pass


def need(cond, message):
    if not cond:
        raise Failure(message)


# ---------------------------------------------------------------------------
# Source data (the single source of truth every ground truth derives from)
# ---------------------------------------------------------------------------
ORDER_COLS = ("id", "region", "product", "qty", "price", "day")
ORDERS = [
    (1, "East", "apple", 3, 2.50, "2024-01-01"),
    (2, "West", "pear", 1, 4.00, "2024-01-01"),
    (3, "East", "apple", 5, 2.50, "2024-01-02"),
    (4, "North", "plum", 2, 1.25, "2024-01-02"),
    (5, "East", "pear", None, 4.00, "2024-01-03"),   # NULL qty on purpose
    (6, "West", "apple", 4, 2.75, "2024-01-03"),
    (7, "South", "plum", 7, 1.10, "2024-01-04"),
    (8, "East", "plum", 2, 1.25, "2024-01-04"),
    (9, "West", "pear", 3, 4.00, "2024-01-05"),
    (10, "North", "apple", 6, 2.50, "2024-01-05"),
    (11, "East", "apple", 1, 2.60, "2024-01-06"),
    (12, "West", "plum", 2, 1.30, "2024-01-06"),
]
REGION_COLS = ("region", "manager")
REGIONS = [
    ("East", "Ann"),
    ("West", "Bob"),
    ("South", "Cy"),
    ("Central", "Dee"),   # no orders -> right_only
]
# North has orders but no manager -> left_only.


def _csv(cols, rows):
    out = [",".join(cols)]
    for r in rows:
        out.append(",".join("" if v is None else str(v) for v in r))
    return "\n".join(out) + "\n"


def orders_dicts(rows=None):
    return [dict(zip(ORDER_COLS, r)) for r in (rows if rows is not None else ORDERS)]


# ---------------------------------------------------------------------------
# Normalisation: compare engine output against Python ground truth
# ---------------------------------------------------------------------------
def norm(v):
    """Engine-neutral scalar: numbers (and numeric strings, which the SQLite
    CSV loader may keep as text) become rounded floats; NULL/blank -> None."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    s = str(v)
    if s == "":
        return None
    try:
        return round(float(s), 6)
    except ValueError:
        return s


def norm_row(row):
    return tuple(norm(v) for v in row)


def ok(res, what):
    need(isinstance(res, dict), "%s: not a result dict: %r" % (what, res))
    need(not res.get("error"), "%s: %s" % (what, res.get("error")))
    return res


def cols_of(res):
    return [str(c) for c in (res.get("columns") or [])]


def rows_of(res, columns=None):
    """Rows of a result envelope, normalised. ``columns`` reorders / selects
    the columns to compare (names are matched case-insensitively)."""
    cols = cols_of(res)
    rows = res.get("rows") or []
    if columns is None:
        return [norm_row(r) for r in rows]
    lower = {c.lower(): i for i, c in enumerate(cols)}
    idx = []
    for c in columns:
        need(c.lower() in lower, "column %r missing from %r" % (c, cols))
        idx.append(lower[c.lower()])
    return [norm_row([r[i] for i in idx]) for r in rows]


def expect_rows(res, expected, what, columns=None, ordered=False):
    """Exact multiset (or sequence) equality between an engine result and a
    Python-computed expectation. Row counts are cross-checked against the
    envelope's total_rows so a truncated result can never pass."""
    ok(res, what)
    got = rows_of(res, columns)
    want = [norm_row(r) for r in expected]
    need(int(res.get("total_rows") or 0) == len(got),
         "%s: total_rows %r disagrees with %d returned rows"
         % (what, res.get("total_rows"), len(got)))
    if ordered:
        need(got == want, "%s: ordered rows differ\n  got:  %r\n  want: %r"
             % (what, got, want))
    else:
        need(sorted(got, key=repr) == sorted(want, key=repr),
             "%s: row sets differ\n  got:  %r\n  want: %r"
             % (what, sorted(got, key=repr), sorted(want, key=repr)))
    return got


def batch_results(res, what):
    ok(res, what)
    need(res.get("ok"), "%s: batch not ok: %r" % (what, res))
    return {(r.get("node"), r.get("port")): r for r in (res.get("results") or [])}


# ---------------------------------------------------------------------------
# Session / graph helpers
# ---------------------------------------------------------------------------
def target_of(engine):
    return DUCKDB_TARGET if engine == "duckdb" else LOCAL_TARGET


class Env:
    """A fresh Session with the orders/regions CSVs loaded on ``engine``."""

    def __init__(self, engine, persistent=False, load=True, orders=None,
                 regions=None):
        self.engine = engine
        self.target = target_of(engine)
        self.dir = tempfile.mkdtemp(prefix="samql_df_%s_" % engine)
        self.orders_path = os.path.join(self.dir, "orders.csv")
        self.regions_path = os.path.join(self.dir, "regions.csv")
        self.write_orders(orders)
        with open(self.regions_path, "w", newline="", encoding="utf-8") as fh:
            fh.write(_csv(REGION_COLS, regions if regions is not None else REGIONS))
        self.s = Session()
        s = self.s
        s.fresh_run = False
        s.fresh_load = False
        s.adaptive_resources = False
        s.flow_cache = True
        s.flow_cache_max = 64
        s.persistent_flow_cache = bool(persistent)
        if persistent:
            s.persistent_flow_cache_mb_configured = 128
        s._flow_cache_clear()
        self.orders = self.regions = None
        if load:
            self.orders = self.load(self.orders_path, "orders")
            self.regions = self.load(self.regions_path, "regions")

    def write_orders(self, rows=None):
        with open(self.orders_path, "w", newline="", encoding="utf-8") as fh:
            fh.write(_csv(ORDER_COLS, rows if rows is not None else ORDERS))

    def load(self, path, base):
        loaded = self.s.load_file(path, destination=self.engine,
                                  base_name=base, flatten=False)
        need(isinstance(loaded, list) and loaded and loaded[0].get("name"),
             "load_file(%s) failed: %r" % (base, loaded))
        return loaded[0]["name"]

    _seq = 0

    def _qid(self, prefix):
        Env._seq += 1
        return "%s-%d" % (prefix, Env._seq)

    def query(self, sql, surface="ide", qid=None, reuse=None):
        return self.s.run_query(sql, target=self.target, surface=surface,
                                query_id=qid or self._qid("q"), reuse=reuse)

    def write(self, sql, qid="w"):
        return ok(self.query(sql, surface="ide", qid=qid), "write %s" % sql)

    def run(self, graph, node, port="out", qid=None, **kw):
        return self.s.run_nodeflow(graph, node, port,
                                   query_id=qid or self._qid("nf-%s-%s" % (node, port)),
                                   **kw)

    def run_many(self, graph, targets, qid="batch", **kw):
        return self.s.run_nodeflows(
            graph, [{"node": n, "port": p} for n, p in targets],
            query_id=qid, **kw)

    def hits(self):
        return int(self.s.flow_cache_info().get("hits") or 0)

    def expired(self, rid):
        return self.s.page(rid, 0, 5).get("error") == "result expired"

    def close(self):
        try:
            self.s.shutdown()
        except Exception:
            pass
        shutil.rmtree(self.dir, ignore_errors=True)


def node(nid, typ, **config):
    return {"id": nid, "type": typ, "config": config}


def edge(src, sport, dst, dport):
    return {"from": {"node": src, "port": sport},
            "to": {"node": dst, "port": dport}}


def chain(*nodes_with_ports):
    """Edges for a linear chain given [(node, out_port, in_port_of_next)]."""
    edges = []
    for (a, aport, _), (b, _, bport) in zip(nodes_with_ports, nodes_with_ports[1:]):
        edges.append(edge(a, aport, b, bport))
    return edges


def summarize_cfg(group_by, aggs):
    return {"group_by": list(group_by),
            "aggs": [{"col": c, "func": f, "name": n} for c, f, n in aggs]}


# ---------------------------------------------------------------------------
# Python ground truth
# ---------------------------------------------------------------------------
def py_group(rows, key):
    out = {}
    for r in rows:
        out.setdefault(tuple(r[k] for k in key), []).append(r)
    return out


def py_agg(values, func):
    vals = [v for v in values if v is not None]
    if func == "sum":
        return sum(vals) if vals else None
    if func == "avg":
        return (sum(vals) / len(vals)) if vals else None
    if func == "min":
        return min(vals) if vals else None
    if func == "max":
        return max(vals) if vals else None
    if func == "count":
        return len(vals)
    if func == "countd":
        return len(set(vals))
    raise ValueError(func)


def py_summarize(rows, group_by, aggs):
    out = []
    for key, grp in py_group(rows, group_by).items():
        rec = list(key)
        for col, func, _name in aggs:
            rec.append(py_agg([r[col] for r in grp], func))
        out.append(tuple(rec))
    return out


# ---------------------------------------------------------------------------
# 1. Isolation: non-connected nodes never affect each other
# ---------------------------------------------------------------------------
def two_chain_graph(env, with_noise=True):
    """Chain A (orders) and chain B (regions) share nothing. Noise nodes:
    an input over a nonexistent table, a filter with nothing wired in, a
    text note, and an orphan formula node."""
    nodes = [
        node("inA", "input", table=env.orders),
        node("fA", "filter", condition="region = 'East'"),
        node("sA", "summarize", **summarize_cfg(
            ["region"], [("qty", "sum", "total_qty"), ("id", "count", "n")])),
        node("inB", "input", table=env.regions),
        node("fmB", "formula", formulas=[{"name": "mgr_up", "expr": "upper(manager)"}]),
        node("soB", "sort", sorts=[{"col": "manager", "dir": "desc"}]),
    ]
    edges = [edge("inA", "out", "fA", "in"), edge("fA", "true", "sA", "in"),
             edge("inB", "out", "fmB", "in"), edge("fmB", "out", "soB", "in")]
    if with_noise:
        nodes += [
            node("ghost", "input", table="no_such_table_zz"),
            node("dangle", "filter", condition="qty > 1"),
            node("note", "text", text="hello"),
            node("orphan", "formula", formulas=[{"name": "x", "expr": "1"}]),
        ]
    return {"nodes": nodes, "edges": edges}


def expected_chain_a():
    east = [r for r in orders_dicts() if r["region"] == "East"]
    return py_summarize(east, ["region"], [("qty", "sum", "t"), ("id", "count", "n")])


def expected_chain_b():
    return [(r, m, m.upper()) for r, m in sorted(REGIONS, key=lambda x: x[1],
                                                  reverse=True)]


def test_disconnected_chains_independent(engine):
    env = Env(engine)
    try:
        g = two_chain_graph(env)
        a = env.run(g, "sA")
        expect_rows(a, expected_chain_a(), "chain A", ["region", "total_qty", "n"])
        b = env.run(g, "soB")
        expect_rows(b, expected_chain_b(), "chain B",
                    ["region", "manager", "mgr_up"], ordered=True)

        # One batch containing both valid chains and both broken noise nodes:
        # the valid results are complete and the failures are per-target.
        res = batch_results(env.run_many(
            g, [("sA", "out"), ("soB", "out"), ("ghost", "out"), ("dangle", "true")]),
            "mixed batch")
        expect_rows(res[("sA", "out")], expected_chain_a(), "batch chain A",
                    ["region", "total_qty", "n"])
        expect_rows(res[("soB", "out")], expected_chain_b(), "batch chain B",
                    ["region", "manager", "mgr_up"], ordered=True)
        need(res[("ghost", "out")].get("error"),
             "a missing-table input must fail on its own target")
        need(res[("dangle", "true")].get("error"),
             "an unwired filter must fail on its own target")
        need("filter" in str(res[("dangle", "true")].get("error")).lower(),
             "unwired filter error names the node type: %r"
             % res[("dangle", "true")].get("error"))

        # Fingerprints: editing / removing anything outside chain A leaves
        # every chain-A fingerprint byte-identical.
        fp0 = nodeflow.flow_fingerprints(g, {}, 7, engine)
        a_keys = ("inA", "fA", "sA")
        base = {k: fp0[k] for k in a_keys}
        g2 = two_chain_graph(env)
        g2["nodes"][4]["config"]["formulas"][0]["expr"] = "lower(manager)"
        g2["nodes"][5]["config"]["sorts"][0]["dir"] = "asc"
        fp2 = nodeflow.flow_fingerprints(g2, {}, 7, engine)
        need({k: fp2[k] for k in a_keys} == base,
             "editing chain B changed chain A fingerprints")
        need(fp2["fmB"] != fp0["fmB"] and fp2["soB"] != fp0["soB"],
             "editing chain B must change chain B fingerprints")
        g3 = two_chain_graph(env, with_noise=False)
        g3["nodes"] = [n for n in g3["nodes"] if n["id"] in a_keys]
        g3["edges"] = [e for e in g3["edges"] if e["from"]["node"] in a_keys]
        fp3 = nodeflow.flow_fingerprints(g3, {}, 7, engine)
        need({k: fp3[k] for k in a_keys} == base,
             "removing every other node changed chain A fingerprints")
        g4 = two_chain_graph(env)
        g4["nodes"].append(node("extraB", "filter", condition="manager = 'Ann'"))
        g4["edges"].append(edge("inB", "out", "extraB", "in"))
        fp4 = nodeflow.flow_fingerprints(g4, {}, 7, engine)
        need({k: fp4[k] for k in a_keys} == base,
             "wiring a new consumer onto chain B changed chain A fingerprints")

        # Chain B edited and rerun; chain A rerun stays identical.
        b2 = env.run(g2, "soB", qid="b2")
        expect_rows(b2, [(r, m, m.lower()) for r, m in sorted(REGIONS, key=lambda x: x[1])],
                    "edited chain B", ["region", "manager", "mgr_up"], ordered=True)
        a2 = env.run(g2, "sA", qid="a2")
        expect_rows(a2, expected_chain_a(), "chain A after chain B edit",
                    ["region", "total_qty", "n"])
        a3 = env.run(g3, "sA", qid="a3")
        expect_rows(a3, expected_chain_a(), "chain A alone",
                    ["region", "total_qty", "n"])
    finally:
        env.close()


def test_disconnected_branch_cache_isolation(engine):
    env = Env(engine)
    try:
        g = two_chain_graph(env)
        env.run(g, "sA", qid="a1")
        h0 = env.hits()
        expect_rows(env.run(g, "sA", qid="a2"), expected_chain_a(),
                    "chain A warm", ["region", "total_qty", "n"])
        need(env.hits() > h0, "second chain-A run should hit the flow cache")
        h1 = env.hits()
        # Chain B's first run can only miss: nothing cached for A applies.
        expect_rows(env.run(g, "soB", qid="b1"), expected_chain_b(),
                    "chain B cold", ["region", "manager", "mgr_up"], ordered=True)
        need(env.hits() == h1,
             "chain B's first run must not hit chain A's cache entries")
        expect_rows(env.run(g, "soB", qid="b2"), expected_chain_b(),
                    "chain B warm", ["region", "manager", "mgr_up"], ordered=True)
        need(env.hits() > h1, "chain B's second run should hit its own entry")
        # Cached tables for the two chains are distinct backing tables.
        entries = env.s._flow_cache_registry.entries
        tables = {t for (t, _target, _b) in entries.values()}
        need(len(tables) == len(entries) and len(entries) >= 2,
             "each chain must own distinct cache tables: %r" % entries)
        # Editing B invalidates only B; A still hits and is unchanged.
        g["nodes"][4]["config"]["formulas"][0]["expr"] = "lower(manager)"
        expect_rows(env.run(g, "soB", qid="b3"),
                    [(r, m, m.lower()) for r, m in sorted(REGIONS, key=lambda x: x[1], reverse=True)],
                    "edited chain B", ["region", "manager", "mgr_up"], ordered=True)
        h2 = env.hits()
        expect_rows(env.run(g, "sA", qid="a3"), expected_chain_a(),
                    "chain A after B edit", ["region", "total_qty", "n"])
        need(env.hits() > h2, "chain A keeps hitting its cache after a chain-B edit")
    finally:
        env.close()


def test_shared_input_fanout_each_branch_complete(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("east", "filter", condition="region = 'East'"),
            node("big", "filter", condition="qty > 2"),
            node("sum", "summarize", **summarize_cfg(
                ["region"], [("qty", "sum", "q"), ("id", "count", "n")])),
            node("so", "sort", sorts=[{"col": "day", "dir": "asc"},
                                      {"col": "region", "dir": "asc"}]),
        ], "edges": [
            edge("in", "out", "east", "in"), edge("in", "out", "big", "in"),
            edge("in", "out", "sum", "in"), edge("in", "out", "so", "in"),
        ]}
        rows = orders_dicts()
        east = [tuple(r.values()) for r in rows if r["region"] == "East"]
        not_east = [tuple(r.values()) for r in rows if r["region"] != "East"]
        big = [tuple(r.values()) for r in rows if r["qty"] is not None and r["qty"] > 2]
        not_big = [tuple(r.values()) for r in rows if not (r["qty"] is not None and r["qty"] > 2)]
        res = batch_results(env.run_many(g, [
            ("east", "true"), ("east", "false"), ("big", "true"), ("big", "false"),
            ("sum", "out"), ("so", "out"), ("in", "out")]), "fan-out batch")
        expect_rows(res[("east", "true")], east, "east/true", ORDER_COLS)
        expect_rows(res[("east", "false")], not_east, "east/false", ORDER_COLS)
        expect_rows(res[("big", "true")], big, "big/true", ORDER_COLS)
        expect_rows(res[("big", "false")], not_big, "big/false (NULL qty lands here)",
                    ORDER_COLS)
        expect_rows(res[("sum", "out")],
                    py_summarize(rows, ["region"], [("qty", "sum", "q"), ("id", "count", "n")]),
                    "summarize", ["region", "q", "n"])
        expect_rows(res[("so", "out")],
                    [tuple(r.values()) for r in sorted(rows, key=lambda r: (r["day"], r["region"]))],
                    "sort by day, region", ORDER_COLS, ordered=True)
        expect_rows(res[("in", "out")], [tuple(r.values()) for r in rows],
                    "input passthrough", ORDER_COLS)
        # Individually too, and the true/false ports always partition the input.
        t = expect_rows(env.run(g, "east", "true"), east, "east/true solo", ORDER_COLS)
        f = expect_rows(env.run(g, "east", "false"), not_east, "east/false solo", ORDER_COLS)
        need(len(t) + len(f) == len(ORDERS), "filter ports must partition the input")

        # A row-limited preview on one branch must never truncate another
        # branch or a later full run of the same branch.
        pv = ok(env.run(g, "east", "true", qid="pv", preview=True, preview_limit=2),
                "preview")
        need(pv.get("preview") and len(pv["rows"]) == 2 and pv.get("preview_limited"),
             "preview should be limited to 2 rows: %r" % pv)
        expect_rows(env.run(g, "big", "true", qid="full-big"), big,
                    "big/true after a preview of east", ORDER_COLS)
        expect_rows(env.run(g, "east", "true", qid="full-east"), east,
                    "east/true full run after its own preview", ORDER_COLS)
        expect_rows(env.run(g, "sum", "out", qid="full-sum"),
                    py_summarize(rows, ["region"], [("qty", "sum", "q"), ("id", "count", "n")]),
                    "summarize after previews", ["region", "q", "n"])
    finally:
        env.close()


# ---------------------------------------------------------------------------
# 2. Connected nodes: complete, accurate data at every hop
# ---------------------------------------------------------------------------
def test_linear_chain_every_hop(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("f", "filter", condition="qty > 2"),
            node("fm", "formula", formulas=[
                {"name": "total", "expr": "qty * price"},
                {"name": "disc", "expr": "qty * price * 0.9"}]),
            node("sel", "select", fields=[
                {"name": "id", "keep": True}, {"name": "region", "keep": True},
                {"name": "product", "keep": False}, {"name": "qty", "keep": False},
                {"name": "price", "keep": False}, {"name": "day", "keep": False},
                {"name": "total", "keep": True},
                {"name": "disc", "keep": True, "rename": "discounted"}]),
            node("so", "sort", sorts=[{"col": "total", "dir": "desc"},
                                      {"col": "region", "dir": "asc"}]),
            node("out", "output"),
        ], "edges": chain(("in", "out", None), ("f", "true", "in"), ("fm", "out", "in"),
                          ("sel", "out", "in"), ("so", "out", "in"), ("out", None, "in"))}
        rows = orders_dicts()
        filt = [r for r in rows if r["qty"] is not None and r["qty"] > 2]
        need(len(filt) == 6, "fixture sanity")
        formula = [dict(r, total=r["qty"] * r["price"], disc=r["qty"] * r["price"] * 0.9)
                   for r in filt]
        selected = [(r["id"], r["region"], r["total"], r["disc"]) for r in formula]
        ordered = sorted(selected, key=lambda t: (-t[2], t[1]))

        res = batch_results(env.run_many(g, [
            ("in", "out"), ("f", "true"), ("fm", "out"), ("sel", "out"),
            ("so", "out"), ("out", "out")]), "every hop")
        expect_rows(res[("in", "out")], [tuple(r.values()) for r in rows],
                    "hop input", ORDER_COLS)
        expect_rows(res[("f", "true")], [tuple(r.values()) for r in filt],
                    "hop filter", ORDER_COLS)
        expect_rows(res[("fm", "out")],
                    [tuple(r[c] for c in ORDER_COLS) + (r["total"], r["disc"]) for r in formula],
                    "hop formula", list(ORDER_COLS) + ["total", "disc"])
        need(cols_of(res[("sel", "out")]) == ["id", "region", "total", "discounted"],
             "select output columns/rename: %r" % cols_of(res[("sel", "out")]))
        expect_rows(res[("sel", "out")], selected, "hop select",
                    ["id", "region", "total", "discounted"])
        expect_rows(res[("so", "out")], ordered, "hop sort",
                    ["id", "region", "total", "discounted"], ordered=True)
        expect_rows(res[("out", "out")], ordered, "hop output",
                    ["id", "region", "total", "discounted"], ordered=True)
        # Solo runs (fused SQL path) agree with the batch (checkpointed path).
        for nid, port, want, cols, is_ordered in (
                ("f", "true", [tuple(r.values()) for r in filt], ORDER_COLS, False),
                ("sel", "out", selected, ["id", "region", "total", "discounted"], False),
                ("out", "out", ordered, ["id", "region", "total", "discounted"], True)):
            expect_rows(env.run(g, nid, port, qid="solo-" + nid), want,
                        "solo %s" % nid, cols, ordered=is_ordered)
    finally:
        env.close()


def test_join_ports_complete(engine):
    env = Env(engine)
    try:
        def graph(mode="inner"):
            return {"nodes": [
                node("o", "input", table=env.orders),
                node("r", "input", table=env.regions),
                node("j", "join", keys=[{"left": "region", "right": "region"}], mode=mode),
            ], "edges": [edge("o", "out", "j", "left"), edge("r", "out", "j", "right")]}
        mgr = dict(REGIONS)
        rows = orders_dicts()
        inner = [tuple(r.values()) + (mgr[r["region"]],) for r in rows if r["region"] in mgr]
        left_only = [tuple(r.values()) for r in rows if r["region"] not in mgr]
        order_regions = {r["region"] for r in rows}
        right_only = [(reg, m) for reg, m in REGIONS if reg not in order_regions]
        left_all = [tuple(r.values()) + (mgr.get(r["region"]),) for r in rows]
        need(len(inner) == 10 and len(left_only) == 2 and len(right_only) == 1,
             "fixture sanity")
        g = graph()
        res = batch_results(env.run_many(g, [
            ("j", "inner"), ("j", "left_only"), ("j", "right_only"), ("j", "out")]),
            "join ports")
        jc = list(ORDER_COLS) + ["manager"]
        expect_rows(res[("j", "inner")], inner, "inner", jc)
        expect_rows(res[("j", "left_only")], left_only, "left_only", ORDER_COLS)
        expect_rows(res[("j", "right_only")], right_only, "right_only", REGION_COLS)
        expect_rows(res[("j", "out")], inner, "out (inner mode)", jc)
        need(cols_of(res[("j", "inner")]) == jc,
             "duplicate key column dropped once: %r" % cols_of(res[("j", "inner")]))
        expect_rows(env.run(graph("left"), "j", "out", qid="left"), left_all,
                    "left join keeps every left row", jc)
        expect_rows(env.run(graph("semi"), "j", "out", qid="semi"),
                    [tuple(r.values()) for r in rows if r["region"] in mgr],
                    "semi join", ORDER_COLS)
        expect_rows(env.run(graph("anti"), "j", "out", qid="anti"), left_only,
                    "anti join", ORDER_COLS)
        # Every input row is accounted for exactly once across the ports.
        need(len(inner) + len(left_only) == len(ORDERS), "left rows partition")
        need(len({r[1] for r in inner}) + len(right_only) == len(REGIONS),
             "right rows partition")
    finally:
        env.close()


def test_union_diamond_no_row_lost(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("f", "filter", condition="region = 'East'"),
            node("u", "union"),
            node("sum", "summarize", **summarize_cfg(
                [], [("id", "count", "n"), ("qty", "sum", "q"),
                     ("region", "countd", "regions"), ("qty", "count", "qty_n")])),
            node("uq", "unique", by=["region"]),
            node("r", "input", table=env.regions),
            node("u2", "union"),
        ], "edges": [
            edge("in", "out", "f", "in"), edge("f", "true", "u", "in1"),
            edge("f", "false", "u", "in2"), edge("u", "out", "sum", "in"),
            edge("u", "out", "uq", "in"),
            edge("in", "out", "u2", "in1"), edge("r", "out", "u2", "in2"),
        ]}
        rows = orders_dicts()
        res = batch_results(env.run_many(g, [
            ("u", "out"), ("sum", "out"), ("uq", "out"), ("u2", "out")]), "diamond")
        expect_rows(res[("u", "out")], [tuple(r.values()) for r in rows],
                    "union of true+false = input", ORDER_COLS)
        expect_rows(res[("sum", "out")],
                    [(12, 36, 4, 11)], "totals over the rejoined stream",
                    ["n", "q", "regions", "qty_n"])
        uq = rows_of(res[("uq", "out")], ["region"])
        need(sorted(uq) == sorted({(r["region"],) for r in rows}),
             "unique by region: %r" % uq)
        need(int(res[("uq", "out")]["total_rows"]) == 4, "unique row count")
        # Mismatched-column union: superset schema, NULL fill, no row lost.
        u2 = res[("u2", "out")]
        need([c.lower() for c in cols_of(u2)] == [c.lower() for c in ORDER_COLS] + ["manager"],
             "union schema is the ordered superset: %r" % cols_of(u2))
        expect_rows(u2, [tuple(r.values()) + (None,) for r in rows]
                    + [(None, reg, None, None, None, None, m) for reg, m in REGIONS],
                    "union with NULL fill", list(ORDER_COLS) + ["manager"])
    finally:
        env.close()


def test_aggregate_accuracy(engine):
    env = Env(engine)
    try:
        aggs = [("qty", "sum", "sum_qty"), ("price", "avg", "avg_price"),
                ("price", "min", "min_price"), ("price", "max", "max_price"),
                ("qty", "count", "n_qty"), ("product", "countd", "n_products"),
                ("id", "count", "n_rows")]
        names = [a[2] for a in aggs]
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("by", "summarize", **summarize_cfg(["region"], aggs)),
            node("all", "summarize", **summarize_cfg([], aggs)),
            node("two", "summarize", **summarize_cfg(["region", "product"], aggs[:2])),
        ], "edges": [edge("in", "out", "by", "in"), edge("in", "out", "all", "in"),
                     edge("in", "out", "two", "in")]}
        rows = orders_dicts()
        res = batch_results(env.run_many(g, [("by", "out"), ("all", "out"), ("two", "out")]),
                            "aggregates")
        expect_rows(res[("by", "out")], py_summarize(rows, ["region"], aggs),
                    "per-region aggregates", ["region"] + names)
        expect_rows(res[("all", "out")], py_summarize(rows, [], aggs),
                    "global aggregates", names)
        expect_rows(res[("two", "out")], py_summarize(rows, ["region", "product"], aggs[:2]),
                    "two-key aggregates", ["region", "product", "sum_qty", "avg_price"])
        # Spot-check the hand-computed East figures so the Python oracle itself
        # is anchored: qty 3+5+NULL+2+1, prices 2.5,2.5,4.0,1.25,2.6.
        east = {r[0]: r for r in rows_of(res[("by", "out")], ["region"] + names)}["East"]
        need(east == ("East", 11.0, 2.57, 1.25, 4.0, 4.0, 3.0, 5.0),
             "East aggregates: %r" % (east,))
    finally:
        env.close()


def test_window_rank_topn_dedupe(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("w", "window", windows=[{
                "func": "running_sum", "col": "qty", "name": "run_qty",
                "partition_by": ["region"], "order_by": [{"col": "day", "dir": "asc"}]}]),
            node("rk", "rank", order="price", dir="desc", method="dense_rank",
                 partition=["region"], out="prank"),
            node("tn", "topn", sort="price", desc=True, n=2, group=["region"]),
            node("dd", "dedupe", keys=["region"], sort="day", keep="first"),
            node("dl", "dedupe", keys=["region"], sort="day", keep="last"),
        ], "edges": [edge("in", "out", nid, "in") for nid in ("w", "rk", "tn", "dd", "dl")]}
        rows = orders_dicts()
        # running sum per region ordered by day (NULL adds nothing); days are
        # unique within each region in the fixture.
        run = []
        acc = {}
        for r in sorted(rows, key=lambda r: r["day"]):
            acc[r["region"]] = acc.get(r["region"], 0) + (r["qty"] or 0)
            run.append(tuple(r.values()) + (acc[r["region"]],))
        # dense rank by price desc within region
        ranked = []
        for reg, grp in py_group(rows, ["region"]).items():
            prices = sorted({r["price"] for r in grp}, reverse=True)
            for r in grp:
                ranked.append(tuple(r.values()) + (prices.index(r["price"]) + 1,))
        # top 2 by price per region (fixture has no tie at the cut)
        top = []
        for reg, grp in py_group(rows, ["region"]).items():
            top.extend(tuple(r.values()) for r in sorted(grp, key=lambda r: -r["price"])[:2])
        first = [tuple(min(grp, key=lambda r: r["day"]).values())
                 for grp in py_group(rows, ["region"]).values()]
        last = [tuple(max(grp, key=lambda r: r["day"]).values())
                for grp in py_group(rows, ["region"]).values()]
        res = batch_results(env.run_many(g, [
            ("w", "out"), ("rk", "out"), ("tn", "out"), ("dd", "out"), ("dl", "out")]),
            "analytic nodes")
        expect_rows(res[("w", "out")], run, "running sum", list(ORDER_COLS) + ["run_qty"])
        expect_rows(res[("rk", "out")], ranked, "dense rank", list(ORDER_COLS) + ["prank"])
        expect_rows(res[("tn", "out")], top, "top-N per group", ORDER_COLS)
        expect_rows(res[("dd", "out")], first, "dedupe keep first", ORDER_COLS)
        expect_rows(res[("dl", "out")], last, "dedupe keep last", ORDER_COLS)
    finally:
        env.close()


def test_projection_pushdown_keeps_dependencies(engine):
    env = Env(engine)
    try:
        # price feeds the filter but is dropped by the select; the filter
        # must still apply and the count must be exact.
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("f", "filter", condition="price >= 2.5"),
            node("sel", "select", fields=[{"name": "id", "keep": True},
                                          {"name": "region", "keep": True}]),
            node("sum", "summarize", **summarize_cfg(["region"], [("id", "count", "n")])),
            node("so", "sort", sorts=[{"col": "price", "dir": "desc"},
                                      {"col": "day", "dir": "asc"}]),
            node("sel2", "select", fields=[{"name": "id", "keep": True}]),
        ], "edges": [edge("in", "out", "f", "in"), edge("f", "true", "sel", "in"),
                     edge("sel", "out", "sum", "in"), edge("f", "true", "so", "in"),
                     edge("so", "out", "sel2", "in")]}
        rows = [r for r in orders_dicts() if r["price"] >= 2.5]
        want = py_summarize(rows, ["region"], [("id", "count", "n")])
        res = batch_results(env.run_many(g, [("sum", "out"), ("sel", "out"), ("sel2", "out")]),
                            "pushdown")
        expect_rows(res[("sum", "out")], want, "count after pruned filter column",
                    ["region", "n"])
        need(cols_of(res[("sel", "out")]) == ["id", "region"],
             "select narrows to kept fields: %r" % cols_of(res[("sel", "out")]))
        expect_rows(res[("sel", "out")], [(r["id"], r["region"]) for r in rows],
                    "select rows", ["id", "region"])
        expect_rows(res[("sel2", "out")], [(r["id"],) for r in rows], "select after sort",
                    ["id"])
        expect_rows(env.run(g, "sum", "out", qid="solo"), want,
                    "fused solo run of the same chain", ["region", "n"])
    finally:
        env.close()


def test_sql_node_named_inputs(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("o", "input", table=env.orders),
            node("r", "input", table=env.regions),
            node("sq", "sql", sql=(
                "SELECT o.region AS region, SUM(o.qty) AS q, r.manager AS manager "
                "FROM %s o JOIN %s r ON o.region = r.region "
                "GROUP BY o.region, r.manager" % (env.orders, env.regions))),
            node("legacy", "sql", sql="SELECT COUNT(*) AS n, SUM(price) AS p FROM {{in}} WHERE qty > 2"),
            node("f", "filter", condition="region <> 'South'"),
        ], "edges": [edge("o", "out", "sq", "in1"), edge("r", "out", "sq", "in2"),
                     edge("o", "out", "f", "in"), edge("f", "true", "legacy", "in1")]}
        mgr = dict(REGIONS)
        rows = orders_dicts()
        joined = [r for r in rows if r["region"] in mgr]
        want = [(reg, q, mgr[reg]) for (reg,), q in
                ((k, py_agg([r["qty"] for r in grp], "sum"))
                 for k, grp in py_group(joined, ["region"]).items())]
        expect_rows(env.run(g, "sq", "out"), want, "sql node over two named inputs",
                    ["region", "q", "manager"])
        big = [r for r in rows if r["region"] != "South" and r["qty"] is not None and r["qty"] > 2]
        expect_rows(env.run(g, "legacy", "out"),
                    [(len(big), sum(r["price"] for r in big))],
                    "sql node {{in}} reads the wired upstream", ["n", "p"])
    finally:
        env.close()


def test_cache_reuse_matches_fresh(engine):
    env = Env(engine)
    try:
        g = {"nodes": [
            node("in", "input", table=env.orders),
            node("f", "filter", condition="qty >= 2"),
            node("sum", "summarize", **summarize_cfg(
                ["region"], [("qty", "sum", "q"), ("price", "avg", "p")])),
            node("so", "sort", sorts=[{"col": "q", "dir": "desc"}, {"col": "region", "dir": "asc"}]),
        ], "edges": chain(("in", "out", None), ("f", "true", "in"), ("sum", "out", "in"),
                          ("so", None, "in"))}
        rows = [r for r in orders_dicts() if r["qty"] is not None and r["qty"] >= 2]
        agg = py_summarize(rows, ["region"], [("qty", "sum", "q"), ("price", "avg", "p")])
        desc = sorted(agg, key=lambda t: (-t[1], t[0]))
        cols = ["region", "q", "p"]
        cold = expect_rows(env.run(g, "so", qid="r1"), desc, "cold run", cols, ordered=True)
        h0 = env.hits()
        warm = expect_rows(env.run(g, "so", qid="r2"), desc, "warm run", cols, ordered=True)
        need(env.hits() > h0, "warm run must reuse the cache")
        need(cold == warm, "cached run differs from cold run")
        env.s.set_fresh_run(True)
        h1 = env.hits()
        fresh = expect_rows(env.run(g, "so", qid="r3"), desc, "fresh run", cols, ordered=True)
        need(env.hits() == h1, "fresh run must not hit the cache")
        need(fresh == warm, "fresh run differs from cached run")
        env.s.set_fresh_run(False)
        # Edit only the terminal: the summarize checkpoint is reused and the
        # new ordering is exact.
        g["nodes"][3]["config"]["sorts"][0]["dir"] = "asc"
        asc = sorted(agg, key=lambda t: (t[1], t[0]))
        h2 = env.hits()
        expect_rows(env.run(g, "so", qid="r4"), asc, "terminal edit", cols, ordered=True)
        need(env.hits() > h2, "unchanged upstream checkpoint should be reused")
        # Edit upstream: nothing stale may be reused; values follow the edit.
        g["nodes"][1]["config"]["condition"] = "qty >= 3"
        rows3 = [r for r in orders_dicts() if r["qty"] is not None and r["qty"] >= 3]
        agg3 = py_summarize(rows3, ["region"], [("qty", "sum", "q"), ("price", "avg", "p")])
        expect_rows(env.run(g, "so", qid="r5"), sorted(agg3, key=lambda t: (t[1], t[0])),
                    "upstream edit", cols, ordered=True)
        expect_rows(env.run(g, "so", qid="r6"), sorted(agg3, key=lambda t: (t[1], t[0])),
                    "upstream edit, warm", cols, ordered=True)
    finally:
        env.close()


def test_createtable_source_accuracy(engine):
    env = Env(engine, load=False)
    try:
        g = {"nodes": [
            node("ct", "createtable", columns=["k", "v"],
                 rows=[["a", "1.5"], ["b", "2"], ["a", "-0.5"], ["c", ""]]),
            node("fm", "formula", formulas=[{"name": "v2", "expr": "v * 2"}]),
            node("sum", "summarize", **summarize_cfg(["k"], [("v2", "sum", "s"), ("v", "count", "n")])),
        ], "edges": chain(("ct", "out", None), ("fm", "out", "in"), ("sum", None, "in"))}
        expect_rows(env.run(g, "sum"), [("a", 2.0, 2), ("b", 4.0, 1), ("c", None, 0)],
                    "inline table through formula and summarize", ["k", "s", "n"])
    finally:
        env.close()


# ---------------------------------------------------------------------------
# 3. Latest data wins across NodeFlow / IDE query / Journal
# ---------------------------------------------------------------------------
def region_qty_graph(table):
    return {"nodes": [
        node("in", "input", table=table),
        node("sum", "summarize", **summarize_cfg(["region"], [("qty", "sum", "q"), ("id", "count", "n")])),
        node("so", "sort", sorts=[{"col": "region", "dir": "asc"}]),
    ], "edges": chain(("in", "out", None), ("sum", "out", "in"), ("so", None, "in"))}


def region_qty_expected(rows):
    return sorted(py_summarize(orders_dicts(rows), ["region"],
                               [("qty", "sum", "q"), ("id", "count", "n")]))


def journal_cells(env, qid_prefix, expect_reuse_works):
    """Journal chain: cell c1 selects the table, cell c2 reads c1 by name via
    reuse. DuckDB reuses c1's parquet; SQLite must bounce (reuse_stale) so
    the client inlines the upstream SQL instead -- never silently stale."""
    c1 = ok(env.query('SELECT * FROM "%s"' % env.orders, surface="journal",
                      qid=qid_prefix + "-c1"), "journal c1")
    c2 = env.query("SELECT region, COUNT(*) AS n FROM c1 GROUP BY region",
                   surface="journal", qid=qid_prefix + "-c2",
                   reuse={"c1": c1["result_id"]})
    if expect_reuse_works:
        ok(c2, "journal c2 via reuse")
        need(not c2.get("reuse_stale"), "reuse should be live: %r" % c2)
    else:
        need(c2.get("reuse_stale") == ["c1"],
             "non-DuckDB reuse must bounce as reuse_stale: %r" % c2)
    return c1, c2


def test_sql_writes_refresh_every_surface(engine):
    env = Env(engine)
    duck = engine == "duckdb"
    try:
        g = region_qty_graph(env.orders)
        base = region_qty_expected(ORDERS)
        ide_sql = ('SELECT region, SUM(qty) AS q, COUNT(id) AS n FROM "%s" '
                   'GROUP BY region ORDER BY region' % env.orders)
        ide = expect_rows(env.query(ide_sql, qid="ide1"), base, "IDE query", ordered=True)
        need(int(env.query(ide_sql, qid="ide1b")["data_epoch"]) == env.s._data_epoch,
             "IDE result stamps the live data epoch")
        c1, c2 = journal_cells(env, "j1", duck)
        if duck:
            expect_rows(c2, [(reg, n) for reg, _q, n in base], "journal c2", ["region", "n"])
        env.run(g, "so", qid="nf1")
        h0 = env.hits()
        nf = expect_rows(env.run(g, "so", qid="nf2"), base, "nodeflow warm", ordered=True)
        need(env.hits() > h0, "nodeflow warm run hit the cache")
        ide_rid = env.query(ide_sql, qid="ide2")["result_id"]
        nf_rid = env.run(g, "so", qid="nf3")["result_id"]
        need(not env.expired(ide_rid) and not env.expired(nf_rid),
             "live results page before any mutation")

        # --- INSERT ---
        epoch0 = env.s._data_epoch
        env.write('INSERT INTO "%s" VALUES (13, \'East\', \'apple\', 10, 2.5, \'2024-01-07\')'
                  % env.orders, qid="ins")
        need(env.s._data_epoch > epoch0, "a SQL write advances the data epoch")
        for rid, what in ((ide_rid, "IDE"), (nf_rid, "NodeFlow"), (c1["result_id"], "journal c1")):
            need(env.expired(rid), "%s result must expire after a write" % what)
            need(env.s._live_cached_result(rid) is None, "%s snapshot not live" % what)
        with_13 = ORDERS + [(13, "East", "apple", 10, 2.5, "2024-01-07")]
        want = region_qty_expected(with_13)
        h1 = env.hits()
        expect_rows(env.run(g, "so", qid="nf4"), want, "nodeflow after INSERT", ordered=True)
        need(env.hits() == h1, "no pre-write cache table may be reused after a write")
        expect_rows(env.query(ide_sql, qid="ide3"), want, "IDE after INSERT", ordered=True)
        stale = env.query("SELECT region, COUNT(*) AS n FROM c1 GROUP BY region",
                          surface="journal", qid="j2-c2", reuse={"c1": c1["result_id"]})
        need(stale.get("reuse_stale") == ["c1"],
             "journal reuse of a pre-write cell must bounce: %r" % stale)
        n1, n2 = journal_cells(env, "j3", duck)
        if duck:
            expect_rows(n2, [(reg, n) for reg, _q, n in want], "journal after INSERT",
                        ["region", "n"])
        expect_rows(n1, with_13, "journal c1 after INSERT", ORDER_COLS)
        # Preview-class runs also see the write (no stale connector reuse).
        pv = ok(env.run(g, "so", qid="pv", preview=True, preview_limit=100), "preview")
        expect_rows(pv, want, "preview after INSERT", ordered=True)

        # --- UPDATE ---
        env.write('UPDATE "%s" SET qty = 20 WHERE id = 13' % env.orders, qid="upd")
        upd = [r if r[0] != 13 else (13, "East", "apple", 20, 2.5, "2024-01-07") for r in with_13]
        expect_rows(env.run(g, "so", qid="nf5"), region_qty_expected(upd),
                    "nodeflow after UPDATE", ordered=True)
        expect_rows(env.query(ide_sql, qid="ide4"), region_qty_expected(upd),
                    "IDE after UPDATE", ordered=True)
        res = batch_results(env.run_many(g, [("sum", "out"), ("so", "out")], qid="b1"), "batch")
        expect_rows(res[("so", "out")], region_qty_expected(upd), "batch after UPDATE",
                    ordered=True)

        # --- DELETE back to the original: the original answer must be
        # recomputed, never replayed from the post-INSERT cache.
        env.write('DELETE FROM "%s" WHERE id = 13' % env.orders, qid="del")
        expect_rows(env.run(g, "so", qid="nf6"), base, "nodeflow after DELETE", ordered=True)
        expect_rows(env.query(ide_sql, qid="ide5"), base, "IDE after DELETE", ordered=True)
        need(rows_of(env.run(g, "so", qid="nf7")) == nf
             and rows_of(env.query(ide_sql, qid="ide6")) == ide,
             "post-delete answers equal the pre-insert answers")
    finally:
        env.close()


def test_write_node_feeds_other_surfaces_fresh(engine):
    env = Env(engine)
    try:
        def writer(cond):
            return {"nodes": [
                node("in", "input", table=env.orders),
                node("f", "filter", condition=cond),
                node("w", "write", table="picked", dest=engine, mode="overwrite"),
            ], "edges": [edge("in", "out", "f", "in"), edge("f", "true", "w", "in")]}
        rows = orders_dicts()
        east = [tuple(r.values()) for r in rows if r["region"] == "East"]
        west = [tuple(r.values()) for r in rows if r["region"] == "West"]
        w1 = ok(env.s.run_nodeflow_to_table(writer("region = 'East'"), "w", "picked",
                                            query_id="w1"), "write East")
        need(w1.get("ok") and w1.get("rows") == len(east), "write East rows: %r" % w1)
        picked = w1["table"]
        sel = 'SELECT * FROM "%s"' % picked
        ide = expect_rows(env.query(sel, qid="ide1"), east, "IDE reads the written table", ORDER_COLS)
        ide_rid = env.query(sel, qid="ide2")["result_id"]
        g2 = {"nodes": [node("p", "input", table=picked),
                        node("sum", "summarize", **summarize_cfg([], [("id", "count", "n"), ("qty", "sum", "q")]))],
              "edges": [edge("p", "out", "sum", "in")]}
        env.run(g2, "sum", qid="g2a")
        h0 = env.hits()
        expect_rows(env.run(g2, "sum", qid="g2b"), [(5, 11)], "nodeflow over written table", ["n", "q"])
        need(env.hits() > h0, "warm g2 hit")
        c1 = ok(env.query(sel, surface="journal", qid="jc1"), "journal c1")

        # Overwrite with a different upstream: every surface must see West.
        w2 = ok(env.s.run_nodeflow_to_table(writer("region = 'West'"), "w", "picked",
                                            query_id="w2"), "write West")
        need(w2.get("table") == picked and w2.get("rows") == len(west),
             "overwrite keeps the name and reports the new row count: %r" % w2)
        need(env.expired(ide_rid), "IDE result over the overwritten table expired")
        need(env.expired(c1["result_id"]), "journal cell over the overwritten table expired")
        expect_rows(env.query(sel, qid="ide3"), west, "IDE after overwrite", ORDER_COLS)
        h1 = env.hits()
        expect_rows(env.run(g2, "sum", qid="g2c"), [(4, 10)], "nodeflow after overwrite", ["n", "q"])
        need(env.hits() == h1, "no stale cache hit after a write-node overwrite")
        stale = env.query("SELECT COUNT(*) AS n FROM c1", surface="journal", qid="jc2",
                          reuse={"c1": c1["result_id"]})
        need(stale.get("reuse_stale") == ["c1"], "journal reuse bounces after overwrite: %r" % stale)

        # Append mode accumulates exactly once.
        w3 = ok(env.s.run_nodeflow_to_table(
            {"nodes": writer("region = 'East'")["nodes"][:2] + [
                node("w", "write", table="picked", dest=engine, mode="append")],
             "edges": writer("x")["edges"]}, "w", "picked", query_id="w3"), "append East")
        need(w3.get("rows") == len(west) + len(east), "append row count: %r" % w3)
        expect_rows(env.query(sel, qid="ide4"), west + east, "IDE after append", ORDER_COLS)
        expect_rows(env.run(g2, "sum", qid="g2d"), [(9, 21)], "nodeflow after append", ["n", "q"])
        need(ide != rows_of(env.query(sel, qid="ide5"), ORDER_COLS),
             "the IDE must not be serving the first snapshot")
    finally:
        env.close()


def test_file_reload_and_drop_refresh(engine):
    env = Env(engine)
    try:
        g = region_qty_graph(env.orders)
        ide_sql = 'SELECT COUNT(*) AS n, SUM(qty) AS q FROM "%s"' % env.orders
        expect_rows(env.query(ide_sql, qid="i1"), [(12, 36)], "IDE before reload")
        env.run(g, "so", qid="n1")
        nf_rid = ok(env.run(g, "so", qid="n2"), "warm").get("result_id")
        ide_rid = env.query(ide_sql, qid="i2")["result_id"]
        c1 = ok(env.query(ide_sql, surface="journal", qid="j1"), "journal")
        bigger = ORDERS + [(13, "South", "pear", 4, 4.0, "2024-01-07"),
                           (14, "North", "plum", 1, 1.25, "2024-01-07")]
        env.write_orders(bigger)
        epoch0 = env.s._data_epoch
        rl = env.s.reload_table_from_source(engine, env.orders, replace=True)
        need(isinstance(rl, dict) and rl.get("ok") and not rl.get("error"),
             "reload failed: %r" % rl)
        need(env.s._data_epoch > epoch0, "reload advances the epoch")
        for rid, what in ((nf_rid, "NodeFlow"), (ide_rid, "IDE"), (c1["result_id"], "journal")):
            need(env.expired(rid), "%s result expired after reload" % what)
        h = env.hits()
        expect_rows(env.run(g, "so", qid="n3"), region_qty_expected(bigger),
                    "nodeflow after reload", ordered=True)
        need(env.hits() == h, "no stale hit after reload")
        expect_rows(env.query(ide_sql, qid="i3"), [(14, 41)], "IDE after reload")
        expect_rows(env.query(ide_sql, surface="journal", qid="j2"), [(14, 41)],
                    "journal after reload")

        # Drop: nothing may answer from a cache for a table that is gone.
        env.run(g, "so", qid="n4")
        d = env.s.drop_table(engine, env.orders)
        need(d.get("ok"), "drop: %r" % d)
        gone = env.run(g, "so", qid="n5")
        need(gone.get("error") and not gone.get("rows"),
             "a flow over a dropped table must error, not replay: %r" % gone)
        need(env.query(ide_sql, qid="i4").get("error"), "IDE over a dropped table errors")
        # Loading a different file under the same name serves that file.
        env.write_orders(ORDERS[:3])
        name = env.load(env.orders_path, "orders")
        need(name == env.orders, "reload under the same name: %r" % name)
        expect_rows(env.run(g, "so", qid="n6"), region_qty_expected(ORDERS[:3]),
                    "nodeflow over the re-loaded table", ordered=True)
        expect_rows(env.query(ide_sql, qid="i5"), [(3, 9)], "IDE over the re-loaded table")
    finally:
        env.close()


def test_mid_run_mutation_never_serves_stale(engine):
    env = Env(engine)
    try:
        g = region_qty_graph(env.orders)
        eng = env.s.duckdb if engine == "duckdb" else env.s.db
        real = eng.execute
        state = {"bumped": 0}

        def mutate_mid_build(sql, *a, **kw):
            if not state["bumped"] and "CREATE" in sql.upper() and "__nb" in sql:
                state["bumped"] = 1
                env.s._bump_data_epoch()   # a write landing mid-build
            return real(sql, *a, **kw)
        eng.execute = mutate_mid_build
        try:
            res = env.run(g, "so", qid="mid")
        finally:
            eng.execute = real
        need(state["bumped"], "the build was intercepted")
        served = not res.get("error") and res.get("rows")
        if served:
            need(env.expired(res["result_id"]),
                 "a result built across a mutation must not stay pageable")
        else:
            need(res.get("error") == "result expired",
                 "mid-run mutation must surface as an expired result: %r" % res)
        # The next clean run answers from the live catalog.
        expect_rows(env.run(g, "so", qid="after"), region_qty_expected(ORDERS),
                    "run after the mid-build mutation", ordered=True)
    finally:
        env.close()


def test_persistent_cache_respects_in_session_writes():
    env = Env("duckdb", persistent=True)
    try:
        g = region_qty_graph(env.orders)
        expect_rows(env.run(g, "so", qid="p1"), region_qty_expected(ORDERS),
                    "persistent cold", ordered=True)
        info = env.s.flow_cache_info()["persistent"]
        need(info["writes"] >= 1, "persistent intermediate published: %r" % info)
        env.write('INSERT INTO "%s" VALUES (13, \'East\', \'apple\', 10, 2.5, \'2024-01-07\')'
                  % env.orders, qid="ins")
        with_13 = ORDERS + [(13, "East", "apple", 10, 2.5, "2024-01-07")]
        expect_rows(env.run(g, "so", qid="p2"), region_qty_expected(with_13),
                    "persistent cache after in-session write", ordered=True)
        need(env.s.flow_cache_info()["persistent"]["hits"] == 0,
             "an in-session write must not restore the on-disk intermediate")
        expect_rows(env.run(g, "so", qid="p3"), region_qty_expected(with_13),
                    "second run after the write", ordered=True)
        # A new session on the unchanged file legitimately restores the file's
        # intermediate -- and it equals a fresh computation over that file.
        env.s.shutdown()
        s2 = Session()
        s2.fresh_run = False
        s2.fresh_load = False
        s2.adaptive_resources = False
        s2.flow_cache = False
        s2.persistent_flow_cache = True
        s2.persistent_flow_cache_mb_configured = 128
        env.s = s2
        name = env.load(env.orders_path, "orders")
        need(name == env.orders, "same table name in the new session")
        expect_rows(env.run(g, "so", qid="p4"), region_qty_expected(ORDERS),
                    "restart restore equals the file", ordered=True)
        # Edit the file, reload, and the restored intermediate is bypassed.
        env.write_orders(ORDERS[:6])
        rl = s2.reload_table_from_source("duckdb", env.orders, replace=True)
        need(rl.get("ok"), "reload: %r" % rl)
        hits = s2.flow_cache_info()["persistent"]["hits"]
        expect_rows(env.run(g, "so", qid="p5"), region_qty_expected(ORDERS[:6]),
                    "after file edit + reload", ordered=True)
        need(s2.flow_cache_info()["persistent"]["hits"] == hits,
             "a changed file must not restore the old intermediate")
    finally:
        env.close()


def test_write_to_one_table_keeps_other_flows_exact(engine):
    """A write to table X: results over X expire; a flow over Y is recomputed
    from live data too (epoch is global) and still correct."""
    env = Env(engine)
    try:
        gx = region_qty_graph(env.orders)
        gy = {"nodes": [node("r", "input", table=env.regions),
                        node("so", "sort", sorts=[{"col": "region", "dir": "asc"}])],
              "edges": [edge("r", "out", "so", "in")]}
        expect_rows(env.run(gy, "so", qid="y1"), sorted(REGIONS), "Y cold", REGION_COLS, ordered=True)
        expect_rows(env.run(gx, "so", qid="x1"), region_qty_expected(ORDERS), "X cold", ordered=True)
        env.write('INSERT INTO "%s" VALUES (\'North\', \'Ned\')' % env.regions, qid="ins")
        new_regions = sorted(REGIONS + [("North", "Ned")])
        expect_rows(env.run(gy, "so", qid="y2"), new_regions, "Y after its write", REGION_COLS, ordered=True)
        expect_rows(env.run(gx, "so", qid="x2"), region_qty_expected(ORDERS), "X unaffected", ordered=True)
        j = {"nodes": [node("o", "input", table=env.orders), node("r", "input", table=env.regions),
                       node("j", "join", keys=[{"left": "region", "right": "region"}])],
             "edges": [edge("o", "out", "j", "left"), edge("r", "out", "j", "right")]}
        mgr = dict(new_regions)
        expect_rows(env.run(j, "j", "inner", qid="j1"),
                    [tuple(r.values()) + (mgr[r["region"]],) for r in orders_dicts()],
                    "join sees the new region row", list(ORDER_COLS) + ["manager"])
        need(int(env.run(j, "j", "left_only", qid="j2")["total_rows"]) == 0,
             "no left-only rows once every region has a manager")
    finally:
        env.close()


# ---------------------------------------------------------------------------
def main():
    engines = ["sqlite"] + (["duckdb"] if HAS_DUCKDB else [])
    if not HAS_DUCKDB:
        print("SKIP duckdb variants (duckdb not installed)")
    per_engine = [
        ("disconnected chains are independent", test_disconnected_chains_independent),
        ("disconnected branches never share cache entries", test_disconnected_branch_cache_isolation),
        ("shared input fan-out: every branch complete", test_shared_input_fanout_each_branch_complete),
        ("linear chain: every hop matches ground truth", test_linear_chain_every_hop),
        ("join: every port complete and exact", test_join_ports_complete),
        ("union/unique diamond loses no row", test_union_diamond_no_row_lost),
        ("aggregate calculations exact", test_aggregate_accuracy),
        ("window/rank/top-N/dedupe exact", test_window_rank_topn_dedupe),
        ("projection pushdown keeps filter dependencies", test_projection_pushdown_keeps_dependencies),
        ("SQL node named inputs exact", test_sql_node_named_inputs),
        ("cache reuse equals fresh computation", test_cache_reuse_matches_fresh),
        ("inline table source exact", test_createtable_source_accuracy),
        ("SQL writes refresh NodeFlow, IDE and Journal", test_sql_writes_refresh_every_surface),
        ("write node output refreshes every surface", test_write_node_feeds_other_surfaces_fresh),
        ("file reload and drop refresh every surface", test_file_reload_and_drop_refresh),
        ("mid-run mutation never serves stale rows", test_mid_run_mutation_never_serves_stale),
        ("write to one table keeps other flows exact", test_write_to_one_table_keeps_other_flows_exact),
    ]
    tests = []
    for engine in engines:
        for name, fn in per_engine:
            tests.append(("[%s] %s" % (engine, name), (lambda f=fn, e=engine: f(e))))
    if HAS_DUCKDB:
        tests.append(("[duckdb] persistent cache respects in-session writes",
                      test_persistent_cache_respects_in_session_writes))
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as exc:
            failed += 1
            print("FAIL", name, "-", exc)
            if VERBOSE:
                traceback.print_exc()
    print("%d passed, %d failed" % (len(tests) - failed, failed))
    shutil.rmtree(_SANDBOX, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
