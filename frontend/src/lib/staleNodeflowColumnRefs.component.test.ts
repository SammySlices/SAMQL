import { describe, expect, it } from "vitest";
import {
  clearStaleNodeflowColumnRefs,
  exprColumnRefs,
  NO_AUTO_PRUNE_STALE_TYPES,
  STALE_REF_NODE_TYPES,
  staleNodeflowColumnRefs,
} from "./staleNodeflowColumnRefs";

describe("staleNodeflowColumnRefs", () => {
  it("lists every stale-ref type as never auto-prune on schema refresh", () => {
    expect([...NO_AUTO_PRUNE_STALE_TYPES].sort()).toEqual(
      [...STALE_REF_NODE_TYPES].sort(),
    );
    for (const t of NO_AUTO_PRUNE_STALE_TYPES) {
      expect(STALE_REF_NODE_TYPES).toContain(t);
    }
  });
  it("returns no stale refs for select/pivot (auto-reconciled)", () => {
    expect(
      staleNodeflowColumnRefs(
        "select",
        { fields: [{ name: "gone", keep: true }] },
        { in: ["a"] },
      ),
    ).toEqual([]);
    expect(
      staleNodeflowColumnRefs(
        "pivot",
        { rows: ["gone"], cols: [], values: [] },
        { in: ["a"] },
      ),
    ).toEqual([]);
  });

  it("flags stale summarize group_by and measure columns", () => {
    const stale = staleNodeflowColumnRefs(
      "summarize",
      { group_by: ["region", "old_key"], aggs: [{ col: "amount", func: "sum" }] },
      { in: ["region", "sales"] },
    );
    expect(stale).toEqual([
      { area: "group by", columns: ["old_key"] },
      { area: "measures", columns: ["amount"] },
    ]);
  });

  it("flags stale join keys against left/right upstream", () => {
    const stale = staleNodeflowColumnRefs(
      "join",
      { keys: [{ left: "id", right: "missing" }] },
      { left: ["id", "name"], right: ["id", "qty"] },
    );
    expect(stale).toEqual([{ area: "join key 1 right", columns: ["missing"] }]);
  });

  it("skips warnings until upstream columns are known", () => {
    expect(
      staleNodeflowColumnRefs("sort", { sorts: [{ col: "gone", dir: "asc" }] }, {}),
    ).toEqual([]);
  });

  it("extracts bracketed column refs from expressions", () => {
    expect(exprColumnRefs("UPPER([Name]) > 0 AND status = 'ok'")).toEqual([
      "Name",
      "status",
    ]);
  });

  it("keeps spaced bracketed headers as one ref (no Order/Date split)", () => {
    expect(exprColumnRefs("[Order Date] > 5")).toEqual(["Order Date"]);
    expect(
      staleNodeflowColumnRefs(
        "filter",
        { condition: "[Order Date] > 5", field: "Order Date" },
        { in: ["Order Date", "Amount"] },
      ),
    ).toEqual([]);
  });

  it("flags real drops of spaced headers and Clear blanks field+condition", () => {
    const cfg = {
      condition: "[Order Date] > 5",
      field: "Order Date",
      filterMode: "simple",
    };
    const stale = staleNodeflowColumnRefs("filter", cfg, { in: ["Amount"] });
    expect(stale).toEqual([
      { area: "condition", columns: ["Order Date"] },
      { area: "field", columns: ["Order Date"] },
    ]);
    expect(clearStaleNodeflowColumnRefs("filter", cfg, stale)).toEqual({
      condition: "",
      field: "",
      filterMode: "simple",
    });
  });

  it("Clear removes stale sort cols after upstream select shrinks fields", () => {
    const cfg = {
      sorts: [
        { col: "keep_me", dir: "asc" },
        { col: "dropped_field", dir: "desc" },
      ],
    };
    const stale = staleNodeflowColumnRefs("sort", cfg, {
      in: ["keep_me", "other"],
    });
    expect(stale).toEqual([
      { area: "sort", columns: ["dropped_field"] },
    ]);
    expect(clearStaleNodeflowColumnRefs("sort", cfg, stale)).toEqual({
      sorts: [{ col: "keep_me", dir: "asc" }],
    });
    expect(
      staleNodeflowColumnRefs(
        "sort",
        clearStaleNodeflowColumnRefs("sort", cfg, stale)!,
        { in: ["keep_me", "other"] },
      ),
    ).toEqual([]);
  });
});
describe("clearStaleNodeflowColumnRefs", () => {
  it("removes only stale sort columns on explicit clear", () => {
    const next = clearStaleNodeflowColumnRefs(
      "sort",
      {
        sorts: [
          { col: "a", dir: "asc" },
          { col: "gone", dir: "desc" },
        ],
      },
      [{ area: "sort", columns: ["gone"] }],
    );
    expect(next).toEqual({ sorts: [{ col: "a", dir: "asc" }] });
  });

  it("clears stale summarize group_by and measure entries", () => {
    const next = clearStaleNodeflowColumnRefs(
      "summarize",
      {
        group_by: ["region", "old_key"],
        aggs: [
          { col: "sales", func: "sum" },
          { col: "amount", func: "sum" },
        ],
      },
      [
        { area: "group by", columns: ["old_key"] },
        { area: "measures", columns: ["amount"] },
      ],
    );
    expect(next).toEqual({
      group_by: ["region"],
      aggs: [{ col: "sales", func: "sum" }],
    });
  });

  it("blanks stale join key sides without dropping the key row", () => {
    const next = clearStaleNodeflowColumnRefs(
      "join",
      { keys: [{ left: "id", right: "missing" }] },
      [{ area: "join key 1 right", columns: ["missing"] }],
    );
    expect(next).toEqual({ keys: [{ left: "id", right: "" }] });
  });

  it("does not mutate select/pivot (auto-reconciled types)", () => {
    expect(
      clearStaleNodeflowColumnRefs(
        "select",
        { fields: [{ name: "gone", keep: true }] },
        [{ area: "fields", columns: ["gone"] }],
      ),
    ).toBeNull();
  });

  it("returns null when there is nothing to prune (no toast path)", () => {
    expect(
      clearStaleNodeflowColumnRefs(
        "sort",
        { sorts: [{ col: "a", dir: "asc" }] },
        [],
      ),
    ).toBeNull();
  });
});

