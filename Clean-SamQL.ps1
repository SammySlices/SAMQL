# Clean-SamQL.ps1 -- run AFTER testing + building to reclaim every byte
# SamQL's workflow can leave behind: temp data, caches, and npm/build
# artifacts. Prints per-class sizes and a total; locked items survive as
# PARTIAL and clear on the next pass (or at the next SamQL open).
#
#   .\Clean-SamQL.ps1                    # safe default clean
#   .\Clean-SamQL.ps1 -WhatIf            # show what WOULD go, remove nothing
#   .\Clean-SamQL.ps1 -KeepConversionCache   # keep instant-reload parquet cache
#   .\Clean-SamQL.ps1 -NodeModules       # ALSO remove frontend node_modules
#                                        # (next test run needs npm install)
#   .\Clean-SamQL.ps1 -PipCache          # ALSO purge the venv's pip cache
param(
    [switch]$NodeModules,
    [switch]$KeepConversionCache,
    [switch]$PipCache,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:total = 0

function Size([string]$p) {
    if (-not (Test-Path $p)) { return 0 }
    $s = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue |
          Measure-Object Length -Sum).Sum
    if ($null -eq $s) { $s = 0 }
    return $s
}
function Zap([string]$p, [string]$label) {
    if (-not (Test-Path $p)) { return }
    $b = Size $p
    if ($WhatIf) {
        '{0,10:N1} MB  would remove   {1}' -f ($b / 1MB), $label
        return
    }
    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
    $left = Size $p
    if (Test-Path $p) {
        '{0,10:N1} MB  PARTIAL(lock)  {1}' -f ($left / 1MB), $label
    } else {
        '{0,10:N1} MB  removed        {1}' -f ($b / 1MB), $label
    }
    $script:total += ($b - $left)
}

# ---- guard: never clean under a running SamQL (locked files everywhere)
$busy = $false
try { $busy = [bool](Get-NetTCPConnection -LocalPort 8765 -State Listen `
                     -ErrorAction SilentlyContinue) } catch { }
if (-not $busy) {
    try { $busy = [bool](Get-Process samql* -ErrorAction SilentlyContinue) }
    catch { }
}
if ($busy) {
    Write-Warning ('SamQL looks RUNNING (port 8765 / samql process). ' +
                   'Close it first; a live instance holds locks and its ' +
                   'temp is deleted on exit anyway.')
    if (-not $WhatIf) { exit 1 }
}

Write-Host "`nSamQL post-run cleanup ($(Get-Date -Format s))" -ForegroundColor Cyan

# ---- 1) SamQL temp: instance dirs + strays; the conversion cache is
#         included by default (it is CACHED data) unless kept explicitly
$samqlTmp = Join-Path $env:TEMP 'samql'
if (Test-Path $samqlTmp) {
    Get-ChildItem $samqlTmp -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'filecache' } |
        ForEach-Object { Zap $_.FullName ('samql temp: ' + $_.Name) }
    if ($KeepConversionCache) {
        '{0,10}     kept        conversion cache (-KeepConversionCache)' -f ''
    } else {
        Zap (Join-Path $samqlTmp 'filecache') 'conversion cache (fc_*)'
    }
}
Get-ChildItem $env:TEMP -Filter 'samql_*' -ErrorAction SilentlyContinue |
    ForEach-Object { Zap $_.FullName ('stray: ' + $_.Name) }

# ---- 2) onefile installer leftovers (a RUNNING extraction is locked and
#         survives as PARTIAL -- that is the correct outcome)
Get-ChildItem $env:TEMP -Directory -Filter '_MEI*' `
    -ErrorAction SilentlyContinue |
    ForEach-Object { Zap $_.FullName ('installer leftover: ' + $_.Name) }

# ---- 3) build artifacts + python bytecode + pyinstaller cache
foreach ($d in @('backend\build', 'backend\dist', 'build', 'dist')) {
    Zap (Join-Path $repo $d) ('build artifact: ' + $d)
}
foreach ($root in @('backend', 'tests', 'tools')) {
    $base = Join-Path $repo $root
    if (Test-Path $base) {
        Get-ChildItem $base -Recurse -Directory -Filter '__pycache__' `
            -ErrorAction SilentlyContinue |
            ForEach-Object {
                Zap $_.FullName ('bytecode: ' +
                    $_.FullName.Substring($repo.Length + 1))
            }
    }
}
Zap (Join-Path $env:LOCALAPPDATA 'pyinstaller') 'pyinstaller cache'

# ---- 4) frontend build + vite cache (+ node_modules only on request)
Zap (Join-Path $repo 'frontend\dist') 'frontend dist'
Zap (Join-Path $repo 'frontend\node_modules\.vite') 'vite cache'
Zap (Join-Path $repo '.samql-npm-cache') 'SamQL isolated npm cache'
if ($NodeModules) {
    Zap (Join-Path $repo 'frontend\node_modules') 'node_modules (-NodeModules)'
}

# ---- 5) npm cache (measure, then let npm clean it properly)
$npmCache = Join-Path $env:LOCALAPPDATA 'npm-cache'
$b = Size $npmCache
if ($b -gt 0) {
    if ($WhatIf) {
        '{0,10:N1} MB  would remove   npm cache' -f ($b / 1MB)
    } else {
        try { npm cache clean --force 2>$null | Out-Null } catch { }
        $left = Size $npmCache
        '{0,10:N1} MB  removed        npm cache' -f (($b - $left) / 1MB)
        $script:total += ($b - $left)
    }
}

# ---- 6) pip cache (opt-in: re-downloads are slow behind the proxy)
if ($PipCache) {
    $pip = Join-Path $repo '.venv\Scripts\pip.exe'
    if (Test-Path $pip) {
        if ($WhatIf) { '           would purge    pip cache (-PipCache)' }
        else {
            try { & $pip cache purge 2>$null | Out-Null } catch { }
            '           purged         pip cache (-PipCache)'
        }
    }
}

Write-Host ("`n  TOTAL reclaimed: {0:N1} MB`n" -f ($script:total / 1MB)) `
    -ForegroundColor Green
