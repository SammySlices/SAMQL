# SamQL refactor sequence — phase 4 (build .586)

## Scope

Phase 4 removes the duplicate paged-result state machines from the SQL IDE and
Journal. Both surfaces now delegate sorting, filters, lazy scrolling, result
restoration, expiry recovery, cancellation, and stale-response protection to
`frontend/src/lib/usePagedResult.ts`.

No backend endpoint, result-page payload, workspace format, Journal document,
or public component prop changed.

## Shared paging ownership

The shared controller owns:

- server-side first-page refresh for sorting and filters;
- synchronous view snapshots so rapid actions do not read stale React state;
- one generation per result for latest-request-wins behavior;
- an `AbortController` per page request;
- duplicate next-page suppression;
- offset and retained-row guards;
- stale append rejection when the result or view changed in flight;
- result-expiry reruns followed by reapplication of the requested view;
- inactive IDE result restoration and collapsed Journal result restoration;
- close, delete, notebook-switch, collapse, and unmount cleanup; and
- React StrictMode setup/cleanup replay.

The IDE keeps its existing filter UI and inactive-tab memory release. The
Journal keeps its existing retained-row ceiling and collapse behavior. Only the
request/lifecycle machinery moved.

## Result-expiry behavior

IDE result reruns and Journal cell reruns now return the replacement result id.
The paging controller uses that identity to fetch the requested sorted or
filtered first page from the regenerated result. This removes the former
surface mismatch where Journal attempted recovery but IDE could leave an
expired grid unchanged.

## Phase 5 preparation

Stable IDE and result-tab contracts moved from `App.tsx` to
`frontend/src/controllers/appTypes.ts`. The controller directory records the
next extraction boundaries:

- `useCatalogController`
- `useIdeController`
- `useResultController`
- `useWorkspaceController`
- `useBackgroundOperations`

`useResultController` is now the safest first Phase 5 extraction because the
result state type and paging state machine no longer live inside `App.tsx`.

## Tests and safety rails

Seven rendered hook regressions cover:

- two rapid filters resolving out of order;
- duplicate lazy-scroll requests;
- expiry rerun plus sort reapplication;
- a stale load-more response arriving after a sort;
- unmount cancellation;
- StrictMode effect replay; and
- the retained-row ceiling.

The frontend source contract additionally requires both App and Notebook to use
the shared controller, forbids the retired local request guards, verifies the
replacement-result-id recovery seam, and verifies the Phase 5 controller types.
The older Journal lifecycle contract was updated to follow the centralized
expiry implementation instead of requiring the literal error string inside
`Notebook.tsx`.

## Validation performed

- Shared paging component regressions: 7 passed, 0 failed.
- Full React component suite: 52 passed, 0 failed.
- Frontend source/behavior contracts through the component gate: passed.
- TypeScript type-check: passed.
- ESLint with zero warnings: passed.
- Production Vite build: passed.
- Playwright discovery: 12 tests across 7 files.
- Python compilation of the changed suite: passed.

The managed Microsoft Edge E2E run remains part of `Test-SamQL-All.ps1` and
must execute on the Windows validation machine.

## Next sequence item

Phase 5 extracts focused controllers from `App.tsx`, starting with the result
controller, then catalog, IDE, workspace, and background-operation ownership.
