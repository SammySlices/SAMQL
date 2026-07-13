<#
  One-command SamQL test bootstrap.

  Creates an isolated Python environment, installs every backend test
  dependency and the locked frontend dependency tree, then runs the complete
  Python, HTTP, DuckDB, benchmark, TypeScript, ESLint, Vite and browser suites.

  Windows uses the installed Microsoft Edge channel by default, avoiding a
  Playwright Chromium download on managed corporate networks. Frontend packages
  install through an isolated cache with EINTEGRITY recovery; checksum
  verification is never disabled. npm audit is
  enforced when the configured registry supports it; a registry-side
  ENOAUDIT/400 response is reported as an environment warning rather than a
  product-test failure.
#>
[CmdletBinding()]
param(
  [switch]$SkipOnline,
  [switch]$SkipBrowser,
  [switch]$SkipInstall,
  [switch]$Clean,
  [ValidateSet("auto", "msedge", "chromium")]
  [string]$BrowserChannel = "auto",
  [string]$Python = "",
  [string]$NpmRegistry = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "SamQL complete test plan" -ForegroundColor White
Write-Host "  Backend / HTTP / DuckDB / component / build tests: ENABLED"
if ($SkipOnline) {
  Write-Warning "  Public-network tests: SKIPPED by -SkipOnline"
} else {
  Write-Host "  Public-network tests: ENABLED"
}
if ($SkipBrowser) {
  Write-Warning "  Playwright browser tests: SKIPPED by -SkipBrowser"
} else {
  Write-Host "  Playwright browser tests: ENABLED (mandatory for a full pass)"
}

function Step([string]$Text) {
  Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

function Run-Native([string]$Label, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

if ($Clean) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ".samql-test-venv"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "frontend\node_modules"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "frontend\dist"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "frontend\test-results"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "frontend\playwright-report"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ".samql-npm-cache"
}

if (-not $Python) {
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source; break }
  }
}
if (-not $Python) {
  throw "Python 3.10+ was not found. Install Python, then rerun this script."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Node.js/npm was not found. Install Node.js 20.19+ (or 22.12+)."
}

$Lock = Join-Path $Root "frontend\package-lock.json"

