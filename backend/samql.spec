# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build spec for SamQL.

Build self-contained AppWindow (+ server sidecar) binaries that bundle the
Python backend, the built React frontend, and whichever optional acceleration
libraries happen to be installed in the build environment.

Usage (from the repository root, after building the frontend):

    cd frontend && npm install && npm run build && cd ..
    # Preferred (matches build.ps1 / build.sh default):
    set SAMQL_ONEDIR=1
    pyinstaller backend/samql.spec

Primary product: ``dist/SamQL-AppWindow/`` (onedir) or
``dist/SamQL-AppWindow.exe`` (onefile). ``dist/SamQL.exe`` remains a
console/server sidecar from the same shared payload — not the promoted
browser-tab distribution artifact.

Nothing here is required at runtime beyond the Python standard library;
DuckDB, pyarrow, sqlglot, pyodbc, openpyxl and pywebview are detected and
bundled only if present, so the build works with a bare interpreter too.
"""
import importlib.util
import os

from PyInstaller.utils.hooks import collect_all

# .549: ONEDIR packaging for the AppWindow. build.ps1 / build.sh default to
# SAMQL_ONEDIR=1 so dist/SamQL-AppWindow/ is a FOLDER (exe + pre-extracted
# _internal/) instead of a single self-extracting SamQL-AppWindow.exe.
# Onedir runs with NO per-launch _MEI extraction -- so the "failed to remove
# temporary directory" bootloader dialog is structurally impossible, startup
# skips the re-unpack+AV-scan, and the runtime layout stops shifting under a
# temp dir each launch. Distribute the folder as a .zip; recipients extract
# it and run the exe inside. Pass -OneFile / --onefile to clear this flag.
# The SamQL.exe server sidecar is unchanged either way.
SAMQL_ONEDIR = os.environ.get("SAMQL_ONEDIR", "").strip() in (
    "1", "true", "yes", "on")

# Optional SQL assistant pack (llama-server + GGUF). Set by build.ps1/build.sh
# when the user chooses packaging mode embed. Default "runtime" mode stages
# llama-server beside dist/ WITHOUT embedding (and WITHOUT a GGUF).
SAMQL_ASSISTANT_EMBED = os.environ.get("SAMQL_ASSISTANT_EMBED", "").strip() in (
    "1", "true", "yes", "on")

# ``__file__`` is not defined inside a spec; SPECPATH is provided by
# PyInstaller and points at the directory containing this file (backend/).
HERE = os.path.abspath(SPECPATH)            # noqa: F821  (injected)
REPO = os.path.dirname(HERE)
FRONTEND_DIST = os.path.join(REPO, "frontend", "dist")

datas = []
binaries = []
hiddenimports = ["samql_core"]

# ---- bundle the built frontend (served from sys._MEIPASS/frontend_dist) ----
# Refuse to ship a placeholder UI. An empty/missing dist used to only WARN
# (and the warning was accidentally attached to the icon for/else), so builds
# could succeed while SamQL.exe showed "React frontend has not been built".
_fe_index = os.path.join(FRONTEND_DIST, "index.html")
_fe_assets = os.path.join(FRONTEND_DIST, "assets")
if not (os.path.isdir(FRONTEND_DIST)
        and os.path.isfile(_fe_index)
        and os.path.isdir(_fe_assets)):
    raise SystemExit(
        "\n[samql.spec] refusing to package: frontend/dist is missing or "
        "incomplete (need index.html + assets/).\n"
        "             Build it first:  cd frontend && npm ci && npm run build\n"
        "             Or re-run build.ps1 / build.sh from the repo root.\n"
    )
datas.append((FRONTEND_DIST, "frontend_dist"))
print("[samql.spec] bundling frontend_dist from %s" % FRONTEND_DIST)

# ---- optional offline SQL assistant pack (mode embed only) ---------------
# Ships llama-server + companion libs + a GGUF inside the frozen payload
# (sys._MEIPASS/assistant). Modes lean / runtime / post leave this off;
# runtime and post stage assistant/ beside dist/ after PyInstaller instead
# (runtime = no GGUF).
if SAMQL_ASSISTANT_EMBED:
    _asst = os.path.join(REPO, "assistant")
    _bin_win = os.path.join(_asst, "runtime", "llama-server.exe")
    _bin_nix = os.path.join(_asst, "runtime", "llama-server")
    _models = os.path.join(_asst, "models")
    _has_bin = os.path.isfile(_bin_win) or os.path.isfile(_bin_nix)
    _has_model = False
    if os.path.isdir(_models):
        _has_model = any(
            name.lower().endswith(".gguf") for name in os.listdir(_models)
        )
    if not (_has_bin and _has_model):
        raise SystemExit(
            "\n[samql.spec] SAMQL_ASSISTANT_EMBED=1 but assistant/ is incomplete.\n"
            "             Need assistant/runtime/llama-server[.exe] and a .gguf under\n"
            "             assistant/models/. Run tools/fetch_assistant_pack.py first,\n"
            "             or choose build packaging mode 1/2 instead.\n"
        )
    datas.append((_asst, "assistant"))
    print("[samql.spec] EMBEDDING assistant pack from %s (~+1 GiB)" % _asst)
else:
    print("[samql.spec] assistant pack not embedded (lean / runtime / post mode)")

# .519: the SERVER exe bundles samql.ico too -- SamQL.exe --window now sets
# the Form icon exactly like the AppWindow launcher, so it needs the art.
for _ic in (os.path.join(REPO, "samql.ico"), os.path.join(HERE, "samql.ico")):
    if os.path.isfile(_ic):
        datas.append((_ic, "."))
        break
else:
    print(
        "\n[samql.spec] NOTE: no samql.ico found at repo root or backend/.\n"
        "             The exe will use the generated brand icon.\n"
    )

# ---- required load/export stack (must be present for distribution) ----
# tzdata / pytz are included because pyarrow and pandas import them
# *dynamically* to handle timezone-aware timestamps, so PyInstaller's static
# analysis misses them -- which is why a frozen build could report "pytz not
# installed" on a query with TIMESTAMP WITH TIME ZONE columns even though it
# was installed in the build environment.
# pandas is required so Python nodes get a real DataFrame as `df`.
REQUIRED = ["duckdb", "pyarrow", "pandas", "sqlglot", "openpyxl", "orjson",
            "ijson", "tzdata"]
OPTIONAL = REQUIRED + ["pyodbc", "pytz", "msal", "requests",
                       "requests_negotiate_sspi"]
_missing_required = [pkg for pkg in REQUIRED
                     if importlib.util.find_spec(pkg) is None]
if _missing_required:
    raise SystemExit(
        "[samql.spec] refusing to package an incomplete app; missing "
        "required dependencies: %s. Re-run build.ps1 / build.sh so "
        "requirements-optional.txt is installed into THIS Python, then "
        "retry." % (", ".join(_missing_required),)
    )
for pkg in OPTIONAL:
    if importlib.util.find_spec(pkg) is not None:
        try:
            d, b, h = collect_all(pkg)
            datas += d
            binaries += b
            hiddenimports += h
            print(f"[samql.spec] bundling dependency: {pkg}")
        except Exception as exc:  # pragma: no cover - build-time only
            print(f"[samql.spec] could not fully collect {pkg}: {exc}")
            if pkg in REQUIRED:
                raise SystemExit(
                    f"[samql.spec] required dependency {pkg!r} could not "
                    f"be collected: {exc}"
                ) from exc

# ---- native window stack (SHARED by SamQL.exe AND SamQL-AppWindow) ----
# Collect once into the shared datas/binaries/hiddenimports so both Analysis
# trees ship the same pywebview / WebView2 / pythonnet payload. Naming the
# lazily-imported platform modules keeps frozen auto-detect deterministic
# (.501/.508). Missing packages are loud but non-fatal (browser fallback).
for pkg in ("win32api", "win32com"):
    if importlib.util.find_spec(pkg) is not None:
        hiddenimports.append(pkg)
_WINDOW_PKGS = ("webview", "clr", "clr_loader", "pythonnet", "proxy_tools")
for _wpkg in _WINDOW_PKGS:
    if importlib.util.find_spec(_wpkg) is None:
        print(f"[samql.spec] native-window package MISSING (both exes): {_wpkg}")
        continue
    try:
        _wd, _wb, _wh = collect_all(_wpkg)
        datas += _wd
        binaries += _wb
        hiddenimports += _wh
        print(f"[samql.spec] bundling native-window package for BOTH exes: {_wpkg}")
    except Exception as _wexc:  # pragma: no cover - build-time only
        print(f"[samql.spec] could not fully collect {_wpkg}: {_wexc}")
if importlib.util.find_spec("webview") is not None:
    hiddenimports += [
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
    ]
    if importlib.util.find_spec("clr_loader") is not None:
        hiddenimports.append("clr_loader.netfx")

# ---- application icon for the Windows executable -------------------------
# Source of truth, strongest first: a real SamQL.ico the user dropped into
# src/ (or frontend/public/), else the embedded _brand.app_ico() base64 -- so a
# text-only source transfer, which carries no binary, still ships a valid icon.
# The chosen bytes are written to backend/samql.ico (the exe icon path),
# OVERWRITING any stale file (.487: a stale one used to be reused forever and
# shipped the old icon). Any failure falls back to an on-disk icon, then to
# PyInstaller's default, so the build never breaks over the icon. On non-Windows
# targets the bootloader ignores this field.
ICON = None
_user_ico = None
# strongest first: a real icon the user keeps in the repo ROOT (samql.ico /
# SamQL.ico -- same file on Windows), then src/, then frontend/public/. The
# root is where Sam actually keeps it; the build no longer writes there, so it
# is a pure INPUT now. On case-sensitive hosts both spellings are tried.
for _cand in (os.path.join(REPO, "SamQL.ico"),
              os.path.join(REPO, "samql.ico"),
              os.path.join(REPO, "src", "SamQL.ico"),
              os.path.join(REPO, "frontend", "public", "SamQL.ico")):
    if os.path.isfile(_cand):
        _user_ico = _cand
        break
try:
    import sys as _sys
    if HERE not in _sys.path:
        _sys.path.insert(0, HERE)
    _gen = os.path.join(HERE, "samql.ico")
    if _user_ico and os.path.abspath(_user_ico) != os.path.abspath(_gen):
        with open(_user_ico, "rb") as _uf:
            _ico_bytes = _uf.read()
        print(f"[samql.spec] using user icon {_user_ico} "
              f"({len(_ico_bytes)} bytes)")
    else:
        from samql_core import _brand as _b
        _ico_bytes = _b.app_ico()
        print(f"[samql.spec] regenerated icon from _brand.app_ico() "
              f"({len(_ico_bytes)} bytes)")
    with open(_gen, "wb") as _fh:          # overwrite unconditionally
        _fh.write(_ico_bytes)
    ICON = _gen
    import hashlib as _hl
    print("[samql.spec] EXE ICON (both exes): %s sha=%s (%d bytes)"
          % (_gen, _hl.sha256(_ico_bytes).hexdigest()[:12],
             len(_ico_bytes)))
except Exception as _e:  # pragma: no cover -- build-box specific
    print(f"[samql.spec] could not resolve the app icon ({_e}); "
          f"falling back to any icon on disk.")
    for _cand in (os.path.join(REPO, "samql.ico"),
                  os.path.join(HERE, "samql.ico")):
        if os.path.isfile(_cand):
            ICON = _cand
            print(f"[samql.spec] embedding existing icon: {_cand}")
            break

block_cipher = None

a = Analysis(
    [os.path.join(HERE, "server.py")],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib", "PyQt5", "PySide2", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="SamQL",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # .498: UPX strips the PE icon resource on-box
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # keep the console open: it shows the boot/status output and
    # stays up so the server can be stopped with Ctrl+C.
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON,  # embedded as the .exe icon when samql.ico is present
)

# ---------------------------------------------------------------------------
# Second binary (.418): the app-window launcher. Same one-command build
# (`pyinstaller backend/samql.spec`) now ALSO produces a console-less
# SamQL-AppWindow executable -- the double-clickable twin of the
# PowerShell launcher: splash, server reuse/start, a NATIVE pywebview
# window (.485), and the launcher log in the samql temp root.
#
# Payload parity with SamQL.exe: the shared Analysis inputs above already
# carry the load stack, frontend_dist, icon, and native-window packages.
# The launcher Analysis reuses those exact lists (+ splash logo + server
# module) so both exes contain the same runtime surface.
la_hidden = ["tkinter", "tkinter.ttk",
             # Named again for the launcher graph (shared lists already
             # include them; duplicates are fine / de-duped below).
             "webview.platforms.edgechromium",
             "webview.platforms.winforms",
             "clr_loader.netfx"]
# .535: fold the WHOLE backend into the launcher exe. A lone
# SamQL-AppWindow.exe used to fail with "no SamQL exe or python backend
# found" when it travelled without SamQL.exe beside it; now it carries the
# server module, samql_core, the built frontend, and the same optional
# acceleration libraries as SamQL.exe -- so it can spawn ITSELF with
# --serve as the last-resort server candidate. One file to send.
la_hidden = list(dict.fromkeys(la_hidden + hiddenimports + ["server"]))
la_binaries = list(binaries)
la_datas = list(datas)
print("[samql.spec] AppWindow payload = SamQL payload "
      "(shared datas/binaries/hiddenimports + server + splash assets)")

# .500: bundle brand assets INTO the launcher exe so the native window and the
# startup splash carry the user's art with no dependence on the server being up
# yet: SamQL.ico (the taskbar stamp) and frontend/public/logo.png (the splash
# image). Both are optional -- absent, the launcher stamps the server favicon
# and shows a text splash. Bundled at the exe root so _bundled_asset() finds
# them via sys._MEIPASS.
_la_ico = ICON if (ICON and os.path.isfile(ICON)) else None
if _la_ico:
    la_datas.append((_la_ico, "."))
# Splash mark: prefer a user drop-in; otherwise write the embedded SQ PNG so
# text-only trees still ship a logo on the launcher splash (mirrors ico).
_la_logo = os.path.join(REPO, "frontend", "public", "logo.png")
if not os.path.isfile(_la_logo):
    try:
        from samql_core import _brand as _b_logo
        _pub = os.path.join(REPO, "frontend", "public")
        os.makedirs(_pub, exist_ok=True)
        with open(_la_logo, "wb") as _lf:
            _lf.write(_b_logo.app_icon_png())
        print(f"[samql.spec] wrote embedded splash logo {_la_logo} "
              f"({os.path.getsize(_la_logo)} bytes)")
    except Exception as _logo_exc:
        print(f"[samql.spec] WARN could not seed splash logo: {_logo_exc!r}")
if os.path.isfile(_la_logo):
    la_datas.append((_la_logo, "."))

la = Analysis(
    ["launcher_app.py"],
    pathex=[SPECPATH],
    binaries=la_binaries,
    datas=la_datas,
    hiddenimports=la_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib", "PyQt5", "PySide2", "pytest"],  # .535: the
    # backend rides along now (self-serve); only the same never-needed
    # heavyweights as the server exe stay out
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

lpyz = PYZ(la.pure, la.zipped_data, cipher=block_cipher)

# .545: pin the onefile extraction under a predictable, SamQL-owned
# subfolder of TEMP rather than a random _MEIxxxxxx at the temp root.
# The bootloader can always find + reclaim it, the launcher's early
# sweep (below) can clear a killed run's leftover before a new boot, and
# the storage report can label it precisely -- the raw "failed to remove
# temporary directory: ..._MEIxxxxxx" warning after a sleep/kill was the
# bootloader failing to delete a still-mapped random dir at exit.
_SAMQL_RUNTIME_TMP = None  # None => default (per-user TEMP); set via env
                          # SAMQL_RUNTIME_TMPDIR at build if a fixed dir
                          # is wanted. Left as default to honour the
                          # bank image's TEMP redirection.

if SAMQL_ONEDIR:
    # .549 ONEDIR: the exe holds only the bootstrap; binaries + datas are
    # laid out beside it in _internal/ by COLLECT. No _MEI extraction at
    # runtime -> no "failed to remove temporary directory" dialog, and a
    # fast start (already unpacked).
    print("[samql.spec] SAMQL_ONEDIR=1 -> building SamQL-AppWindow as a "
          "FOLDER (dist/SamQL-AppWindow/)")
    lexe = EXE(
        lpyz,
        la.scripts,
        [],                       # <-- binaries excluded from the exe
        exclude_binaries=True,    # <-- the onedir switch
        name="SamQL-AppWindow",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=ICON,
    )
    lcoll = COLLECT(
        lexe,
        la.binaries,
        la.zipfiles,
        la.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="SamQL-AppWindow",   # -> dist/SamQL-AppWindow/
    )
else:
    lexe = EXE(
        lpyz,
        la.scripts,
        la.binaries,
        la.zipfiles,
        la.datas,
        [],
        name="SamQL-AppWindow",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,  # .498: UPX strips the PE icon resource on-box
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,  # windowed: the splash IS the interface; failures
        # go to the red splash + the launcher log (Settings -> Error log).
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=ICON,
    )
