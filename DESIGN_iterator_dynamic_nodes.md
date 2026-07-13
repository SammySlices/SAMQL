# Design: iterator + variables + dynamic file/API nodes (memory-first)

Goal: drive a sub-pipeline once per value (e.g. one API call per day), where a
**variable** flows into a **dynamic file browser** or **dynamic API** node, and
results land via an **Output** node that can overwrite or append. The hard
requirement is that large data never piles up in Python as it iterates.

This builds on what SamQL already has, not from scratch:
- `apiload.py` — HTTP+basic-auth fetch over stdlib `urllib`, URL building,
  scheme validation, a `max_bytes` cap, a `json_path` record selector, DuckDB
  native ingest, and a SQLite flattener that uses `add_table_streaming`.
- `rows.py` / `DiskBackedRows` — keeps big result sets off the Python heap in a
  throwaway on-disk SQLite table; ORDER BY pushed down.
- DuckDB runs on-disk (bounded memory, cold data spills); fetches are batched.
- the `group` node — a sub-pipeline container with per-step input bindings; the
  iterator is the same idea plus a driver.
- `sweep_stale()` + the audited temp-file lifecycle for cleanup.

---

## 1. The five pieces and how they interlock

1. **Variable node** — declares named variables (`region`, `as_of`) with default
   values. Downstream nodes reference them as `${region}` / `:region`. The
   iterator *overrides* them per pass. This is the keystone: the dynamic nodes
   and the iterator are all just "read a variable."
2. **Iterator node** — a group-style body + a driver. The driver produces a list
   of values (literal list, distinct values of an input column, or a generated
   date/number range); for each value it sets the loop variable and runs the
   body, appending each pass's output into one accumulator.
3. **Dynamic File Browser node** — a base directory + a path/glob *pattern* that
   contains variables (`/data/${region}/txns_${as_of}.csv`, or a glob
   `*_${as_of}.*`). Resolved per pass, it loads the matching file(s) through the
   engine's readers (read_csv/parquet) straight into a temp table. (The existing
   `input`/`directory` nodes are static; this is the variable-driven version.)
4. **Dynamic API node** — extends `apiload.py`. Config holds the base URL + an
   initial path and basic-auth creds; query params and the path may contain
   variables, and there's an option to take the **path from an input field**
   instead. Per pass it substitutes the variables, GETs, and streams the
   response into a temp table. Batch = the iterator driving `:as_of` across a
   date range, one GET per day.
5. **Output node (append/overwrite)** — a `mode: overwrite | append`. Overwrite
   replaces the target (DROP+CREATE table, or truncate the file); append adds to
   it (INSERT INTO, or append rows to the file). Streaming, never buffered.

Typical wiring:

```
[Variable: as_of] ─┐
                   ▼
[Iterator over date range 06-01..06-30, binds :as_of]
   └─ body: [Dynamic API GET /tx?date=${as_of}] → [jsonextract/explode] → [filter]
                                                              │
                                                              ▼
                                            [Output → table "tx", mode=append]
```

---

## 2. Execution & variable model

- A **run-scoped variable context** (a small dict) threads through nodeflow
  execution. The iterator mutates it per pass: `ctx["as_of"] = value`.
- **Substitution at compile time**: before a node's SQL/URL/path is built,
  `${var}` / `:var` are replaced from `ctx`, with the right escaping per target —
  SQL-quote for SQL, `urlencode` for API params, path-sanitise for file paths.
  (Never string-concat a variable into SQL without quoting.)
- The iterator runs the body **sequentially** by default (predictable memory and
  ordering; also kinder to APIs). Optional bounded concurrency later.
- Each pass's body output is appended to **one accumulator table**; the body's
  per-pass temp tables are dropped right after the append.

---

## 3. Memory architecture (the crux)

Principle: **data lives in the engine (on disk), Python only ever holds SQL,
config, and a ≤5000-row preview.** Concretely:

**(a) Stream API responses to a temp file — don't parse in Python.**
Today `fetch_json` does `raw = resp.read(max_bytes+1)` (whole body in memory)
then `_json_loads(text)` (parsed copy too), and the DuckDB path re-serialises
with `json.dump`. Replace with: read the socket in chunks (e.g. 256 KB) straight
into a temp `.json`/`.ndjson` file, enforcing the byte cap as you go. Then:
- **DuckDB**: `read_json_auto('<tmp>')` — the engine parses out-of-core; Python
  never holds the payload. If a `json_path` is set, navigate it in SQL
  (`json_extract` / `UNNEST`) rather than in Python.
- **SQLite**: stream-parse the temp file with `ijson` (already an optional dep)
  yielding one record at a time into the existing `add_table_streaming(...)`;
  fall back to `json.loads` (still under the byte cap) when ijson is absent.
This turns per-request peak memory from O(payload) into O(chunk + one record).

**(b) Iterate into one accumulator, not N results.**
Pass 1 does `CREATE TABLE acc AS SELECT …`; every later pass does
`INSERT INTO acc SELECT …` (or COPY). Memory and Python state stay flat no matter
how many days you iterate. Alternative for per-file output: each pass writes
`part_<value>.parquet` into a temp dir and the final read is
`read_parquet('<dir>/*.parquet')`, which DuckDB streams lazily.

**(c) Drop per-pass temps immediately.** Only `acc` survives across passes; the
body's intermediate temp tables are dropped after each append so N iterations
don't leave N× tables behind (hooks into `sweep_stale`).

**(d) Caps everywhere (hard stops):** max iterations (default ~100, ceiling
configurable), per-pass row LIMIT, max total rows, `max_bytes` per response,
request timeout, retry/backoff. A **continue-on-error** toggle lets a batch skip
a failed day and collect the failures into an error report rather than aborting.

**(e) Streaming output.** Append/overwrite stream from the source table to the
file/table in batches (`COPY TO`, or `fetchmany` loops) — never `fetchall`.

**(f) Cache correctness.** Iterator / API / file-browser outputs depend on
external state at run time, so they must not be served from the flow cache as if
pure. Mark these node types non-cacheable (or bump the data epoch on each run) so
you never get stale API/file data.

---

## 4. Security (basic auth — important for a bank)

- **Never persist credentials in the saved-workflow JSON.** Options, best first:
  store them in the OS keychain (the `keyring` optional dep) keyed by a
  credential-id that the node *does* save; or prompt for them at run time and
  keep them only in the run-scoped context. The node config stores a reference,
  not the secret.
- **Mask** creds in the UI, and **redact** them from every error message,
  preview, and log line (no Authorization header or URL userinfo in logs).
- **Path/URL from a field is data-driven** → keep the existing scheme check, add
  an optional host allow-list (guards against SSRF), and `urlencode` every
  substituted value. Keep the timeout.

---

## 5. Caps summary

| Limit | Why | Suggested default |
|---|---|---|
| max iterations | runaway loop | 100 (configurable ceiling) |
| per-pass row cap | one huge pass | none / opt-in LIMIT |
| max total rows | unbounded accumulator | warn at e.g. 5–10M |
| max response bytes | hostile/huge endpoint | 512 MB (already) |
| request timeout | hung endpoint | 60 s (already) |
| retries / backoff | transient API errors | 2 retries, expo backoff |
| continue-on-error | one bad day in a batch | on for batches |

---

## 6. Recommended build order (each shippable on its own, with tests)

1. **Variable node + substitution engine** — the foundation everything else uses.
   Adds the run-scoped context and `${var}`/`:var` resolution with per-target
   escaping. (Pairs with the parameterised-workflows idea.)
2. **Output overwrite/append** — small, independently useful, streaming write.
3. **Dynamic File Browser** — variable-driven glob → engine load (reuses the
   existing file readers).
4. **Dynamic API node** — the streaming-to-file refactor of `apiload.py` + a
   real graph node with dynamic params / path-from-field + per-pass append.
   (The streaming refactor is the bulk of the memory work and also benefits the
   existing "Load from API" action.)
5. **Iterator** — driver (list / distinct column / range) + group-style body +
   the accumulator pattern from §3(b). Best built last, once variables exist.

The dependency order matters: variables underpin the dynamic nodes and the
iterator, and the API streaming refactor (§3a) is the single most important
memory change — worth doing carefully and testing against a large fake payload.
