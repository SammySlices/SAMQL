<#
Start-SamQL-AppWindow.ps1 -- open SamQL in its OWN app window, with a
splash screen and no lingering console.

The standard flow (build.ps1 + a Chrome tab) is untouched: this script
is a personal launcher. On launch it immediately relaunches itself
HIDDEN (the console flashes for a fraction of a second and is gone; a
console you launched it FROM is never touched), shows a small splash
while it works, reuses a server already answering on the port (the
usual case when the backend runs from PyCharm), starts one only when
the port is closed, then opens a NATIVE pywebview window (via the
packaged SamQL-AppWindow.exe, or python backend\launcher_app.py when
pywebview is importable) -- falling back to a chromeless Edge/Chrome
"--app=" window only when no pywebview launcher is available -- and
closes the splash. Failures appear ON the splash in red for a few
seconds, since there is no console to read.

PowerShell 5.1 safe: no ternaries, no null-coalescing, no stderr
redirection of native commands. Splash is WinForms (always present).

Usage:
  .\Start-SamQL-AppWindow.ps1                 # port 8765, auto browser
  .\Start-SamQL-AppWindow.ps1 -Port 8770 -Browser chrome
  .\Start-SamQL-AppWindow.ps1 -NoSplash       # hidden, no splash
  .\Start-SamQL-AppWindow.ps1 -KeepConsole    # debug: stay visible
  .\Start-SamQL-AppWindow.ps1 -NoServer       # just open the window
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [ValidateSet("auto", "edge", "chrome")]
    [string]$Browser = "auto",
    [string]$WindowSize = "1600,1000",
    [switch]$NoServer,
    [switch]$NoSplash,
    [switch]$KeepConsole,
    [switch]$HiddenRelaunch   # internal: set by the visible first pass
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$self = $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port"

# WinForms is required for message-loop pumping during port / browser
# waits. Load it before any path that may call Application.DoEvents --
# including -KeepConsole / -NoSplash which skip Show-Splash (where
# Add-Type used to live).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- 0) shed the console: relaunch hidden, forwarding every option ----
if (-not $HiddenRelaunch -and -not $KeepConsole) {
    $fwd = @("-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", "`"$self`"",
             "-HiddenRelaunch",
             "-Port", "$Port",
             "-Browser", "$Browser",
             "-WindowSize", "$WindowSize")
    if ($NoServer) { $fwd += "-NoServer" }
    if ($NoSplash) { $fwd += "-NoSplash" }
    Start-Process -FilePath "powershell.exe" -ArgumentList $fwd `
        -WindowStyle Hidden | Out-Null
    exit 0
}

# ---- splash (WinForms; skipped with -NoSplash or -KeepConsole) ----
$script:Splash = $null
$script:SplashLabel = $null

function Show-Splash {
    if ($NoSplash -or $KeepConsole) { return }
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = "None"
    $f.StartPosition = "CenterScreen"
    $f.Size = New-Object System.Drawing.Size(360, 150)
    $f.BackColor = [System.Drawing.Color]::FromArgb(16, 20, 16)
    $f.TopMost = $true
    $f.ShowInTaskbar = $false
    $t = New-Object System.Windows.Forms.Label
    $t.Text = "SamQL"
    $t.Font = New-Object System.Drawing.Font("Segoe UI", 22,
        [System.Drawing.FontStyle]::Bold)
    $t.ForeColor = [System.Drawing.Color]::FromArgb(84, 214, 96)
    $t.AutoSize = $false
    $t.TextAlign = "MiddleCenter"
    $t.Dock = "Top"
    $t.Height = 60
    $s = New-Object System.Windows.Forms.Label
    $s.Text = "Starting..."
    $s.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $s.ForeColor = [System.Drawing.Color]::Gainsboro
    $s.AutoSize = $false
    $s.TextAlign = "MiddleCenter"
    $s.Dock = "Top"
    $s.Height = 34
    $p = New-Object System.Windows.Forms.ProgressBar
    $p.Style = "Marquee"
    $p.MarqueeAnimationSpeed = 28
    $p.Dock = "Bottom"
    $p.Height = 14
    $f.Controls.Add($p)
    $f.Controls.Add($s)
    $f.Controls.Add($t)
    $f.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $script:Splash = $f
    $script:SplashLabel = $s
}

function Set-SplashText {
    param([string]$Text, [switch]$IsError)
    if ($null -ne $script:SplashLabel) {
        $script:SplashLabel.Text = $Text
        if ($IsError) {
            $script:SplashLabel.ForeColor =
                [System.Drawing.Color]::FromArgb(240, 96, 96)
        }
        [System.Windows.Forms.Application]::DoEvents()
    }
    if ($KeepConsole) { Write-Host $Text }
}

function Close-Splash {
    if ($null -ne $script:Splash) {
        $script:Splash.Close()
        $script:Splash.Dispose()
        $script:Splash = $null
    }
}

function Write-LauncherLog {
    param([string]$Msg)
    try {
        $dir = Join-Path $env:TEMP "samql"
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir | Out-Null
        }
        $log = Join-Path $dir "launcher.log"
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -Path $log -Value "$stamp $Msg"
        $lines = Get-Content -Path $log
        if ($lines.Count -gt 200) {
            $lines | Select-Object -Last 200 | Set-Content -Path $log
        }
    } catch { }
}

