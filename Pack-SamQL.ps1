<#
  Pack-SamQL[.]ps1 - produce the canonical SamQL source release artifacts.

  The Python release facade validates release identity, saved-data declarations,
  SOURCE_MANIFEST exactness, section bytes, and the APHEX decode before it
  publishes anything. The output directory receives:

    samql_full_source_all_tests_ui_<build>.txt
    SAMQL_BUILD_<sequence>_EMAIL_SAFE_APHEX.txt
    SAMQL_BUILD_<sequence>_RELEASE_RECEIPT.json

  APHEX is reversible mail-safe encoding, not cryptographic encryption.
  Windows PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param(
  [string]$OutputDir = "",
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutputDir) {
  $OutputDir = Join-Path (Split-Path -Parent $Root) "samql-release"
}

if (-not $Python) {
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source; break }
  }
}
if (-not $Python) {
  throw "Python 3.10+ was not found. It is required on the build machine."
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$tool = Join-Path $Root "tools\release_artifacts.py"
if (-not (Test-Path -LiteralPath $tool)) {
  throw "Release tool missing: $tool"
}

$toolArgs = @($tool, "package", "--root", $Root, "--output-dir", $OutputDir)
$pythonLeaf = Split-Path -Leaf $Python
if ($pythonLeaf -in @("py", "py.exe", "py.exe")) {
  & $Python -3 @toolArgs
} else {
  & $Python @toolArgs
}
if ($LASTEXITCODE -ne 0) {
  throw "SamQL release packaging failed with exit code $LASTEXITCODE."
}

Write-Host "`nSamQL release package complete: $OutputDir" -ForegroundColor Green
