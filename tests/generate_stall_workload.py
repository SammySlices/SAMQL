#!/usr/bin/env python3
r"""Generate stall-prone fixtures for the cancel / reclaim stress suite.

Produces (at test time only — never commit multi-GB binaries):

1. **Nested NDJSON** — reuses ``generate_hostile_nested_ndjson`` so load +
   shred/flatten can explode into a large relational fan-out (stall risk).
2. **Wide CSV seed** (optional) — many rows for chart / pivot aggregate work.

Fan-out contract (hostile nested defaults)::

    15 × 10 × 10 = 1_500 leaf rows / source record

Environment overrides (shared with the nested perf suite where noted):

* ``SAMQL_STALL_NDJSON_RECORDS`` — default 8 (self-test uses 2)
* ``SAMQL_STALL_NDJSON_TARGET_BYTES`` — default 4 MiB
* ``SAMQL_PERF_NDJSON_*`` — also honored when stall-specific vars are unset

Examples::

    python tests/generate_stall_workload.py -o tmp/stall.ndjson --self-test
    python tests/generate_stall_workload.py -o tmp/stall.ndjson --records 40
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Ensure sibling test modules import cleanly when run as a script.
_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from generate_hostile_nested_ndjson import (  # noqa: E402
    FANOUT_PER_RECORD,
    fanout_math,
    write_ndjson,
)

# Documented stall SQL used by stress_cancel_reclaim (recursive CTE).
# Self-test keeps the bound modest so cancel is measurable but CI-bounded.
STALL_CTE_SELF = (
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL "
    "SELECT x+1 FROM c WHERE x<8000000) "
    "SELECT COUNT(*) AS n FROM c"
)
STALL_CTE_FULL = (
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL "
    "SELECT x+1 FROM c WHERE x<80000000) "
    "SELECT COUNT(*) AS n FROM c"
)

RECORDS_DEFAULT = 8
TARGET_BYTES_DEFAULT = 4 * 1024 * 1024
RECORDS_SELF = 2
TARGET_BYTES_SELF = 1_000_000


def records_from_env(default: int = RECORDS_DEFAULT) -> int:
    for key in ("SAMQL_STALL_NDJSON_RECORDS", "SAMQL_PERF_NDJSON_RECORDS"):
        raw = os.environ.get(key)
        if raw not in (None, ""):
            return max(1, int(raw))
    return int(default)


def target_bytes_from_env(default: int = TARGET_BYTES_DEFAULT) -> int:
    for key in ("SAMQL_STALL_NDJSON_TARGET_BYTES",
                "SAMQL_PERF_NDJSON_TARGET_BYTES"):
        raw = os.environ.get(key)
        if raw not in (None, ""):
            return max(0, int(raw))
    return int(default)


def write_stall_ndjson(
    path: str | Path,
    *,
    records: int | None = None,
    target_bytes: int | None = None,
    self_test: bool = False,
) -> dict[str, Any]:
    """Stream a nested NDJSON fixture sized for stall / cancel tests."""
    if self_test:
        records = RECORDS_SELF if records is None else int(records)
        target_bytes = (TARGET_BYTES_SELF if target_bytes is None
                        else int(target_bytes))
    else:
        records = records_from_env() if records is None else int(records)
        target_bytes = (target_bytes_from_env() if target_bytes is None
                        else int(target_bytes))
    stats = write_ndjson(path, records=records, target_bytes=target_bytes)
    stats["mode"] = "self-test" if self_test else "performance"
    stats["stall_purpose"] = (
        "nested explode / shred fan-out to stress load+flatten cancel"
    )
    stats["expected_exploded_leaf_rows"] = int(records) * FANOUT_PER_RECORD
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-o", "--output", required=True,
                    help="destination .ndjson path")
    ap.add_argument("--records", type=int, default=None)
    ap.add_argument("--target-bytes", type=int, default=None)
    ap.add_argument("--self-test", action="store_true",
                    help="tiny fixture (2 records, ~1 MiB)")
    ap.add_argument("--print-math", action="store_true",
                    help="print fan-out math and exit")
    args = ap.parse_args(argv)

    records = (RECORDS_SELF if args.self_test
               else (args.records if args.records is not None
                     else records_from_env()))
    math = fanout_math(records)
    if args.print_math:
        print(json.dumps({
            **math,
            "stall_cte_self_bound": 8_000_000,
            "stall_cte_full_bound": 80_000_000,
            "fanout_per_record": FANOUT_PER_RECORD,
        }, indent=2))
        return 0

    stats = write_stall_ndjson(
        args.output,
        records=args.records,
        target_bytes=args.target_bytes,
        self_test=args.self_test,
    )
    print(json.dumps(stats, indent=2))
    if stats["exploded_leaf_rows"] != stats["expected_exploded_leaf_rows"]:
        print("ERROR: fan-out math broken", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
