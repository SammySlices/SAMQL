#!/usr/bin/env python3
"""CLI for the JSON load profiler. Thin wrapper over samql_core.diagnostics --
the SAME code the app runs in Settings -> Diagnostics -- so the CLI and the UI
never drift.

    python tools/diag_load.py path/to/instruments.json
    python tools/diag_load.py path/to/instruments.json --max-records 30

Reads only the first --max-records top-level records (default 40) so it finishes
quickly even if the load is slow, and prints which reader is used, read vs
read+flatten vs the engine write, and a cProfile of the hot functions. If ijson
is much slower than the stdlib reader on your file it says so -- run the app with
SAMQL_JSON_READER=stdlib to skip ijson.
"""
import argparse
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "..", "backend"), os.path.join(_HERE, "..")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from samql_core.diagnostics import (profile_json_load, env_report,  # noqa: E402
                                    run_full_analysis)


def _print(res):
    print("file            : %s (%s MB)" % (res["path"], res["size_mb"]))
    print("first char      : %r  -> %s reader" % (res["first_char"], res["reader"]))
    f = res["features"]
    print("ijson/orjson    : %s / %s    duckdb/pyarrow: %s / %s"
          % (f["ijson"], f["orjson"], f["duckdb"], f["pyarrow"]))
    print("sampled records : %d" % res["sampled"])
    print("-" * 64)

    def rate(s, c):
        return c / s if s > 0 else 0.0
    print("A) read  (production/ijson)  %7.2fs  %5d recs  %8.1f rec/s"
          % (res["read_prod_s"], res["read_prod_n"],
             rate(res["read_prod_s"], res["read_prod_n"])))
    print("   read  (stdlib raw_decode) %7.2fs  %5d recs  %8.1f rec/s"
          % (res["read_stdlib_s"], res["read_stdlib_n"],
             rate(res["read_stdlib_s"], res["read_stdlib_n"])))
    if res.get("hint"):
        print("   >> " + res["hint"])
    print("B) read + flatten            %7.2fs  -> %d tables, %d rows"
          % (res["flatten_s"], len(res["tables"]), res["total_rows"]))
    print("   flatten only (B - A)      %7.2fs" % res["flatten_only_s"])
    print("C) per-table write (%d table%s):"
          % (res.get("table_count", len(res.get("per_table", []))),
             "" if res.get("table_count") == 1 else "s"))
    for t in res.get("per_table", []):
        if t.get("error"):
            print("     %-40s %8d rows %3d cols  WRITE FAILED: %s"
                  % (t["name"], t["rows"], t["cols"], t["error"]))
        else:
            print("     %-40s %8d rows %3d cols  %7.3fs  %10s rows/s"
                  % (t["name"], t["rows"], t["cols"], t.get("seconds") or 0,
                     ("%d" % t["rows_per_s"]) if t.get("rows_per_s") else "-"))
    w = res.get("write")
    if w and w.get("warm_seconds") is not None:
        print("   largest cold %.3fs / warm %.3fs (%s rows/s)%s"
              % (w.get("seconds") or 0, w["warm_seconds"],
                 w.get("warm_rows_per_s") or "-",
                 "  [cold-start]" if w.get("cold_start") else ""))
    print("-" * 64)
    print("cProfile of read+flatten (top by cumulative time):")
    print(res["profile"])


def main():
    ap = argparse.ArgumentParser(description="Diagnose flatten-on-load speed.")
    ap.add_argument("path", nargs="?", help="JSON file to profile")
    ap.add_argument("--max-records", type=int, default=40,
                    help="stop after this many top-level records")
    ap.add_argument("--offset", type=int, default=0,
                    help="skip this many records first (aim deeper in the file)")
    ap.add_argument("--full", action="store_true",
                    help="run the comprehensive full-load analysis (scans the "
                         "whole file, finds the heaviest record, projects the "
                         "load time, names the bottleneck)")
    ap.add_argument("--budget", type=int, default=45,
                    help="time budget in seconds for the --full whole-file scan")
    ap.add_argument("--env", action="store_true",
                    help="print the environment report and exit")
    args = ap.parse_args()
    if args.env or not args.path:
        info = env_report()
        for k, v in info.items():
            print("%-16s: %s" % (k, v))
        if not args.path:
            return
    if not os.path.exists(args.path):
        print("File not found: %s" % args.path)
        raise SystemExit(2)
    if args.full:
        _print_full(run_full_analysis(args.path, None,
                                      sample=args.max_records or 200,
                                      time_budget_s=args.budget))
        return
    _print(profile_json_load(args.path, args.max_records, offset=args.offset))


