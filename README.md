# SamQL

A local-first SQL and data-exploration workbench. Load CSV, JSON, or
Parquet files (or pull a REST endpoint), then query them with SQL, profile
columns, chart results, and export — all running on your own machine.

This is a port of the original tkinter desktop app to a **React frontend +
Python backend** architecture. The desktop GUI toolkit is gone; the UI now
runs in a browser (or an optional native window), and a small local HTTP
server does the data work.

---

## How it's built

- **Backend** — a single Python package (`samql_core`) plus a stdlib
  `http.server` (`server.py`). It has **no required third-party
  dependencies**: loading files, the SQLite engine, profiling, charting,
  and serving the UI all work on a bare Python interpreter. Optional
  libraries unlock extra speed and formats (see below).
- **Frontend** — React + TypeScript built with Vite. It has **no runtime
  dependencies beyond React itself**: the SQL editor, the virtualized data
  grid, and every chart are hand-written, so the bundle is tiny and the
  build is dependable.
- **Packaging** — PyInstaller bundles the backend and the built frontend
  into one executable. Optional libraries are folded in only if they're
  installed when you build.

```
samql/
├── backend/
│   ├── samql_core/      # GUI-free engine: loaders, SQL, profiling, charts…
│   ├── server.py        # stdlib HTTP server + static file serving + launcher
│   ├── samql.spec       # PyInstaller build spec
│   └── requirements.txt # optional dependencies (none are required)
├── frontend/
│   ├── src/             # React app (editor, grid, charts, sidebar…)
│   ├── index.html
│   └── package.json
├── Test-SamQL-All.ps1   # install every test dependency + run every suite
├── requirements-test.txt
├── build.sh             # one-shot build (macOS/Linux)
└── build.ps1            # one-shot build (Windows)
```

---

## Quick start (run from source)

You need **Python 3.10+**, **Node.js 20.19+**, and **npm 10+**.

```bash
# 1. Build the frontend once (creates frontend/dist)
cd frontend
npm ci
npm run build
cd ..

# 2. Start the server (serves the built UI and the API)
python backend/server.py
```

The server prints a local URL (default `http://127.0.0.1:8765`) and opens
it in a browser window -- Chrome if it can find it, then Edge, otherwise your
default browser. Use `--window` for a native pywebview window instead (when
`pywebview` is installed), or `--browser` to force your default browser.

Useful flags:

```bash
python backend/server.py --port 9000     # choose a port
python backend/server.py --no-browser     # serve headlessly
python backend/server.py --browser        # force the system browser
python backend/server.py --window         # force a native pywebview window
```

If you start the server **before** building the frontend, it still runs and
serves a placeholder page with build instructions; the API works regardless.

---

## Development workflow

Run the frontend dev server and the backend side by side. Vite proxies
`/api` to the Python server, so there's no CORS setup.

```bash
# terminal 1 — backend
python backend/server.py --no-browser

# terminal 2 — frontend with hot reload
cd frontend
npm run dev
```

Open the Vite URL it prints (usually `http://localhost:5173`).

Run the complete frontend correctness gate without starting the app:

```bash
cd frontend
npm ci
npm run check       # typecheck + zero-warning ESLint + production build
npm run test:e2e    # Playwright; uses installed Edge in Windows CI
```

The repository includes `.github/workflows/windows-browser.yml`. It runs the
release preflight, deterministic source-package regression, complete backend and
frontend gates, optimization/resource suites, and benchmark self-test before it
drives the real Python server through Microsoft Edge on `windows-latest`.
Failed browser runs retain traces and screenshots as workflow artifacts.

---

## Testing

### One command: install everything and run every suite (Windows)

From the reconstructed project root, run either canonical entry point:

```powershell
.\Test-SamQL-All.ps1
# or
.\Run-SamQLTests.ps1
```

With no scope switches, both commands run the same complete gate and include
Playwright. The runner prints the browser-test plan, lists the discovered E2E
tests before launch, refuses a zero-test false green, and prints a distinct
`PLAYWRIGHT UI TESTS PASSED` line after the real browser run.

The script creates an isolated `.samql-test-venv`, installs all Python test
dependencies (including DuckDB, PyArrow, SQLGlot, Excel/JSON acceleration,
pywebview and Windows capability packages), and runs a locked `npm ci` from the
portable lockfile through an isolated `.samql-npm-cache`. An `EINTEGRITY`
failure clears only that isolated cache and partial `node_modules`, retries the
same lockfile, and can fall back once from a corrupt corporate mirror to the
public npm registry without disabling checksum validation. Use `-NpmRegistry`
(or `SAMQL_NPM_REGISTRY`) to pin a specific registry. On Windows it drives the
already-installed Microsoft Edge channel by
default, so managed machines do not need to download Playwright Chromium. The
script then executes the complete backend, live HTTP, frontend contract,
TypeScript, zero-warning ESLint, production build, dual-engine optimization,
adaptive DuckDB/cache budgets, parallel NodeFlow branches, restart-persistent
intermediates, benchmark and real-browser suites. npm audit remains enforced
when the configured registry supports its audit endpoint; corporate registries
that return ENOAUDIT/400 are reported as an explicit environment warning. The
two public-network tests run by default. Use `-SkipOnline` on a restricted
network, `-SkipBrowser` only when browser automation is blocked, `-SkipInstall`
to reuse an existing dependency environment, and `-Clean` to rebuild both.

### Phase 10 release preflight and complete source transports

`RELEASE_MANIFEST.json` pins the release identity, runtime floors, saved-data
compatibility versions, quality floors, and APHEX-1 settings. The stable release
commands are:

