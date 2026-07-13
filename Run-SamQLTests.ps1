<#
  Run-SamQLTests.ps1 -- canonical SamQL test entry point.

  With no scope switches this delegates to Test-SamQL-All.ps1, which creates
  the isolated environment and runs every suite, including the real Playwright
  browser tests. This keeps the two familiar test-script names from producing
  different definitions of "all tests".

  BackendOnly / FrontendOnly / NoHttp / Build / Online / VerboseTests and
  passthrough arguments intentionally select the lightweight tests\run_tests.py
  path. Those scoped runs are partial and do not claim that Playwright passed.

  Usage:
      .\Run-SamQLTests.ps1                  # complete suite INCLUDING Playwright
      .\Run-SamQLTests.ps1 -SkipOnline      # complete suite, no public network
      .\Run-SamQLTests.ps1 -SkipBrowser     # explicit non-browser run
      .\Run-SamQLTests.ps1 -BackendOnly     # intentionally scoped/partial
      .\Run-SamQLTests.ps1 -FrontendOnly
      .\Run-SamQLTests.ps1 -Build           # scoped run_tests.py + Vite build
#>
[CmdletBinding()]
param(
  [switch]$BackendOnly,
  [switch]$FrontendOnly,
  [switch]$NoHttp,
  [switch]$Build,
  [switch]$Online,
  [switch]$VerboseTests,
  [switch]$SkipOnline,
  [switch]$SkipBrowser,
  [switch]$SkipInstall,
  [switch]$Clean,
  [ValidateSet("auto", "msedge", "chromium")]
  [string]$BrowserChannel = "auto",
  [string]$Python = "",
  [string]$NpmRegistry = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Passthrough
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

$scopeRequested = ($BackendOnly -or $FrontendOnly -or $NoHttp -or $Build -or
                   $Online -or $VerboseTests -or
                   ($Passthrough -and $Passthrough.Count -gt 0))
if (-not $scopeRequested) {
  $all = Join-Path $Root "Test-SamQL-All.ps1"
  if (-not (Test-Path -LiteralPath $all)) {
    Write-Error "Couldn't find Test-SamQL-All.ps1 beside this script."
  }
  $allArgs = @{}
  if ($SkipOnline) { $allArgs['SkipOnline'] = $true }
  if ($SkipBrowser) { $allArgs['SkipBrowser'] = $true }
  if ($SkipInstall) { $allArgs['SkipInstall'] = $true }
  if ($Clean) { $allArgs['Clean'] = $true }
  if ($BrowserChannel) { $allArgs['BrowserChannel'] = $BrowserChannel }
  if ($Python) { $allArgs['Python'] = $Python }
  if ($NpmRegistry) { $allArgs['NpmRegistry'] = $NpmRegistry }
  Write-Host "==> Complete mode: delegating to Test-SamQL-All.ps1 (Playwright enabled unless -SkipBrowser)" -ForegroundColor Cyan
  & $all @allArgs
  exit $LASTEXITCODE
}

if ($SkipOnline -or $SkipBrowser -or $SkipInstall -or $Clean -or
    $BrowserChannel -ne "auto" -or $Python -or $NpmRegistry) {
  Write-Warning "Complete-run switches are ignored because a scoped run_tests.py switch/argument was supplied."
}
Write-Warning "Scoped test mode selected; Playwright is not part of this partial run. Run without scope switches for the complete browser-inclusive gate."

# locate the test runner (this script may sit at the repo root)
$runner = Join-Path $Root "tests\run_tests.py"
if (-not (Test-Path -LiteralPath $runner)) {
  $runner = Join-Path (Get-Location) "tests\run_tests.py"
}
if (-not (Test-Path -LiteralPath $runner)) {
  Write-Error "Couldn't find tests\run_tests.py. Run this from the SamQL root, or reconstruct the tree first with Expand-SamQL.ps1."
}

# find Python 3 (prefer `python`, then the Windows launcher `py`, then python3)
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Error "Python 3 was not found on your PATH. Install Python 3.9+ from https://python.org"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "Node.js not found -- the frontend bundle/type-check/notebook-chaining tests will be skipped (everything else still runs)."
}

# map switches to run_tests.py flags
$flags = @()
if ($BackendOnly)  { $flags += "--backend-only" }
if ($FrontendOnly) { $flags += "--frontend-only" }
if ($NoHttp)       { $flags += "--no-http" }
if ($Build)        { $flags += "--build" }
if ($Online)       { $flags += "--online" }
if ($VerboseTests) { $flags += "--verbose" }
if ($Passthrough)  { $flags += $Passthrough }

Write-Host "==> $($py.Source) $runner $($flags -join ' ')"
& $py.Source $runner @flags
exit $LASTEXITCODE