def _print_full(r):
    print("=" * 64)
    print("BOTTLENECK: %s" % r["bottleneck"])
    print(r["verdict"])
    pj = r["projection"]
    if pj.get("est_total_human"):
        print("Projected full load: %s for ~%s rows (flatten ~%ss + write ~%ss)"
              % (pj["est_total_human"], f"{pj['est_total_rows']:,}",
                 pj["est_flatten_s"], pj["est_write_s"]))
    print("=" * 64)
    f = r["file"]
    print("file       : %s (%s MB, %s reader)"
          % (f["path"], f["size_mb"], f["reader"]))
    sc = r["scan"]
    if sc.get("scan_error"):
        print("SCAN ERROR : %s" % sc["scan_error"])
    if sc.get("complete") is False:
        rd = sc.get("est_full_read_s")
        rd_h = ("%.0fs" % rd if (rd and rd < 90)
                else ("%.1f min" % (rd / 60.0) if rd else "unknown"))
        print("scan       : TIME-BOXED -- covered %s MB of %s MB (~%s MB/s); "
              "full read alone ~%s"
              % (sc.get("bytes_covered_mb"), f["size_mb"], sc.get("read_mbps"),
                 rd_h))
    print("scan       : %s%s records in %ss; biggest array %s; depth %s; "
          "~%s projected rows"
          % (f"{sc['records']:,}", "+" if sc.get("complete") is False else "",
             sc["scan_s"], f"{sc['max_array_len']:,}",
             sc["max_depth"], f"{sc['est_total_rows']:,}"))
    print("heaviest   :")
    for h in sc["heaviest"][:6]:
        print("    #%d  array %s  elements %s"
              % (h["record_index"], f"{h['max_array_len']:,}",
                 f"{h['elements']:,}"))
    rd = r["reader"]
    if rd.get("ratio"):
        print("reader     : ijson %ss vs stdlib %ss (%sx)"
              % (rd["ijson_s"], rd["stdlib_s"], rd["ratio"]))
    fl = r["flatten"]
    print("flatten    : %s rows in %ss (~%s/s); %s tables, up to %s cols"
          % (f"{fl['rows']:,}", fl["seconds"],
             f"{fl['rows_per_s']:,}" if fl.get("rows_per_s") else "-",
             fl["table_count"], fl["max_cols"]))
    w = r["write"]
    print("write (%s):" % w.get("engine"))
    for t in w["per_table"]:
        if t.get("error"):
            print("    %-36s %8d rows %3d cols  FAILED: %s"
                  % (t["name"], t["rows"], t["cols"], t["error"]))
        else:
            print("    %-36s %8d rows %3d cols  %7.3fs  %10s/s"
                  % (t["name"], t["rows"], t["cols"], t.get("seconds") or 0,
                     f"{t['rows_per_s']:,}" if t.get("rows_per_s") else "-"))
    hv = r.get("heavy_record")
    if hv:
        if hv.get("error"):
            print("heavy rec  : #%d FAILED: %s"
                  % (hv["record_index"], hv["error"]))
        else:
            print("heavy rec  : #%d -> %s rows in %ss (~%s/s)"
                  % (hv["record_index"], f"{hv['rows_produced']:,}",
                     hv["flatten_s"],
                     f"{hv['rows_per_s']:,}" if hv.get("rows_per_s") else "-"))


if __name__ == "__main__":
    main()
