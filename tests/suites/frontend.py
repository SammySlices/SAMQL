"""Frontend source-contract and toolchain suite."""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile

from harness import eq, need, run, skip
from node_harnesses import (
    _APIPROFILES_HARNESS, _CHART_OPTION_HARNESS, _DOCKING_HARNESS,
    _NODEBOOK_MODEL_HARNESS, _NODEGRAPH_HARNESS, _NOTEBOOK_HARNESS,
    _PROFILE_EXPORT_HARNESS, _RECON_EXPORT_HARNESS,
    _RECON_MAPPING_HARNESS, _SELECT_FIELDS_HARNESS, _SQLFUNCS_HARNESS,
    _SQLPROFILES_HARNESS, _SQL_HARNESS, _TABLECAPS_HARNESS,
)
from paths import BACKEND, FRONTEND, ROOT


def _read_text(path):
    return open(path, encoding="utf-8").read()


def _component_family_source(entry, family):
    """Return a component shell plus every focused module in its family.

    Source-contract tests should follow behavior across an extracted component
    boundary instead of forcing implementation back into one giant file.
    """
    parts = [_read_text(os.path.join(FRONTEND, "src", "components", entry))]
    base = os.path.join(FRONTEND, "src", "components", family)
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            if name.endswith((".ts", ".tsx")) and ".test." not in name:
                parts.append(_read_text(os.path.join(base, name)))
    return "\n".join(parts)


def _load_data_source():
    return _component_family_source("LoadDataModal.tsx", "load")


def _notebook_cell_source():
    return _component_family_source("NotebookCell.tsx", "notebook")


def _root_script(name):
    normal = os.path.join(ROOT, name)
    if os.path.isfile(normal):
        return normal
    stem, ext = os.path.splitext(name)
    return os.path.join(ROOT, stem + "[.]" + ext.lstrip("."))


def _block_css(css, selector):
    match = re.search(r"(?m)^\s*" + re.escape(selector)
                      + r"\s*\{([^}]*)\}", css)
    return match.group(1) if match else ""

def _iter_src_files():
    """Yield production frontend sources.

    Rendered component tests intentionally contain inert fixture buttons and
    local test components, so production wiring/structure audits must not scan
    them as shipped UI. Wave 2 has its own explicit test-file contract below.
    """
    src = os.path.join(FRONTEND, "src")
    for dp, dn, fns in os.walk(src):
        rel_dir = os.path.relpath(dp, src).replace("\\", "/")
        if rel_dir == "test" or rel_dir.startswith("test/"):
            continue
        for fn in fns:
            if ".component.test." in fn:
                continue
            if fn.endswith((".ts", ".tsx", ".css")):
                yield os.path.join(dp, fn)


