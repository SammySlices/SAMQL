# SamQL Refactor Phase 10 Audit — build 2026-07-14.595

Build: `2026-07-14.595`  
Version: `2.16.4`

## Goal

Keep Phase 10 release hardening as the delivery contract while shipping App
Dashboard, SQL Server node parity, large-JSON load hardening, and start/close
lifecycle cleanup on top of build 594.

## Delivered in this build

- App Dashboard: boards, widgets (query/chart/text), expand windows, PDF export
  to Downloads, and settings chrome.
- NodeFlow SQL Server matches Load Data via shared `MsSqlConnectForm`, profile
  and secret reuse, and auto-fetch so Dashboard/Run can proceed unattended.
- Python, SharePoint, and web-scrape NodeFlow nodes.
- Large JSON loads: memory caps, array→NDJSON streaming, on-disk Parquet prefer,
  flatten depth controls, and stream-flatten fallback.
- Session shutdown closes connections and clears temps; DuckDB spill stays under
  the per-pid instance path; AppWindow close keeps the server for reattach while
  Exit→stop / Ctrl+C invoke graceful shutdown.
- Quality floors: 200 component tests / 20 Microsoft Edge E2E tests; managed
  source tree remains an exact `SOURCE_MANIFEST.txt` inventory.

## Release boundaries (unchanged contract)

- `RELEASE_MANIFEST.json` remains the machine-readable identity, quality-floor,
  and APHEX transport contract.
- Packaging still uses only `SOURCE_MANIFEST.txt`, deterministic UTF-8
  normalization, mail-defang of dangerous extensions, section-body SHA-256,
  APHEX-1 encode, and a mandatory decode identity check.
- `Decode-SamQL-APHEX.ps1` and `Expand-SamQL.ps1` remain the Windows PowerShell
  reconstruction path.

## Compatibility

No APHEX alphabet/line-wrap contract change. Dashboard is a new workflow surface
behind existing saved-data migrations. SQL Server node config expands with
defaults that remain readable by older graphs. JSON load paths preserve prior
behavior for small files and add bounded paths for large ones.

## Validation evidence

Release packaging for this build must:

1. pass `python tools/release_artifacts.py verify-tree --root .`
2. emit `samql_full_source_all_tests_ui_2026-07-14.595.txt` and
   `SAMQL_BUILD_595_EMAIL_SAFE_APHEX.txt`
3. decode with `Decode-SamQL-APHEX.ps1` to byte-identical decrypted bytes
4. expand with `Expand-SamQL.ps1` and match every `SOURCE_MANIFEST.txt` path
5. pass `tests/test_release_hardening.py` and the full suite gate
