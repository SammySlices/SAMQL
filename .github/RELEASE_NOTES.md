**SamQL AppWindow — build 2026-08-13.700 (v2.16.4)**

### Pinned Tables shift the workspace; NodeFlow config opens on click, not drag

Pinning the Tables / History / Workflows drawer docks it in the layout so the IDE SQL editor, Journal, NodeFlow canvas, and Dashboard shift right instead of sitting under the panel. Unpinning still overlays for a temporary peek.

NodeFlow configure no longer opens when you press a node to move it. A left click (under 5px of movement) opens the panel; a drag keeps it closed and closes it if it was already open.

### Also in this build

- **JSON Field Explorer multi-level bind** (from `2026-08-10.699`) — combined All-rows queries keep outer-level field aliases through deeper UNNEST hops.
- **Run all continues past a Write node** (from `2026-08-04.698`) — chains wired off a Write node's out port run after the write commits.
- **Run all of Write nodes no longer reports "0 of N done" cancelled after an upstream edit** (from `2026-07-31.697`).

Includes everything from `2026-08-10.699` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
