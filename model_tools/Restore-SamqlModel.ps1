<#
.SYNOPSIS
    Reassemble a GGUF model from the parts produced by Split-SamqlModel.ps1 and
    verify it is byte-identical to the original.

.DESCRIPTION
    Reads manifest.json from -PartsDir, verifies each part's SHA-256, then
    concatenates the parts (in manifest order) into a single output file and
    verifies the reassembled file's SHA-256 matches the original recorded in the
    manifest. Pure PowerShell + .NET, no external tools, works fully offline.

    Typical use: download every *.part??? asset + manifest.json from a GitHub
    Release into one folder, then run this script pointed at that folder.

.PARAMETER PartsDir
    Folder containing the downloaded parts and manifest.json.

.PARAMETER OutPath
    Output path for the reassembled .gguf. Defaults to <PartsDir>\<original name>.

.PARAMETER Force
    Overwrite an existing output file.

.EXAMPLE
    # Download the release assets, then restore
    gh release download <tag> --repo <owner/repo> --dir .\dl --pattern "*.part*"
    gh release download <tag> --repo <owner/repo> --dir .\dl --pattern "manifest.json"
    .\Restore-SamqlModel.ps1 -PartsDir .\dl

.EXAMPLE
    .\Restore-SamqlModel.ps1 -PartsDir .\dl -OutPath C:\models\qwen7b.gguf -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PartsDir,
    [string]$OutPath,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$manifestPath = Join-Path $PartsDir "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found in $PartsDir - download it from the release alongside the parts."
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if (-not $OutPath) { $OutPath = Join-Path $PartsDir $manifest.original }
if ((Test-Path -LiteralPath $OutPath) -and -not $Force) {
    throw "Output already exists: $OutPath (use -Force to overwrite)."
}

# ---- 1) Verify each part is present + intact --------------------------------
Write-Host "Verifying $($manifest.partCount) part(s)..."
foreach ($p in $manifest.parts) {
    $pp = Join-Path $PartsDir $p.name
    if (-not (Test-Path -LiteralPath $pp)) { throw "Missing part: $($p.name)" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $pp).Hash.ToLower()
    if ($actual -ne $p.sha256.ToLower()) {
        throw "Checksum mismatch on $($p.name) - re-download this part."
    }
    Write-Host "  ok: $($p.name)"
}

# ---- 2) Concatenate in manifest order --------------------------------------
Write-Host "Reassembling -> $OutPath"
$out = [System.IO.File]::Create($OutPath)
try {
    foreach ($p in $manifest.parts) {
        $pp = Join-Path $PartsDir $p.name
        $in = [System.IO.File]::OpenRead($pp)
        try { $in.CopyTo($out, 4MB) } finally { $in.Dispose() }
    }
}
finally { $out.Dispose() }

# ---- 3) Verify the reassembled file ----------------------------------------
$finalItem = Get-Item -LiteralPath $OutPath
if ($finalItem.Length -ne $manifest.totalBytes) {
    throw ("Size mismatch: got {0:N0} bytes, expected {1:N0}." -f $finalItem.Length, $manifest.totalBytes)
}
Write-Host "Hashing reassembled file..."
$finalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutPath).Hash.ToLower()
if ($finalHash -ne $manifest.sha256.ToLower()) {
    throw "FINAL checksum mismatch - the reassembled file is corrupt."
}

Write-Host ""
Write-Host "SUCCESS: $OutPath is byte-identical to the original ($($manifest.original))."
Write-Host ("  SHA-256: {0}" -f $finalHash)
Write-Host ("  Size:    {0:N0} bytes ({1:N2} GB)" -f $finalItem.Length, ($finalItem.Length / 1GB))
