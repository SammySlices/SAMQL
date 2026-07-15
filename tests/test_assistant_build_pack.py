#!/usr/bin/env python3
"""Tests for assistant packaging mode helpers used by build.ps1 / build.sh."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import assistant_build_pack as abp  # noqa: E402


class ModeResolveTests(unittest.TestCase):
    def test_normalize_aliases(self):
        self.assertEqual(abp.normalize_mode("1"), "lean")
        self.assertEqual(abp.normalize_mode("sidecar"), "lean")
        self.assertEqual(abp.normalize_mode("2"), "post")
        self.assertEqual(abp.normalize_mode("3"), "embed")
        self.assertEqual(abp.normalize_mode("bundle"), "embed")
        self.assertIsNone(abp.normalize_mode("nope"))

    def test_resolve_prefers_cli_over_env(self):
        with mock.patch.dict(os.environ, {"SAMQL_ASSISTANT_PACK": "post"}):
            self.assertEqual(
                abp.resolve_mode("embed", interactive=False), "embed"
            )

    def test_resolve_defaults_lean_without_tty(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SAMQL_ASSISTANT_PACK", None)
            self.assertEqual(
                abp.resolve_mode(None, interactive=False), "lean"
            )


class PackStatusTests(unittest.TestCase):
    def test_pack_status_and_stage(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = root / "assistant" / "runtime"
            models = root / "assistant" / "models"
            runtime.mkdir(parents=True)
            models.mkdir(parents=True)
            bin_name = "llama-server.exe" if abp._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            (models / "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf").write_bytes(b"g")
            st = abp.pack_status(root)
            self.assertTrue(st["ok"])

            dist = root / "dist"
            dist.mkdir()
            (dist / "SamQL-AppWindow").mkdir()
            written = abp.stage_post_build(root)
            self.assertTrue((dist / "assistant" / "runtime" / bin_name).is_file())
            self.assertTrue(
                (dist / "SamQL-AppWindow" / "assistant" / "models" /
                 "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf").is_file()
            )
            self.assertEqual(len(written), 2)


class MeipassDiscoveryTests(unittest.TestCase):
    def test_candidate_roots_include_meipass(self):
        sys.path.insert(0, str(ROOT / "backend"))
        from samql_core import assistant as asst

        with tempfile.TemporaryDirectory() as td:
            meipass = Path(td) / "_MEI"
            (meipass / "assistant").mkdir(parents=True)
            with mock.patch.object(sys, "_MEIPASS", str(meipass), create=True):
                roots = [str(p) for p in asst._candidate_roots()]
            self.assertTrue(any(str(meipass / "assistant") in r for r in roots))


if __name__ == "__main__":
    unittest.main()
