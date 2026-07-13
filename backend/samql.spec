# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build spec for SamQL.

Build a single self-contained executable that bundles the Python backend,
the built React frontend, and whichever optional acceleration libraries
happen to be installed in the build environment.

Usage (from the repository root, after building the frontend):

    cd frontend && npm install && npm run build && cd ..
    pyinstaller backend/samql.spec

The resulting binary is written to ``dist/SamQL`` (or ``dist/SamQL.exe``
on Windows). Running it starts the local server and opens the app.

Nothing here is required at runtime beyond the Python standard library;
DuckDB, pyarrow, sqlglot, pyodbc, openpyxl and pywebview are detected and
bundled only if present, so the build works with a bare interpreter too.
"""
import importlib.util
import os

from PyInstaller.utils.hooks import collect_all

# .549: ONEDIR packaging for the AppWindow. Set SAMQL_ONEDIR=1 in the
# build environment to produce dist/SamQL-AppWindow/ (a FOLDER: the exe
# plus a pre-extracted _internal/) instead of a single self-extracting
# SamQL-AppWindow.exe. Onedir runs with NO per-launch _MEI extraction --
# so the "failed to remove temporary directory" bootloader dialog is
# structurally impossible, startup skips the re-unpack+AV-scan, and the
# runtime layout stops shifting under a temp dir each launch. Distribute
# the folder as a .zip; recipients extract it and run the exe inside.
# The single-exe SamQL.exe server target is unchanged either way.
SAMQL_ONEDIR = os.environ.get("SAMQL_ONEDIR", "").strip() in (
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
if os.path.isdir(FRONTEND_DIST):
    datas.append((FRONTEND_DIST, "frontend_dist"))
# .519: the SERVER exe bundles samql.ico too -- SamQL.exe --window now sets
# the Form icon exactly like the AppWindow launcher, so it needs the art.
for _ic in (os.path.join(REPO, "samql.ico"), os.path.join(HERE, "samql.ico")):
    if os.path.isfile(_ic):
        datas.append((_ic, "."))
        break
else:
    print(
        "\n[samql.spec] WARNING: frontend/dist not found.\n"
        "             Build it first:  cd frontend && npm install && "
        "npm run build\n"
        "             The executable will still run but show a "
        "placeholder page.\n"
    )

# ---- optionally fold in acceleration libraries when available ----
# tzdata / pytz are included because pyarrow and pandas import them
# *dynamically* to handle timezone-aware timestamps, so PyInstaller's static
# analysis misses them -- which is why a frozen build could report "pytz not
# installed" on a query with TIMESTAMP WITH TIME ZONE columns even though it
# was installed in the build environment.
OPTIONAL = ["duckdb", "pyarrow", "sqlglot", "pyodbc", "openpyxl", "orjson",
            "ijson", "tzdata", "pytz"]
for pkg in OPTIONAL:
    if importlib.util.find_spec(pkg) is not None:
        try:
            d, b, h = collect_all(pkg)
            datas += d
            binaries += b
            hiddenimports += h
            print(f"[samql.spec] bundling optional dependency: {pkg}")
        except Exception as exc:  # pragma: no cover - build-time only
            print(f"[samql.spec] could not fully collect {pkg}: {exc}")

# pywebview (desktop window) + its win32 dependency, if installed
for pkg in ["webview", "win32api", "win32com"]:
    if importlib.util.find_spec(pkg) is not None:
        hiddenimports.append(pkg)
# .501: the WebView2 renderer's platform modules by NAME (lazily imported, so
# the graph misses them) -- SamQL.exe --window needs them just like the
# launcher does.
if importlib.util.find_spec("webview") is not None:
    hiddenimports += ["webview.platforms.edgechromium",
                      "webview.platforms.winforms"]
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
# .485: bundle pywebview (+ its Windows .NET/WebView2 backend) into the
# launcher when present, so SamQL-AppWindow opens a NATIVE window it owns
# (its own taskbar icon -- no Edge logo) instead of a browser. Optional:
# when pywebview is absent the launcher falls back to a chromeless Edge/
# Chrome window at runtime, so the build still succeeds without it.
la_hidden = ["tkinter", "tkinter.ttk",
             # .501: the WebView2 renderer's platform modules, by NAME.
             # collect_all("webview") gathers the package, but PyInstaller's
             # import graph can still miss the lazily-imported platform
             # module, and then the frozen exe's auto-detect "can't find" the
             # very backend that is installed -- and falls back to a browser
             # (the on-box "AppWindow still opens Edge"). Naming them makes
             # the bundle deterministic.
             "webview.platforms.edgechromium",
             "webview.platforms.winforms",
             "clr_loader.netfx"]
la_datas = []
la_binaries = []
for _wpkg in ("webview", "clr", "clr_loader", "pythonnet", "proxy_tools"):
    if importlib.util.find_spec(_wpkg) is None:
        # .508: say it OUT LOUD -- a missing stack here means the AppWindow
        # exe ships browser-only no matter what is installed elsewhere.
        print(f"[samql.spec] launcher native-window package MISSING: {_wpkg}")
        continue
    if importlib.util.find_spec(_wpkg) is not None:
        try:
            _wd, _wb, _wh = collect_all(_wpkg)
            print(f"[samql.spec] launcher bundles native-window package: {_wpkg}")
            la_datas += _wd
            la_binaries += _wb
            la_hidden += _wh
            print(f"[samql.spec] bundling launcher window dep: {_wpkg}")
        except Exception as _wexc:  # pragma: no cover - build-time only
            print(f"[samql.spec] could not fully collect {_wpkg}: {_wexc}")

# .535: fold the WHOLE backend into the launcher exe. A lone
# SamQL-AppWindow.exe used to fail with "no SamQL exe or python backend
# found" when it travelled without SamQL.exe beside it; now it carries the
# server module, samql_core, the built frontend, and the same optional
# acceleration libraries as SamQL.exe -- so it can spawn ITSELF with
# --serve as the last-resort server candidate. One file to send.
la_hidden = list(dict.fromkeys(la_hidden + hiddenimports + ["server"]))
la_binaries = la_binaries + binaries
la_datas = la_datas + datas

# .500: bundle brand assets INTO the launcher exe so the native window and the
# startup splash carry the user's art with no dependence on the server being up
# yet: SamQL.ico (the taskbar stamp) and frontend/public/logo.png (the splash
# image). Both are optional -- absent, the launcher stamps the server favicon
# and shows a text splash. Bundled at the exe root so _bundled_asset() finds
# them via sys._MEIPASS.
_la_ico = ICON if (ICON and os.path.isfile(ICON)) else None
if _la_ico:
    la_datas.append((_la_ico, "."))
_la_logo = os.path.join(REPO, "frontend", "public", "logo.png")
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