$Venv = Join-Path $Root ".samql-test-venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
  Step "Creating isolated Python test environment"
  if ((Split-Path -Leaf $Python) -in @("py", "py.exe")) {
    & $Python -3 -m venv $Venv
  } else {
    & $Python -m venv $Venv
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$VenvPython = (Resolve-Path -LiteralPath $VenvPython).Path

# Older Expand-SamQL releases only overwrote files and could leave retired
# source/test files behind. Prune those bundle-owned trees before TypeScript,
# ESLint, compileall, or test discovery can see an obsolete file.
Step "Pruning obsolete managed source files"
& $VenvPython (Join-Path $Root "tools\prune_stale_source.py") `
  --root $Root `
  --manifest (Join-Path $Root "SOURCE_MANIFEST.txt")
if ($LASTEXITCODE -ne 0) {
  throw "Could not prune obsolete managed source files from an older SamQL build."
}

# Keep npm's dependency graph and integrity hashes pinned while removing only
# absolute registry tarball URLs. This makes the lockfile portable between the
# public npm registry and corporate mirrors, and safely repairs a lockfile that
# was regenerated on a machine with a private registry configured.
Step "Normalizing portable frontend lockfile"
& $VenvPython (Join-Path $Root "tools\normalize_npm_lock.py") --write $Lock
if ($LASTEXITCODE -ne 0) {
  throw "Could not normalize frontend/package-lock.json for this machine."
}

Step "Verifying release identity, compatibility, and source manifest"
& $VenvPython (Join-Path $Root "tools\release_artifacts.py") verify-tree --root $Root
if ($LASTEXITCODE -ne 0) {
  throw "SamQL release preflight failed."
}

if (-not $SkipInstall) {
  Step "Installing backend test dependencies"
  & $VenvPython -m pip install --upgrade pip wheel
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $VenvPython -m pip install -r (Join-Path $Root "requirements-test.txt")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Step "Installing locked frontend dependencies"
  $npmInstallArgs = @(
    (Join-Path $Root "tools\install_frontend_deps.py"),
    "--frontend", (Join-Path $Root "frontend"),
    "--cache", (Join-Path $Root ".samql-npm-cache")
  )
  if ($NpmRegistry) {
    $npmInstallArgs += @("--registry", $NpmRegistry)
  }
  & $VenvPython @npmInstallArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Locked frontend dependency installation failed after integrity-safe recovery attempts."
  }

  Push-Location (Join-Path $Root "frontend")
  try {
    Step "Checking frontend dependency audit"
    # Windows PowerShell 5.1 converts native stderr into a terminating
    # NativeCommandError when ErrorActionPreference is Stop. Capture npm's
    # streams through temporary files so an unsupported corporate audit
    # endpoint can be classified below instead of aborting the whole suite.
    $auditStdout = Join-Path $env:TEMP ("samql-npm-audit-out-" + [guid]::NewGuid().ToString("N") + ".txt")
    $auditStderr = Join-Path $env:TEMP ("samql-npm-audit-err-" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
      $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
      if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction Stop) }
      # Equivalent native command: npm audit --audit-level=high
      # Keep the exact command visible in logs while Start-Process captures
      # Windows PowerShell 5.1 stderr safely.
      Write-Host "Running: npm audit --audit-level=high"
      $auditArgs = @("audit", "--audit-level=high")
      $auditProc = Start-Process -FilePath $npmCmd.Source `
        -ArgumentList $auditArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $auditStdout `
        -RedirectStandardError $auditStderr
      $auditCode = $auditProc.ExitCode
      $auditOutput = ((Get-Content -LiteralPath $auditStdout -Raw -ErrorAction SilentlyContinue) +
                      (Get-Content -LiteralPath $auditStderr -Raw -ErrorAction SilentlyContinue))
    } finally {
      Remove-Item -LiteralPath $auditStdout, $auditStderr -Force -ErrorAction SilentlyContinue
    }
    Write-Host $auditOutput
    if ($auditCode -ne 0) {
      if ($auditOutput -match "audit endpoint returned an error|ENOAUDIT|400 Bad Request|404 Not Found") {
        Write-Warning "The configured npm registry does not provide a compatible audit endpoint. Installation succeeded; audit was skipped by the registry."
      } else {
        throw "npm audit reported high-severity vulnerabilities or another actionable failure."
      }
    }
  } finally {
    Pop-Location
  }
}

