# SamQL release checklist

This checklist is the final Phase 10 gate for a source or executable release.
A green development build is not enough: identity, saved-data compatibility,
the exact source manifest, Microsoft Edge behavior, and both source transports
must all be verified.

Current release identity (must match everywhere): **v2.16.4 / build 2026-07-16.620**,
**316** managed source files.

## 1. Confirm one release identity

From the project root:

```powershell
python tools/release_artifacts.py verify-tree --root .
```

The command must report zero failures. It delegates to `tools/release_preflight.py` and cross-checks
`RELEASE_MANIFEST.json`, `VERSION`, the backend constants, `package.json`, the
npm lockfile, saved-data schema constants, the source manifest, CI wiring, test
inventory, the complete test-extract bootstrap (suite runner, `tests/`,
`tools/`, Playwright e2e, Vitest setup, install helpers), and the final
`NodeFlow.tsx` composition bound.

## 2. Exercise migration compatibility

```powershell
cd frontend
npm run test:release
cd ..
```

The compatibility suite must prove that legacy workflow envelopes, notebooks,
NodeFlow graphs, NodeFlow tab indexes, and browser session state remain
readable; future versions and malformed current NodeFlow documents must fail
with a useful error. Failed migration steps must leave their original input
unchanged so the pre-migration recovery copy remains usable.

## 3. Run the canonical complete suite

On Windows, with Microsoft Edge installed:

```powershell
.\Test-SamQL-All.ps1
```

A complete release pass includes Python compilation, backend and live HTTP
coverage, SQLite and DuckDB optimization tests, frontend source contracts,
Vitest, TypeScript, zero-warning ESLint, the production Vite build, benchmark
self-tests, release/package verification, Playwright test discovery, and the
real Microsoft Edge run. `-SkipBrowser` is a partial diagnostic run and cannot
close a release.

The GitHub `windows-browser.yml` workflow runs the same release preflight and
non-browser suites before its Edge job. Failed browser runs upload traces,
screenshots, and the Playwright report.

## 4. Build executable artifacts on the target Windows toolchain

Follow `WINDOWS_BUILD_CHECKLIST.txt`, including the one-file PyInstaller build,
cold start, single-instance reuse, taskbar/window branding, cancel/recovery,
and clean-exit checks. Confirm `/api/health` reports the exact release version
and build from `RELEASE_MANIFEST.json`.

`build.ps1` / `build.sh` install the full `requirements-optional.txt` set into
the packaging Python and hard-fail if the critical load/export stack cannot
import. That stack now includes:

- **duckdb**, **pyarrow**, **pandas**, **sqlglot**, **openpyxl**, **ijson**,
  **orjson**, **tzdata** (required)
- **msal**, **requests** (SharePoint sign-in; bundled when present)
- **requests-negotiate-sspi** / **pyodbc** / **pywin32** (Windows)
- **pywebview** + **pythonnet** (native AppWindow)

`samql.spec` refuses to package without the required load stack, and refuses a
build that lacks a complete `frontend/dist` (real Vite UI — not a placeholder).
Recipients of the built exe therefore get DuckDB, Parquet, Excel, pandas Python
nodes, and (when bundled) SharePoint OAuth / Windows Integrated Auth.

## 5. Package both complete source transports

```powershell
.\Pack-SamQL.ps1
# or:
python tools/release_artifacts.py package --root . --output-dir release
```

The command writes into `release/`:

- `samql_full_source_all_tests_ui_<build>.txt` — the complete decoded source;
- `SAMQL_BUILD_<sequence>_EMAIL_SAFE_APHEX.txt` — the APHEX-1 mail-safe form;
- `SAMQL_BUILD_<sequence>_RELEASE_RECEIPT.json` — sizes, hashes, and verification flags;
- `Expand-SamQL.ps1.txt` / `Decode-SamQL-APHEX.ps1.txt` — mail-safe helper scripts
  (rename to `.ps1` before running);
- `SHA256SUMS.txt` / `SAMQL_BUILD_<sequence>_RELEASE_REPORT.txt` — publish evidence.

`tools/package_release.py` performs the bundle construction. Packaging is
deterministic because the release timestamp is pinned in
`RELEASE_MANIFEST.json`. It fails on a preflight error, a missing manifest
file, a section mismatch, an incorrect bundle body hash, or any APHEX
byte-for-byte round-trip difference.

APHEX is reversible transport encoding, **not cryptographic encryption**.

## 6. Record release evidence

Archive the following together:

- preflight output;
- full-suite summary and Edge/Playwright result;
- executable build log and Windows checklist notes;
- decoded bundle filename, byte count, and SHA-256;
- APHEX filename, byte count, and SHA-256;
- the `release/` receipt + report for this build.
