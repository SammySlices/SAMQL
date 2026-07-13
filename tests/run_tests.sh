#!/usr/bin/env bash
# Run the SamQL test suite (backend + UI). Passes through any extra flags,
# e.g.  ./tests/run_tests.sh --build   or   ./tests/run_tests.sh -v
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3 was not found on your PATH." >&2
  exit 2
fi
exec "$PY" "$DIR/run_tests.py" "$@"
