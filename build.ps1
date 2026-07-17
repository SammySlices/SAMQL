# Build SamQL into a distributable AppWindow package (Windows).
#
# Requires: node + npm (to build the frontend) and Python 3 + pip.
#
# Primary product (default): dist\SamQL-AppWindow\ (onedir folder) + zip.
# Double-click SamQL-AppWindow.exe inside the extracted folder. The old
# console/browser-tab SamQL.exe is still produced as a sidecar server binary
# inside that folder, but is NOT the promoted distribution artifact.
#
# Optional code signing (recommended for distribution -- bank IT often blocks
# unsigned executables). Signing is OFF unless you pass a certificate:
#
#   # Certificate already installed in the Windows certificate store:
#   .\build.ps1 -CertThumbprint 1A2B3C...   (its SHA-1 thumbprint)
#
#   # Certificate in a .pfx file:
#   .\build.ps1 -CertPath .\codesign.pfx -CertPassword 'secret'
#
#   # Force an unsigned build even if a cert is configured:
#   .\build.ps1 -NoSign
#
# The signature is SHA-256 and RFC-3161 timestamped (so it stays valid after
# the certificate expires). With no certificate the build still completes and
# leaves the .exe unsigned.
#
# Layout:
#   .\build.ps1              # default: AppWindow onedir folder + zip(s)
#   .\build.ps1 -OneFile     # opt-in: single self-extracting SamQL-AppWindow.exe
#   .\build.ps1 -OneDir      # accepted for back-compat (onedir is already default)
#
# Onedir zips (after a successful AppWindow folder build):
#   dist\SamQL-AppWindow.zip            - lean AppWindow (no assistant/)
#   dist\SamQL-AppWindow-Assistant.zip  - same + SQL assistant runtime
#                                         (llama.cpp llama-server; GGUF only
#                                         when -AssistantPack post/embed pack
#                                         already staged models). Written when
#                                         assistant/ was staged into the folder.
#
# SQL assistant packaging (prompted interactively if omitted):
#   .\build.ps1 -AssistantPack runtime # 2: llama-server runtime, no GGUF (default)
#   .\build.ps1 -AssistantPack lean    # 1: SamQL only (no assistant/)
#   .\build.ps1 -AssistantPack post    # 3: full assistant/ with GGUF (~+1GB+)
#   .\build.ps1 -AssistantPack embed   # 4: bake full assistant into PyInstaller
# Or set $env:SAMQL_ASSISTANT_PACK = lean|runtime|post|embed
#
# Recipients download a GGUF later:
#   .\Fetch-SamQL-Assistant.ps1 -Model 4b|7b
param(
  [string]$CertThumbprint,
  [string]$CertPath,
  [string]$CertPassword,
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [switch]$NoSign,
  [switch]$OneDir,   # back-compat: onedir is now the default product layout
  [switch]$OneFile,  # opt-in: self-extracting SamQL-AppWindow.exe (not recommended)
  [ValidateSet("", "1", "2", "3", "4", "lean", "runtime", "runtime-only",
               "post", "embed", "sidecar")]
  [string]$AssistantPack = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Resolve the build Python early -- brand PNG surgery runs BEFORE the
# frontend build so vite packages (and the launcher splash bundles) the
# transparent logos, not the opaque matte exports dropped in public/.
$py = if ($env:PYTHON) { $env:PYTHON } else { "python" }
try {
  $pyExe = & $py -c "import sys; print(sys.executable)"
} catch {
  Write-Error "Python not found. Install Python 3.10+ or set `$env:PYTHON."
  exit 1
}

# ---- SQL assistant packaging (1 lean / 2 runtime / 3 post / 4 embed) -----
$asstTool = Join-Path $Root "tools\assistant_build_pack.py"
if (-not (Test-Path -LiteralPath $asstTool)) {
  Write-Error "Missing $asstTool"
  exit 1
}
$resolveArgs = @($asstTool, "resolve")
if ($AssistantPack) {
  $resolveArgs += @("--mode", $AssistantPack, "--no-prompt")
} elseif ($env:SAMQL_ASSISTANT_PACK) {
  $resolveArgs += @("--mode", $env:SAMQL_ASSISTANT_PACK, "--no-prompt")
}
# When neither flag nor env is set, resolve prompts on a TTY (default runtime).
$AssistantMode = (& $py @resolveArgs).Trim()
if ($LASTEXITCODE -ne 0 -or -not $AssistantMode) {
  Write-Error "Failed to resolve SQL assistant packaging mode."
  exit 1
}
$env:SAMQL_ASSISTANT_PACK = $AssistantMode
if ($AssistantMode -eq "embed") {
  $env:SAMQL_ASSISTANT_EMBED = "1"
} else {
  Remove-Item Env:\SAMQL_ASSISTANT_EMBED -ErrorAction SilentlyContinue
}
Write-Host "==> assistant pack mode: $AssistantMode"
switch ($AssistantMode) {
  "lean"    { Write-Host "    lean: SamQL only (no assistant/ staged)" }
  "runtime" { Write-Host "    runtime: will stage llama-server + DLLs (no GGUF; fetch model later)" }
  "post"    { Write-Host "    post: will stage full assistant/ next to dist/ (~+1 GB+)" }
  "embed"   { Write-Host "    embed: will bake full assistant/ into the PyInstaller payload (~+1 GB+)" }
}
if ($AssistantMode -eq "embed" -or $AssistantMode -eq "post") {
  Write-Host "==> ensuring assistant pack (runtime + GGUF)..."
  & $py $asstTool ensure --root $Root --fetch --platform win-cpu
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Assistant pack is required for mode '$AssistantMode' but could not be prepared."
    exit 1
  }
} elseif ($AssistantMode -eq "runtime") {
  Write-Host "==> ensuring assistant runtime (llama-server only, no GGUF)..."
  & $py $asstTool ensure --root $Root --fetch --platform win-cpu --runtime-only
  if ($LASTEXITCODE -ne 0) {
    $asstErr = @(
      "Assistant runtime is required for mode 'runtime' but could not be prepared.",
      "  With network: .\\Fetch-SamQL-Assistant.ps1 -SkipModel",
      "            or: python tools\\fetch_assistant_pack.py --skip-model",
      "  Offline builders: .\\build.ps1 -AssistantPack lean"
    ) -join "`n"
    Write-Error $asstErr
    exit 1
  }
}

