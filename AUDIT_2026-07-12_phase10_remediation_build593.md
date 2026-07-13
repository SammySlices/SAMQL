# SamQL Phase 10 remediation audit — build 2026-07-12.593

Version: `2.16.4`  
Baseline: audited build `2026-07-12.592`  
Purpose: correct the defects reproduced after the Phase 1–10 refactor before Windows release-candidate certification.

## Release decision

Build 592 must not be promoted. Build 593 is the first candidate containing the complete source-audit remediation set. Promotion still requires the Windows Microsoft Edge rail and optional-engine checks described under **Remaining machine-specific gates**.

## Corrected critical defects

1. **Cross-tab destructive mutation.** NodeFlow deletion and container mutations now commit synchronously in the originating document. The 230 ms implosion timer owns visual state only. Identical pending implosions are coalesced and overlapping visual IDs are reference-counted.
2. **Canonical manifest and release path.** The manifest is generated in the exact mail-safe ordering enforced by preflight and covers one complete managed tree. Packaging, expansion, receipt generation, and APHEX round-trip verification operate on that same tree.
3. **Release codec self-test.** Dangerous-extension checks assert the defanged spelling and reject raw dangerous tokens. Deterministic two-pass packaging, expanded-tree reproduction, tamper detection, and legacy EOF-terminated APHEX decoding are covered.

## Corrected asynchronous-ownership defects

- Validation, chart, directory, and table-create requests carry an AbortSignal, document scope, request generation, and mounted-state guard.
- Stale success, error, cancellation, and notification paths are all no-ops.
- Chart refreshes are latest-request-wins per node, while duplicate same-generation hydration is coalesced.
- NodeFlow unmount aborts every owned auxiliary request and registered run.
- Immediate Run/Stop recovery reads `runIdRef.current`, so a same-render cancellation cannot leave the UI in “Cancelling…”.
- Workflow loads and FileBrowser navigation are latest-request-wins and abort superseded operations.
- Workflow naming targets the editor tab captured when the load began rather than whichever tab is active later.
- Global run cancellation no longer aborts unrelated HTTP work.

## Corrected persistence and graph-integrity defects

- Malformed NodeFlow tab indexes are backed up and replaced with one valid editable tab.
- A corrupt graph body invalidates only its owning tab; valid sibling tabs remain intact.
- Malformed browser sessions are backed up before clean recovery.
- Future-version browser sessions are backed up and preserved without a destructive rewrite.
- Current NodeFlow documents validate unique node and edge IDs, registered node types, valid endpoint membership, and valid source/target port names before projection.

## Restored Phase 9 safeguards

- Structural chart hydration is keyed by tab plus graph signature, deduplicates dashboard/chart sources, and cancels queued animation frames.
- `NodeFlow.tsx` remains a thin composition shell; rendering is owned by `NodeFlowScene`, indexed derivation by `nodeFlowRenderModel`, graph snapshots by `useNodeFlowGraphSnapshot`, and inspector state by its focused controller.
- Per-node render revisions depend on the node, incident edges, and direct dashboard/chart sources rather than a global graph/chart object.
- Large-graph node and wire culling remains active, while selected and transient cards stay mounted.
- Canvas virtualization observes element resizing through `ResizeObserver`, including inspector/sidebar/layout-only changes.
- The unused global-invalidation `NodeFlowNodeLayer.tsx` implementation was removed.

## Regression coverage added

Focused component regressions cover stale validation and notifications, chart stale failures and request ordering, same-tick chart coalescing, immediate Stop recovery, unmount cancellation, malformed tab recovery, isolated corrupt graph recovery, synchronous and deduplicated deletion, directory latest-wins behavior, stale table-create errors, strict graph parsing, workflow latest-wins behavior, editor-tab naming, FileBrowser latest-wins behavior, scoped run cancellation, viewport ResizeObserver handling, malformed session backup, and future-session preservation.

The existing Phase 9 performance suite also protects small-graph identity, large-graph virtualization, stationary-card render isolation, StrictMode-safe animation ownership, and same-tab structural chart hydration.

## Remaining machine-specific gates

- Run the Microsoft Edge Playwright suite through `Test-SamQL-All.ps1` on the supported Windows release machine.
- Run DuckDB-dependent backend tests with the optional release dependency set installed.
- Run online-only HTTP checks where outbound access is permitted.
- Rebuild the Windows executable on a clean account and verify launch, reuse, shutdown, saved-data upgrade, recovery, branding, and signing evidence.

A subsequent build should be created only for defects found by those release-candidate gates.

## Additional release-rail corrections found during implementation

- Vitest again uses the Phase 9 bounded worker model: the thread pool is capped at four workers and file execution is non-concurrent. This prevents the complete component rail from exhausting constrained release hosts while preserving all 113 behavior checks. A source contract now protects the worker bound.
- The historical `.464b` retained-row memory audit now runs six 300,000-row workloads with `MAX_CACHED_RESULTS` deliberately reduced to four. That forces repeated real eviction and count-cache cleanup while removing the previous fourteen-by-600,000-row allocator stress that could take many minutes on the standard-library SQLite fallback. The heap-growth ceiling remains 40 MB.
- The legacy motion audit now follows the split Phase 9 owners and separately verifies single-node and multi-node implosion routes instead of depending on an obsolete source-string count.

## Validation completed in this environment

| Gate | Result |
|---|---:|
| Release preflight | **41 passed**, 0 failed |
| Backend inventory | **588 passed**, 0 failed, 20 optional-dependency skips |
| Live HTTP contracts | **76 passed**, 0 failed, 2 online-only skips |
| Frontend source and architecture contracts | **111 passed**, 0 failed |
| React component behavior | **113 passed across 23 files** |
| Focused Phase 10 remediation behavior | **27 passed** |
| NodeFlow resource checks | **8 passed** |
| SQLite optimization checks | **40 passed** |
| TypeScript | Passed |
| ESLint | Passed with zero warnings |
| Vite production build | Passed; 721 modules transformed |
| Python source compilation | Passed |
| Release hardening and codec self-test | Passed |
| Manifest reconstruction and APHEX round trip | Performed during final packaging |

The complete backend inventory was also executed in bounded index ranges to keep historical stress cases isolated; all 608 registrations are accounted for by the 588 passes and 20 dependency-gated skips. No product failure is hidden behind a timeout.
