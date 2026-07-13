# SamQL refactor sequence — phase 2 shared utilities

**Build:** 2026-07-11.584  
**Version:** 2.15.95

Phase 2 removes small but high-risk duplicates without changing SamQL's public
HTTP, component, storage, or test-runner interfaces.

## Consolidated utilities

### Atomic JSON persistence

`backend/samql_core/stores.py` now exposes `atomic_write_json(path, value)`.
Config, history/saved-query, workflow, and load-manifest stores all delegate to
it. The helper writes a uniquely named temp beside the destination, flushes and
fsyncs it, uses the existing Windows sharing-violation retry ladder, and removes
the temp on every failure. A failed save returns `False` and leaves the previous
valid file byte-for-byte intact.

### Named profile envelope

`frontend/src/lib/namedProfiles.ts` owns malformed JSON recovery, legacy bare
profile maps, blank-name filtering, last-profile metadata, and serialization.
`apiProfiles.ts` and `sqlProfiles.ts` retain only their domain coercion rules.
The persisted JSON shape remains `{ profiles, lastProfile }`.

### Canonical load multipart builder

`frontend/src/lib/loadForm.ts` builds the multipart payload for both
`loadFiles` and `loadFilesStart`. Destination, delimiter, sheet, header row,
mode, exclusions, flatten, shred, root-id, and file ordering now have one
implementation.

### Pointer drag lifecycle

`frontend/src/lib/pointerDrag.ts` owns temporary pointermove, pointerup, and
pointercancel listeners, guarantees cleanup, and prevents duplicate finish
callbacks. It is used by App splitters, DataGrid resize, Journal card resize
and reorder, Pivot resize, and local NodeFlow resize paths. NodeFlow's mounted
canvas gesture effect remains separate because it is a long-lived listener,
not a one-shot drag.

### Reconcile detail payloads

`frontend/src/lib/reconcileRequest.ts` builds drilldown/profile requests for
both the IDE and Journal. It carries keys, balance, and both column maps and
copies mutable maps/arrays so later UI edits cannot mutate an in-flight request.

## Validation

- Atomic writer success/failure rollback and temp cleanup: passed.
- Existing corrupt-persistence quarantine/recovery regression: passed.
- New shared-utility component tests: 4 passed.
- Full React component suite: 42 passed.
- TypeScript: passed.
- ESLint with zero warnings: passed.
- Production Vite build: passed.
- Existing frontend source contracts through the component rail: passed.

No product feature behavior or serialized storage format was intentionally
changed in this phase.
