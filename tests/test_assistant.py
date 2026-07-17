#!/usr/bin/env python3
"""Unit tests for the optional local SQL assistant (no model required)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from samql_core import assistant as asst  # noqa: E402


class SchemaPromptTests(unittest.TestCase):
    def test_schema_prompt_is_compact_and_dialect_aware(self):
        tables = [
            {
                "engine": "duckdb",
                "name": "orders",
                "columns": [
                    {"name": "id", "type": "BIGINT"},
                    {"name": "payload", "type": "JSON",
                     "hint": "json_extract(payload, '$.a')"},
                ],
            },
            {"engine": "remote", "name": "dbo.x", "remote": True, "columns": []},
        ]
        meta = asst.schema_prompt(tables, dialect="spark")
        self.assertEqual(meta["dialect"], "spark")
        self.assertIn("Spark SQL", meta["dialect_label"])
        self.assertIn('"orders"', meta["schema"])
        self.assertIn("json_extract", meta["schema"])
        self.assertNotIn("dbo.x", meta["schema"])

    def test_schema_prompt_steers_duckdb_not_mysql_postgres(self):
        meta = asst.schema_prompt([], dialect="native")
        sys_msg = meta["system"].lower()
        self.assertEqual(meta["dialect"], "duckdb")
        self.assertIn("duckdb", sys_msg)
        self.assertIn("json_extract", sys_msg)
        self.assertIn("unnest", sys_msg)
        self.assertIn("mysql", sys_msg)
        self.assertIn("postgres", sys_msg)
        # Must steer AWAY from those dialects, not recommend them.
        self.assertIn("not mysql", sys_msg)

    def test_extract_sql_from_fenced_block(self):
        text = "Sure.\n```sql\nSELECT 1 AS n;\n```\n"
        self.assertEqual(asst.extract_sql(text), "SELECT 1 AS n;")

    def test_build_messages_truncates_huge_schema(self):
        tables = []
        for i in range(80):
            cols = [{"name": "c%d" % j, "type": "VARCHAR"} for j in range(60)]
            tables.append({"engine": "duckdb", "name": "t%d" % i, "columns": cols})
        msgs, meta = asst.build_messages(tables, "count rows", dialect="native")
        self.assertEqual(msgs[0]["role"], "system")
        self.assertLessEqual(len(msgs[1]["content"]), asst._MAX_PROMPT_CHARS)
        self.assertEqual(meta["dialect"], "duckdb")
        self.assertIn("DuckDB", msgs[0]["content"])


class PackAndGateTests(unittest.TestCase):
    def tearDown(self):
        asst.set_preferred_model(None)
        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_LOCAL,
            base_url="",
            model="",
            clear_api_key=True,
            update_key=True,
        )
        asst.stop_server()

    def test_find_pack_missing(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.dict(os.environ, {"SAMQL_ASSISTANT_DIR": td}):
                # Force only this root via env + empty cwd tricks: call with root=
                got = asst.find_pack(td)
        self.assertFalse(got["ok"])
        self.assertEqual(got["reason"], "pack_missing")

    def test_find_pack_ok(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            (models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf").write_bytes(b"gguf")
            got = asst.find_pack(root)
        self.assertTrue(got["ok"])
        self.assertTrue(got["model"].endswith(".gguf"))
        self.assertIn("runtime", got["binary"].replace("\\", "/"))
        self.assertTrue(got.get("using_default"))
        self.assertIn("4b", (got.get("model_name") or "").lower())

    def test_display_model_name_follows_path_even_when_default(self):
        # Regression: pack discovery of a non-default file must not be mislabeled.
        name = asst._display_model_name(
            "/pack/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
            using_default=True,
        )
        self.assertIn("7b", name.lower())
        self.assertNotEqual(name, asst.DEFAULT_MODEL_NAME)
        self.assertFalse(name.lower().endswith(".gguf"))

    def test_find_pack_sole_nondefault_gguf_labels_from_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            gguf = models / "qwen2.5-coder-7b-instruct-q4_k_m.gguf"
            gguf.write_bytes(b"gguf")
            got = asst.find_pack(root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], gguf))
        self.assertTrue(got.get("using_default"))
        self.assertIn("7b", (got.get("model_name") or "").lower())
        self.assertNotEqual(got.get("model_name"), asst.DEFAULT_MODEL_NAME)

    def test_find_pack_prefers_4b_when_multiple_present(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            mid = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            big = models / "qwen2.5-coder-7b-instruct-q4_k_m.gguf"
            mid.write_bytes(b"mid")
            big.write_bytes(b"big")
            got = asst.find_pack(root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], mid))
        self.assertIn("4b", (got.get("model_name") or "").lower())

    def test_status_model_name_matches_pack_path(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            gguf = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            gguf.write_bytes(b"gguf")
            pack = asst.find_pack(root)
            with mock.patch.object(asst, "find_pack", return_value=pack):
                st = asst.status(None)
        self.assertIn("Qwen3-4B", st.get("model_name") or "")

    def test_find_pack_prefers_selected_gguf(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            default = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            default.write_bytes(b"default")
            custom = Path(td) / "downloads" / "other-coder.gguf"
            custom.parent.mkdir()
            custom.write_bytes(b"custom")
            got = asst.find_pack(root, preferred_model=str(custom))
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], custom))
        self.assertFalse(got.get("using_default"))
        self.assertIn("other-coder", got.get("model_name") or "")

    def test_find_pack_falls_back_when_preferred_missing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            default = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            default.write_bytes(b"default")
            missing = Path(td) / "gone.gguf"
            got = asst.find_pack(root, preferred_model=str(missing))
        self.assertTrue(got["ok"])
        self.assertTrue(got.get("preferred_missing"))
        self.assertTrue(got.get("using_default"))
        self.assertTrue(asst._same_path(got["model"], default))

    def test_find_pack_uses_install_model_folder_when_models_empty(self):
        # Packaged lean/runtime: llama-server under assistant/, GGUF dropped
        # into sibling Model/ (next to _internal). Prefer assistant/models/
        # when present; Model/ is the user drop-in.
        with tempfile.TemporaryDirectory() as td:
            install = Path(td)
            asst_root = install / "assistant"
            runtime = asst_root / "runtime"
            runtime.mkdir(parents=True)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            (asst_root / "models").mkdir()
            user_model = install / "Model"
            user_model.mkdir()
            gguf = user_model / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            gguf.write_bytes(b"user")
            got = asst.find_pack(asst_root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], gguf))

    def test_find_pack_prefers_assistant_models_over_model_folder(self):
        with tempfile.TemporaryDirectory() as td:
            install = Path(td)
            asst_root = install / "assistant"
            runtime = asst_root / "runtime"
            runtime.mkdir(parents=True)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            models = asst_root / "models"
            models.mkdir()
            bundled = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            bundled.write_bytes(b"bundled")
            user_model = install / "Model"
            user_model.mkdir()
            (user_model / "qwen2.5-coder-7b-instruct-q4_k_m.gguf").write_bytes(
                b"user"
            )
            got = asst.find_pack(asst_root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], bundled))

    def test_find_pack_accepts_sole_phi4_mini_q3(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            phi = models / "Phi-4-mini-instruct-Q3_K_M.gguf"
            phi.write_bytes(b"phi")
            got = asst.find_pack(root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], phi))
        self.assertIn("phi", (got.get("model_name") or "").lower())

    def test_find_pack_phi_in_model_dropin_folder(self):
        with tempfile.TemporaryDirectory() as td:
            install = Path(td)
            asst_root = install / "assistant"
            runtime = asst_root / "runtime"
            runtime.mkdir(parents=True)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            (asst_root / "models").mkdir()
            user_model = install / "Model"
            user_model.mkdir()
            phi = user_model / "Phi-4-mini-instruct-Q3_K_M.gguf"
            phi.write_bytes(b"phi")
            got = asst.find_pack(asst_root)
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], phi))

    def test_find_pack_preferred_phi_beats_default_qwen(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            qwen = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            phi = models / "Phi-4-mini-instruct-Q3_K_M.gguf"
            qwen.write_bytes(b"qwen")
            phi.write_bytes(b"phi")
            got = asst.find_pack(root, preferred_model=str(phi))
        self.assertTrue(got["ok"])
        self.assertTrue(asst._same_path(got["model"], phi))
        self.assertFalse(got.get("using_default"))

    def test_ensure_server_cmd_has_no_qwen_only_chat_template(self):
        # llama-server must use the GGUF-embedded template (Phi + Qwen).
        src = Path(asst.__file__).read_text(encoding="utf-8")
        start = src.index("def ensure_server")
        end = src.index("\ndef stop_server", start)
        body = src[start:end]
        self.assertIn("_llama_server_cmd(", body)
        self.assertIn("embedded in the GGUF", body)
        self.assertIn("_llama_server_child_env(", body)
        # No literal template overrides in the launch call (comments may mention).
        self.assertNotIn('--chat-template"', body)
        self.assertNotIn('"--jinja"', body)
        self.assertNotIn("'--jinja'", body)

    def test_llama_server_cmd_is_offline_hardened(self):
        cmd = asst._llama_server_cmd("/bin/llama-server", "/m.gguf", 1234, 2048)
        self.assertEqual(cmd[0], "/bin/llama-server")
        self.assertIn("-m", cmd)
        self.assertIn("/m.gguf", cmd)
        self.assertIn("127.0.0.1", cmd)
        self.assertIn("--offline", cmd)
        self.assertIn("--no-webui", cmd)
        joined = " ".join(cmd)
        self.assertNotIn("--chat-template", joined)
        self.assertNotIn("--jinja", joined)
        self.assertNotIn("--tools", joined)
        self.assertNotIn("--agent", joined)
        self.assertNotIn("--hf-", joined)
        self.assertNotIn("--model-url", joined)
        self.assertNotIn("mcp", joined.lower())

    def test_llama_server_child_env_scrubs_agent_and_hf(self):
        dirty = {
            "PATH": "/usr/bin",
            "LLAMA_ARG_HF_REPO": "org/model",
            "LLAMA_ARG_MODEL_URL": "https://example.com/m.gguf",
            "LLAMA_ARG_TOOLS": "all",
            "LLAMA_ARG_AGENT": "1",
            "LLAMA_ARG_UI_MCP_PROXY": "1",
            "LLAMA_ARG_WEBUI_MCP_PROXY": "1",
            "KEEP_ME": "yes",
        }
        env = asst._llama_server_child_env(dirty)
        self.assertEqual(env.get("KEEP_ME"), "yes")
        self.assertEqual(env.get("LLAMA_ARG_OFFLINE"), "1")
        self.assertEqual(env.get("LLAMA_ARG_UI"), "0")
        for key in asst._LLAMA_CHILD_ENV_CLEAR:
            self.assertNotIn(key, env)

    def test_chat_completion_payload_has_no_tools(self):
        payload = asst._chat_completion_payload(
            "m", [{"role": "user", "content": "hi"}], max_tokens=16
        )
        self.assertNotIn("tools", payload)
        self.assertNotIn("tool_choice", payload)
        self.assertNotIn("functions", payload)
        self.assertFalse(payload.get("stream"))

    def test_loopback_url_helpers(self):
        self.assertTrue(asst._is_loopback_url("http://127.0.0.1:8080"))
        self.assertTrue(asst._is_loopback_url("http://localhost:1234/v1"))
        self.assertFalse(asst._is_loopback_url("https://api.openai.com"))
        self.assertFalse(asst._is_loopback_url("http://192.168.1.5:8080"))
        with self.assertRaises(RuntimeError):
            asst._validate_local_llama_url("https://api.openai.com/v1")
        self.assertEqual(
            asst._validate_local_llama_url("http://127.0.0.1:9090/"),
            "http://127.0.0.1:9090",
        )

    def test_ensure_server_rejects_non_loopback_samql_llama_url(self):
        with mock.patch.dict(
            os.environ, {"SAMQL_LLAMA_URL": "https://api.openai.com"}, clear=False
        ):
            with self.assertRaises(RuntimeError) as ctx:
                asst.ensure_server()
        self.assertIn("loopback", str(ctx.exception).lower())

    def test_set_preferred_model_and_sync_stops_mismatch(self):
        asst.set_preferred_model(None)
        # Pretend a sidecar is running model A.
        asst._proc = mock.MagicMock()
        asst._proc.poll.return_value = None
        asst._proc_port = 12345
        asst._proc_model = "/tmp/old.gguf"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bin_name = "llama-server.exe" if asst._is_windows() else "llama-server"
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / bin_name).write_bytes(b"x")
            models = root / "models"
            models.mkdir()
            default = models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            default.write_bytes(b"gguf")
            custom = Path(td) / "alt.gguf"
            custom.write_bytes(b"alt")
            asst.set_preferred_model(str(custom))
            with mock.patch.object(asst, "find_pack", return_value={
                "ok": True,
                "root": str(root),
                "binary": str(runtime / bin_name),
                "model": str(custom.resolve()),
                "model_name": custom.name,
                "using_default": False,
            }):
                out = asst.sync_server_model()
        self.assertTrue(out.get("stopped"))
        self.assertEqual(out.get("reason"), "model_changed")
        self.assertIsNone(asst._proc)

    def test_chat_refuses_when_duckdb_busy(self):
        class Sess:
            def status(self):
                return {
                    "engines": {"duckdb": {"active": True, "busy": True}},
                    "operations": [
                        {
                            "kind": "load",
                            "target": "trades.csv",
                            "engine": "duckdb",
                            "label": None,
                        }
                    ],
                    "restoring": False,
                }

            def tables_tree(self):
                return []

            _running_lock = mock.MagicMock()
            _running = {}

        # Pretend pack is present so we hit the busy gate, not pack_missing.
        fake_pack = {
            "ok": True,
            "root": "/tmp",
            "binary": "/tmp/llama-server",
            "model": "/tmp/m.gguf",
            "model_name": asst.DEFAULT_MODEL_NAME,
            "quant": asst.DEFAULT_QUANT,
            "hint": None,
            "using_default": True,
        }
        with mock.patch.object(asst, "find_pack", return_value=fake_pack), \
             mock.patch.object(asst, "duckdb_busy", return_value=True):
            out = asst.chat(Sess(), "select 1", dialect="native")
        self.assertFalse(out["ok"])
        self.assertEqual(out.get("queued_reason"), "duckdb_busy")
        self.assertIn("idle", (out.get("error") or "").lower())
        self.assertIn("Loading trades.csv", out.get("error") or "")

    def test_chat_refuses_without_pack(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": False}}}

            def tables_tree(self):
                return [{"engine": "duckdb", "name": "t", "columns": []}]

            _running_lock = mock.MagicMock()
            _running = {}

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(asst, "find_pack",
                                   return_value=asst.find_pack(td)), \
                 mock.patch.object(asst, "duckdb_busy", return_value=False):
                out = asst.chat(Sess(), "how many rows?", dialect="native")
        self.assertFalse(out["ok"])
        self.assertIn("assistant", (out.get("error") or "").lower())


class AssistantApiRuntimeTests(unittest.TestCase):
    """OpenAI-compatible API mode (no network)."""

    def tearDown(self):
        asst.set_preferred_model(None)
        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_LOCAL,
            base_url="",
            model="",
            clear_api_key=True,
            update_key=True,
        )
        asst.stop_server()

    def test_normalize_api_base_strips_v1(self):
        self.assertEqual(
            asst.normalize_api_base("https://api.openai.com/v1/"),
            "https://api.openai.com",
        )
        self.assertEqual(
            asst.normalize_api_base("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080",
        )

    def test_status_api_mode_without_url(self):
        asst.set_api_runtime(mode=asst.ASSISTANT_MODE_API, base_url="")
        st = asst.status(None)
        self.assertEqual(st.get("mode"), "api")
        self.assertFalse(st.get("available"))
        self.assertEqual(st.get("reason"), "api_not_configured")

    def test_chat_uses_api_when_configured(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": False}}}

            def tables_tree(self):
                return [{"engine": "duckdb", "name": "t", "columns": []}]

            _running_lock = mock.MagicMock()
            _running = {}

        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_API,
            base_url="https://api.example.com",
            model="demo-model",
            api_key="sk-secret",
            update_key=True,
        )

        def fake_http(url, payload, timeout=120.0, headers=None,
                      cancellable=False):
            self.assertTrue(url.endswith("/v1/chat/completions"))
            self.assertEqual(payload.get("model"), "demo-model")
            self.assertIn("Authorization", headers or {})
            self.assertNotIn("sk-secret", url)
            return {
                "choices": [{
                    "message": {
                        "content": "Sure.\n```sql\nSELECT 1;\n```\n",
                    },
                }],
            }

        with mock.patch.object(asst, "duckdb_busy", return_value=False), \
             mock.patch.object(asst, "_http_json", side_effect=fake_http):
            out = asst.chat(Sess(), "select one", dialect="native")
        self.assertTrue(out["ok"])
        self.assertEqual(out.get("sql"), "SELECT 1;")
        self.assertEqual(out.get("mode"), "api")

    def test_cancel_sets_flag_and_closes_inflight_response(self):
        asst._cancel.clear()

        class FakeResp:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        resp = FakeResp()
        asst._track_response(resp)
        try:
            out = asst.cancel()
        finally:
            asst._untrack_response(resp)
            asst._cancel.clear()
        self.assertTrue(out["ok"])
        self.assertTrue(resp.closed)

    def test_chat_returns_cancelled_when_model_call_aborted(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": False}}}

            def tables_tree(self):
                return [{"engine": "duckdb", "name": "t", "columns": []}]

            _running_lock = mock.MagicMock()
            _running = {}

        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_API,
            base_url="https://api.example.com",
            model="demo-model",
            update_key=False,
        )

        def fake_http(url, payload, timeout=120.0, headers=None,
                      cancellable=False):
            # Simulate cancel() closing the socket mid-read.
            asst.cancel()
            raise OSError("connection closed")

        try:
            with mock.patch.object(asst, "duckdb_busy", return_value=False), \
                 mock.patch.object(asst, "_http_json", side_effect=fake_http):
                out = asst.chat(Sess(), "select one", dialect="native")
        finally:
            asst._cancel.clear()
        self.assertFalse(out["ok"])
        self.assertTrue(out.get("cancelled"))

    def test_chat_api_still_refuses_when_duckdb_busy(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": True}}}

            def tables_tree(self):
                return []

            _running_lock = mock.MagicMock()
            _running = {}

        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_API,
            base_url="https://api.example.com",
            model="demo",
            update_key=False,
        )
        with mock.patch.object(asst, "duckdb_busy", return_value=True):
            out = asst.chat(Sess(), "hi", dialect="native")
        self.assertFalse(out["ok"])
        self.assertEqual(out.get("queued_reason"), "duckdb_busy")

    def test_local_mode_still_requires_pack(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": False}}}

            def tables_tree(self):
                return []

            _running_lock = mock.MagicMock()
            _running = {}

        asst.set_api_runtime(mode=asst.ASSISTANT_MODE_LOCAL, base_url="")
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(asst, "find_pack",
                                   return_value=asst.find_pack(td)), \
                 mock.patch.object(asst, "duckdb_busy", return_value=False):
                out = asst.chat(Sess(), "how many?", dialect="native")
        self.assertFalse(out["ok"])
        self.assertIn("assistant", (out.get("error") or "").lower())


class AssistantModelsConfigTests(unittest.TestCase):
    """Session ConfigStore library + preferred-path wiring."""

    def tearDown(self):
        asst.set_preferred_model(None)
        asst.set_api_runtime(
            mode=asst.ASSISTANT_MODE_LOCAL,
            base_url="",
            model="",
            clear_api_key=True,
            update_key=True,
        )
        asst.stop_server()

    def test_configure_assistant_models_persist_and_prefer(self):
        from samql_core.session import Session

        class FakeConfig:
            def __init__(self):
                self.data = {}

            def get(self, key, default=None):
                return self.data.get(key, default)

            def set(self, key, value):
                self.data[key] = value

            def save(self):
                pass

        with tempfile.TemporaryDirectory() as td:
            gguf = Path(td) / "my-model.gguf"
            gguf.write_bytes(b"gguf")
            sess = object.__new__(Session)
            sess.config = FakeConfig()

            info = Session.configure_assistant_models(
                sess, add={"path": str(gguf), "label": "My model"}
            )
            self.assertEqual(len(info["models"]), 1)
            self.assertTrue(info["use_default"])
            mid = info["models"][0]["id"]

            info2 = Session.configure_assistant_models(
                sess, selected_id=mid
            )
            self.assertEqual(info2["selected_id"], mid)
            self.assertFalse(info2["use_default"])
            self.assertTrue(
                asst._same_path(asst.get_preferred_model(), gguf)
            )

            prefs = Session._assistant_models_prefs(sess)
            self.assertEqual(prefs["selected_id"], mid)
            self.assertIn("assistant_models", sess.config.data)

            info3 = Session.configure_assistant_models(
                sess, use_default=True
            )
            self.assertIsNone(info3["selected_id"])
            self.assertIsNone(asst.get_preferred_model())

    def test_configure_assistant_api_persists_without_echoing_key(self):
        from samql_core.session import Session

        class FakeConfig:
            def __init__(self):
                self.data = {}

            def get(self, key, default=None):
                return self.data.get(key, default)

            def set(self, key, value):
                self.data[key] = value

            def save(self):
                pass

        class FakeSecrets:
            available = True

            def __init__(self):
                self._d = {}

            def set(self, key, value):
                self._d[key] = value
                return True

            def get(self, key):
                return self._d.get(key)

            def has(self, key):
                return key in self._d

            def delete(self, key):
                return self._d.pop(key, None) is not None

        sess = object.__new__(Session)
        sess.config = FakeConfig()
        sess._secrets = FakeSecrets()

        info = Session.configure_assistant_models(
            sess,
            mode="api",
            api={
                "base_url": "https://api.example.com/v1",
                "model": "demo",
                "api_key": "sk-never-echo",
            },
        )
        self.assertEqual(info.get("mode"), "api")
        self.assertEqual(
            info.get("api", {}).get("base_url"),
            "https://api.example.com",
        )
        self.assertTrue(info.get("api", {}).get("has_api_key"))
        blob = json.dumps(info)
        self.assertNotIn("sk-never-echo", blob)
        self.assertEqual(
            sess.config.data.get("assistant_api", {}).get("mode"), "api"
        )
        self.assertEqual(
            sess._secrets.get(asst.ASSISTANT_API_SECRET_KEY),
            "sk-never-echo",
        )

        info2 = Session.configure_assistant_models(sess, clear_api=True)
        self.assertEqual(info2.get("mode"), "local")
        self.assertFalse(info2.get("api", {}).get("has_api_key"))
        self.assertFalse(sess._secrets.has(asst.ASSISTANT_API_SECRET_KEY))


class MemoryPlanTests(unittest.TestCase):
    def test_estimate_scales_with_gguf_size(self):
        with tempfile.TemporaryDirectory() as td:
            small = Path(td) / "small.gguf"
            big = Path(td) / "big.gguf"
            small.write_bytes(b"x" * (1024 * 1024))  # 1 MiB
            big.write_bytes(b"x" * (20 * 1024 * 1024))  # 20 MiB
            est_s = asst.estimate_gguf_ram_mb(small)
            est_b = asst.estimate_gguf_ram_mb(big)
        self.assertGreater(est_b, est_s)
        self.assertGreaterEqual(est_s, 768)

    def test_plan_allows_32b_class_on_64gib_with_duckdb_shed(self):
        """64 GiB laptop + oversized DuckDB budget must still admit ~20 GiB model."""

        class Duck:
            _applied_resource_memory_mb = 48 * 1024

            def apply_resource_memory_mb(self, mb, allow_decrease=False, wait=False):
                self._applied_resource_memory_mb = mb
                return True

        class DB:
            duck = Duck()

        class Sess:
            db = DB()

        sess = Sess()
        with mock.patch("samql_core.resourcebudget.snapshot", return_value={
            "memory_total_mb": 64 * 1024,
            "memory_available_mb": 900,  # OS free looks tiny
            "memory_total": 64 * 1024 * 1024 * 1024,
            "memory_available": 900 * 1024 * 1024,
        }):
            with mock.patch.object(
                asst, "estimate_gguf_ram_mb", return_value=20_000
            ):
                plan = asst.plan_local_model_memory(sess, "/tmp/qwen-32b.gguf")
                self.assertTrue(plan["machine_fits"])
                self.assertIsNotNone(plan["duckdb_target_mb"])
                self.assertLess(plan["duckdb_target_mb"], 48 * 1024)
                prepared = asst.prepare_memory_for_model(
                    sess, "/tmp/qwen-32b.gguf"
                )
                self.assertLess(
                    sess.db.duck._applied_resource_memory_mb, 48 * 1024
                )
        self.assertTrue(prepared.get("can_run"))

    def test_plan_refuses_32b_on_8gib_laptop(self):
        with mock.patch("samql_core.resourcebudget.snapshot", return_value={
            "memory_total_mb": 8 * 1024,
            "memory_available_mb": 4000,
            "memory_total": 8 * 1024 * 1024 * 1024,
            "memory_available": 4000 * 1024 * 1024,
        }):
            with mock.patch.object(asst, "estimate_gguf_ram_mb", return_value=20_000):
                plan = asst.plan_local_model_memory(None, "/tmp/x.gguf")
        self.assertFalse(plan["can_run"])
        self.assertFalse(plan["machine_fits"])

    def test_prepare_memory_never_drops_loaded_tables(self):
        """Dynamic RAM shed must only SET memory_limit — never drop tables."""

        class Duck:
            _applied_resource_memory_mb = 48 * 1024

            def __init__(self):
                self.sets = []
                self.dropped = []

            def apply_resource_memory_mb(self, mb, allow_decrease=False, wait=False):
                self.sets.append(mb)
                self._applied_resource_memory_mb = mb
                return True

            def drop_table(self, name):
                self.dropped.append(name)

        class DB:
            def __init__(self):
                self.duck = Duck()

            def drop_table(self, name):
                self.duck.drop_table(name)

        class Sess:
            def __init__(self):
                self.db = DB()
                self._tables = [
                    {"engine": "duckdb", "name": "trades"},
                    {"engine": "duckdb", "name": "users"},
                ]
                self.free_calls = 0

            def tables_tree(self):
                return list(self._tables)

            def free_memory(self):
                self.free_calls += 1
                return {}

            def drop_table(self, engine, name):
                self.db.drop_table(name)
                self._tables = [t for t in self._tables if t["name"] != name]

        sess = Sess()
        with mock.patch("samql_core.resourcebudget.snapshot", return_value={
            "memory_total_mb": 64 * 1024,
            "memory_available_mb": 900,
            "memory_total": 64 * 1024 * 1024 * 1024,
            "memory_available": 900 * 1024 * 1024,
        }):
            with mock.patch.object(asst, "estimate_gguf_ram_mb", return_value=20_000):
                plan = asst.prepare_memory_for_model(sess, "/tmp/qwen-32b.gguf")
        self.assertTrue(plan.get("tables_preserved"))
        self.assertEqual(
            sorted(t["name"] for t in sess.tables_tree()),
            ["trades", "users"],
        )
        self.assertEqual(sess.free_calls, 0)
        self.assertEqual(sess.db.duck.dropped, [])
        self.assertTrue(sess.db.duck.sets)  # memory_limit was lowered


if __name__ == "__main__":
    unittest.main()
