# Distributing SamQL to colleagues (AppWindow onedir)

SamQL’s primary packaged product is **SamQL-AppWindow** as an onedir
folder (zipped for handoff). Recipients **do NOT need Python or Node.js
installed.** Everything (the Python runtime, DuckDB, pyarrow, pandas, the
compiled React UI, and optionally the SQL assistant *runtime*) is bundled
into the build.

Node.js and Python are only needed on the BUILD machine, to compile the
frontend and package the app. The people you send it to run a finished,
standalone application.

The old console / browser-tab `SamQL.exe` launch path is **not** the
promoted distribution artifact. A `SamQL.exe` server sidecar may still
ride along inside the AppWindow folder for advanced use; recipients should
double-click **SamQL-AppWindow.exe**.

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

## Primary packaging mode: AppWindow onedir (default)

```powershell
powershell -File build.ps1
```

Produces `dist\SamQL-AppWindow\` — a FOLDER containing the exe plus a
pre-extracted `_internal\` with everything it needs — and writes one or
two zip archives for handoff (via `tar` / ZIP64, not Compress-Archive):

| Zip | Contents |
|-----|----------|
| `dist\SamQL-AppWindow.zip` | Lean AppWindow (no `assistant/`) |
| `dist\SamQL-AppWindow-Assistant.zip` | Same folder **plus** SQL assistant runtime (`assistant/runtime/` = llama.cpp `llama-server` + DLLs; GGUF only if you built with `-AssistantPack post`) |

The second zip is written when the build staged `assistant/` into the
onedir folder (default `-AssistantPack runtime`, or `post`). Lean-only
builds (`-AssistantPack lean`) produce just `SamQL-AppWindow.zip`.

- Pro: NO per-launch extraction. The "failed to remove temporary
  directory" dialog is structurally impossible (there is no temp dir),
  startup is fast (already unpacked), and the app's runtime layout is
  stable instead of shifting under a temp folder each launch.
- Con: you distribute a zip that unzips to a folder, not a lone .exe.

### Opt-in onefile AppWindow

```powershell
powershell -File build.ps1 -OneFile
```

Produces a self-extracting `dist\SamQL-AppWindow.exe` (slower start, temp
`_MEI…` unpack each launch). Not recommended for distribution.

---

## SQL assistant pack (runtime without model by default)

Default build mode `-AssistantPack runtime` stages:

```
assistant\
├── runtime\          <- llama-server + companion DLLs (llama.cpp, not Ollama)
└── models\
    └── README.txt    <- how to fetch a GGUF later (no .gguf shipped)
```

No multi-GB GGUF is bundled. At build time, if `assistant/runtime/` is
missing, `build.ps1` / `build.sh` fetch the llama.cpp CPU release via
`tools/fetch_assistant_pack.py --skip-model` (same as
`.\Fetch-SamQL-Assistant.ps1 -SkipModel`). Offline builders that cannot
reach GitHub should use `-AssistantPack lean`.

Recipients (or you) download a model later:

```powershell
.\Fetch-SamQL-Assistant.ps1 -Model 4b   # or 7b
```

Then either:

- copy `assistant\models\*.gguf` into the install’s `assistant\models\`, or
- drop the `.gguf` into the install-root **`Model\`** folder (next to
  `_internal` / `frontend_dist` — created empty in lean/runtime packs).

SamQL prefers `assistant/models/` when present, then `Model/`. Settings →
preferred path still wins when set. Repo-dev fetch writes to
`assistant/models/`; packaged lean users typically use `Model/`. The
picker and Fetch script support **4b / 7b** (default **4b**).

Other packaging modes:

| Mode | Flag | What ships |
|------|------|------------|
| lean | `-AssistantPack lean` | No `assistant/` (still ships empty `Model/`) |
| runtime (default) | `-AssistantPack runtime` | llama-server only |
| post | `-AssistantPack post` | runtime + GGUF (~+1 GB+) |
| embed | `-AssistantPack embed` | full pack baked into PyInstaller |

Offline / no-network builders should use `-AssistantPack lean`.

---

## What's in the onedir folder

```
SamQL-AppWindow\
├── SamQL-AppWindow.exe     <- double-click THIS
├── SamQL.exe               <- server sidecar (rides along; not the UI product)
├── SamQL.ico               <- shortcut icon
├── Model\                  <- drop a .gguf here when the pack omits a model
├── assistant\              <- runtime-only by default (see above)
├── python3xx.dll           <- the bundled Python runtime
└── _internal\              <- everything else, pre-extracted
    ├── (DuckDB, pyarrow, pandas, sqlglot, openpyxl, orjson, ijson, msal, pywebview, …)
    ├── frontend_dist\      <- the compiled SamQL UI
    └── base_library.zip, …
