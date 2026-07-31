**SamQL AppWindow — build 2026-07-31.697 (v2.16.4)**

### Run all of Write nodes no longer reports "0 of N done" cancelled after an upstream edit

Running a workflow, editing it upstream (the reported shape: inserting a **union** above several write nodes), then running again could end with the run dying partway through the chain and **every** write terminal reporting cancelled — the *"Run all cancelled — 0 of N done"* toast — while previews of the same chain kept working.

The cause was a sticky engine-level cancel flag: DuckDB's engine-wide `interrupt()` sets a `_cancel` event that nothing clears, and while it stays set the heartbeat daemon re-interrupts every statement that outlives its ~3 s beat. Any coarse engine-level cancel plants the flag — a Stop, or the engine-wide fallback taken when a superseded preview/chart request has no precise cursor to interrupt (exactly what a burst of graph edits produces). The query and preview paths already cleared the stale flag at entry; the write path never did, so once the upstream edit invalidated the flow cache and the rebuild ran long enough for the flag to land, every write in the batch unwound as cancelled.

All nine NodeFlow entry points now clear the stale engine cancel at entry — write-to-table, export (single + batch), iterator, while, chart, browse, validate, and reconcile — so a leftover cancel from a superseded preview or an earlier Stop can never fail a later run. A regression test plants the sticky flag, proves a write run succeeds, and pins the guard into every flow entry point.

Includes everything from `2026-07-28.696` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
