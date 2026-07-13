<#
  Decode-SamQL-APHEX[.]ps1 - decode a mail-safe A-P hexadecimal transport.

  This helper needs only Windows PowerShell 5.1. It validates the declared byte
  count and SHA-256 before atomically publishing the decoded full-source file.
  Both current DATA_END-terminated transports and legacy EOF-terminated
  transports are accepted. Run Expand-SamQL[.]ps1 on the decoded file afterward.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Source,
  [string]$Dest = ""
)

$ErrorActionPreference = "Stop"
$Source = (Resolve-Path -LiteralPath $Source).Path
$text = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
$beginMarker = "DATA_BEGIN"
$endMarker = "DATA_END"
$beginMatch = [regex]::Match($text, '(?m)^DATA_BEGIN\s*$')
if (-not $beginMatch.Success) {
  throw "APHEX transport is missing DATA_BEGIN."
}

$header = $text.Substring(0, $beginMatch.Index)
$payloadStart = $beginMatch.Index + $beginMatch.Length
$endMatch = [regex]::Match($text.Substring($payloadStart), '(?m)^DATA_END\s*$')
if ($endMatch.Success) {
  $payload = $text.Substring($payloadStart, $endMatch.Index)
  $trailing = $text.Substring($payloadStart + $endMatch.Index + $endMatch.Length)
  if ($trailing.Trim().Length -ne 0) {
    throw "APHEX transport contains unexpected data after DATA_END."
  }
} else {
  # Build 587-era transports ended at EOF. Preserve read compatibility.
  $payload = $text.Substring($payloadStart)
}

$nameMatch = [regex]::Match($header, '(?m)^Original file:\s*(?<v>.+?)\s*$')
$bytesMatch = [regex]::Match($header, '(?m)^Original bytes:\s*(?<v>\d+)\s*$')
$shaMatch = [regex]::Match($header, '(?mi)^Expected SHA256:\s*(?<v>[0-9a-f]{64})\s*$')
if (-not ($nameMatch.Success -and $bytesMatch.Success -and $shaMatch.Success)) {
  throw "APHEX header is missing Original file, Original bytes, or Expected SHA256."
}

$payload = [regex]::Replace($payload, '\s+', '')
if (-not $payload -or (($payload.Length % 2) -ne 0)) {
  throw "APHEX payload must contain an even number of A-P symbols."
}
if ($payload -notmatch '^[A-P]+$') {
  throw "APHEX payload contains a character outside A-P."
}

$decoded = New-Object byte[] ($payload.Length / 2)
$base = [int][char]'A'
for ($i = 0; $i -lt $payload.Length; $i += 2) {
  $high = ([int][char]$payload[$i]) - $base
  $low = ([int][char]$payload[$i + 1]) - $base
  $decoded[$i / 2] = [byte](($high -shl 4) -bor $low)
}

$expectedBytes = [long]$bytesMatch.Groups['v'].Value
if ($decoded.LongLength -ne $expectedBytes) {
  throw "Decoded byte count $($decoded.LongLength) does not match $expectedBytes."
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $actualSha = -join ($sha.ComputeHash($decoded) | ForEach-Object { $_.ToString('x2') })
} finally {
  $sha.Dispose()
}
$expectedSha = $shaMatch.Groups['v'].Value.ToLowerInvariant()
if ($actualSha -ne $expectedSha) {
  throw "Decoded SHA-256 $actualSha does not match $expectedSha."
}

if (-not $Dest) {
  $safeName = [IO.Path]::GetFileName($nameMatch.Groups['v'].Value.Trim())
  $Dest = Join-Path (Split-Path -Parent $Source) $safeName
}
$destFull = [IO.Path]::GetFullPath($Dest)
$destDir = Split-Path -Parent $destFull
if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}
$temp = $destFull + "." + [guid]::NewGuid().ToString("N") + ".tmp"
try {
  [IO.File]::WriteAllBytes($temp, $decoded)
  Move-Item -LiteralPath $temp -Destination $destFull -Force
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}

Write-Host "Decoded APHEX transport successfully." -ForegroundColor Green
Write-Host "  File:   $destFull"
Write-Host "  Bytes:  $expectedBytes"
Write-Host "  SHA256: $actualSha"
Write-Host "Next: run Expand-SamQL[.]ps1 -Source `"$destFull`" -Force"
