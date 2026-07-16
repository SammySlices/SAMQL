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


if __name__ == "__main__":
    unittest.main()
