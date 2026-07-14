#!/usr/bin/env python3
"""Reproduce / profile flatten-off large JSON load stalls.

Forces the same routing a ~1.8 GiB nested file would take (NDJSON rewrite +
Parquet cache + maximum_depth=2) by lowering size thresholds via env vars.

  python tools/repro_json_load_stall.py [path ...]
  python tools/repro_json_load_stall.py --gen   # generate samples first
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import traceback


def _setup_env():
    # Hit rewrite + on-disk Parquet even on ~48 MiB samples.
    os.environ.setdefault("SAMQL_JSON_STREAM_MB", "1")
    os.environ.setdefault("SAMQL_JSON_ONDISK_MB", "1")
    os.environ.setdefault("SAMQL_ONDISK_MB", "1")
    os.environ.setdefault("SAMQL_ONDISK_HARD_MB", "1")
    # Keep filecache out of the way for timing.
    os.environ.setdefault("SAMQL_FILECACHE", "0")


def _time_call(label, fn):
    t0 = time.perf_counter()
    try:
        out = fn()
        dt = time.perf_counter() - t0
        print("  OK  %-40s  %.2fs" % (label, dt))
        return out, dt, None
    except Exception as e:
        dt = time.perf_counter() - t0
        print("  FAIL %-40s  %.2fs  %s: %s" % (label, dt, type(e).__name__, e))
        traceback.print_exc()
        return None, dt, e


def probe_file(path: str):
    from samql_core.engines import (
        _sniff_json_format, _is_ndjson_path, _write_ndjson_from_stream,
        _json_shallow_depth_default,
    )
    from samql_core.session import Session
    from samql_core import tmputil
    import uuid

    size = os.path.getsize(path)
    print("\n==== %s (%.1f MiB) ====" % (path, size / (1024 * 1024)))
    fmt = _sniff_json_format(path)
    print("  sniff=%s  ndjson_ext=%s  shallow_depth=%s"
          % (fmt, _is_ndjson_path(path), _json_shallow_depth_default()))

    # Phase A: rewrite only (when applicable)
    if fmt != "ndjson" and not _is_ndjson_path(path):
        dst = tmputil.instance_path("probe_" + uuid.uuid4().hex + ".ndjson")

        def _rewrite():
            n = _write_ndjson_from_stream(path, dst)
            return n, os.path.getsize(dst)

        (info, dt, err) = _time_call("NDJSON rewrite", _rewrite)
        if info:
            print("       rewritten records=%s  out=%.1f MiB"
                  % (info[0], info[1] / (1024 * 1024)))
        try:
            os.unlink(dst)
        except OSError:
            pass
    else:
        print("  skip rewrite (native NDJSON path)")

    # Phase B: full Session.load_file flatten-off
    s = Session()
    s.flatten_on_load = False
    try:
        def _load():
            return s.load_file(path, destination="duckdb",
                               base_name="stall_probe",
                               flatten=False, shred=False)

        out, dt, err = _time_call("Session.load_file flatten=False", _load)
        if out:
            for t in out:
                print("       table=%s rows=%s cols=%s storage=%s depth=%s "
                      "shredded=%s method=%s"
                      % (t.get("name") or t.get("table"),
                         t.get("rows"),
                         (t.get("columns") or [])[:8],
                         t.get("storage"),
                         t.get("json_depth"),
                         t.get("shredded"),
                         t.get("method")))
    finally:
        s.shutdown()


def main():
    _setup_env()
    # Ensure backend imports resolve.
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, os.path.join(root, "backend"))

    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--gen", action="store_true")
    ap.add_argument("--target-mb", type=float, default=24.0)
    args = ap.parse_args()

    sample_dir = os.path.join(root, "tmp", "json_stall_samples")
    if args.gen or not args.paths:
        from gen_nested_json_stall_sample import main as gen_main
        sys.argv = ["gen", "--out-dir", sample_dir,
                    "--target-mb", str(args.target_mb)]
        gen_main()

    paths = args.paths or [
        os.path.join(sample_dir, n) for n in (
            "nested_array.json",
            "nested_concat_objs.json",
            "nested_concat_arrays.json",
            "nested.ndjson",
        )
    ]
    for p in paths:
        if not os.path.isfile(p):
            print("missing %s" % p)
            continue
        probe_file(p)
    return 0


if __name__ == "__main__":
    # Allow `from gen_nested_json_stall_sample import ...` when run as script
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
