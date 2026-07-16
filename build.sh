#!/usr/bin/env bash
# Build SamQL into a distributable AppWindow package.
# Requires: node + npm (to build the frontend) and python3 + pip.
#
# Primary product: SamQL-AppWindow (onedir folder by default via SAMQL_ONEDIR=1).
# The console/browser-tab SamQL binary is still built as a sidecar, not the
# promoted distribution artifact.
#
# SQL assistant packaging (prompted interactively if omitted):
#   ./build.sh --assistant-pack lean|runtime|post|embed
#   SAMQL_ASSISTANT_PACK=lean|runtime|post|embed ./build.sh
#   1 lean     = SamQL only
#   2 runtime  = llama-server runtime only, no GGUF (default)
#   3 post     = full assistant/ with GGUF (~+1GB+)
#   4 embed    = bake full assistant/ into PyInstaller payload (~+1GB+)
#
# Layout:
#   ./build.sh                 # default: AppWindow onedir + zip(s)
#   ./build.sh --onefile       # opt-in self-extracting AppWindow
#
# Onedir zips (when SamQL-AppWindow/ exists after the build):
#   dist/SamQL-AppWindow.zip            — lean AppWindow (no assistant/)
#   dist/SamQL-AppWindow-Assistant.zip  — same + SQL assistant runtime
#                                         (written when assistant/ was staged)
#
# Recipients download a GGUF later:
#   python tools/fetch_assistant_pack.py --model 4b|7b
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"
echo "    build Python: $($PY -c 'import sys; print(sys.executable)')"

ASSISTANT_PACK_ARG=""
ONEFILE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --assistant-pack)
      ASSISTANT_PACK_ARG="${2:-}"
      shift 2
      ;;
    --assistant-pack=*)
      ASSISTANT_PACK_ARG="${1#*=}"
      shift
      ;;
    --onefile)
      ONEFILE=1
      shift
      ;;
    --onedir)
      # back-compat: onedir is already the default
      ONEFILE=0
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ASST_TOOL="$ROOT/tools/assistant_build_pack.py"
if [ ! -f "$ASST_TOOL" ]; then
  echo "ERROR: missing $ASST_TOOL" >&2
  exit 1
fi
RESOLVE_ARGS=("$ASST_TOOL" resolve)
if [ -n "$ASSISTANT_PACK_ARG" ]; then
  RESOLVE_ARGS+=(--mode "$ASSISTANT_PACK_ARG" --no-prompt)
elif [ -n "${SAMQL_ASSISTANT_PACK:-}" ]; then
  RESOLVE_ARGS+=(--mode "$SAMQL_ASSISTANT_PACK" --no-prompt)
fi
ASSISTANT_MODE="$("$PY" "${RESOLVE_ARGS[@]}")"
ASSISTANT_MODE="$(echo "$ASSISTANT_MODE" | tr -d '\r' | tail -n 1)"
export SAMQL_ASSISTANT_PACK="$ASSISTANT_MODE"
if [ "$ASSISTANT_MODE" = "embed" ]; then
  export SAMQL_ASSISTANT_EMBED=1
else
  unset SAMQL_ASSISTANT_EMBED || true
fi
echo "==> assistant pack mode: $ASSISTANT_MODE"
case "$ASSISTANT_MODE" in
  lean)    echo "    lean: SamQL only (no assistant/ staged)" ;;
  runtime) echo "    runtime: will stage llama-server + libs (no GGUF; fetch model later)" ;;
  post)    echo "    post: will stage full assistant/ next to dist/ (~+1 GB+)" ;;
  embed)   echo "    embed: will bake full assistant/ into the PyInstaller payload (~+1 GB+)" ;;
esac
if [ "$ASSISTANT_MODE" = "embed" ] || [ "$ASSISTANT_MODE" = "post" ]; then
  echo "==> ensuring assistant pack (runtime + GGUF)…"
  "$PY" "$ASST_TOOL" ensure --root "$ROOT" --fetch || {
    echo "ERROR: assistant pack required for mode '$ASSISTANT_MODE'" >&2
    exit 1
  }
