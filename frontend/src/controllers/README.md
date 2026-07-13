# App controller architecture

Phase 5 extracts the major state and lifecycle domains that previously lived
inside `App.tsx`. The app component is now a composition shell around five
focused controllers:

- `useCatalogController` owns tables, history, saved queries, workflow lists,
  latest-response-wins refresh sequencing, and SQL Server disconnect refreshes.
- `useIdeController` owns editor tabs, active-tab recovery, SQL edits, undo/redo,
  run ownership, query messages, target/read-only/dialect settings, and editor
  tab presentation state.
- `useResultController` owns result tabs, floating/docked result state, result
  menus/filter drafts, inactive-row release, and the shared paged-result
  controller introduced in Phase 4.
- `useWorkspaceController` owns IDE/Journal/NodeFlow view switching, workflow
  save/open/delete routing, file commands, and cross-surface load requests.
- `useBackgroundOperations` owns cancellable background operations, load/folder/
  HDFS/optimize starters, task completion, and their catalog/toast hand-off.

Stable contracts shared by the controllers remain in `appTypes.ts`. The
controllers preserve the existing component props, persisted workspace format,
API endpoints, and visual DOM hooks.

Phase 6 should split the large NodeFlow implementation, beginning with inspector
renderers and the frontend node-definition registry. That work should consume
these controllers rather than moving NodeFlow state back into `App.tsx`.