```bash
python tools/release_artifacts.py verify-tree --root .
python tools/release_artifacts.py package --root . --output-dir release
# Windows wrapper (defaults to .\release):
.\Pack-SamQL.ps1
```

The package command emits the complete decoded full-source bundle, the
mail-safe APHEX transport, and a hash receipt. It verifies manifest/section
parity and decodes APHEX again before publishing. The implementation modules
`tools/release_preflight.py` and `tools/package_release.py` remain directly
usable for diagnostics. APHEX is reversible transport encoding, not
cryptographic encryption. See `RELEASE_CHECKLIST.md` and `ARCHITECTURE.md`.

### Individual/scoped test runner

The dependency-free Python runner exercises the backend and UI contract from
the terminal; optional tests execute whenever their dependencies are installed.
These are intentionally partial commands and do not include Playwright:

```bash
python tests/run_tests.py          # everything
# or use the wrappers:
./tests/run_tests.sh               # macOS / Linux
.\tests\run_tests.ps1              # Windows PowerShell
```

It runs three suites and prints a per-suite and total pass/fail/skip
summary (exit code is non-zero if anything fails). Projection-specific dual-
engine coverage is also available through
`python tests/test_optimizations_dual_engine.py`, and fast-preview/period-change
behavior through `python tests/test_preview_perioddelta.py`:

- **backend** — the headless engine in-process: loading, type inference,
  queries, paging/sorting, **server-side filtering** (including a spilled
  result), **query cancellation**, profiling, charts, pivots, table
  operations, **column type changes**, history, saved queries, CSV export,
  memory accounting, the temp-file lifecycle and the background cleanup
  janitor. Paging is covered for **keyset deep offsets on a spilled result**
  and **column projection**, and **reconcile** is checked for true counts,
  a field-level report with a balance column, **field mapping** that lines up
  differently-named columns (with drill-down through the mapping), composite
  keys with NULL-aware text compares, the keys-only report adding **no**
  materialized rows, empty buckets freeing at once, error paths, profiling
  across buckets, a large diff spilling to a temp store (not memory) with deep
  paging, and JSON tables, with the DuckDB path exercised when it's installed.
  JSON ingestion is covered hard: the streaming parser across
  shapes (array, NDJSON, single object, concatenated, a value that straddles
  a read buffer), streamed-vs-whole-file equivalence, **big integers beyond
  64-bit, decimals, `NaN`/`Infinity`, BOM, deep nesting and unicode**, and
  the value-level revert-to-text fallback.
- **http** — starts the real server and replays the exact API calls the UI
  makes for each user flow (load → tables → query → page → filter → export →
  profile → chart → pivot → rename → drop → clear → history → saved → SQL
  tools → memory), plus the cancel route, a big-integer JSON load, column
  projection on a page, and a reconcile request.
- **frontend** — the UI ↔ backend endpoint contract (every `/api/…`
  endpoint the React client references must be served by the backend), an
  encoding check, a component-structure check, a **feature-wiring check**
  (autocomplete schema, grid column menu, filtering, cancellation, session
  persistence, inactive-tab release, and the reconcile modal/report plus its
  field-mapping helpers, plus the **notebook** mode toggle and its cells, are
  all connected), a **lazy-scroll grid wiring**
  check, a stray-debug scan, and — when Node is present — a **reconcile
  field-mapping logic** test that transpiles `reconMapping.ts` with esbuild
  and asserts the lining-up rules (case/whitespace-insensitive, non-1:1,
  asymmetric renames, composite labels) and the mapping-CSV generate/parse
  round-trip under Node, and a **notebook cell-chaining** test that transpiles
  `notebook.ts` and asserts the `WITH`-clause composition (reference detection
  that ignores comments/strings/qualified columns, dependency ordering, and
  leading-`WITH` merge), plus — with the installed dependencies — a
  TypeScript type-check and (with `--build`) a production build.

Optional Python packages (DuckDB, sqlglot, pyodbc, …) and Node are **not**
required: tests that need a missing dependency are reported as `SKIP`, not
failures, so the suite is green on a bare checkout and exercises more as you
install things.

```bash
python tests/run_tests.py --backend-only   # backend + HTTP, no frontend
python tests/run_tests.py --frontend-only  # UI checks only
python tests/run_tests.py --no-http        # skip the live-server suite
python tests/run_tests.py --build          # also run the vite build
python tests/run_tests.py --online         # also run network tests
python tests/run_tests.py -v               # full tracebacks on failure
```

To run the type-check and build locally, install the frontend deps first
(`cd frontend && npm ci`).

---

## NodeFlow resources and restart reuse

NodeFlow can run independent DuckDB branches concurrently during a multi-target
Run all. Branches that share any upstream node remain in the same group so common
work is computed once; side-effecting or volatile nodes stay serial. The worker
ceiling adapts to current memory pressure and is configurable under **Settings →
NodeFlow cache**.

The same panel controls two complementary caches:

- an in-session, byte-and-entry-budgeted LRU of materialised intermediates;
- an optional restart-persistent Parquet cache for deterministic graphs backed
  by stable local files or folders.

Persistent keys include source identity plus distributed content samples, graph
configuration, required columns, engine and product/cache semantics. Arbitrary
SQL, API/network nodes, loops, file globs, writes, shreds, in-session-mutated
sources, random samples, and volatile or time-dependent DuckDB expressions are
never persisted. Adaptive mode shrinks budgets when RAM or temporary disk space
is scarce and stops persistent reuse entirely under critical disk pressure.