function Fail-Visibly {
    param([string]$Msg)
    Write-LauncherLog "ERROR $Msg"
    Set-SplashText -Text $Msg -IsError
    if ($null -ne $script:Splash) {
        $until = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $until) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 80
        }
        Close-Splash
    }
    exit 1
}

function Test-SamQLPort {
    param([int]$P)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect("127.0.0.1", $P, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(400)
        if ($ok -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# HTTP readiness (not TCP alone). Opening WebView2 on a listening-but-not-
# yet-accepting socket hangs the first navigation in the listen backlog and
# shows a white / "Not Responding" window. Proxy-free: managed boxes can
# hijack even localhost through a system proxy (.509).
function Test-SamQLHealth {
    param([int]$P)
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = $null
        $wc.Headers.Add("Cache-Control", "no-cache")
        $body = $wc.DownloadString("http://127.0.0.1:$P/api/health")
        return ($body -match '"app"\s*:\s*"SamQL"')
    } catch {
        return $false
    }
}

# Best-effort BootBar stage from /api/health (empty string when unavailable).
function Get-SamQLHealthStage {
    param([int]$P)
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = $null
        $wc.Headers.Add("Cache-Control", "no-cache")
        $body = $wc.DownloadString("http://127.0.0.1:$P/api/health")
        if ($body -match '"stage"\s*:\s*"([^"]+)"') {
            return $Matches[1]
        }
    } catch { }
    return ""
}

function Find-BrowserExe {
    param([string]$Which)
    $pf = $env:ProgramFiles
    $pfx86 = ${env:ProgramFiles(x86)}
    $edgePaths = @(
        (Join-Path $pfx86 "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $pf "Microsoft\Edge\Application\msedge.exe")
    )
    $chromePaths = @(
        (Join-Path $pf "Google\Chrome\Application\chrome.exe"),
        (Join-Path $pfx86 "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LocalAppData "Google\Chrome\Application\chrome.exe")
    )
    $order = @()
    if ($Which -eq "edge") { $order = @($edgePaths) }
    elseif ($Which -eq "chrome") { $order = @($chromePaths) }
    else { $order = @($chromePaths) + @($edgePaths) }
    foreach ($p in $order) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

Show-Splash

# Tracks a server WE started (PassThru) so boot wait can fail immediately
# if the child exits -- matches launcher_app._SERVER_PROC semantics.
$script:ServerProc = $null

# ---- 1) server: reuse when up; start only when the port is closed ----
if (-not (Test-SamQLPort -P $Port)) {
    if ($NoServer) {
        Fail-Visibly "Port $Port is closed (and -NoServer was given)."
    }
    Set-SplashText "No server on port $Port -- starting one..."
    # Source checkout: prefer backend\server.py so a rebuilt frontend/dist
    # and current APIs (e.g. tableFields) win over a stale dist\samql.exe
    # that still embeds an older UI/API. Packaged installs have no
    # backend\server.py beside the launcher, so they keep using the exe.
    # Declaration order matches start preference (contract-tested).
    $serverPy = Join-Path $here "backend\server.py"
    $exe = Join-Path $here "samql.exe"
    $distExe = Join-Path $here "dist\samql.exe"
    if (Test-Path $serverPy) {
        $py = Get-Command python -ErrorAction SilentlyContinue
        if ($null -eq $py) {
            Fail-Visibly "python is not on PATH (needed for backend\server.py)."
        }
        # Pass --port so -Port N matches the health wait below (default 8765).
        $script:ServerProc = Start-Process -FilePath $py.Source `
            -ArgumentList @("`"$serverPy`"", "--no-browser", "--port", "$Port") `
            -WorkingDirectory $here -WindowStyle Minimized -PassThru
    } elseif (Test-Path $exe) {
        $script:ServerProc = Start-Process -FilePath $exe `
            -ArgumentList @("--no-browser", "--port", "$Port") `
            -WorkingDirectory $here -PassThru
    } elseif (Test-Path $distExe) {
        $script:ServerProc = Start-Process -FilePath $distExe `
            -ArgumentList @("--no-browser", "--port", "$Port") `
            -WorkingDirectory $here -PassThru
    } else {
        Fail-Visibly "Nothing to start: no samql exe, no backend server."
    }
} elseif (-not (Test-SamQLHealth -P $Port)) {
    Fail-Visibly "Port $Port is in use by something that is not SamQL."
} else {
    Set-SplashText "Reusing the server on port $Port."
}

# Heartbeat wait for /api/health (not TCP alone). Tracks launcher_app:
#   SERVER_BOOT_IDLE_TIMEOUT_S = 90, SERVER_BOOT_TIMEOUT_S = 300
# Child exit fails immediately; process-alive + TCP/stage reset idle;
# absolute ceiling still caps hung-but-alive. Open once health says SamQL
# (warming may still be true -- do not hold the splash for session warm).
if (-not (Test-SamQLHealth -P $Port)) {
    Set-SplashText "Waiting for SamQL to be ready..."
    $bootBudgetS = 300
    $bootIdleS = 90
    $deadline = (Get-Date).AddSeconds($bootBudgetS)
    $waitStarted = Get-Date
    $lastBeat = $waitStarted
    $lastLog = $waitStarted
    $sawTcp = $false
    $lastStage = ""
    Write-LauncherLog "INFO waiting for /api/health on port $Port (idle ${bootIdleS}s / absolute ${bootBudgetS}s)"
    while (-not (Test-SamQLHealth -P $Port)) {
        $now = Get-Date
        if ($null -ne $script:ServerProc) {
            try { $script:ServerProc.Refresh() } catch { }
            if ($script:ServerProc.HasExited) {
                $code = $script:ServerProc.ExitCode
                Fail-Visibly "The SamQL server process exited before it was ready (exit $code)."
            }
            # Process still alive counts as a heartbeat.
            $lastBeat = $now
        }
        if (Test-SamQLPort -P $Port) {
            if (-not $sawTcp) {
                $sawTcp = $true
                Write-LauncherLog "INFO TCP bound on port $Port (still waiting for /api/health)"
            }
            $lastBeat = $now
            $stage = Get-SamQLHealthStage -P $Port
            if ($stage -and ($stage -ne $lastStage)) {
                $lastStage = $stage
                $lastBeat = $now
                Write-LauncherLog "INFO boot stage: $stage"
                Set-SplashText "Starting SamQL ($stage)..."
            }
        }
        if (($now - $lastBeat).TotalSeconds -ge $bootIdleS) {
            Fail-Visibly "The SamQL server stopped making boot progress on port $Port (no heartbeat for ${bootIdleS}s)."
        }
        if ($now -gt $deadline) {
            Fail-Visibly "The server did not come up on port $Port within ${bootBudgetS}s (see the error log in Settings)."
        }
        if (($now - $lastLog).TotalSeconds -ge 15) {
            $elapsed = [int](($now - $waitStarted).TotalSeconds)
            $idleElapsed = [int](($now - $lastBeat).TotalSeconds)
            $stageNote = ""
            if ($lastStage) { $stageNote = ", stage=$lastStage" }
            Write-LauncherLog "INFO still waiting for /api/health on port $Port ($elapsed s elapsed, idle ${idleElapsed}s / abs ${bootBudgetS}s$stageNote)"
            $lastLog = $now
        }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 300
    }
    Set-SplashText "Server is up."
}

# ---- 2) the app window ----
# .486: prefer a NATIVE pywebview window over an Edge --app window. The
# build ships SamQL-AppWindow.exe, which opens SamQL in a window IT owns
# -- its own taskbar icon, no browser chrome, and none of the Edge
# icon-stamping further down. Hand off to it (the server is already up, so
# --no-server); or, in a source checkout, to python backend\launcher_app.py
# when pywebview is importable. Only when no pywebview launcher exists do we
# fall through to the Edge/Chrome --app window below.
$nativeExe = $null
# Prefer an already-shipped AppWindow beside the repo, then the default
# onedir layout (dist\SamQL-AppWindow\...), then the opt-in onefile exe.
# Missing the onedir path used to skip the packaged window and fall
# through to python/Edge even when a fresh build was present.
foreach ($cand in @((Join-Path $here "SamQL-AppWindow.exe"),
                    (Join-Path $here "dist\SamQL-AppWindow\SamQL-AppWindow.exe"),
                    (Join-Path $here "dist\SamQL-AppWindow.exe"))) {
    if (Test-Path $cand) { $nativeExe = $cand; break }
}
if ($null -ne $nativeExe) {
    Set-SplashText "Opening the SamQL window..."
    Write-LauncherLog "INFO native pywebview window via $nativeExe"
    Close-Splash
    Start-Process -FilePath $nativeExe `
        -ArgumentList @("--port", "$Port", "--window-size", "$WindowSize",
                        "--no-server") | Out-Null
    exit 0
}
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
$launcherPy = Join-Path $here "backend\launcher_app.py"
if (($null -ne $pyCmd) -and (Test-Path $launcherPy)) {
    # stdout-only probe (no stderr redirection -> PS5.1-safe; find_spec
    # does not import webview, just reports whether it is installed).
    $hasWv = & $pyCmd.Source -c "import importlib.util as u,sys; sys.stdout.write('1' if u.find_spec('webview') else '0')"
    if ($hasWv -eq "1") {
        Set-SplashText "Opening the SamQL window..."
        Write-LauncherLog "INFO native pywebview window via python launcher_app.py"
        Close-Splash
        & $pyCmd.Source "$launcherPy" "--port" "$Port" `
            "--window-size" "$WindowSize" "--no-server"
        exit 0
    }
}

# ---- Edge/Chrome --app window (fallback: no pywebview launcher found) ----
$bx = Find-BrowserExe -Which $Browser
if ($null -eq $bx) {
    Set-SplashText "No Chrome or Edge found; opening a tab instead."
    Close-Splash
    Start-Process $url
    exit 0
}
Set-SplashText "Opening the app window..."
$bargs = @("--app=$url")
if ($WindowSize -match '^\d+,\d+$') {
    $bargs += "--window-size=$WindowSize"
}
Start-Process -FilePath $bx -ArgumentList $bargs | Out-Null
# hold the splash until the APP WINDOW itself is up: poll for a browser
# window titled "SamQL" (the document title), not a blind sleep
$browserProc = [IO.Path]::GetFileNameWithoutExtension($bx)
# Tracks launcher_app.APP_WINDOW_WAIT_S -- branding only; miss is a WARN.
$appWindowWaitS = 75
$appDeadline = (Get-Date).AddSeconds($appWindowWaitS)
$appUp = $false
while ((Get-Date) -lt $appDeadline) {
    $hit = Get-Process -Name $browserProc -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*SamQL*" }
    if ($hit) { $appUp = $true; break }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 250
}
if (-not $appUp) {
    Write-LauncherLog "WARN app window title not seen within ${appWindowWaitS}s (opened anyway)"
}
Close-Splash

# ---- .469: brand the WINDOW itself -------------------------------------
# An Edge --app window is supposed to adopt the page favicon, but on
# managed boxes the favicon service can be starved (policy, cache) and
# the frame falls back to the Edge logo. So this script stamps the icon
# natively, exactly like the packaged launcher: fetch /favicon.ico from
# the running server (the header names the art source), WM_SETICON the
# window, set the AppUserModelID so the taskbar stops grouping under
# Edge, and restamp a few times so ours is the LAST writer. Failures
# only WARN -- the app itself is already up.
if ($appUp -and $hit) {
    try {
        $hwnd = ($hit | Select-Object -First 1).MainWindowHandle
        $icoPath = Join-Path $env:TEMP "samql_window_icon.ico"
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$url/favicon.ico" `
            -OutFile $icoPath -PassThru -TimeoutSec 5
        $brand = $resp.Headers['X-SamQL-Brand']
        Write-LauncherLog "INFO window icon source: $brand"
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace SamQLBrand {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint i, out PropKey key);
    int GetValue(ref PropKey key, out PropVariant pv);
    int SetValue(ref PropKey key, ref PropVariant pv);
    int Commit();
  }

  public static class Native {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadImage(IntPtr h, string name, uint type,
                                   int cx, int cy, uint load);
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, uint msg,
                                     IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(
        IntPtr hwnd, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);

    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, WM_SETICON = 0x80;

    public static bool SetIcon(IntPtr hwnd, string path) {
      IntPtr big = LoadImage(IntPtr.Zero, path, IMAGE_ICON, 32, 32,
                             LR_LOADFROMFILE);
      IntPtr small = LoadImage(IntPtr.Zero, path, IMAGE_ICON, 16, 16,
                               LR_LOADFROMFILE);
      if (big == IntPtr.Zero && small == IntPtr.Zero) return false;
      if (big != IntPtr.Zero)
        SendMessage(hwnd, WM_SETICON, (IntPtr)1, big);
      if (small != IntPtr.Zero)
        SendMessage(hwnd, WM_SETICON, (IntPtr)0, small);
      return true;
    }

    static bool SetProp(IntPtr hwnd, uint pid, string val) {
      Guid iid = typeof(IPropertyStore).GUID;
      IPropertyStore ps;
      if (SHGetPropertyStoreForWindow(hwnd, ref iid, out ps) != 0
          || ps == null) return false;
      // fmtid 9F4C2855... : pid 5 = AppUserModel_ID,
      //                     pid 3 = AppUserModel_RelaunchIconResource
      PropKey key = new PropKey {
        fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
        pid = pid
      };
      PropVariant pv = new PropVariant {
        vt = 31, p = Marshal.StringToCoTaskMemUni(val)
      };
      try {
        if (ps.SetValue(ref key, ref pv) != 0) return false;
        return ps.Commit() == 0;
      } finally {
        Marshal.FreeCoTaskMem(pv.p);
        Marshal.ReleaseComObject(ps);
      }
    }

    public static bool SetAumid(IntPtr hwnd, string id) {
      return SetProp(hwnd, 5, id);
    }

    // Windows reads RelaunchIconResource to choose the TASKBAR button
    // icon -- setting it to our .ico makes the taskbar show SamQL even
    // when Edge would otherwise supply its own logo. Format: "path,index".
    public static bool SetRelaunchIcon(IntPtr hwnd, string icoPath) {
      return SetProp(hwnd, 3, icoPath + ",0");
    }
  }
}
'@
        $okIco = [SamQLBrand.Native]::SetIcon($hwnd, $icoPath)
        $okId  = [SamQLBrand.Native]::SetAumid($hwnd, 'SamQL.App.2')
        $okRe  = [SamQLBrand.Native]::SetRelaunchIcon($hwnd, $icoPath)
        Write-LauncherLog ("INFO window stamp: icon=$okIco aumid=$okId " +
                           "relaunchIcon=$okRe")
        # .475: Edge can repaint the frame icon well after load (a
        # deferred favicon fetch, a profile sync). Re-stamp on a longer
        # schedule so ours is reliably the last writer -- and re-assert
        # the AUMID too, so a late Edge repaint can't re-group us under
        # its own taskbar button.
        foreach ($delay in 2, 3, 5, 8, 15, 30, 60) {
            Start-Sleep -Seconds $delay
            [SamQLBrand.Native]::SetIcon($hwnd, $icoPath) | Out-Null
            [SamQLBrand.Native]::SetAumid($hwnd, 'SamQL.App.2') | Out-Null
            [SamQLBrand.Native]::SetRelaunchIcon($hwnd, $icoPath) |
                Out-Null
        }
    } catch {
        Write-LauncherLog "WARN window branding failed: $_"
    }
}
exit 0
