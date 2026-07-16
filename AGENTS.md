# AGENTS.md

## Cursor Cloud specific instructions

SamQL is a local-first SQL / data-exploration workbench: a Python stdlib HTTP
backend (`backend/server.py`, no Flask/FastAPI) plus a React + Vite + TypeScript
frontend (`frontend/`). Query engines are in-process (SQLite always, DuckDB when
installed). There is **no external database/Redis/queue** — all storage is local.

Dependencies are installed by the startup update script (Python deps via
`backend/requirements.txt` + `requirements-test.txt`, frontend via
`npm ci` in `frontend/`). The notes below are the non-obvious things that are
easy to get wrong when running/testing; standard commands live in `README.md`
and `frontend/package.json` scripts.

### Running the app

Two supported ways to run (both work in this environment):

1. **Backend serves the built UI (simplest, same-origin).**
   Build once, then run the backend headless:
   - `cd frontend && npm run build` (outputs `frontend/dist/`)
   - `python3 backend/server.py --no-browser` → serves UI + API at
     `http://127.0.0.1:8765`. The API token is injected into the served HTML as
     a cookie automatically, so no token env vars are needed on this path.

2. **Vite dev server with HMR (for frontend iteration).**
   Run the backend and `npm run dev` (Vite on `http://localhost:5173`, proxies
   `/api` → `127.0.0.1:8765`). This path has TWO non-obvious requirements — miss
   either and the browser silently fails on every `/api` call:
   - **Matching token both sides:** start backend with `SAMQL_API_TOKEN=<t>` and
     Vite with `SAMQL_API_TOKEN=<t> VITE_SAMQL_API_TOKEN=<t>` (same value).
     Missing/mismatched → `Missing or invalid SamQL API token`.
   - **Allow the dev origin:** start backend with
     `SAMQL_ALLOWED_ORIGINS=http://localhost:5173`. `vite.config.ts` proxies with
     `changeOrigin: true`, so the browser `Origin` (`localhost:5173`) never
     matches the rewritten `Host` and POSTs are rejected with
     `Request origin or host is not allowed` unless the origin is allow-listed.

   Example dev startup:
   - backend: `SAMQL_API_TOKEN=dev-token SAMQL_ALLOWED_ORIGINS=http://localhost:5173 python3 backend/server.py --no-browser`
   - vite: `SAMQL_API_TOKEN=dev-token VITE_SAMQL_API_TOKEN=dev-token npm run dev` (in `frontend/`)

Note: Vite binds to `localhost` only (not `127.0.0.1`); curl `http://localhost:5173`.

### Loading data / hello-world

Load files by **absolute path** in the "Load data" dialog (e.g. `/tmp/foo.csv`),
which avoids browser file-picker friction. A CSV loads as a DuckDB table you can
immediately query in the SQL editor (Run button / Ctrl+Enter).

### Lint / test / build

- Lint: `npm run lint` (zero-warning gate) — passes clean.
- Build: `npm run build` — passes clean.
- Frontend component tests: `npm run test:component` (Vitest).
- Backend + HTTP suites: `python3 tests/run_tests.py` (add `--backend-only`,
  `--frontend-only`, `--online`, `-v` as needed).
- Playwright E2E (`npm run test:e2e`) needs browsers installed first
  (`npx playwright install`); not part of the startup update script.

### Known pre-existing test failures (NOT environment issues)

On the currently checked-out commit these fail before any change, so do not treat
them as setup breakage:
- ~12 frontend component tests in `App.component.test.tsx`,
  `eyeCare.component.test.tsx`, `nodeFlowDenseApp.component.test.tsx` fail because
  their `ActivityShared` mock does not export `useWinDrag` (added by the recent
  SQL Assistant beta commits; the test mocks were not updated).
- ~18 backend `shred`/`flatten` planner tests fail under the newer DuckDB
  (1.5.x) resolved by pip, plus one repo-content check asserting PowerShell
  sources are pure ASCII.