The visual workflow surface is now named **NodeFlow**. Existing
`samql-nodebook` workflow files and `samql.nodebook.*` browser state remain
compatible and migrate automatically to the new format and keys.

---

## Build a standalone executable

```bash
# macOS / Linux
./build.sh

# Windows (PowerShell)
.\build.ps1
```

Either script builds the frontend, installs the full optional dependency
manifest into the packaging Python, hard-verifies the load stack, and runs
PyInstaller. The **primary product** is **SamQL-AppWindow** as an onedir
folder (`dist/SamQL-AppWindow/`). On Windows the build writes two handoff
zips when the SQL assistant was staged: `SamQL-AppWindow.zip` (lean) and
`SamQL-AppWindow-Assistant.zip` (AppWindow + llama.cpp runtime). A console
`SamQL.exe` server sidecar is still built from the same shared payload but
is **not** the promoted browser-tab distribution artifact. See
[DISTRIBUTION.md](DISTRIBUTION.md).

Default SQL assistant packaging is **runtime-only** (llama.cpp
`llama-server` + DLLs under `assistant/runtime/`, **no GGUF**). Recipients
download a model later with `.\Fetch-SamQL-Assistant.ps1 -Model 4b|7b`.
Use `-AssistantPack lean` for offline/CI builds that must not fetch the
runtime, or `post` / `embed` to ship a full pack with a GGUF.

To build manually:

```bash
cd frontend && npm install && npm run build && cd ..
pip install -r requirements-optional.txt
pip install pyinstaller
# AppWindow onedir (matches build.ps1 / build.sh default):
SAMQL_ONEDIR=1 pyinstaller backend/samql.spec
# -> dist/SamQL-AppWindow/  (primary) and dist/SamQL (server sidecar)
```

Whatever optional libraries are installed in your Python environment at
build time get bundled automatically into **both** targets, so install those
first if you want DuckDB, Parquet, xlsx export, etc. baked in.

### Code signing (Windows, optional)

Unsigned executables are frequently blocked by corporate IT (SmartScreen /
AppLocker), so for distribution you'll usually want to sign the AppWindow
exe (and the server sidecar). `build.ps1` has an opt-in signing
step — off by default, so a plain `.\build.ps1` still produces unsigned
binaries:

```powershell
# certificate already in the Windows certificate store (by SHA-1 thumbprint)
.\build.ps1 -CertThumbprint 1A2B3C4D...

# certificate in a .pfx file
.\build.ps1 -CertPath .\codesign.pfx -CertPassword 'secret'
```

It finds `signtool.exe` from the installed Windows SDK, signs with SHA-256,
RFC-3161 timestamps the signature (so it stays valid past the certificate's
expiry, via `-TimestampUrl`, default DigiCert), and verifies the result. Use
`-NoSign` to force an unsigned build even when a cert is configured. Signing
needs a code-signing certificate (an EV/OV cert from a CA is what removes
SmartScreen prompts) and the Windows SDK's `signtool` on the build machine.

---

## Required acceleration

| Package  | Why |
| -------- | ---- |
| `orjson` | Fast JSON array→NDJSON rewrite and API payloads. Install with `pip install -r backend/requirements.txt` (also pulled in by `requirements-optional.txt` / distribution builds). |

## Optional capabilities

Everything below is optional. Install with `pip install <name>`; the app
detects each at runtime and shows its status in the top bar.

| Package      | Unlocks                                                      |
| ------------ | ----------------------------------------------------------- |
| `duckdb`     | **Default engine when installed** — fast analytical queries and native CSV/JSON/Parquet reading; needed for large (multi-GB) datasets |
| `pyarrow`    | Parquet read/write and Parquet export                       |
| `pandas`     | Python node: input table as a DataFrame (`df`) and DataFrame `out` (bundled in distribution builds) |
| `sqlglot`    | SQL formatting and cross-dialect transpilation              |
| `openpyxl`   | Excel (`.xlsx`) export                                       |
| `ijson`      | Streaming parser for very large JSON arrays (lower memory)  |
| `pyodbc`     | Connect to Microsoft SQL Server                             |
| `pywebview`  | Open SamQL in a native desktop window instead of a browser  |
| `pywin32`    | Windows auth / impersonation for SQL Server (Windows only)  |

---

## Working with large files

For multi-gigabyte files (millions of rows), do two things:

1. **Install DuckDB:** `pip install duckdb` (and `pip install pyarrow` if
   you use Parquet). DuckDB becomes the default engine automatically — it
   reads CSV/JSON/Parquet natively in C++, multithreaded, and spills to disk
   when a dataset exceeds memory, so 9-million-row files load and query
   smoothly. Without DuckDB, SamQL falls back to SQLite, which ingests rows
   one at a time and is not suited to files this large.

2. **Pick the file with Browse.** In **Load data → From a file**, click
   **Browse…** and navigate to your file (or paste its full path), then
   Load. The backend reads it directly from disk — nothing is uploaded — and
   a progress bar shows how the load is going. This is the single
   file-loading path and works the same for small and very large files.

With DuckDB installed, a CSV loaded by path is materialized once into a
DuckDB table, after which all queries, sorting, profiling, and charts run
against DuckDB's fast columnar storage. The engine selector in the toolbar
defaults to DuckDB; each result is tagged with the engine that produced it.