describe("free-form expressions (filter / formula)", () => {
  it("does not read a function call as a column reference", () => {
    expect(exprColumnRefs("LTRIM([Name])")).toEqual(["Name"]);
    expect(exprColumnRefs("regexp_replace([a], 'x', 'y')")).toEqual(["a"]);
    expect(
      staleNodeflowColumnRefs(
        "formula",
        { formulas: [{ name: "clean", expr: "LTRIM(RTRIM([Name]))" }] },
        { in: ["Name"] },
      ),
    ).toEqual([]);
  });

  it("does not read a workflow variable as a column reference", () => {
    expect(exprColumnRefs("[a] = {{run_date}}")).toEqual(["a"]);
    expect(exprColumnRefs("[a] = ${env_name}")).toEqual(["a"]);
  });

  it("does not flag a reference still being typed", () => {
    expect(exprColumnRefs("[Amoun")).toEqual([]);
    expect(
      staleNodeflowColumnRefs("filter", { condition: "[Amoun" }, { in: ["Amount"] }),
    ).toEqual([]);
  });

  it("treats a formula's own new columns as live for later formulas", () => {
    expect(
      staleNodeflowColumnRefs(
        "formula",
        {
          formulas: [
            { name: "gross", expr: "[qty] * [price]", mode: "new" },
            { name: "net", expr: "[gross] * 0.9", mode: "new" },
          ],
        },
        { in: ["qty", "price"] },
      ),
    ).toEqual([]);
  });

  it("never destroys a formula over an undelimited word", () => {
    expect(
      clearStaleNodeflowColumnRefs(
        "formula",
        { formulas: [{ name: "Sales", expr: "amount * 2" }] },
        [{ area: "formula", columns: ["amount"] }],
      ),
    ).toBeNull();
  });

  it("still clears a formula whose bracketed column really went away", () => {
    expect(
      clearStaleNodeflowColumnRefs(
        "formula",
        { formulas: [{ name: "Sales", expr: "[amount] * 2" }] },
        [{ area: "formula", columns: ["amount"] }],
      ),
    ).toEqual({ formulas: [{ name: "Sales", expr: "" }] });
  });

  it("never destroys a filter condition over an undelimited word", () => {
    expect(
      clearStaleNodeflowColumnRefs(
        "filter",
        { condition: "amount > 2" },
        [{ area: "condition", columns: ["amount"] }],
      ),
    ).toBeNull();
  });
});