# .506 / splash: brand PNGs are binary drop-ins (not in SOURCE_MANIFEST).
# Seed the embedded SQ mark into frontend/public when absent so the launcher
# splash + Vite copy always have logo.png; never overwrite a user drop-in.
# Then strip baked-in backgrounds (logo doctor keeps interior whites and only
# clears border-connected background).
Write-Host "==> brand: ensuring public logos (embedded SQ mark if missing)"
$env:PYTHONPATH = (Join-Path $Root "backend")
& $py -c @"
from samql_core import _brand
for r in _brand.ensure_public_brand_pngs(r'frontend\public'):
    path = r.get('path') or ''
    if r.get('written'):
        print('    wrote (embedded):', path)
    else:
        print('    keep (present):', path)
"@
if ($LASTEXITCODE -ne 0) {
  Write-Warning "brand PNG ensure pass failed; continuing"
}

Write-Host "==> brand: making public logos transparent"
& $py -c @"
from samql_core import _brand
results = _brand.logo_fix_public_dir(r'frontend\public')
for r in results:
    path = r.get('path') or ''
    if r.get('before') is None:
        print('    skip (missing):', path)
        continue
    before, after = r['before'], r['after']
    if r.get('changed'):
        print('    fixed:', path,
              'alpha', before.get('has_alpha'), '->', after.get('has_alpha'),
              'border', before.get('border_colors'), '->', after.get('border_colors'))
    else:
        print('    ok (already clean):', path,
              'alpha=', after.get('has_alpha'),
              'border=', after.get('border_colors'))
"@
if ($LASTEXITCODE -ne 0) {
  Write-Warning "brand PNG transparency pass failed; continuing with source art as-is"
}

# .526: ONE source of truth for the mark. The repo-root SamQL.ico is
# propagated into frontend/public/favicon.ico BEFORE the frontend build, so
# the vite dist can never ship a stale favicon again -- that stale file is
# exactly what the launcher used to fetch and stamp onto the window (the
# "Edge icon" that kept coming back). Loud if the icon is missing.
$ico = $null
foreach ($c in @("SamQL.ico", "samql.ico")) {
  if (Test-Path $c) { $ico = $c; break }
}
if ($ico) {
  Copy-Item $ico "frontend\public\favicon.ico" -Force
  Write-Host "==> brand: $ico -> frontend/public/favicon.ico"
} else {
  Write-Warning "no SamQL.ico at the repo root -- the window/taskbar art will fall back to the generated icon"
}