**Load speed.** The progress dialog shows which engine is doing the work
(e.g. `bigfile.csv · duckdb`). DuckDB infers column types from a bounded
sample of the file rather than scanning the whole thing, so a multi-GB CSV
is read in roughly a single pass. On the SQLite fallback, SamQL loads each
table in one transaction with batched inserts, and it skips building
per-column indexes on very large tables (over ~2M rows) so the data is
usable immediately instead of waiting on a post-load indexing pass. If a big
load feels slow and the dialog says `· sqlite`, installing DuckDB is by far
the biggest speedup.

**Large JSON (SQLite path).** JSON is read as a *stream*, not loaded whole
into memory. Records are pulled one at a time — from a top-level array
(element by element), NDJSON/JSONL (line by line), a single object, or
concatenated values — and the flattener spills each table's row buffer to a
temp file once it grows past a threshold (~50k rows, lower in low-memory
mode). So a multi-hundred-megabyte JSON flattens into relational tables with
roughly constant memory instead of holding the parsed document plus all
flattened rows at once. If the optional `ijson` package is installed, array
streaming uses it (C-accelerated); otherwise a pure-stdlib incremental
parser is used. (Loading JSON into DuckDB instead keeps the nesting as
STRUCT/LIST columns via DuckDB's native reader — a different, non-flattened
shape; see the note on JSON shapes.) **Flatten on load** is **off by default**
(Storage & memory → Flatten JSON on load, or `POST /api/settings/flatten-json`);
turn it on only when you want nested JSON shredded into relational tables.

**Robust numbers and shapes.** JSON integers larger than 64-bit (e.g. long
account numbers) are preserved as exact text instead of crashing the load
the way they used to — SQLite can't bind a Python int beyond ±2⁶³, so it now
falls back to a lossless text value. High-precision decimals, scientific
notation, the non-standard `NaN`/`Infinity` literals, a UTF-8 BOM, deeply
nested objects, empty objects/arrays, nulls, unicode/emoji, duplicate keys
(last wins), and a bare top-level object or scalar are all handled.

**Type fallback (both engines).** When a column's type is inferred during a
load and a value doesn't fit it, the load doesn't fail — it falls back to
text. On the SQLite path this is value-level: a batch that can't bind under
the inferred type is rolled back and re-inserted with the offending values
coerced to text (the rest of the load continues coerced), so one odd value
never aborts the whole file. On DuckDB, the native CSV reader retries the
whole file as all-`VARCHAR` (skipping unparseable rows) if typed inference
fails, and the JSON reader retries tolerantly.

## Performance & memory

SamQL keeps large datasets off the Python heap and pushes heavy work down
into whichever engine holds the data.

**Repeatable workload benchmark.** `tests/benchmark_workloads.py` creates a
stable wide synthetic table or loads a real CSV/JSON/Parquet/XLSX file, then
records load, count, bounded preview, projection-heavy flows, period change,
and cold/warm NodeFlow timings as JSON. Start with
`python tests/benchmark_workloads.py --self-test`; see `BENCHMARKS.md` for
million-row and real-file examples. The report also captures SamQL/DuckDB
versions, memory snapshots, source size, and flow-cache telemetry so two builds
can be compared on the same box.

**Fast preview.** The SQL toolbar and every NodeFlow output provide a bounded
preview path. Preview wraps one read-only statement (or caps only the terminal
NodeFlow relation) at 5,000 rows by default, leaving reusable upstream
checkpoints complete. Preview results are marked in the UI and are never stored
as if they were complete flow-cache entries. Full Run remains unchanged.

**Queries and results.** A result that fits one display page is returned
directly. Larger results stay as a plain in-memory list up to a threshold
(50k rows, or 10k in low-memory mode); only genuinely large results spill
into an off-heap store. With DuckDB, a large result from a query that has no
explicit `ORDER BY` is spilled to a temporary **Parquet** file and paged
straight from it — columnar, compressed, with projection and LIMIT pushdown —
so the result never has to be converted into millions of Python objects or a
row-oriented temp database. (Queries with an `ORDER BY` keep an
order-preserving path.) Sorting and deep paging of a spilled result are
executed by the store, so paging to row 10,000,000 never drags the whole
result set through Python. For paging in insertion order, the SQLite-backed
store uses **keyset paging** — an index range scan on the row-id primary key
(`WHERE i >= ? … LIMIT n`) instead of `LIMIT/OFFSET`, so jumping deep into a
result is an index seek rather than an O(n) scan. Exporting a large result
streams it in a single linear pass (no OFFSET re-scans), so even
multi-million-row exports stay fast. Set `parquet_results: false` in the
config to disable the Parquet path.

**Lazy-scroll grid + column projection.** The grid loads the first page and
then fetches further chunks (1,000 rows at a time) as you scroll toward the
bottom, appending them — so the old 5,000-row display cap is gone and a
result is fully scrollable while resident memory grows only as far as you
scroll (and is reclaimed when the tab loses focus). The paging endpoint also
accepts an optional `columns` list, returning only those columns for a page;
that keeps the wire payload and the client's row objects small for very wide
results without affecting which rows match a sort or filter.

