#!/usr/bin/env python3
"""Executed tests for adaptive NodeFlow resources, parallel branches and
restart-persistent deterministic intermediates."""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from samql_core import Session  # noqa: E402
from samql_core import resourcebudget  # noqa: E402
from samql_core.engines import HAS_DUCKDB  # noqa: E402
from samql_core.flowcache import PersistentFlowCache  # noqa: E402


class Failure(AssertionError):
    pass


def need(cond, message):
    if not cond:
        raise Failure(message)


def graph_for(table, prefix="a"):
    return {
        "nodes": [
            {"id": prefix + "s", "type": "input", "config": {"table": table}},
            {"id": prefix + "f", "type": "formula", "config": {
                "formulas": [{"name": "double_v", "expr": "v * 2"}]}},
            {"id": prefix + "o", "type": "output", "config": {}},
        ],
        "edges": [
            {"from": {"node": prefix + "s", "port": "out"},
             "to": {"node": prefix + "f", "port": "in"}},
            {"from": {"node": prefix + "f", "port": "out"},
             "to": {"node": prefix + "o", "port": "in"}},
        ],
    }


def test_adaptive_budget():
    r = resourcebudget.recommend()
    need(r["recommended_flow_cache_mb"] >= 128, "flow-cache recommendation")
    need(1 <= r["recommended_parallel_workers"] <= 4, "worker recommendation")
    eff = resourcebudget.effective_limits(8192, 65536, 16, adaptive=True)
    need(1024 <= eff["engine_memory_mb"] <= r["recommended_engine_mb"],
         "adaptive engine memory is bounded")
    need(eff["flow_cache_mb"] <= 8192, "adaptive flow limit is a ceiling")
    need(eff["persistent_cache_mb"] <= 65536, "adaptive disk limit is a ceiling")
    need(1 <= eff["parallel_workers"] <= 4, "adaptive workers are bounded")

    # Critical temp-disk pressure must disable persistent reuse rather than
    # accidentally turning max_bytes=0 into an unlimited cache.
    original = resourcebudget.recommend
    resourcebudget.recommend = lambda _temp=None: {
        "memory_total": 8 * 1024**3, "memory_available": 4 * 1024**3,
        "memory_total_mb": 8192.0, "memory_available_mb": 4096.0,
        "disk_total": 10 * 1024**3, "disk_free": 1024**3,
        "disk_free_gb": 1.0, "cpus": 8,
        "recommended_engine_mb": 4096,
        "recommended_flow_cache_mb": 512,
        "recommended_persistent_cache_mb": 2048,
        "recommended_parallel_workers": 2,
    }
    try:
        pressured = resourcebudget.effective_limits(1024, 4096, 4, adaptive=True)
        need(pressured["persistent_cache_mb"] == 0,
             "critical disk pressure disables persistent cache budget")
    finally:
        resourcebudget.recommend = original



