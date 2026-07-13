# Run the SamQL test suite (backend + UI) from PowerShell.
# Usage:
#   .\tests\run_tests.ps1                 # everything
#   .\tests\run_tests.ps1 --backend-only
#   .\tests\run_tests.ps1 --build -v
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Error "Python 3 was not found on your PATH."
  exit 2
}

& $py.Source (Join-Path $dir "run_tests.py") @args
exit $LASTEXITCODE
