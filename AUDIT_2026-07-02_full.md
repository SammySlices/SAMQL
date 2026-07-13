# SamQL Full Audit — 2026-07-02 (v2.11.1 / build .372)

Scope: querying, loading, nodes, performance, memory, server stability, UI.
Method: code-review pass with every suspicion verified in source; findings
ranked by (impact on the real workload: 1.7GB nested JSON, journal chains,
concurrent days) × effort. Verified-good items are listed too — knowing
what's already solid is half the audit.

## Verified good (no action)

- Port conflicts: `make_server` walks to a free port (`_find_free_port`).
- Manifest persistence: already atomic (`.tmp` + `replace`).
- Result stores: bounded by count, rows/bytes (in-memory), and disk GB
  (parquet) with reuse pins; eviction can't race a live chain run.
- Schema probes cached with write-site invalidation; concurrent reads
  bounded by the cursor semaphore; the exec chain is keepalive-guarded.
- Loads: filecache is atomic + AV-retry hardened; JSON flatten spills;
  cancel reaches mid-record; failed conversions leave nothing staged.
- Nodes: cycles rejected; missing inputs highlight the node; incremental
  cache; iterator batteries.

## Wave 1 — implemented in build .373

**A. Filtered paging recount (QUERY/PERF, impact M-H, effort S).**
`page()` with filters called `store.count_view(terms)` on EVERY page — a
full filtered COUNT over a multi-million-row parquet store per scroll step.
Results are immutable, so the count is now cached per canonical filter set
on the cached result (small FIFO); scrolling a filtered 10M-row grid pays
the count once.

**B. Multipart uploads fully buffered (MEMORY/STABILITY, impact H, effort:
guard S now, streaming L later).** The drag-drop upload path reads the whole
request body into RAM (`rfile.read(length)` → `parse_multipart(bytes)`): a
dropped 1.7GB file means a >1.7GB spike in the request thread. Wave 1 adds a
size guard (SAMQL_UPLOAD_MB, default 512) returning a friendly 413 that
points at the file-path loader (which streams and filecaches). The full fix
— a streaming multipart parser that spools file parts straight to temp — is
the top Wave-2 item.

**C. History entries store unbounded SQL (MEMORY, impact M, effort S).**
The 200-entry cap doesn't bound entry SIZE; a reuse-miss retry inlines whole
chains, so single entries could reach MBs. SQL is now stored truncated past
200k chars with an explicit marker.

**D. Shred results invisible in completion UX (UI, impact M, effort S).**
A load with the flatten toggle ON reported only the nested table's rows.
Load jobs now carry a note ("+N relational tables") surfaced in the
completion toast and the activity card.

## Wave 2 — recommended next (in rank order)

1. **Streaming multipart parser** (finishes B): boundary-scan the body in
   chunks, spool file parts to temp, never hold a file in RAM. Removes the
   size guard's ceiling for drop-loads.
2. **Relational family grouping in the sidebar** (UI): shred output
   (`trades`, `trades_receivingleg`, …) grouped under a caret on the root
   table, with the join keys shown on hover.
3. **"Insert join" helper** (UI/QUERY): context item on a shredded child
   that inserts `SELECT … FROM parent JOIN child USING (<shared keys>)`
   into the editor. The keys are recoverable from `_rid` + `*_ord` columns.
4. **Shred node** (NODES): a NodeFlow node wrapping shred_plan/shred_run so
   workflows can flatten as a step, not just at load time.
5. **Field-explorer search box** (UI): filter the tree; wide swap schemas
   are hundreds of fields.
6. **Excel loads buffer whole sheets** (MEMORY, niche until a giant xlsx
   shows up): stream per-sheet in row batches to the engine.
7. **Rotating debug log** (STABILITY/DX): today failures explain to stderr;
   a `samql.log` ring under the instance dir would make on-box triage
   one-file.
8. **EXPLAIN affordance** (QUERY/UI): a plan view for the current statement.

## Deferred / by-design

- Sorted deep-paging re-executes ORDER BY per page (DuckDB does the work;
  revisit only if on-box feel says so — R3 item).
- Drop-loaded temp files aren't restart-durable (the upload lives in the
  instance temp; the file-path loader is the durable route).
- SQLite JSON loads stay row-based (no nested types there; by design).
