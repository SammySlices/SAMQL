#!/usr/bin/env python3
"""Unit tests for the optional local SQL assistant (no model required)."""
from __future__ import annotations

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


class PackAndGateTests(unittest.TestCase):
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
            (models / "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf").write_bytes(b"gguf")
            got = asst.find_pack(root)
        self.assertTrue(got["ok"])
        self.assertTrue(got["model"].endswith(".gguf"))
        self.assertIn("runtime", got["binary"].replace("\\", "/"))

    def test_chat_refuses_when_duckdb_busy(self):
        class Sess:
            def status(self):
                return {"engines": {"duckdb": {"active": True, "busy": True}}}

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
        }
        with mock.patch.object(asst, "find_pack", return_value=fake_pack), \
             mock.patch.object(asst, "duckdb_busy", return_value=True):
            out = asst.chat(Sess(), "select 1", dialect="native")
        self.assertFalse(out["ok"])
        self.assertEqual(out.get("queued_reason"), "duckdb_busy")
        self.assertIn("idle", (out.get("error") or "").lower())

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


if __name__ == "__main__":
    unittest.main()
