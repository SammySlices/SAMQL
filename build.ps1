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
}
Push-Location frontend
npm ci
npm run build
Pop-Location

Write-Host "==> 2/4  Ensuring Python dependencies (engines, formats, build)"
$py = if ($env:PYTHON) { $env:PYTHON } else { "python" }
# Install everything the packaged app can use from the SAME manifest the
# Linux build uses (requirements-optional.txt) -- one source of truth, no
# drift. Each line is independent/best-effort; then the CRITICAL set is
# verified by import and the build STOPS if any is missing, because a
# binary without them fails on first use (the on-box openpyxl incident,
# 2026-07-02) or silently falls back to SQLite.
$req = Join-Path $PSScriptRoot "requirements-optional.txt"
if (Test-Path $req) {
    Get-Content $req | ForEach-Object {
        $pkg = $_.Trim()
        if ($pkg -eq "" -or $pkg.StartsWith("#")) { return }
        $mod = ($pkg -split "[<>=]")[0].Trim()
        & $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('$mod') else 1)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "    installing: $pkg"
            & $py -m pip install --user $pkg
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "    skipped $pkg (no compatible wheel?)"
            }
        }
    }
} else {
    Write-Warning "$req not found; the build may fall back to SQLite."
}
foreach ($m in @("duckdb", "pyarrow", "sqlglot", "openpyxl")) {
    & $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('$m') else 1)"
    if ($LASTEXITCODE -ne 0) {
        Write-Error ("critical dependency '$m' is not importable after " +
                     "install -- the packaged app would break. Fix the " +
                     "environment (venv active? proxy?) and re-run.")
        exit 1
    }
}
& $py -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('PyInstaller') else 1)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "    installing pyinstaller..."
  & $py -m pip install --user pyinstaller
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
    & $py -m pip install --user pywebview pythonnet
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

# --- 4/4  Optional code signing -------------------------------------------
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

$exe = Join-Path $Root "dist\SamQL.exe"
if ($NoSign) {
  Write-Host "==> 4/4  Skipping code signing (-NoSign)."
}
elseif (-not ($CertThumbprint -or $CertPath)) {
  Write-Host "==> 4/4  No signing certificate provided; leaving the .exe unsigned."
  Write-Host "         To sign, re-run with -CertThumbprint <thumb> or -CertPath <pfx>."
}
else {
  Write-Host "==> 4/4  Signing $exe"
  if (-not (Test-Path $exe)) { Write-Error "Build output not found: $exe" }
  $signtool = Find-SignTool
  if (-not $signtool) {
    Write-Error "signtool.exe not found. Install the Windows 10/11 SDK, or add signtool to PATH."
  }
  $signArgs = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
  if ($CertThumbprint) {
    $signArgs += @("/sha1", $CertThumbprint)
  }
  else {
    if (-not (Test-Path $CertPath)) { Write-Error "Certificate file not found: $CertPath" }
    $signArgs += @("/f", $CertPath)
    if ($CertPassword) { $signArgs += @("/p", $CertPassword) }
  }
  $signArgs += $exe
  & $signtool @signArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "Signing failed (signtool exit $LASTEXITCODE)." }
  Write-Host "    verifying signature..."
  & $signtool verify /pa /v $exe
  if ($LASTEXITCODE -ne 0) { Write-Error "Signature verification failed." }
  Write-Host "    signed and verified OK."
}

if ($OneDir) {
  $folder = Join-Path $Root "dist\\SamQL-AppWindow"
  if (Test-Path $folder) {
    # ship the server exe + shortcut icon INSIDE the folder too, so the
    # one folder is fully self-contained for a colleague.
    if (Test-Path "$Root\\dist\\SamQL.exe") {
      Copy-Item "$Root\\dist\\SamQL.exe" $folder -Force
    }
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
Get-ChildItem dist -ErrorAction SilentlyContinue
if ($OneDir) {
  Write-Host "Onedir: extract SamQL-AppWindow.zip and run the exe inside the folder."
} else {
  Write-Host "Run SamQL.exe to launch."
}
