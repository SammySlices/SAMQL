# Build SamQL into a single distributable executable (Windows).
#
# Requires: node + npm (to build the frontend) and Python 3 + pip.
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
param(
  [string]$CertThumbprint,
  [string]$CertPath,
  [string]$CertPassword,
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [switch]$NoSign,
  [switch]$OneDir  # .549: build SamQL-AppWindow as a FOLDER (dist\\SamQL-AppWindow\\)
                   # + zip it for distribution -- no per-launch _MEI unpack,
                   # no "failed to remove temp dir" dialog, faster start.
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

# .506 / splash: strip baked-in backgrounds from public brand PNGs
# (logo.png splash mark, app-icon.png tab/PWA icon). The logo doctor keeps
# interior whites and only clears border-connected background. Missing
# files are skipped so a text-only extract still builds.
Write-Host "==> brand: making public logos transparent"
$env:PYTHONPATH = (Join-Path $Root "backend")
& $py -c @"
import json, sys
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
& $py (Join-Path $Root "tools\install_frontend_deps.py") `
  --frontend (Join-Path $Root "frontend") `
  --cache $npmCache
if ($LASTEXITCODE -ne 0) {
  Write-Error ("frontend npm install failed (exit $LASTEXITCODE). " +
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
  "duckdb", "pyarrow", "pandas", "sqlglot", "openpyxl", "ijson", "orjson", "tzdata"
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
if ($OneDir) {
  $env:SAMQL_ONEDIR = "1"
  Write-Host "    ONEDIR mode: SamQL-AppWindow will be a folder (dist\\SamQL-AppWindow\\)"
} else {
  Remove-Item Env:\\SAMQL_ONEDIR -ErrorAction SilentlyContinue
}
& $py -m PyInstaller --clean --noconfirm backend/samql.spec

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

# --- 4/4  Verify BOTH outputs, then optional code signing -----------------
# SamQL.exe (console server) and SamQL-AppWindow.exe (windowed launcher)
# are produced by the SAME spec from the SAME shared payload. Refuse a
# half-build: if either target is missing, distribution is incomplete.
$serverExe = Join-Path $Root "dist\SamQL.exe"
$appExeOnefile = Join-Path $Root "dist\SamQL-AppWindow.exe"
$appExeOnedir = Join-Path $Root "dist\SamQL-AppWindow\SamQL-AppWindow.exe"
if (-not (Test-Path $serverExe)) {
  Write-Error "Build incomplete: dist\SamQL.exe is missing."
  exit 1
}
if ($OneDir) {
  if (-not (Test-Path $appExeOnedir)) {
    Write-Error "Build incomplete: dist\SamQL-AppWindow\SamQL-AppWindow.exe is missing."
    exit 1
  }
} elseif (-not (Test-Path $appExeOnefile)) {
  Write-Error "Build incomplete: dist\SamQL-AppWindow.exe is missing."
  exit 1
}
Write-Host "==> 4/4  Both targets present (SamQL.exe + SamQL-AppWindow)"

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
if ($OneDir) {
  $feOnedir = Join-Path $Root "dist\SamQL-AppWindow\frontend_dist"
  if (Test-Path $feOnedir) { Remove-Item -Recurse -Force $feOnedir }
  Copy-Item -Recurse -Force $feSrc $feOnedir
  Write-Host "    OK: staged dist\SamQL-AppWindow\frontend_dist"
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
if ($OneDir) { $signTargets += $appExeOnedir } else { $signTargets += $appExeOnefile }

if ($NoSign) {
  Write-Host "    Skipping code signing (-NoSign)."
}
elseif (-not ($CertThumbprint -or $CertPath)) {
  Write-Host "    No signing certificate provided; leaving BOTH exes unsigned."
  Write-Host "         To sign, re-run with -CertThumbprint <thumb> or -CertPath <pfx>."
}
else {
  $signtool = Find-SignTool
  if (-not $signtool) {
    Write-Error "signtool.exe not found. Install the Windows 10/11 SDK, or add signtool to PATH."
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

if ($OneDir) {
  $folder = Join-Path $Root "dist\\SamQL-AppWindow"
  if (Test-Path $folder) {
    # ship the (already signed) server exe + shortcut icon INSIDE the folder
    # too, so the one folder is fully self-contained for a colleague.
    Copy-Item $serverExe $folder -Force
    if (Test-Path "$Root\\dist\\SamQL.ico") {
      Copy-Item "$Root\\dist\\SamQL.ico" $folder -Force
    }
    $zip = Join-Path $Root "dist\\SamQL-AppWindow.zip"
    Remove-Item $zip -ErrorAction SilentlyContinue
    Write-Host "==> Zipping the onedir folder for distribution..."
    Compress-Archive -Path $folder -DestinationPath $zip -Force
    Write-Host "    wrote $zip"
    Write-Host ""
    Write-Host "DISTRIBUTE: send dist\\SamQL-AppWindow.zip. The recipient"
    Write-Host "  EXTRACTS it (e.g. to C:\\SamQL) and runs SamQL-AppWindow.exe"
    Write-Host "  from INSIDE the extracted folder. No Python/Node needed."
  }
}
Write-Host ""
Write-Host "Done. Your build is in:  $Root\dist\"
Write-Host "  SamQL.exe            -- console server (+ --window native UI)"
if ($OneDir) {
  Write-Host "  SamQL-AppWindow\     -- windowed launcher folder (same payload)"
  Write-Host "Onedir: extract SamQL-AppWindow.zip and run the exe inside the folder."
} else {
  Write-Host "  SamQL-AppWindow.exe  -- windowed launcher (same payload as SamQL.exe)"
  Write-Host "Run either exe to launch; both ship the same frontend + load stack."
}
Get-ChildItem dist -ErrorAction SilentlyContinue