def test_duckdb_adaptive_memory():
    if not HAS_DUCKDB:
        print("SKIP adaptive DuckDB memory (duckdb not installed)")
        return
    s = Session()
    s.adaptive_resources = True
    try:
        budget = s._effective_resource_budget()
        d = s.get_duckdb()
        need(1024 <= int(d._applied_resource_memory_mb or 0)
             <= int(budget["recommended_engine_mb"]),
             "DuckDB did not start with a bounded adaptive memory ceiling")
        # Adaptive sync must NOT crush a live engine ceiling downward —
        # that aborted flatten/shred after large loads reduced "available" RAM.
        original = resourcebudget.effective_limits
        def pressured(*args, **kwargs):
            out = original(*args, **kwargs)
            out["engine_memory_mb"] = 768
            return out
        resourcebudget.effective_limits = pressured
        try:
            before = int(d._applied_resource_memory_mb or 0)
            s._sync_flow_cache_limits()
            need(int(d._applied_resource_memory_mb or 0) >= before,
                 "adaptive sync must not shrink the live engine memory ceiling")
        finally:
            resourcebudget.effective_limits = original
        # Explicit decrease still works (UI / low-memory).
        need(d.apply_resource_memory_mb(1024, allow_decrease=True),
             "explicit allow_decrease can lower the ceiling")
        need(int(d._applied_resource_memory_mb) == 1024,
             "explicit decrease applied")
        # Heavy-op raise must follow TOTAL RAM, not depressed OS available
        # (the "3.4 of 3.4 GiB used" flatten failure mode).
        from samql_core.engines import ensure_heavy_op_engine_memory
        original_rec = resourcebudget.recommend
        resourcebudget.recommend = lambda _temp=None: {
            "memory_total": 16 * 1024**3,
            "memory_available": 3 * 1024**3,
            "memory_total_mb": 16384.0,
            "memory_available_mb": 3072.0,
            "disk_total": 100 * 1024**3,
            "disk_free": 50 * 1024**3,
            "disk_free_gb": 50.0,
            "cpus": 8,
            "recommended_engine_mb": 12288,
            "recommended_flow_cache_mb": 512,
            "recommended_persistent_cache_mb": 4096,
            "recommended_parallel_workers": 2,
        }
        try:
            need(ensure_heavy_op_engine_memory(d),
                 "heavy-op raise should apply when available is depressed")
            need(int(d._applied_resource_memory_mb) >= 12000,
                 "heavy-op raise targets ~75% of total, not available*0.7")
        finally:
            resourcebudget.recommend = original_rec
    finally:
        s.shutdown()


def _make_csv(path):
    path.write_text("id,v\n1,10\n2,20\n3,30\n", encoding="utf-8")


def test_persistent_restart_cache():
    if not HAS_DUCKDB:
        print("SKIP persistent restart cache (duckdb not installed)")
        return
    old_home = os.environ.get("HOME")
    old_pf = os.environ.get("SAMQL_PERSISTENT_FLOW_CACHE_DIR")
    with tempfile.TemporaryDirectory(prefix="samql_nf_persist_") as td:
        home = Path(td) / "home"
        home.mkdir()
        src = Path(td) / "source.csv"
        cache = Path(td) / "cache"
        _make_csv(src)
        os.environ["HOME"] = str(home)
        os.environ["SAMQL_PERSISTENT_FLOW_CACHE_DIR"] = str(cache)
        try:
            s1 = Session()
            s1.flow_cache = False
            s1.adaptive_resources = False
            s1.persistent_flow_cache = True
            s1.persistent_flow_cache_mb_configured = 128
            loaded = s1.load_file(str(src), destination="duckdb",
                                  base_name="persist_src", flatten=False)
            need(isinstance(loaded, list) and loaded,
                 "first source load failed: %r" % loaded)
            g = graph_for("persist_src")
            first = s1.run_nodeflow(g, "ao", "out")
            need(not first.get("error"), "first flow failed: %r" % first)
            info1 = s1.flow_cache_info()["persistent"]
            need(info1["writes"] >= 1 and info1["size"] >= 1,
                 "first run did not publish a persistent intermediate")
            s1.shutdown()

            s2 = Session()
            s2.flow_cache = False
            s2.adaptive_resources = False
            s2.persistent_flow_cache = True
            s2.persistent_flow_cache_mb_configured = 128
            loaded2 = s2.load_file(str(src), destination="duckdb",
                                   base_name="persist_src", flatten=False)
            need(isinstance(loaded2, list) and loaded2,
                 "second source load failed: %r" % loaded2)
            second = s2.run_nodeflow(g, "ao", "out")
            need(not second.get("error"), "second flow failed: %r" % second)
            need([r[-1] for r in second.get("rows", [])] == [20, 40, 60],
                 "persistent result rows changed")
            info2 = s2.flow_cache_info()["persistent"]
            need(info2["hits"] >= 1,
                 "second session did not reuse the persistent intermediate")
            s2.shutdown()

            # A changed source stat signature must never reuse the prior file.
            src.write_text("id,v\n1,11\n2,22\n3,33\n", encoding="utf-8")
            s3 = Session()
            s3.flow_cache = False
            s3.adaptive_resources = False
            s3.persistent_flow_cache = True
            s3.persistent_flow_cache_mb_configured = 128
            loaded3 = s3.load_file(str(src), destination="duckdb",
                                   base_name="persist_src", flatten=False)
            need(isinstance(loaded3, list) and loaded3,
                 "changed source reload failed: %r" % loaded3)
            third = s3.run_nodeflow(g, "ao", "out")
            need([r[-1] for r in third.get("rows", [])] == [22, 44, 66],
                 "source change reused stale persistent data")
            need(s3.flow_cache_info()["persistent"]["hits"] == 0,
                 "changed source fingerprint should miss the old cache")
            s3.shutdown()
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            if old_pf is None:
                os.environ.pop("SAMQL_PERSISTENT_FLOW_CACHE_DIR", None)
            else:
                os.environ["SAMQL_PERSISTENT_FLOW_CACHE_DIR"] = old_pf