**Reconcile / compare.** Two loaded tables can be compared on key columns
to produce a **field-level reconciliation report**. Headline tiles give the
keys only in A, the keys only in B, the rows that fully match, the rows with
any difference, and the overall record count. Below that, one row per
compared field shows how many key-matched rows agree vs differ on that
field and — when a balance field is chosen — the summed balance of the
matching and non-matching rows. The whole report is computed as SQL
aggregates (a handful of `COUNT`/`SUM(CASE …)` queries) on whichever engine
holds both tables — DuckDB when available (its vectorized hash joins handle
large compares well), otherwise the local SQLite engine — so **no rows are
materialized** and it stays fast and memory-light even on very large inputs.
The underlying rows of any cell are fetched only on demand: right-click a
count to **drill down** (the bucket's rows are spilled to the normal on-disk
result store — a temporary Parquet file on DuckDB or a temporary SQLite
table on the local engine, so even a multi-million-row bucket stays
memory-bounded — and opened in a new result tab, paged lazily like any query
result) or to **profile** those rows in place (profiled as a subquery,
never materialized as a table). JSON files work too, since they flatten into
ordinary tables. Fields are compared as text and the balance is summed from
the left table, so results behave consistently across engines. When the two
tables name their columns differently, a **field mapping** lines them up: the
modal can **generate a mapping-file template** (a CSV of both sides' columns)
and **load a filled-in one**, and fields are matched case- and
whitespace-insensitively, so `FeedCode` vs `feedcode` or a stray trailing
space still line up. The mapping need not be one-to-one and either side may be
renamed independently (A can need no changes while B does, and vice versa);
unmatched columns are simply left out of the compare. Once a mapping loads,
the key / compare / balance pickers show the lined-up (canonical) fields, and
the report's field column shows both originals only when they differ
(`status (A: stat / B: state)`), bare otherwise. Rather than realizing the
mapping as database views (whose visibility across cursors is what broke
drill-down before), each side's real column is referenced **inline** in every
query, so the report, drill-down, and profile all resolve through the same
per-side columns with no extra DDL. The local
SQLite engine keeps its temporary b-trees (the `EXCEPT`/`JOIN`/sort
intermediates) on disk (`temp_store = FILE`), buffered by a large page
cache, so even a big SQLite-side compare stays memory-bounded; DuckDB still
gives the lowest memory and best speed on very large inputs.

**Charts, pivots and filtering — aggregation in the engine.** Charting or
pivoting a result aggregates in whatever engine backs it — SQLite for a
spilled result, DuckDB for a Parquet result, or the source table's own
engine — instead of pulling rows into Python. The `GROUP BY`, histogram
binning, scatter sampling and min/max all run as SQL, so only the small
aggregated series crosses back; charting a multi-million-row result takes
well under a second with no growth in Python memory (the same work done row
by row in Python took tens of seconds). Small in-memory results still take
a direct Python path, which produces identical output. Likewise, grid
**filtering** of a result is pushed into the engine: a spilled SQLite result
filters with a SQL `WHERE`, and a Parquet (DuckDB) result filters by reading
the Parquet with a `WHERE`, so neither drains the whole result through a
Python predicate. Category ordering for bar/line charts is deterministic
(by the x value, numerically when numeric), which also makes line charts
read correctly.

**Profiling.** The profiler computes every column's count, distinct count,
null count, min/max and mean/standard deviation in a *single* pass over the
table (plus one more pass for 3-sigma outliers), rather than several scans
per column. On a wide table that's the difference between a couple of scans
and many dozens. On very large tables (>5M rows) the per-column "top values"
are sampled to stay responsive; everything else stays exact.

**Memory.** DuckDB runs with a memory limit **sized to the machine** — a
fraction of detected physical RAM (about 50% on small boxes, ~60% mid-range,
up to ~65% on large ones, capped at 48 GB) — and spills to its temp directory
past it; its thread count is taken from the CPU count *without
over-subscribing* (and stays small in low-memory mode). RAM is detected on
Linux, macOS and Windows. The throwaway SQLite engine runs with
write-optimized pragmas (synchronous off; journal in memory, or off entirely
when disk-backed; a large page cache and memory-mapped I/O) — safe because
the database is rebuilt every run and never relied on for durability. Query
results live off the heap once they pass the in-memory threshold (in a temp
Parquet file for DuckDB, an on-disk SQLite store otherwise), and only one
page plus at most one cached sorted copy is ever resident. Cached results are
bounded both by count and by total resident rows, so many medium-sized
results can't pile up unbounded memory. The memory indicator (top-right)
shows live usage, and **Free unused memory** drops cached results and their
sorted copies and hands memory back to the OS without touching loaded tables.
On RAM-tight machines, set `low_memory_mode: true` in the config file
(`~/.json_csv_sql_explorer`): SQLite runs disk-backed, DuckDB takes a 1 GB
limit, and results spill sooner.

Set `duckdb_on_disk: true` to make DuckDB use a temporary on-disk database
even outside low-memory mode: its buffer manager then keeps only the working
set in RAM and spills cold table data to that file in DuckDB's own format
(carrying statistics, so it stays fast). Low-memory mode enables this
automatically. The temporary database is removed on exit.

**Housekeeping.** To stay lean over a long session, SamQL runs lightweight
background maintenance — a DuckDB checkpoint, a SQLite planner-stats refresh,
and a garbage-collection / memory-release pass — shortly after a table is
dropped and after queries finish. It's debounced and runs off-thread, so a
burst of queries triggers it once and it never slows a query. Dropping a
table also evicts any cached results that referenced it, and on a disk-backed
database a drop reclaims the freed space.

**Temporary files & cleanup across runs.** Everything SamQL writes to disk
during a session — the on-disk DuckDB database and its spill area, result
row stores, Parquet result temporaries and exports — lives under one
per-process directory, `…/Temp/samql/<pid>/`. A clean shutdown (Ctrl+C, a
SIGTERM/SIGHUP, or closing the console window) deletes that whole directory,
so nothing is left in temp. If the process is killed outright (e.g. the
terminal is force-closed before the server stops), its directory is left
behind — and the **next** `server.exe` start sweeps it away: at startup
SamQL removes the temp directories of any previous instances whose process
is no longer running. It never touches a directory belonging to a server
that is still running, so it's safe to run several instances at once.

**More speed & memory wins.** A few smaller optimizations keep things
quick and lean: sorting a large (spilled) result is pushed down to the
storage engine with an index on the sort column, so paging a sorted result
never re-sorts the whole set in Python; table profiles are cached and reused
until the table changes, so re-opening a profile is instant; JSON responses
are gzip-compressed on the wire when the browser supports it (result pages
and the app bundle shrink several-fold), and are encoded with `orjson` when
it's installed; and the editor cancels a still-running query when you launch
a new one, so a stale result can't land in the wrong tab.

**Choosing an engine for massive data.** For multi-GB files DuckDB is both
faster and far more memory-efficient than SQLite — compressed columnar
storage that spills to disk, versus SQLite's default of holding the table in
memory. DuckDB shines on filter/aggregate/join queries. One honest caveat:
`SELECT *` over a many-million-row table must convert all those rows from
columnar form into display rows, so browsing a giant table in full is the
slowest thing you can ask of either engine — filter or aggregate instead and
let the engine do the work.

---

## What works

Fully implemented end to end:

- **Loading** — pick a file with the built-in **file browser** (click
  Browse…), or paste a full path, for CSV / TSV / JSON / NDJSON / Parquet —
  with a live **progress bar** while it loads. Or fetch a REST API (optional
  basic auth and a JSON path to the records). The file is read directly by
  the local backend; nothing is uploaded. Nested JSON loaded via DuckDB can
  be flattened into related tables from the sidebar.
- **Tables sidebar** — browse tables and columns, filter, click to insert
  names into the editor. Right-click a table for a context menu: profile,
  rename, drop, and (for JSON files loaded via DuckDB) **Flatten JSON into
  tables**, which runs the relational flattener and loads the nested
  structure as related SQLite tables. Newly loaded tables appear
  automatically — no page refresh needed.
- **Memory indicator** — a live readout in the **top-right**, beside the
  feature pills, shows the process's current memory use (and DuckDB's, when
  available). Click or right-click it for a **Free unused memory** action
  that releases cached results and returns memory to the OS, leaving your
  loaded tables intact.
