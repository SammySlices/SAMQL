**SamQL AppWindow — build 2026-08-10.699 (v2.16.4)**

### JSON Field Explorer: combined query binds fields from different nesting levels

Selecting fields from two different array depths — e.g. `id` on the `tradeValuations[]` element plus `metric` on the nested `metricValues[]` element — generated an All-rows query whose deeper CTE projected only its own UNNEST, so the final SELECT's `e2 ->> '$.id'` bound against a CTE exposing only `e4` and DuckDB failed with *`Binder Error: Referenced column "e2" not found in FROM clause! Candidate bindings: "e4"`*.

The composer handled outer scalars and deepest-level fields, but not a field whose UNNEST chain is a proper non-empty prefix of the longest chain. It now carries those fields' element aliases forward through every later hop CTE (`SELECT e2, UNNEST(...) AS e4`), so the final SELECT binds all levels and outer values repeat on each exploded nested row — exactly what the panel promises. Verified against DuckDB: the old shape reproduces the reported binder error; the fixed shape returns the outer `id` repeated per nested `metric` row.

### Also in this build

- **Run all continues past a Write node** (from `2026-08-04.698`) — chains wired off a Write node's out port now run after the write commits (continuation leaves), and chained exporters run in dependency order.
- **Run all of Write nodes no longer reports "0 of N done" cancelled after an upstream edit** (from `2026-07-31.697`) — all nine flow entry points clear the sticky engine-cancel flag at entry.

Includes everything from `2026-07-28.696` and earlier.

### Install
1. **Right-click the zip → "Extract All…"** to a real folder (e.g. `C:\SamQL`). Do **not** run the exe from inside the zip preview.
2. Open the extracted `SamQL-AppWindow` folder.
3. Run `SamQL-AppWindow.exe` — keep it together with the `_internal\` folder beside it.

### Artifacts
- `SamQL-AppWindow.zip` — lean AppWindow
- `SamQL-AppWindow-Assistant.zip` — AppWindow + SQL assistant runtime (no GGUF; fetch a model later)