Write-Host "==> 1/4  Building the React frontend"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
}

# Make package-lock portable (strip absolute registry URLs) then install with
# integrity-safe recovery -- same path Test-SamQL-All uses. Direct ``npm ci``
# under $ErrorActionPreference=Stop fails on harmless npm stderr warnings
# (e.g. Unknown env config "devdir") even when the install succeeded.
$lock = Join-Path $Root "frontend\package-lock.json"
& $py (Join-Path $Root "tools\normalize_npm_lock.py") --write $lock
if ($LASTEXITCODE -ne 0) {
  Write-Error "normalize_npm_lock.py failed (exit $LASTEXITCODE)."
  exit 1
}
$npmCache = Join-Path $env:TEMP ("samql-npm-build-cache-" + $PID)
# Cursor sandboxes set npm_config_devdir; npm warns on stderr and Stop can
# treat that as failure even when install_frontend_deps exits 0.
foreach ($k in @("npm_config_devdir", "NPM_CONFIG_DEVDIR",
                 "npm_config_cache", "NPM_CONFIG_CACHE")) {
  Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}
$prevInstallEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $py (Join-Path $Root "tools\install_frontend_deps.py") `
  --frontend (Join-Path $Root "frontend") `
  --cache $npmCache
$installCode = $LASTEXITCODE
$ErrorActionPreference = $prevInstallEap
if ($installCode -ne 0) {
  Write-Error ("frontend npm install failed (exit $installCode). " +
               "Fix frontend deps / registry, then re-run.")
  exit 1
}

# npm/vite also warn on stderr; keep Stop from treating that as failure.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Push-Location frontend
try {
  & npm run build
  $buildCode = $LASTEXITCODE
} finally {
  Pop-Location
  $ErrorActionPreference = $prevEap
}
if ($buildCode -ne 0) {
  Write-Error "npm run build failed (exit $buildCode). The packaged app would show the placeholder page."
  exit 1
}
$feIndex = Join-Path $Root "frontend\dist\index.html"
$feAssets = Join-Path $Root "frontend\dist\assets"
if (-not (Test-Path $feIndex)) {
  Write-Error "frontend/dist/index.html missing after npm run build -- refusing to package a placeholder UI."
  exit 1
}
if (-not (Test-Path $feAssets)) {
  Write-Error "frontend/dist/assets missing after npm run build -- refusing to package an incomplete UI."
  exit 1
}
Write-Host ("    OK: frontend/dist ready ({0} bytes index.html)" -f (Get-Item $feIndex).Length)

Write-Host "==> 2/4  Ensuring Python dependencies (engines, formats, build)"
Write-Host "    build Python: $pyExe"

# Install core required packages first (orjson, ...), then the full optional
# analytics stack. requirements-optional.txt also lists orjson so a single
# -r still works; installing backend/requirements.txt first makes the
# "always installed" contract explicit for source + packaging.
$reqCore = Join-Path $PSScriptRoot "backend\requirements.txt"
if (Test-Path $reqCore) {
  Write-Host "    installing core requirements from backend/requirements.txt"
  & $py -m pip install -r $reqCore
}

# Install EVERYTHING the packaged app can use from the ONE manifest
# (requirements-optional.txt). This must land in the SAME interpreter that
# runs PyInstaller -- never a different --user site -- or the exe ships
# without DuckDB/openpyxl/ijson and loads fail on other machines.
$req = Join-Path $PSScriptRoot "requirements-optional.txt"
if (-not (Test-Path $req)) {
  Write-Error "requirements-optional.txt not found; refusing an incomplete build."
  exit 1
}
Write-Host "    installing full dependency set from requirements-optional.txt"
& $py -m pip install --upgrade pip
& $py -m pip install -r $req
if ($LASTEXITCODE -ne 0) {
  Write-Warning "bulk install reported errors; retrying each package individually..."
  Get-Content $req | ForEach-Object {
    $pkg = $_.Trim()
    if ($pkg -eq "" -or $pkg.StartsWith("#")) { return }
    Write-Host "    installing: $pkg"
    & $py -m pip install $pkg
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "    pip could not install $pkg"
    }
  }
}

