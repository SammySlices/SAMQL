# SamQL refactor sequence — phase 5 (build .587)

## Scope

Phase 5 extracts the major application state machines from `frontend/src/App.tsx`
into focused, rendered-testable controllers. The refactor preserves API routes,
workspace and workflow file formats, component props, DOM/test hooks, query
semantics, cancellation behavior, and existing IDE/Journal/NodeFlow navigation.

`App.tsx` remains the orchestration and rendering shell. Query execution and
higher-level modal composition stay there for now because they coordinate more
than one controller; their state ownership no longer does.

## Controller ownership

### `useCatalogController`

Owns tables, history, saved queries, and workflow summaries. Every refresh has a
latest-response-wins sequence, including the delayed table retry, so a slower
older response cannot replace a newer catalog. SQL Server disconnect uses the
same catalog refresh and toast rail.

### `useIdeController`

Owns editor tabs, active-tab repair, editor references, SQL text changes,
undo/redo stacks, per-tab run/cancel state, query messages, target, read-only and
dialect settings, tab drag state, run flash, and active-tab underline geometry.
The controller exposes coherent refs for async run code while keeping UI state
reactive.

### `useResultController`

Owns result tabs, active-result recovery, result menus and filter drafts,
floating/docked comparison state, inactive-result row release, and the shared
`usePagedResult` state machine from Phase 4. Closing or changing result identity
cancels stale paging work through the common controller.

### `useWorkspaceController`

Owns IDE/Journal/NodeFlow view switching and refs, workflow names and file
commands, workflow save/open/delete routing, raw SQL versus Journal/NodeFlow
file-envelope dispatch, and cross-surface load requests. One router now decides
which workspace surface receives an opened workflow.

### `useBackgroundOperations`

Owns the cancellable background-operation registry and the load, folder, HDFS,
and optimize starters. Task completion, modal closure, catalog refresh, and
success/error messaging now share one tested hand-off rather than independent
App branches.

## Safety and compatibility

- Persisted editor, result, Journal, NodeFlow, and workflow shapes are unchanged.
- Existing API methods and endpoints are unchanged.
- Active editor/result IDs recover to a valid tab when saved state is stale.
- Run cancellation remains scoped to the active IDE tab.
- Catalog refreshes remain latest-response-wins.
- Inactive result rows are still released under the existing memory policy.
- Raw SQL files and typed workflow envelopes still route to the correct surface.
- Background loads still close the modal at start and report completion once.

`App.tsx` is reduced from roughly 4,964 lines before the controller sequence to
about 4,336 lines after Phase 5. The remaining size is now concentrated in
cross-controller query orchestration and presentation, not duplicated state
ownership.

## Tests and validation

Six rendered controller regressions cover:

- stale active-tab recovery and unique tab naming;
- cancellation of only the active tab's run;
- latest-response-wins catalog refresh;
- inactive result-row release;
- raw SQL and Journal-envelope file routing; and
- background load start/completion behavior.

The frontend architecture contract requires all five controllers to exist and
be composed by `App.tsx`, prevents the extracted state from drifting back into
the shell, and caps the shell size. Existing source and behavior contracts were
updated to follow ownership into the controllers rather than demanding obsolete
source placement.

Validation performed:

- New controller component regressions: 6 passed, 0 failed.
- Full React component suite: 58 passed, 0 failed.
- Frontend source/behavior suite: 111 passed, 0 failed, 1 build-only skip.
- TypeScript type-check: passed.
- ESLint with zero warnings: passed.
- Production Vite build: passed.
- Python compilation of changed test modules: passed.
- Full backend suite: 588 passed, 0 failed, 20 optional-dependency skips.
- Live HTTP suite: 76 passed, 0 failed, 2 online-network skips.

The managed Microsoft Edge E2E suite remains part of `Test-SamQL-All.ps1` and
must execute on the Windows validation machine.

## Next sequence item

Phase 6 splits `NodeFlow.tsx`, beginning with node inspector renderers and a
frontend node-definition registry. That registry should centralize node default
configuration, card summary, inspector selection, and other node-specific UI
behavior before the backend node-definition registry is introduced.
