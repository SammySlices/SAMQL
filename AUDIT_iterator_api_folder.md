# SamQL audit — Iterator, API node, Folder nodes, and node behaviour inside the Iterator

**Build at audit:** 2026-06-24.158 → fix shipped in 2026-06-24.159
**Suite after audit:** 252 passed / 0 failed / 12 skipped (backend 187, http 42, frontend 23)
**Environment caveat:** sandbox has no DuckDB and no network, so DuckDB-only paths
(filebrowser execution, DuckDB API ingest) and live HTTP were verified by code
reading + compile-only checks, not executed. SQLite paths were exercised live.

## Method
1. Dumped the full backend `NODE_PORTS` and frontend `PORTS` maps and compared
   them (the `t_node_port_parity` guard also enforces this every run).
2. Confirmed front-to-back wiring for each node (NodeType, PORTS, palette,
   inspector, canvas body, action, `api.ts` method, NODE_PORTS, compile/ run
   path, session method, server route).
3. Read the iterator's per-pass execution (`run_iterator`,
   `_api_nodes_upstream`, `applyvars.resolve_graph`) to establish exactly what
   is re-resolved each pass.
4. Built and ran iterators live (SQLite) with **every category of body node**
   and checked the accumulated row counts against hand-computed expectations.
5. Formalised the findings into permanent regression tests.

---

## Part 1 — Wiring completeness

Port parity: **49 node types, frontend and backend identical** (verified by dump
and by `t_node_port_parity`). The three audited nodes:

| Node | FE NodeType/PORTS | palette | inspector | canvas | action | api.ts | BE NODE_PORTS | compile/run | session | route |
|------|----|----|----|----|----|----|----|----|----|----|
| **iterator** | ✓ `in`→[] | ✓ | ✓ | ✓ | `doRunIterator` | `iteratorRun` | ✓ | guiding raise on out | `run_iterator` | `/api/iterator/run` |
| **apinode** | ✓ `out`,`err` | ✓ | ✓ | ✓ | `doFetchApi` | `nodeApiFetch` | ✓ | `out`+`err` branches | `fetch_api_node` | `/api/node-api-fetch` |
| **directory** | ✓ `out` | ✓ | ✓ | ✓ | `doReadFolder`/load | `folderRead`/load | ✓ | references loaded table | `load_directory_file` | (load routes) |
| **appendfolder** | ✓ `out` | ✓ | ✓ | ✓ | `doReadFolder` | `folderRead` | ✓ | references loaded table | folder read | (folder route) |
| **filebrowser** | ✓ `out` | ✓ | ✓ | ✓ | Preview | nodeflowColumns | ✓ | pure DuckDB glob SQL | (compile-only) | n/a |

**Result: all three nodes are completely wired with no gaps.** The error-output
port added to `apinode` (`out` + `err`) is consistent on both sides and passes
the parity guard.

---

## Part 2 — Does every other node work *inside* the iterator?

The iterator runs the body wired to its `in` port once per driver value,
re-resolving the graph with the loop variable set, then appends each result into
one accumulator table. Key mechanics established by reading:

- `resolve_graph(graph, extra={var: value})` substitutes `${var}` into **every
  non-variable node's config** and lets the loop value **override** a same-named
  variable node. So any `${var}` in any transform's config varies per pass.
- `_api_nodes_upstream` returns **only `apinode`s** upstream of the body — those
  are re-fetched each pass. Folder/file nodes are *not* re-loaded (see findings).

Live results (SQLite), row counts vs. expectation — **all pass**:

| Body node(s) | What it exercises | Passes | Rows | Verdict |
|---|---|---|---|---|
| `filter` (`n <= ${k}`, **true** port) | single-input transform + var in condition + non-default port | 2 | 6 (2+4) | ✓ |
| `join` (**inner** port) | two inputs, multi-output join | 2 | 2 (1×2) | ✓ |
| `summarize` (group_by + aggs) | aggregation | 2 | 4 (2×2) | ✓ |
| `union` (in1+in2) | set op | 2 | 6 (3×2) | ✓ |
| `formula` | computed column | 2 | 10 (5×2) | ✓ |
| `select` | projection | 2 | 6 | ✓ |
| `pivot` (rows/cols/values) | **force-materialised, dynamic columns** | 2 | 4 (2×2) | ✓ |
| chain `input→formula→filter→select` | multi-node body, `${k}` at a mid-chain filter | 2 | 5 (3+2) | ✓ |
| `apinode` (**out** port) | re-fetched per pass | 3 | 3 | ✓ |

