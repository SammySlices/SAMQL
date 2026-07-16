<#
  Fetch-SamQL-Assistant.ps1 - download the offline SQL assistant pack.

  On a machine that CAN reach GitHub + Hugging Face, this fetches:
    * assistant\runtime\llama-server.exe  (+ companion DLLs)
    * assistant\models\<qwen-gguf>  (4B default; optional 7B)

  into .\assistant\. Models coexist under models\ -- fetching a larger
  size does not delete other GGUFs or the runtime (unless -Force re-downloads
  llama-server). Copy that folder to a locked-down work PC with SamQL.
  Runtime stays offline (no Ollama, no cloud APIs).

  Default SamQL builds (-AssistantPack runtime) already stage the llama.cpp
  runtime into AppWindow zips without a GGUF. Use -SkipModel to fetch only
  that runtime (same path build.ps1 uses when assistant/runtime is missing).
  Recipients drop a .gguf into the install-root Model\ folder (or
  assistant\models\).

  Windows PowerShell 5.1 compatible. Requires Python 3.10+.

  Examples:
    .\Fetch-SamQL-Assistant.ps1
    .\Fetch-SamQL-Assistant.ps1 -Model 4b
    .\Fetch-SamQL-Assistant.ps1 -Model 7b -Force
    .\Fetch-SamQL-Assistant.ps1 -SkipModel          # runtime only (no GGUF)
#>
[CmdletBinding()]
param(
  [string]$Root = "",
  [string]$Python = "",
  [switch]$Force,
  [ValidateSet("win-cpu", "linux-cpu", "macos-arm", "macos-x64")]
  [string]$Platform = "win-cpu",
  # 4b (default) | 7b -- omit to prompt interactively when possible
  [ValidateSet("4b", "4B", "7b", "7B")]
  [string]$Model = "",
  # Runtime-only: llama-server + DLLs, no Hugging Face GGUF download
  [Alias("RuntimeOnly")]
  [switch]$SkipModel
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
if ($SkipModel) {
  $toolArgs += "--skip-model"
  $toolArgs += "--no-prompt"
} elseif ($Model) {
  $toolArgs += @("--model", $Model.ToLowerInvariant())
}

$pythonLeaf = Split-Path -Leaf $Python
if ($SkipModel) {
  Write-Host "Fetching SamQL assistant runtime (llama-server only, no GGUF) into $Root\assistant ..." -ForegroundColor Cyan
} else {
  Write-Host "Fetching SamQL assistant pack into $Root\assistant ..." -ForegroundColor Cyan
}
if ($pythonLeaf -in @("py", "py.exe")) {
  & $Python -3 @toolArgs
} else {
  & $Python @toolArgs
}
if ($LASTEXITCODE -ne 0) {
  throw "Assistant pack download failed with exit code $LASTEXITCODE."
}

Write-Host "`nAssistant pack ready under: $(Join-Path $Root 'assistant')" -ForegroundColor Green
if ($SkipModel) {
  Write-Host "Runtime only (no GGUF). Drop a .gguf into install-root Model\ or assistant\models\."
} else {
  Write-Host "Copy the whole assistant\ folder next to SamQL on the work PC if needed."
}