- **SQL editor** — syntax highlighting, line numbers, multiple query tabs.
  `Ctrl`/`Cmd`+`Enter` runs the whole editor (or the selection); `F5` runs
  the statement at the cursor.
- **Engine routing** — auto-route between SQLite and DuckDB, or pin an
  engine. Each result is tagged with the engine that ran it. Cross-engine
  conflicts and a read-only guard are reported clearly.
- **Results grid** — virtualized for large results, sticky header and row
  numbers, server-side sort by clicking a column, resizable columns.
- **Profiler** — per-column type, null and distinct ratios, min/max,
  mean/std, and most-common values.
- **Charts** — bar, line, area, pie/donut, scatter, histogram, treemap,
  tree, candlestick, multi-axis, **period-delta bars**, and **waterfalls**,
  aggregated server-side over the full result set (sum/avg/count/min/max).
- **Period-change analytics** — a NodeFlow node computes previous-period
  values, absolute or percentage change, and running totals with optional
  partitioning, ordering direction, and lag offset.
- **Export** — CSV, JSON, NDJSON, and (with the right libraries) xlsx and
  Parquet, honoring the current sort.
- **History & saved queries** — recent queries are logged; save queries
  with names and tags and reload them with a click.

Backend-complete with a lighter or scaffolded UI (the API endpoints exist
and are tested; the front-end surface is intentionally minimal and is a
natural place to extend):

- **Pivot tables** — `POST /api/pivot`.
- **Microsoft SQL Server** — driver discovery and connect endpoints
  (`/api/mssql/*`); requires `pyodbc`.

Not ported: the original's HDFS file browser.

---

## Where your data lives

SamQL keeps its config, query history, and saved queries in
`~/.json_csv_sql_explorer` — the same location the original app used, so an
existing setup carries over. Loaded tables live in an in-memory/temporary
SQLite database and are cleared when the server stops (or via **Clear** in
the top bar).

Everything runs locally. The server binds to `127.0.0.1` and nothing leaves
your machine unless you explicitly fetch a remote API or connect to a
database.

---

## Query and result tabs

The editor holds multiple **query tabs**, and each query gets its own
**result tab** below. The two stay in sync:

- Running a query opens a result tab bound to that query tab. Running a
  *second* query tab opens a second result tab, so several results stay open
  side by side.
- Re-running the same query tab — or editing its SQL and running again —
  updates that query's result tab in place rather than piling up duplicates.
- **Pin** a result (right-click the result tab → Pin) to freeze it as a
  snapshot. The query tab is then detached, so the next run opens a fresh
  result tab and the pinned one stops tracking it. **Unpin** to re-attach,
  and the next run updates that tab again.
- **Closing** a result tab discards the result from the server's memory and
  triggers a cache/disk reclaim, keeping things lean.
- Both query tabs and result tabs can be **dragged to reorder**.

Each result tab has its own **Grid / Chart** toggle, and profiling a table
(from the sidebar) opens as its own result tab too.

**Changing a column's type.** Right-click a column header in the results grid
to convert it to Text, Integer, or Decimal. The change is applied to the
underlying loaded table, the grid refreshes automatically to show it, and it
persists (so, for example, a numeric column then sorts numerically). This
works when the grid is showing a table directly (a single-table view such as
`SELECT * FROM table`); for joins or computed columns the menu explains that
type changes apply to a loaded table's own columns.

