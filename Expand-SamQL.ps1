<#
  Expand-SamQL[.]ps1 - rebuild the complete SamQL project tree from a decoded
  full-source text bundle.

  Each bundled file begins with:
      ===== FILE: backend/samql_core/session.py =====

  Recommended upgrade command:
      powershell -ExecutionPolicy Bypass -File .\Expand-SamQL[.]ps1 `
        -Source .\samql_full_source_all_tests_ui_2026-07-13.594.txt `
        -Dest C:\SamQL\samql -Force

  When -Source is omitted, the script examines every *full_source*.txt beside
  the script and in the current directory, reads the build id from each bundle
  header, and selects the highest build. It does not silently prefer an older
  generic samql_full_source.txt.

  Updates are all-or-nothing. If destination files already exist, use -Force or
  approve one overwrite-all prompt. Individual files are never skipped because
  a partial upgrade can mix VERSION, backend, frontend, and tests from different
  builds.
#>
[CmdletBinding()]
param(
  [string]$Source,
  [string]$Dest = ".",
  [switch]$Force
)
$ErrorActionPreference = "Stop"

function Get-BundleBuild([string]$Path) {
  try {
    $head = (Get-Content -LiteralPath $Path -TotalCount 16 -Encoding UTF8) -join "`n"
    $m = [regex]::Match($head, '(?m)^#\s*build:\s*(?<build>\d{4}-\d{2}-\d{2}\.\d+)\s*$')
    if ($m.Success) { return $m.Groups['build'].Value }
  } catch { }
  return $null
}

function Get-BuildSortKey([string]$Build) {
  $m = [regex]::Match($Build, '^(?<date>\d{4}-\d{2}-\d{2})\.(?<seq>\d+)$')
  if (-not $m.Success) { return '00000000.000000000000' }
  $datePart = $m.Groups['date'].Value.Replace('-', '')
  $seq = [long]$m.Groups['seq'].Value
  return ('{0}.{1:D12}' -f $datePart, $seq)
}

# --- locate the newest decoded full-source bundle --------------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) {
  $candidatePaths = New-Object System.Collections.Generic.List[string]
  foreach ($root in @((Get-Location).Path, $here) | Select-Object -Unique) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Filter '*full_source*.txt' -File `
      -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $candidatePaths.Contains($_.FullName)) {
          [void]$candidatePaths.Add($_.FullName)
        }
      }
  }

  $ranked = @(
    foreach ($path in $candidatePaths) {
      $build = Get-BundleBuild $path
      if ($build) {
        [pscustomobject]@{
          Path = $path
          Build = $build
          SortKey = Get-BuildSortKey $build
          Modified = (Get-Item -LiteralPath $path).LastWriteTimeUtc
        }
      }
    }
  )
  if ($ranked.Count -gt 0) {
    $chosen = $ranked | Sort-Object `
      @{Expression = 'SortKey'; Descending = $true}, `
      @{Expression = 'Modified'; Descending = $true} | Select-Object -First 1
    $Source = $chosen.Path
    Write-Host "==> Auto-selected highest decoded build $($chosen.Build): $Source"
  }
}

if (-not $Source -or -not (Test-Path -LiteralPath $Source)) {
  Write-Error ('Could not find a decoded full-source bundle. Pass -Source ' +
               '<path to samql_full_source...txt>. APHEX transport files must ' +
               'be decoded first.')
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$bundleBuild = Get-BundleBuild $Source
Write-Host "==> Reading bundle: $Source"
if ($bundleBuild) { Write-Host "==> Bundle build:   $bundleBuild" }

# Read and decode once with strict UTF-8. Hash the original bytes rather than a
# PowerShell re-encoding so the header authenticates the exact transported body.
$bundleBytes = [IO.File]::ReadAllBytes($Source)
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
try {
  $raw = $strictUtf8.GetString($bundleBytes)
} catch {
  Write-Error "The decoded source bundle is not valid UTF-8: $($_.Exception.Message)"
}

# --- verify the complete bundle before touching the destination ------------
$firstSection = $raw.IndexOf("===== FILE:", [StringComparison]::Ordinal)
if ($firstSection -lt 0) {
  Write-Error "The decoded source bundle contains no FILE sections."
}
$bundleHeader = $raw.Substring(0, $firstSection)
$declaredCountMatch = [regex]::Match(
  $bundleHeader, '(?m)^#\s*files:\s*(?<count>\d+)\s*$'
)
$declaredShaMatch = [regex]::Match(
  $bundleHeader, '(?m)^#\s*sha256:\s*(?<sha>[0-9a-fA-F]{64})\b'
)
if (-not ($declaredCountMatch.Success -and $declaredShaMatch.Success)) {
  Write-Error "The bundle header is missing its declared file count or section-body SHA-256."
}

$rawHeaderRx = [regex]'(?m)^===== FILE: (?<path>.*?) =====[ \t]*\r?\n'
$rawMatches = $rawHeaderRx.Matches($raw)
$declaredCount = [int]$declaredCountMatch.Groups['count'].Value
if ($rawMatches.Count -ne $declaredCount) {
  Write-Error ("Bundle declares {0} files but contains {1} FILE sections." -f `
               $declaredCount, $rawMatches.Count)
}

