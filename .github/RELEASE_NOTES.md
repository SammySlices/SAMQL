**SamQL AppWindow — build 2026-11-24.704 (v2.16.4)**

All 29 findings from the November code audit are fixed in this build, one commit per finding.

### Shared Windows hosts: the UI belongs to the user who launched it (C-1)

On a shared host (RDS/Citrix) every session shares loopback, so another signed-in user could open your SamQL page, get its API cookie, or have their launcher attach to your server. Each launch now keeps an owner-only instance record with its token; the launcher attaches only to a server whose token fingerprint matches its own, the page opens only with that token, and Windows binds are exclusive. The Windows ACL, exclusive bind, PS1 launcher path and Edge e2e for this fix were not run on Windows before release.

### Chart tooltips can't run script (H-1)

Waterfall tooltip labels are HTML-escaped, and the app now sends a `script-src` Content-Security-Policy.

### Cancelling a load drops only that load's tables (H-4)

A cancelled load used to drop tables created meanwhile by other tabs or flows. It now drops only the tables it created.

### Also in this build

- **Stop and cancel stay in their lane** (H-2, H-3, H-8) — Stop on one run, or a load cancel, interrupts only its own statement; a SQL error that mentions "cancel" is no longer treated as a cancel.
- **NodeFlow Run all** (H-7, M-1, M-2, M-3) — Stop halts the whole batch, Run all can't start twice, the post-run column prune leaves nodes you edited alone, and upstream edits refresh the charts below them.
- **Flow builds** (H-5, H-6, M-6, M-7, M-10) — flow-cache tables are pinned for the pass that uses them and private to each run; a failed parallel branch cleans up its siblings; caches stage under the instance folder.
- **Python node** (M-4, M-5, L-7) — scripts run only after you approve them (existing scripts ask once), a timed-out script's thread stops, and the input cap limits the fetch itself.
- **Dashboard** (M-8) — a run belongs to the board it started on.
- **Exports and stores** (L-1, L-2, L-5, L-6) — xlsx headers stay text, two exports in the same second keep both files, an engine reset frees its old SQLite file, and config/history writes are locked and ordered.
- **Housekeeping** (H-9, M-9, L-3, L-4, L-8, L-9) — the test suite no longer touches your real `~/.samql`, cancelled-run id sets are bounded, the mail-safe source transport round-trips byte-exact, duckdb is pinned below 2, and the checked-in source bundle tracks the release build.

Includes everything from `2026-10-12.703` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