```

The `.exe` and `_internal\` must stay together in the same folder. Moving
or deleting `_internal\` will break the app.

---

## Instructions to give recipients (onedir)

1. Extract **SamQL-AppWindow.zip** (lean) or
   **SamQL-AppWindow-Assistant.zip** (includes SQL assistant runtime) to a
   LOCAL folder — e.g. `C:\SamQL`. (A local disk, not a OneDrive-synced
   folder — OneDrive hydration + AV makes first run much slower.)
2. Open the extracted `SamQL-AppWindow` folder.
3. Double-click **SamQL-AppWindow.exe**.

Important: extract the zip FIRST. Do not run the exe from inside the zip
preview — Windows extracts that to a hidden temp location and the app
won't find its files.

No Python. No Node.js. No admin rights needed to run.

Optional — offline SQL assistant model (Assistant zip already has the
llama-server runtime; lean zip needs the runtime/`assistant\` pack first):

```powershell
.\Fetch-SamQL-Assistant.ps1 -Model 4b
```

Copy `assistant\` next to `SamQL-AppWindow.exe` if missing, then drop the
`.gguf` into `Model\` (or `assistant\models\`).

---

## Notes

- **Primary product:** SamQL-AppWindow onedir zip. Do not hand out the
  console/browser-tab `SamQL.exe` as the main app.
- Onedir only changes how the AppWindow is laid out; `-OneFile` restores
  the older self-extracting AppWindow layout.
- **Payload parity:** `SamQL.exe` and `SamQL-AppWindow` are built from the
  same PyInstaller shared lists — same frontend, DuckDB/openpyxl/ijson
  load stack, icon, and native-window (pywebview) packages. The build
  refuses to finish if either target is missing, and signs **both** when
  a code-signing certificate is supplied.
- If your organization allows it, adding an AV exclusion for the install
  folder makes the first launch faster still.

---

## Code signing (optional — not required to build)

A plain `.\build.ps1` (or CI without cert secrets) always produces a complete
**unsigned** package. Signing is opt-in and never blocks packaging.

Corporate IT (SmartScreen / AppLocker) often blocks unsigned exes, so for
bank/colleague distribution sign **both** product binaries
(`SamQL-AppWindow.exe` and the `SamQL.exe` server sidecar) with the same cert:

```powershell
# Certificate already in the Windows certificate store (SHA-1 thumbprint):
.\build.ps1 -CertThumbprint 1A2B3C4D...

# Certificate in a .pfx file:
.\build.ps1 -CertPath .\codesign.pfx -CertPassword 'secret'

# Force unsigned even if a cert is configured in the environment:
.\build.ps1 -NoSign
```

Requirements when signing: Windows SDK `signtool.exe` on the build machine,
plus an OV/EV code-signing certificate from a trusted CA (EV/OV is what
removes SmartScreen prompts). The script signs with SHA-256, RFC-3161
timestamps via `-TimestampUrl` (default DigiCert), and runs `signtool verify`
on each target. See also `WINDOWS_BUILD_CHECKLIST.txt` and the header of
`build.ps1`.