$bodyOffset = $strictUtf8.GetByteCount($bundleHeader)
$bodyLength = $bundleBytes.Length - $bodyOffset
if ($bodyLength -le 0) {
  Write-Error "The bundle section body is empty."
}
$bodyBytes = New-Object byte[] $bodyLength
[Array]::Copy($bundleBytes, $bodyOffset, $bodyBytes, 0, $bodyLength)
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $actualBodySha = -join ($sha.ComputeHash($bodyBytes) |
    ForEach-Object { $_.ToString('x2') })
} finally {
  $sha.Dispose()
}
$declaredBodySha = $declaredShaMatch.Groups['sha'].Value.ToLowerInvariant()
if ($actualBodySha -ne $declaredBodySha) {
  Write-Error ("Bundle section-body SHA-256 mismatch: expected {0}, got {1}. No destination files were changed." -f $declaredBodySha, $actualBodySha)
}

# --- un-defang -------------------------------------------------------------
# Only restore tokens that the APHEX packager can introduce.  A global
# "[.]" replacement corrupts legitimate source literals (for example regex
# fragments and the release tooling's own mail-safe marker handling).
$dangerousExtensionPattern =
  '(?i)\[\.\](exe|dll|msi|bat|cmd|scr|vbs|ps1|jar)(?=$|[^A-Za-z0-9])'
$raw = [regex]::Replace($raw, $dangerousExtensionPattern, '.$1')

# --- split and validate every file section ---------------------------------
$headerRx = [regex]'(?m)^===== FILE: (?<path>.*?) =====[ \t]*\r?\n'
$matches = $headerRx.Matches($raw)
if ($matches.Count -ne $declaredCount) {
  Write-Error ("Bundle section count changed during decode: expected {0}, got {1}." -f
               $declaredCount, $matches.Count)
}

