#!/usr/bin/env python3
"""Tests for assistant packaging mode helpers used by build.ps1 / build.sh."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import assistant_build_pack as abp  # noqa: E402


def _zip_names(path: Path) -> set[str]:
    with zipfile.ZipFile(path) as zf:
        return set(zf.namelist())


class ModeResolveTests(unittest.TestCase):
    def test_normalize_aliases(self):
        self.assertEqual(abp.normalize_mode("1"), "lean")
        self.assertEqual(abp.normalize_mode("sidecar"), "lean")
        self.assertEqual(abp.normalize_mode("2"), "runtime")
        self.assertEqual(abp.normalize_mode("runtime-only"), "runtime")
        self.assertEqual(abp.normalize_mode("3"), "post")
        self.assertEqual(abp.normalize_mode("4"), "embed")
        self.assertEqual(abp.normalize_mode("bundle"), "embed")
        self.assertIsNone(abp.normalize_mode("nope"))

    def test_resolve_prefers_cli_over_env(self):
        with mock.patch.dict(os.environ, {"SAMQL_ASSISTANT_PACK": "post"}):
            self.assertEqual(
                abp.resolve_mode("embed", interactive=False), "embed"
            )

    def test_resolve_defaults_runtime_without_tty(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SAMQL_ASSISTANT_PACK", None)
            self.assertEqual(
                abp.resolve_mode(None, interactive=False), "runtime"
            )


class PackStatusTests(unittest.TestCase):
    def test_pack_status_full_and_runtime_only(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = root / "assistant" / "runtime"
            models = root / "assistant" / "models"
            runtime.mkdir(parents=True)
            models.mkdir(parents=True)
            bin_name = "llama-server.exe" if abp._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")

            st_rt = abp.pack_status(root, require_model=False)
            self.assertTrue(st_rt["ok"])
            self.assertTrue(st_rt["runtime_ok"])
            self.assertFalse(st_rt["model_ok"])

            st_full = abp.pack_status(root, require_model=True)
            self.assertFalse(st_full["ok"])

            (models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf").write_bytes(b"g")
            st_full2 = abp.pack_status(root, require_model=True)
            self.assertTrue(st_full2["ok"])

    def test_stage_runtime_only_excludes_gguf(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = root / "assistant" / "runtime"
            models = root / "assistant" / "models"
            runtime.mkdir(parents=True)
            models.mkdir(parents=True)
            bin_name = "llama-server.exe" if abp._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            (models / "Qwen3-4B-Instruct-2507-Q4_K_M.gguf").write_bytes(b"g")

            dist = root / "dist"
            dist.mkdir()
            (dist / "SamQL-AppWindow").mkdir()
            written = abp.stage_post_build(root, include_models=False)
            self.assertEqual(len(written), 2)
            self.assertTrue((dist / "assistant" / "runtime" / bin_name).is_file())
            self.assertTrue(
                (dist / "SamQL-AppWindow" / "assistant" / "runtime" / bin_name).is_file()
            )
            self.assertFalse(
                any((dist / "assistant" / "models").glob("*.gguf"))
            )
            self.assertTrue(
                (dist / "assistant" / "models" / "README.txt").is_file()
            )
            self.assertIn(
                "Fetch-SamQL-Assistant",
                (dist / "assistant" / "models" / "README.txt").read_text(
                    encoding="utf-8"
                ),
            )

    def test_stage_post_includes_gguf(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = root / "assistant" / "runtime"
            models = root / "assistant" / "models"
            runtime.mkdir(parents=True)
            models.mkdir(parents=True)
            bin_name = "llama-server.exe" if abp._is_windows() else "llama-server"
            (runtime / bin_name).write_bytes(b"x")
            gguf = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            (models / gguf).write_bytes(b"g")

            dist = root / "dist"
            dist.mkdir()
            (dist / "SamQL-AppWindow").mkdir()
            written = abp.stage_post_build(root, include_models=True)
            self.assertTrue(
                (dist / "SamQL-AppWindow" / "assistant" / "models" / gguf).is_file()
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


class OnedirZipTests(unittest.TestCase):
    def test_dual_zips_lean_and_assistant(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            onedir = root / "dist" / "SamQL-AppWindow"
            asst_rt = onedir / "assistant" / "runtime"
            asst_rt.mkdir(parents=True)
            (onedir / "SamQL-AppWindow.exe").write_bytes(b"exe")
            bin_name = "llama-server.exe" if abp._is_windows() else "llama-server"
            (asst_rt / bin_name).write_bytes(b"srv")
            (asst_rt / "ggml.dll").write_bytes(b"dll")

            lean_zip = root / "dist" / "SamQL-AppWindow.zip"
            asst_zip = root / "dist" / "SamQL-AppWindow-Assistant.zip"
            written = abp.write_onedir_distribution_zips(
                onedir, lean_zip=lean_zip, assistant_zip=asst_zip
            )
            self.assertEqual(len(written), 2)
            self.assertTrue(lean_zip.is_file())
            self.assertTrue(asst_zip.is_file())

            lean_names = _zip_names(lean_zip)
            asst_names = _zip_names(asst_zip)
            self.assertTrue(
                any(n.endswith("SamQL-AppWindow.exe") for n in lean_names)
            )
            self.assertFalse(any("/assistant/" in n or n.startswith(
                "SamQL-AppWindow/assistant/"
            ) for n in lean_names))
            self.assertTrue(
                any(f"assistant/runtime/{bin_name}" in n.replace("\\", "/")
                    for n in asst_names)
            )
            # Live onedir keeps assistant/ after zipping.
            self.assertTrue((asst_rt / bin_name).is_file())

    def test_lean_only_when_no_assistant_dir(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            onedir = root / "dist" / "SamQL-AppWindow"
            onedir.mkdir(parents=True)
            (onedir / "SamQL-AppWindow.exe").write_bytes(b"exe")
            lean_zip = root / "dist" / "SamQL-AppWindow.zip"
            asst_zip = root / "dist" / "SamQL-AppWindow-Assistant.zip"
            written = abp.write_onedir_distribution_zips(
                onedir, lean_zip=lean_zip, assistant_zip=asst_zip
            )
            self.assertEqual(written, [lean_zip.resolve()])
            self.assertTrue(lean_zip.is_file())
            self.assertFalse(asst_zip.exists())


if __name__ == "__main__":
    unittest.main()
