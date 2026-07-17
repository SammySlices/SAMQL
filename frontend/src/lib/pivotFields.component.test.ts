import { describe, expect, it } from "vitest";
import { reconcilePivotFields } from "./pivotFields";

describe("reconcilePivotFields", () => {
  it("drops row/col fields that no longer exist upstream, keeps valid ones", () => {
    const { patch, changed } = reconcilePivotFields(["a", "b"], {
      rows: ["a", "gone"],
      cols: ["b", "missing"],
    });
    expect(changed).toBe(true);
    expect(patch.rows).toEqual(["a"]);
    expect(patch.cols).toEqual(["b"]);
  });

  it("drops measures whose field is missing but keeps count-rows measures", () => {
    const { patch, changed } = reconcilePivotFields(["amount"], {
      values: [
        { field: "amount", agg: "sum" },
        { field: "gone", agg: "avg" },
        { field: "", agg: "count" },
      ],
    });
    expect(changed).toBe(true);
    expect(patch.values).toEqual([
      { field: "amount", agg: "sum" },
      { field: "", agg: "count" },
    ]);
  });

  it("matches column names case-insensitively", () => {
    const { changed } = reconcilePivotFields(["Region", "Amount"], {
      rows: ["region"],
      values: [{ field: "amount", agg: "sum" }],
    });
    expect(changed).toBe(false);
  });

  it("reports no change and an empty patch when everything is still valid", () => {
    const { patch, changed } = reconcilePivotFields(["a", "b"], {
      rows: ["a"],
      cols: ["b"],
      values: [{ field: "a", agg: "sum" }],
    });
    expect(changed).toBe(false);
    expect(patch).toEqual({});
  });

  it("only emits the config keys that actually changed", () => {
    const { patch } = reconcilePivotFields(["a", "b"], {
      rows: ["a"],
      cols: ["b", "gone"],
    });
    expect(patch).toHaveProperty("cols");
    expect(patch).not.toHaveProperty("rows");
    expect(patch.cols).toEqual(["b"]);
  });

  it("leaves configs with no pivot arrays untouched", () => {
    const { patch, changed } = reconcilePivotFields(["a"], { subtotals: true });
    expect(changed).toBe(false);
    expect(patch).toEqual({});
  });
});