# CRITICAL load/export stack -- a binary without these fails on first use or
# silently falls back to SQLite (the on-box openpyxl incident, 2026-07-02).
$critical = @(
  "duckdb", "pyarrow", "pandas", "sqlglot", "openpyxl", "ijson", "orjson", "tzdata", "pytz"
)
foreach ($m in $critical) {
  & $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('$m') else 1)"
  if ($LASTEXITCODE -ne 0) {
    Write-Error ("critical dependency '$m' is not importable after " +
                 "install -- the packaged app would break. Fix the " +
                 "environment (venv active? proxy?) and re-run: " +
                 "$py -m pip install -r requirements-optional.txt")
    exit 1
  }
}
Write-Host ("    OK: load stack importable (" + ($critical -join ", ") + ")")

# Windows SQL Server connector -- install is required on Windows; warn (do not
# abort) if the machine has no ODBC driver toolchain for pyodbc.
if ($env:OS -eq "Windows_NT") {
  & $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('pyodbc') else 1)"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning ("pyodbc is not importable -- SQL Server load will be " +
                   "unavailable in this build. Install the Microsoft ODBC " +
                   "Driver for SQL Server, then: $py -m pip install pyodbc")
  } else {
    Write-Host "    OK: pyodbc importable (SQL Server load enabled)"
  }
}

& $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('PyInstaller') else 1)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "    installing pyinstaller..."
  & $py -m pip install pyinstaller
  if ($LASTEXITCODE -ne 0) {
    Write-Error "PyInstaller is required to package SamQL."
    exit 1
  }
}

# .498: the NATIVE window (SamQL-AppWindow.exe / SamQL.exe --window) uses
# pywebview, whose Windows backend is Microsoft Edge WebView2 loaded through
# pythonnet. `pip install pywebview` does not always pull pythonnet, and when
# it is missing pywebview can't start and the app silently opens in Edge
# instead. Install it explicitly (best-effort), then confirm the window stack
# is importable and WARN loudly if it isn't, so a browser fallback is a known
# choice, not a surprise. NOT fatal: the SQLite/browser build still ships.
# .508: install BOTH halves of the native-window stack into the SAME python
# that runs PyInstaller. pywebview itself was never installed here -- if the
# build python lacked it, samql.spec's find_spec silently skipped bundling it
# and the exe shipped browser-only even with pywebview "installed" elsewhere
# (the on-box "still opens Edge" with pywebview present on the machine).
& $py -c "import importlib.util as u, sys; sys.exit(0 if (u.find_spec('webview') and u.find_spec('clr')) else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host "    installing pywebview + pythonnet (native window stack)..."
    & $py -m pip install pywebview pythonnet
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "    pywebview/pythonnet did not install; the native window will fall back to a browser."
    }
}
& $py -c "import webview, webview.platforms.edgechromium, clr" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Host "  NATIVE WINDOW STACK MISSING IN THIS BUILD PYTHON" -ForegroundColor Yellow
    Write-Host "  SamQL-AppWindow.exe from THIS build will open a BROWSER" -ForegroundColor Yellow
    Write-Host "  window (Edge), not a pywebview window." -ForegroundColor Yellow
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Warning ("pywebview + its WebView2 backend are NOT both importable; " +
                   "SamQL-AppWindow will open a chromeless browser window " +
                   "instead of a native one. Install with: pip install " +
                   "pywebview pythonnet   (and ensure the Edge WebView2 " +
                   "Runtime is present on this machine).")
} else {
    Write-Host "    native-window stack OK (pywebview + WebView2 backend)"
}

