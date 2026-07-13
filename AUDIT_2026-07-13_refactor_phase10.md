# SamQL Refactor Phase 10 Audit — build 2026-07-13.594

Build: `2026-07-13.594`  
Version: `2.16.4`

## Goal

Keep Phase 10 release hardening as the delivery contract while shipping the
soft-recovery and Created Node polish that followed the 593 remediation.

## Delivered in this build

- Soft engine reset (`POST /api/engine/reset`) from Activity & connections,
  distinct from nuclear Reset server / nuke + reload.
- Created Node definition refresh loads never-opened NodeFlow tabs from
  localStorage so dormant instances receive port updates.
- Soft cancel for chart, reconcile drill/profile, and Excel peek via
  AbortSignal on supersede.
- Expanded Create-a-node icon palette across existing `Icon` glyphs.

## Release boundaries (unchanged contract)

- `RELEASE_MANIFEST.json` remains the machine-readable identity, quality-floor,
  and APHEX transport contract.
- Packaging still uses only `SOURCE_MANIFEST.txt`, deterministic UTF-8
  normalization, mail-defang of dangerous extensions, section-body SHA-256,
  APHEX-1 encode, and a mandatory decode identity check.
- `Decode-SamQL-APHEX.ps1` and `Expand-SamQL.ps1` remain the Windows PowerShell
  reconstruction path.

## Compatibility

No backend route shape, workflow kind, notebook cell format, NodeFlow node
type/port vocabulary, or APHEX alphabet/line-wrap contract changed. Soft reset
reuses the existing `/api/engine/reset` endpoint. Soft cancel only adds optional
AbortSignal plumbing to already-unbounded fetches.

## Validation evidence

Release packaging for this build must:

1. pass `python tools/release_artifacts.py verify-tree --root .`
2. emit `samql_full_source_all_tests_ui_2026-07-13.594.txt` and
   `SAMQL_BUILD_594_EMAIL_SAFE_APHEX.txt`
3. decode with `Decode-SamQL-APHEX.ps1` to byte-identical decrypted bytes
4. expand with `Expand-SamQL.ps1` and match every `SOURCE_MANIFEST.txt` path
5. pass `tests/test_release_hardening.py` and the full suite gate
