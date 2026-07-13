# SamQL Storage Lifecycle Audit — 2026-07-02 (v2.12.0 → fixes in .375)

Question: "my disk keeps shrinking — what does SamQL remove when it closes
and opens?" Every disk artifact class, verified in source.

## What lives where, and when it's removed

| Class | Where | Size profile | On CLOSE (clean) | On next OPEN | On crash/kill |
|---|---|---|---|---|---|
| Session temp (results `qr_*`, uploads `up_*`, flatten spills `jf_*`, engine spill `duckdb_spill/`) | `<temp>/samql/<pid>/` | up to `SAMQL_RESULTS_GB` (20) for results; uploads = file-sized | **Deleted** (`_graceful_shutdown` → `cleanup_instance`, wired to signal + atexit + finally) | Dead-pid dirs from earlier crashes deleted (`sweep_stale`, liveness-checked) | Orphaned until the next open, then deleted |
| Conversion cache (`fc_*.parquet`) | `<temp>/samql/filecache/` | **multi-GB by design** — one parquet ≈ your JSON per distinct (path,size,mtime); a re-downloaded/edited file makes a NEW entry, the old one lingers | **Kept on purpose** (it's why reloads are instant) | Swept to `SAMQL_FILECACHE_GB` (10) + `SAMQL_FILECACHE_DAYS` (14); entries <10 min old exempt from the budget rule | Staged `.tmp` never published (atomic); aged out |
| PyInstaller onefile extraction (`_MEIxxxxxx`) | `<temp>/` (NOT under samql/) | **hundreds of MB per LAUNCH** | Removed by the bootloader on a clean exit | **(was: never — fixed in .375)** now swept: every `_MEI*` except the running one, >1 h old | Orphaned **forever** before .375 |
| DuckDB tables (incl. shred families) | in-memory engine; spill pinned to `duckdb_spill/` inside the instance dir | RAM + bounded spill | gone with the process / instance dir | — | covered by the instance-dir story |
| Manifest / history / saved queries | app data | KB | kept (that's their job); history entries size-capped (.373) | — | atomic writes |

## The two honest answers to "why is my disk shrinking"

1. **`_MEI` launch leftovers (fixed this build).** You launch a new exe per
   build and kill mid-test on validation days; each of those stranded a
   ~200–400 MB extraction directly in `%TEMP%`, invisible to our sweeps
   because it isn't under `samql/`. Dozens of launches ⇒ many GB. From .375
   every open reclaims them (skipping the running one and anything <1 h old,
   in case a second instance is mid-launch; locked dirs skipped silently).
2. **The conversion cache, by design.** Up to 10 GB of `fc_*.parquet` so
   your 1.7 GB JSON reattaches in seconds. Each *distinct version* of a
   source file is its own entry, so daily files / re-downloads accumulate
   toward the budget before LRU takes the old ones. Tune with
   `SAMQL_FILECACHE_GB` / `SAMQL_FILECACHE_DAYS`, kill with
   `SAMQL_FILECACHE=0`, or clear it from the new Storage panel.

## Gaps found and fixed in .375

- **`_MEI` orphans** — swept at every open (`sweep_mei_orphans`).
- **Windows pid reuse** — a dead instance's pid adopted by another process
  made its directory (up to 20 GB of `qr_*`) look "alive" forever. Every
  instance now touches a liveness marker (at start + 6-hourly); a pid-alive
  dir whose marker is >48 h old is treated as a zombie and removed.
- **No visibility** — Settings → **Storage & cleanup…** shows the four
  classes with real byte counts, what's automatic, and two actions: "Clean
  orphans & leftovers" and "Clear conversion cache" (explicit, since it
  costs one reconversion per file).

## Verified good (no change)

Clean-close deletion of the instance dir (triple-wired); engine spill pinned
inside the instance dir (never the cwd); materialized uploads unlinked right
after load, view uploads kept only for the session; flatten spill dirs
removed in `finally`; filecache publishes atomically and its budget/age
sweep runs at every open; stray root-level `samql_*` files age-swept.

## Check on your box

`%TEMP%` → count `_MEI*` folders (expect several GB reclaimed on first .375
open); `%TEMP%\samql\filecache` size vs. the 10 GB budget; `%TEMP%\samql\`
should hold only your live pid + `filecache` after an open.