def test_persistent_rejects_nondeterministic_graphs():
    if not HAS_DUCKDB:
        print("SKIP persistent nondeterminism guard (duckdb not installed)")
        return
    old_pf = os.environ.get("SAMQL_PERSISTENT_FLOW_CACHE_DIR")
    with tempfile.TemporaryDirectory(prefix="samql_nf_nondeterministic_") as td:
        src = Path(td) / "source.csv"
        cache = Path(td) / "cache"
        _make_csv(src)
        os.environ["SAMQL_PERSISTENT_FLOW_CACHE_DIR"] = str(cache)
        try:
            s = Session()
            s.flow_cache = False
            s.adaptive_resources = False
            s.persistent_flow_cache = True
            s.persistent_flow_cache_mb_configured = 128
            s.load_file(str(src), destination="duckdb",
                        base_name="volatile_src", flatten=False)
            graph = {
                "nodes": [
                    {"id": "s", "type": "input",
                     "config": {"table": "volatile_src"}},
                    {"id": "f", "type": "formula", "config": {
                        "formulas": [{"name": "r", "expr": "random()"}]}},
                    {"id": "o", "type": "output", "config": {}},
                ],
                "edges": [
                    {"from": {"node": "s", "port": "out"},
                     "to": {"node": "f", "port": "in"}},
                    {"from": {"node": "f", "port": "out"},
                     "to": {"node": "o", "port": "in"}},
                ],
            }
            result = s.run_nodeflow(graph, "o", "out")
            need(not result.get("error"),
                 "volatile graph itself should still execute")
            info = s.flow_cache_info()["persistent"]
            need(info["size"] == 0 and info["writes"] == 0,
                 "volatile graph was persisted across restarts")
            need(info["skips"] >= 1,
                 "unsafe persistent-cache skip was not observable")
            s.shutdown()
        finally:
            if old_pf is None:
                os.environ.pop("SAMQL_PERSISTENT_FLOW_CACHE_DIR", None)
            else:
                os.environ["SAMQL_PERSISTENT_FLOW_CACHE_DIR"] = old_pf

def test_persistent_registry_safety():
    with tempfile.TemporaryDirectory(prefix="samql_nf_registry_") as td:
        cache = PersistentFlowCache(Path(td), max_bytes=8, max_age_days=0)

        # A single result larger than the whole disk budget is never published.
        def write_big(path):
            Path(path).write_bytes(b"0123456789")

        need(not cache.publish("a" * 40, write_big),
             "oversized persistent entry should be rejected")
        info = cache.info()
        need(info["size"] == 0 and info["oversized"] == 1,
             "oversized entry leaked into the persistent cache")

        cache.configure(max_bytes=64)

        def write_small(path):
            Path(path).write_bytes(b"safe")

        need(cache.publish("b" * 40, write_small),
             "small persistent entry did not publish")
        pinned = cache.acquire("b" * 40)
        need(pinned and Path(pinned).exists(), "published entry could not be pinned")
        cache.configure(max_bytes=1)
        cache.clear()
        need(Path(pinned).exists(),
             "budget trim or clear removed a file during an active restore")
        need(cache.info()["pinned"] == 1, "pin telemetry missing")
        cache.release(pinned)
        cache.prune()
        need(not Path(pinned).exists(),
             "released over-budget entry was not reclaimed")


