**SamQL AppWindow — build 2026-08-04.698 (v2.16.4)**

### Run all continues past a Write node

A data chain wired off a **Write to table** node's out port — the reported shape: two inputs → SQL join → **Write** → SQL — never ran: the run visibly ended at the Write node and nothing downstream produced results. Run all treats every output/write/iterator/while node as an exporter and, when any connected exporter exists, runs *only* the exporters; the fallback "leaves" mode that runs end-of-chain data nodes never activates in that case. The downstream SQL step was neither an exporter nor a leaf candidate, so it was simply never executed — and post-run row seeding covers only the *ancestor* closure of the run's terminals, so the node after the write got no rows either.

Run all now collects **continuation leaves** — data leaves sitting downstream of one of the run's exporters — and runs them **after** every exporter has finished, so a step reading the just-written table by name sees the committed rows (the write's out port remains a passthrough of the rows it wrote for `{{in}}`-style steps). A leaf under a failed or cancelled exporter is skipped — that exporter already reported. Continuation leaves count in the finish toast, seed last-run previews, and refresh downstream charts like any other terminal.

The same pass closes a related ordering hole: an exporter wired downstream of another exporter (write → … → output/write) could previously start concurrently with its upstream sink. Terminals now run in waves by exporter depth, so chained sinks commit in order; flat flows schedule exactly as before.

### Also in this build (from 2026-07-31.697)

**Run all of Write nodes no longer reports "0 of N done" cancelled after an upstream edit** — a sticky engine-level cancel flag (planted by a Stop or by superseding preview/chart requests during graph edits, e.g. inserting a union) was never cleared by the write/export/iterator/while/chart/browse/validate/reconcile flow paths, so the heartbeat daemon kept auto-interrupting every later statement and whole Run alls unwound as cancelled. All nine flow entry points now clear the stale flag at entry.

Includes everything from `2026-07-28.696` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
