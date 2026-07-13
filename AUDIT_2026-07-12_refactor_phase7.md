# SamQL Refactor Phase 7 Audit

Build: `2026-07-12.589`  
Version: `2.16.0`

## Goal

Turn `NodeFlow.tsx` from a combined editor/controller/rendering implementation
into a smaller composition shell while preserving workflow formats, node
semantics, DOM hooks, run behavior, persistence, and inspector behavior.

## Implemented boundaries

- `useNodeFlowCanvasInteractions.ts` owns the global pointer state machine for
  node movement, multi-drag, resizing, marquee selection, panning, connection
  creation, snap-to-port behavior, and container drop detection.
- `useNodeFlowViewport.ts` owns zoom, viewport measurement, minimap preference,
  and pan-to behavior.
- `useNodeFlowClipboard.ts` owns graph copy/paste and regenerates node, edge,
  group-child, and iterator-child identifiers.
- `useNodeFlowKeyboardShortcuts.ts` owns undo/redo/copy/paste/delete routing and
  ignores destructive shortcuts in text-entry controls.
- `useNodeFlowAutosave.ts` owns debounced tab persistence plus page-hide and
  visibility flushes.
- `nodeFlowGraphCommands.ts` is the pure command layer for node creation,
  top-level and nested configuration edits, child add/remove/reorder/extract,
  container dissolution, atomic node/edge deletion, and move-into-container.
- `NodeFlowCanvasShell.tsx`, `NodeFlowTabBar.tsx`, `NodeFlowPalette.tsx`,
  `NodeFlowMenus.tsx`, and `NodeFlowStatusBar.tsx` own their focused UI surfaces.

`NodeFlow.tsx` is reduced from 5,100 lines in Phase 6 to 3,769 lines. Remaining
code is primarily workflow execution, preview/export orchestration, tab/history
coordination, and canvas node composition.

## Compatibility

- No node type, port, default configuration, persisted graph/tab envelope, or
  backend endpoint changed.
- Inspector ownership from Phase 6 remains intact.
- Incremental execution, dependency-journal optimization, and projection
  pushdown code paths are unchanged.
- Existing CSS classes and test hooks used by Playwright remain present.
- Source-contract audits now inspect the logical NodeFlow module family rather
  than assuming every behavior lives in one file.

## Regression coverage

New tests cover:

- fresh graph-node defaults and coordinate bounds;
- nested child lookup and immutable configuration patching;
- group child add/reorder/remove;
- child extraction and container dissolution;
- atomic incident-edge cleanup;
- move-into-container behavior and invalid-target safety;
- clipboard regeneration of top-level, edge, and nested child IDs;
- keyboard shortcut dispatch, edge/multi/node delete precedence, and typing
  protection;
- Phase 7 architectural ownership and NodeFlow size limits.

## Validation

- TypeScript (`tsc --noEmit`)
- ESLint with zero warnings
- Vite production build
- Vitest rendered/component suite
- SamQL frontend source, wiring, model, and architecture contracts
- Full-source manifest reconstruction
- APHEX encode/decode byte-for-byte round trip

The Windows Microsoft Edge Playwright run remains the machine-specific final
browser gate through `Test-SamQL-All.ps1`.
