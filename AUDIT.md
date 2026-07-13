# SamQL system wiring audit — build .227

Scope: every UI action's path from button → handler → `api` method → `/api`
route → backend `Api.<handler>` → session method, plus hang/stall risks and
cross-surface (IDE / Journal / NodeFlow) parity. The audit is now codified as a
test (`full wiring audit`) that runs every build, so these invariants stay
true.

## What was checked and the result

**1. Structural chain — HEALTHY.**
- 90 `api` methods, 81 endpoints in `api.ts`, 92 backend routes, 92 handlers.
- Every `api.X()` call across the whole UI resolves to a real method (0 calls
  to a non-existent method).
- Every `/api/...` endpoint the UI uses is served by a backend route (0
  missing).
- Every route points at a defined `Api.<handler>` (0 dangling routes).
- No handler is defined-but-unrouted.

**2. Buttons — no dead buttons.**
Every `<button>` across all 19 components wires a handler. The five the scan
first flagged were correct by design: three are drag-source palette tiles
(`onDragStart`, dragged onto the canvas, not clicked) and two are hover-submenu
headers (the enclosing row owns `onMouseEnter`). No no-op `onClick`, no
`TODO`/`FIXME`/"not implemented"/stub handlers anywhere.

**3. Types — handlers can't reference a missing function.**
The TypeScript gate (`tsc`) is the type authority; an `onClick` pointing at an
undefined name fails the build (TS2304). The baseline holds, so the "button
that silently does nothing because its handler is mis-named" class is covered.

**4. Hang / stall surface — bounded.**
- Both blocking `acquire()` calls in the engine layer go through the
  deadline lock: they wait at most `timeout` seconds, then raise `EngineBusy`
  rather than blocking forever. No `join()` / `Event.wait()` without a timeout.
- The streaming export that holds the DuckDB connection lock releases it in a
  `finally`, so a failed export can't wedge later DuckDB work.
- Backed by the recent hardening: the stall watchdog (observe-only stack
  dumps), the bounded DuckDB connect (`DUCKDB_CONNECT_TIMEOUT`), and the
  cancel/interrupt fix (.226) that stops a big DuckDB read mid-flight.

**5. Cross-surface parity (IDE / Journal / NodeFlow) — consistent.**
- Run + Stop/cancel: the IDE (App.tsx orchestrates SqlEditor), the Journal
  (Notebook), and the NodeFlow all run with a `query_id` and can be cancelled
  (abort the fetch + interrupt the backend), and a new launch supersedes the
  previous in-flight query.
- Fixed this round: **re-running a result tab** (`rerunResultTab`) previously
  ran its query with no `query_id` and no abort — uncancellable, and a stale
  one kept burning CPU after a new launch. It now uses the same Run/Stop
  machinery as every other run path.

## Known-legacy `api` methods (intentionally unused, documented in the test)

These backend capabilities have no UI caller because a newer path replaced them
or they're diagnostics. They are not broken buttons; they're recorded in the
audit test's allowlist so any *new* method falling out of use is flagged:

| method | why unused |
| --- | --- |
| `exportUrl` | result export goes through `downloadBlob` |
| `flattenExport` | superseded by the job-based `flattenStart` / `flattenProgress` |
| `loadFiles` | superseded by `loadFilesStart` (cancelable job) |
| `loadPath` | superseded by `loadStart` (cancelable job) |
| `runTests` | backend diagnostics; no UI by design |
| `secretStatus` | the UI tracks `secret_saved` on the node config instead |
| `transpileSql` | SQL dialect transpile isn't surfaced (`formatSql` is) |

## Ongoing protection

The `full wiring audit` test now fails the build if: a `api.X()` call has no
method, an `/api` endpoint has no route, a route has no handler, a *new* `api`
method goes unused (without being added to the allowlist with a reason), or a
`<button>` ships with no handler wired.