Write-Host "==> 3/4  Packaging the executable"
# Clean rebuild so a changed icon / splash / bundled asset is actually
# re-embedded -- PyInstaller otherwise reuses its build cache. Only build/ and
# dist/ are cleared; the spec writes backend\samql.ico every build (from the
# user's root samql.ico if present, else _brand.py), overwriting any stale file,
# so there is no need to delete it first. (.498/.500: keep samql.ico -- both the
# root input and the generated backend copy -- the spec's unconditional rewrite
# already defeats the stale-icon problem the old delete was working around.)
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
# Default product layout is AppWindow onedir (folder + zip). -OneFile opts
# into the older self-extracting AppWindow.exe. -OneDir remains accepted.
if ($OneFile -and $OneDir) {
  Write-Error "Pass either -OneFile or -OneDir, not both."
  exit 1
}
$UseOneDir = -not $OneFile
if ($UseOneDir) {
  $env:SAMQL_ONEDIR = "1"
  Write-Host "    ONEDIR mode (default): SamQL-AppWindow will be a folder (dist\\SamQL-AppWindow\\)"
} else {
  Remove-Item Env:\\SAMQL_ONEDIR -ErrorAction SilentlyContinue
  Write-Host "    ONEFILE mode: SamQL-AppWindow.exe (self-extracting; not the recommended ship)"
}
# PyInstaller writes progress to stderr. With $ErrorActionPreference=Stop,
# PowerShell turns those NativeCommandError records into a terminating stop
# even when the process exit code is 0. Soften EAP for this call only.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $py -m PyInstaller --clean --noconfirm backend/samql.spec
$pyiCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($pyiCode -ne 0) {
  Write-Error "PyInstaller failed with exit code $pyiCode."
  exit $pyiCode
}

# .500: the app icon SOURCE is now the user's own file in the repo ROOT
# (samql.ico), which the spec reads and embeds into the exe. The build must NOT
# write over it -- doing so clobbered the user's icon and shipped the default
# (on-box: exe showed the _brand icon because root\samql.ico had been overwritten
# by a prior build). Only refresh the shortcut copy NEXT TO the exe (dist).
if (Test-Path backend\samql.ico) {
  Copy-Item backend\samql.ico dist\SamQL.ico -Force
  Write-Host "    wrote dist\SamQL.ico (shortcut icon)"
}
else {
  try {
    & $py -c "import sys; sys.path.insert(0,'backend'); from samql_core import _brand; open('dist/SamQL.ico','wb').write(_brand.app_ico())"
    Write-Host "    regenerated dist\SamQL.ico from _brand"
  }
  catch { Write-Host "    WARN could not write dist\SamQL.ico" }
}

# --- 4/4  Verify primary AppWindow output (+ server sidecar), then sign ----
# Primary ship is SamQL-AppWindow (onedir folder by default). SamQL.exe is
# still built from the shared payload as a console/server sidecar (copied
# into the onedir folder) but is not the promoted browser-tab product.
$serverExe = Join-Path $Root "dist\SamQL.exe"
$appExeOnefile = Join-Path $Root "dist\SamQL-AppWindow.exe"
$appExeOnedir = Join-Path $Root "dist\SamQL-AppWindow\SamQL-AppWindow.exe"
if (-not (Test-Path $serverExe)) {
  Write-Error "Build incomplete: dist\SamQL.exe is missing."
  exit 1
}
if ($UseOneDir) {
  if (-not (Test-Path $appExeOnedir)) {
    Write-Error "Build incomplete: dist\SamQL-AppWindow\SamQL-AppWindow.exe is missing."
    exit 1
  }
} elseif (-not (Test-Path $appExeOnefile)) {
  Write-Error "Build incomplete: dist\SamQL-AppWindow.exe is missing."
  exit 1
}
Write-Host "==> 4/4  Both targets present (SamQL.exe + SamQL-AppWindow)"

# .637: refuse to ship an AppWindow onedir that is missing Tcl/Tk data.
# Stock PyInstaller aborts at pyi_rth__tkinter when _tcl_data/_tk_data are
# absent; we also ship a lenient rthook, but the splash still needs these
# files for a real UI. Hard-fail here so a bad collect never becomes a zip.
if ($UseOneDir) {
  $tclInit = Join-Path $Root "dist\SamQL-AppWindow\_internal\_tcl_data\init.tcl"
  $tkTcl = Join-Path $Root "dist\SamQL-AppWindow\_internal\_tk_data\tk.tcl"
  $tkinterPyd = Join-Path $Root "dist\SamQL-AppWindow\_internal\_tkinter.pyd"
  foreach ($need in @($tclInit, $tkTcl, $tkinterPyd)) {
    if (-not (Test-Path $need)) {
      Write-Error "Build incomplete: AppWindow Tcl/Tk payload missing: $need. Ensure the packaging Python can import tkinter and its tcl/tk8.6 trees exist, then rebuild."
      exit 1
    }
  }
  Write-Host "    OK: AppWindow Tcl/Tk data present (_tcl_data + _tk_data + _tkinter.pyd)"
}

