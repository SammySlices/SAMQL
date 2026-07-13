# SamQL Refactor Phase 10 Audit

Build: `2026-07-12.592`  
Version: `2.16.3`

## Goal

Close the refactor sequence with release hardening rather than another UI
split. Phase 10 makes release identity, saved-data compatibility, Windows Edge
coverage, and source packaging executable contracts that fail closed when the
shipped tree is incomplete or internally inconsistent.

## Implemented release boundaries

- `RELEASE_MANIFEST.json` is the machine-readable release contract for product
  identity, minimum runtimes, saved-data versions, quality floors, the final
  NodeFlow composition limit, and APHEX transport settings.
- `tools/release_artifacts.py` is the stable verify/package/decode/verify CLI
  used by CI and PowerShell wrappers.
- `tools/release_preflight.py` cross-checks every version/build source, npm lock
  identity, `VERSION` ordering, compatibility constants, manifest safety and
  exactness, UTF-8 source readability, test inventories, Windows CI wiring,
  documentation, and packaging-tool presence.
- `tools/package_release.py` atomically builds the decoded full-source bundle
  exclusively from `SOURCE_MANIFEST.txt`, normalizes text deterministically,
  mail-defangs executable-looking extensions, hashes the exact section body,
  emits APHEX, decodes it again, and refuses any byte mismatch.
- `tools/aphex_transport.py` provides a documented APHEX-1 encode/decode/verify
  implementation. It checks the declared byte count and SHA-256 and is
  regression-tested against the established transport format.
- `tests/test_release_hardening.py` proves preflight success, deterministic
  repeated packaging, exact manifest/section parity, executable-extension
  defanging, and byte-for-byte APHEX recovery.
- `RELEASE_CHECKLIST.md` makes Microsoft Edge, executable checks, source hashes,
  and release evidence explicit final gates.

## Saved-data hardening

- `runMigrations` clones untrusted JSON input before the first step, checks the
  complete plan up front, requires one-version-at-a-time advancement, requires
  an object with an explicit integer version from every step, wraps step
  failures with their source version, and rejects future data before mutation.
- Current-format NodeFlow files validate format, node/edge arrays, node
  geometry/config shape, connection shape, referenced nodes, and duplicate
  node/connection identifiers before the canvas consumes them.
- Current NodeFlow tab indexes validate shape and duplicate IDs while retaining
  the existing missing-active-tab recovery behavior.
- The rendered compatibility suite covers legacy/current/future workflow,
  notebook, graph, and tab cases plus failed-migration input preservation.

## CI and test integration

- The Windows workflow runs release preflight, deterministic packaging, the
  complete custom Python/HTTP/frontend suite, optimization/resource tests, and
  benchmark self-tests before Microsoft Edge Playwright.
- `Test-SamQL-All.ps1` runs the same release/package regression as part of its
  canonical gate.
- Runtime documentation agrees with the locked frontend engine floor: Python
  3.10+, Node.js 20.19+, and npm 10+.
- Legacy source audits now follow the Phase 9 module owners rather than pinning
  obsolete one-line spellings in the former NodeFlow monolith.

## Compatibility

No backend API route, query payload, workflow kind, notebook cell format,
NodeFlow node type/port, graph serialization version, execution planner,
incremental journal optimization, projection pushdown rule, CSS selector, or
Playwright selector changed. Phase 10 only tightens malformed-current-data
handling and release production.

## Validation evidence

The Phase 10 source tree completed these available release gates:

- release preflight against exactly 249 managed source files;
- 608 registered backend contracts: 607 passed, 0 failed, and 1 expected
  environment/code-path skip because the real TypeScript compiler was present;
- 78 live HTTP contracts: 76 passed, 0 failed, and 2 intentionally skipped
  online-network cases;
- all 116 frontend contracts, including 87 rendered/component tests, the saved
  data migration suite, TypeScript, zero-warning ESLint, and the production
  Vite build;
- 80 SQLite/DuckDB optimization tests and 8 NodeFlow resource tests;
- the dual-engine benchmark harness self-test; and
- Playwright discovery of all 12 browser journeys with the Microsoft Edge
  channel selected.

The retained-row memory regression now uses six budget-crossing workloads. It
still forces repeated eviction across the 300,000-row ceiling, but avoids
constructing 8.4 million Python tuples under `tracemalloc` during every release
run, keeping the gate bounded without weakening its assertion.

This Linux execution environment has no PowerShell runtime and its managed
Chromium policy blocks navigation to localhost with
`ERR_BLOCKED_BY_ADMINISTRATOR`; the failure occurs before any SamQL browser
assertion. The real Microsoft Edge execution therefore remains the explicit
Windows-only certification gate and must be recorded through
`Test-SamQL-All.ps1` or `windows-browser.yml` before promoting an executable.

The final package receipt records file counts, sizes, hashes, deterministic
bundle identity, and APHEX round-trip status.