**Filtering rows (server-side).** The same column-header menu has a *Filter
rows* section: pick an operator (contains, equals, not equals, greater/less
than, starts/ends with, is null, is not null) and a value, then **Apply**.
Filtering runs in the engine (a `WHERE` against the result), not in the
browser, so it works on the full result set even when only the first page is
loaded. Filters from several columns combine (AND), the row count reflects the
filtered total, and an active-filter chip in the status row clears them all.
Sorting and paging operate within the filtered set.

**Schema-aware autocomplete.** As you type in the editor, a dropdown suggests
matching table names, column names, and SQL keywords drawn from whatever is
currently loaded. Typing `table.` suggests that table's columns. Use
Up/Down to move, Tab or Enter to accept, Esc to dismiss. Ctrl/Cmd+Enter and
F5 still run as usual.

**Cancelling a running query.** Re-running while a query is still in flight
cancels the previous one — the browser aborts the request *and* the server
interrupts the engine so it stops consuming CPU, rather than finishing a query
whose result you no longer want.

**Releasing inactive results.** Only the result tab you're viewing keeps its
rows resident in the browser; switching away drops the other tabs' row data
(their identity, sort, and filters are remembered) and switching back re-fetches
the first page from the server's cache. Total browser memory stays bounded by
the *active* tab rather than the number of open tabs.

**Session persistence.** Your open query tabs and their SQL, the active engine,
read-only toggle, and panel sizes are saved to the browser's local storage and
restored on reload. Result rows are intentionally not persisted — they live in
the server's memory and are cheap to re-run.

> **Not yet pushed down:** two larger items are deliberately deferred because
> they can't be exercised safely in the headless sandbox and need real
> browser/DuckDB testing: (1) infinite-scroll paging that would remove the
> 5,000-row display cap by streaming pages as you scroll, and (2) running
> chart/pivot aggregation as SQL against the result store instead of in
> Python. Both are designed for but not implemented in this round.

---

## Notebook mode

A toggle in the top bar (**IDE** / **Notebook**) switches the workspace
between the classic editor-plus-results layout and a **notebook**: an ordered
list of cells where a query and its result live together, read top to bottom.
It shares the same backend session, so tables you've loaded are available in
both modes, and the choice is remembered between visits.

- **SQL cells** — each is a full editor (the same syntax highlighting and
  schema autocomplete as the IDE), with its result rendered directly beneath:
  a lazy-scrolling grid that pages in more rows as you scroll, or a **chart**
  of the same result, plus **export** (CSV / JSON / xlsx). Run a cell with the
  green badge or ⌘/Ctrl+Enter; **Run all** runs every SQL cell top to bottom.
- **Note cells** — lightweight Markdown (headings, bullets, **bold**, `code`)
  for commentary between steps. Double-click to edit.
- **Cell chaining** — every SQL cell has a stable handle (`cell1`, `cell2`, …,
  shown in its header, click to copy). Reference an earlier cell by its handle
  to build a step onto its result — `SELECT … FROM cell1 …`. Chaining is done
  entirely on the front end by composing a `WITH` clause from the referenced
  cells (depth-first, so each CTE precedes the ones that use it) and running it
  as an ordinary query: no new endpoints, no temp views, nothing added to the
  sidebar. A cell may only reference cells above it, which keeps the graph
  acyclic. (The composed query recomputes referenced cells from their SQL, so
  results stay live with the underlying tables.)
- Cells can be added between any two cells, reordered, collapsed, and deleted.
  The cell list is persisted in the browser; results are recomputed on demand
  rather than stored.


Click **Exit** in the top bar to bring up a confirmation with three choices:

- **Exit, keep server running** — closes the view but leaves the local
  server running, so you can reopen SamQL instantly at the same address.
- **Exit & stop server** — calls the server's shutdown endpoint, which stops
  it gracefully and clears its temporary files.
- **Don't exit** — dismisses the dialog.

If you simply close the browser tab or hit reload, the browser shows its own
"Leave site?" confirmation first (so an accidental close can be cancelled).
That native prompt can't host custom buttons — browsers don't allow it — so
the in-app **Exit** button is the way to get the keep-server / stop-server
choice.

Desktop window behavior:

- **SamQL AppWindow** (the usual double-click launcher) leaves the local
  server running when you close the window so the next launch can reattach
  with the session intact. Use **Exit & stop server** (or Storage / Clean-SamQL)
  when you want a full teardown and temp reclaim.
- **`SamQL.exe --window`** (server owns the native window) stops the server
  and clears temp when the window closes — same process as Exit → stop.

---

## Keyboard shortcuts

| Shortcut                | Action                                  |
| ----------------------- | --------------------------------------- |
| `Ctrl`/`Cmd` + `Enter`  | Run the whole editor, or the selection  |
| `F5`                    | Run the statement at the cursor         |
| `Tab`                   | Indent (two spaces)                     |
| `Esc`                   | Close a dialog                          |

---

## Local API security

SamQL generates a random API capability each time the server starts. The
Python server embeds it in the HTML shell and the React client sends it as
`X-SamQL-Token` on every sensitive `/api` request. `/api/health` and the
low-risk `/api/focus` launcher action are the only exemptions. Host and Origin
validation also remain enabled. This is defense in depth against browser-based
request forgery; it is not an operating-system sandbox against another process
running as the same user.

For a script or another trusted client, start SamQL with a known value and send
the same header:

```text
SAMQL_API_TOKEN=your-private-value
X-SamQL-Token: your-private-value
```

