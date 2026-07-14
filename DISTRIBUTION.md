# Distributing SamQL to colleagues (onedir)

SamQL can be built two ways. Both are fully self-contained — **recipients
do NOT need Python or Node.js installed.** Everything (the Python runtime,
DuckDB, pyarrow, pandas, the compiled React UI) is bundled into the build.

Node.js and Python are only needed on the BUILD machine, to compile the
frontend and package the app. The people you send it to run a finished,
standalone application.

---

## Complete source delivery (decoded + APHEX)

Before an executable build or source handoff, verify one coherent tree and
produce both canonical transports:

```powershell
python tools/release_artifacts.py verify-tree --root .
python tools/release_artifacts.py package --root . --output-dir release
```

The output contains a decoded `samql_full_source_all_tests_ui_<build>.txt`, a
`SAMQL_BUILD_<sequence>_EMAIL_SAFE_APHEX.txt` transport, and a release receipt.
Decode APHEX with `Decode-SamQL-APHEX.ps1` or the `decode` command in
`tools/release_artifacts.py`, then reconstruct with `Expand-SamQL.ps1`. The
expander verifies the declared file count and section-body SHA-256 before any
destination file is changed. APHEX is encoding, not cryptographic encryption.

Release preflight rejects any extract that omits the complete test bootstrap:
`Test-SamQL-All.ps1`, Python suite trees (`tests/`, `tools/`), Playwright
specs (`frontend/e2e/`), `frontend/package-lock.json`, Vitest setup, and the
install helpers the all-tests runner invokes. After expand, the destination is
meant to run `.\Test-SamQL-All.ps1` with the declared Python/Node floors.

---

## Two packaging modes

### Onefile (default) — one .exe

    powershell -File build.ps1

Produces `dist\SamQL.exe` and `dist\SamQL-AppWindow.exe`. Each is a
single self-extracting executable: on every launch it unpacks its
payload to a temporary `_MEI…` folder, runs from there, and deletes it
on exit.

- Pro: one file to send.
- Con: slower start (re-unpack + AV scan every launch), and the
  PyInstaller bootloader can show a "Failed to remove temporary
  directory: …_MEI…" warning if Windows/AV holds a file handle at exit.

### Onedir (recommended for distribution) — a folder

    powershell -File build.ps1 -OneDir

Produces `dist\SamQL-AppWindow\` — a FOLDER containing the exe plus a
pre-extracted `_internal\` with everything it needs — and zips it to
`dist\SamQL-AppWindow.zip` for you to hand out.

- Pro: NO per-launch extraction. The "failed to remove temporary
  directory" dialog is structurally impossible (there is no temp dir),
  startup is fast (already unpacked), and the app's runtime layout is
  stable instead of shifting under a temp folder each launch.
- Con: you distribute a zip that unzips to a folder, not a lone .exe.

---

## What's in the onedir folder

    SamQL-AppWindow\
    ├── SamQL-AppWindow.exe     <- double-click THIS
    ├── SamQL.exe               <- the bundled server (rides along)
    ├── SamQL.ico               <- shortcut icon
    ├── python3xx.dll           <- the bundled Python runtime
    └── _internal\              <- everything else, pre-extracted
        ├── (DuckDB, pyarrow, pandas, sqlglot, openpyxl, orjson, ijson, msal, pywebview, …)
        ├── frontend_dist\      <- the compiled SamQL UI
        └── base_library.zip, …

The `.exe` and `_internal\` must stay together in the same folder. Moving
or deleting `_internal\` will break the app.

---

## Instructions to give recipients (onedir)

1. Extract **SamQL-AppWindow.zip** to a LOCAL folder — e.g. `C:\SamQL`.
   (A local disk, not a OneDrive-synced folder — OneDrive hydration + AV
   makes first run much slower.)
2. Open the extracted `SamQL-AppWindow` folder.
3. Double-click **SamQL-AppWindow.exe**.

Important: extract the zip FIRST. Do not run the exe from inside the zip
preview — Windows extracts that to a hidden temp location and the app
won't find its files.

No Python. No Node.js. No admin rights needed to run.

---

## Notes

- The two modes are independent; the single-exe `SamQL.exe` server target
  is built the same way in both. Onedir only changes how the AppWindow
  is laid out.
- **Payload parity:** `SamQL.exe` and `SamQL-AppWindow` are built from the
  same PyInstaller shared lists — same frontend, DuckDB/openpyxl/ijson
  load stack, icon, and native-window (pywebview) packages. The build
  refuses to finish if either target is missing, and signs **both** when
  a code-signing certificate is supplied.
- If your organization allows it, adding an AV exclusion for the install
  folder makes the first launch faster still.
