#!/usr/bin/env python3
r"""Streaming generator for a hostile nested NDJSON fixture.

Produces exactly ``RECORD_COUNT`` (default 2000) NDJSON lines with:

* nested objects up to **5 levels** deep
* multiple nested arrays (object arrays, scalar arrays, arrays-in-arrays)
* irregular keys, empty arrays, null nests, duplicate-looking keys at
  different depths, and Unicode field names that SamQL already tolerates
* a long ``pad`` blob sized so the file reaches a target byte length
  (default **2 GiB+**)

**Fan-out math (exact when defaults are used)**::

    FANOUT_LEGS × FANOUT_CASHFLOWS × FANOUT_ADJUSTMENTS
        = 15 × 10 × 10
        = 1_500 exploded leaf rows per source record

    RECORD_COUNT × 1_500
        = 2_000 × 1_500
        = 3_000_000 deepest-array rows after relational flatten/shred

Secondary arrays (``tags``, ``contacts``, ``matrix``, ``mixed``) stay small so
they do not dominate the explode count; the asserted 3M figure is the product
along ``legs → cashflows → adjustments``.

Examples::

    python tests/generate_hostile_nested_ndjson.py -o tmp/hostile.ndjson
    python tests/generate_hostile_nested_ndjson.py -o tmp/smoke.ndjson \\
        --target-bytes 4000000

Environment overrides (used by the benchmark harness too):

* ``SAMQL_PERF_NDJSON_TARGET_BYTES`` — default ``2147483648`` (2 GiB)
* ``SAMQL_PERF_NDJSON_RECORDS`` — default ``2000``
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

# Exact fan-out constants (documented contract for the perf suite).
RECORD_COUNT_DEFAULT = 2000
FANOUT_LEGS = 15
FANOUT_CASHFLOWS = 10
FANOUT_ADJUSTMENTS = 10
FANOUT_PER_RECORD = FANOUT_LEGS * FANOUT_CASHFLOWS * FANOUT_ADJUSTMENTS  # 1500
EXPLODED_LEAF_ROWS_DEFAULT = RECORD_COUNT_DEFAULT * FANOUT_PER_RECORD  # 3_000_000

# Default target: 2 GiB. Override via CLI / SAMQL_PERF_NDJSON_TARGET_BYTES.
TARGET_BYTES_DEFAULT = 2 * 1024 ** 3

# Keys that every record contributes (for Field Explorer / correctness asserts).
# Names only — structural "(element)" markers are discovered separately.
EXPECTED_FIELD_NAMES = frozenset({
    "rec_id", "book", "product",
    "meta", "source", "flags", "alpha", "beta", "labels",
    "deep", "l2", "l3", "l4", "l5_leaf", "pad",
    "legs", "leg_id", "pay_receive", "cashflows", "cf_id",
    "amount", "ccy", "adjustments", "adj_type", "delta", "note",
    "matrix", "mixed", "empty_arr", "null_nest",
    "tags", "contacts", "role", "email", "phones",
    "parallel", "id", "nest", "value",
    "café_note", "税率",
})

# Present on a subset of records only (irregular schema stress).
IRREGULAR_FIELD_NAMES = frozenset({"bonus_branch", "ghost_key"})


def fanout_math(records: int = RECORD_COUNT_DEFAULT) -> dict[str, int]:
    """Return the documented explode arithmetic for ``records`` source lines."""
    per = FANOUT_PER_RECORD
    return {
        "records": int(records),
        "fanout_legs": FANOUT_LEGS,
        "fanout_cashflows": FANOUT_CASHFLOWS,
        "fanout_adjustments": FANOUT_ADJUSTMENTS,
        "fanout_per_record": per,
        "exploded_leaf_rows": int(records) * per,
    }


def _pad_char_block(size: int) -> str:
    """Deterministic ASCII pad (no escapes) of exactly ``size`` characters."""
    if size <= 0:
        return ""
    # 64-byte repeating pattern keeps encode cost low and avoids JSON escapes.
    unit = "0123456789abcdefABCDEF~_-+=" * 2  # 64 chars
    reps, rem = divmod(size, len(unit))
    return unit * reps + unit[:rem]


def build_record(rec_id: int, pad_len: int) -> dict[str, Any]:
    """Build one hostile nested record with exact array fan-out."""
    # 5-level object nest (not part of the explode product).
    deep = {
        "l2": {
            "l3": {
                "l4": {
                    "l5_leaf": "leaf-%d" % rec_id,
                    "pad": _pad_char_block(pad_len),
                    "café_note": "unicode-café-%d" % rec_id,
                    "税率": rec_id % 97,
                }
            }
        }
    }

    legs = []
    for li in range(FANOUT_LEGS):
        cashflows = []
        for ci in range(FANOUT_CASHFLOWS):
            adjustments = []
            for ai in range(FANOUT_ADJUSTMENTS):
                adjustments.append({
                    "adj_type": "rate" if (ai % 2) == 0 else "dayCount",
                    "delta": (rec_id * 17 + li * 13 + ci * 7 + ai) % 10000 / 100.0,
                    "note": "r%d-l%d-c%d-a%d" % (rec_id, li, ci, ai),
                })
            cashflows.append({
                "cf_id": "CF-%d-%d-%d" % (rec_id, li, ci),
                "amount": {
                    "value": float(rec_id * 1000 + li * 10 + ci),
                    "ccy": "USD" if (ci % 2) == 0 else "EUR",
                },
                "adjustments": adjustments,
                # Small arrays-in-arrays / mixed — do not dominate fan-out.
                "matrix": [[li, ci], [ci, li]],
                "mixed": [ci, "t-%d" % ci, None, {"k": "v%d" % li}],
            })
        legs.append({
            "leg_id": "LEG-%d-%d" % (rec_id, li),
            "pay_receive": "Pay" if (li % 2) == 0 else "Receive",
            "cashflows": cashflows,
            "empty_arr": [],
            "null_nest": None,
        })

    # Duplicate-looking ``id`` at three depths under ``parallel``.
    parallel = {
        "id": "P-%d" % rec_id,
        "nest": {
            "id": "P-nest-%d" % rec_id,
            "deep": {
                "id": "P-deep-%d" % rec_id,
                "value": rec_id,
            },
        },
    }

    rec: dict[str, Any] = {
        "rec_id": rec_id,
        "book": "HOSTILE-%02d" % (rec_id % 20),
        "product": "HostileNestedSwap",
        "meta": {
            "source": "perf-generator",
            "flags": {
                "alpha": (rec_id % 3) == 0,
                "beta": None if (rec_id % 11) == 0 else True,
            },
            "labels": ["L0", "L1", "L%d" % (rec_id % 5)],
        },
        "deep": deep,
        "legs": legs,
        "tags": ["t0", "t1", "t%d" % (rec_id % 7)],
        "contacts": [
            {
                "role": "trader",
                "email": "t%d@example.test" % rec_id,
                "phones": ["+1-555-%04d" % (rec_id % 10000)],
            },
            {
                "role": "ops",
                "email": "o%d@example.test" % rec_id,
                "phones": ["+1-555-%04d" % ((rec_id + 1) % 10000),
                           "+1-555-%04d" % ((rec_id + 2) % 10000)],
            },
        ],
        "parallel": parallel,
    }

    # Irregular keys across records (schema drift stress).
    if (rec_id % 17) == 0:
        rec["bonus_branch"] = {
            "extra": {"nested": {"hint": "irregular-%d" % rec_id}},
            "empty_arr": [],
        }
    if (rec_id % 23) == 0:
        rec["ghost_key"] = None

    return rec


def _estimate_base_bytes(sample_pad: int = 0) -> int:
    """Encode one sample record to estimate non-pad JSON size."""
    line = json.dumps(build_record(0, sample_pad),
                      ensure_ascii=False, separators=(",", ":"))
    return len(line.encode("utf-8")) + 1  # + newline


def compute_pad_len(records: int, target_bytes: int) -> int:
    """Choose a per-record pad length so total file size ≥ ``target_bytes``.

    Uses a measured base-record size (pad=0) and solves for pad characters.
    Adds a small safety margin so UTF-8 / encoder variance still clears the
    floor on the first streaming write.
    """
    records = max(1, int(records))
    target_bytes = max(0, int(target_bytes))
    base = _estimate_base_bytes(0)
    # pad appears once as a JSON string value; each ASCII char ≈ 1 UTF-8 byte
    # plus we already counted ``"pad":""`` in base. Extra bytes ≈ pad_len.
    need = target_bytes - base * records
    if need <= 0:
        return 0
    # Ceiling divide + 64-byte margin per record for encoder jitter.
    per = (need + records - 1) // records + 64
    return max(0, int(per))


def iter_records(records: int, pad_len: int) -> Iterable[dict[str, Any]]:
    for i in range(int(records)):
        yield build_record(i, pad_len)


def write_ndjson(
    path: str | Path,
    *,
    records: int = RECORD_COUNT_DEFAULT,
    target_bytes: int = TARGET_BYTES_DEFAULT,
    pad_len: int | None = None,
) -> dict[str, Any]:
    """Stream-write NDJSON to ``path``. Returns size / fan-out stats.

    Never holds the full file in RAM — one record encoded at a time.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    records = int(records)
    if pad_len is None:
        pad_len = compute_pad_len(records, target_bytes)
    math = fanout_math(records)

    written = 0
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in iter_records(records, pad_len):
            line = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
            fh.write(line)
            fh.write("\n")
            written += 1

    size = path.stat().st_size
    if written != records:
        raise RuntimeError("wrote %d lines, expected %d" % (written, records))
    if size < int(target_bytes):
        # One corrective rewrite with a larger pad (still streaming).
        deficit = int(target_bytes) - size
        extra = (deficit + records - 1) // records + 128
        return write_ndjson(
            path, records=records, target_bytes=target_bytes,
            pad_len=pad_len + extra,
        )

    # Count lines without loading content.
    with path.open("rb") as fh:
        line_count = sum(1 for _ in fh)

    return {
        "path": str(path.resolve()),
        "records": records,
        "lines": line_count,
        "bytes": size,
        "target_bytes": int(target_bytes),
        "pad_len": pad_len,
        **math,
        "expected_field_names": sorted(EXPECTED_FIELD_NAMES),
        "irregular_field_names": sorted(IRREGULAR_FIELD_NAMES),
    }


