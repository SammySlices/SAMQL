# SamQL architecture and release boundaries

This document records the ownership boundaries at the end of the ten-phase
refactor sequence. It is intentionally about stable contracts, not individual
implementation details.

## Runtime shape

SamQL is a local-first application with a React/Vite frontend and a Python HTTP
backend. The browser UI talks only to the versioned `/api` surface. Backend
engine selection, result paging, cancellation, persistence, and temporary-file
lifecycle remain behind that API boundary.

The authoritative product identity lives in
`backend/samql_core/__init__.py`. `VERSION`, `frontend/package.json`, the npm
lockfile, and `RELEASE_MANIFEST.json` must agree with it. The Phase 10 release
preflight rejects any skew before tests or packaging can publish artifacts.

## Frontend ownership

`frontend/src/App.tsx` is the application composition shell. Focused controller
modules own server health, file/workflow routing, dialogs, persistence, and
cross-workspace actions. Pure model modules own serialization and migrations so
saved data can be tested without mounting React.

`frontend/src/components/NodeFlow.tsx` is the NodeFlow composition shell. Its
stable boundaries are:

- `nodeDefinitions.ts` — node identity, defaults, labels, ports, summaries,
  inspector selection, and resize policy;
- inspector modules — node-specific editing UI only;
- graph command modules — pure graph mutations and container operations;
- document controllers — tabs, per-tab history, autosave, restore, open/save,
  and latest-request-wins file loading;
- execution controllers — run/cancel/recovery, previews, charts, validation,
  export, iterator/while execution, and tab-scoped stale-response rejection;
- graph projection and viewport modules — indexed graph lookups, wire geometry,
  large-canvas culling, and frame-coalesced measurement;
- result drawer and visual-effects modules — transient rendering state isolated
  from graph/document state.

NodeFlow serialization remains in `frontend/src/lib/nodeFlowModel.ts`. The
current graph and tab schema versions are declared there and mirrored in the
release manifest.

## Saved-data compatibility

All versioned JSON enters through `runMigrations` in
`frontend/src/lib/migrations.ts`. Migrations are sequential, operate on a clone,
and must return exactly the next integer version. Future versions, incomplete
plans, malformed outputs, and malformed current NodeFlow documents fail closed
with a user-facing error. The original input remains available for recovery.

The compatibility contract covers:

- workflow envelope and payload versions;
- notebook documents;
- NodeFlow graph documents;
- NodeFlow tab indexes;
- browser-session persistence.

Changing any current version requires a one-step migration, a compatibility
test, and a corresponding `RELEASE_MANIFEST.json` update.

## Release ownership and source-transport boundary

`SOURCE_MANIFEST.txt` is the only input list for complete-source packaging.
`tools/release_preflight.py` proves identity, manifest exactness, saved-data
version alignment, test floors, CI wiring, documentation, and transport
settings. `tools/package_release.py` constructs and reconstructs the decoded
bundle. `tools/aphex_transport.py` owns APHEX-1. The stable command-line facade
is `tools/release_artifacts.py`.

A release source package contains:

1. a decoded full-source bundle with a declared section count and SHA-256 of
   the exact section body;
2. an APHEX-1 mail-safe transport that decodes byte-for-byte to that bundle;
3. a release receipt containing artifact sizes, hashes, and verification flags.

`Expand-SamQL.ps1` verifies the decoded bundle count and body hash before it
creates, prunes, or overwrites destination files. APHEX is reversible encoding,
not cryptographic encryption.

## Required release gates

The canonical local gate is `Test-SamQL-All.ps1`. It includes release
preflight/package regression, Python compilation, backend and live HTTP suites,
frontend contracts and component tests, TypeScript, zero-warning ESLint, the
production Vite build, dual-engine optimization checks, adaptive resource and
persistent-cache checks, benchmark self-tests, Playwright discovery, and the
real browser run.

The Windows workflow performs the same non-browser gates before Microsoft Edge
Playwright. Windows-only executable, cold-start, taskbar, and Citrix checks are
recorded in `WINDOWS_BUILD_CHECKLIST.txt` and must be completed before promoting
an executable release.
