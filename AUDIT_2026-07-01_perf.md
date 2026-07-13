# SamQL performance, lockdown & cancel audit — 2026-07-01 (v2.10.89 / build .360)

Scope requested: query performance, loading performance, flatten performance,
node running performance, journal query performance, memory optimizations,
UI-lockdown areas, cancel capabilities. Line references are against build .360.
Severity: HIGH = user-visible slowness/freeze on the current workload,
MED = measurable cost or risk, LOW = note/OK.

Method note: everything below is from code inspection plus the unit suite;
none of it was profiled against the real 1.7 GB file (no DuckDB in the dev
sandbox), so the rankings are engineering judgement, not measurements.

---

## 1. Query performance

**F1 — MED — Every DuckDB result pays a `row_number() OVER ()` window.**
`session._exec_duckdb_parquet` materializes results as
`COPY (SELECT row_number() OVER () AS __rn, * FROM (inner) LIMIT cap+1) TO parquet`.
The window function forces a full sequence over the result before writing, and
serializes what could otherwise be a parallel COPY. On multi-million-row
results (a leg explode) this can rival the query itself.
*Recommendation:* drop `__rn` from the COPY and derive the row number at page
time with `read_parquet(..., file_row_number = 1)` — same stable paging order,
no window over the full result. Contained change (store + page + sort paths);
needs a careful round on the paging/sort/filter tests.

**F2 — HIGH (config, not code) — One write lock serializes the world.**
A DuckDB read/build/load holds `write_lock` for its full duration (by design;
the .349 row cap bounds the worst case). Everything routed through
`engine.execute()` queues behind it, and `_DeadlineRLock` turns >30 s waits
into `EngineBusy` errors (engines.py:44). `SAMQL_CONCURRENT_READS` moves
metadata reads onto separate cursors, but it **defaults OFF**
(engines.py:1218).
*Recommendation:* flip the default ON after a validation day on the real box
(the in-app toggle / env var makes the A/B trivial). All concurrent paths
already fall back to the locked read on failure, so the risk is low.

**F3 — LOW — Paging is already off the lock.** Result pages read the
per-result `qr_*.parquet` store, not the live engine, so scrolling a result
never queues behind a build. Display volume is bounded (DISPLAY_LIMIT, .342).

## 2. Loading performance

**F4 — LOW — The fast path is right; the slow path is loud.** JSON loads use
DuckDB `read_json` (with `maximum_object_size=1GB`); the deep-flatten fast
path falls back to nested `read_json` only on bind failures and prints an
explicit "this is slow" warning (loaders.py:619–629). NDJSON pre-passes poll
cancellation on every read. Large text sources cache to `cache_*.parquet`.

**F5 — MED — A load blocks all engine reads while it runs** (same root as F2:
`CREATE TABLE AS` must hold the lock). With F2's flag ON, the panels stay live
during a load; the load itself can't be made concurrent.

## 3. Flatten performance

**F6 — LOW — Cancellable and heartbeat'd.** The flatten reader polls
cancellation *within* a single huge value and stamps heartbeats
(flatten.py:379–550), so Stop lands mid-record and the watchdog never
misreads it as a stall. The explode plan itself is SQL (fast path); the
python fallback is the same warned path as F4. Spill lives under the
per-instance temp dir (lifecycle-cleaned, .350/.352).

## 4. Node running performance

**F7 — LOW — Incremental node cache works in your favor.** A node's
materialized output is reused across runs when its inputs are unchanged
(session.py:479), and multi-output exports share one materialization pass
(session.py:2176). Iterator/while loops report per-pass progress
(`opreg.advance`) and check a cooperative cancel flag between passes, so a
scoped card cancel stops a loop without the global engine hammer.

## 5. Journal query performance

**F8 — HIGH — Chained cells re-execute their upstream every run.**
Chaining inlines referenced cells as CTEs (`composeChainedSql`), so running
`cell3` re-runs `cell1` and `cell2` inside DuckDB even when both already have
fresh parquet result stores; a Run-all on a chain does O(sum-of-prefixes)
work. On heavy swap queries this is the single biggest avoidable cost in the
app. The group-output alias (.357) inherits the same behavior.
*Recommendation:* when a referenced cell `ranOnce` and is **not stale**,
rewrite its reference to `read_parquet('<its result store>')` instead of
inlining its SQL (fall back to the CTE inline otherwise, e.g. after eviction).
Result stores already persist per cell, so this is plumbing, not new
infrastructure. Highest-value follow-up in this audit.