elif [ "$ASSISTANT_MODE" = "runtime" ]; then
  echo "==> ensuring assistant runtime (llama-server only, no GGUF)…"
  "$PY" "$ASST_TOOL" ensure --root "$ROOT" --fetch --runtime-only || {
    echo "ERROR: assistant runtime required for mode 'runtime'." >&2
    echo "       With network: python tools/fetch_assistant_pack.py --skip-model" >&2
    echo "       Offline builders: ./build.sh --assistant-pack lean" >&2
    exit 1
  }
fi

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

echo "==> 4/4  Packaging the AppWindow product"
# Clean rebuild so a changed icon / splash / bundled asset is actually
# re-embedded -- PyInstaller otherwise reuses its build cache. Only build/ and
# dist/ are cleared; the spec writes backend/samql.ico every build (from the
# user's root samql.ico if present, else _brand.py), overwriting any stale file,
# so there is no need to delete it. (.498/.500: keep samql.ico.)
rm -rf build dist
if [ "$ONEFILE" -eq 1 ]; then
  unset SAMQL_ONEDIR || true
  echo "    ONEFILE mode: SamQL-AppWindow self-extracting binary"
else
  export SAMQL_ONEDIR=1
  echo "    ONEDIR mode (default): SamQL-AppWindow folder under dist/"
fi
"$PY" -m PyInstaller --clean --noconfirm backend/samql.spec

# Both targets come from the same shared payload in samql.spec. Refuse a
# half-build so packaging never ships AppWindow without the server sidecar
# (or vice versa). Primary distribute target is SamQL-AppWindow.
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

if [ "$ASSISTANT_MODE" = "runtime" ]; then
  echo "==> staging assistant runtime beside dist (no GGUF)…"
  "$PY" "$ASST_TOOL" stage-post --root "$ROOT" --runtime-only
elif [ "$ASSISTANT_MODE" = "post" ]; then
  echo "==> staging full assistant pack beside dist outputs…"
  "$PY" "$ASST_TOOL" stage-post --root "$ROOT"
elif [ "$ASSISTANT_MODE" = "lean" ]; then
  echo "==> assistant pack: lean mode (not staged). To add later:"
  echo "    python tools/fetch_assistant_pack.py --skip-model   # runtime"
  echo "    python tools/fetch_assistant_pack.py --model 4b    # GGUF"
  echo "    then copy ./assistant next to dist/SamQL-AppWindow/"
  echo "    and/or drop a .gguf into dist/SamQL-AppWindow/Model/"
else
  echo "==> assistant pack: embedded in PyInstaller payload (mode embed)"
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

LEAN_ZIP=""
ASSISTANT_ZIP=""
if [ -d dist/SamQL-AppWindow ]; then
  echo "==> Zipping the onedir folder for distribution..."
  "$PY" "$ASST_TOOL" zip-onedir --root "$ROOT"
  LEAN_ZIP="$ROOT/dist/SamQL-AppWindow.zip"
  ASSISTANT_ZIP="$ROOT/dist/SamQL-AppWindow-Assistant.zip"
fi

echo
echo "Done. Your build is in:  $ROOT/dist/"
echo "Assistant packaging mode: $ASSISTANT_MODE"
echo "PRIMARY: SamQL-AppWindow (distribute this). SamQL is a server sidecar."
if [ -n "$LEAN_ZIP" ] && [ -f "$LEAN_ZIP" ]; then
  echo "  SamQL-AppWindow.zip           — lean AppWindow (no assistant/)"
fi
if [ -n "$ASSISTANT_ZIP" ] && [ -f "$ASSISTANT_ZIP" ]; then
  echo "  SamQL-AppWindow-Assistant.zip — AppWindow + SQL assistant runtime"
  if [ "$ASSISTANT_MODE" = "runtime" ]; then
    echo "    (llama-server; no GGUF). Add a model later with:"
    echo "      python tools/fetch_assistant_pack.py --model 4b|7b"
    echo "      then drop the .gguf into the install's Model/ folder"
    echo "      (or copy into assistant/models/)"
  fi
fi
ls -la dist/ 2>/dev/null || true
echo "SamQL-AppWindow is the windowed product; SamQL shares the same payload."