Vite development uses the same explicit value on both sides: set
`SAMQL_API_TOKEN` for the Python server and `VITE_SAMQL_API_TOKEN` for Vite. If
the dev UI runs on another origin, add that exact origin to
`SAMQL_ALLOWED_ORIGINS`. Additional hostnames use `SAMQL_ALLOWED_HOSTS`.

Ordinary JSON request bodies are limited to 32 MB before buffering; configure
that with `SAMQL_JSON_BODY_MB` (`0` disables). Streamed multipart uploads use
`SAMQL_UPLOAD_MB` and default to 16 GB. `SAMQL_JSON_OBJECT_MB` controls DuckDB's
largest single-record JSON parser buffer (256 MiB by default; raise it only for
genuinely huge individual records, and only after giving DuckDB enough
`SAMQL_DUCKDB_MEMORY_GB` — the live engine budget also clamps the parser so a
tight adaptive floor cannot request a 512 MiB allocation it cannot satisfy).
Nested JSON loads prefer an on-disk Parquet cache from `SAMQL_JSON_ONDISK_MB`
(64 MiB by default) so materialising structs/lists does not fill RAM. All JSON
formats (array, NDJSON, concat, single object) are rewritten to NDJSON when
needed and COPY'd to Parquet for both flatten-on and flatten-off loads. A
single document at/above `SAMQL_JSON_STREAM_FLATTEN_MB` (default 256 MiB) uses
the Python streaming flattener with disk spill so multi-GB nested objects
still land. Flatten-off uses a shallow DuckDB `maximum_depth`
(default 2 via `SAMQL_JSON_MAX_DEPTH`; `0` = one JSON column per row) so deep
nesting stays queryable JSON instead of exploding into STRUCTs. Flatten-on
shreds the Parquet nested table into relational child tables. **Load preflight**
(`POST /api/load/preflight`) warns before large files; Parquet COPY aborts
mid-flight when temp disk is too low. DuckDB **concurrent reads** default ON
(`POST /api/settings/concurrent-reads` to toggle).
`SAMQL_JSON_STREAM_MB` (default 32 MiB) remains available for tuning the
array-stream pre-pass. The incremental NodeFlow cache uses both
an entry cap and `SAMQL_FLOW_CACHE_MB` (default 1024 MB). Cache accounting and
LRU policy live in `backend/samql_core/flowcache.py`; engine-specific size
estimation and table cleanup remain in `Session`.

**Settings → NodeFlow cache…** applies these limits live and shows entry/byte
usage, hit rate, misses, evictions, oversized/stale skips, and the largest
intermediates. Reducing a budget immediately trims oldest entries. Clear and
reset-counter actions do not require a server restart.

Saved workflows, Journal documents, NodeFlow graphs/tabs, and browser session
state carry explicit format versions. Older formats migrate sequentially; a raw
localStorage recovery copy is written to `<key>.pre-migration-backup` (plus a
timestamp key) before replacement. Files from a newer unsupported format are
rejected rather than guessed at.

### Profiling large NodeFlows

Node cards, committed wires, and the minimap are isolated rendering boundaries.
To inspect card re-renders on real hardware, open the browser console and run:

```js
window.__SAMQL_RENDER_DEBUG__ = true
```

Then drag or edit nodes and inspect `window.__samqlRenders`. Individual cards
appear as `NodeFlowNode:<id>`. During a drag, stationary card counters should
stay flat while the moved cards and geometry update.

---

## API reference (brief)

All endpoints are under `/api` and speak JSON. Except for health/focus, callers
must send the `X-SamQL-Token` capability described above.

```
GET    /api/health                     capabilities + version
GET    /api/tables                     loaded tables and columns
GET    /api/fs/list?path=              browse the server's local filesystem
POST   /api/load/start                 start a background file load
GET    /api/load/progress/{job}        poll load progress (for the bar)
POST   /api/load/path                  load a file by server path (sync)
POST   /api/load/files                 multipart upload (legacy)
POST   /api/api-fetch                  load from a REST endpoint
POST   /api/query                      run SQL  {sql, target, read_only, query_id}
POST   /api/query/{id}/cancel          interrupt an in-flight query by its query_id
POST   /api/result/{id}/page           page/sort/filter a cached result {offset, limit, sort_col, descending, filters}
POST   /api/result/{id}/export         download CSV/JSON/NDJSON/xlsx/parquet
DELETE /api/result/{id}                drop a cached result
POST   /api/table/{name}/profile       column profile
POST   /api/table/{name}/flatten       flatten a JSON table into related tables
POST   /api/table/rename | drop | change-type
GET    /api/memory                     current memory usage
POST   /api/memory/free                release cached results / trim memory
POST   /api/sql/format | transpile | statement-at
GET/POST/DELETE /api/saved             saved queries
GET/DELETE      /api/history           query history
POST   /api/chart/data                 server-side chart aggregation
POST   /api/pivot                      pivot table
POST   /api/reconcile                  field-level reconciliation report
POST   /api/reconcile/drilldown        materialize one bucket's rows -> result_id
POST   /api/reconcile/profile          profile one bucket's underlying rows
GET    /api/mssql/drivers              list ODBC drivers
POST   /api/mssql/connect              open a SQL Server connection
```

---

## Notes

- The grid displays up to 5,000 rows per result (matching the original's
  cap); sorting and aggregation run over the full result on the server.
- Optional native binaries (DuckDB, pyarrow) can make the packaged
  executable noticeably larger; leave them out for the smallest build.