def target_bytes_from_env(default: int = TARGET_BYTES_DEFAULT) -> int:
    raw = os.environ.get("SAMQL_PERF_NDJSON_TARGET_BYTES")
    if raw in (None, ""):
        return int(default)
    return max(0, int(raw))


def records_from_env(default: int = RECORD_COUNT_DEFAULT) -> int:
    raw = os.environ.get("SAMQL_PERF_NDJSON_RECORDS")
    if raw in (None, ""):
        return int(default)
    return max(1, int(raw))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-o", "--output",
                    help="destination .ndjson path (created/overwritten)")
    ap.add_argument("--records", type=int, default=None,
                    help="source NDJSON records (default %d or "
                         "SAMQL_PERF_NDJSON_RECORDS)" % RECORD_COUNT_DEFAULT)
    ap.add_argument("--target-bytes", type=int, default=None,
                    help="minimum file size in bytes (default %d or "
                         "SAMQL_PERF_NDJSON_TARGET_BYTES)"
                    % TARGET_BYTES_DEFAULT)
    ap.add_argument("--pad-len", type=int, default=None,
                    help="override computed per-record pad length")
    ap.add_argument("--print-math", action="store_true",
                    help="print fan-out math and exit (no write)")
    args = ap.parse_args(argv)

    records = (args.records if args.records is not None
               else records_from_env())
    target = (args.target_bytes if args.target_bytes is not None
              else target_bytes_from_env())
    math = fanout_math(records)
    if args.print_math:
        print(json.dumps(math, indent=2))
        return 0
    if not args.output:
        ap.error("-o/--output is required unless --print-math is set")

    stats = write_ndjson(
        args.output, records=records, target_bytes=target,
        pad_len=args.pad_len,
    )
    print(json.dumps(stats, indent=2))
    if stats["lines"] != stats["records"]:
        print("ERROR: line count mismatch", file=sys.stderr)
        return 1
    if stats["bytes"] < stats["target_bytes"]:
        print("ERROR: file smaller than target", file=sys.stderr)
        return 1
    if stats["exploded_leaf_rows"] != records * FANOUT_PER_RECORD:
        print("ERROR: fan-out math broken", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
