#!/usr/bin/env python3
"""Unit tests for assistant pack model URL / filename mapping."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from fetch_assistant_pack import (  # noqa: E402
    DEFAULT_MODEL_KEY,
    GGUF_NAME,
    GGUF_URL,
    MODELS,
    main as fetch_main,
    normalize_model_key,
    resolve_model,
)


class ModelMappingTests(unittest.TestCase):
    def test_default_aliases_match_4b(self):
        self.assertEqual(DEFAULT_MODEL_KEY, "4b")
        self.assertEqual(GGUF_NAME, "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")
        self.assertIn("Qwen3-4B-Instruct-2507-GGUF", GGUF_URL)
        self.assertTrue(GGUF_URL.endswith(GGUF_NAME))

    def test_normalize_accepts_aliases(self):
        self.assertEqual(normalize_model_key("4"), "4b")
        self.assertEqual(normalize_model_key("4B"), "4b")
        self.assertEqual(normalize_model_key("medium"), "4b")
        self.assertEqual(normalize_model_key("small"), "4b")
        self.assertEqual(normalize_model_key("7B"), "7b")
        self.assertEqual(normalize_model_key("large"), "7b")
        with self.assertRaises(ValueError):
            normalize_model_key("1.5b")
        with self.assertRaises(ValueError):
            normalize_model_key("3b")
        with self.assertRaises(ValueError):
            normalize_model_key("32b")
        with self.assertRaises(ValueError):
            normalize_model_key("13b")

    def test_resolve_model_urls_and_filenames(self):
        expected = {
            "4b": (
                "unsloth/Qwen3-4B-Instruct-2507-GGUF",
                "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
            ),
            "7b": (
                "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
                "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
            ),
        }
        self.assertEqual(set(MODELS.keys()), set(expected.keys()))
        for key, (repo, filename) in expected.items():
            spec = resolve_model(key)
            self.assertEqual(spec["repo"], repo)
            self.assertEqual(spec["filename"], filename)
            self.assertEqual(
                spec["url"],
                f"https://huggingface.co/{repo}/resolve/main/{filename}",
            )
        self.assertTrue(resolve_model("4b")["label"].startswith("Qwen3-4B-"))
        self.assertTrue(resolve_model("7b")["label"].startswith("Qwen2.5-Coder-"))


class SkipModelCliTests(unittest.TestCase):
    def test_skip_model_and_skip_llama_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            fetch_main(["--skip-model", "--skip-llama"])
        self.assertEqual(ctx.exception.code, 1)


class LlamaAssetPickerTests(unittest.TestCase):
    """The Windows CPU archive matcher must survive upstream naming drift.

    2026-08-04 build failure: llama.cpp's latest release carried only GPU
    archives (cudart/cuda/vulkan/...), and the old matcher demanded the one
    exact suffix -bin-win-cpu-x64.zip -- the whole AppWindow release build
    died on upstream's partial release. The picker now matches CPU archives
    by meaning and returns None for a release with nothing usable, so the
    fetcher can walk back to an earlier release.
    """

    @staticmethod
    def _assets(*names):
        return [
            {"name": n, "browser_download_url": f"https://dl/{n}"}
            for n in names
        ]

    def _pick(self, plat, *names):
        from fetch_assistant_pack import _pick_llama_asset_or_none
        return _pick_llama_asset_or_none(self._assets(*names), plat)

    def test_modern_cpu_name_preferred(self):
        got = self._pick(
            "win-cpu",
            "cudart-llama-bin-win-cuda-12.4-x64.zip",
            "llama-b6000-bin-win-cpu-x64.zip",
            "llama-b6000-bin-win-vulkan-x64.zip",
        )
        self.assertEqual(got[0], "llama-b6000-bin-win-cpu-x64.zip")
        self.assertEqual(got[2], "llama-server.exe")

    def test_historical_avx2_name_matches(self):
        got = self._pick(
            "win-cpu",
            "llama-b4000-bin-win-avx512-x64.zip",
            "llama-b4000-bin-win-avx2-x64.zip",
            "llama-b4000-bin-win-cuda-cu12.2.0-x64.zip",
        )
        self.assertEqual(got[0], "llama-b4000-bin-win-avx2-x64.zip")

    def test_any_plain_cpu_variant_matches(self):
        got = self._pick(
            "win-cpu",
            "llama-b7000-bin-win-noavx-x64.zip",
            "llama-b7000-bin-win-cuda-12.4-x64.zip",
        )
        self.assertEqual(got[0], "llama-b7000-bin-win-noavx-x64.zip")

    def test_gpu_only_release_returns_none(self):
        # The exact 2026-08-04 shape: GPU/arm archives only -> walk back.
        self.assertIsNone(self._pick(
            "win-cpu",
            "cudart-llama-bin-win-cuda-12.4-x64.zip",
            "llama-b7900-bin-win-cuda-12.4-x64.zip",
            "llama-b7900-bin-win-vulkan-x64.zip",
            "llama-b7900-bin-win-hip-radeon-x64.zip",
            "llama-b7900-bin-win-sycl-x64.zip",
            "llama-b7900-bin-win-arm64.zip",
        ))

    def test_arm_never_matches_win_cpu(self):
        self.assertIsNone(
            self._pick("win-cpu", "llama-b7900-bin-win-cpu-arm64.zip"),
        )

    def test_linux_and_macos_still_resolve(self):
        got = self._pick(
            "linux-cpu",
            "llama-b6000-bin-ubuntu-vulkan-x64.tar.gz",
            "llama-b6000-bin-ubuntu-x64.tar.gz",
        )
        self.assertEqual(got[0], "llama-b6000-bin-ubuntu-x64.tar.gz")
        got = self._pick("macos-arm", "llama-b6000-bin-macos-arm64.tar.gz")
        self.assertEqual(got[0], "llama-b6000-bin-macos-arm64.tar.gz")


if __name__ == "__main__":
    unittest.main()
