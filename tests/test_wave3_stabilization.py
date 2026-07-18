"""Wave 3 stabilization tests.

These are deliberately stdlib-first and plug into ``tests/run_tests.py``.
DuckDB-native concurrency cases execute when DuckDB is installed and skip
cleanly otherwise. The suite targets bugs that unit/source checks cannot see:
real process death/restart, real socket disconnects, scoped native cancellation,
malformed streamed uploads, persistence corruption, and stateful route orderings.
"""
from __future__ import annotations

import io
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def _need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _eq(actual, expected, msg):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def _http_json(base, token, method, path, payload=None, timeout=20,
               extra_headers=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token and path.startswith("/api/"):
        req.add_header("X-SamQL-Token", token)
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
    try:
        body = json.loads(raw.decode("utf-8", "replace") or "{}")
    except Exception:
        body = {"_raw": raw[:500].decode("utf-8", "replace")}
    return status, body


def _wait_until(predicate, timeout=10.0, interval=0.025, message="condition"):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # readiness probes can race process startup
            last = exc
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {message}; last={last!r}")


def _persistence_corruption_quarantine(root, _csv, _skip):
    from samql_core.stores import (
        ConfigStore, LoadManifestStore, QueryHistoryStore, WorkflowStore,
    )

    d = Path(tempfile.mkdtemp(prefix="samql_wave3_store_"))
    try:
        fixtures = [
            ("config.json", b"{bad", ConfigStore, dict),
            ("history.json", b"{}", QueryHistoryStore, list),
            ("workflows.json", b"[1]", WorkflowStore, list),
            ("session_manifest.json", b"[\"not-an-object\"]",
             LoadManifestStore, list),
        ]
        stores = []
        for name, raw, cls, expected in fixtures:
            path = d / name
            path.write_bytes(raw)
            store = cls(dirname=str(d), filename=name)
            stores.append((store, path, raw))
            value = store.data if hasattr(store, "data") else store.entries
            _need(isinstance(value, expected), f"{name}: safe empty container")
            _eq(value, expected(), f"{name}: corrupt content rejected")
            _need(not path.exists(), f"{name}: original moved out of the way")
            backups = list(d.glob(name + ".corrupt-*"))
            _eq(len(backups), 1, f"{name}: one quarantine backup")
            _eq(backups[0].read_bytes(), raw,
                f"{name}: quarantine preserves exact bytes")

        # Each store remains writable after recovery and does not overwrite the
        # quarantined evidence.
        stores[0][0].set("theme", "dark")
        stores[1][0].add("SELECT 1")
        stores[2][0].upsert("wf", {"nodes": [], "edges": []}, kind="node")
        stores[3][0].add("file", str(d / "x.csv"), destination="sqlite")
        for store, path, _raw in stores:
            _need(path.exists(), f"{path.name}: fresh valid file recreated")
            json.loads(path.read_text(encoding="utf-8"))
            _need(list(d.glob(path.name + ".corrupt-*")),
                  f"{path.name}: backup retained after save")

        # Repeated corruption is bounded so a bad disk or editor cannot create
        # an unbounded backup pile.
        cfg = d / "bounded.json"
        for i in range(6):
            cfg.write_text("{" + str(i), encoding="utf-8")
            ConfigStore(dirname=str(d), filename=cfg.name)
        _need(len(list(d.glob(cfg.name + ".corrupt-*"))) <= 3,
              "corrupt JSON backup retention is bounded")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _multipart_malformed_matrix(root, _csv, _skip):
    import server
    from samql_core import tmputil

    inst = Path(tmputil.instance_dir())

    def upfiles():
        return {p.resolve() for p in inst.glob("up_*") if p.is_file()}

    def bad(raw, content_type, *, field_cap=1_000_000, label):
        before = upfiles()
        try:
            server.stream_multipart(
                io.BytesIO(raw), content_type, len(raw), chunk=7,
                field_cap=field_cap)
            raise AssertionError(label + ": malformed body was accepted")
        except ValueError:
            pass
        _eq(upfiles(), before, label + ": no upload spool leak")

    bad(b"", "multipart/form-data", label="missing boundary parameter")
    bad(b"", 'multipart/form-data; boundary=""', label="empty boundary")
    bad(b"", "multipart/form-data; boundary=" + "x" * 201,
        label="overlong boundary")
    bad(b"", "multipart/form-data; boundary=abc\r\nInjected: x",
        label="newline in boundary")
    bad(b"garbage", "multipart/form-data; boundary=abc",
        label="body without first boundary")
    bad(b"--abc\r\nContent-Disposition: form-data; name=\"x\"\r\n",
        "multipart/form-data; boundary=abc", label="truncated headers")
    bad(b"--abc\r\nContent-Type: text/plain\r\n\r\nx\r\n--abc--\r\n",
        "multipart/form-data; boundary=abc", label="missing form-data name")

    # A file part is opened before the terminal boundary is discovered to be
    # missing. The failure path must close then unlink it (Windows-sensitive).
    truncated_file = (
        b"--abc\r\nContent-Disposition: form-data; name=\"file\"; "
        b"filename=\"x.csv\"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n")
    bad(truncated_file, "multipart/form-data; boundary=abc",
        label="truncated file part")

    large_field = (
        b"--abc\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n"
        + b"z" * 33 + b"\r\n--abc--\r\n")
    bad(large_field, "multipart/form-data; boundary=abc", field_cap=32,
        label="oversized scalar field")

    # Valid quoted boundary, tiny chunks, and a marker split across every
    # possible read boundary: proves the hardening did not reject real bodies.
    body = (
        b"--quoted-1\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n"
        b"hello\r\n--quoted-1\r\nContent-Disposition: form-data; "
        b"name=\"file\"; filename=\"ok.csv\"\r\nContent-Type: text/csv\r\n\r\n"
        b"a,b\n1,2\n\r\n--quoted-1--\r\n")
    fields, files = server.stream_multipart(
        io.BytesIO(body), 'multipart/form-data; boundary="quoted-1"',
        len(body), chunk=3)
    try:
        _eq(fields.get("note"), "hello", "valid field round-trip")
        _eq(len(files), 1, "one valid file part")
        _eq(Path(files[0].path).read_bytes(), b"a,b\n1,2\n",
            "valid file bytes exact")
    finally:
        server._cleanup_uploaded_parts(files)


def _ephemeral_port_and_token_rotation(root, _csv, _skip):
    import server

    old = os.environ.pop("SAMQL_API_TOKEN", None)
    servers = []
    try:
        h1, p1 = server.make_server("127.0.0.1", 0)
        h2, p2 = server.make_server("127.0.0.1", 0)
        servers.extend((h1, h2))
        _need(p1 > 0 and p2 > 0, "port 0 resolves to real bound ports")
        _eq(p1, h1.server_address[1], "first returned port matches socket")
        _eq(p2, h2.server_address[1], "second returned port matches socket")
        _need(p1 != p2, "two live ephemeral servers do not collide")
        _need(h1.samql_api_token != h2.samql_api_token,
              "per-process API tokens rotate")

        os.environ["SAMQL_API_TOKEN"] = "wave3-fixed-token"
        h3, p3 = server.make_server("127.0.0.1", 0)
        servers.append(h3)
        _need(p3 > 0, "configured-token server bound")
        _eq(h3.samql_api_token, "wave3-fixed-token",
            "explicit deployment token is honored")
    finally:
        for h in servers:
            try:
                h.server_close()
            except Exception:
                pass
        if old is None:
            os.environ.pop("SAMQL_API_TOKEN", None)
        else:
            os.environ["SAMQL_API_TOKEN"] = old


def _spawn_test_server(root, home, ready_path):
    backend = str(Path(root) / "backend")
    code = r'''
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ["SAMQL_WAVE3_BACKEND"])
import server
server.SESSION = None
httpd, port = server.make_server("127.0.0.1", 0)
server._HTTPD = httpd
server.get_session()
Path(os.environ["SAMQL_WAVE3_READY"]).write_text(
    json.dumps({"port": port, "token": httpd.samql_api_token}),
    encoding="utf-8")
httpd.serve_forever(poll_interval=0.05)
'''
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "LOCALAPPDATA": str(Path(home) / "localapp"),
        "APPDATA": str(Path(home) / "appdata"),
        "SAMQL_WAVE3_BACKEND": backend,
        "SAMQL_WAVE3_READY": str(ready_path),
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    env.pop("SAMQL_API_TOKEN", None)
    Path(env["LOCALAPPDATA"]).mkdir(parents=True, exist_ok=True)
    Path(env["APPDATA"]).mkdir(parents=True, exist_ok=True)
    return subprocess.Popen(
        [sys.executable, "-u", "-c", code], env=env,
        cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _subprocess_crash_restart_manifest(root, csv_path, _skip):
    d = Path(tempfile.mkdtemp(prefix="samql_wave3_restart_"))
    home = d / "home"
    home.mkdir()
    stable_csv = d / "wave3_restart.csv"
    shutil.copyfile(csv_path, stable_csv)
    p1 = p2 = None
    try:
        ready1 = d / "ready1.json"
        p1 = _spawn_test_server(root, home, ready1)
        info1 = _wait_until(
            lambda: json.loads(ready1.read_text(encoding="utf-8"))
            if ready1.exists() else None,
            timeout=20, message="first subprocess server readiness")
        base1 = f"http://127.0.0.1:{info1['port']}"
        st, health = _http_json(base1, None, "GET", "/api/health")
        _eq(st, 200, "first subprocess health")
        _eq(health.get("app"), "SamQL", "first subprocess identity")

        st, started = _http_json(
            base1, info1["token"], "POST", "/api/load/start",
            {"path": str(stable_csv), "destination": "sqlite",
             "base_name": "wave3_restart"})
        _eq(st, 200, "restart fixture load starts")
        job = started.get("job_id") or started.get("job")
        _need(job, "restart fixture received a job id")

        def load_done():
            st2, body = _http_json(
                base1, info1["token"], "GET", f"/api/load/progress/{job}")
            if st2 != 200:
                return None
            if body.get("state") == "error":
                raise AssertionError("restart fixture load failed: " +
                                     str(body.get("error")))
            return body if body.get("state") == "done" else None

        _wait_until(load_done, timeout=30, message="fixture load completion")
        from samql_core.stores import app_config_dir
        manifest = app_config_dir() / "session_manifest.json"
        _wait_until(manifest.exists, timeout=5, message="manifest write")
        entries = json.loads(manifest.read_text(encoding="utf-8"))
        _need(any(e.get("path") == str(stable_csv) for e in entries),
              "loaded source recorded in restart manifest")

        # Hard kill: no shutdown handlers, no manifest clear, no clean temp
        # lifecycle. This is the failure mode Wave 3 is meant to exercise.
        p1.kill()
        p1.wait(timeout=10)
        p1 = None
        _need(manifest.exists(), "crash leaves restore manifest intact")

        ready2 = d / "ready2.json"
        p2 = _spawn_test_server(root, home, ready2)
        info2 = _wait_until(
            lambda: json.loads(ready2.read_text(encoding="utf-8"))
            if ready2.exists() else None,
            timeout=20, message="restarted subprocess server readiness")
        base2 = f"http://127.0.0.1:{info2['port']}"
        _need(info2["token"] != info1["token"],
              "API token rotates across a real process restart")

        st_old, _ = _http_json(
            base2, info1["token"], "GET", "/api/tables")
        _eq(st_old, 403, "old process token rejected after restart")

        def restored_table():
            st3, body = _http_json(
                base2, info2["token"], "GET", "/api/tables")
            if st3 != 200:
                return None
            rows = body if isinstance(body, list) else body.get("tables", [])
            return next((r for r in rows
                         if r.get("name") == "wave3_restart"), None)

        restored = _wait_until(
            restored_table, timeout=30,
            message="manifest-backed table after hard restart")
        _need(restored.get("row_count", 0) > 0,
              "restored table is queryable and non-empty")
        st_q, q = _http_json(
            base2, info2["token"], "POST", "/api/query",
            {"sql": "SELECT COUNT(*) AS n FROM wave3_restart",
             "target": "__local__"})
        _eq(st_q, 200, "query after restart")
        _need(not q.get("error"), "restored table query succeeds: " + str(q))
        _need((q.get("rows") or [[0]])[0][0] > 0,
              "restored table contains rows")
    finally:
        for proc in (p1, p2):
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                    proc.wait(timeout=10)
                except Exception:
                    pass
        shutil.rmtree(d, ignore_errors=True)



def _cancelled_parquet_never_reruns(root, _csv, _skip):
    """Regression for the cancellation fallthrough found on Windows.

    A DuckDB parquet COPY interruption used to be swallowed by
    ``_exec_target_inner`` and the same SQL was immediately started again via
    ``execute_cursor``. This small fake executes on every machine, including
    environments without DuckDB, and proves an interrupt is terminal.
    """
    from samql_core import Session

    class FakeEngine:
        concurrent_reads = True

        def __init__(self):
            self.execute_cursor_calls = 0
            self._native_ops = {}
            self._native_ops_lock = threading.Lock()
            self.engine_interrupts = 0

        def execute_cursor(self, _sql, batch=None):
            self.execute_cursor_calls += 1
            return ["v"], [(1,)], None

        def interrupt(self):
            self.engine_interrupts += 1

    fake = FakeEngine()
    sess = Session.__new__(Session)
    sess.use_parquet_results = True
    sess._is_single_read = lambda _sql: True
    sess._run_is_cancelled = lambda _qid: False

    def interrupted(*_args, **_kwargs):
        raise RuntimeError("Interrupted by scoped cancellation")

    sess._exec_duckdb_parquet = interrupted
    try:
        Session._exec_target_inner(
            sess, "SELECT 1", "__duckdb__", fake, "duckdb",
            query_id="wave3-fake-cancel")
    except RuntimeError as exc:
        _need("interrupt" in str(exc).lower(),
              "the original interrupt propagates unchanged")
    else:
        raise AssertionError("interrupted parquet COPY was swallowed")
    _eq(fake.execute_cursor_calls, 0,
        "an interrupted parquet COPY is never rerun by the generic drain")

    # An early Stop can land after the run id is registered but before its
    # cursor exists. The deferred placeholder must not use the engine-wide
    # hammer, which would interrupt unrelated queries.
    Session._interrupt_entry({
        "engine": fake, "tid": 123456, "deferred": True,
    })
    _eq(fake.engine_interrupts, 0,
        "deferred concurrent registration never interrupts the whole engine")

def _real_duckdb_concurrency(root, _csv, skip):
    from samql_core import Session
    from samql_core.engines import HAS_DUCKDB
    from samql_core.stores import LoadManifestStore, QueryHistoryStore

    if not HAS_DUCKDB:
        skip("DuckDB is not installed")

    d = Path(tempfile.mkdtemp(prefix="samql_wave3_duck_"))
    s = Session()
    # Keep this stress test out of the user's normal history/manifest.
    s.history = QueryHistoryStore(dirname=str(d), filename="history.json")
    s.manifest = LoadManifestStore(dirname=str(d), filename="manifest.json")
    long_sql = (
        "SELECT sum(random()) AS v "
        "FROM range(50000000000) t(i)")

    def launch(qid, box):
        def worker():
            box[qid] = s.run_query(
                long_sql, target="__duckdb__", query_id=qid,
                surface="ide", label=qid)
        th = threading.Thread(target=worker, daemon=True, name=qid)
        th.start()
        _wait_until(lambda: qid in s._running, timeout=10,
                    message=f"{qid} registered in native engine")
        return th

    threads = []
    try:
        s.set_concurrent_reads(True)
        s.get_duckdb()

        box = {}
        slow = launch("wave3-long", box)
        threads.append(slow)

        latencies = []
        for _ in range(10):
            t0 = time.monotonic()
            status = s.status()
            latencies.append(time.monotonic() - t0)
            _need("engines" in status and "operations" in status,
                  "status shape remains complete under native load")
        _need(max(latencies) < 0.75,
              f"status blocked behind DuckDB work: max={max(latencies):.3f}s")

        quick = {}
        tq = threading.Thread(
            target=lambda: quick.setdefault(
                "r", s.run_query("SELECT 42 AS answer",
                                 target="__duckdb__", query_id="wave3-quick")),
            daemon=True)
        tq.start()
        tq.join(8)
        _need(not tq.is_alive(),
              "concurrent quick read completes while long query is active")
        _need(not quick["r"].get("error"), "quick read succeeded")
        _eq((quick["r"].get("rows") or [[None]])[0][0], 42,
            "quick read result")

        s.cancel_query("wave3-long")
        slow.join(20)
        if slow.is_alive():
            with s._running_lock:
                entry = s._running.get("wave3-long")
            raise AssertionError(
                "long native query did not stop within 20s; "
                f"registration={type(entry).__name__}:{entry!r}; "
                f"result={box.get('wave3-long')!r}; "
                f"cancelled_flag={'wave3-long' in s._cancelled_runs}")
        long_result = box.get("wave3-long") or {}
        _need(long_result.get("cancelled") is True,
              "long native query reports scoped cancellation; "
              f"result={long_result!r}")

        recovery = s.run_query("SELECT 7 AS n", target="__duckdb__",
                               query_id="wave3-recovery")
        _need(not recovery.get("error"),
              "DuckDB accepts work immediately after cancellation")
        _eq((recovery.get("rows") or [[None]])[0][0], 7,
            "post-cancel recovery result")

        # Two live native reads: cancelling A must not interrupt B. B is then
        # cancelled separately so the test never burns CPU after completion.
        both = {}
        ta = launch("wave3-a", both)
        tb = launch("wave3-b", both)
        threads.extend((ta, tb))
        s.cancel_query("wave3-a")
        ta.join(20)
        _need(not ta.is_alive(),
              "query A did not stop within 20s; "
              f"result={both.get('wave3-a')!r}")
        _need((both.get("wave3-a") or {}).get("cancelled") is True,
              "query A cancellation result: "
              f"{both.get('wave3-a')!r}")
        time.sleep(0.2)
        _need(tb.is_alive() and "wave3-b" in s._running,
              "query B survives scoped cancellation of query A")
        s.cancel_query("wave3-b")
        tb.join(20)
        _need(not tb.is_alive(),
              "query B did not stop within 20s; "
              f"result={both.get('wave3-b')!r}")
        _need((both.get("wave3-b") or {}).get("cancelled") is True,
              "query B cancellation result: "
              f"{both.get('wave3-b')!r}")
    finally:
        for qid in ("wave3-long", "wave3-a", "wave3-b"):
            try:
                s.cancel_query(qid, scope="all")
            except Exception:
                pass
        for th in threads:
            th.join(3)
        try:
            s.shutdown()
        finally:
            shutil.rmtree(d, ignore_errors=True)


def backend_cases(root, csv_path, skip):
    return [
        ("Wave 3: corrupt persistence is quarantined and startup recovers",
         lambda: _persistence_corruption_quarantine(root, csv_path, skip)),
        ("Wave 3: malformed multipart matrix rejects cleanly with no spools",
         lambda: _multipart_malformed_matrix(root, csv_path, skip)),
        ("Wave 3: port-0 binding and per-process API token rotation",
         lambda: _ephemeral_port_and_token_rotation(root, csv_path, skip)),
        ("Wave 3: interrupted parquet COPY never reruns or cancels siblings",
         lambda: _cancelled_parquet_never_reruns(root, csv_path, skip)),
        ("Wave 3: hard subprocess crash restores manifest on restart",
         lambda: _subprocess_crash_restart_manifest(root, csv_path, skip)),
        ("Wave 3: real DuckDB concurrency, scoped cancel, and recovery",
         lambda: _real_duckdb_concurrency(root, csv_path, skip)),
    ]


def _stateful_randomized_http(base, token):
    rng = random.Random(0x574)
    table_names = ("wave3_state_a", "wave3_state_b")
    current = None
    saved = set()
    workflows = set()

    def call(method, path, payload=None, expected=None):
        st, body = _http_json(base, token, method, path, payload)
        _need(st < 500, f"{method} {path} returned {st}: {body}")
        if expected is not None:
            _need(st in expected, f"{method} {path}: expected {expected}, got {st}")
        return st, body

    def table_snapshot():
        st, body = call("GET", "/api/tables", expected={200})
        rows = body if isinstance(body, list) else body.get("tables", [])
        return {r.get("name") for r in rows if r.get("name") in table_names}

    # Clean any residue from an interrupted prior run.
    for name in table_names:
        call("POST", "/api/table/drop",
             {"engine": "sqlite", "name": name})

    try:
        for step in range(100):
            action = rng.choice([
                "create", "rename", "drop", "query", "bad_query",
                "saved_put", "saved_del", "workflow_put", "workflow_del",
                "status",
            ])
            if action == "create" and current is None:
                name = rng.choice(table_names)
                st, body = call("POST", "/api/table/create", {
                    "name": name, "columns": ["id", "v"],
                    "rows": [["1", "a"], ["2", "b"], ["3", "c"]],
                    "destination": "sqlite"}, expected={200})
                _need(body.get("ok"), f"step {step}: create failed: {body}")
                current = body.get("table") or name
            elif action == "rename" and current is not None:
                other = table_names[1] if current == table_names[0] else table_names[0]
                st, body = call("POST", "/api/table/rename", {
                    "engine": "sqlite", "old": current, "new": other},
                    expected={200})
                _need(body.get("ok", True), f"step {step}: rename failed: {body}")
                current = other
            elif action == "drop" and current is not None:
                call("POST", "/api/table/drop",
                     {"engine": "sqlite", "name": current}, expected={200})
                current = None
            elif action == "query":
                sql = (f'SELECT COUNT(*) AS n FROM "{current}"'
                       if current else "SELECT 3 AS n")
                st, body = call("POST", "/api/query", {
                    "sql": sql, "target": "__local__"}, expected={200})
                _need(not body.get("error"), f"step {step}: valid query failed: {body}")
                expected_n = 3
                _eq((body.get("rows") or [[None]])[0][0], expected_n,
                    f"step {step}: query/model row count")
            elif action == "bad_query":
                st, body = call("POST", "/api/query", {
                    "sql": "SELECT * FROM definitely_missing_wave3",
                    "target": "__local__"}, expected={200})
                _need(body.get("error"), f"step {step}: invalid query needs error payload")
            elif action == "saved_put":
                name = f"wave3_saved_{rng.randrange(5)}"
                call("POST", "/api/saved", {
                    "name": name, "sql": "SELECT 1", "tags": ["wave3"]},
                    expected={200})
                saved.add(name)
            elif action == "saved_del":
                name = f"wave3_saved_{rng.randrange(5)}"
                call("DELETE", "/api/saved", {"name": name}, expected={200})
                saved.discard(name)
            elif action == "workflow_put":
                name = f"wave3_wf_{rng.randrange(5)}"
                call("POST", "/api/workflows", {
                    "name": name, "kind": "ide",
                    "graph": {"sql": f"SELECT {step}"}}, expected={200})
                workflows.add(name)
            elif action == "workflow_del":
                name = f"wave3_wf_{rng.randrange(5)}"
                call("DELETE", "/api/workflows", {
                    "name": name, "kind": "ide"}, expected={200})
                workflows.discard(name)
            else:
                call("GET", "/api/status", expected={200})

            expected_tables = {current} if current else set()
            _eq(table_snapshot(), expected_tables,
                f"step {step}: table model matches server")
            st, body = call("GET", "/api/saved", expected={200})
            actual_saved = {x.get("name") for x in body.get("saved", [])
                            if str(x.get("name", "")).startswith("wave3_saved_")}
            _eq(actual_saved, saved, f"step {step}: saved-query model")
            st, body = call("GET", "/api/workflows", expected={200})
            actual_wf = {x.get("name") for x in body.get("workflows", [])
                         if x.get("kind") == "ide" and
                         str(x.get("name", "")).startswith("wave3_wf_")}
            _eq(actual_wf, workflows, f"step {step}: workflow model")
    finally:
        for name in table_names:
            call("POST", "/api/table/drop",
                 {"engine": "sqlite", "name": name})
        for name in list(saved) + [f"wave3_saved_{i}" for i in range(5)]:
            call("DELETE", "/api/saved", {"name": name})
        for name in list(workflows) + [f"wave3_wf_{i}" for i in range(5)]:
            call("DELETE", "/api/workflows", {"name": name, "kind": "ide"})


def _client_disconnect_download_cleanup(root, base, token):
    import server

    d = Path(tempfile.mkdtemp(prefix="samql_wave3_disconnect_"))
    payload_path = d / "large.bin"
    payload_path.write_bytes(b"x" * (8 * 1024 * 1024))
    original = server.Api.result_export
    route_indexes = [i for i, (meth, rx, fn) in enumerate(server._COMPILED)
                     if meth == "POST" and rx.match("/api/result/wave3/export")]
    _eq(len(route_indexes), 1, "one result-export route")
    route_index = route_indexes[0]
    original_route = server._COMPILED[route_index]

    def fake_export(_s, _m, _body, _ctx):
        return server.FileDownload(str(payload_path), "large.bin", cleanup=True)

    server.Api.result_export = staticmethod(fake_export)
    server._COMPILED[route_index] = (original_route[0], original_route[1],
                                     fake_export)
    try:
        parsed = urllib.parse.urlsplit(base)
        sock = socket.create_connection((parsed.hostname, parsed.port), timeout=5)
        body = b"{}"
        req = (
            f"POST /api/result/wave3/export HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            f"X-SamQL-Token: {token}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n").encode("ascii") + body
        sock.sendall(req)
        sock.recv(2048)  # receive headers / first payload bytes, then disappear
        sock.close()
        _wait_until(lambda: not payload_path.exists(), timeout=8,
                    message="download temp cleanup after client disconnect")
        st, health = _http_json(base, None, "GET", "/api/health")
        _eq(st, 200, "server remains healthy after broken download socket")
        _eq(health.get("app"), "SamQL", "health identity after disconnect")
    finally:
        server.Api.result_export = original
        server._COMPILED[route_index] = original_route
        shutil.rmtree(d, ignore_errors=True)


def http_cases(root, csv_path, base, token, skip):
    return [
        ("Wave 3: deterministic state-machine route fuzz (100 transitions)",
         lambda: _stateful_randomized_http(base, token)),
        ("Wave 3: client disconnect during download cleans temp and recovers",
         lambda: _client_disconnect_download_cleanup(root, base, token)),
    ]
