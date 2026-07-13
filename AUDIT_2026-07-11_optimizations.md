# SamQL incremental execution and dependency optimization — build .582

Scope: NodeFlow incremental execution, Journal dependency scheduling, and
projection pushdown. The implementation deliberately reuses SamQL's existing
content-addressed flow cache and Journal result stores rather than introducing a
second cache or persistence format.

## NodeFlow incremental execution

Long linear flows previously fused into one SQL statement. Fusion is fast on a
cold run, but it meant a downstream edit could force the entire branch to scan
and recompute again even when every upstream node was unchanged.

Build .582 adds a sparse, deterministic checkpoint planner. It materializes
reusable boundaries at expensive operators, shared subgraphs, the direct parent
of a requested target, and every third node in a long branch. Random sampling,
free-form SQL, sources, and side-effecting sinks are excluded. Checkpoints use
the existing subtree fingerprint, projection signature, data epoch, engine salt,
LRU budget, and persistent-cache safety rules. An upstream edit changes every
downstream fingerprint; a downstream edit leaves earlier checkpoints reusable.

## Journal dependency optimization

One pure dependency graph now powers lineage, branch runs, the in-flight gate,
and Run all. The graph includes direct SQL-cell references, chart/pivot sources,
reconcile sources, and earlier-group output aliases.

Run all now skips cells whose complete result store matches the current canonical
compiled SQL. Stale cells are divided into dependency waves: independent cells
in a wave run concurrently, while downstream waves wait for prerequisites.
Capped, missing, never-run, or SQL-drifted results are never reused. Existing
server-side chain reuse remains the execution mechanism for fresh dependencies.

## Projection pushdown

Column liveness now passes through nested groups and a broader set of transforms,
including joins, unions, reconcile, summarize, pivot/unpivot, windows, ranking,
coalesce, split, JSON extraction, date transforms, and multi-join. File-browser
sources and iterator accumulators use the same projection wrapper as loaded
input tables.

Dependency-only fields remain available while an operator runs, then are removed
before a reusable intermediate is cached. For example, a shared filter may read
`a`, `b`, and condition column `c`, while its checkpoint stores only downstream
columns `a` and `b`.

## Regression coverage

- Dual-engine SQLite and DuckDB optimization suite: 80 passed.
- New projection tests cover groups, per-input union, reconcile, and narrow
  shared checkpoints.
- New incremental tests prove downstream edits hit an upstream checkpoint and
  upstream edits invalidate descendants.
- New Journal component tests cover full reuse, stale descendants, parallel
  waves, group aliases, capped results, chart sources, and reconcile sources.
- TypeScript, ESLint, 38 React component tests, and production Vite build pass.
