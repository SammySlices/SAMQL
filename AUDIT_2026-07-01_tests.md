# SamQL test-suite audit — 2026-07-01 (v2.10.95 / build .366)

Scope requested: analyze the current tests for what is WRONG, LACKING, needs
IMPROVEMENT, or MISSING. Suite at audit time: 546 registered tests
(534 passing / 21 skipped) across backend, http, and frontend sections of
`tests/run_tests.py`. Everything found as *wrong* was fixed in this build;
everything *missing-and-cheap* was added; the rest is inventoried below with
honest reasoning about what can and cannot be closed in this sandbox.

---

## 1. WRONG — tests that asserted the wrong thing (all fixed in .366)

**W1 — Vacuous format-version assertion (filecache).** The check
`cache_key(...) != (FC.CACHE_VERSION, k_mtime)[1]` compared against
`k_mtime` (the tuple-index was a no-op), and the key already differed because
the source's size had changed since `k_mtime` was captured — so the assertion
passed even if `CACHE_VERSION` was completely unused. *Fixed:* a proper
round-trip (bump changes the key; restore returns it exactly), which proves
the version participates in the identity.

**W2 — `begin()` uniqueness was untested and actually broken.** Adding the
missing "two stagings never collide" case (section 3) immediately failed:
`begin()` keyed its temp name on millisecond time, so two conversions of the
same file in the same millisecond would fight over one temp path. *Fixed in
the MODULE* (a locked process-local counter), not the test — the audit's
first concrete product.

**W3 — Environment leak in the row-cap test.** `t_result_row_cap` set
`SAMQL_MAX_RESULT_ROWS=5` and popped it only at the end of the body — a
mid-test assertion failure would leave a FIVE-ROW cap poisoning every later
query test in the run, turning one failure into a confusing cascade.
*Fixed:* the body now runs under try/finally. A sweep of every other
`os.environ[...] =` site in the suite found the rest already guarded
(finally-pop or save/restore).

## 2. Registry hygiene — clean, and now enforced

A scan for orphaned tests (defined but never registered → silently test
nothing), ghost registrations, and duplicate labels found **zero of each**
across all 546 functions. That property is now locked in by a permanent
meta-test (`t_suite_registry_hygiene`) so a future paste error can't silently
disable a test.

## 3. MISSING — cheap gaps, added in .366

- **filecache:** a zero-byte (corrupt) entry must MISS (exercises the
  `getsize > 0` guard); staging-path uniqueness (which exposed W2).
- **cell_value:** a non-string value (number) returns raw — no length, never
  clipped — so the full-value popover can't mangle numerics.
- **chain reuse:** an empty/None reuse map is a no-op fast path (no views,
  harmless cleanup) — the common non-chained run must never pay anything.

## 4. NEEDS IMPROVEMENT — the source-check class

~131 of 546 tests (~24%) are source-substring ("grep") checks rather than
behavioral tests. They are the right tool for *wiring* (route registered,
prop passed, gate present) and they run in a sandbox with no DuckDB and no
browser — but they carry two known costs, both paid this session:

- they break on refactors that preserve behavior (two knock-ons this cycle:
  the journal-persist ternary heuristic, and the chain-reuse check anchored
  on text that a later hoist moved), and
- they can go stale in the other direction: asserting text that no longer
  proves the behavior.

Guidance adopted going forward (not a rewrite of 131 tests): new code gets a
behavioral stub test FIRST (the .363 concurrent-read battery and the .365
reconcile-staging battery are the template — real functions bound to
recording stubs), with a source check only for pure wiring. Where frontend
logic is pure (e.g. group reordering, `composeForRun`'s walk), the long-term
fix is moving it into `lib/` so the existing node test harness
(`notebook.mjs` block) can exercise it directly.

## 5. LACKING — coverage gaps that CANNOT be closed in this sandbox

Honest list; these need the real box (no DuckDB / pyarrow / browser here):

- **True concurrency (#2):** the cursor-vs-lock behavior is stub-proven, but
  nothing here executes two real DuckDB statements in parallel. On-box check:
  long query + load simultaneously; both progress; Stop kills the right one.
- **R3 paging parity:** read-time `__rn` ordering cost on a multi-million-row
  store is reasoned, not measured. On-box: scroll + sort a huge result;
  compare feel to pre-.361.
- **Filecache under a real COPY:** hit/miss logic is fully tested; the
  interaction with a real multi-GB DuckDB COPY (and a crash mid-COPY leaving
  only a .tmp) is design-verified only. On-box: restart-reattach; kill the
  app mid-load once and confirm the next start converts cleanly.
- **Grid interactions (#3):** the truncated-cell fetch is endpoint-tested and
  wiring-checked; the actual click → popover flow needs eyes.
- **R2 validation day:** concurrent reads defaulting ON is the standing ask.

## 6. What was checked and found sound

Tautology sweep (self-comparisons, `need(True)`, dead index tricks) — only
W1. Exception-swallowing inside assertions — none beyond intentional
cleanup guards. Cross-test state: env vars now all guarded (W3); temp dirs
per-test with finally-rmtree; the one deliberate module-global monkeypatch
pattern (`FC._DIR`) is save/restore everywhere. Skips: all 21 are explicit
environment gates (duckdb/pyarrow/openpyxl absent), not silent.

---

## Fixed in this build (.366)

W1, W2 (module fix), W3, plus the three section-3 additions and the
registry-hygiene meta-test. Suite: 535 passing, 0 failing, 21 skipped.

---

## Addendum — improvement phases 1–3 applied (build .367)

**Phase 1 (extract trapped pure logic → real behavioral tests).** `cellIsFresh`,
`reorderByGroups`, `lastSqlCellByGroup`, `planChainReuse`, and
`journalGraphCsv` now live in `lib/notebook.ts`; the component keeps thin
wrappers. Each gained a node-harness behavioral battery (7d–7h: freshness
truth table incl. capped-never-fresh; group reordering + rank order; last-cell
alias resolution with `uptoId`; the reuse walk incl. stale-with-fresh-dep and
group aliases; CSV BOM/CRLF/RFC quoting/edge dedup), and the corresponding
component greps were repointed to identifier-level wiring only.

**Phase 2 (executed checks instead of greps).**
`t_interface_signatures` (inspect.signature: reuse / from_result /
prefer_locked+query_id / cell_value view params) and
`t_handler_ast_passthroughs` (AST walk of server.py: each handler must pass
the audited keywords into its session call, whatever the formatting) replace
six string checks, which were pruned. Two cross-boundary contracts now
EXECUTE both sides under node: the truncation marker vs the client's verbatim
`TRUNC_RE`, and the #5 refresh gate vs a real SELECT payload. Fixing them up
was itself a find: both node contracts carried an argv bug (`node -e` user
args begin at argv[1]; one sliced from 2, one routed through `--`) — the
marker contract could never see the marker. Both corrected and green.

**Phase 3 (anchor hardening).** Formatting anchors replaced with semantic or
regex anchors: the two non-SELECT-branch refresh checks now extract the
actual branch (between `result_id == null` and its `} else`) instead of
matching exact indentation; `view === "ide" ? (` and `!g.collapsed && (`
became whitespace-tolerant regexes; and the journal-persist "never behind a
conditional" pattern was corrected — it forbade the ALLOWED display-style
ternary; it now forbids only a real conditional render of `<Notebook`.

Post-phase state: 549 registered tests, 539 passing / 21 skipped; source-check
count down and every remaining one anchored on identifiers, API strings, or
extracted segments.
