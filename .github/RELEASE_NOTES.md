**SamQL AppWindow — build 2026-09-10.701 (v2.16.4)**

### NodeFlow: a Filter sharing an Input with a second branch previews its real rows

A Filter wired to the same Input as a Summarize (or any second branch) showed no results after Run all. The post-run preview seed built the Input as a 200-row preview copy and every node after it read that truncated copy, so the Filter was evaluated over the first 200 input rows only. Preview copies are now kept apart from the node's real relation, so Filter, Summarize, and every other sibling preview the full data.

### JSON Field Explorer always opens on screen

Settings → JSON Field Explorer could appear to do nothing: the window reopened at a position saved on a wider screen (off screen), or as a minimized pill. Every open now clamps the window into view, expands a minimized pill, and brings back an already-open window — from the Settings menu and the command palette alike.

### Also in this build

- **Pinned Tables shift the workspace; NodeFlow config opens on click, not drag** (from `2026-08-13.700`).
- **JSON Field Explorer multi-level bind** (from `2026-08-10.699`) — combined All-rows queries keep outer-level field aliases through deeper UNNEST hops.
- **Run all continues past a Write node** (from `2026-08-04.698`).

Includes everything from `2026-08-13.700` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
