<#
  Fetch-SamQL-Assistant.ps1 - download the offline SQL assistant pack.

  On a machine that CAN reach GitHub + Hugging Face, this fetches:
    * assistant\runtime\llama-server.exe  (+ companion DLLs)
    * assistant\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

  into .\assistant\. Copy that folder to a locked-down work PC with SamQL.
  Runtime stays offline (no Ollama, no cloud APIs).

  Windows PowerShell 5.1 compatible. Requires Python 3.10+.
#>
[CmdletBinding()]
param(
  [string]$Root = "",
  [string]$Python = "",
  [switch]$Force,
  [ValidateSet("win-cpu", "linux-cpu", "macos-arm", "macos-x64")]
  [string]$Platform = "win-cpu"
)

$ErrorActionPreference = "Stop"
if (-not $Root) {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

if (-not $Python) {
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source; break }
  }
}
if (-not $Python) {
  throw "Python 3.10+ was not found. It is required to run the download helper."
}

$tool = Join-Path $Root "tools\fetch_assistant_pack.py"
if (-not (Test-Path -LiteralPath $tool)) {
  throw "Download tool missing: $tool"
}

$toolArgs = @($tool, "--root", $Root, "--platform", $Platform)
if ($Force) { $toolArgs += "--force" }

$pythonLeaf = Split-Path -Leaf $Python
Write-Host "Fetching SamQL assistant pack into $Root\assistant …" -ForegroundColor Cyan
if ($pythonLeaf -in @("py", "py.exe")) {
  & $Python -3 @toolArgs
} else {
  & $Python @toolArgs
}
if ($LASTEXITCODE -ne 0) {
  throw "Assistant pack download failed with exit code $LASTEXITCODE."
}

Write-Host "`nAssistant pack ready under: $(Join-Path $Root 'assistant')" -ForegroundColor Green
Write-Host "Copy the whole assistant\ folder next to SamQL on the work PC if needed."
