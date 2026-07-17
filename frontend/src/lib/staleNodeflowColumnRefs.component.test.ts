import { describe, expect, it } from "vitest";
import {
  clearStaleNodeflowColumnRefs,
  exprColumnRefs,
  NO_AUTO_PRUNE_STALE_TYPES,
  STALE_REF_NODE_TYPES,
  staleNodeflowColumnRefs,
} from "./staleNodeflowColumnRefs";

describe("staleNodeflowColumnRefs", () => {
  it("lists freeform types that must never auto-prune", () => {
    expect([...NO_AUTO_PRUNE_STALE_TYPES].sort()).toEqual(["filter", "formula"]);
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
