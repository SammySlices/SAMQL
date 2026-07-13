# SamQL workload benchmarks

`tests/benchmark_workloads.py` is the repeatable performance harness for the
operations that most affect interactive use: wide scans, fast previews,
projection-heavy NodeFlow flows, warm flow-cache reuse, and period-change
analytics.

Run a small correctness smoke test:

```powershell
python tests\benchmark_workloads.py --self-test
```

Run a useful local comparison on both engines:

```powershell
python tests\benchmark_workloads.py --engine both --rows 250000 --iterations 3 --output benchmark.json
```

For a validation box with enough memory and disk, use a row count close to the
real workload and keep the JSON reports from consecutive builds:

```powershell
python tests\benchmark_workloads.py --engine duckdb --rows 1700000 --iterations 5 --output benchmark-build-560.json
```

The script deliberately does not fail on timing thresholds because hardware,
antivirus, and Citrix load vary. CI should run `--self-test`; release validation
should compare the generated medians, peak behavior, and cache statistics with a
known-good prior build.

## Benchmark an actual large file

Point the harness at the real source file to measure the loader and execution
path you actually use:

```powershell
python tests\benchmark_workloads.py `
  --input "D:\data\trades.json" `
  --destination duckdb `
  --iterations 3 `
  --output benchmark-real-build-560.json
```

For Parquet or CSV, `--mode view` also measures the query-in-place path without
copying the source into a DuckDB table:

```powershell
python tests\benchmark_workloads.py --input trades.parquet --destination duckdb --mode view
```

When suitable date and numeric fields exist, include a real period-change run:

```powershell
python tests\benchmark_workloads.py `
  --input trades.parquet `
  --destination duckdb `
  --date-column business_date `
  --value-column market_value `
  --group-column account
```

Real-file reports include source bytes, load time, process/DuckDB memory before
and after loading, exact count time, bounded preview time, projected-flow time,
cold/warm aggregate-flow cache behavior, and optional period-change timing. No
source rows are written to the JSON report beyond the first preview row.
