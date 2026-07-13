# SamQL Refactor Phase 9 Audit

Build: `2026-07-12.591`  
Version: `2.16.2`

## Goal

Finish the NodeFlow composition split and remove the two remaining rendering
scalability problems: global canvas-card invalidation for local graph changes,
and unconditional rendering of every node and wire in oversized workflows.
Preserve graph serialization, execution semantics, workflow compatibility, DOM
hooks, and the Phase 6-8 controller boundaries.

## Implemented boundaries

- `NodeFlow.tsx` is reduced from 1,979 lines to 582 lines. It now composes a
  focused scene, inspector panel, preview drawer, graph controller, graph
  snapshot, chart-hydration controller, and canvas-animation controller.
- `NodeFlowScene.tsx` owns canvas/palette/status/menu composition without taking
  document or execution state-machine ownership back from the Phase 8
  controllers.
- `useNodeFlowGraphController.ts` owns graph mutation callbacks and command
  routing; `useNodeFlowAnimations.ts` owns born/dying/snapping card state,
  deduplicates repeated delete animations, and cancels every timer/frame on
  StrictMode replay or unmount.
- `useNodeFlowInspectorController.tsx` owns inspector-local state, input-column
  resolution, autocomplete, and inspector callbacks. `NodeFlowInspectorPanel`
  has an explicit memo boundary keyed by execution scope, selected node,
  structural graph signature, and inspector runtime inputs.
- `NodeFlowPreviewDrawer.tsx` owns the preview/chart drawer presentation.
- `useStableEvent.ts` supplies identity-stable handlers that always invoke the
  latest implementation, preventing callback identity churn from defeating
  component memoization.
- Vitest uses a four-worker thread pool so the complete jsdom component rail
  is deterministic on 4 GiB CI and developer machines.

## Local invalidation and snapshot reuse

- `nodeFlowRenderModel.ts` indexes nodes and incoming edges once and derives a
  per-node render revision from only that node's configuration, its incident
  edges, and dashboard-source dependencies. An unrelated node edit therefore
  does not invalidate every canvas card.
- `useNodeFlowGraphSnapshot.ts` caches the backend execution graph by structural
  node/edge identity. Position-only drag frames do not rebuild or stringify the
  backend graph, while config, type, port, and edge changes still invalidate it.
- `useNodeFlowChartHydration.ts` keys restored chart work to the structural graph
  signature rather than the tab id or moving node array. Same-tab workflow loads
  hydrate correctly, coordinate-only edits enqueue nothing, and queued frames are
  canceled when the graph or editor changes.
- Canvas cards receive `renderVersion`, replacing the previous global graph
  version contract.

## Large-workflow virtualization

- Normal workflows continue to render every card and wire.
- Above guarded node and wire thresholds, the scene computes viewport bounds
  with overscan and culls off-screen cards and wires.
- Selected cards and transient wire-source, group-hover, born, dying, and
  snapping cards remain mounted even when their geometry is outside the
  viewport.
- The canvas publishes total/rendered counts and virtualization state through
  stable data attributes for behavioral and diagnostic coverage.

## Compatibility

- No node type, port, node configuration schema, graph envelope, tab envelope,
  backend route, request payload, or persisted workflow format changed.
- Phase 8 execution/document controllers remain the sole owners of run scope,
  cancellation, autosave, history, tabs, and file lifecycle.
- Existing CSS classes, test ids, canvas gestures, inspector behavior, preview
  behavior, and Playwright-facing selectors remain present.

## Regression coverage

New pure and rendered tests verify:

- only incident/dependent cards receive a new render revision;
- dashboard source configuration participates in local invalidation;
- position-only updates reuse the backend graph snapshot;
- normal workflows render every card;
- oversized workflows virtualize off-screen nodes and wires;
- selected and transient wire-source/animation cards survive virtualization;
- a moved card does not rerender an unrelated stationary card;
- a 4,000-node/3,999-edge render model stays on the linear indexing path;
- animation timers survive StrictMode replay and exact duplicate deletes commit
  only once;
- expanded charts hydrate after a same-tab graph replacement but not after a
  coordinate-only move.

The frontend source-contract suite also enforces the 750-line NodeFlow shell
limit, module ownership, stable-event use, snapshot reuse, chart-hydration
cancellation, transient-frame cleanup, per-node render revisions, virtualization
thresholds, and shipped regression names.

## Validation

Build 591 passed the complete source-available release gates:

- 588 backend tests passed, 0 failed, with 20 optional-engine/environment skips;
- 111 frontend source and wiring contracts passed, 0 failed;
- 87 rendered/component tests across 20 files passed, 0 failed;
- TypeScript, zero-warning ESLint, and the Vite production build passed;
- all 244 unique manifest entries were packaged, reconstructed, and compared
  against the expected refanged source projection; and
- the APHEX payload decoded byte-for-byte to the decrypted full-source bundle.

The Windows Microsoft Edge Playwright run remains the machine-specific final
browser gate through `Test-SamQL-All.ps1`.
