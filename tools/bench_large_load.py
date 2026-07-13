#!/usr/bin/env python3
"""Benchmark how a large file loads into DuckDB three ways, so you can pick the
best storage for memory + speed on YOUR data and hardware:

  memory   - CREATE TABLE ...            (in-memory DuckDB, spills under pressure)
  parquet  - stream to a Parquet cache, query via a read_parquet view
  duckdb   - CREATE TABLE ...            (in an on-disk .duckdb database)

Each strategy runs in its OWN process, so peak memory is measured in isolation.
All three use the same memory limit + temp dir as the app, and apply the same
top-level-JSON-array pre-pass, so the comparison is apples to apples.

    python tools/bench_large_load.py path/to/trades.json
    python tools/bench_large_load.py --run parquet path/to/trades.json   # one

Reports load time, a sample scan+aggregate query time, and peak RSS. Needs the
duckdb package; run it on the machine whose behaviour you care about.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

_BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")


def _peak_rss_mb():
    """Peak resident memory of this process, in MB (best effort)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD),
                            ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            h = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.psapi.GetProcessMemoryInfo(
                h, ctypes.byref(pmc), pmc.cb)
            return pmc.PeakWorkingSetSize / (1024 * 1024)
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak / 1024 if sys.platform != "darwin" else peak / (1024 * 1024)
    except Exception:
        return float("nan")


def _reader_and_limits(path):
    """A DuckDB reader expression for the file (applying the product's top-level
    JSON-array -> NDJSON pre-pass so all strategies are fair), plus the memory
    limit the app would use. Returns (reader_sql, mem_gb, tempfile_or_None)."""
    if _BACKEND not in sys.path:
        sys.path.insert(0, _BACKEND)
    mem_gb = 8
    try:
        from samql_core import engines as E
        mem_gb = E.DuckDBManager._mem_limit_gb()
    except Exception:
        E = None
    ext = os.path.splitext(path)[1].lower()
    fwd = path.replace("\\", "/").replace("'", "''")
    if ext in (".parquet", ".pq"):
        return f"read_parquet('{fwd}')", mem_gb, None
    if ext in (".json", ".ndjson", ".jsonl"):
        try:
            if E is not None and ext == ".json" and \
                    E._file_starts_with_array(path):
                nd = tempfile.mktemp(suffix=".ndjson")
                E._write_ndjson_from_stream(path, nd)
                ndf = nd.replace("\\", "/").replace("'", "''")
                return (f"read_json('{ndf}', format='newline_delimited')",
                        mem_gb, nd)
        except Exception:
            pass
        return f"read_json_auto('{fwd}')", mem_gb, None
    return f"read_csv_auto('{fwd}', sample_size=204800)", mem_gb, None


def _run(strategy, path):
    import duckdb
    reader, mem_gb, tmp = _reader_and_limits(path)
    work = tempfile.mkdtemp(prefix="bench_")
    spill = os.path.join(work, "spill").replace("\\", "/")
    os.makedirs(spill, exist_ok=True)
    t0 = time.perf_counter()
    if strategy == "duckdb":
        con = duckdb.connect(os.path.join(work, "bench.duckdb"))
    else:
        con = duckdb.connect(":memory:")
    for pragma in (f"SET memory_limit='{mem_gb}GB'",
                   f"SET temp_directory='{spill}'",
                   "SET preserve_insertion_order=false",
                   "SET enable_object_cache=true"):
        try:
            con.execute(pragma)
        except Exception:
            pass
    if strategy == "parquet":
        pq = os.path.join(work, "cache.parquet").replace("\\", "/")
        con.execute(f"COPY (SELECT * FROM {reader}) TO '{pq}' (FORMAT PARQUET)")
        con.execute(f"CREATE VIEW t AS SELECT * FROM read_parquet('{pq}')")
    else:
        con.execute(f"CREATE TABLE t AS SELECT * FROM {reader}")
    load_s = time.perf_counter() - t0

    cols = [r[0] for r in con.execute("SELECT * FROM t LIMIT 0").description]
    t1 = time.perf_counter()
    n = con.execute("SELECT COUNT(*) FROM t").fetchone()[0]
    if cols:  # touch a real column so it isn't a metadata-only count
        con.execute(f'SELECT COUNT(DISTINCT "{cols[0]}") FROM t').fetchone()
    query_s = time.perf_counter() - t1

    con.close()
    if tmp:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    import shutil
    shutil.rmtree(work, ignore_errors=True)
    return {"strategy": strategy, "rows": n, "cols": len(cols),
            "load_s": round(load_s, 3), "query_s": round(query_s, 3),
            "peak_rss_mb": round(_peak_rss_mb(), 1)}


def main(argv):
    if len(argv) >= 3 and argv[0] == "--run":
        print(json.dumps(_run(argv[1], argv[2])))
        return 0
    if not argv:
        print(__doc__)
        return 2
    path = argv[-1]
    if not os.path.isfile(path):
        print("No such file:", path)
        return 2
    print("File: %s  (%.1f MB)\n" % (path, os.path.getsize(path) / (1024 * 1024)))
    results = []
    for strat in ("memory", "parquet", "duckdb"):
        try:
            out = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "--run", strat,
                 path], capture_output=True, text=True, timeout=7200)
            line = (out.stdout.strip().splitlines() or [""])[-1]
            results.append(json.loads(line) if line.startswith("{")
                           else {"strategy": strat,
                                 "error": (out.stderr.strip()[-120:]
                                           or "no output")})
        except Exception as e:
            results.append({"strategy": strat, "error": str(e)[:120]})

    print("%-9s %14s %9s %9s %10s" %
          ("strategy", "rows", "load s", "query s", "peak MB"))
    for r in results:
        if "error" in r:
            print("%-9s  ERROR: %s" % (r["strategy"], r["error"]))
        else:
            print("%-9s %14s %9s %9s %10s" %
                  (r["strategy"], "{:,}".format(r["rows"]), r["load_s"],
                   r["query_s"], r["peak_rss_mb"]))
    print("\nLower peak MB = more memory-frugal; lower query s = faster repeat "
          "queries.\n'parquet' bounds memory across the whole lifecycle "
          "(ingest and queries).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
