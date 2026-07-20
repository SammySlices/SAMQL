<#
.SYNOPSIS
    Download (optional) a GGUF model and split it into <2 GB parts for a
    GitHub Release, with a self-describing manifest for verified reassembly.

.DESCRIPTION
    GitHub Release assets are capped at 2 GB per file. This script takes one
    large .gguf (either downloaded from a URL or an existing local file) and
    splits it into fixed-size byte chunks that each fit under that cap. It
    writes a manifest.json describing the original file (name, size, SHA-256),
    the chunk size, and every part (name + SHA-256), so Restore-SamqlModel.ps1
    can concatenate the parts back into a byte-identical original and verify it.

    These are RAW byte chunks (not native gguf-split shards), so the model is
    NOT usable until reassembled with Restore-SamqlModel.ps1 -- which is exactly
    the "return it to its initial state" workflow. No external tools required
    (pure PowerShell + .NET); works offline once the source file is present.

.PARAMETER SourceUrl
    Direct URL to a .gguf to download first. Ignored if -SourcePath exists.
    Defaults to a single-file Qwen2.5-Coder-7B Q4_K_M GGUF (Apache-2.0).

.PARAMETER SourcePath
    Path to an already-downloaded .gguf. If it exists, no download happens.

.PARAMETER OutDir
    Folder to write the parts + manifest.json into. Created if missing.

.PARAMETER PartSizeMB
    Max size of each part in MB. Default 1900 (safe under the 2 GB cap).

.EXAMPLE
    # Download the default model and split it
    .\Split-SamqlModel.ps1 -OutDir .\dist\qwen7b

.EXAMPLE
    # Split a model you already have on disk into ~1.5 GB parts
    .\Split-SamqlModel.ps1 -SourcePath C:\models\my-model.gguf -OutDir .\dist -PartSizeMB 1500
#>
[CmdletBinding()]
param(
    [string]$SourceUrl = "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf?download=true",
    [string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$PartSizeMB = 1900
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PartSizeMB -lt 1 -or $PartSizeMB -gt 2000) {
    throw "PartSizeMB must be between 1 and 2000 (GitHub caps release assets at 2 GB/file)."
}

# ---- 1) Resolve / download the source .gguf ---------------------------------
if (-not $SourcePath) {
    # Derive a filename from the URL (strip any ?query).
    $leaf = ([System.Uri]$SourceUrl).AbsolutePath.Split("/")[-1]
    if (-not $leaf) { $leaf = "model.gguf" }
    $SourcePath = Join-Path $OutDir $leaf
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (Test-Path -LiteralPath $SourcePath) {
    Write-Host "Using existing source: $SourcePath"
}
else {
    Write-Host "Downloading model to: $SourcePath"
    Write-Host "  from: $SourceUrl"
    $downloaded = $false
    # Prefer BITS (resumable, low-memory, progress) when available.
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        try {
            Start-BitsTransfer -Source $SourceUrl -Destination $SourcePath -Description "SamQL model download"
            $downloaded = $true
        }
        catch {
            Write-Warning "BITS transfer failed ($($_.Exception.Message)); falling back to HttpClient."
        }
    }
    if (-not $downloaded) {
        # Streamed HttpClient download (does not buffer the whole file in memory).
        Add-Type -AssemblyName System.Net.Http
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromHours(6)
        try {
            $resp = $client.GetAsync($SourceUrl, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            $resp.EnsureSuccessStatusCode() | Out-Null
            $src = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $dst = [System.IO.File]::Create($SourcePath)
            try { $src.CopyTo($dst, 4MB) } finally { $dst.Dispose(); $src.Dispose() }
        }
        finally { $client.Dispose() }
    }
}

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Source file not found after download: $SourcePath"
}

$srcItem = Get-Item -LiteralPath $SourcePath
Write-Host ("Source size: {0:N0} bytes ({1:N2} GB)" -f $srcItem.Length, ($srcItem.Length / 1GB))

# ---- 2) Split into byte parts -----------------------------------------------
$partSize = [int64]$PartSizeMB * 1MB
$origName = $srcItem.Name
$parts = New-Object System.Collections.Generic.List[object]

$buffer = New-Object byte[] (4MB)
$in = [System.IO.File]::OpenRead($SourcePath)
try {
    $index = 0
    while ($true) {
        $written = [int64]0
        $index++
        $partName = "{0}.part{1:D3}" -f $origName, $index
        $partPath = Join-Path $OutDir $partName
        $out = [System.IO.File]::Create($partPath)
        try {
            while ($written -lt $partSize) {
                $toRead = [int][Math]::Min($buffer.Length, ($partSize - $written))
                $read = $in.Read($buffer, 0, $toRead)
                if ($read -le 0) { break }
                $out.Write($buffer, 0, $read)
                $written += $read
            }
        }
        finally { $out.Dispose() }

        if ($written -eq 0) {
            # Nothing went into this part (clean EOF on a boundary): drop it.
            Remove-Item -LiteralPath $partPath -Force
            $index--
            break
        }

        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $partPath).Hash.ToLower()
        $parts.Add([ordered]@{ name = $partName; bytes = $written; sha256 = $hash })
        Write-Host ("  wrote {0}  ({1:N0} bytes)" -f $partName, $written)

        if ($written -lt $partSize) { break }  # last (short) part
    }
}
finally { $in.Dispose() }

# ---- 3) Manifest ------------------------------------------------------------
Write-Host "Hashing original for the manifest..."
$origHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourcePath).Hash.ToLower()

$manifest = [ordered]@{
    schema      = 1
    original    = $origName
    totalBytes  = $srcItem.Length
    sha256      = $origHash
    partSizeMB  = $PartSizeMB
    partCount   = $parts.Count
    parts       = $parts
}
$manifestPath = Join-Path $OutDir "manifest.json"
($manifest | ConvertTo-Json -Depth 5) | Set-Content -Encoding ascii -LiteralPath $manifestPath

Write-Host ""
Write-Host "Done. $($parts.Count) part(s) + manifest.json in: $OutDir"
Write-Host "Upload every *.part??? file AND manifest.json to the GitHub Release, e.g.:"
Write-Host ("  gh release create <tag> --repo <owner/repo> --title <title> --notes <notes>")
Write-Host ("  gh release upload <tag> --repo <owner/repo> " + (Join-Path $OutDir '*.part*') + " " + $manifestPath)
Write-Host "Reassemble later with: .\Restore-SamqlModel.ps1 -PartsDir <download dir>"