**F9 — LOW — Everything around the run is already cheap.** Compiled SQL and
the dependency graph recompute on a debounced signature, not per keystroke;
staleness is a string compare; Run-all streams progress and honors Stop
between cells.

## 6. Memory optimizations

**F10 — LOW — DuckDB is fenced.** Auto-sized `memory_limit` (env override
`SAMQL_DUCKDB_MEMORY_GB`), spill directed to the per-instance temp dir,
threads sized to the box, `preserve_insertion_order=false`
(engines.py:1313–1327). SQLite runs tuned PRAGMAs. Results live on disk as
parquet with discard endpoints + LRU; "Free unused memory" exists; the memory
probe never blocks the engine (.353).
*Recommendation (nice-to-have):* surface memory-limit/threads in Settings so
tuning doesn't require env vars.

## 7. UI areas that lock down

Already fixed this cycle: `/api/status` is lock-free; the memory probe is
non-blocking and the popover caches its last snapshot (.353); the Journal
stays mounted across tab switches (.347); capped results toast (.349).

**F11 — fixed in this build — schema reads.** The tables tree and the field
explorer read `DESCRIBE` + `typeof()` through `_column_types_raw`; until now
those queued behind a build unless the concurrency flag was on. As of .360
they try a separate cursor **unconditionally** (TEMP tables and failures fall
back to the locked read), so expanding a column mid-build no longer hangs.

**F12 — MED — Row counts still queue when the flag is off.** The tables
panel's counts go through `engine.read()`, which is concurrent only with F2's
flag ON. Covered by the F2 recommendation rather than a special case.

## 8. Cancel capabilities (inventory)

Working today: per-query cancel by id + **cancel-all**; per-operation ✕ in the
status popover (anything registered cancellable in the progress registry);
background **load** job cancel; **flatten** job cancel; scoped per-card cancel
for node loops (cooperative flag, no global hammer); Journal **Stop**
(aborts client requests + cancels run ids); **Reset server** (frees the
browser pool first via abortInflight, then rebuilds engines from the
manifest); `engine.interrupt()` is lock-free so a cancel reaches a busy engine
without queueing; the stall watchdog logs anything that stops heartbeating.
Restore is uncancellable **by design**. A cancelled COPY's partial `qr_*`
file is reclaimed by the temp lifecycle (.350/.352).

**G1 — LOW — no gaps found that strand work unreachable.** The historical
wedge (lock held + pool exhausted so cancel can't get through) is closed by
the combination of the .349 cap, .353 pool fix, and lock-free interrupt.

---

## Ranked follow-ups — ALL SHIPPED in build .361 (v2.10.90)

1. **R1 (F8) — DONE:** chained cells send a reduced SQL + a reuse map; the
   server stands up TEMP VIEWs over fresh upstream parquet stores (capped or
   evicted results bounce as `reuse_stale` and the client falls back to full
   CTE inlining once). Staleness still keys off the canonical composition.
2. **R2 (F2/F12) — DONE:** `SAMQL_CONCURRENT_READS` now defaults ON
   (`SAMQL_CONCURRENT_READS=0` restores full serialization).
3. **R3 (F1) — DONE:** the result COPY no longer pays a `row_number()`
   window; the store synthesizes a 1-based `__rn` at read time from
   `file_row_number`, and the COPY is keepalive-guarded (heartbeats + cancel
   nudges) like every other long native statement.
4. **R4 (F10) — DONE:** Settings → "Engine tuning (memory / threads)…"
   applies `SET memory_limit` / `SET threads` live (non-blocking: a busy
   engine says so instead of queueing); `SAMQL_DUCKDB_MEMORY_GB` persists.

Shipped earlier (.360): F11 (unconditional separate-cursor schema reads) and
Esc-to-close on the field explorer.