# Resolve paths without creating the destination. All integrity, manifest,
# duplicate, case-collision, and path checks complete before pruning/writing.
$destRoot = [IO.Path]::GetFullPath($Dest)
if (-not $destRoot.EndsWith([IO.Path]::DirectorySeparatorChar)) {
  $destPrefix = $destRoot + [IO.Path]::DirectorySeparatorChar
} else {
  $destPrefix = $destRoot
}
$sections = New-Object System.Collections.Generic.List[object]
$seenBundlePaths = @{}
for ($i = 0; $i -lt $matches.Count; $i++) {
  $m = $matches[$i]
  $rel = $m.Groups['path'].Value.Trim()
  if (-not $rel) { Write-Error "Bundle contains an empty FILE path." }
  $relKey = $rel.ToLowerInvariant()
  if ($seenBundlePaths.ContainsKey($relKey)) {
    Write-Error "Bundle contains a duplicate or case-colliding FILE section: $rel"
  }
  $seenBundlePaths[$relKey] = $true
  $startAt = $m.Index + $m.Length
  $endAt = if ($i + 1 -lt $matches.Count) { $matches[$i + 1].Index } else { $raw.Length }
  $relLocal = $rel -replace '/', [IO.Path]::DirectorySeparatorChar
  $full = [IO.Path]::GetFullPath((Join-Path $destRoot $relLocal))
  if (-not ($full.Equals($destRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($destPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
    Write-Error "Bundle contains a suspicious path outside destination: $rel"
  }
  [void]$sections.Add([pscustomobject]@{
    Rel = $rel
    RelLocal = $relLocal
    Full = $full
    Start = $startAt
    End = $endAt
  })
}

# The embedded manifest must enumerate every section in the same order. This
# catches a validly re-hashed but incomplete/reordered hand-edited bundle.
$manifestSections = @($sections | Where-Object {
  $_.Rel.Equals('SOURCE_MANIFEST.txt', [StringComparison]::OrdinalIgnoreCase)
})
if ($manifestSections.Count -ne 1) {
  Write-Error "Bundle must contain exactly one SOURCE_MANIFEST.txt section."
}
$manifestSection = $manifestSections[0]
$manifestContent = $raw.Substring(
  $manifestSection.Start, $manifestSection.End - $manifestSection.Start
)
$manifestEntries = @(
  $manifestContent -split '\r?\n' | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
)
if ($manifestEntries.Count -ne $sections.Count) {
  Write-Error ("Embedded SOURCE_MANIFEST lists {0} files but bundle contains {1}." -f
               $manifestEntries.Count, $sections.Count)
}
for ($i = 0; $i -lt $sections.Count; $i++) {
  if (-not [string]::Equals(
      [string]$manifestEntries[$i], [string]$sections[$i].Rel,
      [StringComparison]::Ordinal)) {
    Write-Error ("Embedded SOURCE_MANIFEST differs at entry {0}: manifest '{1}', section '{2}'." -f
                 ($i + 1), $manifestEntries[$i], $sections[$i].Rel)
  }
}
Write-Host "==> Verified bundle integrity: $declaredCount files, SHA256 $actualBodySha"
Write-Host "==> Verified embedded SOURCE_MANIFEST section order"

$destRoot = (New-Item -ItemType Directory -Path $destRoot -Force).FullName
if (-not $destRoot.EndsWith([IO.Path]::DirectorySeparatorChar)) {
  $destPrefix = $destRoot + [IO.Path]::DirectorySeparatorChar
} else {
  $destPrefix = $destRoot
}

# Exact-source upgrades must also REMOVE files that belonged to an older
# bundle but no longer exist in this one. Otherwise TypeScript/Python globbing
# still sees retired files (for example the old MSW test server) and a clean
# build fails even though every current file was overwritten successfully.
# Restrict pruning to source/test roots owned by the bundle; node_modules,
# dist/build output, Playwright reports, caches, and user data are untouched.
$expectedFiles = @{}
foreach ($section in $sections) {
  $expectedFiles[$section.Full.ToLowerInvariant()] = $true
}
$managedRelRoots = @(
  '.github\workflows',
  'backend\samql_core',
  'frontend\e2e',
  'frontend\src',
  'tests',
  'tools'
)
$staleFiles = New-Object System.Collections.Generic.List[object]
foreach ($managedRel in $managedRelRoots) {
  $managedFull = Join-Path $destRoot $managedRel
  if (-not (Test-Path -LiteralPath $managedFull)) { continue }
  Get-ChildItem -LiteralPath $managedFull -Recurse -File -Force `
    -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $expectedFiles.ContainsKey($_.FullName.ToLowerInvariant())) {
        [void]$staleFiles.Add($_)
      }
    }
}

$existing = @($sections | Where-Object { Test-Path -LiteralPath $_.Full })
if (($existing.Count -gt 0 -or $staleFiles.Count -gt 0) -and -not $Force) {
  $selectedBuild = if ($bundleBuild) { $bundleBuild } else { 'selected' }
  $ans = Read-Host ("Destination contains {0} bundle file(s) and {1} " +
                    "obsolete managed source file(s). Replace it exactly " +
                    "with build {2}? [y/N]" -f
                    $existing.Count, $staleFiles.Count, $selectedBuild)
  if ($ans -notin 'y', 'Y') {
    throw 'Cancelled before writing. Re-run with -Force to perform a complete upgrade.'
  }
  $Force = $true
}

foreach ($stale in $staleFiles) {
  $relStale = $stale.FullName.Substring($destPrefix.Length)
  Remove-Item -LiteralPath $stale.FullName -Force
  Write-Host "  - stale $relStale"
}
if ($staleFiles.Count -gt 0) {
  Write-Host "==> Pruned $($staleFiles.Count) obsolete managed source file(s)."
}

$written = 0
foreach ($section in $sections) {
  $content = ($raw.Substring($section.Start,
                             $section.End - $section.Start) `
              -replace '(\r?\n)+\z', '') + "`n"
  $dir = Split-Path -Parent $section.Full
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [IO.File]::WriteAllText(
    $section.Full,
    $content,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "  + $($section.RelLocal)"
  $written++
}

# Remove now-empty directories left by retired files, deepest first.
foreach ($managedRel in $managedRelRoots) {
  $managedFull = Join-Path $destRoot $managedRel
  if (-not (Test-Path -LiteralPath $managedFull)) { continue }
  Get-ChildItem -LiteralPath $managedFull -Recurse -Directory -Force `
    -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | ForEach-Object {
      if (@(Get-ChildItem -LiteralPath $_.FullName -Force `
            -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $_.FullName -Force
      }
    }
}

# Brand drop-in folder. Binary logo assets (logo.png / app-icon.png /
# samql.ico) are not in SOURCE_MANIFEST, so a fresh expand would otherwise
# leave nowhere for the builder to put them. Create an empty frontend/public
# AFTER managed empty-dir pruning so it is never swept away.
$publicDir = Join-Path $destRoot 'frontend\public'
if (-not (Test-Path -LiteralPath $publicDir)) {
  New-Item -ItemType Directory -Path $publicDir -Force | Out-Null
  Write-Host "==> Created empty frontend\public (drop logo.png / app-icon.png here)"
}

# --- verify one exact source identity after extraction ---------------------
$issues = New-Object System.Collections.Generic.List[string]
$leftoverManaged = New-Object System.Collections.Generic.List[string]
foreach ($managedRel in $managedRelRoots) {
  $managedFull = Join-Path $destRoot $managedRel
  if (-not (Test-Path -LiteralPath $managedFull)) { continue }
  Get-ChildItem -LiteralPath $managedFull -Recurse -File -Force `
    -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $expectedFiles.ContainsKey($_.FullName.ToLowerInvariant())) {
        [void]$leftoverManaged.Add($_.FullName.Substring($destPrefix.Length))
      }
    }
}
if ($leftoverManaged.Count -gt 0) {
  [void]$issues.Add("obsolete managed source remains: " +
                    (($leftoverManaged | Select-Object -First 10) -join ', '))
}
$versionPath = Join-Path $destRoot 'VERSION'
$initPath = Join-Path $destRoot 'backend\samql_core\__init__.py'
$packagePath = Join-Path $destRoot 'frontend\package.json'
$lockPath = Join-Path $destRoot 'frontend\package-lock.json'
$releasePath = Join-Path $destRoot 'RELEASE_MANIFEST.json'
foreach ($required in @($versionPath, $initPath, $packagePath, $lockPath, $releasePath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    [void]$issues.Add("missing $required")
  }
}

if ($issues.Count -eq 0) {
  $versionText = Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8
  $initText = Get-Content -LiteralPath $initPath -Raw -Encoding UTF8
  $vm = [regex]::Match($versionText, '(?m)^Product version:\s*(?<v>\S+)\s*$')
  $bm = [regex]::Match($versionText, '(?m)^Current build:\s*(?<b>\S+)\s*$')
  $iv = [regex]::Match($initText, '(?m)^__version__\s*=\s*["''](?<v>[^"'']+)["'']\s*$')
  $ib = [regex]::Match($initText, '(?m)^BUILD\s*=\s*["''](?<b>[^"'']+)["'']\s*$')
  $pkg = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $release = Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8 | ConvertFrom-Json

  # npm lockfile v3 legally uses an empty-string property at packages[""].
  # Windows PowerShell 5.1 ConvertFrom-Json rejects that key with:
  #   Cannot process argument because the value of argument "name" is not valid.
  # Read only the two generated version fields instead of deserializing the
  # entire lockfile. This remains compatible with Windows PowerShell 5.1 and
  # PowerShell 7 and still detects a stale top-level or root package version.
  $lockText = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8
  $lockVersionMatch = [regex]::Match(
    $lockText,
    '(?s)\A\s*\{\s*"name"\s*:\s*"[^"]*"\s*,\s*"version"\s*:\s*"(?<v>[^"]+)"'
  )
  $lockRootVersionMatch = [regex]::Match(
    $lockText,
    '(?s)"packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]*"\s*,\s*"version"\s*:\s*"(?<v>[^"]+)"'
  )
  $lockVersion = if ($lockVersionMatch.Success) {
    $lockVersionMatch.Groups['v'].Value
  } else { $null }
  $lockRootVersion = if ($lockRootVersionMatch.Success) {
    $lockRootVersionMatch.Groups['v'].Value
  } else { $null }

  $productVersion = if ($vm.Success) { $vm.Groups['v'].Value } else { $null }
  $currentBuild = if ($bm.Success) { $bm.Groups['b'].Value } else { $null }
  $backendVersion = if ($iv.Success) { $iv.Groups['v'].Value } else { $null }
  $backendBuild = if ($ib.Success) { $ib.Groups['b'].Value } else { $null }
  $entryOk = $false
  if ($productVersion -and $currentBuild) {
    $entryPattern = '(?m)^build\s+' + [regex]::Escape($currentBuild) +
                    '\s+\(v' + [regex]::Escape($productVersion) + '\)\s*$'
    $entryOk = [regex]::IsMatch($versionText, $entryPattern)
  }

  if (-not $productVersion) { [void]$issues.Add('VERSION product version missing') }
  if (-not $currentBuild) { [void]$issues.Add('VERSION current build missing') }
  if ($backendVersion -ne $productVersion) {
    [void]$issues.Add("backend version '$backendVersion' != VERSION '$productVersion'")
  }
  if ($backendBuild -ne $currentBuild) {
    [void]$issues.Add("backend build '$backendBuild' != VERSION '$currentBuild'")
  }
  if ([string]$pkg.version -ne $productVersion) {
    [void]$issues.Add("package.json '$($pkg.version)' != VERSION '$productVersion'")
  }
  if ([string]$lockVersion -ne $productVersion) {
    [void]$issues.Add("package-lock.json '$lockVersion' != VERSION '$productVersion'")
  }
  if ([string]$lockRootVersion -ne $productVersion) {
    [void]$issues.Add("package-lock root '$lockRootVersion' != VERSION '$productVersion'")
  }
  if ([string]$release.version -ne $productVersion) {
    [void]$issues.Add("RELEASE_MANIFEST version '$($release.version)' != VERSION '$productVersion'")
  }
  if ([string]$release.build -ne $currentBuild) {
    [void]$issues.Add("RELEASE_MANIFEST build '$($release.build)' != VERSION '$currentBuild'")
  }
  if ([int]$release.sourceFileCount -ne $written) {
    [void]$issues.Add("RELEASE_MANIFEST sourceFileCount '$($release.sourceFileCount)' != expanded '$written'")
  }
  if ($bundleBuild -and $currentBuild -ne $bundleBuild) {
    [void]$issues.Add("expanded build '$currentBuild' != bundle header '$bundleBuild'")
  }
  if (-not $entryOk) {
    [void]$issues.Add("VERSION has no changelog entry for build $currentBuild (v$productVersion)")
  }
}

if ($issues.Count -gt 0) {
  Write-Error ("Expanded identity check failed:`n  - " + ($issues -join "`n  - "))
}

Write-Host ""
Write-Host "Done. Wrote $written files into: $destRoot"
Write-Host "Expanded identity check passed: SamQL v$productVersion build $currentBuild"
Write-Host "Source bundle used: $Source"
Write-Host "This is a complete source + tests + UI extract (harnesses, Playwright,"
Write-Host "lockfile, and Test-SamQL-All). For a packaged exe with the full load"
Write-Host "stack (DuckDB, openpyxl, ijson, ...), run .\build[.]ps1 - it installs"
Write-Host "requirements-optional.txt into the build Python and refuses to ship"
Write-Host "without those imports."
Write-Host "Run the complete suite from this exact destination:"
Write-Host "    cd `"$destRoot`""
Write-Host "    .\Test-SamQL-All[.]ps1"
