#!/usr/bin/env bash
# Build SamQL into a single distributable executable.
# Requires: node + npm (to build the frontend) and python3 + pip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> 1/3  Building the React frontend"
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
pushd frontend >/dev/null
npm ci
npm run build
popd >/dev/null

echo "==> 2/4  Ensuring PyInstaller is available"
PY="${PYTHON:-python3}"
if ! "$PY" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "    installing pyinstaller..."
  "$PY" -m pip install --user pyinstaller
fi

echo "==> 3/4  Installing optional acceleration libraries (so the build bundles DuckDB)"
# These are bundled into the .exe only if present in this environment (see
# samql.spec). DuckDB is the default engine -- without it the app falls back to
# SQLite -- so install the recommended set here. Best-effort and per-package:
# a wheel that isn't available for this platform/Python is skipped, and the
# build still succeeds (the app runs stdlib-only). Set SAMQL_SKIP_OPTIONAL=1 to
# build a deliberately minimal, SQLite-only binary.
REQ_OPTIONAL="$ROOT/requirements-optional.txt"
if [ "${SAMQL_SKIP_OPTIONAL:-0}" = "1" ]; then
  echo "    SAMQL_SKIP_OPTIONAL=1 -> skipping; the build will be SQLite-only."
elif [ -f "$REQ_OPTIONAL" ]; then
  while IFS= read -r pkg; do
    case "$pkg" in
      ""|\#*) continue ;;   # skip blank lines and comments
    esac
    echo "    installing optional: $pkg"
    "$PY" -m pip install --user "$pkg" || \
      echo "    (skipped $pkg -- no compatible wheel; continuing)"
  done < "$REQ_OPTIONAL"
else
  echo "    WARNING: $REQ_OPTIONAL not found; the build may fall back to SQLite."
fi
# .508: the native-window stack must live in THIS python (the one running
# PyInstaller) or samql.spec silently skips bundling it and SamQL-AppWindow
# opens a browser. Best-effort install + a loud, unmissable warning.
if ! "$PY" -c "import webview, clr" >/dev/null 2>&1; then
  echo "    installing pywebview + pythonnet (native window stack)..."
  "$PY" -m pip install --user pywebview pythonnet || true
fi
if ! "$PY" -c "import webview, webview.platforms.edgechromium, clr" >/dev/null 2>&1; then
  echo ""
  echo "  ============================================================"
  echo "  NATIVE WINDOW STACK MISSING IN THIS BUILD PYTHON"
  echo "  SamQL-AppWindow from THIS build will open a BROWSER window."
  echo "  Fix: $PY -m pip install --user pywebview pythonnet"
  echo "  ============================================================"
  echo ""
fi
# CRITICAL set must import or the build stops -- a binary without these
# fails on first use or silently falls back to SQLite.
for mod in duckdb pyarrow sqlglot openpyxl; do
  if ! "$PY" -c "import $mod" >/dev/null 2>&1; then
    echo "    *** critical dependency '$mod' is not importable after" \
         "install -- fix the environment and re-run." >&2
    exit 1
  fi
done
# Make the DuckDB situation unmistakable before we package.
if "$PY" -c "import duckdb" >/dev/null 2>&1; then
  echo "    OK: DuckDB is available -- the executable will use DuckDB by default."
else
  echo "    *** WARNING: DuckDB is NOT installed in this environment. The built"
  echo "    *** executable will run on SQLite only. Install it and rebuild for"
  echo "    *** 'DuckDB by default':  $PY -m pip install duckdb"
fi

echo "==> 4/4  Packaging the executable"
# Clean rebuild so a changed icon / splash / bundled asset is actually
# re-embedded -- PyInstaller otherwise reuses its build cache. Only build/ and
# dist/ are cleared; the spec writes backend/samql.ico every build (from the
# user's root samql.ico if present, else _brand.py), overwriting any stale file,
# so there is no need to delete it. (.498/.500: keep samql.ico.)
rm -rf build dist
"$PY" -m PyInstaller --clean --noconfirm backend/samql.spec

# .500: the app icon SOURCE is the user's own file in the repo ROOT (samql.ico),
# which the spec reads and embeds. The build must NOT write over it -- that
# clobbered the user's icon and shipped the default. Only refresh the shortcut
# copy NEXT TO the exe (dist/SamQL.ico).
if [ -f backend/samql.ico ]; then
  cp -f backend/samql.ico dist/SamQL.ico
  echo "    wrote dist/SamQL.ico (shortcut icon)"
else
  "$PY" -c "import sys; sys.path.insert(0,'backend'); from samql_core import _brand; open('dist/SamQL.ico','wb').write(_brand.app_ico())" \
    && echo "    regenerated dist/SamQL.ico from _brand" \
    || echo "    WARN could not write dist/SamQL.ico"
fi

echo
echo "Done. Your executable is in:  $ROOT/dist/"
ls -la dist/ 2>/dev/null || true
echo "Run it to launch SamQL."