def test_parallel_independent_branches():
    if not HAS_DUCKDB:
        print("SKIP parallel branches (duckdb not installed)")
        return
    s = Session()
    s.flow_cache = False
    s.persistent_flow_cache = False
    s.adaptive_resources = False
    s.parallel_nodeflows = True
    s.parallel_nodeflow_workers = 2
    d = s.get_duckdb()
    d.execute('CREATE TABLE pleft AS SELECT i AS id, i AS v FROM range(0, 1000) t(i)')
    d.execute('CREATE TABLE pright AS SELECT i AS id, i + 1 AS v FROM range(0, 1000) t(i)')
    d.table_columns["pleft"] = ["id", "v"]
    d.table_columns["pright"] = ["id", "v"]
    g1 = graph_for("pleft", "l")
    g2 = graph_for("pright", "r")
    graph = {"nodes": g1["nodes"] + g2["nodes"],
             "edges": g1["edges"] + g2["edges"]}

    original = d.branch_cursor
    state = {"active": 0, "max": 0}
    gate = threading.Lock()

    def tracked_branch():
        inner = original()
        original_execute = inner.execute

        def execute(sql):
            if str(sql).lstrip().upper().startswith("CREATE"):
                with gate:
                    state["active"] += 1
                    state["max"] = max(state["max"], state["active"])
                try:
                    time.sleep(0.12)
                    return original_execute(sql)
                finally:
                    with gate:
                        state["active"] -= 1
            return original_execute(sql)
        inner.execute = execute
        return inner

    d.branch_cursor = tracked_branch
    try:
        out = s.run_nodeflows(
            graph, [{"node": "lo", "port": "out"},
                    {"node": "ro", "port": "out"}],
            query_id="parallel-public-batch")
        need(out.get("ok") and len(out.get("results") or []) == 2,
             "public batch run lost a target: %r" % out)
        need(state["max"] >= 2,
             "independent branches did not overlap on separate DuckDB cursors")
        _cols, leftovers = d.execute(
            "SELECT table_name FROM duckdb_tables() "
            "WHERE table_name LIKE '__nbflow_%'")
        need(not leftovers,
             "successful parallel batch left hidden regular tables: %r" % leftovers)

        # If one parallel worker fails after another has created relations, all
        # hidden regular branch tables must still be removed.
        bad = {
            "nodes": graph["nodes"] + [
                {"id": "xs", "type": "input", "config": {"table": "pleft"}},
                {"id": "xf", "type": "formula", "config": {
                    "formulas": [{"name": "broken", "expr": "missing_col + 1"}]}},
                {"id": "xo", "type": "output", "config": {}}],
            "edges": graph["edges"] + [
                {"from": {"node": "xs", "port": "out"},
                 "to": {"node": "xf", "port": "in"}},
                {"from": {"node": "xf", "port": "out"},
                 "to": {"node": "xo", "port": "in"}}],
        }
        failed = s.run_nodeflows(
            bad, [{"node": "lo"}, {"node": "xo"}],
            query_id="parallel-cleanup")
        need(failed.get("error"), "invalid branch should fail the batch")
        _cols, leftovers = d.execute(
            "SELECT table_name FROM duckdb_tables() "
            "WHERE table_name LIKE '__nbflow_%'")
        need(not leftovers,
             "failed parallel batch left hidden regular tables: %r" % leftovers)
    finally:
        d.branch_cursor = original
        s.shutdown()