Step "Compiling all Python sources"
& $VenvPython -m compileall -q backend tests tools
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "Running deterministic release/package regression"
& $VenvPython "tests\test_release_hardening.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "Running complete Python, HTTP, frontend contract and React component suite"
$mainArgs = @("tests\run_tests.py", "--build")
if (-not $SkipOnline) { $mainArgs += "--online" }
& $VenvPython @mainArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "Running SQLite and DuckDB optimization suite"
& $VenvPython "tests\test_optimizations_dual_engine.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "Running adaptive resources, parallel branches and persistent-cache suite"
& $VenvPython "tests\test_nodeflow_resources.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "Running benchmark harness self-test"
& $VenvPython "tests\benchmark_workloads.py" --self-test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipBrowser) {
  Step "Running UI tests (Playwright; Microsoft Edge on Windows)"
  Push-Location (Join-Path $Root "frontend")
  try {
    $chosen = $BrowserChannel
    if ($chosen -eq "auto") {
      $chosen = if ($IsWindows -or $env:OS -eq "Windows_NT") { "msedge" } else { "chromium" }
    }

    if ($chosen -eq "chromium" -and -not $SkipInstall) {
      Step "Installing Playwright Chromium"
      npx playwright install chromium
      if ($LASTEXITCODE -ne 0) {
        throw "Playwright Chromium installation failed. On managed Windows rerun with -BrowserChannel msedge, or use -SkipBrowser if browser automation is blocked by policy."
      }
    }

    $listener = $null
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $listener = Get-NetTCPConnection -LocalPort 8765 -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($listener) {
      throw "Port 8765 is already in use by process $($listener.OwningProcess). Stop the existing SamQL server before browser tests."
    }

    $oldChannel = $env:PLAYWRIGHT_BROWSER_CHANNEL
    $oldPython = $env:SAMQL_TEST_PYTHON
    $oldCI = $env:CI
    try {
      # These are the same UI-test settings users previously had to enter
      # manually from the frontend folder. Keep them in the all-tests runner
      # so the real browser suite is part of every normal run.
      $env:SAMQL_TEST_PYTHON = $VenvPython
      $env:PLAYWRIGHT_BROWSER_CHANNEL = $chosen
      $env:CI = "1"

      Write-Host "UI test folder: $((Get-Location).Path)"
      Write-Host "UI test Python: $env:SAMQL_TEST_PYTHON"
      Write-Host "UI browser channel: $env:PLAYWRIGHT_BROWSER_CHANNEL"
      Write-Host "UI fresh-server mode (CI): $env:CI"

      # Prove that Playwright is installed and that the repository actually
      # contains discoverable E2E tests before starting the browser/server.
      # A missing test directory must never produce a misleading green run.
      $listStdout = Join-Path $env:TEMP ("samql-playwright-list-out-" + [guid]::NewGuid().ToString("N") + ".txt")
      $listStderr = Join-Path $env:TEMP ("samql-playwright-list-err-" + [guid]::NewGuid().ToString("N") + ".txt")
      try {
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction Stop }
        Write-Host "Running: npm run test:e2e -- --list"
        $listProc = Start-Process -FilePath $npmCmd.Source `
          -ArgumentList @("run", "test:e2e", "--", "--list") `
          -NoNewWindow -Wait -PassThru `
          -RedirectStandardOutput $listStdout `
          -RedirectStandardError $listStderr
        $listCode = $listProc.ExitCode
        $listOutput = ((Get-Content -LiteralPath $listStdout -Raw -ErrorAction SilentlyContinue) +
                       (Get-Content -LiteralPath $listStderr -Raw -ErrorAction SilentlyContinue))
      } finally {
        Remove-Item -LiteralPath $listStdout, $listStderr -Force -ErrorAction SilentlyContinue
      }
      Write-Host $listOutput
      if ($listCode -ne 0) {
        throw "Playwright test discovery failed with exit code $listCode."
      }
      $totalMatch = [regex]::Match($listOutput, '(?im)Total:\s*(?<count>\d+)\s+tests?')
      if (-not $totalMatch.Success) {
        throw "Playwright discovery completed but its test total could not be confirmed."
      }
      $playwrightCount = [int]$totalMatch.Groups['count'].Value
      if ($playwrightCount -lt 1) {
        throw "Playwright discovery returned zero tests; refusing a false-green full run."
      }
      Write-Host "Playwright discovery confirmed $playwrightCount E2E tests." -ForegroundColor Green

      Write-Host "Running: npm run test:e2e"
      & $npmCmd.Source run test:e2e
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      Write-Host "PLAYWRIGHT UI TESTS PASSED ($playwrightCount tests)" -ForegroundColor Green
    } finally {
      if ($null -eq $oldChannel) { Remove-Item Env:PLAYWRIGHT_BROWSER_CHANNEL -ErrorAction SilentlyContinue } else { $env:PLAYWRIGHT_BROWSER_CHANNEL = $oldChannel }
      if ($null -eq $oldPython) { Remove-Item Env:SAMQL_TEST_PYTHON -ErrorAction SilentlyContinue } else { $env:SAMQL_TEST_PYTHON = $oldPython }
      if ($null -eq $oldCI) { Remove-Item Env:CI -ErrorAction SilentlyContinue } else { $env:CI = $oldCI }
    }
  } finally {
    Pop-Location
  }
}

if ($SkipBrowser) {
  Write-Host "`nSAMQL NON-BROWSER TESTS PASSED (Playwright skipped explicitly)" -ForegroundColor Yellow
} else {
  Write-Host "`nALL SAMQL TESTS PASSED, INCLUDING PLAYWRIGHT" -ForegroundColor Green
}