# Always ship a real UI folder next to the exe as well as inside the frozen
# bundle. Frozen apps resolve sys._MEIPASS/frontend_dist; the adjacent copy is
# the .467 hot-swap path and a safety net when MEIPASS extraction is incomplete.
$feSrc = Join-Path $Root "frontend\dist"
$feAdj = Join-Path $Root "dist\frontend_dist"
if (Test-Path $feAdj) { Remove-Item -Recurse -Force $feAdj }
Copy-Item -Recurse -Force $feSrc $feAdj
if (-not (Test-Path (Join-Path $feAdj "index.html"))) {
  Write-Error "Failed to stage dist\frontend_dist\index.html beside the executable."
  exit 1
}
Write-Host "    OK: staged dist\frontend_dist (exe-adjacent UI)"
if ($UseOneDir) {
  $feOnedir = Join-Path $Root "dist\SamQL-AppWindow\frontend_dist"
  if (Test-Path $feOnedir) { Remove-Item -Recurse -Force $feOnedir }
  Copy-Item -Recurse -Force $feSrc $feOnedir
  Write-Host "    OK: staged dist\SamQL-AppWindow\frontend_dist"
}

# Stage assistant/ next to dist outputs (and inside the AppWindow onedir).
if ($AssistantMode -eq "runtime") {
  Write-Host "==> staging assistant runtime beside dist (no GGUF)..."
  & $py $asstTool stage-post --root $Root --runtime-only
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to stage assistant/ runtime into dist/."
    exit 1
  }
} elseif ($AssistantMode -eq "post") {
  Write-Host "==> staging full assistant pack beside dist outputs..."
  & $py $asstTool stage-post --root $Root
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to stage assistant/ into dist/."
    exit 1
  }
} elseif ($AssistantMode -eq "lean") {
  Write-Host "==> assistant pack: lean mode (not staged). To add later:"
  Write-Host "    .\\Fetch-SamQL-Assistant.ps1 -Model 4b"
  Write-Host "    then copy .\\assistant next to dist\\SamQL-AppWindow\\"
  Write-Host "    and/or drop a .gguf into dist\\SamQL-AppWindow\\Model\\"
} else {
  Write-Host "==> assistant pack: embedded in PyInstaller payload (mode embed)"
}

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin",
             "${env:ProgramFiles}\Windows Kits\10\bin",
             "${env:ProgramFiles(x86)}\Windows Kits\8.1\bin")
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $hit = Get-ChildItem -Path $r -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -match '\\x64\\' } |
             Sort-Object FullName -Descending | Select-Object -First 1
      if ($hit) { return $hit.FullName }
    }
  }
  return $null
}

# Sign BOTH product exes with the same cert/timestamp policy. Onedir signs
# the AppWindow exe inside the folder; the later SamQL.exe folder copy
# inherits the already-signed server binary.
$signTargets = @($serverExe)
if ($UseOneDir) { $signTargets += $appExeOnedir } else { $signTargets += $appExeOnefile }

if ($NoSign) {
  Write-Host "    Skipping code signing (-NoSign)."
  Write-Host "         Unsigned build is fine for local/CI. For bank/IT distribution,"
  Write-Host "         re-run with -CertThumbprint or -CertPath (see DISTRIBUTION.md)."
}
elseif (-not ($CertThumbprint -or $CertPath)) {
  Write-Host "    No signing certificate provided; leaving BOTH exes unsigned."
  Write-Host "         Unsigned builds always succeed - a cert is never required to package."
  Write-Host "         Bank/IT-friendly: .\build.ps1 -CertThumbprint <sha1>"
  Write-Host "         or .\build.ps1 -CertPath .\codesign.pfx -CertPassword '...'."
  Write-Host "         Details: DISTRIBUTION.md / WINDOWS_BUILD_CHECKLIST.txt."
}
else {
  $signtool = Find-SignTool
  if (-not $signtool) {
    Write-Error "signtool.exe not found. Install the Windows 10/11 SDK, or add signtool to PATH. (Or omit the cert flags / pass -NoSign for an unsigned build.)"
  }
  $signBase = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
  if ($CertThumbprint) {
    $signBase += @("/sha1", $CertThumbprint)
  }
  else {
    if (-not (Test-Path $CertPath)) { Write-Error "Certificate file not found: $CertPath" }
    $signBase += @("/f", $CertPath)
    if ($CertPassword) { $signBase += @("/p", $CertPassword) }
  }
  foreach ($exe in $signTargets) {
    Write-Host "    Signing $exe"
    & $signtool @($signBase + $exe)
    if ($LASTEXITCODE -ne 0) { Write-Error "Signing failed for $exe (signtool exit $LASTEXITCODE)." }
    Write-Host "    verifying signature..."
    & $signtool verify /pa /v $exe
    if ($LASTEXITCODE -ne 0) { Write-Error "Signature verification failed for $exe." }
    Write-Host "    signed and verified OK: $(Split-Path $exe -Leaf)"
  }
}