def test_one_command_runner_contract():
    root = HERE.parent
    ps = (root / "Test-SamQL-All.ps1").read_text(encoding="utf-8")
    normalized = ps.replace("\\", "/")
    req = (root / "requirements-test.txt").read_text(encoding="utf-8").lower()
    for package in ("duckdb", "pyarrow", "sqlglot", "openpyxl", "orjson",
                    "ijson", "pandas", "pywebview"):
        need(package in req, "test requirements omit %s" % package)
    for fragment in (
        "-m pip install -r",
        "tools/install_frontend_deps.py",
        ".samql-npm-cache",
        "tools/normalize_npm_lock.py",
        "--write $Lock",
        "npx playwright install chromium",
        'tests/run_tests.py", "--build"',
        "tests/test_optimizations_dual_engine.py",
        "tests/test_nodeflow_resources.py",
        "tests/benchmark_workloads.py",
        "npm run test:e2e -- --list",
        "Playwright discovery returned zero tests",
        "PLAYWRIGHT UI TESTS PASSED",
        "npm run test:e2e",
    ):
        need(fragment in normalized, "one-command runner omits: %s" % fragment)
    need("npm audit --audit-level=high" in normalized
         and "Start-Process" in ps
         and '$auditArgs = @("audit", "--audit-level=high")' in ps
         and "RedirectStandardError" in ps,
         "one-command runner must execute the high-severity npm audit through the Windows-safe captured process path")
    need('$mainArgs += "--online"' in ps and "$SkipOnline" in ps,
         "online tests are not enabled by default with an escape hatch")
    need("$SkipBrowser" in ps and "$Clean" in ps,
         "browser/clean bootstrap switches are missing")
    need("$NpmRegistry" in ps and "--registry" in ps,
         "the complete runner must expose an explicit npm-registry override")
    need("ALL SAMQL TESTS PASSED, INCLUDING PLAYWRIGHT" in ps
         and "SAMQL NON-BROWSER TESTS PASSED" in ps,
         "the all-tests runner must distinguish a complete browser pass from an explicit browser skip")

    wrapper = (root / "Run-SamQLTests.ps1").read_text(encoding="utf-8")
    need('$all = Join-Path $Root "Test-SamQL-All.ps1"' in wrapper
         and "if (-not $scopeRequested)" in wrapper
         and "& $all @allArgs" in wrapper
         and "Playwright enabled unless -SkipBrowser" in wrapper,
         "Run-SamQLTests must delegate its default run to the browser-inclusive canonical runner")
    need("Scoped test mode selected; Playwright is not part" in wrapper,
         "partial wrapper runs must state that Playwright was omitted")



