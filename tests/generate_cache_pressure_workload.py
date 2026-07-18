#!/usr/bin/env python3
r"""Generate distinct on-disk fixtures for cache / memory pressure benchmarks.

Produces multiple NDJSON (and optional CSV) files sized toward a per-file
byte target. Each file has unique content so SamQL's filecache keys differ
(path + size + mtime + kind) and conversions accumulate instead of colliding
on a single entry.

Never commit generated payloads — create them at runtime.

Examples::

    python tests/generate_cache_pressure_workload.py -o tmp/cache_pressure --self-test
    python tests/generate_cache_pressure_workload.py -o tmp/cache_pressure \\
        --files 8 --target-bytes 67108864

Environment overrides (also read by the benchmark harness):

* ``SAMQL_CACHE_PRESSURE_TARGET_BYTES`` — default ``67108864`` (64 MiB) per file
* ``SAMQL_CACHE_PRESSURE_FILES`` — default ``8``
* ``SAMQL_CACHE_PRESSURE_RECORDS`` — default ``400`` records per file
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any


TARGET_BYTES_DEFAULT = 64 * 1024 * 1024
FILES_DEFAULT = 8
RECORDS_DEFAULT = 400

# Self-test stays tiny for CI.
SELF_TARGET_BYTES = 8 * 1024
SELF_FILES = 3
SELF_RECORDS = 8


def target_bytes_from_env(default: int = TARGET_BYTES_DEFAULT) -> int:
    raw = (os.environ.get("SAMQL_CACHE_PRESSURE_TARGET_BYTES") or "").strip()
    if not raw:
        return int(default)
    return max(1024, int(raw))


def files_from_env(default: int = FILES_DEFAULT) -> int:
    raw = (os.environ.get("SAMQL_CACHE_PRESSURE_FILES") or "").strip()
    if not raw:
        return int(default)
    return max(1, min(int(raw), 64))


def records_from_env(default: int = RECORDS_DEFAULT) -> int:
    raw = (os.environ.get("SAMQL_CACHE_PRESSURE_RECORDS") or "").strip()
    if not raw:
        return int(default)
    return max(2, min(int(raw), 200_000))


def _pad_block(size: int, salt: int) -> str:
    """Deterministic pad that resists trivial run-length / dictionary collapse.

    A repeating alphabet pad compresses to nearly nothing in Parquet, which
    understates filecache disk pressure. Use a salted LCG so each file stays
    near its byte target on disk after conversion.
    """
    if size <= 0:
        return ""
    head = "S%08X|" % (salt & 0xFFFFFFFF)
    if size <= len(head):
        return head[:size]
    # Printable ASCII via LCG (no JSON/CSV escapes).
    out = [head]
    need = size - len(head)
    state = (salt ^ 0xA5A5A5A5) & 0xFFFFFFFF
    chunk = []
    for _ in range(need):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        chunk.append(chr(32 + (state % 95)))
        if len(chunk) >= 4096:
            out.append("".join(chunk))
            chunk.clear()
    if chunk:
        out.append("".join(chunk))
    return "".join(out)


def build_record(file_idx: int, rec_id: int, pad_len: int) -> dict[str, Any]:
    return {
        "file_idx": file_idx,
        "rec_id": rec_id,
        "book": "PRESSURE-%02d" % (file_idx % 16),
        "amount": (file_idx * 1000 + rec_id) % 9973,
        "tags": ["a", "b", "c"] if rec_id % 3 == 0 else ["x"],
        "nest": {
            "l2": {
                "leaf": "f%d-r%d" % (file_idx, rec_id),
                "pad": _pad_block(pad_len, salt=(file_idx << 16) ^ rec_id),
            }
        },
    }


def _pad_len_for_target(records: int, target_bytes: int, file_idx: int) -> int:
    """Estimate per-record pad so the NDJSON file lands near ``target_bytes``."""
    # Rough envelope without pad (~180 bytes/line) + JSON overhead.
    base = 220
    overhead = records * base + 64
    if target_bytes <= overhead:
        return 16
    # Pad is JSON-escaped as a string; ASCII-only so 1 byte ≈ 1 char.
    return max(16, (int(target_bytes) - overhead) // max(1, records))


def write_ndjson(path: Path, *, file_idx: int, records: int,
                 target_bytes: int) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    pad_len = _pad_len_for_target(records, target_bytes, file_idx)
    written = 0
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for rid in range(records):
            line = json.dumps(build_record(file_idx, rid, pad_len),
                              separators=(",", ":"))
            fh.write(line)
            fh.write("\n")
            written += len(line) + 1
            # Grow pad on the last few rows if still short of target.
            if rid == records - 2 and written < target_bytes:
                extra = int(target_bytes) - written - 64
                if extra > 0:
                    pad_len = pad_len + extra
    size = path.stat().st_size
    # If still short, append one fat trailer record (keeps line-oriented NDJSON).
    if size < int(target_bytes) * 0.95:
        need = int(target_bytes) - size
        trailer = build_record(file_idx, records, max(64, need - 120))
        trailer["rec_id"] = records
        with path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(trailer, separators=(",", ":")) + "\n")
        size = path.stat().st_size
    return {
        "path": str(path.resolve()),
        "kind": "ndjson",
        "file_idx": file_idx,
        "records": records + (1 if size >= int(target_bytes) * 0.95 else 0),
        "bytes": size,
        "target_bytes": int(target_bytes),
        "pad_len": pad_len,
    }


def write_csv(path: Path, *, file_idx: int, records: int,
              target_bytes: int) -> dict[str, Any]:
    """CSV twin — distinct filecache kind from NDJSON.

    DuckDB's default ``max_line_size`` is 2 MiB, so pads are capped per cell
    and row count is grown to reach ``target_bytes`` instead of one fat line.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Stay well under DuckDB's 2 MiB max_line_size default.
    max_pad = 256 * 1024
    pad_len = min(max_pad, max(32, _pad_len_for_target(
        records, target_bytes, file_idx) // 2))
    # Grow row count when a capped pad cannot reach the byte target.
    approx_row = 48 + pad_len
    need_rows = max(records, int(target_bytes) // max(1, approx_row) + 2)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["file_idx", "rec_id", "book", "amount", "pad"])
        for rid in range(need_rows):
            w.writerow([
                file_idx, rid, "PRESSURE-%02d" % (file_idx % 16),
                (file_idx * 1000 + rid) % 9973,
                _pad_block(pad_len, salt=(file_idx << 20) ^ rid),
            ])
    size = path.stat().st_size
    return {
        "path": str(path.resolve()),
        "kind": "csv",
        "file_idx": file_idx,
        "records": need_rows,
        "bytes": size,
        "target_bytes": int(target_bytes),
        "pad_len": pad_len,
    }


def write_workload(
    out_dir: Path,
    *,
    n_files: int,
    target_bytes: int,
    records: int,
    include_csv: bool = True,
    self_test: bool = False,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    fixtures: list[dict[str, Any]] = []
    for i in range(n_files):
        nd = out_dir / ("pressure_%02d.ndjson" % i)
        fixtures.append(write_ndjson(
            nd, file_idx=i, records=records, target_bytes=target_bytes))
        if include_csv and (self_test or i % 2 == 0):
            # Self-test: one CSV; full: CSV for even indices (kind diversity).
            # Keep full-mode CSV modest — below the CSV on-disk hard floor so
            # NDJSON drives filecache pressure while CSV adds in-engine load
            # without multi-×64 MiB RAM materialize.
            if self_test and i != 0:
                continue
            csv_path = out_dir / ("pressure_%02d.csv" % i)
            if self_test:
                csv_target = max(2048, target_bytes // 2)
            else:
                csv_target = max(256 * 1024, min(int(target_bytes), 4 * 1024 * 1024))
            fixtures.append(write_csv(
                csv_path, file_idx=i, records=records,
                target_bytes=csv_target))
    total = sum(int(f["bytes"]) for f in fixtures)
    return {
        "out_dir": str(out_dir.resolve()),
        "files": len(fixtures),
        "ndjson_files": sum(1 for f in fixtures if f["kind"] == "ndjson"),
        "csv_files": sum(1 for f in fixtures if f["kind"] == "csv"),
        "total_bytes": total,
        "target_bytes_each": int(target_bytes),
        "records_per_file": int(records),
        "mode": "self-test" if self_test else "performance",
        "fixtures": fixtures,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-o", "--out-dir", required=True,
                    help="directory for generated fixtures")
    ap.add_argument("--self-test", action="store_true",
                    help="tiny fixtures for CI")
    ap.add_argument("--files", type=int, default=None)
    ap.add_argument("--target-bytes", type=int, default=None)
    ap.add_argument("--records", type=int, default=None)
    ap.add_argument("--no-csv", action="store_true")
    args = ap.parse_args(argv)

    if args.self_test:
        n_files = args.files if args.files is not None else SELF_FILES
        target = args.target_bytes if args.target_bytes is not None else SELF_TARGET_BYTES
        records = args.records if args.records is not None else SELF_RECORDS
    else:
        n_files = args.files if args.files is not None else files_from_env()
        target = (args.target_bytes if args.target_bytes is not None
                  else target_bytes_from_env())
        records = args.records if args.records is not None else records_from_env()

    stats = write_workload(
        Path(args.out_dir),
        n_files=n_files,
        target_bytes=target,
        records=records,
        include_csv=not args.no_csv,
        self_test=bool(args.self_test),
    )
    print(json.dumps(stats, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