$LeanZip = $null
$AssistantZip = $null
if ($UseOneDir) {
  $folder = Join-Path $Root "dist\\SamQL-AppWindow"
  if (Test-Path $folder) {
    # ship the (already signed) server exe + shortcut icon INSIDE the folder
    # too, so the one folder is fully self-contained for a colleague.
    Copy-Item $serverExe $folder -Force
    if (Test-Path "$Root\\dist\\SamQL.ico") {
      Copy-Item "$Root\\dist\\SamQL.ico" $folder -Force
    }
    # Dual zip when assistant/ is staged: lean (no assistant/) + with SQL
    # assistant runtime. Uses tar/ZIP64 (not Compress-Archive) for large packs.
    Write-Host "==> Zipping the onedir folder for distribution..."
    & $py $asstTool zip-onedir --root $Root
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Failed to write AppWindow distribution zip(s)."
      exit 1
    }
    $LeanZip = Join-Path $Root "dist\\SamQL-AppWindow.zip"
    $AssistantZip = Join-Path $Root "dist\\SamQL-AppWindow-Assistant.zip"
    Write-Host ""
    Write-Host "DISTRIBUTE: send a zip from dist\\. The recipient EXTRACTS it"
    Write-Host "  (e.g. to C:\\SamQL) and runs SamQL-AppWindow.exe from INSIDE"
    Write-Host "  the extracted folder. No Python/Node needed."
    if (Test-Path $LeanZip) {
      Write-Host "  Lean (no assistant/):          dist\\SamQL-AppWindow.zip"
    }
    if (Test-Path $AssistantZip) {
      Write-Host "  With SQL assistant runtime:    dist\\SamQL-AppWindow-Assistant.zip"
      if ($AssistantMode -eq "runtime") {
        Write-Host "    (llama-server + DLLs; no GGUF). To add a model:"
        Write-Host "      .\\Fetch-SamQL-Assistant.ps1 -Model 4b|7b"
        Write-Host "      then drop the .gguf into the install's Model\\ folder"
        Write-Host "      (or copy into assistant\\models\\)"
      } elseif ($AssistantMode -eq "post") {
        Write-Host "    (llama-server + GGUF from post-build pack)"
      }
    }
  }
}
Write-Host ""
Write-Host "Done. Your build is in:  $Root\dist\"
Write-Host "  Assistant packaging mode: $AssistantMode"
Write-Host "  PRIMARY: SamQL-AppWindow  -- windowed AppWindow product (distribute this)"
if ($UseOneDir) {
  Write-Host "  SamQL-AppWindow\              -- onedir folder (default ship)"
  if ($LeanZip -and (Test-Path $LeanZip)) {
    Write-Host "  SamQL-AppWindow.zip           -- lean AppWindow (no assistant/)"
  }
  if ($AssistantZip -and (Test-Path $AssistantZip)) {
    Write-Host "  SamQL-AppWindow-Assistant.zip -- AppWindow + SQL assistant runtime"
  }
  Write-Host "Onedir: extract a zip and run SamQL-AppWindow.exe inside the folder."
} else {
  Write-Host "  SamQL-AppWindow.exe  -- onefile windowed launcher (-OneFile)"
}
Write-Host "  SamQL.exe            -- console/server sidecar (not the browser-tab product)"
if ($AssistantMode -eq "runtime") {
  Write-Host "  assistant\           -- llama-server runtime only (no GGUF; fetch model later)"
} elseif ($AssistantMode -eq "post") {
  Write-Host "  assistant\           -- offline SQL assistant pack (llama-server + GGUF)"
}
Get-ChildItem dist -ErrorAction SilentlyContinue