def test_npm_integrity_recovery():
    root = HERE.parent
    tool = root / "tools" / "install_frontend_deps.py"
    spec = importlib.util.spec_from_file_location("samql_npm_installer", tool)
    need(spec is not None and spec.loader is not None,
         "could not load npm installer module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    cleaned_env = module._scrub_sandbox_npm_env({
        "npm_config_registry": "https://mirror.example.invalid/npm/",
        "NPM_CONFIG_DEVDIR": "sandbox-only",
        "npm_config_cache": "sandbox-only",
    })
    need(cleaned_env.get("npm_config_registry")
         == "https://mirror.example.invalid/npm/",
         "npm installer discarded the ambient corporate registry")
    need("NPM_CONFIG_DEVDIR" not in cleaned_env
         and "npm_config_cache" not in cleaned_env,
         "npm installer retained sandbox-only npm configuration")

    with tempfile.TemporaryDirectory(prefix="samql_npm_recovery_") as td:
        base = Path(td)
        frontend = base / "frontend"
        cache = base / "cache"
        frontend.mkdir()
        (frontend / "node_modules").mkdir()
        (cache / "content").mkdir(parents=True)

        calls = []
        results = iter([
            module.CommandResult(1, "npm ERR! code EINTEGRITY\nchecksum failed"),
            module.CommandResult(0, "added 297 packages"),
        ])
        cleaned = []

        def runner(command, cwd, env):
            calls.append(list(command))
            return next(results)

        def cleaner(path):
            cleaned.append(Path(path))

        code = module.install_with_recovery(
            frontend=frontend,
            npm="npm",
            cache=cache,
            registry=module.OFFICIAL_REGISTRY,
            allow_public_fallback=True,
            env={},
            runner=runner,
            cleaner=cleaner,
        )
        need(code == 0, "fresh-cache integrity retry did not recover")
        need(len(calls) == 2, "integrity failure must retry ci exactly once")
        need(cache.resolve() in cleaned
             and (frontend / "node_modules").resolve() in cleaned,
             "integrity retry did not discard cache and partial node_modules")
        command_text = " ".join(calls[0])
        need("ci" in calls[0] and "--prefer-online" in calls[0]
             and "--cache" in calls[0]
             and any(a.startswith("--registry=") for a in calls[0])
             and not any(a.startswith("--userconfig=") for a in calls[0])
             and not any(a.startswith("--globalconfig=") for a in calls[0]),
             "npm recovery install is not a locked online cache-isolated ci")
        need("--force" not in command_text
             and "ignore-integrity" not in command_text,
             "npm recovery must never weaken package integrity checks")

        mirror_calls = []
        mirror_results = iter([
            module.CommandResult(0, "https://mirror.example.invalid/npm/"),
            module.CommandResult(1, "EINTEGRITY first mirror payload"),
            module.CommandResult(1, "invalid json response body Unterminated string in JSON"),
            module.CommandResult(0, "public registry success"),
        ])

        def mirror_runner(command, cwd, env):
            mirror_calls.append(list(command))
            return next(mirror_results)

        code = module.install_with_recovery(
            frontend=frontend,
            npm="npm",
            cache=cache,
            registry=None,
            allow_public_fallback=True,
            env={},
            runner=mirror_runner,
            cleaner=lambda _path: None,
        )
        need(code == 0, "corporate-mirror integrity fallback did not recover")
        need(len(mirror_calls) == 4,
             "mirror recovery must read ambient config, retry mirror, then fall back to public")
        need(not any(arg.startswith("--registry=") for arg in mirror_calls[1]),
             "ambient corporate registry must not be replaced on the initial install")
        need(any(arg == "--registry=https://registry.npmjs.org/"
                 for arg in mirror_calls[-1]),
             "final integrity recovery did not use the public registry")

    package = (root / "frontend" / "package.json").read_text(encoding="utf-8")
    lock = (root / "frontend" / "package-lock.json").read_text(encoding="utf-8")
    setup = (root / "frontend" / "src" / "test" / "setup.ts").read_text(encoding="utf-8")
    need('"msw"' not in package and 'node_modules/msw' not in lock
         and 'node_modules/require-directory' not in lock,
         "unused MSW/yargs/require-directory dependency chain remains locked")
    need('from "./server"' not in setup
         and not (root / "frontend" / "src" / "test" / "server.ts").exists(),
         "component tests still initialize the unused MSW server")

def main():
    tests = [
        ("adaptive resource budgets", test_adaptive_budget),
        ("adaptive DuckDB memory ceiling", test_duckdb_adaptive_memory),
        ("persistent NodeFlow intermediates survive restart", test_persistent_restart_cache),
        ("nondeterministic NodeFlow graphs stay session-only", test_persistent_rejects_nondeterministic_graphs),
        ("persistent cache pinning and budget safety", test_persistent_registry_safety),
        ("independent NodeFlow branches execute in parallel", test_parallel_independent_branches),
        ("one-command dependency bootstrap covers every suite", test_one_command_runner_contract),
        ("npm integrity recovery and dependency pruning", test_npm_integrity_recovery),
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as exc:
            failed += 1
            print("FAIL", name, "-", exc)
    print("%d passed, %d failed" % (len(tests) - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
