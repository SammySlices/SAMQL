# SamQL refactor sequence — phase 1 (build .583)

## Scope

The first sequence item was implemented: split `tests/run_tests.py` while
preserving its public command, options, output, ordering, and cleanup behavior.
No production query, UI, server, or persistence behavior changed in this build.

## New ownership boundaries

- `tests/run_tests.py` — argument parsing, suite orchestration, cleanup, summary.
- `tests/harness.py` — result ledger, assertions, colors, skip/failure handling,
  authenticated test requests, and split-source discovery.
- `tests/fixtures.py` — shared CSV/JSON fixtures.
- `tests/paths.py` — repository path resolution.
- `tests/node_harnesses.py` — JavaScript behavioral fixture programs.
- `tests/suites/backend.py` — in-process engine/session suite.
- `tests/suites/http_api.py` — live server/API suite.
- `tests/suites/frontend.py` — frontend contracts and toolchain suite.

## Safety rails

The registry audit now scans the full custom-runner source set, not one file.
The free-name audit uses Python symbol tables across every split module, so a
skip-gated NameError remains detectable. A new architecture test enforces a
small orchestrator, suite exports, retained CLI options, all three suite calls,
and a minimum inventory of registered test functions.

## Validation performed

- Python compilation of all split runner modules: passed.
- Frontend custom suite: 89 passed, 0 failed, 19 environment-gated skips.
- Live HTTP suite: 76 passed, 0 failed, 2 network-only skips.
- Split architecture, registry hygiene, and cross-module scope audits: passed.
- The first 260+ backend registrations completed without a failure before the
  environment execution window; directly affected meta-tests were then run
  independently and passed.

## Next sequence item

Consolidate the small duplicated utilities: atomic JSON writes, load FormData
construction, named-profile persistence, pointer-drag listener ownership, and
reconcile request construction.
