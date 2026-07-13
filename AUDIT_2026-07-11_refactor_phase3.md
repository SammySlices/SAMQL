# SamQL refactor sequence — phase 3 (build .585)

## Scope

Phase 3 splits two UI areas that had grown into multi-domain components:
`LoadDataModal.tsx` and `NotebookCell.tsx`. The refactor preserves their public
props, compatibility exports, DOM/CSS hooks, keyboard behavior, cancellation,
persistence, and API payloads. No backend endpoint or serialized workspace
format changed.

## Load-data ownership

`LoadDataModal.tsx` is now a composition shell. It owns the selected source tab,
shared busy state, close/cancel behavior, and completion hand-off. Source-specific
logic lives under `frontend/src/components/load/`:

- `FileLoadTab.tsx` — local files, Excel sheet selection, foreground/background
  load options, and flatten/root-id choices.
- `FileBrowser.tsx` — filesystem navigation and save/folder selection.
- `RootIdPicker.tsx` — nested JSON root discovery.
- `ApiLoadTab.tsx` — REST preview, credentials, fetch, and cancellation.
- `SqlServerLoadTab.tsx` — profiles, connection/catalog browsing, import, and
  query cancellation.
- `HdfsLoadTab.tsx` — connection, browsing, scanning, and load hand-off.
- `FlattenLoadTab.tsx` — standalone flatten job lifecycle.

`FileBrowser` and `RootIdPicker` remain re-exported by `LoadDataModal.tsx`, so
existing imports continue to work.

## Notebook-cell ownership

`NotebookCell.tsx` is now a thin shell for status flash, gutter/drag chrome,
renderer dispatch, and add-cell controls. Focused renderers live under
`frontend/src/components/notebook/`:

- `SqlNotebookCell.tsx` — SQL editor, result grid, run/stop, and query actions.
- `VisualizationNotebookCell.tsx` — chart/pivot source selection, collapse,
  refresh, and rendering.
- `ReconcileNotebookCell.tsx` — left/right source selection and report actions.
- `NoteNotebookCell.tsx` — note editing/rendering.
- `NotebookCellShared.tsx` — resize, add controls, shared move/delete actions,
  and editor chrome.
- `NotebookCellTypes.ts` — one owner for the cell contracts.

The extraction intentionally preserves existing class names and control order,
including note action placement and visualization/reconcile collapse controls.

## Tests and safety rails

- A rendered `LoadDataModal` component test walks every extracted source tab.
- `NotebookCell` component tests cover SQL, note, visualization, and reconcile
  renderer routing, including source selectors and collapse behavior.
- The source-contract suite enforces thin shells, isolated API responsibilities,
  compatibility exports, centralized types/chrome, and no child-to-parent import
  cycles.
- Existing load, cancellation, HDFS, Excel, API, SQL Server, Journal, resize,
  reorder, delete, and accessibility contracts continue to run against the
  combined component family rather than forcing implementation back into one
  file.

## Validation performed

- React component suite: 45 passed, 0 failed.
- Frontend source/behavior contracts through ESLint: all passed.
- TypeScript type-check: passed.
- ESLint with zero warnings: passed.
- Production Vite build: passed.
- Python compilation of the changed test suite: passed.

The live managed-Edge Playwright suite is still executed by the Windows all-test
runner; this refactor does not change its selectors or workflows.

## Next sequence item

Introduce the shared IDE/Journal paged-result controller, then begin extracting
focused controllers from `App.tsx`.