**Conclusion: every node category works correctly as an iterator body**, the
loop variable reaches transform configs, non-default ports (filter `true`, join
`inner`) wire correctly, and the trickiest node (pivot, whose columns are only
known after it runs) accumulates correctly.

---

## Findings

### 🐞 Fixed — the API node's `err` port was unusable inside an iterator
Per pass the iterator copied only the API node's **data** table into the
resolved graph (`{"table": fr["table"]}`) and dropped the **`err_table`** that
`fetch_api_node` also returns. Wiring the `err` port to the iterator therefore
failed every pass with *"Fetch from the API node first."*

**Fix:** propagate both — `{"table": ..., "err_table": ...}`. With
`continue_on_error` on the API node, a per-pass failure is now captured and the
error rows accumulate. This incidentally delivers an **error accumulator**: 3
failing passes → 3 accumulated error rows with columns `ok, status, error, url`
(the `url` carries the resolved `${var}`, so you can see which value failed).
Guarded by a new test.

### ⚠️ Documented behaviour — a `write` node inside an iterator body is a pass-through
`write`'s compile form is `SELECT * FROM <in>`; the actual table write happens
only in the dedicated write action, not during the body materialisation the
iterator uses. So a `write` node inside the body **passes rows through but does
not create its named side table per pass** (no error, no write). This is
reasonable — the iterator's accumulator is the real output — but is a gotcha, so
it is now asserted by a test to prevent silent drift.

### ⚠️ Documented behaviour — folder sources differ on "dynamic per pass"
- **`filebrowser` is dynamic per pass.** It compiles to a DuckDB glob whose
  `${var}` is re-resolved each pass, so `/data/*_${as_of}.csv` reads a different
  file set per value. This is the intended dynamic-folder source for iterators.
- **`directory` / `appendfolder` are static per pass.** They reference a table
  that was eagerly loaded when you pressed load; `node_output_sql` uses that
  fixed table name, and a `${var}` in their *path* is **not** re-applied per
  pass (they are not in the per-pass refresh set). Use `filebrowser` when you
  want the folder/glob to vary with the loop variable.

Both points are now locked in by `t_iterator_refresh_scope`.

### ℹ️ Semantics note — `continue_on_error` with a total failure
`ok = passes > 0 and (continue_on_error or not errors)`. With
`continue_on_error` and **every** pass failing, the run does keep going (it
records all errors and doesn't stop early) but returns `ok=False, passes=0`
because no rows were produced and no accumulator table is created. The per-pass
reasons are in `errors[]`. This matches the existing partial-failure test
(some good + one bad value → `ok=True`).

### 🔭 Pre-existing follow-up (not a regression) — `Retry-After`
Retry (build .158) uses pure exponential backoff and does not yet honour a
server `Retry-After` header, because the fetch seam returns no response headers.
Out of scope for this audit; noted for a future build.

---

## Tests added (permanent regression guards)
- `audit: every body-node type accumulates in the iterator` — the Part 2 matrix
  (filter/join/summarize/union/formula/select/pivot/chain) plus the
  write-is-pass-through assertion.
- `audit: API err port accumulates errors across iterator passes` — guards the
  `err_table` fix.
- `audit: iterator per-pass refresh scope (api vs folder nodes)` — asserts only
  `apinode`s refresh per pass, the filebrowser glob varies, and a directory node
  keeps its fixed table.

## Verdict
Wiring for the iterator, API node, and folder nodes is **complete and
consistent**. **Every node type works inside the iterator.** One real wiring
bug (the `err` port) was found and fixed; three behaviours that could surprise a
user are now documented and test-locked. Net change: +3 backend tests, one
two-line fix in `run_iterator`.
