#!/usr/bin/env python3
"""Generate heavily nested JSON samples that exercise the large flatten-off
load path (array / concat / NDJSON) without needing a real 1.8 GiB file.

Usage:
  python tools/gen_nested_json_stall_sample.py [--out-dir DIR] [--target-mb N]

Writes:
  nested_array.json          top-level [ {...}, ... ]  (rewrite + Parquet path)
  nested_concat_objs.json    {...}{...}{...} no newlines (concat rewrite)
  nested_concat_arrays.json  [{...}][{...}]...         (ijson then stdlib re-read)
  nested.ndjson              one object per line         (direct DuckDB NDJSON)
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def _record(i: int, nest_depth: int = 6, tags: int = 8, legs: int = 4) -> dict:
    """One trade-like record with deep nesting + arrays of structs."""
    nest = {"leaf": i, "flag": bool(i % 2), "note": f"n{i}"}
    for d in range(nest_depth):
        nest = {
            f"lvl{d}": nest,
            "meta": {"i": i, "d": d, "pad": ("x" * 24)},
            "arr": [{"k": k, "v": i + k} for k in range(3)],
        }
    return {
        "id": i,
        "sym": f"SYM{i % 97}",
        "qty": i * 1.5,
        "empty_int": "" if i % 17 == 0 else i,  # conversion trap
        "tags": [f"t{j}" for j in range(tags)],
        "legs": [
            {
                "leg_id": f"{i}-{L}",
                "side": "BUY" if L % 2 == 0 else "SELL",
                "cf": [
                    {"dt": f"2026-01-{(L % 28) + 1:02d}", "amt": i + L + c}
                    for c in range(3)
                ],
                "nest": nest,
            }
            for L in range(legs)
        ],
        "nest": nest,
    }


def _write_until(path: str, mode: str, target_bytes: int, writer) -> tuple[int, int]:
    n = 0
    with open(path, mode, encoding="utf-8", newline="\n") as f:
        writer.begin(f)
        while f.tell() < target_bytes:
            writer.write(f, _record(n))
            n += 1
            if n % 500 == 0 and f.tell() >= target_bytes:
                break
        writer.end(f)
        size = f.tell()
    return n, size


class _ArrayWriter:
    def begin(self, f):
        f.write("[\n")
        self._first = True

    def write(self, f, rec):
        if not self._first:
            f.write(",\n")
        self._first = False
        json.dump(rec, f, separators=(",", ":"), ensure_ascii=False)

    def end(self, f):
        f.write("\n]\n")


class _ConcatObjWriter:
    def begin(self, f):
        pass

    def write(self, f, rec):
        json.dump(rec, f, separators=(",", ":"), ensure_ascii=False)

    def end(self, f):
        f.write("\n")


class _ConcatArrayWriter:
    """Each record wrapped as a one-element array, concatenated — the shape
    that makes ijson finish the first `[...]` then fail and re-read."""

    def begin(self, f):
        pass

    def write(self, f, rec):
        f.write("[")
        json.dump(rec, f, separators=(",", ":"), ensure_ascii=False)
        f.write("]")

    def end(self, f):
        f.write("\n")


class _NdjsonWriter:
    def begin(self, f):
        pass

    def write(self, f, rec):
        json.dump(rec, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")

    def end(self, f):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=os.path.join("tmp", "json_stall_samples"))
    ap.add_argument("--target-mb", type=float, default=48.0,
                    help="Approximate size per sample (default 48 MiB)")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    target = int(args.target_mb * 1024 * 1024)
    specs = [
        ("nested_array.json", _ArrayWriter()),
        ("nested_concat_objs.json", _ConcatObjWriter()),
        ("nested_concat_arrays.json", _ConcatArrayWriter()),
        ("nested.ndjson", _NdjsonWriter()),
    ]
    for name, writer in specs:
        path = os.path.join(args.out_dir, name)
        n, size = _write_until(path, "w", target, writer)
        print("%s  rows=%d  size=%.1f MiB" % (path, n, size / (1024 * 1024)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