def frontend_tests(do_build):
    api_ts = os.path.join(FRONTEND, "src", "lib", "api.ts")

    def t_form_fetch_and_recon_hook_order():
        api_src = open(api_ts, encoding="utf-8").read()
        recon_src = open(os.path.join(FRONTEND, "src", "components",
                                      "ReconReport.tsx"), encoding="utf-8").read()
        need("async function formFetch" in api_src,
             "multipart requests share the cancellable request helper")
        for token in (
            'formFetch<LoadResult>("/api/load/files", form)',
            '>("/api/load/files-start", form)',
            'formFetch<{ sheets: string[] }>("/api/excel/peek", fd, { signal })',
            'return formFetch("/api/load/sniff", fd)',
        ):
            need(token in api_src, "multipart call missing shared helper: " + token)
        err = recon_src.index("if (report.error)")
        need(recon_src.index("const runTick = React.useRef", 0, err) >= 0
             and recon_src.index("const lastReport = React.useRef", 0, err) >= 0,
             "ReconReport hooks run before the conditional return")

    def t_security_transport_and_tooling():
        api_src = open(api_ts, encoding="utf-8").read()
        srv = open(os.path.join(BACKEND, "server.py"),
                   encoding="utf-8").read()
        sess = open(os.path.join(BACKEND, "samql_core", "session.py"),
                    encoding="utf-8").read()
        pkg = json.load(open(os.path.join(FRONTEND, "package.json"),
                             encoding="utf-8"))
        need('_api_token_set_cookie' in srv
             and 'X-SamQL-Token' in srv
             and "hmac.compare_digest" in srv
             and "HttpOnly" in srv
             and "samql_api_token" in srv,
             "per-process API capability is enforced via HttpOnly cookie")
        need("SAMQL_JSON_BODY_MB" in srv and "_json_body_cap_bytes" in srv,
             "ordinary JSON requests have a configurable memory ceiling")
        fetch_calls = 0
        for f in _iter_src_files():
            if f.endswith((".ts", ".tsx")):
                fetch_calls += open(f, encoding="utf-8").read().count("fetch(")
        eq(fetch_calls, 1, "all frontend network calls share apiFetch")
        need("getApiToken" in api_src
             and 'headers.set("X-SamQL-Token"' in api_src
             and 'credentials: rest.credentials ?? "same-origin"' in api_src,
             "the shared client attaches credentials and optional Vite token")
        vite = open(os.path.join(FRONTEND, "vite.config.ts"),
                    encoding="utf-8").read()
        need("X-SamQL-Token" in vite
             and "SAMQL_API_TOKEN" in vite
             and "proxyReq" in vite,
             "Vite /api proxy injects X-SamQL-Token when env token is set")
        result_ctrl = open(
            os.path.join(FRONTEND, "src", "controllers",
                         "useResultController.ts"),
            encoding="utf-8").read()
        need("maxRetainedRows" in result_ctrl
             and "12000" in result_ctrl,
             "IDE result paging caps retained rows (sliding window)")
        scripts = pkg.get("scripts") or {}
        need("lint" in scripts and "check" in scripts and "test:e2e" in scripts,
             "lint/check/browser-test scripts are registered")
        for rel in ("eslint.config.js", "playwright.config.ts",
                    os.path.join("e2e", "security-smoke.spec.ts")):
            need(os.path.isfile(os.path.join(FRONTEND, rel)),
                 "missing frontend tooling file: " + rel)
        need("flow_cache_bytes_max" in sess and "_flow_cache_estimate_bytes" in sess,
             "flow cache has a size-aware budget")

    def t_contract():
        import server
        files = [f for f in _iter_src_files() if f.endswith((".ts", ".tsx"))]
        need(files, "no frontend source files found")
        text = "\n".join(open(f, encoding="utf-8").read() for f in files)
        raw = re.findall(r"/api/[A-Za-z0-9_./${}()\-]+", text)
        paths = set()
        for tok in raw:
            p = re.sub(r"\$\{[^}]*\}", "X", tok)
            p = p.split("?")[0].rstrip("/.")
            paths.add(p)
        need(paths, "no /api/ endpoints found in UI source")
        compiled = server._COMPILED
        missing = [p for p in sorted(paths)
                   if not any(rx.match(p) for _m, rx, _f in compiled)]
        need(not missing,
             "UI calls endpoints the backend does not serve: " +
             ", ".join(missing))

    def t_wiring_audit():
        # Full wiring audit, codified so it runs every build: every api.X()
        # call resolves to a real api method; every api method is used (or is a
        # known-legacy exception); every routed handler exists; and every
        # <button> has a handler (drag sources + hover-submenu headers
        # excepted). This guards the recurring "button with no functionality /
        # wrong wiring" class across the IDE, Journal, and NodeFlow.
        import server
        files = [f for f in _iter_src_files() if f.endswith((".ts", ".tsx"))]
        api_src = _read_fe("src", "lib", "api.ts")
        mm = re.search(r"export const api\s*=\s*\{(.*)\n\};", api_src, re.S)
        api_body = mm.group(1) if mm else api_src
        api_methods = set(
            re.findall(r"\n  ([A-Za-z_][A-Za-z0-9_]*)\s*:", api_body))
        need(len(api_methods) > 50, "should have found the api surface (%d)"
             % len(api_methods))

        called = set()
        for f in files:
            # api.ts is scanned too: method *definitions* are `name:` and don't
            # match the api.X(...) call pattern, but helper functions there
            # (e.g. exportResultToFile -> api.exportResult) are real uses whose
            # consumers live elsewhere, so they must count as wired.
            t = open(f, encoding="utf-8").read()
            called |= set(re.findall(
                r"\bapi\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(", t))
            called |= set(re.findall(
                r"\bapi\s*\.\s*\n\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(", t))

        # 1. no api.X() call to a method that doesn't exist
        unknown = sorted(called - api_methods)
        need(not unknown,
             "api.X() called but not defined on api: " + ", ".join(unknown))

        # 2. no NEW dead api method. The known-legacy set is the synchronous /
        # diagnostic surface that the job-based or alternative paths replaced;
        # a method falling out of use should be wired up or added here on
        # purpose, not left to rot silently.
        LEGACY_UNUSED = {
            # the synchronous upload endpoint: the UI uses loadFilesStart
            # (job-based), but /api/load/files is kept + behaviourally tested.
            "loadFiles",
            # /api/load/jobs (reattach list): the activity tray reattaches via
            # /api/tasks now, but the endpoint is kept + behaviourally tested.
            "loadJobs",
            "runTests",        # backend diagnostics; no UI by design
            "secretStatus",    # UI tracks secret_saved on the node config
            # the synchronous in-place flatten: the UI now uses
            # flattenTableStart (job-based -> a cancellable tray card), but
            # /api/table/<t>/flatten is kept + behaviourally tested.
            "flattenJson",
            # .426: async reads are always on; the route survives (clamped,
            # behaviourally tested) but the UI toggle is retired.
            "setConcurrentReads",
            # .473: the field-explorer shred UI was removed by request
            # (flatten-on-load is the supported path now). The routes +
            # api client are kept and behaviourally tested; only the UI
            # entry point is gone.
            "shredPlan",
            "shredRun",
            "shredPreflight",
            # Named connection profiles: the UI lists/upserts/deletes; a single
            # get is kept for reconnect / NodeFlow field hydrate and is covered
            # by the HTTP suite, but no surface calls it yet.
            "connectionProfilesGet",
        }
        dead = sorted(api_methods - called - LEGACY_UNUSED)
        need(not dead, "new dead api method(s) -- wire them up or add to the "
             "known-legacy list with a reason: " + ", ".join(dead))

        # 3. every routed handler resolves to a defined Api method
        handler_names = set(fn.__name__ for _m, _rx, fn in server._COMPILED)
        defined = set(n for n in dir(server.Api) if not n.startswith("__"))
        miss = sorted(handler_names - defined)
        need(not miss, "routes point at undefined handlers: " + ", ".join(miss))

        # 4. every <button> wires a handler (drag sources + hover submenus ok)
        HANDLERS = ("onClick", "onPointerDown", "onMouseDown", "onDragStart")
        dead_btns = []
        for f in files:
            if not f.endswith(".tsx"):
                continue
            t = open(f, encoding="utf-8").read()
            for b in re.finditer(r"<button\b", t):
                i, brace, tag = b.end(), 0, []
                while i < len(t):
                    c = t[i]
                    if c == "{":
                        brace += 1
                    elif c == "}":
                        brace -= 1
                    elif c == ">" and brace == 0:
                        break
                    tag.append(c)
                    i += 1
                tagsrc = "".join(tag)
                if any(h in tagsrc for h in HANDLERS) or "draggable" in tagsrc:
                    continue
                # hover-submenu header: an enclosing element carries the
                # interaction (onMouseEnter/Leave) and the button is its label.
                ctx = t[max(0, b.start() - 240):b.start()]
                if "onMouseEnter" in ctx or "onMouseLeave" in ctx:
                    continue
                dead_btns.append("%s:%d" % (
                    os.path.relpath(f, FRONTEND), t[:b.start()].count("\n") + 1))
        need(not dead_btns,
             "button(s) with no handler wired: " + ", ".join(dead_btns))

    def t_pivot_subtotal_collapse_wiring():
        # Collapsing a pivot row group with subtotals on must show that group's
        # rolled-up subtotal values on the collapsed line (Excel / Tableau
        # "collapse to subtotal"), not a blank row. (Source guard: no live
        # frontend in this harness.)
        pv = _read_fe("src", "components", "PivotPanel.tsx")
        need("isGroupSubtotal" in pv,
             "PivotPanel must detect a group's subtotal row")
        need("isGroupSubtotal(r, supLevel + 1)" in pv,
             "promotion must target the subtotal that totals the collapsed "
             "dimension")
        need("out[repIdx].subtotal = true" in pv,
             "a collapsed group's subtotal row must be promoted to its "
             "representative")
        need('collAt >= 0 && !d.subtotal ? "" : fmtCell(cell)' in pv,
             "a collapsed-subtotal row must render its values, not blanks")

    def t_folder_read_cancel_wiring():
        # The appendfolder/directory reads must pass the run id so the Cancel
        # button can interrupt them, send it to the backend, and treat a
        # cancelled result as cancelled (not an error toast).
        nb = _read_nodebook_source()
        api_src = _read_fe("src", "lib", "api.ts")
        need(re.search(r"api\.folderRead\(\s*folder\s*,\s*id\s*,", nb),
             "doReadFolder must pass the run id to folderRead for cancel")
        need(re.search(r"api\.directoryRead\(\s*path\s*,\s*id\s*,", nb),
             "doReadDirectory must pass the run id to directoryRead")
        need(len(re.findall(r"wasCancelled\(r(?:,\s*(?:id|queryId))?\)", nb)) >= 3,
             "folder + file reads must each handle a cancelled result")
        need(re.search(r"folderRead:.*?query_id", api_src, re.S),
             "folderRead must send query_id to the backend")
        need(re.search(r"directoryRead:.*?query_id", api_src, re.S),
             "directoryRead must send query_id to the backend")
        # iterator + while loops (many statements, can run long) must also pass
        # the run id so Stop can cancel them
        need(re.search(r"iteratorRun\(\{[^}]*query_id:\s*id", nb, re.S),
             "doRunIterator must pass the run id for cancel")
        need(re.search(r"whileRun\(\{[^}]*query_id:\s*id", nb, re.S),
             "doRunWhile must pass the run id for cancel")
        # API node fetch must pass the run id so Stop can abort the fetch
        need(re.search(r"nodeApiFetch\(\s*\{[^}]*query_id:\s*id", nb, re.S),
             "doFetchApi must pass the run id for cancel")
        need(re.search(r"nodeApiFetch:.*?query_id", api_src, re.S),
             "nodeApiFetch must send query_id to the backend")

    def t_no_mojibake():
        bad = []
        for f in _iter_src_files():
            if "\ufffd" in open(f, encoding="utf-8", errors="replace").read():
                bad.append(os.path.relpath(f, FRONTEND))
        need(not bad, "replacement chars (U+FFFD) in: " + ", ".join(bad))

    def t_structure():
        required = [
            "src/main.tsx", "src/App.tsx", "src/styles.css",
            "src/lib/api.ts", "src/lib/types.ts", "src/lib/sql.ts",
            "src/lib/migrations.ts", "src/lib/workflowFile.ts",
            "src/lib/nodeFlowPersistence.ts",
            "src/components/FlowCacheModal.tsx",
            "src/components/StorageMemoryModal.tsx",
            "src/components/SqlEditor.tsx", "src/components/DataGrid.tsx",
            "src/components/Profiler.tsx", "src/components/ChartPanel.tsx",
            "src/components/Sidebar.tsx", "src/components/Modal.tsx",
            "src/components/LoadDataModal.tsx", "src/components/Icon.tsx",
            "e2e/fixtures.ts", "e2e/security-smoke.spec.ts",
            "e2e/workflow-smoke.spec.ts",
            "e2e/dashboard-smoke.spec.ts",
            "e2e/load-query-export.spec.ts",
            "e2e/cancellation-recovery.spec.ts",
            "e2e/eye-care.spec.ts",
            "e2e/nodeflow-dense.spec.ts",
            "e2e/journal-stability.spec.ts",
            "e2e/nodeflow-stability.spec.ts",
            "e2e/persistence-stability.spec.ts",
            "e2e/fixtures/wave1-load.csv",
            "e2e/fixtures/wave1-nested.json",
            "playwright.config.ts", "eslint.config.js",
            "index.html", "package.json", "package-lock.json",
            "vite.config.ts", "tsconfig.json",
        ]
        miss = [r for r in required
                if not os.path.isfile(os.path.join(FRONTEND, r))]
        need(not miss, "missing frontend files: " + ", ".join(miss))
        idx = open(os.path.join(FRONTEND, "index.html"),
                   encoding="utf-8").read()
        need("background: #15171b" in idx
             and "color-scheme" in idx
             and "Inline before any CSS/JS" in idx,
             "index.html paints dark before the JS bundle (no white flash)")
        need(os.path.isfile(os.path.join(ROOT, ".github", "workflows",
                                        "windows-browser.yml")),
             "missing Windows real-browser CI workflow")
        noexport = []
        for f in _iter_src_files():
            if f.endswith(".tsx") and os.path.basename(f) != "main.tsx":
                if "export" not in open(f, encoding="utf-8").read():
                    noexport.append(os.path.relpath(f, FRONTEND))
        need(not noexport, "components without an export: "
             + ", ".join(noexport))

    def _node():
        return shutil.which("node")

    def _frontend_bin(name):
        # Prefer lockfile-pinned tools. On Windows a broken/partial npm ci can
        # leave node_modules/.bin shims missing ("'vite' is not recognized");
        # fall back to invoking the package entry via node.
        names = ([name + ".cmd", name + ".exe", name]
                 if os.name == "nt" else [name])
        for candidate in names:
            path = os.path.join(FRONTEND, "node_modules", ".bin", candidate)
            if os.path.isfile(path):
                return path
        node = shutil.which("node")
        js_entry = {
            "vite": os.path.join("vite", "bin", "vite.js"),
            "vitest": os.path.join("vitest", "vitest.mjs"),
            "tsc": os.path.join("typescript", "bin", "tsc"),
            "eslint": os.path.join("eslint", "bin", "eslint.js"),
        }.get(name)
        if node and js_entry:
            js_path = os.path.join(FRONTEND, "node_modules", js_entry)
            if os.path.isfile(js_path):
                return [node, js_path]
        return None

    def _run_frontend_tool(name, args, label, timeout_seconds):
        executable = _frontend_bin(name)
        if not executable:
            skip("run `npm ci` in frontend/ first (missing %s)" % name)
        if isinstance(executable, list):
            command = [*executable, *args]
        else:
            command = [executable, *args]
        # Do not capture through PIPE: Node worker children can retain an
        # inherited pipe after the parent has printed its final green summary,
        # leaving communicate() blocked forever. A real temporary file provides
        # complete diagnostics without depending on every descendant closing a
        # Python-owned pipe.
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as log:
            creationflags = 0
            popen_kwargs = {}
            if os.name == "nt":
                creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                popen_kwargs["shell"] = True
            else:
                popen_kwargs["start_new_session"] = True
            process = subprocess.Popen(
                command, cwd=FRONTEND, stdout=log,
                stderr=subprocess.STDOUT, text=True,
                creationflags=creationflags, **popen_kwargs,
            )
            try:
                returncode = process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as exc:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        check=False,
                    )
                else:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    process.wait()
                log.flush(); log.seek(0)
                output = log.read().strip()
                raise AssertionError(
                    "%s exceeded the %ss release timeout:\n%s"
                    % (label, timeout_seconds, output[-4000:])
                ) from exc
            log.flush(); log.seek(0)
            output = log.read()
        return subprocess.CompletedProcess(command, returncode, output, "")

    def t_lint():
        if not _node():
            skip("Node not on PATH")
        need(_has_script("lint"), "frontend package has no lint script")
        p = _run_frontend_tool(
            "eslint", ["src/**/*.{ts,tsx}", "--max-warnings", "0"],
            "ESLint", 180,
        )
        if p.returncode != 0:
            raise AssertionError("eslint reported errors or warnings:\n"
                                 + (p.stdout + p.stderr).strip()[:3000])

    def t_maintenance_batch_wiring():
        pkg = json.load(open(os.path.join(FRONTEND, "package.json"),
                             encoding="utf-8"))
        need("--max-warnings 0" in (pkg.get("scripts") or {}).get("lint", ""),
             "lint gate must reject every warning")
        eslint = open(os.path.join(FRONTEND, "eslint.config.js"),
                      encoding="utf-8").read()
        for rule in ("react-hooks/rules-of-hooks",
                     "react-hooks/exhaustive-deps",
                     "@typescript-eslint/no-floating-promises"):
            need(rule in eslint and '"error"' in eslint,
                 "correctness lint rule is not an error: " + rule)
        app = _read_fe("src", "App.tsx")
        api_src = _read_fe("src", "lib", "api.ts")
        storage_mem = _read_fe("src", "components", "StorageMemoryModal.tsx")
        need("StorageMemoryModal" in app
             and "FlowCachePanel" in storage_mem
             and "LoadThresholdsPanel" in storage_mem
             and "EngineTuningPanel" in storage_mem
             and "NodeFlow cache" in storage_mem
             and "Load thresholds" in storage_mem
             and 'data-testid="flow-cache-tab"' in storage_mem
             and 'data-testid="load-thresholds-tab"' in storage_mem
             and 'data-testid="engine-tuning-tab"' in storage_mem
             and 'title="Storage & Engine"' in storage_mem
             and "Storage &amp; Engine" in app
             and 'data-testid="storage-memory-menu"' in app
             and "Engine tuning (memory / threads)" not in app,
             "Storage & Engine must host Engine + Load thresholds + NodeFlow cache tabs")
        need("flowCacheConfigure" in api_src and "flowCacheInfo" in api_src
             and "/api/settings/flow-cache" in api_src
             and "loadThresholdsConfigure" in api_src
             and "loadThresholdsInfo" in api_src
             and "/api/settings/load-thresholds" in api_src,
             "frontend cache/load-threshold settings API is incomplete")
        migrations = _read_fe("src", "lib", "migrations.ts")
        need("runMigrations" in migrations and "pre-migration-backup" in migrations,
             "versioned migrations and local recovery backups are required")
        for rel, marker in (("src/lib/workflowFile.ts", "WF_FILE_VERSION = 2"),
                            ("src/lib/notebook.ts", "NB_FILE_VERSION = 2"),
                            ("src/lib/nodeFlowModel.ts", "NODEFLOW_FILE_VERSION = 3")):
            need(marker in open(os.path.join(FRONTEND, *rel.split("/")),
                                encoding="utf-8").read(),
                 rel + " does not declare the current saved-file version")
        workflow = open(os.path.join(ROOT, ".github", "workflows",
                                     "windows-browser.yml"),
                        encoding="utf-8").read()
        need("runs-on: windows-latest" in workflow
             and "PLAYWRIGHT_BROWSER_CHANNEL: msedge" in workflow
             and "npm run test:e2e" in workflow,
             "Windows CI must exercise the real Edge workflow")
        smoke = open(os.path.join(FRONTEND, "e2e",
                                  "workflow-smoke.spec.ts"),
                     encoding="utf-8").read()
        fixtures = open(os.path.join(FRONTEND, "e2e", "fixtures.ts"),
                        encoding="utf-8").read()
        need("seedStorageBeforeBoot" in fixtures
             and "page.addInitScript" in fixtures
             and "window.localStorage.clear()" in fixtures
             and "window.location.reload()" not in fixtures
             and 'page.goto("/", { waitUntil: "domcontentloaded" })' in fixtures
             and 'page.goto("/api/health"' not in fixtures
             and 'waitForJsonResponse(page, "/api/query", "POST")' in smoke
             and '"/api/settings/flow-cache"' in smoke
             and 'getByTestId("storage-memory-menu")' in smoke
             and 'getByTestId("flow-cache-tab")' in smoke
             and 'getByTestId("ide-sql-editor")' in smoke
             and 'getByTestId("sql-editor").first()' not in smoke
             and 'getByTestId("result-grid")' in smoke,
             "Playwright workflows must seed storage before React, wait for app readiness, and target the visible IDE editor rather than the mounted hidden Journal editor")
        grid_src = _read_fe("src", "components", "DataGrid.tsx")
        sql_editor_src = _read_fe("src", "components", "SqlEditor.tsx")
        notebook_cell_src = _notebook_cell_source()
        need('data-testid="samql-app"' in app
             and 'data-ready={health ? "true" : "false"}' in app
             and 'testId="ide-sql-editor"' in app
             and 'testId="notebook-sql-editor"' in notebook_cell_src
             and 'data-testid={testId}' in sql_editor_src
             and 'data-testid="result-grid"' in grid_src,
             "IDE and Journal editors must expose distinct rendered hooks and the application must publish an API-ready state")
        need('if (h.features?.duckdb && !HAS_SAVED_TARGET)' in app
             and 'setTarget("__duckdb__")' in app,
             "startup must not overwrite a persisted or migrated engine choice")
        scripts = pkg.get("scripts") or {}
        need(scripts.get("test:e2e:edge") ==
             "node ./e2e/run-playwright-edge.mjs"
             and os.path.isfile(os.path.join(FRONTEND, "e2e",
                                             "run-playwright-edge.mjs")),
             "the Edge npm script must actually select the msedge channel")
        all_tests = open(_root_script("Test-SamQL-All.ps1"),
                         encoding="utf-8").read()
        need("RedirectStandardError" in all_tests
             and "Start-Process" in all_tests
             and "samql-npm-audit-err-" in all_tests,
             "Windows PowerShell audit capture must not terminate on registry stderr")
        need('Push-Location (Join-Path $Root "frontend")' in all_tests
             and '$env:SAMQL_TEST_PYTHON = $VenvPython' in all_tests
             and '$env:PLAYWRIGHT_BROWSER_CHANNEL = $chosen' in all_tests
             and '$env:CI = "1"' in all_tests
             and 'npm run test:e2e -- --list' in all_tests
             and 'Playwright discovery returned zero tests' in all_tests
             and 'PLAYWRIGHT UI TESTS PASSED' in all_tests
             and 'npm run test:e2e' in all_tests,
             "Test-SamQL-All must discover and run the Playwright UI suite with the isolated test Python, selected browser, and fresh server")
        wrapper = open(_root_script("Run-SamQLTests.ps1"),
                       encoding="utf-8").read()
        need('$all = Join-Path $Root "Test-SamQL-All.ps1"' in wrapper
             and 'if (-not $scopeRequested)' in wrapper
             and '& $all @allArgs' in wrapper
             and 'Scoped test mode selected; Playwright is not part' in wrapper,
             "Run-SamQLTests must default to the canonical browser-inclusive runner and label scoped runs as partial")

    def t_wave1_stabilization_contract():
        e2e = os.path.join(FRONTEND, "e2e")
        fixture = open(os.path.join(e2e, "fixtures.ts"),
                       encoding="utf-8").read()
        for marker in ('page.on("pageerror"', 'page.on("console"',
                       'page.on("requestfailed"', 'page.on("response"',
                       'response.status() < 500', 'allowRequestFailure'):
            need(marker in fixture,
                 "Wave 1 runtime guard is missing: " + marker)
        need("waitForTimeout" not in fixture,
             "Wave 1 fixtures must wait on state/responses, never timeouts")
        specs = [
            "workflow-smoke.spec.ts", "security-smoke.spec.ts",
            "load-query-export.spec.ts", "cancellation-recovery.spec.ts",
            "journal-stability.spec.ts", "nodeflow-stability.spec.ts",
            "persistence-stability.spec.ts",
        ]
        combined = ""
        for name in specs:
            path = os.path.join(e2e, name)
            need(os.path.isfile(path), "missing Wave 1 E2E spec: " + name)
            src = open(path, encoding="utf-8").read()
            combined += "\n" + src
            need('from "./fixtures"' in src,
                 name + " bypasses the shared runtime guard")
            need("waitForTimeout" not in src,
                 name + " contains a timing sleep instead of a state wait")
        for marker in (
            "/api/load/start", "grid-filter-apply", "export-csv",
            "stop-query", "journal-run-all", "nodeflow-run",
            "samql.session.v1", "page.reload",
        ):
            need(marker in combined, "Wave 1 journey missing: " + marker)
        app = _read_fe("src", "App.tsx")
        load = _load_data_source()
        journal = _read_fe("src", "components", "Notebook.tsx")
        cell = _notebook_cell_source()
        flow = _read_fe("src", "components", "NodeFlow.tsx")
        canvas = _read_fe("src", "components", "NodeFlowCanvas.tsx")
        grid = _read_fe("src", "components", "DataGrid.tsx")
        hooks = app + load + journal + cell + flow + canvas + grid
        for hook in (
            'data-testid="view-ide"', 'data-testid="view-journal"',
            'data-testid="view-nodeflow"', 'data-testid="load-data-menu"',
            'data-testid="load-file-path"', 'data-testid="load-submit"',
            'data-testid="stop-query"', 'data-testid="ide-engine"',
            'data-testid="output-button"', 'data-testid="journal-view"',
            'data-testid="journal-run-all"', 'data-testid="journal-cell"',
            'data-testid="nodeflow-view"', 'data-testid="nodeflow-run"',
            'data-testid="nodeflow-node"', 'data-testid="nodeflow-preview"',
            'data-testid="structured-value-viewer"',
            'data-testid="structured-cell-expand"', 'data-column={c}',
        ):
            need(hook in hooks, "Wave 1 rendered hook missing: " + hook)
        cfg = open(os.path.join(FRONTEND, "playwright.config.ts"),
                   encoding="utf-8").read()
        need("forbidOnly: true" in cfg and "retries: 0" in cfg
             and "workers: 1" in cfg,
             "Playwright stabilization must expose flakes (no retries, serial)")
        load_spec = open(os.path.join(e2e, "load-query-export.spec.ts"),
                         encoding="utf-8").read()
        node_spec = open(os.path.join(e2e, "nodeflow-stability.spec.ts"),
                         encoding="utf-8").read()
        need("flatten: false" in load_spec
             and "structured-cell-expand" in load_spec,
             "the nested-value E2E must explicitly preserve native structs and use the stable viewer hook")
        need("resetBackendAndReload" in node_spec
             and "readJsonOrText" in node_spec
             and "PageTransitionEvent(\"pagehide\")" in node_spec,
             "the NodeFlow E2E must isolate server state, inspect API errors, and exercise lifecycle persistence")
        need("cellFetch={{" in app
             and "activeResultTab.page.result_id" in app,
             "the active IDE grid must wire the full structured-cell endpoint")
        need("persistGraphNow" in flow
             and 'addEventListener("pagehide"' in flow
             and "graphForRun" in flow,
             "NodeFlow must flush lifecycle persistence and run the latest edited graph")

    def t_wave2_component_contract():
        pkg = json.load(open(os.path.join(FRONTEND, "package.json"),
                             encoding="utf-8"))
        scripts = pkg.get("scripts", {})
        dev = pkg.get("devDependencies", {})
        need("vitest.mjs run" in scripts.get("test:component", ""),
             "Wave 2 must expose npm run test:component (node-invoked vitest)")
        for dep in ("vitest", "@testing-library/react",
                    "@testing-library/user-event",
                    "@testing-library/jest-dom", "jsdom"):
            need(dep in dev, "Wave 2 dependency missing: " + dep)
        need("msw" not in dev,
             "unused MSW dependency should not remain in the component-test rail")
        cfg = open(os.path.join(FRONTEND, "vitest.config.ts"),
                   encoding="utf-8").read()
        for marker in ('environment: "jsdom"',
                       'url: "http://localhost/"',
                       '"--no-webstorage"',
                       'setupFiles: ["./src/test/setup.ts"]',
                       'include: ["src/**/*.component.test.{ts,tsx}"]',
                       'pool: "threads"',
                       'maxWorkers: 4',
                       'sequence: { concurrent: false }'):
            need(marker in cfg, "Wave 2 Vitest config missing: " + marker)
        setup = _read_fe("src", "test", "setup.ts")
        need("@testing-library/jest-dom/vitest" in setup
             and "ResizeObserver" in setup
             and 'from "./server"' not in setup,
             "Wave 2 test environment lacks DOM matchers/polyfills or still boots an unused network interceptor")
        files = [
            ("src", "App.component.test.tsx"),
            ("src", "components", "DataGrid.component.test.tsx"),
            ("src", "components", "ServerWatchdog.component.test.tsx"),
            ("src", "components", "Modal.component.test.tsx"),
            ("src", "components", "NotebookCell.component.test.tsx"),
            ("src", "components", "NodeFlowCanvas.component.test.tsx"),
            ("src", "lib", "nodeFlowPersistence.component.test.ts"),
        ]
        combined = ""
        for rel in files:
            path = os.path.join(FRONTEND, *rel)
            need(os.path.isfile(path),
                 "missing Wave 2 component test: " + "/".join(rel))
            src = open(path, encoding="utf-8").read()
            combined += "\n" + src
        for marker in (
            "data-ready", "notebook-sql-editor", "pre-migration-backup",
            "debounces editor persistence", "responses complete out of order",
            "virtualizes a large result", "stale full-value response",
            "two consecutive misses", "traps forward and backward Tab",
            "scoped cancel", "NodeFlow canvas components",
            "updated result id", "NodeFlow persistence",
        ):
            need(marker in combined, "Wave 2 behavior missing: " + marker)
        modal = _read_fe("src", "components", "Modal.tsx")
        grid = _read_fe("src", "components", "DataGrid.tsx")
        watchdog = _read_fe("src", "components", "ServerWatchdog.tsx")
        need('role="dialog"' in modal and 'aria-modal="true"' in modal
             and "previousFocus" in modal and "FOCUSABLE" in modal,
             "Modal source lacks focus containment/restoration")
        need("viewerRequestSeq" in grid
             and "request !== viewerRequestSeq.current" in grid,
             "DataGrid full-value fetch lacks latest-wins protection")
        need("phaseRef" in watchdog and "clearScheduled" in watchdog,
             "watchdog still depends on a re-created phase timer loop")

    def t_wave3_stabilization_contract():
        wave3 = os.path.join(ROOT, "tests", "test_wave3_stabilization.py")
        need(os.path.isfile(wave3), "Wave 3 test module is missing")
        src = open(wave3, encoding="utf-8").read()
        for token in (
            "_real_duckdb_concurrency",
            "_subprocess_crash_restart_manifest",
            "_multipart_malformed_matrix",
            "_stateful_randomized_http",
            "_client_disconnect_download_cleanup",
            "random.Random(0x574)",
        ):
            need(token in src, "Wave 3 rail missing: " + token)
        server_src = open(os.path.join(BACKEND, "server.py"),
                          encoding="utf-8").read()
        stores_src = open(os.path.join(BACKEND, "samql_core", "stores.py"),
                          encoding="utf-8").read()
        need("port = int(httpd.server_address[1])" in server_src,
             "port 0 must report the actual bound port")
        need("multipart field is too large" in server_src
             and "multipart boundary is invalid" in server_src,
             "multipart hardening is not in production source")
        need("def _load_json_container" in stores_src
             and ".corrupt-" in stores_src,
             "persistence corruption quarantine is not in production source")

    def t_component_tests():
        if not _node():
            skip("Node not on PATH")
        p = _run_frontend_tool(
            "vitest", ["run", "--maxWorkers=4", "--reporter=dot"],
            "React component tests", 240,
        )
        if p.returncode != 0:
            raise AssertionError("React component tests failed:\n"
                                 + (p.stdout + p.stderr).strip()[-6000:])
        out = p.stdout + p.stderr
        plain = re.sub(r"\x1b\[[0-9;]*m", "", out)
        m = re.search(r"Tests\s+(\d+) passed", plain)
        release = json.load(open(os.path.join(ROOT, "RELEASE_MANIFEST.json"),
                                 encoding="utf-8"))
        minimum = int((release.get("qualityGates") or {})
                      .get("componentTestsMinimum", 32))
        need(m is not None and int(m.group(1)) >= minimum,
             "component suite executed fewer than the current %d tests: %s"
             % (minimum, m.group(1) if m else "no count"))

    def t_migrations_logic():
        _run_logic("migrations.ts", r"""
import { runMigrations } from "./migrations.mjs";
function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
const result = runMigrations({ value: 7 }, 2, {
  0: (x) => ({ ...x, version: 1, one: true }),
  1: (x) => ({ ...x, version: 2, two: true }),
}, "fixture");
assert(result.migrated && result.fromVersion === 0, "legacy version is reported");
assert(result.value.one && result.value.two && result.value.version === 2, "migrations run sequentially");
let future = false;
try { runMigrations({ version: 3 }, 2, {}, "fixture"); } catch { future = true; }
assert(future, "future versions are rejected");
let stalled = false;
try { runMigrations({ version: 0 }, 1, { 0: (x) => x }, "fixture"); } catch { stalled = true; }
assert(stalled, "a migration that does not advance is rejected");
console.log("OK");
""", "migrations.ts")

    def t_typecheck():
        if not _node():
            skip("Node not on PATH")
        args = ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"]
        p = _run_frontend_tool("tsc", args, "TypeScript", 180)
        out = (p.stdout + p.stderr).strip()
        if p.returncode != 0 and not out:
            # Incremental metadata can replay a cached failure as a silent exit.
            # Remove it and force one complete diagnostic pass.
            for bi in ("tsconfig.tsbuildinfo",
                       os.path.join("node_modules", ".tmp",
                                    "tsconfig.tsbuildinfo")):
                try:
                    os.unlink(os.path.join(FRONTEND, bi))
                except OSError:
                    pass
            p = _run_frontend_tool("tsc", args, "TypeScript", 180)
            out = (p.stdout + p.stderr).strip()
        if p.returncode != 0:
            raise AssertionError("tsc reported type errors:\n"
                                 + (out or "(no output)")[-4000:])

    def t_build():
        if not do_build:
            skip("run with --build to test the production build")
        if not _node():
            skip("Node not on PATH")
        p = _run_frontend_tool("vite", ["build"], "Vite production build", 240)
        if p.returncode != 0:
            raise AssertionError("vite build failed:\n"
                                 + (p.stdout + p.stderr).strip()[-4000:])
        need(os.path.isdir(os.path.join(FRONTEND, "dist")), "no dist/")

    def _read_nodebook_source():
        # NodeFlow is intentionally split into the state/orchestration component,
        # a pure model/geometry module, and memoized canvas primitives. Source
        # contract checks read the logical subsystem rather than assuming every
        # identifier still lives in one 10k-line file.
        return "\n".join((
            _component_family_source("NodeFlow.tsx", "nodeflow"),
            _read_text(os.path.join(FRONTEND, "src", "components", "NodeFlowCanvas.tsx")),
            _read_text(os.path.join(FRONTEND, "src", "lib", "nodeFlowModel.ts")),
        ))

    def _read_fe(*parts):
        if tuple(parts) == ("src", "components", "NodeFlow.tsx"):
            return _read_nodebook_source()
        return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()

    def t_tree_field_collapse_and_search():
        # The nested field tree gains collapsible struct nodes, and the table
        # filter searches nested field names (which live in the column's type
        # string) -- auto-opening the matching column so the hit is visible.
        sb = _read_fe("src", "components", "Sidebar.tsx")
        checks = [
            ("field-tree structs default collapsed; (element) defaults open",
             "openFields" in sb and "closedEls" in sb
             and "!openFields.has(nid)" in sb
             and "closedEls.has(nid)" in sb),
            ("collapse hides the subtree under a collapsed node",
             "skipDeeper" in sb),
            ("collapse is ignored while filtering so matches stay visible",
             "!filtering &&" in sb),
            ("struct/list rows with children get an expand caret",
             "hasKids" in sb),
            ("the filter matches nested field names via the type string",
             '(c.type || "").toLowerCase().includes(needle)' in sb),
            ("field search auto-opens the matching nested column",
             "openColFields" in sb and "typeHit" in sb),
            ("matching field rows are highlighted",
             "rgba(255,213,74,0.16)" in sb),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "tree collapse / field search broken: " + "; ".join(missing))

    def t_journal_export_csv():
        # Settings -> Export journal (CSV): every cell with its SQL and, from the
        # dependency graph, which cells it uses / feeds.
        app = _read_fe("src", "App.tsx")
        workspace = _read_fe(
            "src", "controllers", "useWorkspaceController.ts")
        nb = _read_fe("src", "components", "Notebook.tsx")
        checks = [
            ("Settings has an Export journal button gated to the Journal view",
             'action: "exportGraph"' in app
             and "Export journal (CSV)" in app
             and 'view === "notebook"' in app),
            ("journalCmd carries the exportGraph action",
             '"save" | "saveAs" | "open" | "exportGraph"' in workspace
             and "setJournalCmd" in app),
            ("Notebook handles the exportGraph command",
             'command.action === "exportGraph"' in nb
             and "exportGraph()" in nb),
            ("export delegates to the lib CSV builder (columns/quoting/BOM "
             "are node-harness cases now)",
             "journalGraphCsv(" in nb),
            ("uses/feeds come from the dependency graph",
             "g.depNames[c.id]" in nb and "g.dependentNames[c.id]" in nb),
            ("export writes the CSV server-side into Downloads (.539)",
             "saveToDownloads(`${base}.csv`" in nb),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "journal CSV export broken: " + "; ".join(missing))

    def t_journal_groups():
        import re as _re
        # Journal groups (sections): a group model + horizontal layout, group
        # add/rename/delete, per-group add-cell toolbar with New Group, and
        # cells ordered by group so run order matches the left-to-right layout.
        nbt = _read_fe("src", "lib", "notebook.ts")
        nb = _read_fe("src", "components", "Notebook.tsx")
        cell = _notebook_cell_source()
        css = _read_fe("src", "styles.css")
        checks = [
            ("NbGroupDef + sidecar persistence in the store",
             "interface NbGroupDef" in nbt
             and "export function loadGroups" in nbt
             and "export function saveGroups" in nbt),
            ("cells carry a group id (def + RunCell + slimCell)",
             "group?: string" in nbt and "group?: string" in cell
             and "group: c.group" in nbt),
            ("groups state + add / rename / delete ops",
             "const [groups, setGroups]" in nb
             and "const addGroup" in nb
             and "const renameGroup" in nb
             and "const deleteGroup" in nb),
            ("addCell targets a group; array stays grouped/ordered",
             "reorderByGroups" in nb
             and 'addCell("sql", g.id)' in nb),
            ("cells bucketed by group for the columnar layout",
             "const grouped" in nb and "groupOf" in nb),
            ("horizontal group columns render with a rename header + delete X",
             'className="nb-groups"' in nb
             and 'className="nb-group-name"' in nb
             and "deleteGroup(g.id)" in nb),
            ("New Group lives in the top toolbar (per-group bar removed)",
             "nb-group-tools" not in nb
             and "New Group" in nb.split("<Icon.Redo")[1][:600]
             and "onClick={addGroup}" in nb),
            ("groups can collapse to a slim header-only column",
             "toggleGroupCollapse" in nb
             and "collapsed?: boolean" in nbt
             and _re.search(r"!g\.collapsed\s*&&", nb) is not None
             and 'data-collapsed="1"' in css),
            ("group layout CSS exists",
             ".nb-groups {" in css and ".nb-group {" in css),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "journal groups broken: " + "; ".join(missing))

    def t_journal_group_output():
        # Phase 2: a later group references an earlier group's final output by
        # the group name; groups also travel through file save/open.
        nbt = _read_fe("src", "lib", "notebook.ts")
        nb = _read_fe("src", "components", "Notebook.tsx")
        checks = [
            ("chain-name detection also matches a quoted (spaced) name",
             'const quoted = new RegExp(`"${escapeRe(n)}"`, "i")' in nbt),
            ("earlierList appends an output alias for each earlier group",
             "lastByGroup" in nb and "earlier groups only" in nb),
            ("group aliases don't shadow a real cell name",
             "cellNames.has(nm.toLowerCase())" in nb),
            ("compiled SQL recomputes on a group rename",
             "groupSig" in nb),
            ("file save carries the groups; open restores them",
             "serializeNotebook(cellsRef.current as NbCellDef[], groupsRef.current)"
             in nb
             and "parseNotebookGroups(doc)" in nb
             and "saveGroups(meta.id, openGroups)" in nb),
            ("the notebook file format includes an optional groups list",
             "groups?: NbGroupDef[]" in nbt
             and "export function parseNotebookGroups" in nbt),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "journal group output broken: " + "; ".join(missing))

    def t_field_explorer_panel():
        # Floating, draggable field-access explorer: persists across the IDE /
        # Journal / Node views (rendered at the App root, outside the view
        # switch), source dropdown of nested columns, field list, and a right
        # pane assembling the access queries from the backend recipes.
        fx = _read_fe("src", "components", "FieldExplorer.tsx")
        app = _read_fe("src", "App.tsx")
        tools = _read_fe("src", "components", "ToolsTablesPanel.tsx")
        api_src = _read_fe("src", "lib", "api.ts")
        css = _read_fe("src", "styles.css")
        checks = [
            ("panel closes on Esc anywhere while open (not when minimized)",
             '"Escape"' in fx and "onClose()" in fx and "!minimized" in fx),
            ("panel is draggable via its header (the shared hook)",
             "useWinDrag" in fx
             and "onMouseDown={startDrag}" in fx
             and bool(__import__("re").search(
                 r"\.fx-panel \{[^}]*position: fixed", css))),
            ("panel title / aria use JSON Field Explorer",
             'aria-label="JSON Field Explorer"' in fx
             and "JSON Field Explorer" in fx),
            ("minimize collapses to a clickable icon and expands again",
             "field-explorer-minimize" in fx
             and "field-explorer-mini" in fx
             and "SquareMinus" in fx
             and "FIELD_EXPLORER_STORE_KEY" in fx),
            ("source dropdown is one entry per nested table (not table › column)",
             "c.hint" in fx
             and "Pick a table" in fx
             and "label: t.name" in fx
             and " › " not in fx
             and "Pick a JSON source" not in fx),
            ("field list fetches the table field tree via tableFields",
             "api" in fx
             and "tableFields(" in fx
             and "columnFields(" not in fx),
            ("closing Field Explorer cancels in-flight nested discovery",
             "stopDiscovery" in fx
             and "cancelQuery" in fx
             and "openRef" in fx
             and "next_after" in fx
             and "[srcKey, open]" in fx),
            ("right pane assembles first / all-rows / recursive queries",
             ("Peek one value" in fx or "First record" in fx)
             and "All rows" in fx
             and "recursive" in fx
             and ("formatFieldSql" in fx or "acc.unnests" in fx)
             and "buildUnnestPipelineSql" in fx),
            ("copy buttons use the shared copyText helper",
             "copyText" in fx),
            ("App renders it OUTSIDE the view switch so it persists",
             "<FieldExplorer" in app
             and "fieldExplorerOpen" in app),
            ("Tools & Tables hosts JSON Field Explorer entry (not Settings)",
             "onOpenJsonFieldExplorer" in app
             and "JSON Field Explorer" in tools
             and "tools-tables-tab-fields" in tools
             and "Field explorer…" not in app),
            ("command palette opens JSON Field Explorer (not view-gated)",
             "Open JSON Field Explorer" in app),
            ("api type carries the access recipe",
             "recursive?: string" in api_src and "unnests?: string[]"
             in api_src),
            ("minimize has a component test",
             os.path.isfile(os.path.join(
                 FRONTEND, "src", "components",
                 "FieldExplorer.component.test.tsx"))),
            ("Flatten opens Unique Identifier picker before Confirm",
             "FlattenUidModal" in fx
             and os.path.isfile(os.path.join(
                 FRONTEND, "src", "components", "FlattenUidModal.tsx"))
             and "tableRootIdOptions" in api_src
             and "tableRootIdStats" in api_src
             and "flattenTableStart" in app
             and "rootId" in app),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "field explorer broken: " + "; ".join(missing))

    def t_chain_reuse_wiring():
        # R1 wiring: the Journal composes a reduced transport SQL + reuse map,
        # keeps the CANONICAL compiled SQL as the staleness key, retries once
        # on reuse_stale, and the server plumbs reuse through to run_query.
        nb = _read_fe("src", "components", "Notebook.tsx")
        api_src = _read_fe("src", "lib", "api.ts")
        srv = open(os.path.join(ROOT, "backend", "server.py"),
                   encoding="utf-8").read()
        sess = open(os.path.join(ROOT, "backend", "samql_core", "session.py"),
                    encoding="utf-8").read()
        checks = [
            ("composeForRun delegates to the lib (planChainReuse, tested "
             "behaviorally in the node harness)",
             "const composeForRun" in nb and "planChainReuse(" in nb
             and "lastSqlCellByGroup(" in nb),
            ("freshness delegates to the lib predicate (capped-never-fresh "
             "is a harness case now)",
             "cellIsFresh(" in nb and "result_capped" in nb),
            ("staleness key stays the canonical composition",
             "ranCompiledSql: composed" in nb),
            ("one retry on reuse_stale with full inlining",
             "reuse_stale" in nb),
            ("api.query carries the reuse map",
             "reuse?: Record<string, string>" in api_src),
            # (handler passthrough is an AST check now:
            #  t_handler_ast_passthroughs)
            ("run_query gates reuse to duckdb and cleans up views",
             (lambda S, i: "reuse" in i.signature(S.run_query).parameters
              and all(t in i.getsource(S._run_query_inner) for t in
                      ("reuse_stale", "_setup_reuse_views", "reuse_cleanup"))
              )(__import__("samql_core.session",
                           fromlist=["Session"]).Session,
                __import__("inspect"))),
            ("Storage & Engine hosts live engine tuning (memory / threads)",
             "EngineTuningPanel" in
             _read_fe("src", "components", "StorageMemoryModal.tsx")
             and 'data-testid="engine-tuning-tab"' in
             _read_fe("src", "components", "StorageMemoryModal.tsx")
             and "engineTuning:" in api_src
             and "/api/engine/tuning" in srv
             and "Engine tuning (memory / threads)" not in
             _read_fe("src", "App.tsx")),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "chain reuse wiring broken: " + "; ".join(missing))

    def t_modal_cancel_close_consolidated():
        # A window modal's Cancel button and its close-X share ONE cancel
        # function -- no duplicated cancel call site. The only split was the
        # Flatten tab (its own cancelFlatten vs an inline cancelRef arrow);
        # they now both use cancelFlatten, and the X / Esc / backdrop route
        # through it too. (Other modals already send Cancel + close-X to one
        # onClose; the load-progress window's X + Cancel already call one
        # cancel().)
        modal = _load_data_source()
        need("if (cancelRef) cancelRef.current = cancelFlatten;" in modal,
             "Flatten tab registers cancelFlatten as the single window cancel")
        need("onClick={cancelFlatten}" in modal,
             "the in-tab Cancel button calls the same cancelFlatten")
        need(modal.count("api.flattenCancel(") == 1,
             "flattenCancel must have a single call site (no Cancel-vs-X "
             "duplication), found %d" % modal.count("api.flattenCancel("))

    def t_runall_no_output_is_soft_warning():
        # Run all with no CONNECTED output node must NOT raise a red error -- it
        # runs the chain so the user can preview through the output arrows, and
        # nudges with a yellow "Output node not connected" warning. The
        # unconnected Output node is flagged yellow (a warn class), never red.
        nb = _read_fe("src", "components", "NodeFlow.tsx")
        css = _read_fe("src", "styles.css")
        # a distinct soft-warning channel separate from the red nodeErrors
        need("nodeWarnings" in nb, "NodeFlow has a nodeWarnings (yellow) state")
        # the node className picks the yellow 'warn' class when warned but not
        # errored (red still wins if a node genuinely failed)
        need(
            re.search(r'nodeErrors\[n\.id\]\s*\?\s*" err"\s*:\s*'
                      r'nodeWarnings\[n\.id\]\s*\?\s*" warn"', nb)
            or 'error ? " err" : warning ? " warn"' in nb,
            "node uses err (red) over warn (yellow), warn when only warned")
        need(".nb2-node.warn" in css, "a yellow .nb2-node.warn CSS rule exists")
        # .468: the nudge is the yellow BADGE on the node -- the warn
        # TOAST is retired at the user's request. The badge string
        # stays; the run-all body must not toast about it, and a clean
        # run with a dangling output ends in a plain OK toast.
        need('"Output node not connected"' in nb,
             "the yellow badge names the dangling output")
        ra = nb[nb.index("const runAll = async"):]
        ra = ra[:ra.index("const doCreateTable")]
        need("output(s) not connected" not in ra,
             "run-all summaries no longer count dangling outputs")
        need(not re.search(
                 r'onToast\([^)]*"Output node not connected"', ra),
             "no toast carries the output nudge -- badge only")
        need('onToast("ok", "Run all finished"' in ra,
             "a clean run (dangling output or not) ends in OK")
        need('onToast("error", "Run all finished"' in ra,
             "a real node failure still surfaces as a red error")

    def t_cancel_recovery_no_refresh():
        # A stalled cancel used to strand the NodeFlow on "Cancelling…" until a
        # manual page refresh. Stop now recovers the UI itself after a grace
        # period (forceRecoverFromCancel), guarded so it only fires while still
        # stuck on the SAME run; and a late straggler result is absorbed by
        # finishRun's runDepth===0 guard so it can't desync a fresh run.
        nb = _read_fe("src", "components", "NodeFlow.tsx")
        need("forceRecoverFromCancel" in nb,
             "NodeFlow has a force-recover path for a stalled cancel")
        # cancelRun schedules the recovery on a timer, guarded by the run id
        cr = nb[nb.index("const cancelRun = async"):]
        cr = cr[:cr.index("const wasCancelled")]
        need("setTimeout" in cr and "forceRecoverFromCancel()" in cr,
             "cancelRun schedules a grace-timeout recovery")
        need("runIdRef.current === stuckId" in cr,
             "recovery only fires if still stuck on the same run")
        # finishRun no-ops (absorbs the straggler) when no run is active
        fr = nb[nb.index("const finishRun = ("):]
        fr = fr[:fr.index("const forceRecoverFromCancel")]
        need(re.search(r"if\s*\(\s*runDepth\.current\s*===\s*0\s*\)\s*\{", fr),
             "finishRun no-ops when no run is active (absorbs stragglers)")
        # the recovery resets the run state so the UI becomes usable again
        fc = nb[nb.index("const forceRecoverFromCancel"):]
        fc = fc[:fc.index("const cancelRun = async")]
        need("runDepth.current = 0" in fc and "setRunning(false)" in fc,
             "force-recover resets run depth and clears the running state")

    def t_node_palette_coverage():
        # Every node the palette offers must be reachable from a category AND
        # have a config (inspector) panel; and the only node types that exist
        # but aren't in the palette are the intentionally-hidden back-compat
        # ones (fill, antijoin). Catches "added a node but forgot to wire it in"
        # (or removed it from the palette without hiding it properly).
        nb = _read_nodebook_source()
        palette_block = re.search(
            r"export const NODE_PALETTE_ORDER: NodeType\[\] = \[(.*?)\];",
            nb, re.S,
        )
        palette = list(dict.fromkeys(
            re.findall(r'"([a-z]+)"', palette_block.group(1))
            if palette_block else []
        ))
        groups = set()
        for arr in re.findall(r"types:\s*\[([^\]]*)\]", nb):
            groups |= set(re.findall(r'"([a-z]+)"', arr))
        insp = set(re.findall(r'(?:sel\.type|inspectorType) === "([a-z]+)"', nb))
        m = re.search(r"type NodeType =([^;]*);", nb)
        union = set(re.findall(r'"([a-z]+)"', m.group(1))) if m else set()
        HIDDEN = {"fill", "antijoin"}  # kept for old flows, off the palette
        # Instantiated from Created Nodes only (not a blank palette tile).
        CREATED_ONLY = {"usernode"}

        need(len(palette) > 30, "palette has the full node set (got %d)" % len(palette))
        miss_group = sorted(set(palette) - groups)
        need(not miss_group, "palette nodes missing from a category: " + ", ".join(miss_group))
        extra_group = sorted(groups - set(palette))
        need(not extra_group, "category lists a node not in the palette: " + ", ".join(extra_group))
        miss_insp = sorted(set(palette) - insp)
        need(not miss_insp, "palette nodes with no config panel: " + ", ".join(miss_insp))
        # hidden types still resolve (type present, inspector present) but are
        # NOT offered in the palette/categories
        for h in HIDDEN:
            need(h in union, "hidden type %s still declared in NodeType" % h)
            need(h not in set(palette), "hidden type %s must stay off the palette" % h)
            need(h not in groups, "hidden type %s must stay out of categories" % h)
        for c in CREATED_ONLY:
            need(c in union, "created-only type %s still declared in NodeType" % c)
            need(c not in set(palette), "created-only type %s must stay off NODE_PALETTE_ORDER" % c)
            need(c not in groups, "created-only type %s must stay out of NODE_GROUPS" % c)
            need(c in insp, "created-only type %s needs an inspector panel" % c)
        unexpected = sorted(union - set(palette) - HIDDEN - CREATED_ONLY)
        need(not unexpected, "node types neither in palette nor known-hidden: " + ", ".join(unexpected))

    def t_created_nodes_wiring():
        # Save / export / load Created Nodes, plus port-count + run path.
        app = _read_fe("src", "App.tsx")
        created = _read_fe("src", "lib", "createdNodes.ts")
        modals = _read_fe("src", "components", "CreatedNodeModals.tsx")
        palette = _read_fe("src", "components", "nodeflow", "NodeFlowPalette.tsx")
        model = _read_fe("src", "lib", "nodeFlowModel.ts")
        nf = open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                  encoding="utf-8").read()
        be = open(os.path.join(ROOT, "tests", "suites", "backend.py"),
                  encoding="utf-8").read()
        checks = [
            ("Settings offers Create / Created Nodes; Export / Load live in manage modal",
             (lambda settings, manage: (
                 "useCreatedNodesSettings" in app
                 and "Create a node…" in settings
                 and "Created Nodes…" in settings
                 and "ManageCreatedNodesModal" in settings
                 and "Save node" not in settings
                 and "save-node-menu" not in settings
                 and "Export created node…" not in settings
                 and "Load created node…" not in settings
                 and "CreateCreatedNodeModal" in settings
                 and "manage-created-nodes-export" in manage
                 and "manage-created-nodes-load" in manage
                 and "ExportCreatedNodeModal" in manage
                 and "LoadCreatedNodeModal" in manage
             ))(open(os.path.join(FRONTEND, "src", "components",
                                  "CreatedNodesSettings.tsx"),
                     encoding="utf-8").read(),
                modals)),
            ("workspace Save upserts Created Node when editingDefinitionId is set",
             "editingDefinitionId" in open(
                 os.path.join(FRONTEND, "src", "components", "nodeflow",
                              "useNodeFlowDocumentController.ts"),
                 encoding="utf-8").read()
             and "updateCreatedNodeDefinition" in open(
                 os.path.join(FRONTEND, "src", "components", "nodeflow",
                              "useNodeFlowDocumentController.ts"),
                 encoding="utf-8").read()),
            ("create/export/load/update helpers persist and round-trip a file",
             "upsertCreatedNode" in created
             and "updateCreatedNodeDefinition" in created
             and "applyCreatedNodeToGraph" in created
             and "renameCreatedNode" in created
             and "stripCreatedNodeFromGraph" in created
             and "samql-created-node-deleted" in created
             and "serializeCreatedNodeFile" in created
             and "parseCreatedNodeFile" in created
             and 'CREATED_NODE_FILE_FORMAT = "samql-created-node"' in created),
            ("modals call save + export + load helpers",
             "buildCreatedNodeDefinition" in modals
             and "serializeCreatedNodeFile" in modals
             and "parseCreatedNodeFile" in modals
             and "upsertCreatedNode" in modals
             and "ManageCreatedNodesModal" in modals
             and "renameCreatedNode" in modals
             and "removeCreatedNode" in modals
             and "saveToDownloads(" in modals
             and "URL.createObjectURL" not in modals),
            ("Open Node context menu opens a definition tab",
             (lambda menus, nf: (
                 "Open Node" in menus
                 and "onOpenCreatedNode" in menus
                 and "openCreatedNode" in nf
                 and "openGraphInNewTab" in nf
                 and "editingDefinitionId" in nf
                 and "samql-created-node-deleted" in nf
                 and "stripUsernodesByDefinitionId" in nf
             ))(open(os.path.join(FRONTEND, "src", "components", "nodeflow",
                                  "NodeFlowMenus.tsx"),
                     encoding="utf-8").read(),
                open(os.path.join(FRONTEND, "src", "components", "NodeFlow.tsx"),
                     encoding="utf-8").read())),
            ("palette lists Created Nodes from the catalog",
             "Created Nodes" in palette
             and ("application/x-nb-created-node" in palette
                  or "NB_CREATED_NODE_MIME" in palette)
             and "loadCreatedNodes" in palette),
            ("usernode arrow count follows inputCount/outputCount",
             "function portsOf" in model
             and "inputCount" in model
             and "outputCount" in model),
            ("backend expands and the suite runs created nodes",
             "def _expand_usernode" in nf
             and "def t_usernode_run" in be
             and "def t_usernode_multi_input_run" in be
             and "def t_usernode_saved_port_refresh_run" in be),
            ("component tests cover save/export/load/open/save + port arrows",
             os.path.isfile(os.path.join(
                 FRONTEND, "src", "lib", "createdNodes.component.test.ts"))
             and os.path.isfile(os.path.join(
                 FRONTEND, "src", "lib",
                 "CreatedNodeFlows.component.test.tsx"))
             and os.path.isfile(os.path.join(
                 FRONTEND, "src", "lib",
                 "CreatedNodeOpenSave.component.test.tsx"))
             and os.path.isfile(os.path.join(
                 FRONTEND, "src", "lib",
                 "CreatedNodeManage.component.test.tsx"))),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "created-nodes wiring broken: " + "; ".join(missing))

    def t_ide_surface():
        # The IDE view's editing surface is wired: Run all / Run statement with
        # their shortcuts, multi-tab editing (add / close), engine target +
        # read-only, query cancel, and the results height the layout persists.
        app = _read_fe("src", "App.tsx")
        ed = _read_fe("src", "components", "SqlEditor.tsx")
        checks = [
            ("Run all / selection is wired with its shortcut",
             "runAll" in app and "Run all / selection (Ctrl/Cmd+Enter)" in app),
            ("Run current statement is wired with its shortcut",
             "runStatement" in app
             and "the statement at the cursor (F5)" in app),
            ("multi-tab editing (open + close tabs)",
             "edTabs" in app and "closeTab" in app),
            ("engine target + read-only toggle",
             ("setReadOnly" in app or "setReadOnly" in
              _read_fe("src", "controllers", "useIdeController.ts"))
             and ("target" in app or "engineTarget" in
                  _read_fe("src", "controllers", "useIdeController.ts")
                  or "setTarget" in
                  _read_fe("src", "controllers", "useIdeController.ts"))),
            ("SQL dialect selector (native/spark) wired",
             "setDialect" in app and '"spark"' in app
             and "dialect" in app),
            ("query cancellation", "cancelQuery" in app or "cancelOne" in app),
            ("can switch among the views", "switchView" in app),
            ("Dashboard view toggle is wired", 'data-testid="view-dashboard"' in app),
            ("SqlEditor consumes the schema for autocomplete",
             "tables" in ed),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "IDE surface broken: " + "; ".join(missing))

    def t_journal_surface():
        # The Journal view offers all five cell kinds, can run the whole sheet,
        # and reuses the editor/grid/chart/pivot building blocks.
        nb = _read_fe("src", "components", "Notebook.tsx")
        nbc = _notebook_cell_source()
        cell_kinds = set(re.findall(r'onAddBelow\("([a-z]+)"\)', nbc))
        for k in ["sql", "note", "chart", "pivot", "reconcile"]:
            need(k in cell_kinds, "Journal can add a %s cell" % k)
        need("runAll" in nb and "Run all" in nb, "Journal runs the whole sheet")
        need("ChartPanel" in nbc and "PivotPanel" in nbc,
             "Journal cells reuse the chart + pivot panels")
        need("DataGrid" in nbc, "Journal SQL cells render through the data grid")
        # engine selector — the Journal lets you pick the engine like the IDE,
        # bound to the same shared target, with the DuckDB option gated on the
        # duckdb feature flag (SQLite always available).
        need("onTargetChange" in nb and "value={target}" in nb,
             "Journal has an engine selector bound to the shared target")
        need('"__local__"' in nb and '"__duckdb__"' in nb
             and "features?.duckdb" in nb,
             "Journal engine selector offers SQLite and a gated DuckDB option")
        need("onDialectChange" in nb and '"spark"' in nb
             and "dialect" in nb,
             "Journal has the SQL dialect selector (native/spark)")
        # The Journal chart panel offers every chart type the node chart does
        # (incl. the ones added recently) and can change colours / styling.
        cp = _read_fe("src", "components", "ChartPanel.tsx")
        for t in ["bar", "line", "area", "pie", "donut", "scatter",
                  "histogram", "treemap", "candlestick", "multix"]:
            need('"%s"' % t in cp, "Journal chart offers %s" % t)
        # candlestick + multiple-x field pickers are wired into the spec
        need("open: isCandle" in cp and "close: isCandle" in cp,
             "Journal candlestick sends OHLC columns")
        need("x2: isMultiX" in cp and "y2: isMultiX" in cp,
             "Journal multiple-x sends the second (x2, y2) series")
        # colour / style panel: palette, per-element colour pickers, applied
        need('type="color"' in cp and "patchColor" in cp,
             "Journal chart has per-element colour pickers")
        need("PALETTE_NAMES" in cp and "patchStyle" in cp,
             "Journal chart has a palette + style controls")
        need("seriesColors" in cp, "Journal colour overrides feed ChartStyle")
        need("styledData" in cp and "style: Object.keys(style)" in cp,
             "Journal attaches the chosen style to the chart data")
        # Cancel parity with the IDE: chart/pivot panels own Stop; reconcile
        # cells wire onCancel; failures CSV registers on the shared run rail.
        pp = _read_fe("src", "components", "PivotPanel.tsx")
        recon = _read_fe("src", "components", "notebook",
                         "ReconcileNotebookCell.tsx")
        api_src = _read_fe("src", "lib", "api.ts")
        need('data-testid="chart-stop"' in cp and "registerRun(qid, ctrl)" in cp,
             "Journal chart cells use ChartPanel Stop + registerRun")
        need('data-testid="pivot-stop"' in pp and "registerRun(qid, ctrl)" in pp,
             "Journal pivot cells use PivotPanel Stop + registerRun")
        need('cell.reconRunning ? props.onCancel : props.onRunReconcile' in recon
             and "■ Stop" in recon,
             "Journal reconcile cell Stop calls onCancel")
        need("registerRun(exportId, ctrl)" in api_src
             and "reconFailuresCsv:" in api_src,
             "reconcile failures CSV export registers for Activity cancel")
        need(os.path.isfile(os.path.join(
                 FRONTEND, "src", "components",
                 "JournalCancel.component.test.tsx")),
             "Journal cancel has a component test")
        need("Downloads" in _read_fe("src", "components", "DocsModal.tsx")
             and "Stop" in _read_fe("src", "components", "DocsModal.tsx"),
             "Journal docs mention Downloads exports + Stop cancel")

    def _has_script(name):
        try:
            pkg = json.load(open(os.path.join(FRONTEND, "package.json")))
            return name in (pkg.get("scripts") or {})
        except Exception:
            return False

    def _find_esbuild():
        # esbuild ships as a binary; after `npm install` it lands in the
        # frontend's node_modules/.bin (it is a dependency of Vite). Fall back
        # to one on PATH, or to a globally-installed copy located via
        # `npm root -g` (HOME-independent), so the logic test can run without a
        # full project install too.
        names = ["esbuild.cmd", "esbuild.exe"] if os.name == "nt" \
            else ["esbuild"]
        cand = [os.path.join(FRONTEND, "node_modules", ".bin", n)
                for n in names]
        w = shutil.which("esbuild")
        if w:
            cand.append(w)
        from glob import glob
        roots = []
        try:
            r = subprocess.run(["npm", "root", "-g"], capture_output=True,
                               text=True, shell=(os.name == "nt"), timeout=20)
            if r.returncode == 0 and r.stdout.strip():
                roots.append(r.stdout.strip())
        except Exception:
            pass
        for root in roots:
            for n in names:
                cand += glob(os.path.join(root, "**", ".bin", n),
                             recursive=True)
        for c in cand:
            if c and os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        return None

    def _run_logic(rel_module, harness, label):
        # Transpile a pure lib module (rel_module under src/lib) with esbuild and
        # run a Node harness that imports it and asserts (prints OK on success).
        # Skips cleanly when Node/esbuild aren't available in the sandbox.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        base = os.path.splitext(os.path.basename(rel_module))[0]
        src = os.path.join(FRONTEND, "src", "lib", rel_module)
        tmp = tempfile.mkdtemp(prefix="samql-" + base + "-")
        try:
            mjs = os.path.join(tmp, base + ".mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on %s:\n%s"
                                     % (rel_module,
                                        (p.stdout + p.stderr).strip()[:1500]))
            harness_path = os.path.join(tmp, "run.mjs")
            with open(harness_path, "w", encoding="utf-8") as fh:
                fh.write(harness)
            r = subprocess.run(["node", harness_path], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "%s assertions failed:\n%s"
                    % (label, (r.stdout + r.stderr).strip()[:2000]))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_nodegraph_logic():
        # Node-view geometry/graph helpers (nodegraph.ts): wiring path, marquee
        # hit-test, snap-to-connect nearest input, viewport clamp, and the
        # graph serialised to the backend.
        _run_logic("nodegraph.ts", _NODEGRAPH_HARNESS,
                   "nodegraph.ts geometry/graph")

    def t_nodebook_model_logic():
        # Split NodeFlow model/geometry and its render comparator run as real
        # TypeScript under Node. This proves the memo boundary skips stationary
        # cards but invalidates on movement, selection, graph, or chart changes.
        _run_logic("nodeFlowModel.ts", _NODEBOOK_MODEL_HARNESS,
                   "nodeFlowModel.ts geometry/memo")

    def t_nodebook_split_and_memo_wiring():
        component = open(os.path.join(FRONTEND, "src", "components",
                                      "NodeFlow.tsx"), encoding="utf-8").read()
        canvas = open(os.path.join(FRONTEND, "src", "components",
                                   "NodeFlowCanvas.tsx"), encoding="utf-8").read()
        model = open(os.path.join(FRONTEND, "src", "lib",
                                  "nodeFlowModel.ts"), encoding="utf-8").read()
        css = _read_fe("src", "styles.css")
        checks = [
            ("NodeFlow imports the split pure model",
             'from "../lib/nodeFlowModel"' in component),
            ("NodeFlow composes the split canvas modules",
             'from "./nodeflow/NodeFlowScene"' in component
             and 'from "./NodeFlowCanvasShell"' in _component_family_source(
                 "NodeFlow.tsx", "nodeflow")
             and 'from "../NodeFlowCanvas"' in _component_family_source(
                 "NodeFlow.tsx", "nodeflow")),
            ("stationary cards use an explicit memo comparator",
             "CanvasNodeFrame = React.memo" in canvas
             and "sameCanvasNodeMemoState" in canvas),
            ("per-card render profiling is available behind the debug flag",
             "useRenderCount(`NodeFlowNode:${node.id}`)" in canvas),
            ("memo boundary tracks structure and scopes transient state",
             "renderVersion={renderModel.renderVersionByNode[node.id]" in _read_nodebook_source()
             and 'node.type === "chart"' in _read_nodebook_source()
             and 'node.type === "dashboard"' in _read_nodebook_source()
             and '(node.type === "group" || node.type === "iterator")'
                 in _read_nodebook_source()
             and "child.id === selectedId" in _read_nodebook_source()),
            ("drag map preserves stationary node identity",
             "if (!origin) return node;" in _read_nodebook_source()),
            ("node cards have layout/style containment",
             "contain: layout style" in css),
            ("ports and geometry no longer live in the component",
             "export const PORTS" in model
             and "export function nodeWidth" in model
             and "const PORTS" not in component),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "NodeFlow split/memo wiring broken: " + "; ".join(missing))

    def t_sql_functions_logic():
        # The IDE's "SQL functions" catalog + caret-insert helper
        # (sqlFunctions.ts): $0 caret marker, selection replacement, and the
        # catalog covering json/unnest, CASE, substring, regex, lag/lead, etc.
        _run_logic("sqlFunctions.ts", _SQLFUNCS_HARNESS,
                   "sqlFunctions.ts catalog + applySnippet")

    def t_table_caps_logic():
        # "Flatten" is offered when a DuckDB table came from JSON OR still has a
        # nested (STRUCT/LIST/MAP/JSON) column -- not gated on the source file's
        # extension (tableCaps.ts). Mirrors the backend, which dumps a non-JSON
        # source to JSON before flattening, so a .txt-bundle or Parquet-cache
        # table is still flattenable.
        _run_logic("tableCaps.ts", _TABLECAPS_HARNESS,
                   "tableCaps.ts flatten availability")

    def t_sql_functions_menu():
        # The query IDE wires a right-click "SQL functions" submenu: it imports
        # the catalog + insert helper, renders a scrollable submenu (positioned
        # via menuPos, which caps height + scrolls), and inserts a snippet at
        # the caret. Guards the wiring without needing a browser.
        ed = open(os.path.join(FRONTEND, "src", "components", "SqlEditor.tsx"),
                  encoding="utf-8").read()
        need("from \"../lib/sqlFunctions\"" in ed
             and "SQL_FUNCTION_GROUPS" in ed and "applySnippet" in ed,
             "SqlEditor imports the catalog + insert helper")
        need("SQL functions" in ed, "the menu has a 'SQL functions' item")
        need("fn-sub" in ed and "menuPos(fnMenu" in ed,
             "the submenu renders, positioned/scrolled via menuPos")
        need("insertFn(" in ed and "def insertFn" not in ed
             and "const insertFn" in ed,
             "a snippet-insert handler exists")
        need("selectionStart = t.selectionEnd = caret" in ed,
             "insert places the caret at the snippet marker")
        lib = open(os.path.join(FRONTEND, "src", "lib", "sqlFunctions.ts"),
                   encoding="utf-8").read()
        need("export function applySnippet" in lib
             and "export const SQL_FUNCTION_GROUPS" in lib,
             "sqlFunctions exports the catalog + applySnippet")
        css = open(os.path.join(FRONTEND, "src", "styles.css"),
                   encoding="utf-8").read()
        need(".ctx-menu.fn-sub" in css, "the submenu has styling")

    def t_recon_export_logic():
        # The reconcile-report CSV builder (reconExport.ts): metadata block,
        # per-field breakdown, balance columns only when a balance field was
        # compared, comma-safe quoting, blank cells for null balances, the
        # totals row, and a sanitised filename.
        _run_logic("reconExport.ts", _RECON_EXPORT_HARNESS,
                   "reconExport.ts CSV")

    def t_profile_export_logic():
        # The profile CSV builder (profileExport.ts): metadata block (table +
        # row count), per-column stat row, blank cells for null stats,
        # comma-safe quoting of column names, and a sanitised filename. Lets the
        # IDE export profile tabs (which have no result_id to hand the backend).
        _run_logic("profileExport.ts", _PROFILE_EXPORT_HARNESS,
                   "profileExport.ts CSV")

    def t_recon_mapping_logic():
        # Exercise the field-mapping logic (lining-up, labels, CSV
        # generate/parse) for real: transpile the TS module with esbuild and
        # run assertions under Node. Skips cleanly if neither is available.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "reconMapping.ts")
        tmp = tempfile.mkdtemp(prefix="samql-reconmap-")
        try:
            mjs = os.path.join(tmp, "reconMapping.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on reconMapping.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_RECON_MAPPING_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "reconMapping logic assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_chart_option_logic():
        # Exercise the chart option builder (buildChartOption) under Node: chart
        # type variants (area/donut/horizontal/stacked/smooth), palettes,
        # themes, legend/grid toggles, axis labels and per-element colours.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "chartOption.ts")
        tmp = tempfile.mkdtemp(prefix="samql-chartopt-")
        try:
            mjs = os.path.join(tmp, "chartOption.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on chartOption.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_CHART_OPTION_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "chart option builder assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_chart_modules_registered():
        # Every ECharts series type the option builder can emit needs its chart
        # module registered in echart.ts (echarts.use([...])). An unregistered
        # type renders a BLANK canvas WITHOUT throwing, so the SVG error-boundary
        # fallback never fires -- which is exactly why tree / treemap /
        # candlestick came up empty. This parses the types chartOption.ts emits
        # and checks each one (plus the dataZoom / visualMap components) is
        # registered.
        import re as _re
        opt = open(os.path.join(FRONTEND, "src", "lib", "chartOption.ts"),
                   encoding="utf-8").read()
        ech = open(os.path.join(FRONTEND, "src", "lib", "echart.ts"),
                   encoding="utf-8").read()
        use_at = ech.find("echarts.use(")
        need(use_at >= 0, "echart.ts has no echarts.use([...]) call")
        use_block = ech[use_at:]
        type_module = {
            "bar": "BarChart", "line": "LineChart", "scatter": "ScatterChart",
            "pie": "PieChart", "treemap": "TreemapChart", "tree": "TreeChart",
            "candlestick": "CandlestickChart",
        }
        emitted = set(_re.findall(r'type:\s*"([a-z]+)"', opt))
        chart_types = sorted(t for t in emitted if t in type_module)
        missing = [type_module[t] for t in chart_types
                   if type_module[t] not in use_block]
        need(not missing,
             "echart.ts must register chart modules for emitted series "
             + str(chart_types) + " -- missing: " + ", ".join(missing))
        if "dataZoom" in opt:
            need("DataZoomComponent" in use_block,
                 "options use dataZoom but DataZoomComponent is not registered")
        if "visualMap" in opt:
            need("VisualMapComponent" in use_block,
                 "options use visualMap but VisualMapComponent is not registered")

    def t_node_port_parity():
        # Every node type must declare IDENTICAL ports in the frontend PORTS map
        # (NodeFlow.tsx) and the backend NODE_PORTS (nodeflow.py), and every
        # executable type must have a dispatch branch in the backend. A mismatch
        # means a port the UI offers can't execute, or a capability the engine
        # supports is hidden in the UI -- i.e. a node not wired through end to
        # end. (This caught browse/write hiding their pass-through output.)
        import re as _re
        fe = _read_nodebook_source()
        nf = open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                  encoding="utf-8").read()
        ss = open(os.path.join(BACKEND, "samql_core", "session.py"),
                  encoding="utf-8").read()

        m = _re.search(r"const PORTS[^\n]*=\s*\{(.*?)\n\};", fe, _re.S)
        need(m, "could not find the PORTS map in NodeFlow.tsx")
        fe_ports = {}
        for mm in _re.finditer(
                r'(\w+):\s*\{\s*inputs:\s*\[([^\]]*)\]\s*,\s*'
                r'outputs:\s*\[([^\]]*)\]', m.group(1)):
            ins = tuple(x.strip().strip('"\'')
                        for x in mm.group(2).split(",") if x.strip())
            outs = tuple(x.strip().strip('"\'')
                         for x in mm.group(3).split(",") if x.strip())
            fe_ports[mm.group(1)] = (ins, outs)

        m = _re.search(r"NODE_PORTS\s*=\s*\{(.*?)\n\}", nf, _re.S)
        need(m, "could not find NODE_PORTS in nodeflow.py")
        be_ports = {}
        for mm in _re.finditer(
                r'"(\w+)":\s*\{"in":\s*\[([^\]]*)\]\s*,\s*'
                r'"out":\s*\[([^\]]*)\]\}', m.group(1), _re.S):
            ins = tuple(x.strip().strip('"\'')
                        for x in mm.group(2).split(",") if x.strip())
            outs = tuple(x.strip().strip('"\'')
                         for x in mm.group(3).split(",") if x.strip())
            be_ports[mm.group(1)] = (ins, outs)

        need(len(fe_ports) >= 40 and len(be_ports) >= 40,
             "port-map parse looks wrong (fe=%d be=%d)"
             % (len(fe_ports), len(be_ports)))

        fk, bk = set(fe_ports), set(be_ports)
        need(fk == bk,
             "node-type sets differ -- only in frontend: %s ; only in backend: %s"
             % (sorted(fk - bk), sorted(bk - fk)))
        bad = [t for t in sorted(fk & bk) if fe_ports[t] != be_ports[t]]
        need(not bad,
             "ports differ between frontend and backend for: "
             + "; ".join("%s (FE %s / BE %s)"
                         % (t, fe_ports[t], be_ports[t]) for t in bad))

        handled = set()
        for blob in (nf, ss):
            handled |= set(_re.findall(r'typ\s*==\s*"(\w+)"', blob))
            for mm in _re.finditer(r'typ\s+in\s*\(([^)]*)\)', blob):
                handled |= set(_re.findall(r'"(\w+)"', mm.group(1)))
        # a node with no ports at all (e.g. the `text` sticky note or a
        # `variable` declaration) is a UI-only definition node and needs no
        # execution handler; every node that has any port must have one
        no_handler = sorted(t for t in bk
                            if (be_ports[t][0] or be_ports[t][1])
                            and t not in handled)
        need(not no_handler,
             "node types with ports but no backend dispatch branch: "
             + ", ".join(no_handler))

    def t_inspector_columns_audit():
        # AUDIT of input-column resolution: every node whose inspector reads
        # inspCols.<port> must (a) have that port in the PORTS table, and (b) be
        # covered by the fetch -- which now derives its wanted ports straight
        # from PORTS[sel.type].inputs, so no input-bearing node can be missed.
        # This caught the filter node, whose key dropdowns were dead because it
        # was absent from the old hand-maintained fetch list.
        import re as _re
        fe = _read_nodebook_source()

        # the fetch must derive wanted ports from the port table, not a list
        need("const wantPorts = PORTS[sel.type]?.inputs" in fe,
             "the inspector column fetch must derive wantPorts from "
             "PORTS[sel.type].inputs so no node type is ever missed")

        # PORTS table: type -> input port names
        m = _re.search(r"const PORTS[^\n]*=\s*\{(.*?)\n\};", fe, _re.S)
        need(m, "could not find the PORTS map")
        ports = {}
        for line in m.group(1).splitlines():
            mm = _re.match(r'\s*([A-Za-z0-9]+):\s*\{\s*inputs:\s*\[([^\]]*)\]',
                           line)
            if mm:
                ports[mm.group(1)] = _re.findall(r'"([^"]+)"', mm.group(2))

        # each inspector block's static inspCols.<key> reads must be real ports
        blocks = _re.split(r'\{(?:sel\.type|inspectorType) === "([a-z0-9]+)" &&', fe)
        offenders = []
        checked = 0
        for i in range(1, len(blocks) - 1, 2):
            typ, body = blocks[i], blocks[i + 1][:5000]
            keys = set(_re.findall(r'inspCols\.([a-zA-Z_]\w*)', body))
            if not keys:
                continue
            checked += 1
            pin = set(ports.get(typ, []))
            bad = keys - pin
            if bad:
                offenders.append("%s reads inspCols.%s but ports=%s"
                                 % (typ, sorted(bad), sorted(pin)))
        need(checked >= 20,
             "expected to audit many inspector blocks, only saw %d" % checked)
        need(not offenders,
             "inspector reads a column key with no matching input port: "
             + "; ".join(offenders))

    def t_workflow_kind_routing():
        # Every workflow kind (node / journal / ide) must be handled in BOTH the
        # open-from-Saved-Workflows path and the open-file-from-disk path, and
        # each surface must save under its own kind. A missing branch would
        # route a workflow to the wrong editor (or silently fail to open it).
        import re as _re
        app = open(os.path.join(FRONTEND, "src", "App.tsx"),
                   encoding="utf-8").read()
        workspace = open(os.path.join(
            FRONTEND, "src", "controllers", "useWorkspaceController.ts"),
            encoding="utf-8").read()
        types = open(os.path.join(FRONTEND, "src", "lib", "types.ts"),
                     encoding="utf-8").read()
        nbk = _read_nodebook_source()
        nb = open(os.path.join(FRONTEND, "src", "components", "Notebook.tsx"),
                  encoding="utf-8").read()

        def after(text, marker, n=5000):
            i = text.find(marker)
            need(i >= 0, "could not find '%s'" % marker)
            return text[i:i + n]

        # the kind union includes IDE, Journal, Node, and Dashboard
        m = _re.search(r'WorkflowKind\s*=\s*([^;]+);', types)
        need(m, "WorkflowKind type not found")
        kinds = set(_re.findall(r'"(\w+)"', m.group(1)))
        need(kinds == {"node", "journal", "ide", "dashboard"},
             "WorkflowKind should be node/journal/ide/dashboard, got "
             + str(sorted(kinds)))

        # open-from-Saved-Workflows handles all kinds (ide + journal + dashboard
        # explicit, node as the else branch). Window widened: abortable load
        # + per-kind metadata grew past the old 1900-char slice.
        load = after(workspace, "onLoadWorkflow = useCallback")
        for needle in ('kind === "ide"', 'kind === "journal"',
                       'kind === "dashboard"',
                       'switchView("nodeflow")'):
            need(needle in load, "onLoadWorkflow missing: " + needle)

        # open-file-from-disk handles all kinds (journal + node + dashboard
        # explicit, ide as the fallthrough)
        openc = after(workspace, "openWorkflowContent = useCallback")
        for needle in ('envelope?.kind === "journal"', 'envelope?.kind === "node"',
                       'envelope?.kind === "dashboard"',
                       'switchView("ide")', "loadSqlIntoEditor"):
            need(needle in openc, "openWorkflowContent missing: " + needle)

        # each surface saves under its own kind
        need("workflowSave" in nbk and '"node")' in nbk,
             "NodeFlow must save with kind=node")
        need("workflowSave" in nb and '"journal")' in nb,
             "Notebook (Journal) must save with kind=journal")
        need('{ sql: tab.sql }, "ide")' in workspace,
             "the SQL editor must save with kind=ide")
        dash = _read_fe("src", "components", "Dashboard.tsx")
        need('workflowSave(name, workspace, "dashboard")' in dash,
             "Dashboard must save with kind=dashboard")
        need("setDashboardCmd" in workspace
             and 'action: "save"' in workspace,
             "workspace controller routes save to dashboardCmd")
        need('kind: "dashboard", label: "Dashboard"' in _read_fe(
                "src", "components", "Sidebar.tsx"),
             "Sidebar WF_SECTIONS includes Dashboard")
        app = _read_fe("src", "App.tsx")
        need("useDashboardSettings" in app
             and "dashboardUi.menu" in app
             and "dashboardUi.modals" in app,
             "App hosts Dashboard Settings export/load")
        need("inspectorHost={dashHostEl}" in app
             and "onSelectionChange={setDashSel}" in app,
             "App still wires Dashboard selection/host props")
        # Config is a Field Explore–style float (useWinDrag + tt-mini), not a
        # tables-rail portal. Board background customization was removed.
        need("useWinDrag" in dash
             and 'data-testid="dashboard-config-mini"' in dash
             and "tt-mini" in dash
             and 'data-testid="dashboard-config-close"' in dash
             and "openWidgetConfig" in dash
             and "openTitleConfig" in dash
             and 'data-testid="dashboard-export-pdf"' in dash
             and "exportDashboardElementToPdf" in dash
             and "openExpand" in dash
             and "dashboard-widget-expand-" in dash
             and "dash-expand-win" in dash
             and "Maximize2" in dash
             and "dashboard-bg-menu" not in dash
             and "dash-root-custom-bg" not in dash,
             "Dashboard configure is a draggable float (not board-bg chrome)")
        need("Maximize2" in _read_fe("src", "components", "Icon.tsx"),
             "Icon.Maximize2 backs the dashboard expand control")
        need(os.path.isfile(os.path.join(
                FRONTEND, "src", "lib", "dashboardPdf.ts")),
             "dashboard PDF export helper must exist")
        pdf = _read_fe("src", "lib", "dashboardPdf.ts")
        need("saveToDownloads" in pdf
             and "jpegBytesToPdf" in pdf
             and "b64" in pdf,
             "dashboard PDF export must write via saveToDownloads b64")
        api = _read_fe("src", "lib", "api.ts")
        need("sharepointDownload" in api
             and '"/api/sharepoint/download"' in api,
             "api.sharepointDownload posts to /api/sharepoint/download")
        need("sharepointAuthDeviceStart" in api
             and '"/api/sharepoint/auth/device/start"' in api
             and "sharepointAuthInteractive" in api
             and '"/api/sharepoint/auth/interactive"' in api,
             "api exposes SharePoint device-code + interactive sign-in")
        insp = _read_fe("src", "components", "nodeflow", "NodeFlowInspector.tsx")
        need('data-testid="sharepoint-download"' in insp
             and "api.sharepointDownload" in insp,
             "SharePoint inspector exposes Download file")
        need('data-testid="sharepoint-auth-mode"' in insp
             and 'data-testid="sharepoint-device-start"' in insp
             and "Windows Integrated" in insp,
             "SharePoint inspector exposes auth modes + device sign-in")
        srv = open(os.path.join(ROOT, "backend", "server.py"),
                   encoding="utf-8").read()
        need('r"^/api/sharepoint/download$"' in srv
             or "/api/sharepoint/download" in srv,
             "server registers POST /api/sharepoint/download")
        need("/api/sharepoint/auth/device/start" in srv
             and "/api/sharepoint/auth/interactive" in srv,
             "server registers SharePoint OAuth auth routes")

    def t_select_fields_logic():
        # Exercise select-field reconciliation (reconcileSelectFields,
        # fieldsDiffer) under Node: a downstream Select must follow upstream
        # renames / new columns / dropped columns. Backs the reported bug.
        # Also covers inspector search filter + A/Z sort helpers.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "selectFields.ts")
        tmp = tempfile.mkdtemp(prefix="samql-selfields-")
        try:
            mjs = os.path.join(tmp, "selectFields.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on selectFields.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_SELECT_FIELDS_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "select-field reconciliation assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_select_field_search_sort_wiring():
        # Select inspector: search box filters the field list; Sort sits next
        # to All/None and reorders config.fields. Pure helpers live in
        # selectFields.ts (covered by t_select_fields_logic).
        insp = _read_fe("src", "components", "nodeflow", "NodeFlowInspector.tsx")
        sf = _read_fe("src", "lib", "selectFields.ts")
        missing = []
        if 'data-testid="select-fields-search"' not in insp:
            missing.append("select field search input")
        if 'data-testid="select-fields-sort"' not in insp:
            missing.append("select field Sort button")
        if "filterSelectFields" not in insp or "sortSelectFields" not in insp:
            missing.append("inspector uses filter/sort helpers")
        if "export function filterSelectFields" not in sf:
            missing.append("filterSelectFields helper")
        if "export function sortSelectFields" not in sf:
            missing.append("sortSelectFields helper")
        if "export function setFieldsKept" not in sf:
            missing.append("setFieldsKept helper")
        need(not missing,
             "Select field search/sort wiring incomplete: "
             + "; ".join(missing))

    def t_select_fields_follow_input_table_change():
        # Changing an Input node's table must refresh every wired Select's
        # fields even when the Select is not selected. Reconciliation used to
        # run only for the selected Select, so Input->Select graphs kept stale
        # columns after a table switch.
        sf = _read_fe("src", "lib", "selectFields.ts")
        ctrl = _read_fe("src", "components", "nodeflow",
                        "useNodeFlowInspectorController.tsx")
        missing = []
        if "export function listWiredSelectUpstreams" not in sf:
            missing.append("listWiredSelectUpstreams helper")
        if "export function applySelectColumnsReconcile" not in sf:
            missing.append("applySelectColumnsReconcile helper")
        if "export function collectSelectFieldPatches" not in sf:
            missing.append("collectSelectFieldPatches helper")
        if 'kind: "step-above"' not in sf and "kind: \"step-above\"" not in sf:
            if 'kind: "step-above"' not in sf.replace("'", '"'):
                # accept either quote style
                if "step-above" not in sf:
                    missing.append("nested Select step-above discovery")
        if "listWiredSelectUpstreams" not in ctrl:
            missing.append("controller lists wired Selects")
        if "applySelectColumnsReconcile" not in ctrl:
            missing.append("controller applies graph-wide reconcile")
        if "partialGroupGraph" not in ctrl or "step-above" not in ctrl:
            missing.append("controller fetches step-above group Select columns")
        if "[scopeKey, graphSig]" not in ctrl:
            missing.append("graph-wide reconcile keyed on graphSig")
        need(not missing,
             "Select fields do not follow Input table changes: "
             + "; ".join(missing))

    def t_notebook_logic():
        # Exercise notebook cell-chaining (composeChainedSql, referencedNames,
        # nextCellName) under Node, transpiling the TS module with esbuild.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "notebook.ts")
        tmp = tempfile.mkdtemp(prefix="samql-notebook-")
        try:
            mjs = os.path.join(tmp, "notebook.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on notebook.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_NOTEBOOK_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "notebook chaining assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_sql_statement_logic():
        # Exercise the editor's statement-splitting + cursor logic (sql.ts)
        # under Node: this backs "Run statement" and must ignore semicolons in
        # strings, identifiers, brackets and comments.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "sql.ts")
        tmp = tempfile.mkdtemp(prefix="samql-sql-")
        try:
            mjs = os.path.join(tmp, "sql.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on sql.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_SQL_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "sql.ts statement-splitting assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_ide_journal_ident_quoting():
        # Weird filenames are sanitized on load, but IDE / Journal still quote
        # any non-bare identifier on insert + autocomplete so a leftover
        # space/dot/paren name (or a messy column header) cannot break a
        # typed SELECT. Shared by the tables sidebar and SqlEditor (IDE +
        # Journal cells both mount SqlEditor).
        sql = _read_fe("src", "lib", "sql.ts")
        sb = _read_fe("src", "components", "Sidebar.tsx")
        ed = _read_fe("src", "components", "SqlEditor.tsx")
        nb = _read_fe("src", "lib", "notebook.ts")
        missing = []
        if "export function quoteSqlIdent" not in sql:
            missing.append("quoteSqlIdent helper")
        if "export function needsSqlQuote" not in sql:
            missing.append("needsSqlQuote helper")
        if 'import { quoteSqlIdent } from "../lib/sql"' not in sb:
            missing.append("Sidebar imports quoteSqlIdent")
        if "onInsertTable(quoteSqlIdent(" not in sb:
            missing.append("Sidebar quotes table inserts")
        if "onInsertColumn(quoteSqlIdent(" not in sb:
            missing.append("Sidebar quotes column inserts")
        if "quoteSqlIdent" not in ed or 'sug.kind === "table"' not in ed:
            missing.append("SqlEditor quotes table/column autocomplete")
        if 'import { quoteSqlIdent } from "./sql"' not in nb:
            missing.append("notebook chaining uses quoteSqlIdent")
        need(not missing,
             "IDE/Journal ident quoting incomplete: " + "; ".join(missing))

    def t_docking_logic():
        # Exercise the float/dock/compare geometry (docking.ts) under Node:
        # backs the pop-out floating panels (snap-back overlap test), the
        # cascade/dedup of multiple pop-outs, and the drag-to-compare /
        # drag-back-to-uncompare reducer for the side-by-side result view.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "docking.ts")
        tmp = tempfile.mkdtemp(prefix="samql-dock-")
        try:
            mjs = os.path.join(tmp, "docking.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on docking.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_DOCKING_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "docking.ts geometry/compare assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_sql_profiles_logic():
        # Exercise sqlProfiles.ts under Node: ODBC-driver auto-pick (newest
        # SQL Server driver) + saved-profile (de)serialization that never
        # persists a password.
        if not shutil.which("node"):
            skip("Node not on PATH")
        esb = _find_esbuild()
        if not esb:
            skip("esbuild not found (run `npm install` in frontend/)")
        src = os.path.join(FRONTEND, "src", "lib", "sqlProfiles.ts")
        tmp = tempfile.mkdtemp(prefix="samql-sqlprof-")
        try:
            mjs = os.path.join(tmp, "sqlprofiles.mjs")
            p = subprocess.run(
                [esb, src, "--bundle", "--format=esm", "--platform=node",
                 "--log-level=warning", "--outfile=" + mjs],
                capture_output=True, text=True, shell=(os.name == "nt"))
            if p.returncode != 0:
                raise AssertionError("esbuild failed on sqlProfiles.ts:\n"
                                     + (p.stdout + p.stderr).strip()[:1500])
            harness = os.path.join(tmp, "run.mjs")
            with open(harness, "w", encoding="utf-8") as fh:
                fh.write(_SQLPROFILES_HARNESS)
            r = subprocess.run(["node", harness], capture_output=True,
                               text=True, shell=(os.name == "nt"))
            if r.returncode != 0 or "OK" not in r.stdout:
                raise AssertionError(
                    "sqlProfiles.ts assertions failed:\n"
                    + (r.stdout + r.stderr).strip()[:2000])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def t_api_profiles_logic():
        # Exercise apiProfiles.ts under Node: query-string composition + saved
        # API request profiles that never persist a secret.
        _run_logic("apiProfiles.ts", _APIPROFILES_HARNESS,
                   "apiProfiles.ts query-string + profiles")

    def t_connection_profiles_wiring():
        # First-class connection profiles: API client + Load tabs upsert/delete
        # + API-node picker. Passwords stay in the secret store; nodes keep only
        # the profile key (mssql:Name / api:Name).
        api = _read_fe("src", "lib", "api.ts")
        helpers = _read_fe("src", "lib", "connectionProfiles.ts")
        mssql = _read_fe("src", "components", "load", "SqlServerLoadTab.tsx")
        mssql_form = _read_fe("src", "components", "load", "MsSqlConnectForm.tsx")
        rest = _read_fe("src", "components", "load", "ApiLoadTab.tsx")
        insp = _read_fe("src", "components", "nodeflow", "NodeFlowInspector.tsx")
        defs = _read_fe("src", "components", "nodeflow", "nodeDefinitions.ts")
        vitest = os.path.join(
            FRONTEND, "src", "lib", "connectionProfiles.component.test.ts")
        missing = []
        for token in (
            "connectionProfilesList",
            "connectionProfilesUpsert",
            "connectionProfilesDelete",
            "connectionProfilesGet",
            "/api/connection-profiles/list",
            "/api/connection-profiles/upsert",
            "/api/connection-profiles/delete",
            "/api/connection-profiles/get",
        ):
            if token not in api:
                missing.append("api.ts " + token)
        if "export function profileKey" not in helpers:
            missing.append("profileKey helper")
        if "export function listConnectionProfiles" not in helpers and \
                "export async function listConnectionProfiles" not in helpers:
            missing.append("listConnectionProfiles helper")
        if "persistMsSqlProfile" not in mssql_form:
            missing.append("MsSqlConnectForm persistMsSqlProfile")
        if "connectionProfilesUpsert" not in mssql_form:
            missing.append("MsSqlConnectForm upserts connection profiles")
        if "connectionProfilesDelete" not in mssql_form:
            missing.append("MsSqlConnectForm deletes connection profiles")
        if "MsSqlConnectForm" not in mssql:
            missing.append("SQL Server Load tab uses MsSqlConnectForm")
        if "connectionProfilesUpsert" not in rest:
            missing.append("REST API Load tab upserts connection profiles")
        if "connectionProfilesDelete" not in rest:
            missing.append("REST API Load tab deletes connection profiles")
        if 'data-testid="apinode-connection-profile"' not in insp:
            missing.append("API node connection-profile picker")
        if "connectionProfilesList" not in insp:
            missing.append("inspector loads connection profiles")
        if "MsSqlConnectForm" not in insp:
            missing.append("SQL Server node uses MsSqlConnectForm")
        if "sqlserver-node-fetch" not in insp:
            missing.append("SQL Server node Fetch control")
        if 'save_password: false' not in defs and \
                "save_password: false" not in defs:
            missing.append("sqlserver node defaults include save_password")
        if 'auth: "windows"' not in defs:
            missing.append("sqlserver node defaults include auth")
        if not os.path.isfile(vitest):
            missing.append("Vitest connectionProfiles helpers")
        need(not missing,
             "connection profiles wiring incomplete: "
             + "; ".join(missing))

    def t_command_palette_and_tools_tables():
        # Ctrl+K command palette (App-global) + NodeFlow-only Tools & Tables
        # floating window (tables + node sections, resize/minimize/close).
        # Also guards: feature pills removed from the top bar (About lists
        # active packages), and connector delete plays a retract animation.
        app = _read_fe("src", "App.tsx")
        nb = _read_nodebook_source()
        cmd = _read_fe("src", "components", "CommandPalette.tsx")
        tools = _read_fe("src", "components", "ToolsTablesPanel.tsx")
        about = _read_fe("src", "components", "AboutModal.tsx")
        css = _read_fe("src", "styles.css")
        missing = []
        if "setCommandPaletteOpen" not in app or "CommandPalette" not in app:
            missing.append("App mounts command palette")
        if 'event.key !== "k"' not in app and "event.key !== 'k'" not in app:
            missing.append("Ctrl/Cmd+K opens command palette")
        if "Open Tools & Tables" not in app:
            missing.append("command palette Tools & Tables action")
        # Tools & Tables is command-palette only (not a Settings menu entry).
        if "Tools &amp; Tables…" in app or "Tools & Tables…" in app:
            missing.append("Settings menu must not list Tools & Tables")
        if "toolsTablesOpen" not in app or "toolsTablesOpen" not in nb:
            missing.append("Tools & Tables open flag NodeFlow-scoped")
        if "TOOLS_TABLES_STORE_KEY" not in tools:
            missing.append("Tools & Tables chrome persistence")
        if 'data-testid="tools-tables-minimize"' not in tools:
            missing.append("Tools & Tables minimize")
        if 'data-testid="tools-tables-close"' not in tools:
            missing.append("Tools & Tables close")
        if "NB_NODE_MIME" not in tools or "addFavorite" not in tools:
            missing.append("Tools & Tables node drag / favorites")
        if ".cmd-palette" not in css or ".tt-panel" not in css:
            missing.append("command palette / Tools & Tables CSS")
        if "cmd-palette-backdrop" not in cmd:
            missing.append("CommandPalette component")
        if "feat-pill" in app or "featList" in app:
            missing.append("top-bar feature pills should be removed")
        if "about-package-" not in about or "about-pkg-status" not in about:
            missing.append("About modal active package badges")
        if "withEdgeRetract" not in nb or "dyingEdgeIds" not in nb:
            missing.append("connector delete retract animation")
        need(not missing,
             "command palette / Tools & Tables incomplete: "
             + "; ".join(missing))

    def t_disconnect_and_addbtn_wiring():
        # Build .178 — two UI fixes:
        #   A) the per-cell add buttons stay under the cell (bounded to the
        #      card width) instead of drifting across a wide monitor;
        #   B) a SQL Server connection group can be disconnected from the
        #      Tables panel (right-click menu + a red Power icon), wired to
        #      the existing DELETE /api/mssql/connection endpoint.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        css = rd("src", "styles.css")
        api = rd("src", "lib", "api.ts")
        sb = rd("src", "components", "Sidebar.tsx")
        app = rd("src", "App.tsx")
        catalog = rd("src", "controllers", "useCatalogController.ts")
        # the .nb-add block must carry a max-width so its centered buttons
        # track the (1100-capped) card rather than the full-width journal pane
        _s = css.index(".nb-add {")
        nbadd = css[_s:css.index("}", _s) + 1]
        checks = [
            ("add buttons bounded to the card width (Fix A; "
             ".437: hard LEFT under the cell, no centering)",
             "max-width: 1100px" in nbadd
             and "justify-content: flex-start" in nbadd),
            ("exactly one mssqlDisconnect in the api",
             api.count("mssqlDisconnect:") == 1),
            ("disconnect hits DELETE /api/mssql/connection",
             'mssqlDisconnect: (name: string) =>' in api
             and '"/api/mssql/connection"' in api
             and 'method: "DELETE"' in api),
            ("Sidebar takes an onDisconnect prop",
             "onDisconnect: (conn: string) => void;" in sb
             and "onDisconnect," in sb),
            ("group row has a right-click disconnect menu",
             "grpMenu" in sb
             and "setGrpMenu" in sb
             and "onContextMenu" in sb
             and "Disconnect" in sb),
            ("group row has a red Power disconnect icon",
             "grp-disconnect" in sb
             and "Icon.Power" in sb
             and "danger" in sb),
            ("the disconnect targets the group's connection",
             "ts[0]?.conn" in sb and "onDisconnect(conn)" in sb),
            ("catalog controller wires onDisconnect -> mssqlDisconnect + refresh",
             "mssqlDisconnect(connection)" in catalog
             and "refreshTables();" in catalog
             and "onDisconnect: disconnectSqlServer" in catalog
             and "onDisconnect={onDisconnect}" in app),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "disconnect / add-button wiring broken: " + "; ".join(missing))

    def t_hdfs_tab_wiring():
        # The HDFS connector tab (simplified flow): enter a URL (persisted across
        # closing the window) -> Connect -> browse folders/sub-folders -> click a
        # file, which hands off to the load job rail (load-file-start -> progress
        # window) and is read in place as a zero-copy DuckDB view.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        modal = _load_data_source()
        app = rd("src", "App.tsx")
        bg = rd("src", "controllers", "useBackgroundOperations.ts")
        checks = [
            ("hdfs api methods defined once each",
             api.count("hdfsConnect:") == 1 and api.count("hdfsBrowse:") == 1
             and api.count("hdfsLoadFileStart:") == 1),
            ("the retired scan/index api is gone",
             "hdfsIndex:" not in api and "hdfsLoadStart:" not in api),
            ("hdfs api methods hit the /api/hdfs/* routes",
             '"/api/hdfs/connect"' in api and '"/api/hdfs/browse"' in api
             and '"/api/hdfs/load-file-start"' in api),
            ("modal has an HDFS tab (Tab union + button + switch)",
             '"hdfs"' in modal and "> HDFS" in modal and 'setTab("hdfs")' in modal),
            ("HDFS source component defined + rendered",
             "export const HdfsLoadTab: React.FC" in modal
             and "<HdfsLoadTab" in modal),
            ("the tab drives connect + folder browse in-modal",
             "api.hdfsConnect(" in modal and "api.hdfsBrowse(" in modal),
            ("the URL persists across closing the window (localStorage)",
             "HDFS_URL_KEY" in modal and "localStorage" in modal),
            ("a file-type filter (CSV/TSV/JSON/Parquet) hides marker/other files",
             "isHdfsLoadable" in modal),
            ("clicking a file hands off to the job rail (file-start -> tray)",
             "onBeginHdfsFileLoad" in modal
             and "api.hdfsLoadFileStart(" in bg
             and "const beginHdfsFileLoad" in bg
             and "onBeginHdfsFileLoad={beginHdfsFileLoad}" in app),
            ("a DuckDB-less server is surfaced, not a silent fail",
             "!duck" in modal),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "HDFS tab wiring broken: " + "; ".join(missing))

    def t_load_cancel_on_close():
        # The Load-data window's X / Esc / backdrop must cancel an in-flight
        # in-modal op (REST API fetch, flatten, HDFS scan/load) -- the same abort
        # the Stop buttons use -- so closing never leaves it stalling; the
        # file-load progress window's X must cancel that job; and a missing-feed
        # date is surfaced as a warning, not an error.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        modal = _load_data_source()
        app = rd("src", "App.tsx")
        shared = rd("src", "components", "ActivityShared.tsx")
        checks = [
            ("modal imports the abort + cancel primitives",
             "abortInflight" in modal and "isCancelledError" in modal),
            ("closing while busy aborts the in-flight op then closes",
             "const handleClose" in modal and "abortInflight()" in modal
             and "closingRef" in modal and "onClose();" in modal),
            ("X / Esc / backdrop route through handleClose",
             "onClose={handleClose}" in modal),
            ("a close-time abort stays silent; a real error still surfaces",
             "guardedError" in modal and "if (!closingRef.current)" in modal),
            ("flatten polling stops when the window is closed",
             "isCancelledError(e)) break" in modal),
            ("missing-feed dates surface as a warning on load completion",
             "skipped" in app and 'toast("warn"' in app),
            ("an in-flight load is cancellable from its activity-tray card",
             "api.loadCancel" in shared),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "load cancel-on-close wiring broken: " + "; ".join(missing))

    def t_flatten_cancel_wiring():
        # Flatten on the cancel rail: a server-side cancel endpoint, the tab
        # registers it (so the window X stops the real work), a Cancel button,
        # and the poll loop stops on a server-side cancel.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        modal = _load_data_source()
        checks = [
            ("flattenCancel api method hits the cancel route",
             "flattenCancel:" in api and "/api/flatten/cancel/" in api),
            ("flatten progress state union includes cancelled",
             '"cancelled"' in api and "flattenProgress:" in api),
            ("FlattenTab tracks the job id + registers a server-side cancel",
             "jobIdRef" in modal and "cancelRef" in modal
             and "api.flattenCancel(" in modal),
            ("the poll loop stops on a server-side cancel",
             'p.state === "cancelled"' in modal),
            ("a Cancel button + the window X both cancel the flatten",
             "cancelFlatten" in modal and "activeCancelRef" in modal
             and "activeCancelRef.current?.()" in modal),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "flatten cancel wiring broken: " + "; ".join(missing))

    def t_fetch_timeout_backstop():
        # Part 4: every no-signal request is bounded by a wall-clock timeout so a
        # wedged backend socket can't hang the UI forever. Data-volume endpoints
        # opt out (they stay cancellable via Stop / abortInflight); quick ops get
        # the default backstop. The HTTP fetcher, MSSQL connect/metadata, and
        # HDFS reads are already bounded server-side.
        import re as _re
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        m = _re.search(
            r"UNBOUNDED_ENDPOINTS = new Set<string>\(\[(.*?)\]\)", api, _re.S)
        set_body = m.group(1) if m else ""
        checks = [
            ("a default timeout backstop is defined",
             "const DEFAULT_TIMEOUT_MS" in api),
            ("jsonFetch resolves an effective timeout (signal/explicit/path/"
             "default)",
             "const effTimeout" in api and "isUnboundedPath(path)" in api),
            ("the timer + the timeout error both use the effective timeout",
             api.count("effTimeout") >= 4),
            ("data-volume endpoints opt out of the backstop",
             bool(set_body) and all(
                 p in set_body for p in [
                     '"/api/nodeflow/run"', '"/api/iterator/run"',
                     '"/api/while/run"', '"/api/node-api-fetch"',
                     '"/api/reconcile"', '"/api/run-tests"',
                     '"/api/chart/data"', '"/api/pivot"',
                     '"/api/catalog/import"', '"/api/load/files"'])),
            ("reconcile sub-ops (drilldown/profile) are unbounded too",
             'p.startsWith("/api/reconcile/")' in api),
            ("frequent schema-inspect calls stay backstopped (not unbounded)",
             '"/api/nodeflow/columns"' not in set_body),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "fetch timeout backstop broken: " + "; ".join(missing))

    def t_rest_mssql_client_cancel():
        # Part 3 client wiring: the load modal's API-fetch and MSSQL-import tabs
        # thread a query id + abort signal and register a backend cancel
        # (api.cancelQuery) so closing the modal aborts the fetch AND interrupts
        # the backend op (the fetch loop's flag / the pyodbc cursor.cancel).
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        modal = _load_data_source()
        checks = [
            ("apiFetch + mssqlImport accept a query id + signal",
             "apiFetch: (\n" in api and "mssqlImport: (\n" in api
             and api.count("query_id: queryId") >= 7),
            ("API + MSSQL load tabs register a backend cancel",
             modal.count("cancelOne(queryId, ctrl)") >= 2
             and "registerRun(queryId, ctrl)" in modal),
            ("API fetch passes query id + abort signal",
             "api.apiFetch(" in modal and modal.count("ctrl.signal,") >= 2),
            ("MSSQL import passes query id + abort signal",
             "api.mssqlImport(" in modal),
            ("both load tabs get the modal cancel ref",
             modal.count("cancelRef={activeCancelRef}") >= 3),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "part-3 client wiring broken: " + "; ".join(missing))

    def t_bg_ops_client_cancel():
        # Part 2 client wiring: the IDE background ops (profile, profile-field,
        # save-as-table, change-type) thread a query id + abort signal so the
        # backend op is interruptible AND the fetch aborts; closing a profile
        # tab cancels it; an engine reset cancels them all. (The in-place
        # flatten moved to a background job -- see t_flatten_table_start_job.)
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        app = rd("src", "App.tsx")
        bg = rd("src", "controllers", "useBackgroundOperations.ts")
        act = rd("src", "components", "ActivityShared.tsx")
        checks = [
            ("api exposes the bg-op cancel registry",
             "export function registerBgCancel" in api
             and "export function cancelAllBgOps" in api),
            ("the IDE bg ops use the tracked-op pattern",
             app.count("startBgOp()") >= 4),
            ("onProfile passes query id + abort signal",
             "api.profile(table, engine, queryId, ctrl.signal)" in app),
            ("closing a profile tab cancels its in-flight profile",
             'if (r.kind === "profile") cancelBgOp(r.profileQueryId)' in app),
            ("background controller registers a bulk bg-op cancel for engine reset",
             "registerBgCancel(cancelAllBgOps)" in bg),
            ("engine reset cancels in-flight background ops",
             "cancelAllBgOps()" in act),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "part-2 client wiring broken: " + "; ".join(missing))

    def t_nodebook_stop_cancels_all():
        # Stop must HARD-cancel a whole workflow: abort every in-flight run fetch
        # AND interrupt every backend run in the batch, stop launching new nodes,
        # and report each run as cancelled (never a spurious error). Run all is
        # concurrent, so tracking the full set of run ids (not just the last) and
        # gating the worker loop both matter.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nb = _read_nodebook_source()
        checks = [
            ("Stop aborts + interrupts ALL runs in the batch (not just the last)",
             "const ids = [...activeRunIds.current]" in nb
             and "cancelAllRuns(ids)" in nb),
            ("every in-flight run id is tracked (Run all is concurrent)",
             "activeRunIds.current.add(id)" in nb
             and "activeRunIds.current.clear()" in nb),
            ("Run-all stops launching new nodes once Stop is requested",
             "if (cancelRequested.current) break;" in nb),
            ("every run catch reports cancellation, not a spurious error",
             nb.count("cancelRequested.current || isCancelledError(e") >= 15),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "NodeFlow stop-cancels-all wiring broken: " + "; ".join(missing))

    def t_notebook_toolbar_and_node_help_wiring():
        # Build .181 — (a) the notebook toolbar wraps instead of clipping its
        # right-hand items when the tables panel is open; (b) each node's
        # inspector gets a "?" help button (left of Delete) opening a per-node
        # help window. Visuals are browser-only, so these are structural.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        css = rd("src", "styles.css")
        help_ts = rd("src", "lib", "nodeHelp.ts")
        ic = rd("src", "components", "Icon.tsx")
        # (a) toolbar wrap
        tb = css[css.index(".nb-toolbar {"):css.index(".nb-toolbar {") + 220]
        need("flex-wrap: wrap" in tb, "notebook toolbar does not wrap")
        # (b) help button + modal wired in the inspector
        checks = [
            ("inspector help delegates to the node-help module",
             "nodeHelp" in nbk and "getNodeHelp" in nbk),
            ("help button opens help for the selected node",
             "setHelpFor(sel.type)" in nbk
             and "How to use this node" in nbk),
            ("help is a lightbulb beside the node name, moved away from Delete",
             "Icon.Lightbulb" in nbk
             and "nb2-insp-title" in nbk
             and "nb2-insp-head-actions" in nbk
             and "Lightbulb:" in ic
             and ".nb2-insp-title" in css),
            ("a help window renders with the content",
             'className="nb2-help"' in nbk
             and "nb2-help-what" in nbk
             and "help.funcs" in nbk),
            ("help modal is styled",
             ".nb2-help {" in css and ".nb2-help-funcs li {" in css),
            ("help content module covers nodes + functions",
             "export function getNodeHelp" in help_ts
             and "export const NODE_HELP" in help_ts
             and "iterator:" in help_ts
             and "sql:" in help_ts
             and "filter:" in help_ts
             and "funcs:" in help_ts),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "toolbar/help wiring broken: " + "; ".join(missing))

    def t_iterator_top_port_wiring():
        # Build .180 — the iterator gets a top "vars" input connector (the
        # driver table whose rows produce the loop's scalar values), with the
        # body/side "in" staying on the left. Canvas geometry is browser-only,
        # so the placement is checked structurally; the functional path is
        # exercised live in t_flow_iterator (wired-vars case).
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        css = rd("src", "styles.css")
        nf = open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                  encoding="utf-8").read()
        ss = open(os.path.join(BACKEND, "samql_core", "session.py"),
                  encoding="utf-8").read()
        checks = [
            ("iterator exposes a vars + in input (FE)",
             'iterator: { inputs: ["vars", "in"], outputs: ["out"] }' in nbk),
            ("top-input registry marks vars as a top port",
             "const TOP_INPUTS" in nbk
             and 'iterator: ["vars"]' in nbk
             and "isTopInput" in nbk
             and "leftInputsOf" in nbk),
            ("top inputs anchor on the top edge, centered",
             "isTopInput(n.type, port)" in nbk
             and "n.x + nodeWidth(n) / 2" in nbk),
            ("a down-pointing top port renders (not on the left)",
             '"nb2-port top"' in nbk and '"nb2-dot down"' in nbk),
            ("CSS places the top port + down arrow",
             ".nb2-port.top {" in css and ".nb2-dot.down {" in css),
            ("vars is labelled for the user",
             'vars: "values"' in nbk),
            ("backend declares the vars port",
             '"iterator": {"in": ["vars", "in"], "out": ["out"]}' in nf),
            ("backend loop honors a wired vars driver",
             'nodeflow.upstream(graph, node_id, "vars")' in ss
             and "_materialize_var_rows" in ss),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "iterator top-port wiring broken: " + "; ".join(missing))

    def t_lucide_icons():
        # Build .182 — the whole icon set was re-vendored from Lucide (ISC) and
        # drawn on a single 24x24 / 2px / round / currentColor grid for
        # uniformity, and every node type in the palette was given a distinct,
        # semantic icon (e.g. formula -> Beaker, summarize -> Sigma). The
        # glyphs themselves only render in a browser, so appearance is
        # unverifiable here; these checks cover the structural contract:
        # one uniform wrapper, every call-site name defined (incl. the
        # single-letter close 'X'), and palette icons that are real + distinct
        # + cleverly assigned.
        import re
        import glob as _glob
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        icon = rd("src", "components", "Icon.tsx")
        nbk = _read_nodebook_source()
        defined = set(re.findall(r"^  ([A-Z][A-Za-z0-9]*): \(p: P\)", icon, re.M))
        # 1) one uniform Lucide wrapper draws every glyph
        need('viewBox="0 0 24 24"' in icon
             and 'stroke="currentColor"' in icon
             and "strokeWidth={2}" in icon
             and 'strokeLinecap="round"' in icon,
             "Icon wrapper is not the uniform Lucide 24/2px/round/currentColor S")
        # 2) every Icon.X referenced anywhere in the app is defined (the close
        #    'X' is single-letter and was easy to drop in a rewrite)
        used = set()
        for f in _glob.glob(os.path.join(FRONTEND, "src", "**", "*.ts*"),
                            recursive=True):
            used |= set(re.findall(r"Icon\.([A-Z][A-Za-z0-9]*)",
                                   open(f, encoding="utf-8").read()))
        missing_def = sorted(used - defined)
        need(not missing_def,
             "Icon names used but not defined: " + ", ".join(missing_def))
        need("X" in defined, "the close 'X' icon is missing")
        # 3) parse the palette -> (node type, icon) and validate it
        palette_block = re.search(
            r"export const NODE_PALETTE_ORDER: NodeType\[\] = \[(.*?)\];",
            nbk, re.S,
        )
        palette_types = set(re.findall(r'"([a-z]+)"', palette_block.group(1))) \
            if palette_block else set()
        all_pairs = re.findall(
            r'^\s*([a-z]+): define\("[a-z]+", "[^"]+", "([A-Za-z0-9]+)"',
            nbk, re.M,
        )
        pairs = [(typ, icon) for typ, icon in all_pairs if typ in palette_types]
        need(len(pairs) >= 45,
             "palette parse found too few entries (%d)" % len(pairs))
        icons = [ic for _t, ic in pairs]
        bad = sorted({ic for ic in icons if ic not in defined})
        need(not bad, "palette references undefined icons: " + ", ".join(bad))
        # 4) the "try not to reuse icons" rule: distinct icon per node type
        dupes = sorted({ic for ic in icons if icons.count(ic) > 1})
        need(not dupes,
             "palette reuses icons across node types: " + ", ".join(dupes))
        # 5) spot-check the clever, semantic assignments
        m = dict(pairs)
        want = {
            "formula": "Beaker", "summarize": "Sigma", "sort": "SortArrows",
            "sample": "Dice", "jsonextract": "Braces", "validate": "ShieldCheck",
            "reconcile": "Scale", "browse": "Eye", "variable": "Variable",
            "sql": "Code", "python": "Terminal", "iterator": "Repeat", "while": "RotateCw",
            "pivot": "LayoutGrid", "join": "GitMerge", "date": "Calendar",
        }
        wrong = ["%s->%s (want %s)" % (t, m.get(t), ic)
                 for t, ic in want.items() if m.get(t) != ic]
        need(not wrong, "clever icon assignments off: " + "; ".join(wrong))

    def t_iterator_container_frontend():
        # The iterator now shares the group's containment machinery: it has a
        # real container default config (children, not the output fallback), it
        # is a drop target that holds child nodes, it renders the container body
        # and sizes like a group, and a container can't be nested in a
        # container. All structural (no browser in the sandbox).
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        checks = [
            ("iterator has a container default (children, not output fallback)",
             'iterator: define("iterator"' in nbk
             and ('{ children: [], table: "", accumulate: "append", '
                  'label: "iterator" }') in nbk),
            ("iterator sizes like a group (width + children-based height)",
             ('if (n.type === "group" || n.type === "iterator") return GROUP_W;'
              in nbk
              or 'if (n.type === "group" || n.type === "iterator") return densify(GROUP_W);'
                 in nbk)),
            ("nested-node lookup routes child edits inside an iterator",
             'group.type !== "group" && group.type !== "iterator"' in nbk
             and "findChildNode(nodes, id)" in nbk),
            ("iterator is a drop target (groupAtContentPoint)",
             "const groupAtContentPoint" in nbk
             and 'node.type !== "group" && node.type !== "iterator"' in nbk
             and "node.id === excludeId" in nbk),
            ("a container can't be dropped into a container",
             'moved.type === "group"' in nbk
             and 'moved.type === "iterator"' in nbk
             and 'node.type !== "group" && node.type !== "iterator"' in nbk),
            ("iterator renders the container body",
             ('n.type === "group" || n.type === "iterator" ? (' in nbk
              or 'node.type === "group" || node.type === "iterator" ? ('
                 in nbk)),
            ("palette / right-click drop onto an iterator adds a child",
             'type !== "group"' in nbk
             and 'type !== "iterator"' in nbk
             and 'type !== "usernode"' in nbk
             and "groupAddChild(group.id, type)" in nbk
             and "addTypeAt" in nbk),
            ("pasted iterator children get fresh ids",
             'node.type === "group" || node.type === "iterator"' in nbk
             and "Array.isArray(config.children)" in nbk
             and "id: uid()" in nbk),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "iterator containment broken: " + "; ".join(missing))

    def t_inspector_ui_polish():
        # Build .189 — inspector polish from the screenshot review:
        #   - the inspector header shows the node's display name (palette label),
        #     so e.g. "renamecols" reads "Rename columns" and "sql" reads "SQL"
        #     instead of the raw type (CSS capitalises each word).
        #   - the SQL query box is capped to the panel width and resizes only
        #     vertically, so it can no longer be dragged past the panel.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        css = rd("src", "styles.css")
        checks = [
            ("inspector header uses the registry display name, not raw type",
             "{inspectorDefinition?.label || sel.type} node" in nbk
             and "{sel.type} node" not in nbk),
            ("sql box is width-capped to the panel",
             ".nb2-sql-area {" in css
             and "max-width: 100%;" in css),
            ("sql box resizes vertically only (can't exceed the panel)",
             "resize: vertical;" in css),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "inspector UI polish broken: " + "; ".join(missing))

    def t_load_finalize_feedback():
        # Build .190 — a large file's load job reports a "finalizing" phase once
        # the bytes are read (the table write + row count then run with no byte
        # signal), and the loading modal shows that instead of a bar frozen at
        # 100%, so it no longer looks stuck at "loaded" while still working.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        app = rd("src", "App.tsx")
        srv = open(os.path.join(BACKEND, "server.py"), encoding="utf-8").read()
        types = rd("src", "lib", "types.ts")
        shared = rd("src", "components", "ActivityShared.tsx")
        checks = [
            ("backend flips the load job to finalizing after the read",
             'job["state"] = "finalizing"' in srv
             and 'done >= job["bytes_total"]' in srv),
            ("the tray card recognizes the finalizing phase",
             'phase === "finalizing"' in shared
             and "const finalizing =" in shared),
            ("tray card shows finalizing instead of a bar frozen at 100%",
             "Finalizing" in shared and "writing rows" in shared
             and "!finalizing" in shared),
            # the modal compares state to "finalizing", so the LoadProgress /
            # JobSummary unions must include it or the real tsc rejects the
            # comparison (TS2367) -- guard that here too.
            ('the "finalizing" state is in the LoadProgress union',
             '"reading" | "finalizing"' in types),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "load finalize feedback broken: " + "; ".join(missing))

    def t_iterator_run_fixes():
        # Build .192 — container-iterator fixes from a screenshot review:
        #   - running a container no longer pops "Name the loop variable" (a
        #     container is driven by its wired "values" table, not a var name),
        #   - "Replace rows matching" lists the accumulator TABLE's own columns
        #     (the keys must exist there), not the unrelated side-input columns.
        def rd(*p):
            return open(os.path.join(FRONTEND, *p), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        checks = [
            ('the spurious "Name the loop variable" run-gate is gone',
             "Name the loop variable" not in nbk),
            ("replace keys read the accumulator table's own columns",
             "t.name === accName" in nbk
             and "const accName = (sel.config.table" in nbk),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "iterator run fixes broken: " + "; ".join(missing))

    def t_node_ports_and_note_delete():
        # Build .195 — two UI polish items from a screenshot:
        #   - the generic "in"/"out" port text is hidden on canvas nodes (the
        #     connection dots stay; meaningful labels like True/False/values
        #     remain), and
        #   - the journal note card's delete button matches the cell's: the same
        #     red delete styling, now extended to the note actions bar.
        def rd(*p):
            return open(os.path.join(FRONTEND, *p), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        cell = _notebook_cell_source()
        css = rd("src", "styles.css")
        checks = [
            ('the generic "in" port text is hidden',
             'port !== "in" && (' in nbk
             or "sidePortLabel" in nbk),
            ('the generic "out" port text is hidden',
             'port !== "out" && (' in nbk
             or "sidePortLabel" in nbk),
            ("the note card delegates to the shared red × delete action",
             'deleteTitle="Delete note"' in cell
             and 'className="iconbtn xbtn"' in cell),
            ("the red × styling reaches the note actions bar",
             ".nb-note-actions" in css and ".iconbtn.xbtn" in css),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "node/note polish broken: " + "; ".join(missing))

    def t_iterator_container_not_subtitle():
        # Build .201 — the real tsc (the dev machine's authoritative type gate)
        # caught a dead comparison (TS2367). The iterator node is a container:
        # it's rendered by the group/iterator branch, so it never reaches the
        # per-node subtitle label chain. A leftover `n.type === "iterator"`
        # branch there (with a `loop ${var}` label) was unreachable, and tsc
        # rightly flagged it as a comparison with no overlap. Removed. Guard:
        # iterators stay container-routed and the dead subtitle branch does not
        # creep back. (esbuild can't see this class of bug; only a typed check
        # can, so this structural guard stands in for the sandbox.)
        nbk = _read_nodebook_source()
        checks = [
            ("iterator nodes are routed as containers (like groups)",
             'n.type === "group" || n.type === "iterator"' in nbk),
            ("the dead iterator loop-subtitle branch is gone",
             r"loop \${" not in nbk),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "iterator container/subtitle invariant broken: "
             + "; ".join(missing))

    def t_iterator_keeps_table_name_on_fail():
        # Build .201 — the iterator/while run handlers used to patch
        # `table: r.table` unconditionally. A failed run returns table: null
        # (nothing was written), so that wiped the user's accumulator name and
        # blocked a simple rerun ("the table name clears after every run").
        # They now only update `table` when the backend returns one, leaving
        # the name in place after a failed pass.
        nbk = _read_nodebook_source()
        need(
            nbk.count("...(r.table ? { table: r.table } : {})") >= 2,
            "the iterator and while run handlers guard the table-name update "
            "so a failed run can't clear it",
        )

    def t_formula_iterator_var_hint():
        # Build .205 — when a formula step sits inside an iterator, its inspector
        # spells out the loop variables and the quoting rule (a bare ${col1} is
        # read as a column name; '${col1}' is the text value), heading off the
        # most common iterator-formula mistake. Structural.
        nbk = _read_nodebook_source()
        checks = [
            ("hint keys off the owning iterator",
             'owner.type !== "iterator"' in nbk),
            ("hint reads the iterator's var_rename",
             "owner.config.var_rename" in nbk),
            ("hint shows the loop variables and the {{ }} text form",
             "Iterator variables (one per pass)" in nbk
             and "auto-quotes" in nbk),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "formula iterator-var hint broken: " + "; ".join(missing))

    def t_journal_delete_buttons_match():
        # Build .198 / red-× pass — every journal cell delete shares
        # NotebookMoveDeleteActions with className="iconbtn xbtn" (red ×),
        # including note / chart / pivot / reconcile / SQL cells.
        cell = _notebook_cell_source()
        checks = [
            ("all cell renderers share one move/delete action",
             cell.count("<NotebookMoveDeleteActions") >= 4),
            ("the shared action owns the red × delete button",
             'className="iconbtn xbtn"' in cell
             and 'title={deleteTitle}' in cell),
            ("standard cells use the default delete label",
             cell.count("onDelete={props.onDelete}") >= 3),
            ("the note renderer supplies its note-specific label",
             'deleteTitle="Delete note"' in cell
             and 'className="nb-note-actions"' in cell),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "journal delete buttons inconsistent: " + "; ".join(missing))

    def t_ctx_menu_scrolls():
        # Build .197 — every right-click/context menu is positioned through the
        # shared menuPos() helper, so they all clamp into the viewport and
        # scroll when tall instead of running off the bottom of the screen.
        # Guards the helper's logic, that each menu file routes through it (no
        # ad-hoc clamps left), and the CSS safety net.
        def rd(*p):
            return open(os.path.join(FRONTEND, *p), encoding="utf-8").read()
        helper = rd("src", "lib", "menuPos.ts")
        css = rd("src", "styles.css")
        checks = [
            ("menuPos clamps horizontally to the viewport",
             "Math.min(x, window.innerWidth - width" in helper),
            ("menuPos clamps the top into the viewport",
             "Math.min(y, window.innerHeight - 220)" in helper),
            ("menuPos caps the height to the space below",
             "maxHeight: window.innerHeight - top" in helper),
            ("menuPos turns on vertical scrolling",
             'overflowY: "auto"' in helper),
            ("every ctx-menu has a viewport-bounded height (CSS net)",
             "max-height: calc(100vh - 16px)" in css),
        ]
        # Every file that renders a context menu must route it through menuPos
        # and keep no hand-rolled vertical clamp behind.
        menu_files = [
            ("App.tsx", ("src", "App.tsx")),
            ("DataGrid.tsx", ("src", "components", "DataGrid.tsx")),
            ("Sidebar.tsx", ("src", "components", "Sidebar.tsx")),
            ("ReconReport.tsx", ("src", "components", "ReconReport.tsx")),
            ("SqlEditor.tsx", ("src", "components", "SqlEditor.tsx")),
        ]
        for name, path in menu_files:
            src = rd(*path)
            checks.append((name + " imports menuPos",
                           "import { menuPos }" in src))
            checks.append((name + " positions menus via menuPos(",
                           "menuPos(" in src))
            checks.append((name + " has no ad-hoc menu top clamp left",
                           "top: Math.min(" not in src))
        missing = [n for n, ok in checks if not ok]
        need(not missing, "ctx-menu scroll fix broken: " + "; ".join(missing))

    def t_excel_load_ui_and_bi_export():
        # Build .199 — frontend wiring for: the Excel sheet picker + header
        # start-row in both the file browser and drag-and-drop, plus the
        # Tableau / Power BI export types.
        def rd(*p):
            return open(os.path.join(FRONTEND, *p), encoding="utf-8").read()
        api = rd("src", "lib", "api.ts")
        modal = _load_data_source()
        app = rd("src", "App.tsx")
        checks = [
            ("api exposes excelSheets", "excelSheets:" in api),
            ("api exposes excelPeek", "excelPeek:" in api),
            ("loads carry header_row", "header_row: headerRow" in api),
            ("file tab fetches sheet names", ".excelSheets" in modal),
            ("file tab has a start-at-row input", "Start at row" in modal),
            ("file tab detects Excel files", "\\.(xlsx|xlsm|xls)" in modal),
            ("drag-drop peeks Excel sheets", ".excelPeek" in app),
            ("excel peek aborts on supersede",
             "excelPeek(files[0], ctrl.signal)" in app
             and "peekCtrl?.abort()" in app),
            ("drop prompt has a start-at-row input",
             "Start at row (the header row)" in app),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "excel UI wiring broken: " + "; ".join(missing))

    def t_tableau_powerbi_ui_removed():
        # Build .204 — the dedicated Tableau / Power BI export options were
        # removed from both the results Export menu and the Output node's
        # file-type list, since Parquet (typed, columnar) opens directly in
        # both. Parquet stays. Structural regression guard (no browser here).
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()

        app = rd("src", "App.tsx")
        nbk = _read_nodebook_source()
        checks = [
            # the quoted format keys / option labels are gone from both menus
            # (a passing mention in a code comment is fine -- we pin the keys)
            ("export menu drops the Tableau option",
             '"tableau"' not in app and '"Tableau ("' not in app),
            ("export menu drops the Power BI option",
             '"powerbi"' not in app and '"Power BI ("' not in app),
            ("output node format list drops tableau/powerbi",
             '"tableau"' not in nbk and '"powerbi"' not in nbk),
            ("output node format labels drop Tableau/Power BI",
             "Tableau (.parquet)" not in nbk
             and "Power BI (.parquet)" not in nbk),
            ("Parquet stays in the shared export formats module",
             '"parquet"' in rd("src", "lib", "resultExportFormats.ts")
             and "backendResultExportFormats" in rd(
                 "src", "lib", "resultExportFormats.ts")),
            ("tsv + ndjson stay in the shared export formats module",
             '["tsv", "TSV"]' in rd("src", "lib", "resultExportFormats.ts")
             and '["ndjson", "NDJSON"]' in rd(
                 "src", "lib", "resultExportFormats.ts")),
            ("IDE Output menu consumes the shared export formats",
             "exportFormatsForResultTab" in app
             and "ExportResultsMenuItems" in app),
            ("Parquet stays in the output node format list",
             '"parquet"' in nbk),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "Tableau/Power BI removal incomplete: " + "; ".join(missing))

    def t_iterator_container_inspector():
        # Build .188 — the iterator inspector is now container-only: the old
        # loop-variable / values-from driver / max-passes fields are gone, and
        # it exposes the accumulator table, the column->variable rename grid
        # (writing config.var_rename, auto-populated from the values-port
        # columns), the shared accumulate/fold controls, keep-going, and a
        # "dissolve" action that expands the body back onto the canvas as
        # standalone nodes. Structural (no browser in the sandbox).
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbk = _read_nodebook_source()
        inspector = rd("src", "components", "nodeflow", "NodeFlowInspector.tsx")
        gone = ["Loop variable", "Values from", "A list I type", "Max passes",
                "Each row of a table"]
        present = [
            "patch(sel.id, { var_rename: cur })",       # rename grid writes it
            "(inspCols.vars || [])",                    # populated from values
            "renderReduceControls(sel)",                # accumulate/fold reused
            "dissolveContainer(sel.id)",                # expand-to-canvas button
            "const dissolveContainer = useCallback(",      # orchestration seam
            "dissolveContainerGraph(",                  # pure graph command
            "edges.filter(",                            # container wires removed
            "doRunIterator(sel)",                       # run button kept
        ]
        bad = [g for g in gone if g in inspector]
        missing = [p for p in present if p not in nbk]
        need(not bad,
             "old iterator-driver UI still present: " + ", ".join(bad))
        need(not missing,
             "container inspector incomplete: " + "; ".join(missing))

    def t_type_safety_fixes():
        # Build .184 — fixes for the type errors the full `tsc` surfaced once
        # the frontend node_modules was installed (tsc is skipped in this
        # sandbox, so the fixes are guarded structurally here):
        #   - showTables / showNodeSearch are typed useState<boolean> so their
        #     setter callbacks stop being implicit-any (App.tsx TS7006)
        #   - leftInputsOf indexes PORTS via a string-keyed cast and types its
        #     filter param (NodeFlow.tsx TS7053 + TS7006)
        #   - the unreachable `n.type === "sql"` arm in the node-label chain is
        #     gone: it lived inside `n.type === "sql" ? null : (...)`, so the
        #     comparison could never be true (NodeFlow.tsx TS2367)
        #   - the inline ReconReport is passed its required onExport prop
        #     (NotebookCell.tsx TS2741)
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        app = rd("src", "App.tsx")
        nbk = _read_nodebook_source()
        nbc = _notebook_cell_source()
        checks = [
            ("showTables state typed boolean",
             "[showTables, setShowTables] = useState<boolean>(" in app),
            ("showNodeSearch state typed boolean",
             "[showNodeSearch, setShowNodeSearch] = useState<boolean>(" in app),
            ("leftInputsOf indexes PORTS through a string cast",
             "PORTS as Record<string, { inputs: string[]; outputs: string[] }>"
             in nbk),
            ("leftInputsOf types its filter param",
             ".filter((p: string) => !isTopInput(type, p))" in nbk),
            ("dead sql arm removed from the node-label chain",
             "write a query" not in nbk),
            ("inline ReconReport is given onExport",
             "onExport={(filename, csv) => {" in nbc
             and "saveToDownloads(filename, { text: csv })" in nbc),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "type-safety fixes broken: " + "; ".join(missing))

    def t_mssql_profile_resilience():
        # Saved SQL Server connection profiles live in localStorage, not on the
        # backend. They must load independent of the pyodbc/ODBC-driver probe
        # and stay visible even when pyodbc isn't detected on the server --
        # otherwise an unrelated pyodbc gap makes a saved profile look lost.
        src = _load_data_source()
        checks = [
            ("profiles load independent of the driver probe",
             "setProfiles(parseSqlProfiles(localStorage.getItem("
             "SQL_PROFILES_KEY)))" in src),
            ("pyodbc-unavailable notice still lists saved profiles",
             'Object.keys(profiles).sort().join(", ")' in src
             and "will load once pyodbc is detected" in src),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "mssql profile resilience broken: " + "; ".join(missing))

    def t_recon_ui_layout_wiring():
        # Build .179 — two reconcile UI fixes (browser-rendered, so checked
        # structurally):
        #   A) the results table aligns header + body columns on a wide
        #      monitor via a fixed table layout + a colgroup;
        #   B) the Key/Compare/Balance dropdowns float as a viewport-fixed
        #      overlay so they sit on top of the modal card instead of being
        #      clipped by its overflow.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        css = rd("src", "styles.css")
        rr = rd("src", "components", "ReconReport.tsx")
        ms = rd("src", "components", "MultiSelect.tsx")
        _g = css.index(".rr-grid {")
        grid = css[_g:css.index("}", _g) + 1]
        _f = css.index(".rr-field {")
        field = css[_f:css.index("}", _f) + 1]
        checks = [
            ("recon table uses a fixed layout (Fix A)",
             "table-layout: fixed" in grid),
            ("recon table has a colgroup with a field column",
             "<colgroup>" in rr and "rr-col-field" in rr),
            ("long field names clip instead of widening the column",
             "text-overflow: ellipsis" in field),
            ("the field cell keeps a title for the full name",
             'title={f.label || f.field}' in rr),
            ("dropdown floats off the trigger rect (Fix B)",
             "getBoundingClientRect" in ms and "btnRef" in ms),
            ("dropdown renders as a fixed overlay",
             'position: "fixed"' in ms and "rc-menu-float" in ms),
            ("dropdown flips above the trigger when low on room",
             "flipUp" in ms and "bottom:" in ms),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "recon UI layout wiring broken: " + "; ".join(missing))

    def t_ui_feature_wiring():
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        app = rd("src", "App.tsx")
        result_controller = rd("src", "controllers", "useResultController.ts")
        workspace_controller = rd("src", "controllers", "useWorkspaceController.ts")
        background_controller = rd("src", "controllers", "useBackgroundOperations.ts")
        ed = rd("src", "components", "SqlEditor.tsx")
        dg = rd("src", "components", "DataGrid.tsx")
        rcm = rd("src", "components", "ReconcileModal.tsx")
        rmap = rd("src", "lib", "reconMapping.ts")
        nb = rd("src", "components", "Notebook.tsx")
        nbc = _notebook_cell_source()
        sb = rd("src", "components", "Sidebar.tsx")
        ld = _load_data_source()
        pv = rd("src", "components", "PivotPanel.tsx")
        cp = rd("src", "components", "ChartPanel.tsx")
        fp = rd("src", "components", "FloatingPanel.tsx")
        dk = rd("src", "lib", "docking.ts")
        cv = rd("src", "components", "ChartView.tsx")
        pkg = rd("package.json")
        paging = rd("src", "lib", "usePagedResult.ts")
        checks = [
            ("schema autocomplete prop passed", "tables={tables}" in app),
            ("SqlEditor consumes schema",
             "tables" in ed and "TableInfo" in ed),
            ("grid column context menu",
             "onColumnContextMenu" in dg and "onColumnContextMenu" in app),
            ("server-side filter wiring",
             "applyColFilter" in app and "filters" in app),
            ("query cancellation wiring",
             "cancelQuery" in app or "cancelOne" in app),
            ("IDE Run toggles to a red Stop while running",
             "<Icon.Square size={14} /> Stop" in app
             and "onClick={cancelRunning}" in app
             and '"btn sm danger"' in app),
            ("Journal Run all toggles to a red Stop while running",
             "runningAll" in nb and "cancelAll" in nb
             and "<Icon.Square size={13} /> Stop" in nb),
            ("Journal Stop halts the sweep and cancels in-flight cells",
             "cancelAllRef" in nb and "cancelCell(id)" in nb),
            ("IDE exports profile + reconcile tabs, not just query results",
             "canExport" in app and "reconReportCsv" in app
             and "profileCsv" in app
             and 'r.kind === "recon"' in app
             and 'r.kind === "profile"' in app),
            ("IDE export formats are kind-aware (CSV/JSON for recon/profile)",
             "exportFormatsFor" in app),
            ("session persistence",
             "localStorage" in app and "samql.session" in app),
            ("release inactive results",
             "released" in result_controller
             and "useResultController" in app),
            ("reconcile modal + report wired",
             "ReconcileModal" in app and "ReconReport" in app
             and "onRunReconcile" in app),
            ("reconcile drill/profile pass colmaps",
             "createReconDetailController" in app
             and "buildReconcileRequest(spec, bucket, field" in rd(
                 "src", "lib", "reconDetailActions.ts")
             and "colmap_a" in rd("src", "lib", "reconcileRequest.ts")),
            ("reconcile drill/profile soft-cancel via AbortSignal",
             "abortReconDetail" in rd("src", "lib", "reconDetailActions.ts")
             and "createReconDetailController" in app
             and "ctrl.signal" in rd("src", "lib", "reconDetailActions.ts")
             and "registerRun(qid, ctrl)" in rd(
                 "src", "lib", "reconDetailActions.ts")),
            ("chart requests accept AbortSignal",
             "chart: (spec: ChartSpec, signal?: AbortSignal)" in rd(
                 "src", "lib", "api.ts")),
            ("ChartPanel aborts superseded chart fetches",
             "ctrl.signal" in cp and "cancelInflight" in cp
             and "stopChart" in cp and 'data-testid="chart-stop"' in cp
             and "query_id: qid" in cp and "registerRun(qid, ctrl)" in cp),
            ("Created Node refresh loads never-opened tabs",
             "ensureTabGraphLoaded" in rd(
                 "src", "components", "nodeflow",
                 "useNodeFlowDocumentController.ts")
             and "ensureTabGraphLoaded(tab.id)" in rd(
                 "src", "components", "nodeflow",
                 "useNodeFlowDocumentController.ts")),
            ("reconcile field mapping wired",
             "resolveReconFields" in rcm and "mappingTemplateCsv" in rcm
             and "parseMappingCsv" in rcm),
            ("mapping logic is case/whitespace-insensitive",
             "trim().toLowerCase()" in rmap and "colmapsFor" in rmap),
            ("notebook mode toggle wired",
             "Notebook" in app and 'view === "notebook"' in app
             and "switchView" in app),
            ("notebook cell reuses editor/grid/chart",
             "SqlEditor" in nbc and "DataGrid" in nbc and "ChartPanel" in nbc),
            ("notebook chaining + persistence wired",
             "composeChainedSql" in nb and "saveNotebook" in nb),
            ("notebook save/open to file wired (file browser + envelope)",
             "serializeNotebook" in nb and "parseNotebookFile" in nb
             and "FileBrowser" in nb and "onPickJournalFile" in nb
             and "wfEnvelope" in nb),
            ("reconcile from table context menu",
             "onReconcile" in sb and "Reconcile with" in sb
             and "onReconcile" in app and "initialLeft" in app),
            ("running-query indicator wired",
             "run-progress" in app and "RunTimer" in app
             and "cancelRunning" in app),
            ("table filter is name-only",
             "Filter tables\u2026" in sb and ".columns.some(" not in sb),
            ("settings menu wired",
             "settings-menu" in app
             and "Storage &amp; Engine" in app),
            ("stat indicator present", "StatIndicator" in app),
            ("sidebar column context menu + change type",
             "onChangeType" in sb and "Change type to" in sb
             and "onChangeType={changeColType}" in app),
            ("sidebar table search matches name, source and columns",
             "c.name.toLowerCase().includes(needle)" in sb
             and "t.source" in sb),
            ("file browser has quick-access shortcuts",
             "fb-shortcuts" in ld and "listing.shortcuts" in ld),
            ("SQL Server load tab present + safeguards surfaced",
             '"mssql"' in ld and "SqlServerLoadTab" in ld and "mssqlImport" in ld
             and "Read-only" in ld and "destination" in ld
             and "Target engine" in ld),
            ("result grid cell selection + copy",
             "copySel" in dg and "buildTSV" in dg
             and "Copy with headers" in dg),
            ("grid widths updater is a no-op when unchanged",
             "changed ? next : prev" in dg),
            ("editor right-click menu (run/copy/paste/select all)",
             "ctxMenu" in ed and "ctxPaste" in ed and "Run statement" in ed
             and "Select all" in ed),
            ("pivot panel wired into result view",
             "PivotPanel" in app and 'view === "pivot"' in app
             and "import { PivotPanel }" in app),
            ("pivot tiles + drag/drop + summarize + filters",
             "dropOnAxis" in pv and "Summarize" in pv and "Filters" in pv
             and "api.pivot" in pv and "values" in pv),
            ("notebook cell has a pivot view",
             "PivotPanel" in nbc and '"pivot"' in nbc),
            ("notebook cells drag-and-drop reorder",
             "nb-grip" in nbc and "onReorderStart" in nbc
             and "startCellDrag" in nb and "setDropTarget" in nb),
            ("notebook dependency-aware run + stale + lineage",
             "buildGraph" in nb and "staleById" in nb
             and "runWithDownstream" in nb and "runWithUpstream" in nb
             and "nb-stale" in nbc and "nb-lineage" in nbc
             and "onRunBranch" in nbc),
            ("notebook first-class chart + pivot cells",
             '"chart" | "pivot"' in nb and "onAddBelow" in nb
             and "sourceName" in nb
             and "isVisualization" in nbc and "nb-viz" in nbc
             and "onSetSource" in nbc and "const source" in nbc),
            # .471 repoint: the switcher popover became the journal
            # TAB STRIP (delete works on ANY tab; Duplicate retired).
            ("notebook library: multi-notebook + autosave + recovery",
             "ensureNotebookStore" in nb and "switchTo" in nb
             and "newNotebook" in nb and "deleteJournal" in nb
             and "nb-jtabs" in nb and "nb-save" in nb
             and "nb-recovery" in nb and "restoreRecovery" in nb),
            ("notebook perf: debounced recompute + memoised cells",
             "debSqlSig" in nb and "compiledById" in nb
             and "persistSig" in nb and "sqlSig" in nb
             and "cellPropsEqual" in nbc and "React.memo" in nbc),
            ("notebook result lifecycle: eager discard + expired self-heal",
             "discardRid" in nb and "discardResult" in nb
             and "notebookPaging" in nb
             and 'const EXPIRED_ERROR = "result expired"' in paging
             and "rerunExpired" in paging
             and "onSourceExpired" in nb and "onSourceExpired" in nbc
             and "onExpired" in cp and "onExpired" in pv),
            ("notebook memory: collapse frees rows + scroll cap",
             "toggleCollapse" in nb and "MAX_RETAINED_ROWS" in nb),
            ("viz panels memoised (skip re-render on unrelated parent updates)",
             "React.memo" in cp and "ChartPanelImpl" in cp
             and "React.memo" in pv and "PivotPanelImpl" in pv),
            ("IDE render isolation: run-timer + task-watcher self-contained",
             "RunTimer" in app and "runElapsed" not in app
             and "TaskWatcher" in app and "onTaskComplete" in app
             and "loadProg" not in app.replace("loadProgress", "")),
            ("render-count instrument wired into heavy children",
             "useRenderCount" in ed and "useRenderCount" in dg
             and "useRenderCount" in sb),
            ("IDE heavy children memoised (Sidebar + DataGrid)",
             "React.memo" in sb and "SidebarImpl" in sb
             and "sidebarPropsEqual" in sb
             and "React.memo" in dg and "DataGridImpl" in dg
             and "dataGridPropsEqual" in dg),
            ("sidebar hides __-prefixed materialisation tables",
             'startsWith("__")' in sb),
            ("notebook reconcile cell wired into dependency graph",
             "buildJournalDependencyGraph" in nb
             and "leftSource" in nb and "rightSource" in nb),
            ("reconcile cell UI + run orchestration",
             "nb-recon" in nbc and "ReconReport" in nbc
             and "onRunReconcile" in nbc
             and "runReconcile" in nb and "reconSources" in nb
             and "api.materialize" in nb and "reconCellDrill" in nb),
            ("reconcile cell auto-reruns on input change",
             "reconInputSig" in nb and "reconAutoSig" in nb
             and "reconRanSig" in nb),
            ("reconcile auto-rerun gated by source size (M4)",
             "AUTO_RECON_MAX_ROWS" in nb and "reconAutoEligible" in nb
             and "reconNeedsManualRefresh" in nbc),
            ("detachable floating panels wired",
             "FloatingPanel" in app and "floatView(" in app
             and "Open in new window" in app and "dockFloat" in app),
            ("float panel snap-back + dock controls",
             "shouldDock" in fp and "onDock" in fp and "getDockRect" in fp),
            ("pivot + chart pop-out buttons wired",
             "onPopOut" in pv and "onPopOut" in cp
             and "onPopOut={() => floatView(" in app),
            ("dock-zone highlight on the results pane",
             "dock-hot" in app and "dockHot" in app
             and "resultPaneRef" in app),
            ("side-by-side compare wired",
             "applyCompareDrop" in app and "compare-split" in app
             and "renderGridForRes" in app and "doSortFor" in app),
            ("docking geometry/state helpers present",
             "overlapFraction" in dk and "applyCompareDrop" in dk
             and "pruneCompare" in dk and "addFloat" in dk),
            ("charts use echarts with a native SVG fallback",
             "ChartView" in cp and "ChartSvg" in cp
             and "echarts" in cv and "ChartErrorBoundary" in cv
             and "fallback" in cv),
            ("echarts is a declared dependency",
             '"echarts"' in pkg and '"recharts"' not in pkg),
            ("pivot nests row dimensions into sub-rows",
             "pv-group-start" in pv and "pv-subdim" in pv),
            ("tables panel hide/show toggle wired",
             "showTables" in app and "Hide tables panel" in app
             and "tables-reopen" in app),
            ("notebook cell inline-rename wired",
             "renameCell" in nb and "onRename" in nb
             and "sanitizeCellName" in nb and "renameInSql" in nb
             and "onRename" in nbc and "nb-handle-edit" in nbc
             and "startRename" in nbc),
            ("profile-field on column header wired",
             "onProfileField" in app and "Profile field" in app
             and "profileField" in app
             and "profileField" in rd("src", "lib", "api.ts")),
            ("run-tests removed from settings",
             "runTestsFromMenu" not in app and "Run tests" not in app),
            ("sql server saved profiles + alternate-account auth wired",
             "windows_alt" in ld and "Saved profile" in ld
             and "saveProfile" in ld and "deleteProfile" in ld
             and "bestOdbcDriver" in ld
             and "Alternate Windows account" in ld
             and "looks like a Windows account" in ld
             and "bestOdbcDriver" in rd("src", "lib", "sqlProfiles.ts")),
            ("mssql windows_alt impersonation wired in backend",
             "alt_creds" in open(os.path.join(BACKEND, "server.py"),
                                 encoding="utf-8").read()
             and "split_domain_user" in open(os.path.join(BACKEND, "server.py"),
                                              encoding="utf-8").read()
             and "best_odbc_driver" in open(
                 os.path.join(BACKEND, "samql_core", "mssql.py"),
                 encoding="utf-8").read()),
            ("reconcile multi-select menu auto-sizes to content",
             "width: max-content" in rd("src", "styles.css")
             and "max-width: min(70vw, 640px)" in rd("src", "styles.css")),
            ("notebook chart/pivot/reconcile cells can minimize",
             nbc.count("nb-collapsed") >= 2 and "Minimize" in nbc
             and ".nb-card.nb-collapsed" in rd("src", "styles.css")),
            ("notebook reconcile uses shared MultiSelect dropdowns",
             "MultiSelect" in nbc and "openSelector" in nbc
             and 'from "./MultiSelect"' in rcm
             and "rc-multi-btn" in rd("src", "components", "MultiSelect.tsx")),
            ("notebook reconcile stages cell sources on their own engine",
             "leftEngine" in nb and "rightEngine" in nb
             and "page?.engine" in nb),
            ("sql server catalog browse (schema-only tables) wired",
             "mssqlCatalog" in rd("src", "lib", "api.ts")
             and "Load all tables" in ld and "doLoadCatalog" in ld
             and "schema only" in sb and "t.remote" in sb),
            ("load-data modal scales (responsive width, profile row wraps)",
             "max-width: min(760px, 94vw)" in rd("src", "styles.css")
             and "flex-wrap: wrap" in rd("src", "styles.css")
             and "mssql-connect-form" in ld),
            ("flatten json + export tab wired (browse in / out folder / run)",
             "flattenStart" in rd("src", "lib", "api.ts")
             and "/api/flatten/start" in rd("src", "lib", "api.ts")
             and "Flatten JSON and Export" in ld and "FlattenLoadTab" in ld
             and "pickFolder" in ld),
            ("reconcile modal: no horizontal scroll + green native accents",
             ".rc-row > *" in rd("src", "styles.css")
             and ".rc-config .field select" in rd("src", "styles.css")
             and rd("src", "styles.css").count("accent-color: var(--accent)")
             >= 2),
            ("save result as a table wired (button + materialize endpoint)",
             "materializeResult" in rd("src", "lib", "api.ts")
             and "/materialize" in rd("src", "lib", "api.ts")
             and "doSaveResultAsTable" in app and "Save as table" in app),
            ("bulk-load a folder wired (load/folder endpoint + browse button)",
             "loadFolderStart" in rd("src", "lib", "api.ts")
             and "/api/load/folder" in rd("src", "lib", "api.ts")
             and "beginLoadFolder" in background_controller
             and "beginLoadFolder" in app
             and "onBeginLoadFolder" in ld and "Load a folder" in ld),
            ("session restore wired (frontend reacts to restoring flag)",
             "restoring" in rd("src", "lib", "types.ts")
             and "h.restoring" in app and "Session restored" in app),
            ("NodeFlow tab + canvas wired (view, run/export, ports, wiring)",
             "NodeFlow" in app and 'view === "nodeflow"' in app
             and "nodeflowRun" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/run" in rd("src", "lib", "api.ts")
             and "nb2-canvas" in _read_nodebook_source()
             and "startWire" in _read_nodebook_source()),
            ("NodeFlow phase 2 wired (join/union/select, drag-drop, columns)",
             "nodeflowColumns" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/columns" in rd("src", "lib", "api.ts")
             and "left_only" in _read_nodebook_source()
             and "application/x-nb-node" in _read_nodebook_source()
             and "nb2-field-type" in _read_nodebook_source()),
            ("NodeFlow phase 3 wired (formula + summarize nodes)",
             '"formula"' in _read_nodebook_source()
             and '"summarize"' in _read_nodebook_source()
             and "setFormulas" in _read_nodebook_source()
             and "ColumnPicker" in _read_nodebook_source()
             and "nb2-agg-func" in _read_nodebook_source()),
            ("NodeFlow phase 4 wired (pivot/chart/reconcile nodes)",
             "nodeflowChart" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/chart" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/reconcile" in rd("src", "lib", "api.ts")
             and '"pivot"' in _read_nodebook_source()
             and '"reconcile"' in _read_nodebook_source()
             and "doChart" in _read_nodebook_source()
             and "ChartView" in _read_nodebook_source()
             and "nb2-recon" in _read_nodebook_source()),
            ("NodeFlow v5 wired (sort/sample/unique/unpivot/window/browse)",
             "/api/nodeflow/browse" in rd("src", "lib", "api.ts")
             and "nodeflowBrowse" in rd("src", "lib", "api.ts")
             and '"sort"' in _read_nodebook_source()
             and '"unpivot"' in _read_nodebook_source()
             and '"window"' in _read_nodebook_source()
             and "setWindows" in _read_nodebook_source()
             and "doProfile" in _read_nodebook_source()
             and "nb2-window" in _read_nodebook_source()),
            ("NodeFlow status bar + cancel + saved workflows wired",
             "workflowsList" in rd("src", "lib", "api.ts")
             and "/api/workflows" in rd("src", "lib", "api.ts")
             and "cancelRun" in _read_nodebook_source()
             and ("cancelQuery" in _read_nodebook_source()
                  or "cancelOne" in _read_nodebook_source()
                  or "cancelAllRuns" in _read_nodebook_source())
             and "nb2-statusbar" in _read_nodebook_source()
             and "saveWorkflow" in _read_nodebook_source()
             and "openGraphInNewTab" in _read_nodebook_source()
             and "fullGraph" in _read_nodebook_source()),
            ("sidebar groups catalog tables by database (collapsible)",
             "tree-grp-row" in rd("src", "components", "Sidebar.tsx")
             and "groupOpen" in rd("src", "components", "Sidebar.tsx")
             and "renderRow" in rd("src", "components", "Sidebar.tsx")
             and "t.group" in rd("src", "components", "Sidebar.tsx")),
            ("sidebar lazy catalog columns + import wired",
             "catalogColumns" in rd("src", "lib", "api.ts")
             and "/api/catalog/columns" in rd("src", "lib", "api.ts")
             and "catalogImport" in rd("src", "lib", "api.ts")
             and "loadRemoteCols" in rd("src", "components", "Sidebar.tsx")
             and "colsCache" in rd("src", "components", "Sidebar.tsx")
             and "Import into workspace" in rd("src", "components", "Sidebar.tsx")),
            ("NodeFlow create-table + text + node delete menu wired",
             "tableCreate" in rd("src", "lib", "api.ts")
             and "/api/table/create" in rd("src", "lib", "api.ts")
             and "doCreateTable" in _read_nodebook_source()
             and "nb2-textnote-body" in _read_nodebook_source()
             and "nb2-node-menu" in _read_nodebook_source()
             and "Connect two inputs" in _read_nodebook_source()
             and "onTablesChanged" in _read_nodebook_source()),
            ("NodeFlow layout: category palette + arrow ports + zoom + no node-X",
             "NODE_GROUPS" in _read_nodebook_source()
             and "nb2-cats" in _read_nodebook_source()
             and "nb2-cat-sub" in _read_nodebook_source()
             and "openCat" in _read_nodebook_source()
             and "nb2-canvas-scaler" in _read_nodebook_source()
             and "zoomBy" in _read_nodebook_source()
             # zoom is buttons-only now (wheel/trackpad no longer zooms)
             and 'addEventListener("wheel"' not in _read_nodebook_source()
             and "is-empty" in _read_nodebook_source()
             # the per-node delete X is gone (delete via panel or right-click)
             and "nb2-node-x" not in _read_nodebook_source()
             and ".nb2-inspector.is-empty" in rd("src", "styles.css")
             # the config panel floats over the canvas now (was order:-1 flex)
             and "position: absolute" in _block_css(
                 rd("src", "styles.css"), ".nb2-inspector")
             # ports render as arrows (solid left border = right-pointing triangle)
             and "border-left: 14px solid var(--accent)" in rd("src", "styles.css")
             # directory node: folder browse -> pick a file -> read it
             and "directoryRead" in rd("src", "lib", "api.ts")
             and "doReadDirectory" in _read_nodebook_source()
             and "loadDirList" in _read_nodebook_source()
             and "DIR_EXTS" in _read_nodebook_source()
             and '"directory"' in _read_nodebook_source()
             # dashboard node + on-canvas charts
             and '"dashboard"' in _read_nodebook_source()
             and "nb2-dash-pane" in _read_nodebook_source()
             and "ensureChartFor" in _read_nodebook_source()
             and "upstreamChartNode" in _read_nodebook_source()
             and "nb2-node-chart" in _read_nodebook_source()
             and "nodeShowsBody" in _read_nodebook_source()
             and ".nb2-dash-pane" in rd("src", "styles.css")
             and "resize: both" in rd("src", "styles.css")
             # ECharts is the renderer; recharts is gone
             and "echarts" in rd("src", "lib", "echart.ts")
             and "getDataURL" in rd("src", "lib", "echart.ts")
             and "buildOption" in rd("src", "components", "ChartView.tsx")
             and "recharts" not in rd("src", "components", "ChartView.tsx")
             # Output node is type-aware (image vs data) + image export
             and "outputKind" in _read_nodebook_source()
             and "doExportImage" in _read_nodebook_source()
             and "exportImage" in rd("src", "lib", "api.ts")
             # new transform nodes
             and '"bin"' in _read_nodebook_source()
             and '"rank"' in _read_nodebook_source()
             and '"fill"' in _read_nodebook_source()
             and '"dedupe"' in _read_nodebook_source()
             and '"split"' in _read_nodebook_source()
             and "doValidate" in _read_nodebook_source()
             and "nodeflowValidate" in rd("src", "lib", "api.ts")
             and '"appendfolder"' in _read_nodebook_source()
             and "folderRead" in rd("src", "lib", "api.ts")
             and '"group"' in _read_nodebook_source()
             and "groupReorder" in _read_nodebook_source()
             and "childCtx" in _read_nodebook_source()
             and "partialGroupGraph" in _read_nodebook_source()
             and '"multijoin"' in _read_nodebook_source()
             and "nb2-mj-join" in _read_nodebook_source()
             and '"jsonextract"' in _read_nodebook_source()
             and '"explode"' in _read_nodebook_source()
             and '"textclean"' in _read_nodebook_source()
             and '"antijoin"' in _read_nodebook_source()
             and '"groupconcat"' in _read_nodebook_source()
             and '"date"' in _read_nodebook_source()
             and '"maprecode"' in _read_nodebook_source()
             and '"parse"' in _read_nodebook_source()
             and '"topn"' in _read_nodebook_source()
             and '"crossjoin"' in _read_nodebook_source()
             and '"coalesce"' in _read_nodebook_source()
             and '"renamecols"' in _read_nodebook_source()
             and "palSearch" in _read_nodebook_source()
             and "nb2-pal-search" in rd("src", "styles.css")
             and "setAllFieldsKept" in _read_nodebook_source()),
            ("NodeFlow SQL/write nodes + run-all + undo/redo + minimap wired",
             "nodeflowToTable" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/write" in rd("src", "lib", "api.ts")
             and '"sql"' in _read_nodebook_source()
             and '"write"' in _read_nodebook_source()
             and "doWriteTable" in _read_nodebook_source()
             and "runAll" in _read_nodebook_source()
             and "const undo" in _read_nodebook_source()
             and "const redo" in _read_nodebook_source()
             and "nb2-minimap" in _read_nodebook_source()
             and "{{in}}" in _read_nodebook_source()),
            ("run-all batches file outputs through the shared-pass endpoint",
             "nodeflowExportMany" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/export-many" in rd("src", "lib", "api.ts")
             and "doExportBatch" in _read_nodebook_source()
             and "nodeflowExportMany" in _read_nodebook_source()
             and "eachAlone" in _read_nodebook_source()),
            # ---- this build (.110) ----
            ("join node exposes three outputs (left-only / inner / right-only)",
             '["left_only", "inner", "right_only"]'
             in _read_nodebook_source()
             and "migrateJoinEdges" in _read_nodebook_source()
             and 'doPreview(sel, "left_only"' in _read_nodebook_source()
             and 'doPreview(sel, "right_only"' in _read_nodebook_source()),
            ("filter node has simple field/operator + custom-logic editor",
             "buildFilterCond" in _read_nodebook_source()
             and "filterMode" in _read_nodebook_source()
             and "nb2-filter-toggle" in _read_nodebook_source()
             and "filterPickField" in _read_nodebook_source()
             and "nb2-filter-area" in rd("src", "styles.css")),
            ("formula palette has regex templates + parameter signatures",
             "regexp_matches" in _read_nodebook_source()
             and "regexp_replace" in _read_nodebook_source()
             and "sig:" in _read_nodebook_source()
             and "nb2-fx-sig" in _read_nodebook_source()
             and "fxHint" in _read_nodebook_source()),
            ("formula × button sits outside the box + survives resize",
             "width: calc(100% - 36px)" in rd("src", "styles.css")
             and "resize: vertical" in rd("src", "styles.css")),
            ("running query shows a red Stop that cancels (not supersede)",
             "run-progress" in app
             and "onClick={cancelRunning}" in app
             and "Restart / supersede" not in app),
            ("error log wired (settings entry + modal + Diagnostics tab + API + export)",
             "ErrorLogModal" in app and "errorLogOpen" in app
             and "Error log" in app
             and "Diagnostics…" not in app
             and "DiagnosticsPanel" in rd("src", "components", "ErrorLogModal.tsx")
             and 'tab === "diagnostics"' in rd("src", "components", "ErrorLogModal.tsx")
             and "errors:" in rd("src", "lib", "api.ts")
             and "/api/errors" in rd("src", "lib", "api.ts")
             and "errlog-tb" in rd("src", "components", "ErrorLogModal.tsx")
             and "errlog-kind" in rd("src", "components", "ErrorLogModal.tsx")
             and "samql-error-log-" in rd("src", "components", "ErrorLogModal.tsx")
             and "_log_soft_result_error" in open(
                 os.path.join(BACKEND, "server.py"),
                 encoding="utf-8").read()),
            ("saved workflows: 3-section panel + kind-aware save/load (IDE/Journal/Node)",
             "Saved Workflows" in sb and "WorkflowsPanel" in sb
             and "onLoadWorkflow" in sb and "onDeleteWorkflow" in sb
             and "wf-section" in sb
             and "saveIdeWorkflow" in workspace_controller
             and "refreshWorkflows" in workspace_controller
             and "onLoadWorkflow" in workspace_controller
             and "journalLoad" in workspace_controller
             and "nodeLoad" in workspace_controller
             and "useWorkspaceController" in app
             and '"ide" | "journal" | "node"' in rd("src", "lib", "api.ts")
             and "saveAsWorkflow" in nb and "loadRequest" in nb
             and "loadRequest" in _read_nodebook_source()
             and "onWorkflowsChanged" in _read_nodebook_source()),
            ("save as / open to disk wired (file browser + envelope, all 3 views)",
             "saveFile" in rd("src", "lib", "api.ts")
             and "openFile" in rd("src", "lib", "api.ts")
             and "wfEnvelope" in rd("src", "lib", "workflowFile.ts")
             and "parseWfFile" in rd("src", "lib", "workflowFile.ts")
             and "saveMode" in _load_data_source()
             and "fb-savename" in _load_data_source()
             and "openWorkflowContent" in workspace_controller
             and "ideFile" in workspace_controller
             and "wfEnvelope" in app
             and "onPickJournalFile" in nb
             and "onPickNodeFile" in _read_nodebook_source()
             and "nodeFileModal" in _read_nodebook_source()),
            ("save/save-as/open live in sidebar + settings (not the toolbar); export added to menus",
             # Settings Open / Save routes via workspace controller (sidebar wf-actions retired)
             'data-testid="settings-open"' in app
             and "Open / Save" in app
             and "activeSave" in workspace_controller
             and "activeSaveAs" in workspace_controller
             and "activeOpen" in workspace_controller
             and "useWorkspaceController" in app
             and "Save to Saved Workflows" not in app
             and "Save this SQL to a file on your computer" not in app
             and "lastJournalCmd" in nb
             and "lastNodeCmd" in _read_nodebook_source()
             and ("ExportResultsButton" in app or "exportResultTab" in app)
             and "exportResultTab" in app
             and "onExportResults" in rd("src", "components", "DataGrid.tsx")),
            ("saved-workflows action buttons wrap (don't clip off-panel)",
             (lambda css: "flex-wrap: wrap" in css[
                 css.find(".wf-actions-row {"):
                 css.find("}", css.find(".wf-actions-row {"))]
             )(rd("src", "styles.css"))),
            ("node canvas: hide-toolbar toggle + right-click Nodes cascade (category -> node)",
             (lambda nbk, css: (
                 "paletteHidden" in nbk and "onTogglePalette" in nbk
                 and "nb2-hidden" in nbk
                 and "nodesOpen" in nbk and "categoryOpen" in nbk
                 and "nb2-cm-sub" in nbk and "NODE_GROUPS" in nbk
                 and "nb2-cm-sub" in css and "nb2-hidden" in css
             ))(_read_nodebook_source(), rd("src", "styles.css"))),
            ("node cascade: nested flyout not clipped (scroll lives on the leaf)",
             (lambda nbk, css: (
                 # the leaf (node list) flyout is the one marked scrollable
                 "nb2-cm-leaf" in nbk
                 and "overflow-y: auto" in css[
                     css.find(".nb2-cm-sub.nb2-cm-leaf"):
                     css.find("}", css.find(".nb2-cm-sub.nb2-cm-leaf"))]
                 # the intermediate .nb2-cm-sub rule must NOT clip, or it hides
                 # the next cascade level positioned at left/right:100%
                 and "overflow-y: auto" not in css[
                     css.find(".nb2-cm-sub {"):
                     css.find("}", css.find(".nb2-cm-sub {"))]
             ))(_read_nodebook_source(), rd("src", "styles.css"))),
            ("node ports: arrows sit on the node edge, output red, with a shadow",
             (lambda css: (
                 "left: -14px" in css[
                     css.find(".nb2-port.in {"):
                     css.find("}", css.find(".nb2-port.in {"))]
                 and "right: -14px" in css[
                     css.find(".nb2-port.out {"):
                     css.find("}", css.find(".nb2-port.out {"))]
                 and "drop-shadow" in css[
                     css.find(".nb2-dot {"):
                     css.find("}", css.find(".nb2-dot {"))]
                 and "#e5484d" in css[
                     css.find(".nb2-port.out .nb2-dot {"):
                     css.find("}", css.find(".nb2-port.out .nb2-dot {"))]
             ))(rd("src", "styles.css"))),
            ("node/journal load requests are cleared after consuming (no replay on view re-mount)",
             # children signal consumption...
             "onLoadConsumed?.()" in _read_nodebook_source()
             and "onLoadConsumed?.()" in rd("src", "components", "Notebook.tsx")
             # ...and App clears the one-shot request so a re-mount can't replay it
             and "onLoadConsumed={() => setNodeLoad(null)}" in app
             and "onLoadConsumed={() => setJournalLoad(null)}" in app),
            # .469 repoint: the mark now tries BOTH custom names
            # (app-icon.png first, then logo.png) before the letter.
            # .475: the mark sits in a clipping box and is upscaled so its
            # transparent margin is cropped -- the glyph fills the footprint
            # instead of floating in whitespace.
            ("top-bar logo uses the custom art (clip-box, no whitespace) "
             "with a lettered-badge fallback",
             '["/app-icon.png", "/logo.png"]' in app
             and 'className="mark-img"' in app
             and 'className="mark-img-wrap"' in app
             and "onError={() => setSrcIdx((i) => i + 1)}" in app
             and ".mark-img-wrap" in rd("src", "styles.css")),
            ("settings menu scrolls on short screens (max-height + overflow-y)",
             (lambda css: (lambda blk: "max-height" in blk and "overflow-y" in blk)(
                 css[css.find(".settings-menu {"):css.find("}", css.find(".settings-menu {"))]
             ))(rd("src", "styles.css"))),
            ("maintenance: clear temp files wired to /api/maintenance/sweep-temp",
             "Clear temp files" in rd("src", "components", "StorageMemoryModal.tsx")
             and "api.sweepTemp()" in rd("src", "components", "StorageMemoryModal.tsx")
             and "/api/maintenance/sweep-temp" in rd("src", "lib", "api.ts")),
            ("view: node-toolbar toggle shared between Settings and the canvas",
             "Show node toolbar" in app and "Hide node toolbar" in app
             and "paletteHidden={nodeToolbarHidden}" in app
             and "onTogglePalette={() => setNodeToolbarHidden" in app
             and "onClick={onTogglePalette}" in _read_nodebook_source()
             # the old internal palette state is gone (App owns it now)
             and "setPaletteHidden" not in _read_nodebook_source()),
            ("drag-and-drop file load: overlay + how-to-load prompt -> background job + Cancel",
             'addEventListener("drop"' in app
             and "drop-overlay" in app
             and "dropFiles" in app
             and "doDropLoad" in app
             # drag-drop now loads in the background so it can be cancelled
             and "api.loadFilesStart(" in app
             and ".drop-overlay" in rd("src", "styles.css")
             # background loader + cancel routes exist in api.ts
             and "/api/load/files-start" in rd("src", "lib", "api.ts")
             and "loadCancel:" in rd("src", "lib", "api.ts")
             and "destination = \"auto\"" in rd("src", "lib", "api.ts")
             # the loading progress modal offers a Cancel button -> loadCancel
             # a dropped load is cancellable from its activity-tray card
             and "api.loadCancel(" in rd("src", "components", "ActivityShared.tsx")),
            ("REST API tab: params editor + JSON preview + Fetch/Load + profiles",
             (lambda ld: (
                 "api-tab" in ld and "api-left" in ld and "api-right" in ld
                 and "buildApiUrl" in ld
                 and "addParam" in ld and "removeParam" in ld
                 and "api.apiPreview" in ld          # Fetch previews
                 and "doLoad" in ld and "api.apiFetch" in ld  # Load imports
                 and "API_PROFILES_KEY" in ld
                 and "saveProfile" in ld and "deleteProfile" in ld
             ))(_load_data_source())
             and "apiPreview" in rd("src", "lib", "api.ts")
             and "/api/api-preview" in rd("src", "lib", "api.ts")
             and ".api-tab {" in rd("src", "styles.css")),
            ("SamQL wordmark: QL rendered in TD green (accent)",
             'className="ql">QL</span>' in app
             and (lambda css: (lambda blk: "var(--accent)" in blk)(
                 css[css.find(".brand .ql"):css.find("}", css.find(".brand .ql"))]
             ))(rd("src", "styles.css"))),
            ("file load delimiter: input in file tab + drag-drop, threaded to API",
             "Delimiter (CSV / text files)" in _load_data_source()
             and "delim.trim()" in _load_data_source()
             and "dropDelim" in app and "dropDelim.trim()" in app
             and "Delimiter (CSV / text)" in app
             and 'form.append("delimiter"' in rd("src", "lib", "loadForm.ts")
             and rd("src", "lib", "api.ts").count("buildLoadForm(files, {") == 2),
            ("saved passwords: opt-in encrypted (DPAPI) checkbox in SQL + API tabs",
             (lambda ld: (
                 "Save password (encrypted)" in ld
                 and "secretsOk" in ld
                 and '"api:"' in ld and '"mssql:"' in ld
                 and "api.secretSet(" in ld and "api.secretDelete(" in ld
                 and "savePassword" in ld
             ))(_load_data_source())
             and "/api/secrets/set" in rd("src", "lib", "api.ts")
             and "secretSet" in rd("src", "lib", "api.ts")),
            ("charts: multi-Y axis + gradient tree + rounded/large variants wired",
             (lambda nb, cp, co: (
                 '<option value="multiy">' in nb and '<option value="tree">' in nb
                 and 'patchStyle(sel, "rounded"' in nb
                 and 'patchStyle(sel, "large"' in nb
                 and 'v: "multiy"' in cp and 'v: "tree"' in cp
                 and 'patchStyle("rounded"' in cp and 'patchStyle("large"' in cp
                 and 'ct === "multiy"' in co and 'ct === "tree"' in co
                 and 'sampling = "lttb"' in co and "borderRadius" in co
             ))(_read_nodebook_source(),
                rd("src", "components", "ChartPanel.tsx"),
                rd("src", "lib", "chartOption.ts"))),
            ("flatten export: background job + inline progress bar wired",
             (lambda md, ap: (
                 "flattenStart" in md and "flattenProgress" in md
                 and "flatten-progress" in md
                 and "/api/flatten/start" in ap
                 and "/api/flatten/progress" in ap
             ))(_load_data_source(),
                rd("src", "lib", "api.ts"))),
            ("pivot node: multi-column + measures list + subtotals wired",
             (lambda nb: (
                 "Rows (drag to reorder)" in nb
                 and "Columns (drag to reorder)" in nb
                 and "Measures (drag to reorder)" in nb
                 and "Add measure" in nb
                 and "Subtotals &amp; grand totals" in nb
                 and "Indented sub-rows (outline)" in nb
                 and "function ReorderList" in nb
                 and "+ Add row field" in nb
             ))(_read_nodebook_source())),
            ("edge delete badge: clickable (hover-revealed), no confirm",
             (lambda nbk, css: (
                 "nb2-wire-del-hit" in nbk
                 and "nb2-wire-del-dot" in nbk
                 and "Delete connection" in nbk
                 and "onDelete(w.id)" in nbk
                 and ".nb2-wire:hover .nb2-wire-del" in css
                 and ".nb2-wire-del-hit" in css
             ))(_read_nodebook_source(),
                rd("src", "styles.css"))),
            ("tables panel: column icon pinned + long field names wrap",
             (lambda css: (
                 ".tree-col > svg" in css
                 and "overflow-wrap: anywhere" in css
                 and ".tree-col .fname" in css
             ))(rd("src", "styles.css"))),
            ("nodebook: redundant status-bar Cancel button removed",
             (lambda nbk: (
                 "nb2-cancel" not in nbk
                 and "Stop the running workflow" in nbk  # tabbar Stop remains
             ))(_read_nodebook_source())),
            ("nodebook: cancel-requested guard suppresses spurious cancel error",
             (lambda nbk: (
                 "cancelRequested" in nbk
                 and "const wasCancelled" in nbk
                 and "wasCancelled(r, id)" in nbk
             ))(_read_nodebook_source())),
            ("nodebook: custom in-canvas delete confirm (not window.confirm)",
             (lambda nbk, css: (
                 "setDelConfirm" in nbk
                 and "doRemoveNode" in nbk
                 and "nb2-delconfirm" in nbk
                 and 'Delete this node? This can' not in nbk  # old browser confirm gone
                 and ".nb2-delconfirm" in css
             ))(_read_nodebook_source(),
                rd("src", "styles.css"))),
            ("group node: multi-input ports + per-step input binding UI",
             (lambda nbk, css, nf: (
                 'group: { inputs: ["in", "in2"' in nbk
                 and "Step inputs" in nbk
                 and "nb2-grpbind" in nbk
                 and "setBind" in nbk
                 and "{ bindings: next }" in nbk
                 and ".nb2-grpbind" in css
                 # backend: group declares the extra ports + reads bindings
                 and '"group": {"in": ["in", "in2"' in nf
                 and 'bindings = cfg.get("bindings")' in nf
             ))(_read_nodebook_source(),
                rd("src", "styles.css"),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read())),
            ("node ports: centered triangles + bigger arrows + red output hover",
             (lambda nbk, css: (
                 # ports centered as a block (rendering + wire geometry share it)
                 "function portTopOffset" in nbk
                 and "nodeHeight(n) / 2" in nbk
                 and "top: portTopOffset(" in nbk
                 and 'style={{ top: portTopOffset(node, "out", index) }}' in nbk
                 # bigger arrow
                 and "border-left: 14px solid var(--accent)" in css
                 # hover brightens in the port's own colour, not the green accent
                 and ".nb2-port.out:hover .nb2-dot" in css
                 and "#f2555a" in css
                 and ".nb2-port:hover .nb2-dot {\n  background" not in css
             ))(_read_nodebook_source(),
                rd("src", "styles.css"))),
            ("group node: step reorder works both up and down (position-aware)",
             (lambda nbk: (
                 "to?: number" in nbk
                 and ("d.to =" in nbk or "drag.to =" in nbk)
                 and ("r.top + r.height / 2" in nbk
                      or "rect.top + rect.height / 2" in nbk)
                 and ("groupReorder(n.id, d.from, d.to ?? i)" in nbk
                      or "groupReorder(node.id, drag.from, drag.to ?? index)" in nbk)
                 and ("d.to ?? (n.config.children || []).length" in nbk
                      or "drag.to ?? (node.config.children || []).length" in nbk)
             ))(_read_nodebook_source())),
            ("group node: dynamic input ports (connected + 1 spare; wires track)",
             (lambda nbk: (
                 "function visibleInputCount" in nbk
                 and 'n.type !== "group"' in nbk
                 and "Math.max(1, maxIdx + 2)" in nbk
                 # render only the visible ports, centred with that count
                 and (".slice(0, nIn)" in nbk
                      or ".slice(0, visibleInputCount)" in nbk)
                 and ('portTopOffset(n, "in", i, left.length)' in nbk
                      or "leftPorts.length" in nbk)
                 # wire endpoints + snap use the same indexed visible count
                 and ("visibleInputCount(tn, edges)" in nbk
                      or "visibleInputCountByNode[toNode.id]" in nbk)
                 and "visibleInputCount(node, edges)" in nbk
             ))(_read_nodebook_source())),
            ("variable node: palette + inspector + body + backend substitution",
             (lambda nbk, css, av, nf: (
                 # frontend: port-less node, palette entry, inspector + body
                 "variable: { inputs: [], outputs: [] }" in nbk
                 and 'variable: define("variable", "Variable", "Variable"' in nbk
                 and 'inspectorType === "variable"' in nbk
                 and 'n.type === "variable"' in nbk
                 and "nb2-var-chip" in css
                 # backend: substitution engine + node registered, no handler
                 and "def resolve_graph" in av
                 and "def collect_vars" in av
                 and '"variable": {"in": [], "out": []}' in nf
             ))(_read_nodebook_source(),
                rd("src", "styles.css"),
                open(os.path.join(BACKEND, "samql_core", "applyvars.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read())),
            ("write node: overwrite/append mode + idempotent replace-by-key",
             (lambda nbk, ss: (
                 # frontend: the mode select + the replace-key picker
                 'value={sel.config.mode || "overwrite"}' in nbk
                 and '>Append (add rows)<' in nbk
                 and "replace_keys" in nbk
                 # backend: shared write helper (overwrite/append + idempotent)
                 and "def _write_into_table" in ss
                 and 'mode == "overwrite" or not _exists' in ss
                 and "INSERT INTO" in ss
                 and "SELECT DISTINCT" in ss
             ))(_read_nodebook_source(),
                open(os.path.join(BACKEND, "samql_core", "session.py"),
                     encoding="utf-8").read())),
            ("filebrowser node: palette + inspector + ports + DuckDB glob reader",
             (lambda nbk, nf: (
                 # frontend: palette entry, port-less source, inspector + pattern
                 'filebrowser: define("filebrowser", "File browser", "FolderSearch"' in nbk
                 and "filebrowser: { inputs: [], outputs: [\"out\"] }" in nbk
                 and 'inspectorType === "filebrowser"' in nbk
                 and "{ pattern: e.target.value }" in nbk
                 and 'case "filebrowser":' in nbk
                 # backend: DuckDB glob reader + provenance + DuckDB-only guard
                 and 'typ == "filebrowser"' in nf
                 and "read_csv_auto('%s', filename=true, union_by_name=true)" in nf
                 and "RENAME (filename AS %s)" in nf
                 and '"filebrowser": {"in": [], "out": ["out"]}' in nf
             ))(_read_nodebook_source(),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read())),
            ("API node: palette + inspector + fetch action + secret store + backend",
             (lambda nbk, apit, nf, ss, srv: (
                 # frontend: palette, port-less source, inspector + fetch + secret
                 'apinode: define("apinode", "API", "Cloud"' in nbk
                 and 'apinode: { inputs: [], outputs: ["out", "err"] }' in nbk
                 and 'inspectorType === "apinode"' in nbk
                 and "doFetchApi(sel)" in nbk
                 and "api.secretSet(key, apiPwDraft)" in nbk
                 and "continue_on_error: e.target.checked" in nbk
                 and "retries: Math.max(" in nbk
                 and "nodeApiFetch:" in apit
                 # backend: node SQL source, ports, fetch method, route
                 and 'typ == "apinode"' in nf
                 and '"apinode": {"in": [], "out": ["out", "err"]}' in nf
                 and 'if port == "err"' in nf
                 and "def fetch_api_node" in ss
                 and "self.secrets.get(sk)" in ss
                 and 'retry=cfg.get("retry")' in ss
                 and "/api/node-api-fetch" in srv
             ))(_read_nodebook_source(),
                rd("src", "lib", "api.ts"),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "samql_core", "session.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "server.py"),
                     encoding="utf-8").read())),
            ("iterator node: palette + inspector + run + drivers + backend loop",
             (lambda nbk, apit, nf, ss, srv: (
                 # frontend: palette, input-only controller, inspector + run
                 'iterator: define("iterator", "Iterator", "Repeat"' in nbk
                 and 'iterator: { inputs: ["vars", "in"], outputs: ["out"] }' in nbk
                 and 'inspectorType === "iterator"' in nbk
                 and "doRunIterator(sel)" in nbk
                 and "dissolveContainer(sel.id)" in nbk  # container: expand to canvas
                 and "iteratorRun:" in apit
                 and 'n.type === "iterator"' in nbk     # runAll dispatch + body
                 # backend: loop + drivers + accumulator + route + handler
                 and "def run_iterator" in ss
                 and "def _iterator_values" in ss
                 and "def _daterange_values" in ss
                 and "def _row_values" in ss        # rows driver reader
                 and 'elif kind == "rows"' in ss
                 and "_api_nodes_upstream" in ss
                 and 'typ == "iterator"' in nf
                 and '"iterator": {"in": ["vars", "in"], "out": ["out"]}' in nf
                 and "/api/iterator/run" in srv
             ))(_read_nodebook_source(),
                rd("src", "lib", "api.ts"),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "samql_core", "session.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "server.py"),
                     encoding="utf-8").read())),
            ("while/until controller + reduce-fold accumulator: FE + backend",
             (lambda nbk, apit, nf, ss, srv: (
                 # frontend: palette, inspector, run button, api binding
                 'while: define("while", "Repeat until", "RotateCw"' in nbk
                 and 'while: { inputs: ["in"], outputs: [] }' in nbk
                 and 'inspectorType === "while"' in nbk
                 and "doRunWhile(sel)" in nbk
                 and "whileRun:" in apit
                 and 'n.type === "while"' in nbk        # runAll dispatch + body
                 # reduce-fold accumulator controls (shared by both inspectors)
                 and "renderReduceControls" in nbk
                 and 'value="reduce"' in nbk
                 # backend: controller loop, fold helper, ports, route, handler
                 and "def run_while" in ss
                 and "def _reduce_accumulator" in ss
                 and 'accumulate == "reduce"' in ss
                 and "_flow_cache_clear()" in ss        # per-iteration freshness
                 and 'typ == "while"' in nf
                 and '"while": {"in": ["in"], "out": []}' in nf
                 and "/api/while/run" in srv
                 and "def while_run" in srv
             ))(_read_nodebook_source(),
                rd("src", "lib", "api.ts"),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "samql_core", "session.py"),
                     encoding="utf-8").read(),
                open(os.path.join(BACKEND, "server.py"),
                     encoding="utf-8").read())),
            ("select node: drag-reorder fields (preserve-order reconcile + patch)",
             (lambda nbk, sf: (
                 'inspectorType === "select"' in nbk
                 and "<ReorderList" in nbk
                 and "onChange={(next) => patch(sel.id, { fields: next })}" in nbk
                 # reconcile must keep the user's order and append new cols last
                 and "for (const f of current || [])" in sf
                 and ("append columns that are newly available upstream" in sf
                      or "append columns that are genuinely new upstream" in sf)
             ))(_read_nodebook_source(),
                rd("src", "lib", "selectFields.ts"))),
            ("reorder controls: ColumnPicker + ReorderList across list nodes",
             (lambda nbk: (
                 "function ColumnPicker" in nbk
                 and "<ColumnPicker" in nbk
                 # summarize: group-by picker + aggregations reorder
                 and "patch(sel.id, { group_by: next })" in nbk
                 and "onChange={(next) => setAggs(next)}" in nbk
                 # sort keys reorder (priority order)
                 and "onChange={(next) => setSorts(next)}" in nbk
                 # coalesce precedence + group-concat / top-N groups
                 and "patch(sel.id, { cols: next })" in nbk
                 and "patch(sel.id, { group: next })" in nbk
             ))(_read_nodebook_source())),
            ("filter/formula expressions: portable IF + bare-condition palette",
             (lambda nbk, nfsrc: (
                 # FX palette offers IF (and CASE) as insertable conditionals
                 "IF([], '', '')" in nbk
                 and "FX_FUNCS" in nbk
                 # backend rewrites IF -> CASE and shares one expression prep
                 and "def _if_to_case" in nfsrc
                 and "def _prepare_expr" in nfsrc
                 and "CASE WHEN (%s) THEN (%s) ELSE (%s) END" in nfsrc
                 # both filter and formula run user text through the shared prep
                 and nfsrc.count("_prepare_expr(") >= 3
             ))(_read_nodebook_source(),
                open(os.path.join(BACKEND, "samql_core", "nodeflow.py"),
                     encoding="utf-8").read())),
            ("inspector columns don't blank on keystroke (flicker fix)",
             (lambda nbk: (
                 # input columns are cleared only when the selected node changes
                 # (deps may include scopeKey; probing lines can sit between)
                 (("setInspCols({});" in nbk and "}, [selId]);" in nbk)
                  or ("setInputColumns({});" in nbk
                      and "}, [scopeKey, selId]);" in nbk))
                 and "blanked every column-derived list" in nbk
                 # ...never at the top of the fetch effect, which re-ran on every
                 # keystroke and blanked the column-derived lists (the flicker)
                 and "setInspCols({});\n    if (!sel) return;" not in nbk
                 and "setInputColumns({});\n    if (!sel) return;" not in nbk
             ))(_read_nodebook_source())),
            ("group child inspector resolves every input port (binding + step-above)",
             (lambda nbk: (
                 "config.bindings || {})" in nbk
                 and "groupReqs" in nbk
                 and "stepAbovePort" in nbk
                 and "binds[port] ||" in nbk
             ))(_read_nodebook_source())),
            ("reconcile report is exportable to CSV (ReconReport + App wired)",
             (lambda rr, app: (
                 "Export CSV" in rr
                 and "reconReportCsv" in rr
                 and "onExport(reconCsvFilename" in rr
                 and "onExport={(filename, csv) => {" in app
                 and "saveToDownloads(filename, { text: csv })" in app
             ))(rd("src", "components", "ReconReport.tsx"),
                rd("src", "App.tsx"))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "UI features not wired: " + ", ".join(missing))

    def t_ui_no_debug_statements():
        bad = []
        for f in _iter_src_files():
            if not f.endswith((".ts", ".tsx")):
                continue
            txt = open(f, encoding="utf-8").read()
            if re.search(r"\bconsole\.log\(", txt) or re.search(
                    r"\bdebugger\b", txt):
                bad.append(os.path.relpath(f, FRONTEND))
        need(not bad, "stray console.log/debugger in: " + ", ".join(bad))

    def t_repo_hygiene():
        # samql_txt/ holds the published full-source .txt for handoff;
        # it is intentional and tracked. Root-level Tee copies of the
        # same file remain gitignored.
        def helper_path(defanged, normal):
            first = os.path.join(ROOT, defanged)
            return first if os.path.isfile(first) else os.path.join(ROOT, normal)

        expand = helper_path("Expand-SamQL.ps1", "Expand-SamQL.ps1")
        runps = helper_path("Run-SamQLTests.ps1", "Run-SamQLTests.ps1")
        need(os.path.isfile(expand), "Expand-SamQL helper missing at repo root")
        need(os.path.isfile(runps), "Run-SamQLTests helper missing at repo root")
        etext = open(expand, encoding="utf-8").read()
        # the reconstruct script must match the bundle's header delimiter
        need("===== FILE:" in etext,
             "Expand-SamQL.ps1 must parse the '===== FILE:' bundle headers")
        need("$dangerousExtensionPattern" in etext
             and "[regex]::Replace($raw" in etext
             and "$raw.Replace($fang" not in etext,
             "Expand-SamQL.ps1 must only un-defang declared dangerous "
             "extensions before splitting")
        need("Get-BundleBuild" in etext
             and "SortKey = Get-BuildSortKey" in etext
             and "Replace it exactly" in etext
             and "$managedRelRoots" in etext
             and "Pruned $($staleFiles.Count) obsolete managed source" in etext
             and "obsolete managed source remains" in etext
             and "Expanded identity check passed" in etext
             and "frontend\\public" in etext
             and "Created empty frontend" in etext,
             "Expand-SamQL.ps1 must select the newest build, prohibit "
             "partial upgrades, prune retired managed source files, "
             "create empty frontend/public for brand assets, and "
             "verify the extracted source identity")
        # npm lockfile v3 has a legal empty-string packages key. Windows
        # PowerShell 5.1 ConvertFrom-Json rejects that key, so the expander
        # must extract the two version fields without deserializing the lock.
        lock_json = json.load(open(os.path.join(
            FRONTEND, "package-lock.json"), encoding="utf-8"))
        need("" in lock_json.get("packages", {}),
             "package-lock fixture no longer exercises the empty root key")
        lock_convert = re.search(
            r"\$lock\s*=.*?ConvertFrom-Json", etext, re.S)
        need(lock_convert is None
             and "$lockVersionMatch = [regex]::Match" in etext
             and "$lockRootVersionMatch = [regex]::Match" in etext
             and "Windows PowerShell 5.1 ConvertFrom-Json rejects" in etext,
             "Expand-SamQL.ps1 must not deserialize npm package-lock.json "
             "with Windows PowerShell 5.1 ConvertFrom-Json")
        rtext = open(runps, encoding="utf-8").read()
        need("run_tests.py" in rtext,
             "Run-SamQLTests.ps1 must invoke tests/run_tests.py")
        # build/iteration label present and in sync between code and VERSION
        from samql_core import BUILD
        need(isinstance(BUILD, str) and BUILD.strip(), "BUILD is empty")
        vpath = os.path.join(ROOT, "VERSION")
        need(os.path.isfile(vpath), "VERSION file missing at repo root")
        vtext = open(vpath, encoding="utf-8").read()
        need(BUILD in vtext,
             f"VERSION file does not mention the current build {BUILD!r}")

        # A current full-source release is an exact managed tree, not merely
        # an overwrite. The bootstrap prune must run even when this release
        # was reconstructed by an older expander that did not yet delete
        # retired files.
        manifest = os.path.join(ROOT, "SOURCE_MANIFEST.txt")
        prune_tool = os.path.join(ROOT, "tools", "prune_stale_source.py")
        all_runner = _root_script("Test-SamQL-All.ps1")
        need(os.path.isfile(manifest), "SOURCE_MANIFEST.txt missing")
        need(os.path.isfile(prune_tool), "managed-source prune tool missing")
        runner_text = open(all_runner, encoding="utf-8").read()
        need("Pruning obsolete managed source files" in runner_text
             and "tools\\prune_stale_source.py" in runner_text
             and "SOURCE_MANIFEST.txt" in runner_text,
             "Test-SamQL-All.ps1 must prune stale managed source before tests")

        listed = {line.strip().replace("\\", "/")
                  for line in open(manifest, encoding="utf-8")
                  if line.strip() and not line.lstrip().startswith("#")}
        need("SOURCE_MANIFEST.txt" in listed
             and "tools/prune_stale_source.py" in listed
             and "frontend/src/App.tsx" in listed
             and "tests/run_tests.py" in listed,
             "source manifest is incomplete")

        with tempfile.TemporaryDirectory(prefix="samql_source_prune_") as td:
            fixture_root = os.path.join(td, "repo")
            expected = os.path.join(fixture_root, "frontend", "src",
                                    "App.tsx")
            stale = os.path.join(fixture_root, "frontend", "src", "test",
                                 "server.ts")
            unmanaged = os.path.join(fixture_root, "user-workspace.json")
            os.makedirs(os.path.dirname(expected), exist_ok=True)
            os.makedirs(os.path.dirname(stale), exist_ok=True)
            open(expected, "w", encoding="utf-8").write("export {};\n")
            open(stale, "w", encoding="utf-8").write(
                'import { setupServer } from "msw/node";\n')
            open(unmanaged, "w", encoding="utf-8").write("keep\n")
            sample_manifest = os.path.join(fixture_root,
                                           "SOURCE_MANIFEST.txt")
            open(sample_manifest, "w", encoding="utf-8").write(
                "frontend/src/App.tsx\n")
            proc = subprocess.run(
                [sys.executable, prune_tool, "--root", fixture_root,
                 "--manifest", sample_manifest],
                text=True, capture_output=True, timeout=20)
            need(proc.returncode == 0,
                 "source prune failed: " + proc.stdout + proc.stderr)
            need(os.path.isfile(expected),
                 "source prune removed a manifest-owned file")
            need(not os.path.exists(stale),
                 "source prune left an obsolete managed file")
            need(os.path.isfile(unmanaged),
                 "source prune touched data outside managed roots")

    def t_npm_lock_portability():
        lock_path = os.path.join(FRONTEND, "package-lock.json")
        lock = json.load(open(lock_path, encoding="utf-8"))
        absolute = []
        for package_path, metadata in lock.get("packages", {}).items():
            if not isinstance(metadata, dict):
                continue
            resolved = metadata.get("resolved")
            if (isinstance(resolved, str)
                    and resolved.lower().startswith(("http://", "https://"))):
                absolute.append((package_path, resolved))
        need(not absolute,
             "package-lock.json contains absolute registry URLs: "
             + json.dumps(absolute[:10]))
        package_paths = set(lock.get("packages", {}))
        need("node_modules/msw" not in package_paths
             and "node_modules/require-directory" not in package_paths,
             "lockfile still contains the unused MSW/require-directory chain")
        stale_msw = []
        for f in _iter_src_files():
            if not f.endswith((".ts", ".tsx")):
                continue
            text = open(f, encoding="utf-8").read()
            if ("msw/node" in text or 'from "msw"' in text
                    or "from 'msw'" in text):
                stale_msw.append(os.path.relpath(f, FRONTEND))
        need(not stale_msw,
             "retired MSW imports remain in frontend source: "
             + ", ".join(stale_msw))

        installer = os.path.join(ROOT, "tools", "install_frontend_deps.py")
        need(os.path.isfile(installer),
             "integrity-safe npm installer is missing")
        installer_text = open(installer, encoding="utf-8").read()
        # .608: the ambient-registry restore removed the forced --userconfig
        # isolation so a corporate npmrc / npm_config_registry is respected.
        # The public-registry fallback (OFFICIAL_REGISTRY) and every integrity
        # guard below remain required.
        for marker in ("--prefer-online", "--cache",
                       "EINTEGRITY", "OFFICIAL_REGISTRY",
                       "is_registry_body_failure",
                       "npm recovery succeeded with a fresh isolated cache"):
            need(marker in installer_text,
                 "npm integrity installer missing: " + marker)
        need("--force" not in installer_text
             and "ignore-integrity" not in installer_text,
             "npm installer must never weaken integrity verification")

        tool = os.path.join(ROOT, "tools", "normalize_npm_lock.py")
        need(os.path.isfile(tool), "npm lockfile normalizer is missing")
        fixture = {
            "name": "fixture",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "requires": True,
            "packages": {
                "": {"name": "fixture", "version": "1.0.0"},
                "node_modules/remote": {
                    "version": "2.3.4",
                    "resolved": "https://private.example.invalid/npm/remote/-/remote-2.3.4.tgz",
                    "integrity": "sha512-preserve-me",
                },
                "node_modules/local": {
                    "version": "1.0.0",
                    "resolved": "file:../local-package",
                },
            },
        }
        with tempfile.TemporaryDirectory(prefix="samql_lock_portable_") as td:
            sample = os.path.join(td, "package-lock.json")
            with open(sample, "w", encoding="utf-8") as handle:
                json.dump(fixture, handle, indent=2)
                handle.write("\n")
            proc = subprocess.run(
                [sys.executable, tool, "--write", sample],
                text=True, capture_output=True, timeout=20)
            need(proc.returncode == 0,
                 "lock normalizer failed: " + proc.stdout + proc.stderr)
            got = json.load(open(sample, encoding="utf-8"))
            remote = got["packages"]["node_modules/remote"]
            local = got["packages"]["node_modules/local"]
            need("resolved" not in remote,
                 "absolute registry URL was not removed")
            need(remote.get("version") == "2.3.4"
                 and remote.get("integrity") == "sha512-preserve-me",
                 "normalizer changed pinned version/integrity metadata")
            need(local.get("resolved") == "file:../local-package",
                 "normalizer must preserve local file dependencies")
            check = subprocess.run(
                [sys.executable, tool, "--check", sample],
                text=True, capture_output=True, timeout=20)
            need(check.returncode == 0,
                 "normalized lockfile did not pass --check: "
                 + check.stdout + check.stderr)

    def t_ui_lazy_scroll():
        def rd(*p):
            return open(os.path.join(FRONTEND, *p), encoding="utf-8").read()
        dg = rd("src", "components", "DataGrid.tsx")
        app = rd("src", "App.tsx")
        api_src = rd("src", "lib", "api.ts")
        checks = [
            ("grid exposes onLoadMore", "onLoadMore" in dg),
            ("grid exposes hasMore", "hasMore" in dg),
            ("grid exposes loadingMore", "loadingMore" in dg),
            ("grid triggers near bottom", "scrollHeight" in dg),
            ("App has lazy loader", "loadMoreRows" in app),
            ("App wires onLoadMore to grid", "onLoadMore=" in app),
            ("api.page accepts columns", "columns?: string[]" in api_src),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing, "lazy-scroll wiring missing: " + ", ".join(missing))

    def t_ui_layout():
        # Guards the layout rules that keep the select field-list one-per-row
        # and the data grid's columns/rows correctly sized. (Pixel rendering
        # needs a browser; these lock the CSS/structure that produce it.)
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        css = rd("src", "styles.css")
        dg = rd("src", "components", "DataGrid.tsx")
        nb = _read_nodebook_source()
        app = rd("src", "App.tsx")

        def block(selector):
            m = re.search(r"(?m)^\s*" + re.escape(selector) + r"\s*\{([^}]*)\}",
                          css)
            return m.group(1) if m else ""

        fields = block(".nb2-fields")
        fname = block(".nb2-field-name")
        gc = block(".gc-cell")
        checks = [
            # global border-box so width = the width we set (header == body)
            ("global box-sizing border-box",
             re.search(r"\*\s*\{[^}]*box-sizing:\s*border-box", css)
             is not None),
            # --- select: every field on its own row ---
            ("select field list stacks vertically (one per row)",
             "flex-direction: column" in fields),
            ("select renders one row element per field",
             "(sel.config.fields || []).map(" in nb
             and 'className="nb2-field"' in nb),
            ("long field names clip to their row, not overflow",
             "text-overflow: ellipsis" in fname
             and "white-space: nowrap" in fname
             and "overflow: hidden" in fname),
            # --- data grid: columns the right width, aligned header/body ---
            ("grid header and body cells share the same column width",
             dg.count("width: colWidth(c)") >= 2),
            ("grid body cells clip to the column width",
             "white-space: nowrap" in gc
             and "overflow: hidden" in gc
             and "text-overflow: ellipsis" in gc),
            ("grid header and body cells use matching padding + divider",
             "10px" in block(".gh-cell") and "10px" in gc
             and "border-right: 1px" in block(".gh-cell")
             and "border-right: 1px" in gc),
            # --- data grid: rows a fixed, non-overlapping height ---
            ("grid rows have a fixed height constant",
             re.search(r"const ROW_H\s*=\s*\d+", dg) is not None),
            ("grid body rows are positioned by that fixed height",
             "top: idx * ROW_H" in dg and "height: ROW_H" in dg),
            # --- canvas interaction model ---
            ("left-drag marquee-selects; middle-drag/scroll pans",
             'mode: "marquee"' in nb and 'mode: "pan"' in nb
             and "nb2-marquee" in nb),
            ("marquee box renders (light green rubber band)",
             "position: absolute" in block(".nb2-marquee")),
            ("multi-select supports copy / paste / delete",
             "copySelection" in nb and "pasteClipboard" in nb
             and "deleteMany" in nb and "selIds" in nb),
            ("zoom is buttons-only (no wheel/trackpad zoom)",
             'addEventListener("wheel"' not in nb),
            ("config panel floats over the canvas (doesn't push it)",
             "position: absolute" in block(".nb2-inspector")),
            ("dragging a node onto a group drops it inside",
             "moveNodeIntoGroup" in nb and "groupAtContentPoint" in nb),
            ("removing a node from a group returns it to the canvas full-size",
             "extractChildToCanvas" in nb),
            ("the node palette pushes the canvas down (so it can't clip the config panel)",
             "position: absolute" not in block(".nb2-cat-sub")),
            ("select field rows don't duplicate the field name in the rename box",
             "placeholder={f.name}" not in nb),
            ("browse is now a data viewer; profiling is its own Profile node",
             '"profile"' in nb and "Show data" in nb and "Profile data" in nb),
            ("the browse viewer exposes a pass-through output (like chart/profile)",
             'browse: { inputs: ["in"], outputs: ["out"] }' in nb),
            ("the results viewer can be dragged to resize",
             "nb2-preview-resize" in nb and "previewHeight" in nb),
            ("clicking an output arrow previews that output's data",
             "doPreviewRef" in nb),
            ("the SQL node documents the input keyword",
             "FROM input" in nb),
            ("text-clean cleans multiple columns (cols, not a single col)",
             '"textclean"' in nb and "{ cols: [], ops: [], label: \"clean\" }" in nb),
            ("formula has a resizable box with field + function suggestions",
             "nb2-fx-area" in nb and "fxPickField" in nb and "FX_FUNCS" in nb
             and "nb2-fx-suggest" in nb),
            ("parse cleans multiple columns (cols, not a single col)",
             "{ cols: [], to: \"number\", format: \"\", group: \",\", label: \"parse\" }"
             in nb),
            ("closing a tab asks for confirmation",
             "Its nodes will be removed." in nb),
            ("palette nodes are drag-only (no click-to-add)",
             "click, or drag onto the canvas" not in nb
             and "onto the canvas`}" in nb
             and "draggable" in nb),
            ("active tab uses the green accent",
             "var(--accent)" in block(".nb2-tab.active")),
            ("ivory canvas toggle exists",
             "canvas-ivory" in rd("src", "App.tsx")
             and "body.canvas-ivory" in rd("src", "styles.css")),
            # --- performance ---
            ("dragging a node doesn't refetch columns (structural signature)",
             "useNodeFlowGraphSnapshot(nodes, edges)" in nb
             and ("[selId, graphSig]" in nb
                  or "[scopeKey, selId, graphSig]" in nb
                  or "[scopeKey, selId, graphSig, schemaSig]" in nb)),
            ("pointer drag/marquee is rAF-throttled",
             "requestAnimationFrame" in nb and "cancelAnimationFrame" in nb),
            ("graph persistence to localStorage is debounced",
             "setTimeout" in nb and "clearTimeout" in nb),
            ("committed wires render in a memoized layer",
             "WireLayer" in nb and "React.memo" in nb),
            ("inspector columns are fetched in one batched request",
             "nodeflowColumnsBatch" in nb
             and "nodeflowColumnsBatch" in rd("src", "lib", "api.ts")
             and "/api/nodeflow/columns-batch" in rd("src", "lib", "api.ts")),
            ("a marquee selection drags together (multi-node move)",
             "origins" in nb and "inMulti" in nb),
            ("snap-to-grid is an optional toggle",
             "snapRef" in nb and "nb2-canvas.snap" in rd("src", "styles.css")),
            ("nodes show an inline error state",
             "nodeErrors" in nb and ".nb2-node.err" in rd("src", "styles.css")),
            ("on-canvas charts are memoized (no ECharts redraw each render)",
             "React.memo" in rd("src", "components", "ChartView.tsx")
             and "CHART_FALLBACK" in nb),
            ("initial chart hydration is staggered across frames",
             "requestAnimationFrame(pump)" in nb),
            ("multiple canvases via a tab bar",
             "nb2-tabbar" in nb and "switchTab" in nb and "addTab" in nb
             and "closeTab" in nb),
            ("per-tab persistence + v1 migration",
             "TABS_KEY" in nb and "TAB_KEY" in nb and "tabGraphs" in nb
             and "Tab 1" in nb),
            ("each tab keeps its own undo history",
             "tabHist" in nb),
            ("tab bar is styled",
             ".nb2-tab" in rd("src", "styles.css")),
            # --- .93: category reorg ---
            ("Input is a nested category (input + source nodes including Dynamic Input)",
             '{ id: "input", label: "Input", icon: "Database", types: '
             '["input", "shred", "directory", "appendfolder", "filebrowser", '
             '"apinode", "sqlserver", "sharepoint", "webscrape", "createtable", '
             '"dyn_input"] }' in nb),
            ("chart + dashboard live in the Create category",
             '"chart", "dashboard", "sql", "python", "text"' in nb),
            ("validate + profile in Transform",
             '"renamecols", "validate", "profile"' in nb),
            ("Output category includes Dynamic Output",
             '"browse", "write", "output", "samqldash", "iterator", "while", "dyn_output"' in nb),
            # --- .93: chart/dashboard output saves on Run all (no button) ---
            ("output: no manual Save image button",
             '{isImage ? "Save image" : "Run & export"}' not in nb
             and "saved as an image when you run the workflow" in nb),
            ("Run all exports chart/dashboard outputs as images",
             'kind === "chart" || kind === "dashboard"' in nb
             and "? doExportImage(n)" in nb),
            # --- .93: tab numbering survives delete-then-add ---
            ("new tab numbers past the highest existing tab",
             (('"Tab " + (maxN + 1)' in nb
               or '`Tab ${maxNumber + 1}`' in nb)
              and "/^Tab (\\d+)$/" in nb)),
            # --- .93: New button removed; workflow rename ---
            ("NodeFlow New-workflow button removed",
             "onClick={newWorkflow}" not in nb),
            ("banner removed; save uses tab name; load opens a new tab; actions in tab row",
             "activeTabName" in nb and "openGraphInNewTab" in nb
             and "nb2-wf-name-edit" not in nb
             and "nb2-wfbar" not in nb
             and "nb2-tabbar-actions" in nb),
            # --- .93: output-arrow preview is cached ---
            ("preview results are cached (LRU, signature-keyed)",
             "previewCache" in nb
             and 'graphSig + "::" + node.id + "::" + port' in nb
             and "(cached)" in nb),
            ("preview cache is bounded + cleared on tab switch",
             "previewCache.current.size > 12" in nb
             and "previewCache.current.clear()" in nb),
            # --- .93: resizable chart/dashboard nodes ---
            ("chart/dashboard nodes are resizable",
             "startNodeResize" in nb and "nb2-node-resize" in nb
             and "bodyW:" in nb and "bodyH:" in nb),
            ("resize handle is styled + bodies fill the node",
             "nwse-resize" in css
             and ".nb2-node.sql {" in css
             and "flex: 1" in block(".nb2-node-chart")),
            # --- .93: every field multi-select is one-per-row ---
            ("aggregate/field multi-selects stack one per row",
             "flex-direction: column" in block(".nb2-groupby")),
            # --- .94: dedupe/window key lists also one-per-row ---
            ("checkbox key lists (dedupe/window) stack one per row",
             "flex-direction: column" in block(".nb2-checks")),
            # --- .94: run without an Output node + warn on dangling ---
            ("workflows run without an Output (leaf chains)",
             "runLeaf" in nb and 'mode = "leaves"' in nb
             and "PORTS[n.type]?.outputs?.length" in nb),
            # .468 repoint: the dangling-output count left the run-all
            # SUMMARY (the nudge is the yellow badge on the node now);
            # isolated nodes still report.
            ("unconnected / input-less nodes warn instead of blocking",
             "unconnected node(s) ignored" in nb
             and '"Output node not connected"' in nb),
            # --- .94: SQL editor ivory toggle ---
            ("SQL editor has an ivory toggle",
             "ivoryEditor" in rd("src", "App.tsx")
             and "editor-ivory" in rd("src", "App.tsx")
             and "body.editor-ivory .code" in css),
            # --- .95: reconcile output + optional sum balance ---
            ("reconcile node has an output port",
             'reconcile: { inputs: ["left", "right"], outputs: ["out"] }' in nb),
            ("reconcile has an optional balance column + output preview",
             "Balance column (optional)" in nb
             and "node.config.balance || null" in nb),
            # --- .95: formula target is a dropdown (overwrite / add new) ---
            ("formula target is a column dropdown with add-new",
             "+ Add a new column…" in nb and "Overwrite" in nb
             and 'mode: "new"' in nb),
            ("text boxes (sql + formula + more) resize both ways; panel grows",
             ".nb2-inspector.has-resize" in css
             and "width: max-content" in css
             and ".nb2-sql-area," in css
             and ".nb2-fx-area," in css
             and ".nb2-text-area," in css
             and "resize: both;" in css),
            # --- .96: multi-select right-click + copy/paste menu ---
            ("right-click keeps a multi-selection (no single config panel)",
             "currentSelection.length > 1" in nb
             and "currentSelection.includes(currentNode.id)" in nb
             and "if (!inMulti)" in nb),
            ("node menu copies + deletes the whole selection",
             "copySelection()" in nb and "Delete ${count} nodes" in nb
             and "deleteMany(selectedIds.slice())" in nb),
            ("empty canvas has a paste-here menu",
             "canvasMenu" in nb and "Paste here" in nb
             and "pasteClipboard({ x: canvasMenu.cx" in nb),
            ("canvas menu runs/stops the workflow (toggles above Paste here)",
             "Run Workflow" in nb and "Stop Workflow" in nb
             and re.search(r"if \(running\) (?:void )?cancelRun\(\);", nb)
             and re.search(r"else (?:void )?runAll\(\);", nb)),
            # --- .96/.492: renames (Journal / NodeFlow) ---
            ("views renamed to Journal and NodeFlow",
             "Open Journal" in rd("src", "App.tsx")
             and "Open NodeFlow" in rd("src", "App.tsx")
             and "nb2-toolbar" in nb
             and 'nb2-title">NodeFlow' not in nb),
            # --- .97: a new Input node has no table pre-selected ---
            ("new Input node starts with no table chosen",
             'input: define("input", "Input", "Database"' in nb
             and '{ table: "", label: "input" }' in nb),
            # --- .98: bypass toggle (green on / red off) ---
            ("node bypass toggle is wired",
             "nb2-node-bypass" in nb
             and ("{ disabled: !n.config.disabled }" in nb
                  or "{ disabled: !node.config.disabled }" in nb)
             and '" bypassed" : ""' in nb),
            ("bypass toggle is green when on, red when off",
             ".nb2-node-bypass.on {" in css
             and "background: var(--accent)" in css
             and ".nb2-node-bypass.off {" in css
             and "#d1493b" in css
             and ".nb2-node.bypassed {" in css),
            # --- .98: parallel Run all ---
            ("run all uses a bounded concurrency pool",
             "runDepth" in nb
             and "let CONCURRENCY =" in nb
             and "Promise.all(Array.from({ length: CONCURRENCY" in nb
             and "if (info.parallel_nodeflows) CONCURRENCY = 1" in nb),
            # --- .101: join single out port + buttons removed ---
            ("join exposes three outputs with L/R preview buttons (no mode select)",
             'join: { inputs: ["left", "right"], outputs: ["left_only", "inner", "right_only"] }'
             in nb
             and 'doPreview(sel, "left_only"' in nb
             and 'doPreview(sel, "right_only"' in nb
             and "Join type" not in nb),
            # --- .101: SQL node reads FROM input by default + guard ---
            ("sql node defaults to FROM input + warns when it doesn't",
             'sql: "SELECT *\\nFROM input"' in nb
             and "nb2-warn-sm" in nb
             and "from\\s+your_table" in nb),
            # --- .101: Run/Stop toggle ---
            ("run-all button toggles to a clickable Stop while running",
             "Icon.Square" in nb
             and "onClick={onCancelRun}" in nb
             and "onClick={onRunAll}" in nb
             and "<Icon.Play size={12} /> Run" in nb),
            # --- .101: combined dark/light toggle (under Visual Toggles) ---
            ("single dark/light toggle under Visual Toggles",
             "Toggle Dark Mode" in rd("src", "App.tsx")
             and "Toggle Light Mode" in rd("src", "App.tsx")
             and 'data-testid="settings-theme-toggle"' in rd("src", "App.tsx")
             and 'data-testid="settings-visual-toggles-menu"' in rd("src", "App.tsx")
             and "NodeFlow canvas: dark" not in rd("src", "App.tsx")),
            ("light theme applies CSS variables on html (theme-light)",
             "theme-light" in rd("src", "App.tsx")
             and 'html.theme-light' in css
             and "samql.theme" in rd("src", "App.tsx")
             and "--menu-hl:" in css),
            # --- .101: Favorites shortcut group ---
            ("favorites group: drag-in to add, persisted, stays in group",
             "LEGACY_FAVORITES_KEY" in nb
             and "const addFavorite" in nb
             and "const removeFavorite" in nb
             and "nb2-cat-fav" in nb
             and "nb2-fav-sub" in nb
             and "event.dataTransfer.getData(" in nb
             and "NB_NODE_MIME" in nb
             and "NB_CREATED_NODE_MIME" in nb
             and "createdFavoriteKey" in nb
             and "samql-created-node-deleted" in nb
             and ".nb2-fav-x {" in css),
            ("join left/right inputs use L/R marks inside the arrows",
             "inputPortMark" in nb
             and "sidePortLabel" in nb
             and "nb2-dot-mark" in nb
             and ".nb2-dot-mark" in css),
            # --- .101: layout doesn't clip the top bars when results grow ---
            ("preview drawer can't squeeze the tabs/banner/palette off-screen",
             "flex: 1 1 0;" in css
             and "window.innerHeight - 260" in nb
             and "\n  flex: 0 0 auto;\n}" in css),
            # --- .102: downstream nodes follow upstream column changes ---
            ("select fields reconcile with upstream (rename/new col persist)",
             "reconcileSelectFields" in nb
             and "fieldsDiffer" in nb
             and ('from "../lib/selectFields"' in nb
                  or 'from "../../lib/selectFields"' in nb)),
            # --- .103: more chart types + style / colour editing ---
            ("chart inspector exposes area/pie/donut/histogram + series split",
             '<option value="area">' in nb
             and '<option value="donut">' in nb
             and '<option value="histogram">' in nb
             and "Split into series by" in nb),
            ("chart style panel: palette/theme/legend/grid/labels/colours",
             "nb2-style" in nb
             and 'patchStyle(sel, "palette"' in nb
             and 'patchStyle(sel, "theme"' in nb
             and 'patchStyle(sel, "showLegend"' in nb
             and "patchSeriesColor(sel" in nb
             and ".nb2-color-row {" in css
             and ".nb2-style {" in css),
            ("chart option logic lives in a testable pure module",
             ('from "../lib/chartOption"' in nb
              or 'from "../../lib/chartOption"' in nb)
             and 'from "./chartOption"' in rd("src", "lib", "echart.ts")),
            ("chart calls send series split + map UI type to data shape",
             "backendChartType" in nb
             and "chartSpecOf" in nb
             and "styleChartData" in nb),
            # --- this batch: chart live-update, join modes, deletes, snapping,
            #     link selection, copy grid, red × buttons ---
            ("charts re-render from cache live (ChartView takes type/style; no refetch on style)",
             ("chartType={n.config.chart_type}" in nb
              or "chartType={node.config.chart_type}" in nb)
             and ("style={n.config.style}" in nb
                  or "style={node.config.style}" in nb)
             and "chartType?: string" in rd("src", "components", "ChartView.tsx")),
            ("join uses three output ports instead of a mode selector",
             "Join type" not in nb
             and "three outputs" in nb
             and 'left_only: "only L"' in nb),
            ("anti-join removed from the palette",
             '{ type: "antijoin"' not in nb),
            ("node delete confirms; empty tab closes without a prompt",
             "Delete this node?" in nb
             and ("if (tabNodes.length > 0) {" in nb
                  or "if (tabNodes.length) {" in nb)),
            ("wire snap-to-connect within a tolerance",
             "nearestInputPort" in nb
             and "nearestInputPort(end.x, end.y, drag.fromNode, 38)" in nb),
            ("connection select + highlight + delete handle (no confirm)",
             "selEdge" in nb
             and "selectedId={selectedEdge}" in nb
             and "nb2-wire-del" in nb
             and ".nb2-wire.sel .nb2-wire-line" in css),
            ("results preview uses DataGrid (cell + multi-row/col copy)",
             ('from "./DataGrid"' in nb
              or 'from "../DataGrid"' in nb)
             and ("previewPage" in nb or "const page = useMemo" in nb)
             and "<DataGrid" in nb),
            ("remove / cancel × buttons are pronounced red",
             "xbtn" in nb
             and ".btn.xbtn" in css),
            # --- config panel replaces the tables panel when one is shown ---
            ("inspector docks into the tables-panel slot (portal) when a node is selected",
             "InspectorShell" in nb
             and "createPortal" in nb
             and "inspectorHost" in nb
             and "onSelectionChange" in nb
             and ".nb2-inspector.docked" in css),
            ("app swaps the tables list for the config host in the Node view",
             "nb-inspector-host" in app
             and "setNbHostEl" in app
             and 'view === "nodeflow" && showTables && nbSel' in app
             and "onSelectionChange={setNbSel}" in app),
            # --- journal chart no longer frozen (echart contained, real height) ---
            ("journal chart canvas is positioned + sized so the chart can't overlay the cell",
             "position: relative" in (block(".chart-canvas") or "")
             and "max-height: 440px" not in css
             and "height: 440px" in css),
            # --- marquee stays inside the canvas ---
            ("marquee is clamped to the visible canvas (no spill into panels)",
             "clampToViewport" in nb
             and "clampToViewport(target.x, target.y)" in nb),
            # --- fill-nulls folded into text clean; fill node off the palette ---
            ("text clean offers a Fill blanks step",
             'value="fillnull"' in nb),
            ("fill node removed from the palette + groups (type kept for old flows)",
             '{ type: "fill", label: "Fill nulls"' not in nb
             and '"bin", "fill", "dedupe"' not in nb
             and 'inspectorType === "fill"' in nb),
            # --- node search bar can be toggled from View settings ---
            ("node search bar is toggleable from View settings",
             "showNodeSearch" in app
             and "Hide node search bar" in app
             and "showNodeSearch={showNodeSearch}" in app
             and "showNodeSearch !== false" in nb),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "layout rules broken: " + "; ".join(missing))

    def t_journal_ui_polish():
        # Browser-unverifiable CSS/markup: pin the Journal + Select-node polish
        # so a later refactor can't silently revert it. Pixel rendering needs a
        # real browser; these lock the rules that produce it.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        css = rd("src", "styles.css")
        nbc = _notebook_cell_source()
        nb_ = rd("src", "components", "Notebook.tsx")

        def block(selector):
            m = re.search(r"(?m)^\s*" + re.escape(selector) + r"\s*\{([^}]*)\}",
                          css)
            return m.group(1) if m else ""

        fields = block(".nb2-fields")
        grip = block(".nb-grip")
        scroll = block(".nb-scroll")
        checks = [
            # 1) Select node: the "Fields to keep" list fills the empty space
            #    and scales with the window instead of a short fixed box.
            ("select fields list scales with viewport height",
             "calc(100vh" in fields and "max-height: 260px" not in fields),
            ("select fields list still stacks one field per row",
             "flex-direction: column" in fields),
            # 2) Up / Down reorder buttons are pronounced (visible chips).
            ("move up / move down buttons are styled as pronounced chips",
             '.nb-cell-actions .iconbtn[title="Move up"]' in css
             and '.nb-cell-actions .iconbtn[title="Move down"]' in css),
            # 3) Delete is a clearly destructive red × (shared .iconbtn.xbtn).
            ("delete cell / delete note button is red ×",
             ".iconbtn.xbtn" in css
             and ".btn.xbtn" in css
             and "#e5484d" in css),
            ("delete button uses the red × glyph (not muted trash)",
             'className="iconbtn xbtn"' in nbc
             and "×" in nbc
             and 'title={deleteTitle}' in nbc),
            # 4) Drag grip is bigger and reads as a handle.
            ("drag grip is enlarged and styled as a grabbable handle",
             "font-size: 18px" in grip and "cursor: grab" in grip
             and "var(--border)" in grip),
            # 5) Drop indicator covers both edges + the reorder logic splices
            #    before/after by edge, so dragging works UP and DOWN.
            ("drop indicator renders on both the top and bottom edges",
             ".nb-cell.drop-top::before" in css
             and ".nb-cell.drop-bottom::after" in css),
            ("cell reorder honors a top/bottom edge (drag up AND down)",
             'edge: "top" | "bottom"' in nb_
             and "splice(ti, 0, moved)" in nb_),
            # 6) Journal is left-aligned so it uses the empty space; the
            #    loaded-table / Workflows rail is a separate column (no clip).
            ("journal cells are left-aligned, not centered",
             "margin: 0;" in scroll and "0 auto" not in scroll),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing,
             "journal / select polish broken: " + "; ".join(missing))

    def t_journal_cell_resize():
        # Journal cells resize on both axes via a persisted corner handle that
        # sizes the CARD (so the query/content expands into the blank space
        # instead of overflowing). Browser-unverifiable; this pins the wiring.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbc = _notebook_cell_source()
        nb_ = rd("src", "components", "Notebook.tsx")
        nblib = rd("src", "lib", "notebook.ts")
        css = rd("src", "styles.css")

        def css_block(sel):
            i = css.find(sel + " {")
            if i < 0:
                return ""
            j = css.find("}", i)
            return css[i : (j if j > 0 else len(css))]

        checks = [
            ("a reusable corner resize grip exists (pointer-drag, both axes)",
             "export const NotebookResizeGrip" in nbc
             and "startPointerDrag({" in nbc
             and "onResize(" in nbc),
            ("the grip sits on the SQL, visualization, and note renderers",
             nbc.count("<NotebookResizeGrip") >= 3),
            ("the card itself is the resize target: width + a maxWidth that beats the cap",
             nbc.count("maxWidth: cell.boxW") >= 3
             and "width: cell.boxW" in nbc),
            ("the card is a flex column, default-capped (content fills resized height)",
             "flex-direction: column" in css_block(".nb-card")
             and "max-width: 1100px" in css_block(".nb-card")),
            ("the sql editor + viz body grow to fill the card height",
             "flex: 1 1 auto" in css_block(".nb-ed")
             and "flex: 1 1 auto" in css_block(".nb-out-chart")),
            ("the journal column no longer caps width (cards use the blank space)",
             css_block(".nb-scroll") != "" and "max-width" not in css_block(".nb-scroll")),
            ("resize writes a persisted size on the cell",
             "boxW: w, boxH: h" in nb_),
            ("size round-trips through the cell model + persistence",
             "boxW?: number" in nbc
             and "boxW?: number" in nblib
             and "boxW: c.boxW" in nblib   # slimCell -> saved file
             and "boxW: d.boxW" in nb_),   # defToCell -> loaded cell
            ("a resize changes the persist signature (so it autosaves)",
             '(c.boxW || "")' in nb_ and '(c.boxH || "")' in nb_),
            ("the corner handle is styled (nwse-resize cursor)",
             ".nb-resize {" in css and "cursor: nwse-resize" in css),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "journal cell resize broken: " + "; ".join(missing))

    def t_journal_dnd():
        # Journal cell reordering is pointer-based (HTML5 drag-and-drop on a
        # button was flaky / never smooth). Browser-unverifiable; pins the wiring.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nbc = _notebook_cell_source()
        nb_ = rd("src", "components", "Notebook.tsx")
        checks = [
            ("reorder is driven by a pointer handler that hit-tests cells",
             "const startCellDrag" in nb_
             and "elementFromPoint" in nb_
             and '[data-cell-id]' in nb_),
            ("the drag tracks via the shared pointer owner + mirror refs",
             "startPointerDrag({" in nb_
             and "onCancel: () => finish(false)" in nb_
             and "dropTargetRef" in nb_
             and "dragIdRef" in nb_),
            ("cells expose an id for hit-testing",
             "data-cell-id={cell.id}" in nbc),
            ("the grip starts the reorder on pointerdown (not HTML5 draggable)",
             ("onPointerDown={props.onReorderStart}" in nbc
              or "onPointerDown={(event) => props.onReorderStart(event)}" in nbc)
             and "draggable" not in nbc),
            ("the old HTML5 drag handlers are gone",
             "onCellDragOver" not in nb_ and "onCellDrop" not in nb_),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "journal drag-and-drop broken: " + "; ".join(missing))

    def t_nodebook_resize():
        # Node editor: the SQL query node resizes (with a query body) and the
        # config window (inspector) can be dragged wider. Browser-unverifiable;
        # pins the wiring + CSS.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        nb = _read_nodebook_source()
        css = rd("src", "styles.css")
        help_ts = rd("src", "lib", "nodeHelp.ts")
        docs_modal = rd("src", "components", "DocsModal.tsx")

        def css_block(sel):
            i = css.find(sel + " {")
            if i < 0:
                return ""
            j = css.find("}", i)
            return css[i : (j if j > 0 else len(css))]

        checks = [
            # --- the SQL query node is resizable, like a journal card ---
            ("sql node honours a user width + height (bodyW/bodyH)",
             (lambda model, inter: (
                 "bodyW" in model and "bodyH" in model
                 and "SQL_BODY_H" in model
                 and ("bodyW" in inter or "bodyH" in inter
                      or "bodyW" in nb or "bodyH" in nb)
             ))(rd("src", "lib", "nodeFlowModel.ts"),
                rd("src", "components", "nodeflow",
                   "useNodeFlowCanvasInteractions.ts"))),
            ("sql node renders the corner resize handle",
             ('n.type === "sql" ? (' in nb
              or 'node.type === "sql") && (' in nb
              or 'node.type === "python") && (' in nb)
             and "nb2-node-resize" in nb
             and "startNodeResize" in nb),
            ("sql node shows a (resizable) read-only query body",
             "nb2-node-sql" in nb
             and "nb2-node-sql-text" in nb
             and ('n.type === "sql" && (' in nb
                  or 'node.type === "sql" && (' in nb)),
            ("python node is registered with Terminal icon + inspector",
             '"python"' in nb
             and "Terminal" in nb
             and 'inspectorType === "python"' in nb
             and "config.code" in nb),
            ("python node docs explain pandas df against an input table",
             "pandas DataFrame" in nb
             and 'df[df["score"] > 50]' in nb
             and "pandas DataFrame" in help_ts
             and "pandas DataFrame" in docs_modal),
            ("sql node keeps its ports by the header (not centred) like chart",
             'n.type === "sql"\n  ) {\n    return PORT_TOP + idx * PORT_GAP;' in nb
             or ('n.type === "sql"' in nb
                 and "return portTop + idx * portGap;" in nb
                 and "densify(PORT_TOP)" in nb)),
            ("sql node is a flex column so the body fills it",
             ".nb2-node.sql {" in css
             and "flex: 1" in css_block(".nb2-node-sql")),
            # --- the config window (inspector) expands further + drags wider ---
            ("the config window can be dragged wider (state-driven width)",
             "const [inspW" in nb
             and "width={inspW}" in nb
             and "onResize={setInspW}" in nb),
            ("a user width overrides the auto width + its cap",
             "{ width, maxWidth: width }" in nb
             and "nb2-insp-resize" in nb),
            ("the config window's auto cap was raised so it expands further",
             "max-width: min(1100px, calc(100vw - 160px))" in css_block(
                 ".nb2-inspector.has-resize")),
            ("the config-window grip is styled (ew-resize)",
             "cursor: ew-resize" in css_block(".nb2-insp-resize")),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "NodeFlow resize broken: " + "; ".join(missing))

    def t_undo_redo_wiring():
        # Undo/redo for the IDE editor and the Journal. Browser-unverifiable
        # behaviour; this pins the controls, the Ctrl+Z handlers, and the stacks.
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()
        icon = rd("src", "components", "Icon.tsx")
        app = rd("src", "App.tsx")
        ide = rd("src", "controllers", "useIdeController.ts")
        nb = rd("src", "components", "Notebook.tsx")
        checks = [
            ("undo + redo icons exist",
             "Undo: (p" in icon and "Redo: (p" in icon),
            # ---- IDE ----
            ("IDE keeps a per-tab editor history (controlled textarea has none)",
             "ideHistory" in ide and "const undoIde" in ide
             and "const redoIde" in ide),
            ("IDE undo/redo enable state is derived",
             "canUndoIde" in ide and "canRedoIde" in ide),
            ("IDE has a Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y handler on the editor",
             "const onEditorKeyDown" in ide
             and "onKeyDown={onEditorKeyDown}" in app
             and 'key === "z"' in ide),
            ("IDE undo + redo buttons sit by Export",
             app.count("<Icon.Undo") >= 1
             and app.count("<Icon.Redo") >= 1
             and "onClick={undoIde}" in app
             and "onClick={redoIde}" in app),
            # ---- Journal ----
            ("Journal keeps a notebook-level snapshot history",
             "nbHist" in nb and "const undoNb" in nb and "const redoNb" in nb),
            ("Journal records edits (persistSig), not query runs, and resets per notebook",
             "[persistSig, nbId]" in nb and "nbHistNbId" in nb),
            ("Journal undo/redo enable state is derived",
             "canUndoNb" in nb and "canRedoNb" in nb),
            ("Journal has a Ctrl+Z handler on its root",
             "const onJournalKeyDown" in nb
             and "onKeyDown={onJournalKeyDown}" in nb),
            ("Journal undo + redo buttons are in the toolbar",
             nb.count("<Icon.Undo") >= 1
             and nb.count("<Icon.Redo") >= 1
             and "onClick={undoNb}" in nb
             and "onClick={redoNb}" in nb),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "undo/redo wiring broken: " + "; ".join(missing))

    def t_activity_dashboard_wiring():
        # The Activity & connections dashboard: api methods + endpoints, the
        # modal (live poll + interval cleanup + reset action), the Settings
        # menu entry + render, the status types, and the dashboard CSS.
        api_src = _read_fe("src", "lib", "api.ts")
        need("status:" in api_src and "/api/status" in api_src,
             "api.status() must call /api/status")
        need("nuke:" in api_src and '"/api/nuke"' in api_src,
             "api.nuke() must POST /api/nuke (.523 nuclear reset)")
        need("engineReset:" in api_src and '"/api/engine/reset"' in api_src,
             "api.engineReset() must POST /api/engine/reset (soft recovery)")
        am = (_read_fe("src", "components", "ActivityModal.tsx")
              + _read_fe("src", "components", "ActivityShared.tsx")
              + _read_fe("src", "lib", "activity.ts"))
        need(re.search(r"api\s*\.\s*status\s*\(", am),
             "the dashboard must poll api.status() (now via shared hook)")
        need(re.search(r"api\s*\.\s*nuke\s*\(", am),
             "the dashboard must call api.nuke() (nuclear, via shared hook)")
        need(re.search(r"api\s*\.\s*engineReset\s*\(", am)
             or "softResetEngines" in am,
             "the dashboard must offer soft engine reset")
        need("setInterval" in am and "clearInterval" in am,
             "modal must poll on an interval and clear it on unmount")
        # The shared hook caches the last snapshot at module scope so a consumer
        # that mounts fresh (the memory popover) shows the last-known status
        # instead of flashing/sticking on "checking..." while a load has the
        # connection pool saturated.
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        need("_lastStatus" in shared
             and "useState<ActivityStatus | null>(_lastStatus)" in shared,
             "useActivityStatus must seed from the cached last status")
        need("_lastStatus = d" in shared,
             "the poll must update the module-level status cache")
        need("Reset server" in am and "Reset engines" in am,
             "modal must offer Reset engines (soft) and Reset server (nuclear)")
        app = _read_fe("src", "App.tsx")
        need("ActivityModal" in app and "activityOpen" in app,
             "App must import + gate the ActivityModal")
        need("<ActivityModal" in app, "App must render the ActivityModal")
        need("Activity &amp; connections" in app,
             "Settings menu must have an Activity & connections entry")
        types = _read_fe("src", "lib", "types.ts")
        need("ActivityStatus" in types and "EngineResetResult" in types,
             "status + reset-result types must be declared")
        css = _read_fe("src", "styles.css")
        need(".act-engine" in css and ".act-ops" in css,
             "dashboard CSS (engine badges + ops table) must exist")
        need("prefers-reduced-motion" in css,
             "dashboard animation must respect reduced motion")
        # heartbeat monitor: traffic-light states + a pulse keyed to each poll
        need("act-monitor" in am, "monitor element must be present")
        need('"error"' in am and '"busy"' in am and '"idle"' in am,
             "monitor must compute error/busy/idle states")
        need("key={beat}" in am,
             "pulse must re-mount each poll for a real-time heartbeat")
        need("last_error" in types,
             "status type must carry last_error for the red state")
        need(".act-monitor.error" in css and ".act-monitor.busy" in css
             and ".act-monitor.idle" in css,
             "traffic-light CSS for red / yellow / green states")
        need("@keyframes act-beat" in css,
             "heartbeat pulse animation must exist")
        # busy engine badge dot is yellow (matches busy=yellow), not green
        need(re.search(r"\.act-engine\.busy\s+\.act-dot\s*\{[^}]*var\(--warn\)",
                       css),
             "the busy engine dot must be yellow (var(--warn))")
        # the monitor must never say "All clear" while an engine is busy
        need('eng?.duckdb.busy' in am and "is working on something" in am,
             "a busy engine with no named op must still read as working, "
             "not 'All clear'")

    def t_clear_all_graceful_483():
        # .483: "Clear all" in the activity tray slides every finished card
        # away together -- the SAME exit a single dismiss plays -- instead of
        # blinking them out. The tray marks completed cards leaving (via a
        # `clearing` flag driving each card's forceLeaving), waits out the
        # exit animation, THEN calls clearCompleted to remove them for good.
        # Running cards are untouched and reflow up. This guards the wiring.
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        css = _read_fe("src", "styles.css")

        # the card row accepts a parent-driven leaving trigger and honours it
        need("forceLeaving?: boolean" in shared,
             "TaskCardRow takes a forceLeaving prop")
        need("leaving || forceLeaving" in shared,
             "a card shows the leaving animation when the parent forces it")

        # the tray orchestrates: clearing state -> animate -> real clear
        need("const gracefulClear" in shared
             and "setClearing(true)" in shared,
             "Clear all marks the finished cards leaving first")
        need("forceLeaving={clearing && isDone(t)}" in shared,
             "only the FINISHED cards are cleared; running ones stay")
        need("clearCompleted();" in shared
             and "window.setTimeout" in shared,
             "the real clear runs AFTER the exit animation, not instantly")
        # the delay is past the .task-card.leaving transition (0.22s)
        import re as _re12
        m = _re12.search(r"clearTimer\.current = window\.setTimeout\("
                         r".*?\},\s*(\d+)\)", shared, _re12.DOTALL)
        need(m and int(m.group(1)) >= 220,
             "the clear waits at least the 0.22s exit transition before "
             "removing the cards")
        # double-click / unmount safety
        need("if (clearing) return;" in shared,
             "a second Clear-all click while animating is ignored")
        need("window.clearTimeout(clearTimer.current)" in shared,
             "a pending clear is cancelled on unmount")

        # the exit animation the cards reuse still exists
        need(".task-card.leaving" in css
             and ("transition: all 0.22s ease" in css
                  or "0.22s ease" in css),
             "the shared card exit transition is present")

    def t_cancel_all_in_tray():
        # The catch-all "Cancel all" used to sit on the live "Working" card,
        # where it overlapped the server text. It now lives in the background-
        # tasks tray as its own row -- directly below the header and above the
        # task cards -- shown whenever a task is running, and the Working card
        # no longer carries a Stop. Cancellation itself is unchanged (still
        # api.cancelAll). Source-guarded; the sandbox has no node_modules.
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        app = _read_fe("src", "App.tsx")
        amodal = _read_fe("src", "components", "ActivityModal.tsx")
        css = _read_fe("src", "styles.css")
        missing = []
        # the Working-card Stop and all of its onStop wiring are gone
        if "act-monitor-stop" in shared or ".act-monitor-stop" in css:
            missing.append("Working-card Stop must be removed")
        if "onStop" in shared or "onStop=" in app or "onStop=" in amodal:
            missing.append("onStop wiring must be fully removed")
        # Cancel all is now a tray row, shown whenever a task runs
        if "task-tray-cancel-all" not in shared:
            missing.append("tray Cancel-all row")
        if "activeTasks.length > 0" not in shared:
            missing.append("Cancel-all shows whenever a task is running")
        if "onClick={cancelAll}" not in shared or "api.cancelAll(" not in shared:
            missing.append("Cancel all still wired to api.cancelAll")
        if ".task-tray-cancel-all" not in css:
            missing.append(".task-tray-cancel-all css")
        need(not missing,
             "tray Cancel-all relocation incomplete: " + ", ".join(missing))

    def t_load_start_feedback():
        # Two pieces of load feedback: (1) the cancel X on a *running* task card
        # is red -- the same shared card renders in the stat popover and the
        # Activity & connections modal, so one class covers both; (2) starting a
        # load (drag-drop, a single file, or a folder) fires a bottom-right toast
        # so the user knows it kicked off, before the card shows in the panel.
        # Source-guarded; the sandbox has no node_modules to render live.
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        app = _read_fe("src", "App.tsx")
        bg = _read_fe("src", "controllers", "useBackgroundOperations.ts")
        css = _read_fe("src", "styles.css")
        missing = []
        if "task-cancel-x" not in shared:
            missing.append("running task card uses the red cancel-x class")
        if ".btn.task-cancel-x" not in css:
            missing.append("red cancel-x css")
        starts = (app + bg).count("tracking in the activity panel")
        need(starts >= 3,
             "expected a load-start toast at all three load entry points "
             "(drag-drop, single file, folder); found %d" % starts)
        if "`Loading ${" not in (app + bg):
            missing.append("the load-start toast names the file")
        need(not missing,
             "load-start feedback incomplete: " + ", ".join(missing))

    def t_micro_animations():
        # A first batch of subtle, one-shot animations (right-click menus,
        # modals, the button press, node selection, toast exit), all behind a
        # reduced-motion guard: the OS "reduce motion" setting plus a Settings
        # toggle, applied as a body class that zeroes every animation +
        # transition. Source-guarded; no node_modules in the sandbox.
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        missing = []
        # reduced-motion guard
        if "prefers-reduced-motion: reduce" not in css:
            missing.append("prefers-reduced-motion media query")
        if "body.motion-reduced" not in css:
            missing.append("body.motion-reduced kill switch")
        if "reduceMotion" not in app or "motion-reduced" not in app:
            missing.append("reduce-motion state + body-class toggle")
        if "Reduce motion" not in app:
            missing.append("Settings reduce-motion toggle")
        # the animations
        for kf in ("@keyframes ctx-pop", "@keyframes modal-in",
                   "@keyframes toast-out"):
            if kf not in css:
                missing.append("missing " + kf)
        if "scale(0.97)" not in css:
            missing.append("button press-scale")
        if ".ctx-menu { animation: ctx-pop" not in css:
            missing.append("context-menu entrance")
        if ".toast.leaving" not in css or "leaving" not in app:
            missing.append("toast exit")
        if "transition: box-shadow" not in css:
            missing.append("node selection-ring transition")
        need(not missing,
             "micro-animation wiring incomplete: " + ", ".join(missing))

    def t_eye_care_scaling():
        # Settings > View "Eye Care" enlarges text, buttons, nodes, and
        # containers together via html.eye-care + zoom (with a CSS fallback),
        # persisted as samql.eyeCare. Covered by Playwright + Vitest.
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        e2e = _read_fe("e2e", "eye-care.spec.ts")
        missing = []
        if "eye-care-toggle" not in app or "Eye Care" not in app:
            missing.append("Settings Eye Care toggle")
        if "samql.eyeCare" not in app:
            missing.append("samql.eyeCare persistence")
        if 'classList.toggle("eye-care"' not in app and \
           "classList.toggle('eye-care'" not in app:
            missing.append("html.eye-care class toggle")
        if "data-eye-care" not in app:
            missing.append("data-eye-care attribute")
        if "--eye-care-scale" not in css:
            missing.append("--eye-care-scale token")
        if "html.eye-care" not in css or "zoom:" not in css:
            missing.append("html.eye-care zoom scaling")
        if "@supports not (zoom: 1)" not in css:
            missing.append("zoom fallback for non-Chromium")
        if "eye-care-toggle" not in e2e or "boundingBox" not in e2e:
            missing.append("Playwright Eye Care size assertions")
        if "nodeflow-node" not in e2e:
            missing.append("Playwright NodeFlow node scaling")
        need(not missing,
             "Eye Care scaling incomplete: " + ", ".join(missing))

    def t_nodeflow_dense():
        # Settings > View "Dense NodeFlow" shrinks canvas geometry (pairs with
        # Eye Care). Persisted as samql.nodeFlowDense; layout helpers densify
        # NODE_W / ports when html.nb-dense is set.
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        model = _read_fe("src", "lib", "nodeFlowModel.ts")
        e2e = _read_fe("e2e", "nodeflow-dense.spec.ts")
        vitest_layout = os.path.join(
            FRONTEND, "src", "lib", "nodeFlowDense.component.test.ts")
        vitest_app = os.path.join(
            FRONTEND, "src", "lib", "nodeFlowDenseApp.component.test.tsx")
        missing = []
        if "nodeflow-dense-toggle" not in app or "Dense NodeFlow" not in app:
            missing.append("Settings Dense NodeFlow toggle")
        if "samql.nodeFlowDense" not in app:
            missing.append("samql.nodeFlowDense persistence")
        if "setNodeFlowDenseMode" not in app or "setNodeFlowDenseMode" not in model:
            missing.append("dense mode layout flag")
        if "NB_DENSE_SCALE" not in model or "densify" not in model:
            missing.append("densify helpers")
        if "denseMode" not in model or "a.denseMode === b.denseMode" not in model:
            missing.append("denseMode canvas memo key")
        scene = _read_fe("src", "components", "nodeflow", "NodeFlowScene.tsx")
        if "denseMode" not in scene:
            missing.append("NodeFlowScene denseMode prop (busts Scene memo)")
        if "html.nb-dense" not in css:
            missing.append("html.nb-dense CSS")
        if not os.path.isfile(vitest_layout):
            missing.append("Vitest layout dense helpers")
        if not os.path.isfile(vitest_app):
            missing.append("Vitest Dense NodeFlow App toggle")
        if '"nodeflow"' not in e2e:
            missing.append("Playwright openApp nodeflow expectedView")
        if "nodeflow-dense-toggle" not in e2e or "nb-dense" not in e2e:
            missing.append("Playwright Dense NodeFlow assertions")
        need(not missing,
             "Dense NodeFlow incomplete: " + "; ".join(missing))

    def t_more_animations():
        # Second animation batch: node placement scale-in + drag lift, the
        # toast auto-dismiss countdown bar, the editor tab bar's sliding
        # underline, and a success flash on the Run button -- all still behind
        # the reduced-motion guard. Source-guarded (no node_modules here).
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        ide = _read_fe("src", "controllers", "useIdeController.ts")
        missing = []
        # nodes (positioned by left/top, so the scale animation is safe)
        if "@keyframes node-in" not in css or "animation: node-in" not in css:
            missing.append("node placement scale-in")
        if ".nb2-node:active" not in css:
            missing.append("node drag lift")
        # toast countdown bar
        if "@keyframes toast-bar" not in css or ".toast-bar" not in css:
            missing.append("toast countdown bar CSS")
        if "toast-bar" not in app or "animationDuration" not in app:
            missing.append("toast countdown bar wiring")
        # editor tab-underline slide
        if ".ed-tabs" not in css or ".tab-underline" not in css:
            missing.append("tab underline CSS")
        for tok in ("tabsRef", "tabUl", "useLayoutEffect"):
            if tok not in ide:
                missing.append("tab underline controller: " + tok)
        for tok in ("ed-tabs", "tab-underline"):
            if tok not in app:
                missing.append("tab underline rendering: " + tok)
        # Run-button success flash
        if "@keyframes flash-ok" not in css or ".flash-ok" not in css:
            missing.append("success-flash CSS")
        for tok in ("runFlash", "flashRun"):
            if tok not in ide:
                missing.append("success-flash controller: " + tok)
        if "flash-ok" not in app:
            missing.append("success-flash rendering: flash-ok")
        need(not missing,
             "second animation batch incomplete: " + ", ".join(missing))

    def t_pivot_grid_sort_resize():
        # The pivot result grid gained sortable + resizable columns, and the
        # field-chip remove button is now a pronounced red x. PivotPanel is
        # shared, so this lands in both the SQL IDE and the Journal. Source-
        # guarded (no node_modules in the sandbox).
        pv = _read_fe("src", "components", "PivotPanel.tsx")
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        nbc = _notebook_cell_source()
        missing = []
        # sortable columns
        if "toggleSort" not in pv or "viewRows" not in pv:
            missing.append("column sort")
        if "pv-sorted" not in pv or "\u25b2" not in pv:
            missing.append("sort indicator")
        # resizable columns (measured -> fixed-layout colgroup, draggable)
        for tok in ("startResize", "colW", "<colgroup", "pv-fixed",
                    "pv-col-resize"):
            if tok not in pv:
                missing.append("resize: " + tok)
        if ".pv-grid.pv-fixed" not in css or ".pv-col-resize" not in css:
            missing.append("resize CSS")
        # pronounced red remove-x: red at rest, not only on hover
        m = re.search(r"\.pv-chip-x \{[^}]*\}", css)
        if not (m and "var(--error)" in m.group(0)):
            missing.append("red chip-x at rest")
        # shared panel -> both IDE and Journal pick the changes up
        if "PivotPanel" not in app or "PivotPanel" not in nbc:
            missing.append("PivotPanel must be used in both IDE and Journal")
        need(not missing,
             "pivot sort/resize/red-x incomplete: " + ", ".join(missing))

    def t_pivot_row_collapse():
        # The pivot result grid can collapse/expand nested row groups: a
        # chevron on each non-leaf row-dimension cell folds that group's
        # children into a single representative row (deeper dims + values
        # blanked, with a hidden-count), so one parent can stay expanded while
        # another is collapsed. PivotPanel is shared -> lands in both the SQL
        # IDE and the Journal. Source-guarded (no node_modules in the sandbox).
        pv = _read_fe("src", "components", "PivotPanel.tsx")
        css = _read_fe("src", "styles.css")
        app = _read_fe("src", "App.tsx")
        nbc = _notebook_cell_source()
        missing = []
        # per-group collapse state, keyed by the dimension-prefix path
        for tok in ("const [collapsed", "setCollapsed", "toggleCollapse",
                    "prefixKey"):
            if tok not in pv:
                missing.append("collapse state: " + tok)
        # the display model that suppresses children + tags the representative
        for tok in ("displayRows", "collapsedAt", "supLevel", "supKey"):
            if tok not in pv:
                missing.append("display model: " + tok)
        # chevron control + the two glyphs (escaped in source) + hidden-count
        if "pv-collapse" not in pv:
            missing.append("chevron button")
        if "u25b8" not in pv or "u25be" not in pv:
            missing.append("chevron glyphs")
        if "pv-collapse-count" not in pv:
            missing.append("hidden-row count")
        # nesting is only contiguous in dimension order, so collapse is gated
        # off when sorted by a value column
        if "canCollapse" not in pv or "sort.col < nDims" not in pv:
            missing.append("value-sort gate")
        # resets when the pivot shape changes
        if "setCollapsed(new Set())" not in pv:
            missing.append("reset on shape change")
        # collapse styling
        if ".pv-collapse" not in css or ".pv-collapse-count" not in css:
            missing.append("collapse CSS")
        # shared panel -> both IDE and Journal pick the change up
        if "PivotPanel" not in app or "PivotPanel" not in nbc:
            missing.append("PivotPanel must be used in both IDE and Journal")
        need(not missing,
             "pivot row collapse incomplete: " + ", ".join(missing))

    def t_activity_tray_wiring():
        # The activity tray: the unified /api/tasks feed rendered as
        # cancellable cards under the connection monitor in the Activity modal,
        # plus a persistent header badge. Source-guarded + tsc-gated -- the
        # sandbox has no node_modules to run the UI live.
        types = _read_fe("src", "lib", "types.ts")
        api_src = _read_fe("src", "lib", "api.ts")
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        amodal = _read_fe("src", "components", "ActivityModal.tsx")
        app = _read_fe("src", "App.tsx")
        css = _read_fe("src", "styles.css")
        checks = [
            ("TaskCard type models the /api/tasks card shape",
             "interface TaskCard" in types and "TaskProgressMode" in types
             and '"queued"' in types),
            ("api.tasks() hits the unified feed",
             "tasks:" in api_src and '"/api/tasks"' in api_src
             and "TaskCard" in api_src),
            ("useTasks polls /api/tasks + cancels via the per-job cancel",
             "export function useTasks" in shared and "api.tasks()" in shared
             and "api.loadCancel" in shared),
            ("the tray + a card row are real components",
             "export const TaskTray" in shared and "TaskCardRow" in shared),
            ("a card X cancels a running task, dismisses a finished one",
             "onCancel(t.id)" in shared and "onDismiss(t.id)" in shared),
            ("progress is honest per mode (bytes / steps / spinner)",
             'p.mode === "bytes"' in shared and 'p.mode === "steps"' in shared
             and "indeterminate" in shared),
            ("cancel-all stops every in-flight task",
             "cancelAll" in shared and "api.cancelAll()" in shared),
            ("the ONE tray lives in the shared Server block "
             "(the window otherwise shows tasks twice)",
             "<TaskTray hideEmpty" in shared
             and "<TaskTray" not in amodal),
            ("a persistent header badge shows the active-task count",
             "useTasks" in app and "task-badge" in app
             and "activeCount" in app),
            ("tray card CSS exists",
             ".task-card" in css and ".task-badge" in css),
            ("finished cards dismiss + clear-completed server-side, so they "
             "stay cleared across reopen and both modals share it",
             "dismissTask" in api_src and "clearCompletedTasks" in api_src
             and "/api/tasks/clear-completed" in api_src
             and "/dismiss" in api_src
             and "api.dismissTask(" in shared
             and "api.clearCompletedTasks(" in shared
             and "clearCompleted" in shared and "completedTasks" in shared),
            ("the tray has a Clear-all button + a hide-empty mode for the popover",
             "hideEmpty" in shared and "Clear all" in shared),
            ("the Server block (in the dashboard) lists the live "
             "cancellable cards via the shared tray",
             "<TaskTray hideEmpty" in shared),
            ("drag-drop load returns to the main screen at once (fire-and-forget)",
             "doDropLoad" in app and "setDropBusy" not in app
             and "api.loadFilesStart(" in app),
            ("each cancellable ACTIVE OPERATIONS row offers an inline cancel "
             "that hits the existing run-cancel rail (cancel_query); loads "
             "(tray job) and restore (no run id) show no inline control",
             "StatusOp" in types and "cancellable" in types
             and "o.cancellable" in amodal
             and "cancelById(id);" in amodal),
            ("the shared Server block surfaces cancellable foreground "
             "runs with the same per-run cancel (now hosted in the "
             "dashboard)",
             "o.cancellable" in shared and "cancelById(o.id)" in shared),
            ("EMBEDDED, the block renders NOTHING the dashboard already "
             "shows: one monitor, one reset (on-box dedupe 2026-07-02)",
             "embedded?: boolean" in shared
             and "!embedded && (" in shared
             and amodal.count("<ActivityMonitor") == 1
             and "<TaskTray" not in amodal
             and "!embedded && (" not in amodal),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "activity tray wiring broken: " + "; ".join(missing))

    def t_tray_replaces_load_modal():
        # Stage 4b: the load / folder / HDFS / convert flow now runs through the
        # tray, not a blocking modal. ProgressModal + loadJob are retired; the
        # triggers start the job fire-and-forget; completion (toasts + a table
        # refresh) is relocated into the tray poller, keyed off the card kind;
        # flatten keeps its own in-modal completion (not double-toasted); and
        # the header badge is fed by the single lifted poll. Source-guarded.
        app = _read_fe("src", "App.tsx")
        background = _read_fe(
            "src", "controllers", "useBackgroundOperations.ts")
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        checks = [
            ("the per-load ProgressModal + loadJob state are retired",
             "ProgressModal" not in app and "setLoadJob" not in app
             and "loadJob" not in app),
            ("load / folder / HDFS triggers start the job without a modal",
             "await api.loadStart(" in background
             and "await api.loadFolderStart(" in background
             and "await api.hdfsLoadFileStart(" in background
             and "beginLoad" in app and "beginLoadFolder" in app
             and "beginHdfsFileLoad" in app),
            ("completion is relocated into one kind-keyed handler",
             "const onTaskComplete" in background
             and 'task.kind === "convert"' in background
             and "Converted to Parquet" in background),
            ("completion runs in a self-contained TaskWatcher (isolated)",
             "TaskWatcher" in app and "onComplete={onTaskComplete}" in app
             and "useTasks(true, onComplete)" in shared),
            ("flatten keeps its own completion (not double-toasted)",
             'task.kind === "flatten"' in background),
            ("the header badge polls in its own component, not the IDE body",
             # .463: the badge now also passes its pulse callback
             "const { activeCount, opsCount, stalled } = "
             "useTasks(true, firePulse)"
             in app),
            ("useTasks fires once per terminal transition (first poll seeded)",
             "seeded" in shared and "fired" in shared
             and "onComplete" in shared),
        ]
        missing = [n for n, ok in checks if not ok]
        need(not missing,
             "tray-replaces-modal wiring broken: " + "; ".join(missing))

    def t_nodebook_stop_halts_background():
        # the NodeFlow Stop is a global halt: besides cancelling foreground
        # runs, it flags + interrupts any background tray task (load / convert /
        # flatten) via the cancel-all endpoint, even with no foreground run.
        api = _read_fe("src", "lib", "api.ts")
        nb = _read_fe("src", "components", "NodeFlow.tsx")
        need("cancelAll:" in api and "/api/cancel-all" in api,
             "api.cancelAll must POST /api/cancel-all")
        need("api.cancelAll()" in nb,
             "NodeFlow cancelRun must call api.cancelAll() to halt background")

    def t_status_reset_resilient_wiring():
        # The connection-status window + reset must not hang the UI under load:
        # jsonFetch supports a timeout via AbortController and surfaces a clear
        # (recoverable) error; the status poll and the reset are each bounded by
        # a timeout; the reset frees the connection pool first; and the poll is
        # single-flighted so it can't stack and exhaust the pool.
        api_src = _read_fe("src", "lib", "api.ts")
        modal = (_read_fe("src", "components", "ActivityModal.tsx")
                 + _read_fe("src", "components", "ActivityShared.tsx"))
        need("timeoutMs" in api_src and "AbortController" in api_src,
             "jsonFetch must support a timeout via AbortController")
        need(re.search(r"setTimeout\([\s\S]{0,120}?abort", api_src),
             "the timeout must abort the request")
        need(re.search(r'name === "AbortError"', api_src),
             "an aborted/timed-out request must surface as a clear error "
             "rather than a promise that never settles")
        need("abortInflight" in api_src and "_inflight" in api_src,
             "an in-flight registry + abortInflight() must exist to free the "
             "connection pool")
        need(re.search(r'/api/status",\s*\{\s*timeoutMs', api_src),
             "the status poll must be bounded by a timeout")
        need(re.search(r'/api/nuke"[\s\S]{0,200}?timeoutMs', api_src),
             "the nuclear reset request must be bounded by a timeout "
             "(and the hook reloads on a hang regardless)")
        need("abortInflight()" in modal,
             "reset must free the connection pool (abortInflight) so it can "
             "get through under load")
        need(re.search(r"if \(polling\.current\)\s*return", modal),
             "the status poll must be single-flighted (no stacking under load)")

    def t_run_progress_bar_wiring():
        # A determinate progress bar (% complete) sits next to Run/Stop on the
        # IDE, the Journal and the Node view, fed by real completion data: the op
        # registry's percent (iterators/while) via a polling hook, Run all's
        # client-side terminal count, and the Journal's cell count. It is
        # determinate-only: when there is no knowable %, it renders nothing
        # (no animated "running" indicator), so every surface that shows it gates
        # on a real fraction.
        pb = _read_fe("src", "components", "ProgressBar.tsx")
        hook = _read_fe("src", "lib", "useRunProgress.ts")
        app = _read_fe("src", "App.tsx")
        nb = _read_fe("src", "components", "NodeFlow.tsx")
        journal = _read_fe("src", "components", "Notebook.tsx")
        types = _read_fe("src", "lib", "types.ts")
        need("determinate" in pb and re.search(r'width:\s*pct\s*\+', pb),
             "ProgressBar must fill to the value when determinate")
        need(re.search(r"return null", pb),
             "ProgressBar must render nothing (no running indicator) when "
             "there is no real percentage")
        need("api.status()" in hook and "percent" in hook,
             "useRunProgress must poll /api/status and read percent")
        need("inflight" in hook and re.search(r"setInterval", hook),
             "the progress poll must be single-flighted on an interval")
        need("percent" in types, "StatusOp type must expose percent")
        # IDE: ProgressBar from useRunProgress
        need("useRunProgress" in app and "<ProgressBar" in app,
             "IDE must render ProgressBar from useRunProgress")
        # Node view: the Run-all progress bar was removed -- fast runs made the
        # toolbar jump, so the Run button that flips to Stop is now the only
        # running indicator. The progress-tracking state went with it, while
        # cancellation (Stop -> cancelRun) is untouched.
        need("<ProgressBar" not in nb and "nb2-run-progress" not in nb,
             "Node view must not render a Run-all progress bar")
        need("runAllProg" not in nb and "runProg" not in nb,
             "Node view Run-all progress-tracking state must be fully removed")
        need(
            re.search(r"running\s*\?", nb)
            and "onClick={onCancelRun}" in nb
            and "onClick={onRunAll}" in nb
            and "onCancelRun={() => { void cancelRun(); }}" in nb
            and "onRunAll={() => { void runAll(); }}" in nb,
            "Node view must keep the Run<->Stop toggle (Stop wired to cancelRun)",
        )
        # Journal (Notebook.tsx): was previously missing the bar -- now wired
        need("<ProgressBar" in journal and "journalProg" in journal,
             "Journal must render ProgressBar and track Run-all cell progress")
        need(re.search(r"setJournalProg\(\{\s*done", journal),
             "Journal Run all must report cells done/total to the bar")

    def t_run_cancel_consolidation():
        # The three run surfaces share one cancel module so a Stop behaves
        # identically everywhere. And because jsonFetch now maps an aborted
        # fetch to ApiError(0), a superseded/cancelled run must be classified by
        # the shared isCancelledError -- NOT the old e?.name === "AbortError",
        # which silently stopped matching and surfaced a red "Request aborted".
        rc = _read_fe("src", "lib", "runController.ts")
        app = _read_fe("src", "App.tsx")
        journal = _read_fe("src", "components", "Notebook.tsx")
        node = _read_nodebook_source()
        for fn in ("cancelOne", "cancelAllRuns", "isCancelledError",
                   "cancelById", "registerRun"):
            need(("export function " + fn) in rc,
                 "runController must export " + fn)
        need('name === "AbortError"' in rc and "status === 0" in rc,
             "isCancelledError must catch both a raw AbortError and the "
             "ApiError(0) timeout/abort mapping")
        need("abortRegistered" in rc and "cancelQuery" in rc
             and "abort every local fetch" in rc,
             "cancelOne/cancelById must abort ALL registered fetches "
             "AND interrupt the backend")
        need('from "./lib/runController"' in app and "cancelOne(" in app,
             "IDE must use the shared cancelOne")
        need('from "../lib/runController"' in journal
             and "cancelOne(" in journal,
             "Journal must use the shared cancelOne")
        need(('from "../lib/runController"' in node
              or 'from "../../lib/runController"' in node)
             and ("cancelAllRuns(" in node or "cancelOne(" in node),
             "Node must use the shared run-cancel module (Stop -> cancelAllRuns)")
        # the regression is fixed: the broken name-check is gone from the run
        # catches, replaced by the shared classifier
        need('e?.name === "AbortError"' not in app,
             "IDE must not use the broken AbortError name-check")
        need('e?.name === "AbortError"' not in journal,
             "Journal must not use the broken AbortError name-check")
        need("isCancelledError(e, queryId)" in app
             and "isCancelledError(e, queryId)" in journal
             and "isCancelledError(e)" in node,
             "IDE + Journal + Node catches must classify cancels via "
             "isCancelledError")

    def t_shared_format_and_id_helpers():
        # uid and the byte/count formatters live in one place and are reused,
        # not re-implemented per component.
        ids = _read_fe("src", "lib", "ids.ts")
        fmt = _read_fe("src", "lib", "format.ts")
        need("export function uid" in ids, "shared uid must exist in lib/ids")
        need("export function formatBytes" in fmt
             and "export function formatCount" in fmt,
             "shared formatters must exist in lib/format")
        for f in ("App.tsx", "components/NodeFlow.tsx",
                  "components/Notebook.tsx"):
            src = _read_fe("src", *f.split("/"))
            need("const uid = () =>" not in src,
                 f + " must not redefine uid locally")
            need('/lib/ids"' in src or '/ids"' in src,
                 f + " must import the shared uid")
        app = _read_fe("src", "App.tsx")
        lm = _load_data_source()
        am = _read_fe("src", "components", "ActivityModal.tsx")
        need("function fmtSize" not in lm and "formatBytes(" in lm,
             "LoadDataModal must reuse formatBytes")
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        need("const fmtB =" not in shared and "formatBytes(" in shared,
             "the activity tray (ActivityShared) must reuse formatBytes")
        need("const fmtRows =" not in am and "formatCount(" in am,
             "ActivityModal must reuse formatCount")

    def t_dom_helpers_shared():
        # blob-download and clipboard-copy each go through one helper, not
        # re-implemented inline per component.
        apisrc = _read_fe("src", "lib", "api.ts")
        need("export async function saveToDownloads" in apisrc,
             ".539: the ONE download rail is the server-side save "
             "(blob anchors are a no-op in the native window)")
        need("export async function copyText" in apisrc,
             "copyText helper must exist")
        for f in ("components/NodeFlow.tsx", "components/ErrorLogModal.tsx",
                  "components/CreatedNodeModals.tsx"):
            src = _read_fe("src", *f.split("/"))
            need("URL.createObjectURL" not in src,
                 f + " must not run an inline download dance")
            need("saveLineage(" in src or "saveToDownloads(" in src,
                 f + " must save server-side (.539)")
        for f in ("components/SqlEditor.tsx", "components/DataGrid.tsx"):
            src = _read_fe("src", *f.split("/"))
            need("execCommand" not in src,
                 f + " must use copyText, not an inline clipboard fallback")
            need("copyText(" in src, f + " must call copyText")

    def t_concurrent_reads_ui_wiring():
        apisrc = _read_fe("src", "lib", "api.ts")
        need("setConcurrentReads:" in apisrc
             and "/api/settings/concurrent-reads" in apisrc,
             "api.setConcurrentReads must hit the concurrent-reads route")
        types = _read_fe("src", "lib", "types.ts")
        need("concurrent_reads" in types,
             "Health type must carry concurrent_reads")
        app = _read_fe("src", "App.tsx")
        # .426: the toggle is RETIRED -- always on; the menu must not
        # offer it and App must not carry the dead handler.
        need("api.setConcurrentReads(" not in app
             and "toggleConcurrentReads" not in app
             and "async reads" not in app,
             "the async-reads toggle is retired from the UI")

    def t_activity_status_shared():
        shared = _read_fe("src", "components", "ActivityShared.tsx")
        lib = _read_fe("src", "lib", "activity.ts")
        need("export function useActivityStatus" in shared
             and "export function useEngineReset" in shared
             and "export const ActivityMonitor" in shared,
             "ActivityShared must export the hooks + monitor")
        need("export function deriveActivity" in lib,
             "activity lib must export deriveActivity")
        am = _read_fe("src", "components", "ActivityModal.tsx")
        need("useActivityStatus" in am and "ActivityMonitor" in am,
             "ActivityModal must reuse the shared monitor/hooks")
        need("const badge =" not in am and "api.status" not in am,
             "ActivityModal must not re-implement badges or polling")
        shared_src = _read_fe("src", "components", "ActivityShared.tsx")
        need("export const ServerStatus" in shared_src
             and "<ActivityMonitor" in shared_src,
             "the shared ServerStatus renders the shared ActivityMonitor")
        need("Reset server" in shared_src
             and "Reset engines" in shared_src
             and "useEngineReset" in shared_src
             and "softResetEngines" in shared_src,
             "the shared ServerStatus has soft + nuclear reset buttons")

    def t_formula_x_gap():
        css = _read_fe("src", "styles.css")
        need("width: calc(100% - 36px)" in css,
             "formula textarea gutter must exceed the 30px x button so they "
             "don't touch")

    def t_stat_indicator_and_export_shared():
        app = _read_fe("src", "App.tsx")
        need("StatIndicator" in app and "MemoryIndicator" not in app,
             "the memory indicator should be renamed StatIndicator")
        need('"stat"' in app and ': "mem"' not in app,
             "the badge label should read 'stat', not 'mem'")
        apisrc = _read_fe("src", "lib", "api.ts")
        need("export async function exportResultToFile" in apisrc,
             "shared exportResultToFile helper must exist")
        need("exportResultToFile(" in app,
             "IDE result export must use the shared helper")
        nb = _read_fe("src", "components", "Notebook.tsx")
        need("exportResultToFile(" in nb,
             "Journal cell export must use the shared helper")
        need("api.exportResult(" not in nb,
             "Journal must not call api.exportResult directly anymore")

    def t_datagrid_pretty_struct():
        # A nested cell (a DuckDB struct, a JSON value) reaches the grid as a
        # one-line string -- single-quoted for a struct repr, double-quoted for
        # JSON -- so it's cramped and unreadable inline. A hover-revealed "{ }"
        # button on those cells opens a popover that reindents the value
        # (quote-agnostic, tolerant of truncation) with a Copy. DataGrid is
        # shared by the SQL IDE result grid AND the NodeFlow node-flow preview,
        # so the fix lands in both. Source-guarded (no node_modules / JS runtime
        # in the sandbox); the reindenter's logic is exercised separately.
        ps = _read_fe("src", "lib", "prettyStruct.ts")
        dg = _read_fe("src", "components", "DataGrid.tsx")
        css = _read_fe("src", "styles.css")
        missing = []
        # the pure helper: a detector + a reindenter, both exported
        if "export function prettyStruct" not in ps:
            missing.append("prettyStruct.ts: export prettyStruct")
        if "export function looksStructy" not in ps:
            missing.append("prettyStruct.ts: export looksStructy")
        # strings are tracked so punctuation inside a value isn't broken
        if "inStr" not in ps:
            missing.append("prettyStruct.ts: must track quoted spans")
        # DataGrid imports + uses them, gates the affordance on looksStructy
        if 'from "../lib/prettyStruct"' not in dg:
            missing.append("DataGrid: import prettyStruct helpers")
        if "looksStructy(f.text)" not in dg:
            missing.append("DataGrid: gate expander on looksStructy")
        # Pretty-print is deferred after open (viewerPretty) so large values
        # don't block the first paint of the popup.
        if "prettyStruct(" not in dg or "viewerPretty" not in dg:
            missing.append("DataGrid: viewer must reindent the value (deferred)")
        # the expander button + the viewer popover state/markup
        for tok in ("gc-expand", "setViewer(", "gc-json-pop", "gc-json-body"):
            if tok not in dg:
                missing.append("DataGrid: " + tok)
        # the viewer must clear when the result changes
        if dg.count("setViewer(null)") < 1:
            missing.append("DataGrid: clear viewer on new page")
        # styling for both pieces
        if ".gc-expand" not in css or ".gc-json-pop" not in css:
            missing.append("pretty-print CSS (.gc-expand / .gc-json-pop)")
        need(not missing,
             "pretty-print viewer incomplete: " + ", ".join(missing))

    def t_refactor_phase3_component_decomposition():
        components = os.path.join(FRONTEND, "src", "components")
        load_dir = os.path.join(components, "load")
        notebook_dir = os.path.join(components, "notebook")

        load_shell = _read_text(os.path.join(components, "LoadDataModal.tsx"))
        cell_shell = _read_text(os.path.join(components, "NotebookCell.tsx"))
        load_files = {
            name: _read_text(os.path.join(load_dir, name))
            for name in (
                "ApiLoadTab.tsx",
                "FileBrowser.tsx",
                "FileLoadTab.tsx",
                "FlattenLoadTab.tsx",
                "HdfsLoadTab.tsx",
                "MsSqlConnectForm.tsx",
                "RootIdPicker.tsx",
                "SqlServerLoadTab.tsx",
            )
        }
        cell_files = {
            name: _read_text(os.path.join(notebook_dir, name))
            for name in (
                "NotebookCellShared.tsx",
                "NotebookCellTypes.ts",
                "NoteNotebookCell.tsx",
                "ReconcileNotebookCell.tsx",
                "SqlNotebookCell.tsx",
                "VisualizationNotebookCell.tsx",
            )
        }
        checks = [
            ("load shell is composition-only",
             len(load_shell.splitlines()) < 230
             and "<FileLoadTab" in load_shell
             and "<ApiLoadTab" in load_shell
             and "<SqlServerLoadTab" in load_shell
             and "<HdfsLoadTab" in load_shell
             and "<FlattenLoadTab" in load_shell
             and "api." not in load_shell),
            ("load source responsibilities are isolated",
             re.search(r"api\s*\.\s*apiFetch\b", load_files["ApiLoadTab.tsx"])
             and re.search(r"api\s*\.\s*mssqlImport\b", load_files["SqlServerLoadTab.tsx"])
             and "MsSqlConnectForm" in load_files["SqlServerLoadTab.tsx"]
             and "persistMsSqlProfile" in load_files["MsSqlConnectForm.tsx"]
             and re.search(r"api\s*\.\s*flattenStart\b", load_files["FlattenLoadTab.tsx"])
             and re.search(r"api\s*\.\s*hdfsConnect\b", load_files["HdfsLoadTab.tsx"])
             and re.search(r"api\s*\.\s*excelSheets\b", load_files["FileLoadTab.tsx"])
             and re.search(r"api\s*\.\s*loadPreflight\b",
                           load_files["FileLoadTab.tsx"])
             and "load-preflight" in load_files["FileLoadTab.tsx"]
             and re.search(r"api\s*\.\s*fsList\b", load_files["FileBrowser.tsx"])
             and re.search(r"api\s*\.\s*loadSniff\b", load_files["RootIdPicker.tsx"])),
            ("legacy load exports remain compatible",
             'export { FileBrowser } from "./load/FileBrowser"' in load_shell
             and 'export { RootIdPicker } from "./load/RootIdPicker"' in load_shell),
            ("load children do not import their parent shell",
             all("LoadDataModal" not in text for text in load_files.values())),
            ("notebook shell is composition-only",
             len(cell_shell.splitlines()) < 230
             and "<SqlNotebookCell" in cell_shell
             and "<VisualizationNotebookCell" in cell_shell
             and "<ReconcileNotebookCell" in cell_shell
             and "<NoteNotebookCell" in cell_shell
             and "DataGrid" not in cell_shell
             and "ReconReport" not in cell_shell),
            ("notebook types and chrome have one owner",
             "export interface RunCell" in cell_files["NotebookCellTypes.ts"]
             and "export interface NotebookCellProps" in cell_files["NotebookCellTypes.ts"]
             and "export const NotebookMoveDeleteActions" in cell_files["NotebookCellShared.tsx"]
             and "export const NotebookResizeGrip" in cell_files["NotebookCellShared.tsx"]),
            ("cell-specific dependencies stay in their renderers",
             "DataGrid" in cell_files["SqlNotebookCell.tsx"]
             and "ChartPanel" in cell_files["VisualizationNotebookCell.tsx"]
             and "ReconReport" in cell_files["ReconcileNotebookCell.tsx"]
             and "renderNotebookNote" in cell_files["NoteNotebookCell.tsx"]),
            ("notebook children do not import their parent shell",
             all('from "../NotebookCell"' not in text
                 and 'from "./NotebookCell"' not in text
                 for text in cell_files.values())),
            ("rendered regressions cover both decomposed families",
             os.path.isfile(os.path.join(components,
                                         "LoadDataModal.component.test.tsx"))
             and os.path.isfile(os.path.join(components,
                                             "NotebookCell.component.test.tsx"))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-3 component decomposition broken: "
             + "; ".join(missing))

    def t_refactor_phase4_shared_paging():
        hook = _read_fe("src", "lib", "usePagedResult.ts")
        app = _read_fe("src", "App.tsx")
        notebook = _read_fe("src", "components", "Notebook.tsx")
        app_types = _read_fe("src", "controllers", "appTypes.ts")
        result_controller = _read_fe(
            "src", "controllers", "useResultController.ts")
        prep = _read_fe("src", "controllers", "README.md")
        test_path = os.path.join(
            FRONTEND, "src", "lib", "usePagedResult.component.test.tsx"
        )
        tests = _read_text(test_path) if os.path.isfile(test_path) else ""
        checks = [
            ("one shared paging hook owns the state machine",
             "export function usePagedResult" in hook
             and "latest-request-wins" in hook
             and "cancelPending" in hook
             and "rerunExpired" in hook
             and "registerRun" in hook
             and "Do NOT cancelQuery" in hook),
            ("IDE delegates sort/filter/scroll/reactivation",
             "resultPaging.sortBy" in app
             and "resultPaging.applyFilters" in app
             and "resultPaging.loadMore" in app
             and "usePagedResult<ResultTab>" in result_controller
             and "resultPaging.refresh" in result_controller
             and "reactivateSeq" not in app),
            ("Journal delegates sort/scroll/collapse recovery",
             "notebookPaging.sortBy" in notebook
             and "notebookPaging.loadMore" in notebook
             and "notebookPaging.refresh" in notebook
             and "loadingMore.current" not in notebook),
            ("expiry reruns return the replacement result id",
             "Promise<string | null>" in app
             and "rerunExpiredResultRef.current" in app
             and "rerunExpiredCellRef.current" in notebook),
            ("behavioral race regressions ship",
             all(token in tests for token in (
                 "latest rapid filter response",
                 "prevents duplicate next-page requests",
                 "reruns an expired result",
                 "drops a stale load-more response",
                 "aborts pending page work on unmount",
                 "survives React StrictMode effect replay",
                 "retained-row memory ceiling",
             ))),
            ("Phase 5 controller seam is established",
             "export interface ResultTab" in app_types
             and "export interface EdTab" in app_types
             and "useResultController" in prep
             and "interface ResultTab" not in app),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-4 shared paging broken: " + "; ".join(missing))

    def t_refactor_phase9_nodeflow_performance():
        components = os.path.join(FRONTEND, "src", "components")
        nodeflow_dir = os.path.join(components, "nodeflow")
        component = _read_text(os.path.join(components, "NodeFlow.tsx"))
        scene = _read_text(os.path.join(nodeflow_dir, "NodeFlowScene.tsx"))
        render_model = _read_text(os.path.join(
            nodeflow_dir, "nodeFlowRenderModel.ts"))
        canvas_shell = _read_text(os.path.join(
            nodeflow_dir, "NodeFlowCanvasShell.tsx"))
        inspector_panel = _read_text(os.path.join(
            nodeflow_dir, "NodeFlowInspectorPanel.tsx"))
        inspector_controller = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowInspectorController.tsx"))
        graph_controller = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowGraphController.ts"))
        graph_snapshot = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowGraphSnapshot.ts"))
        animations = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowAnimations.ts"))
        chart_hydration = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowChartHydration.ts"))
        stable_event = _read_fe("src", "lib", "useStableEvent.ts")
        perf_tests = _read_text(os.path.join(
            nodeflow_dir, "NodeFlowPhase9Performance.component.test.tsx"))
        model_tests = _read_text(os.path.join(
            nodeflow_dir, "nodeFlowRenderModel.component.test.ts"))
        checks = [
            ("NodeFlow is now a thin composition shell",
             len(component.splitlines()) < 800
             and "<NodeFlowScene" in component
             and "<NodeFlowInspectorPanel" in component
             and "<NodeFlowPreviewDrawer" in component
             and "<CanvasNodeFrame" not in component
             and "nodes.map(" not in component),
            ("canvas cards invalidate from local graph dependencies",
             "renderVersionByNode" in render_model
             and "incomingByNode" in render_model
             and "dashboardSourceIdsByNode" in render_model
             and "renderVersion={renderModel.renderVersionByNode[node.id]"
                 in scene
             and "graphVersion" not in scene),
            ("large workflows cull off-screen nodes and wires",
             "LARGE_GRAPH_NODE_THRESHOLD" in render_model
             and "LARGE_GRAPH_WIRE_THRESHOLD" in render_model
             and "selectVisibleCanvasNodes" in render_model
             and "selectVisibleCanvasWires" in render_model
             and "selectVisibleCanvasNodes(nodes, viewport, zoom" in scene
             and 'data-virtualized={renderedNodeCount < nodes.length'
                 in canvas_shell),
            ("drag frames avoid graph serialization and inspector rerenders",
             "useNodeFlowGraphSnapshot(nodes, edges)" in component
             and "key.config !== node.config" in graph_snapshot
             and "x: node.x" not in graph_snapshot
             and "previous.graphSig === next.graphSig" in inspector_panel
             and "previous.scopeKey === next.scopeKey" in inspector_panel),
            ("event, graph, and transient work have stable focused owners",
             "export function useStableEvent" in stable_event
             and component.count("useStableEvent(") >= 8
             and "export function useNodeFlowGraphController" in graph_controller
             and "export function useNodeFlowAnimations" in animations
             and "window.cancelAnimationFrame" in animations
             and "useNodeFlowChartHydration" in component
             and "graphSignature" in chart_hydration
             and "window.cancelAnimationFrame" in chart_hydration
             and "setInputColumns" in inspector_controller),
            ("Phase 9 rendered and pure regressions ship",
             all(token in perf_tests for token in (
                 "renders every card for normal workflows",
                 "virtualizes an oversized graph",
                 "data-total-nodes",
                 "data-rendered-nodes",
                 "without rerendering a stationary sibling",
                 "survives StrictMode replay",
                 "newly loaded expanded chart in the same tab",
             ))
             and all(token in model_tests for token in (
                 "invalidates only incident cards",
                 "tracks dashboard source config",
                 "virtualizes only above the large-graph threshold",
                 "four-thousand-node render model",
                 "culls off-screen wires",
             ))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-9 NodeFlow rendering/performance broken: "
             + "; ".join(missing))

    def t_refactor_phase8_nodeflow_orchestration():
        components = os.path.join(FRONTEND, "src", "components")
        nodeflow_dir = os.path.join(components, "nodeflow")
        component = _read_text(os.path.join(components, "NodeFlow.tsx"))
        execution = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowExecutionController.ts"))
        documents = _read_text(os.path.join(
            nodeflow_dir, "useNodeFlowDocumentController.ts"))
        regressions = _read_text(os.path.join(
            nodeflow_dir, "NodeFlowPhase8Controllers.component.test.tsx"))
        checks = [
            ("NodeFlow is a thin composition shell",
             len(component.splitlines()) < 2200
             and "useNodeFlowExecutionController({" in component
             and "useNodeFlowDocumentController({" in component
             and "const startRun =" not in component
             and "const loadTabIntoState =" not in component),
            ("execution lifecycle has one scope-aware owner",
             all(token in execution for token in (
                 "scopeVersionRef", "runScopesRef", "isRunCurrent",
                 "cancelAllRuns(ids)", "runDepth.current",
                 "previousTabRef.current === activeTabId",
                 "previewCache.current.clear()",
             ))),
            ("document lifecycle owns tabs, history, autosave, and files",
             all(token in documents for token in (
                 "useNodeFlowAutosave({", "loadTabIntoState",
                 "saveActiveTab", "openGraphInNewTab",
                 "persistGraphNow", "openFileSeqRef",
                 "lastNodeCmd",
             ))),
            ("Phase 8 stale and concurrency regressions ship",
             all(token in regressions for token in (
                 "drops a stale execution result after switching tabs",
                 "keeps concurrent run state active until the final request finishes",
                 "keeps only the latest asynchronous workflow file open",
             ))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-8 NodeFlow orchestration broken: "
             + "; ".join(missing))

    def t_refactor_phase7_nodeflow_controller():
        components = os.path.join(FRONTEND, "src", "components")
        nodeflow_dir = os.path.join(components, "nodeflow")
        component = _read_text(os.path.join(components, "NodeFlow.tsx"))

        module_names = [
            "NodeFlowCanvasShell.tsx",
            "NodeFlowTabBar.tsx",
            "NodeFlowPalette.tsx",
            "NodeFlowMenus.tsx",
            "NodeFlowStatusBar.tsx",
            "useNodeFlowViewport.ts",
            "useNodeFlowClipboard.ts",
            "useNodeFlowKeyboardShortcuts.ts",
            "useNodeFlowCanvasInteractions.ts",
            "useNodeFlowAutosave.ts",
            "useNodeFlowGraphController.ts",
            "nodeFlowGraphCommands.ts",
        ]
        modules = {
            name: _read_text(os.path.join(nodeflow_dir, name))
            for name in module_names
        }
        command_test = os.path.join(
            nodeflow_dir, "nodeFlowGraphCommands.component.test.ts"
        )
        controller_test = os.path.join(
            nodeflow_dir, "NodeFlowControllerHooks.component.test.tsx"
        )
        checks = [
            ("NodeFlow is a smaller composition/controller shell",
             len(component.splitlines()) < 2200
             and all(os.path.isfile(os.path.join(nodeflow_dir, name))
                     for name in module_names)
             and 'from "./nodeflow/useNodeFlowDocumentController"' in component
             and 'from "./nodeflow/useNodeFlowExecutionController"' in component),
            ("canvas interactions and shortcut listeners have focused owners",
             'window.addEventListener("pointermove"' not in component
             and 'window.addEventListener("keydown"' not in component
             and 'window.addEventListener("pointermove"'
                 in modules["useNodeFlowCanvasInteractions.ts"]
             and 'window.addEventListener("keydown"'
                 in modules["useNodeFlowKeyboardShortcuts.ts"]),
            ("viewport, clipboard, and autosave state machines are extracted",
             "export function useNodeFlowViewport"
                 in modules["useNodeFlowViewport.ts"]
             and "export function useNodeFlowClipboard"
                 in modules["useNodeFlowClipboard.ts"]
             and "export function useNodeFlowAutosave"
                 in modules["useNodeFlowAutosave.ts"]
             and "persistGraphNow" in modules["useNodeFlowAutosave.ts"]),
            ("tabs, palette, canvas, menus, and status UI are focused modules",
             "export const NodeFlowTabBar" in modules["NodeFlowTabBar.tsx"]
             and "export const NodeFlowPalette" in modules["NodeFlowPalette.tsx"]
             and "export const NodeFlowCanvasShell" in modules["NodeFlowCanvasShell.tsx"]
             and "export const NodeFlowMenus" in modules["NodeFlowMenus.tsx"]
             and "export const NodeFlowStatusBar" in modules["NodeFlowStatusBar.tsx"]),
            ("graph edits share pure command functions",
             all(token in modules["nodeFlowGraphCommands.ts"] for token in (
                 "export function createGraphNode",
                 "export function patchNodeConfig",
                 "export function appendGroupChild",
                 "export function dissolveContainerGraph",
                 "export function removeGraphNodes",
                 "export function moveNodeIntoContainer",
             ))
             and all(token in modules["useNodeFlowGraphController.ts"]
                     for token in (
                 "createGraphNode(type, x, y)",
                 "patchNodeConfig(current, id, config)",
                 "dissolveContainerGraph(",
                 "removeGraphNodes(",
                 "moveNodeIntoContainer(",
             ))
             and "useNodeFlowGraphController({" in component),
            ("Phase 7 behavioral regressions ship",
             os.path.isfile(command_test)
             and os.path.isfile(controller_test)
             and "removes selected nodes and every incident edge atomically"
                 in _read_text(command_test)
             and "pastes fresh node, edge, and child ids"
                 in _read_text(controller_test)
             and "ignores destructive keys while typing"
                 in _read_text(controller_test)),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-7 NodeFlow controller extraction broken: "
             + "; ".join(missing))

    def t_refactor_phase6_nodeflow_modules():
        components = os.path.join(FRONTEND, "src", "components")
        nodeflow_dir = os.path.join(components, "nodeflow")
        component = _read_text(os.path.join(components, "NodeFlow.tsx"))
        inspector = _read_text(os.path.join(nodeflow_dir, "NodeFlowInspector.tsx"))
        inspector_panel = _read_text(os.path.join(
            nodeflow_dir, "NodeFlowInspectorPanel.tsx"))
        scene = _read_text(os.path.join(nodeflow_dir, "NodeFlowScene.tsx"))
        palette = _read_text(os.path.join(nodeflow_dir, "NodeFlowPalette.tsx"))
        controls = _read_text(os.path.join(nodeflow_dir, "InspectorControls.tsx"))
        inspector_shell = _read_text(os.path.join(nodeflow_dir, "InspectorShell.tsx"))
        definitions = _read_text(os.path.join(nodeflow_dir, "nodeDefinitions.ts"))
        definition_test = os.path.join(
            nodeflow_dir, "nodeDefinitions.component.test.ts"
        )
        inspector_test = os.path.join(
            nodeflow_dir, "NodeFlowInspector.component.test.tsx"
        )
        checks = [
            ("NodeFlow shell is materially smaller and composes the inspector",
             len(component.splitlines()) < 5500
             and 'from "./nodeflow/NodeFlowInspectorPanel"' in component
             and "<NodeFlowInspectorPanel" in component
             and 'from "./NodeFlowInspector"' in inspector_panel),
            ("palette/default/summary behavior has one registry owner",
             'from "./nodeDefinitions"' in scene
             and 'from "./nodeDefinitions"' in palette
             and "satisfies Record<NodeType, NodeDefinition>" in definitions
             and "export const NODE_PALETTE_ORDER" in definitions
             and "export const createDefaultNodeConfig" in definitions
             and "export const getNodeCardSummary" in definitions
             and "const defaultConfig" not in component
             and "const PALETTE" not in component),
            ("inspector selection and resize behavior use the registry",
             "export const getNodeInspectorType" in definitions
             and "export const nodeInspectorIsResizable" in definitions
             and "getNodeInspectorType(sel.type)" in inspector
             and "const inspectorDefinition =" in inspector
             and inspector.count('inspectorType === "') >= 45
             and 'sel.type === "' not in inspector),
            ("shared inspector controls and chrome have focused modules",
             "export function ReorderList" in controls
             and "export function ColumnPicker" in controls
             and "export const InspectorShell" in inspector_shell
             and "startPointerDrag" in inspector_shell),
            ("inspector context is explicit rather than an any bag",
             "export interface NodeFlowInspectorContext" in inspector
             and "[key: string]: any" not in inspector),
            ("registry covers fresh defaults for source/controller nodes",
             'filebrowser: define("filebrowser", "File browser"' in definitions
             and 'apinode: define("apinode", "API"' in definitions
             and 'while: define("while", "Repeat until"' in definitions),
            ("rendered and registry regressions ship",
             os.path.isfile(definition_test)
             and os.path.isfile(inspector_test)
             and "returns fresh default configuration objects" in _read_text(definition_test)
             and "renders and updates an input node" in _read_text(inspector_test)),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-6 NodeFlow extraction broken: "
             + "; ".join(missing))

    def t_refactor_phase5_app_controllers():
        app = _read_fe("src", "App.tsx")
        controller_dir = os.path.join(FRONTEND, "src", "controllers")
        controller_names = [
            "useCatalogController.ts",
            "useIdeController.ts",
            "useResultController.ts",
            "useWorkspaceController.ts",
            "useBackgroundOperations.ts",
        ]
        controllers = {
            name: _read_text(os.path.join(controller_dir, name))
            for name in controller_names
        }
        rendered_path = os.path.join(
            controller_dir, "AppControllers.component.test.tsx"
        )
        rendered = (
            _read_text(rendered_path) if os.path.isfile(rendered_path) else ""
        )
        checks = [
            ("all five focused controllers ship",
             all(os.path.isfile(os.path.join(controller_dir, name))
                 for name in controller_names)
             and all("export function " + name[:-3] in controllers[name]
                     for name in controller_names)),
            ("App composes controllers instead of owning their state",
             all((f'from "./controllers/{name[:-3]}"' in app)
                 for name in controller_names)
             and "const [tables, setTables]" not in app
             and "const [edTabs, setEdTabs]" not in app
             and "const [resTabs, setResTabs]" not in app
             and "const [ideWfNames, setIdeWfNames]" not in app
             and "const bgOps =" not in app),
            ("catalog latest-wins and disconnect behavior moved together",
             "tablesSeq" in controllers["useCatalogController.ts"]
             and "historySeq" in controllers["useCatalogController.ts"]
             and "savedSeq" in controllers["useCatalogController.ts"]
             and "workflowsSeq" in controllers["useCatalogController.ts"]
             and "mssqlDisconnect" in controllers["useCatalogController.ts"]),
            ("IDE tabs, undo, and per-tab runs share one owner",
             all(token in controllers["useIdeController.ts"] for token in (
                 "ideHistory", "cancelRunning", "setRuns", "newTab",
                 "loadSqlIntoEditor", "onEditorKeyDown",
             ))),
            ("result controller owns paging and detached views",
             all(token in controllers["useResultController.ts"] for token in (
                 "usePagedResult", "rerunExpiredResultRef", "released",
                 "floatView", "pruneCompare", "maxRetainedRows",
             ))),
            ("workspace routing is centralized and persistent",
             all(token in controllers["useWorkspaceController.ts"] for token in (
                 "parseWfFile", "workflowSave", "workflowLoad",
                 "activeSaveAs", "switchView",
             ))
             and 'setView("ide")' not in app),
            ("background cancellation and task completion share one rail",
             all(token in controllers["useBackgroundOperations.ts"]
                 for token in (
                     "registerBgCancel", "cancelAllBgOps", "beginLoad",
                     "beginLoadFolder", "beginHdfsFileLoad",
                     "beginOptimize", "onTaskComplete",
                 ))),
            # .608+: Field Explorer shred/flatten + Output/export wiring grew
            # the shell; still far below the pre-refactor monolith (~10k+), so
            # the "materially smaller" intent holds with modest headroom.
            ("App shell is materially smaller",
             len(app.splitlines()) < 5500),
            ("rendered controller regressions ship",
             os.path.isfile(rendered_path)
             and all(token in rendered for token in (
                 "recovers a stale active id",
                 "cancels only the active tab run",
                 "keeps the newest table refresh response",
                 "releases inactive rows",
                 "routes raw SQL and Journal envelopes",
                 "starts loads, closes the modal",
             ))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-5 App controller extraction broken: "
             + "; ".join(missing))

    def t_refactor_phase2_shared_utilities():
        def rd(*parts):
            return open(os.path.join(FRONTEND, *parts), encoding="utf-8").read()

        api = rd("src", "lib", "api.ts")
        api_profiles = rd("src", "lib", "apiProfiles.ts")
        sql_profiles = rd("src", "lib", "sqlProfiles.ts")
        named = rd("src", "lib", "namedProfiles.ts")
        pointer = rd("src", "lib", "pointerDrag.ts")
        reconcile = rd("src", "lib", "reconcileRequest.ts")
        app = rd("src", "App.tsx")
        notebook = rd("src", "components", "Notebook.tsx")
        migrated = {
            "App": app,
            "DataGrid": rd("src", "components", "DataGrid.tsx"),
            "Notebook": notebook,
            "NotebookCell": _notebook_cell_source(),
            "PivotPanel": rd("src", "components", "PivotPanel.tsx"),
        }
        nodeflow = _read_nodebook_source()
        checks = [
            ("generic profile parser exists",
             "export function parseNamedProfiles" in named
             and "export function dumpNamedProfiles" in named
             and "export function readLastProfileName" in named),
            ("API and SQL profiles delegate to the generic envelope",
             "parseNamedProfiles(raw, coerceProfile)" in api_profiles
             and "dumpNamedProfiles(profiles, lastProfile)" in api_profiles
             and "parseNamedProfiles(raw, coerceProfile)" in sql_profiles
             and "dumpNamedProfiles(profiles, lastProfile)" in sql_profiles),
            ("both upload endpoints use one FormData builder",
             api.count("buildLoadForm(files, {") == 2
             and "const fd = new FormData();" not in api[api.index("loadFiles:"):api.index("excelSheets:")]),
            ("IDE and Journal share reconcile detail payload construction",
             rd("src", "lib", "reconDetailActions.ts").count(
                 "buildReconcileRequest(spec, bucket, field") == 2
             and notebook.count("buildReconcileRequest(spec, bucket, field") == 2
             and "export function buildReconcileRequest" in reconcile),
            ("pointer helper owns move/up/cancel cleanup",
             'removeEventListener("pointercancel"' in pointer
             and 'addEventListener("pointercancel"' in pointer
             and "if (!active) return" in pointer),
            ("migrated surfaces no longer duplicate window drag cleanup",
             all('window.addEventListener("pointermove"' not in src
                 for src in migrated.values())),
            ("NodeFlow uses helper for local drags but keeps its mounted canvas listener",
             nodeflow.count("startPointerDrag({") >= 3
             and nodeflow.count('window.addEventListener("pointermove"') == 1),
            ("behavioral component regression ships",
             os.path.isfile(os.path.join(FRONTEND, "src", "lib",
                                         "refactorUtilities.component.test.ts"))),
        ]
        missing = [name for name, ok in checks if not ok]
        need(not missing, "phase-2 utility consolidation broken: "
             + "; ".join(missing))

    for name, fn in [
        ("refactor phase 9: NodeFlow projection + large-canvas rendering are optimized",
         t_refactor_phase9_nodeflow_performance),
        ("refactor phase 8: NodeFlow execution + document orchestration are extracted",
         t_refactor_phase8_nodeflow_orchestration),
        ("refactor phase 7: NodeFlow controller + canvas responsibilities are extracted",
         t_refactor_phase7_nodeflow_controller),
        ("refactor phase 6: NodeFlow inspector + node registry are extracted",
         t_refactor_phase6_nodeflow_modules),
        ("refactor phase 5: App state machines live in focused controllers",
         t_refactor_phase5_app_controllers),
        ("refactor phase 4: IDE and Journal share paging + Phase 5 seam",
         t_refactor_phase4_shared_paging),
        ("refactor phase 3: load tabs + notebook cell renderers are focused modules",
         t_refactor_phase3_component_decomposition),
        ("refactor phase 2: shared persistence/load/drag/reconcile utilities",
         t_refactor_phase2_shared_utilities),
        ("multipart cancellation + ReconReport hook order",
         t_form_fetch_and_recon_hook_order),
        ("API capability, JSON ceiling, shared transport, lint/e2e, cache budget",
         t_security_transport_and_tooling),
        ("UI <-> backend endpoint contract", t_contract),
        ("full wiring audit (api calls/methods, routes, button handlers)",
         t_wiring_audit),
        ("appendfolder/directory reads are cancel-wired (run id + cancelled)",
         t_folder_read_cancel_wiring),
        ("pivot subtotal collapse (collapse-to-subtotal shows rolled-up values)",
         t_pivot_subtotal_collapse_wiring),
        ("connection-status window + reset are hang-proof under load",
         t_status_reset_resilient_wiring),
        ("true progress bar (% complete) next to Run/Stop on all surfaces",
         t_run_progress_bar_wiring),
        ("IDE/Journal/Node share one run-cancel module (+ abort regression fix)",
         t_run_cancel_consolidation),
        ("uid + byte/count formatters are shared, not re-implemented",
         t_shared_format_and_id_helpers),
        ("blob-download + clipboard-copy go through one shared helper each",
         t_dom_helpers_shared),
        ("async-reads Settings toggle is wired end to end",
         t_concurrent_reads_ui_wiring),
        ("Activity modal + memory widget share one status monitor/reset",
         t_activity_status_shared),
        ("formula x button has a gap from its text box", t_formula_x_gap),
        ("stat indicator renamed + IDE/Journal share one export helper",
         t_stat_indicator_and_export_shared),
        ("no encoding corruption (U+FFFD)", t_no_mojibake),
        ("component file structure", t_structure),
        ("IDE view surface wiring", t_ide_surface),
        ("Journal view surface wiring", t_journal_surface),
        ("modal Cancel + close-X share one cancel fn",
         t_modal_cancel_close_consolidated),
        ("Node palette / category / config coverage", t_node_palette_coverage),
        ("Created Nodes: save/export/load + ports + run wiring",
         t_created_nodes_wiring),
        ("Disconnect + cell add-button placement wiring",
         t_disconnect_and_addbtn_wiring),
        ("HDFS connector tab wiring (connect/browse/scan/load, feed-first)",
         t_hdfs_tab_wiring),
        ("Load window X cancels in-flight op (api/flatten/hdfs) + load job",
         t_load_cancel_on_close),
        ("Flatten cancel rail: endpoint + tab registration + Cancel button",
         t_flatten_cancel_wiring),
        ("NodeFlow Stop hard-cancels the whole workflow (all runs + fetches)",
         t_nodebook_stop_cancels_all),
        ("IDE background ops (profile/save/change-type/flatten) cancel client-side",
         t_bg_ops_client_cancel),
        ("REST API fetch + MSSQL import cancel client-side (load modal)",
         t_rest_mssql_client_cancel),
        ("fetch timeout backstop bounds quick POSTs; data ops opt out",
         t_fetch_timeout_backstop),
        ("Notebook toolbar wrap + per-node help window",
         t_notebook_toolbar_and_node_help_wiring),
        ("Iterator top 'values' connector (FE geometry + backend driver)",
         t_iterator_top_port_wiring),
        ("Lucide icon set (uniform wrapper + distinct palette assignments)",
         t_lucide_icons),
        ("Type-safety fixes (tsc: implicit-any setters, PORTS string-index, "
         "dead sql label arm, ReconReport onExport)",
         t_type_safety_fixes),
        ("MSSQL saved-profile resilience (loads w/o pyodbc; never hidden)",
         t_mssql_profile_resilience),
        ("Iterator container (FE): drop target, child render, sizing, default",
         t_iterator_container_frontend),
        ("Iterator container inspector (FE): rename grid, fold, dissolve",
         t_iterator_container_inspector),
        ("Inspector UI polish (FE): header display name, SQL box width cap",
         t_inspector_ui_polish),
        ("Load finalize feedback (large files: finalizing phase, no frozen bar)",
         t_load_finalize_feedback),
        ("Iterator run fixes (FE): no loop-var gate, replace-keys from table",
         t_iterator_run_fixes),
        ("Node ports + note delete (FE): hide in/out text, red note delete",
         t_node_ports_and_note_delete),
        ("Iterator is container-routed, not a dead subtitle branch",
         t_iterator_container_not_subtitle),
        ("Iterator/while keep the table name on a failed run",
         t_iterator_keeps_table_name_on_fail),
        ("Formula inside an iterator hints loop vars + quoting (FE)",
         t_formula_iterator_var_hint),
        ("Journal delete buttons match (FE): query/chart/pivot like the note",
         t_journal_delete_buttons_match),
        ("Context menu scrolls when off-screen (FE): grid column right-click",
         t_ctx_menu_scrolls),
        ("Excel load UI (FE)",
         t_excel_load_ui_and_bi_export),
        ("Tableau/Power BI options removed from both menus (FE)",
         t_tableau_powerbi_ui_removed),
        ("Reconcile UI layout (table align + dropdown overlay)",
         t_recon_ui_layout_wiring),
        ("UI feature wiring", t_ui_feature_wiring),
        ("UI layout (select rows + grid column/row sizing)", t_ui_layout),
        ("Journal + Select-node UI polish (CSS structure)",
         t_journal_ui_polish),
        ("Journal cell resize (card-level + persistence)",
         t_journal_cell_resize),
        ("Journal drag-and-drop reorder (pointer-based)", t_journal_dnd),
        ("NodeFlow resize (sql node + config window)", t_nodebook_resize),
        ("Run all with no output node is a yellow nudge, not a red error",
         t_runall_no_output_is_soft_warning),
        ("Stalled cancel recovers the NodeFlow UI without a refresh",
         t_cancel_recovery_no_refresh),
        ("Undo/redo wiring (IDE editor + Journal)", t_undo_redo_wiring),
        ("reconcile mapping logic (esbuild + node)", t_recon_mapping_logic),
        ("reconcile report CSV export (esbuild + node)", t_recon_export_logic),
        ("profile CSV export (esbuild + node)", t_profile_export_logic),
        ("notebook chaining logic (esbuild + node)", t_notebook_logic),
        ("select field reconciliation (esbuild + node)",
         t_select_fields_logic),
        ("Select inspector: field search filter + Sort next to All/None",
         t_select_field_search_sort_wiring),
        ("Select fields follow Input table changes (graph-wide reconcile)",
         t_select_fields_follow_input_table_change),
        ("chart option builder (esbuild + node)", t_chart_option_logic),
        ("chart modules registered for every emitted series type",
         t_chart_modules_registered),
        ("node ports: frontend/backend parity + every type has a handler",
         t_node_port_parity),
        ("inspector input-column resolution audit (every node covered)",
         t_inspector_columns_audit),
        ("workflow kinds: node/journal/ide all routed on open + save",
         t_workflow_kind_routing),
        ("node-canvas geometry + graph (esbuild + node)", t_nodegraph_logic),
        ("NodeFlow model + memo comparator (esbuild + node)",
         t_nodebook_model_logic),
        ("NodeFlow split modules + stationary-card memo wiring",
         t_nodebook_split_and_memo_wiring),
        ("SQL functions catalog + caret insert (esbuild + node)",
         t_sql_functions_logic),
        ("tableCaps.ts: flatten offered on nested columns, not filename",
         t_table_caps_logic),
        ("IDE right-click 'SQL functions' submenu wiring (FE)",
         t_sql_functions_menu),
        ("editor statement-splitting logic (esbuild + node)",
         t_sql_statement_logic),
        ("IDE/Journal quote weird identifiers on insert + autocomplete",
         t_ide_journal_ident_quoting),
        ("float/dock/compare geometry (esbuild + node)",
         t_docking_logic),
        ("sql profiles + odbc driver pick (esbuild + node)",
         t_sql_profiles_logic),
        ("api profiles + query-string compose (esbuild + node)",
         t_api_profiles_logic),
        ("connection profiles: API + Load tabs + API-node picker",
         t_connection_profiles_wiring),
        ("Ctrl+K command palette + NodeFlow Tools & Tables window",
         t_command_palette_and_tools_tables),
        ("lazy-scroll grid wiring", t_ui_lazy_scroll),
        ("no stray debug statements", t_ui_no_debug_statements),
        ("repo hygiene (no artifacts, ps1 helpers present)", t_repo_hygiene),
        ("portable npm lockfile and registry normalizer", t_npm_lock_portability),
        ("Activity & connections dashboard wiring (status + reset + modal)",
         t_activity_dashboard_wiring),
        ("tables tree: collapsible struct nodes + nested field search",
         t_tree_field_collapse_and_search),
        ("Settings: export journal to CSV (Cell/SQL/uses/feeds)",
         t_journal_export_csv),
        ("Journal: grouped sections (horizontal groups + New Group)",
         t_journal_groups),
        ("Journal: group-output alias + groups in file save/open",
         t_journal_group_output),
        ("field explorer: floating draggable panel across views",
         t_field_explorer_panel),
        ("journal chain reuse: run wiring (reduced SQL + retry + plumbing)",
         t_chain_reuse_wiring),
        ("Cancel-all lives in the task tray (row below header), not on the card",
         t_cancel_all_in_tray),
        (".483: Clear all slides the finished cards away gracefully "
         "(forceLeaving + delayed real clear), not an instant blink",
         t_clear_all_graceful_483),
        ("load feedback: red cancel-x on running cards + a load-start toast",
         t_load_start_feedback),
        ("micro-animations (menus/modals/nodes/toasts) behind a motion guard",
         t_micro_animations),
        ("Eye Care view setting scales text, buttons, nodes, and containers",
         t_eye_care_scaling),
        ("Dense NodeFlow shrinks canvas geometry (pairs with Eye Care)",
         t_nodeflow_dense),
        ("second animation batch (nodes/toast-bar/tab-slide/run-flash)",
         t_more_animations),
        ("pivot result grid: sortable + resizable columns + red remove-x",
         t_pivot_grid_sort_resize),
        ("pivot result grid: collapse/expand nested row groups",
         t_pivot_row_collapse),
        ("activity tray: /api/tasks cards + cancel + badge (source-guard)",
         t_activity_tray_wiring),
        ("activity tray replaces the load modal + relocates completion (4b)",
         t_tray_replaces_load_modal),
        ("NodeFlow Stop is a global halt (cancels background tray tasks)",
         t_nodebook_stop_halts_background),
        ("preview: pretty-print struct/JSON cells in an expandable viewer",
         t_datagrid_pretty_struct),
        ("maintenance batch: CI, cache UI, migrations, zero-warning lint",
         t_maintenance_batch_wiring),
        ("Wave 1 stabilization: runtime guards + end-to-end journeys",
         t_wave1_stabilization_contract),
        ("Wave 2 stabilization: React DOM behavior + race guards",
         t_wave2_component_contract),
        ("Wave 3 stabilization: process/concurrency/stateful server rails",
         t_wave3_stabilization_contract),
        ("React component behavior suite (Vitest + Testing Library)",
         t_component_tests),
        ("saved-file migration engine (esbuild + node)", t_migrations_logic),
        ("ESLint correctness gate (zero warnings)", t_lint),
        ("TypeScript type-check (tsc)", t_typecheck),
        ("production build (vite)", t_build),
    ]:
        run("frontend", name, fn)
