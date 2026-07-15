#!/usr/bin/env bash
# Build SamQL into a single distributable executable.
# Requires: node + npm (to build the frontend) and python3 + pip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"
echo "    build Python: $($PY -c 'import sys; print(sys.executable)')"

# Brand PNGs are binary drop-ins (not in SOURCE_MANIFEST). Seed the embedded
# SQ mark when absent so splash + Vite always have logo.png; never overwrite
# a user drop-in. Then strip baked-in backgrounds before vite packages them.
echo "==> brand: ensuring public logos (embedded SQ mark if missing)"
export PYTHONPATH="$ROOT/backend"
if ! "$PY" -c "
from samql_core import _brand
for r in _brand.ensure_public_brand_pngs('frontend/public'):
    path = r.get('path') or ''
    print(('    wrote (embedded):' if r.get('written') else '    keep (present):'), path)
"; then
  echo "    WARN: brand PNG ensure pass failed; continuing" >&2
fi

echo "==> brand: making public logos transparent"
if ! "$PY" -c "
from samql_core import _brand
for r in _brand.logo_fix_public_dir('frontend/public'):
    path = r.get('path') or ''
    if r.get('before') is None:
        print('    skip (missing):', path); continue
    b, a = r['before'], r['after']
    if r.get('changed'):
        print('    fixed:', path, 'alpha', b.get('has_alpha'), '->', a.get('has_alpha'))
    else:
        print('    ok (already clean):', path)
"; then
  echo "    WARN: brand PNG transparency pass failed; continuing with source art as-is" >&2
fi

echo "==> 1/3  Building the React frontend"
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
pushd frontend >/dev/null
npm ci
npm run build
popd >/dev/null
if [ ! -f frontend/dist/index.html ] || [ ! -d frontend/dist/assets ]; then
  echo "ERROR: frontend/dist incomplete after npm run build (need index.html + assets/)." >&2
  echo "       Refusing to package a placeholder UI." >&2
  exit 1
fi
echo "    OK: frontend/dist ready"

echo "==> 2/4  Ensuring PyInstaller is available"
if ! "$PY" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "    installing pyinstaller..."
  "$PY" -m pip install pyinstaller
fi

echo "==> 3/4  Installing full dependency set (bundled into the executable)"
# Core required packages first (orjson, …), then the full optional stack.
REQ_CORE="$ROOT/backend/requirements.txt"
if [ -f "$REQ_CORE" ]; then
  echo "    installing from backend/requirements.txt"
  "$PY" -m pip install -r "$REQ_CORE" || true
fi
# Distribution builds MUST install the entire optional manifest into THIS
# Python (the one running PyInstaller). Missing packages are not bundled and
# recipients then see load failures that work on the builder's machine.
REQ_OPTIONAL="$ROOT/requirements-optional.txt"
if [ ! -f "$REQ_OPTIONAL" ]; then
  echo "ERROR: $REQ_OPTIONAL not found; refusing an incomplete build." >&2
  exit 1
fi
echo "    installing from requirements-optional.txt"
"$PY" -m pip install --upgrade pip
if ! "$PY" -m pip install -r "$REQ_OPTIONAL"; then
  echo "    bulk install reported errors; retrying packages individually..."
  while IFS= read -r pkg; do
    case "$pkg" in
      ""|\#*) continue ;;
    esac
    echo "    installing: $pkg"
    "$PY" -m pip install "$pkg" || echo "    (pip could not install $pkg)"
  done < "$REQ_OPTIONAL"
fi
# .508: the native-window stack must live in THIS python (the one running
# PyInstaller) or samql.spec silently skips bundling it and SamQL-AppWindow
# opens a browser. Best-effort install + a loud, unmissable warning.
if ! "$PY" -c "import webview, clr" >/dev/null 2>&1; then
  echo "    installing pywebview + pythonnet (native window stack)..."
  "$PY" -m pip install pywebview pythonnet || true
fi
if ! "$PY" -c "import webview, webview.platforms.edgechromium, clr" >/dev/null 2>&1; then
  echo ""
  echo "  ============================================================"
  echo "  NATIVE WINDOW STACK MISSING IN THIS BUILD PYTHON"
  echo "  SamQL-AppWindow from THIS build will open a BROWSER window."
  echo "  Fix: $PY -m pip install pywebview pythonnet"
  echo "  ============================================================"
  echo ""
fi
# CRITICAL load/export stack must import or the build stops.
for mod in duckdb pyarrow pandas sqlglot openpyxl ijson orjson tzdata; do
  if ! "$PY" -c "import importlib.util as u, sys; sys.exit(0 if u.find_spec('$mod') else 1)"; then
    echo "    *** critical dependency '$mod' is not importable after" \
         "install -- the packaged app would break. Fix the environment" \
         "and re-run: $PY -m pip install -r requirements-optional.txt" >&2
    exit 1
  fi
done
echo "    OK: load stack importable (duckdb, pyarrow, pandas, sqlglot, openpyxl, ijson, orjson, tzdata)"
if "$PY" -c "import duckdb" >/dev/null 2>&1; then
  echo "    OK: DuckDB is available -- the executable will use DuckDB by default."
fi

echo "==> 4/4  Packaging the executable"
# Clean rebuild so a changed icon / splash / bundled asset is actually
# re-embedded -- PyInstaller otherwise reuses its build cache. Only build/ and
# dist/ are cleared; the spec writes backend/samql.ico every build (from the
# user's root samql.ico if present, else _brand.py), overwriting any stale file,
# so there is no need to delete it. (.498/.500: keep samql.ico.)
rm -rf build dist
"$PY" -m PyInstaller --clean --noconfirm backend/samql.spec

# Both targets come from the same shared payload in samql.spec. Refuse a
# half-build so packaging never ships SamQL without AppWindow (or vice versa).
SERVER_OUT="dist/SamQL"
APP_OUT="dist/SamQL-AppWindow"
if [ -f "${SERVER_OUT}.exe" ]; then SERVER_OUT="${SERVER_OUT}.exe"; fi
if [ -f "${APP_OUT}.exe" ]; then APP_OUT="${APP_OUT}.exe"; fi
if [ ! -e "$SERVER_OUT" ] && [ ! -d "dist/SamQL" ]; then
  echo "ERROR: build incomplete -- SamQL server binary missing under dist/" >&2
  exit 1
fi
if [ ! -e "$APP_OUT" ] && [ ! -d "dist/SamQL-AppWindow" ]; then
  echo "ERROR: build incomplete -- SamQL-AppWindow binary missing under dist/" >&2
  exit 1
fi
echo "    OK: both targets present (SamQL + SamQL-AppWindow), shared payload"

# Stage an exe-adjacent frontend_dist copy (frozen MEIPASS + .467 hot-swap).
rm -rf dist/frontend_dist
cp -R frontend/dist dist/frontend_dist
if [ ! -f dist/frontend_dist/index.html ]; then
  echo "ERROR: failed to stage dist/frontend_dist/index.html" >&2
  exit 1
fi
echo "    OK: staged dist/frontend_dist (exe-adjacent UI)"
if [ -d dist/SamQL-AppWindow ]; then
  rm -rf dist/SamQL-AppWindow/frontend_dist
  cp -R frontend/dist dist/SamQL-AppWindow/frontend_dist
  echo "    OK: staged dist/SamQL-AppWindow/frontend_dist"
fi

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
echo "Done. Your build is in:  $ROOT/dist/"
ls -la dist/ 2>/dev/null || true
echo "SamQL and SamQL-AppWindow both ship the same frontend + load stack."
echo "Run either to launch SamQL."
