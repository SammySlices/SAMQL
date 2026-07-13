# SamQL refactor sequence — phase 6 (build .588)

## Scope

Phase 6 starts the `NodeFlow.tsx` decomposition by moving node-specific
configuration rendering behind focused inspector modules and introducing one
typed frontend node-definition registry. The refactor preserves API routes,
workflow envelopes, persisted node/config shapes, node ports, run semantics,
canvas DOM hooks, and existing user-visible behavior.

## New ownership boundaries

### `nodeflow/nodeDefinitions.ts`

Owns the complete frontend node registry. Every `NodeType` has exactly one
definition with its display label, palette icon, inspector selection, fresh
default-config factory, resizable-inspector policy, and card-summary behavior.
Palette order and category groups are derived from or validated against this
registry instead of maintaining independent metadata and long fallback chains.

Defaults for `filebrowser`, `apinode`, and `while` are now explicit rather than
falling through a generic object. Every factory returns a new object, including
fresh nested arrays/objects, so creating one node cannot mutate another node's
default configuration.

### `nodeflow/NodeFlowInspector.tsx`

Owns the node-type-specific inspector branches and their local transient UI
state. `NodeFlow.tsx` passes an explicit context contract while retaining graph,
run, preview, and orchestration ownership.

### `nodeflow/InspectorControls.tsx`

Owns reusable inspector list controls (`ReorderList` and `ColumnPicker`).

### `nodeflow/InspectorShell.tsx`

Owns inspector docking/portal behavior, empty and hidden states, width styling,
and the pointer-drag resize rail.

## Result

`frontend/src/components/NodeFlow.tsx` is reduced from 11,091 lines in build
.587 to 5,100 lines in build .588. Palette construction, node default creation,
card-summary branching, inspector labels, and resize-policy branching no longer
live in the orchestration shell.

The large inspector renderer is now isolated behind a stable context boundary.
That is deliberate: this phase removes the highest-risk ownership coupling first
without rewriting dozens of node forms at once. Later phases can split inspector
families independently while the NodeFlow shell and registry contracts stay
stable.

## Safety and compatibility

- Every `NodeType` is covered by `NODE_DEFINITIONS` through a TypeScript
  `satisfies Record<NodeType, NodeDefinition>` contract.
- Hidden compatibility nodes (`fill` and `antijoin`) remain declared and
  inspectable but stay off the palette/categories.
- Palette labels/icons and category order remain unchanged.
- Workflow and node configuration formats remain unchanged.
- Existing run, preview, export, API, iterator, while, group, and canvas behavior
  remains in the orchestration component or its prior focused modules.
- Legacy source-contract tests now read the complete NodeFlow component family,
  preventing architecture tests from forcing extracted logic back into one file.

## Tests and validation

New regressions cover:

- registry coverage for every frontend node type;
- palette/category consistency;
- fresh nested default configuration objects;
- explicit `filebrowser`, `apinode`, and `while` defaults;
- card summaries and resizable-inspector behavior;
- extracted inspector empty-selection rendering; and
- extracted Input inspector config/preview interactions.

Validation performed:

- Full React component suite: 64 passed, 0 failed.
- Phase 6 and affected frontend source contracts: passed.
- TypeScript type-check: passed.
- ESLint with zero warnings: passed.
- Production Vite build: passed.
- Python compilation of changed frontend/backend suite modules: passed.
- Backend in-process suite reached the final legacy source-wiring contracts with
  production/runtime tests passing; the one stale NodeFlow source-location check
  was updated and revalidated against the extracted component family.

The managed Microsoft Edge E2E suite remains part of `Test-SamQL-All.ps1` and
must execute on the Windows validation machine.
