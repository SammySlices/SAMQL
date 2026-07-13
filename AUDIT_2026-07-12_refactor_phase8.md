# SamQL Refactor Phase 8 Audit

Build: `2026-07-12.590`  
Version: `2.16.1`

## Goal

Move NodeFlow execution and document lifecycle state machines out of the React
composition shell while preserving workflow formats, backend request payloads,
incremental execution, dependency-journal optimization, projection pushdown,
and all existing node behavior.

## Implemented boundaries

- `useNodeFlowExecutionController.ts` owns run start/finish depth, Stop and
  stalled-cancel recovery, previews, chart hydration, validation, profiling,
  reconciliation, exports, table writes, directory/API reads, iterator/while
  execution, table creation, and Run all scheduling.
- Execution work is scoped to the active tab. A tab change increments the scope,
  aborts registered foreground requests, clears run-local caches, and prevents
  late results or toasts from mutating the newly selected canvas.
- `useNodeFlowDocumentController.ts` owns tab graph storage, per-tab undo/redo,
  autosave/restore and legacy migration, workflow save/load, file open/save,
  lineage export, and sidebar command routing.
- File-open requests use a monotonic sequence so an older response cannot open
  after a newer request has already completed.
- `NodeFlow.tsx` is reduced from 3,769 lines to 1,979 lines and now composes the
  execution/document controllers with the Phase 6 inspector and Phase 7 canvas
  modules.

## Compatibility

- No node type, port, default config, persisted graph/tab envelope, workflow
  envelope, or backend endpoint changed.
- Run all still uses backend multi-target execution, shared export
  materialization, and the existing three-worker terminal pool.
- Iterator/while accumulator names remain preserved on failed runs.
- Existing Playwright selectors, CSS classes, inspector props, and status-bar
  behavior remain present.

## Regression coverage

New rendered tests verify:

- a late preview result is discarded after a tab switch;
- concurrent requests keep the running rail active until the final request
  completes;
- out-of-order workflow-file responses open only the newest request.

The frontend source-contract suite also verifies controller ownership,
scope-aware cancellation, document persistence ownership, and the NodeFlow size
limit.

## Validation

- TypeScript (`tsc --noEmit`)
- ESLint with zero warnings
- Vite production build
- Vitest rendered/component suite
- SamQL frontend source, wiring, model, and architecture contracts
- Full backend/source-contract suite
- Full-source manifest reconstruction
- APHEX encode/decode byte-for-byte round trip

The Windows Microsoft Edge Playwright run remains the machine-specific final
browser gate through `Test-SamQL-All.ps1`.
