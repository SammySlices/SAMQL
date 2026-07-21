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

  it("does not explode an unbracketed multi-word name into fragments", () => {
    // The user's example: renaming `a` -> `hi my name is Bob` must never show
    // hi/my/name/is/Bob as separate missing refs. Typed unbracketed it is
    // invalid SQL the app never emits (autocomplete brackets names), so the
    // hardening simply refuses to fragment a run of >=2 adjacent words.
    const refs = exprColumnRefs("hi my name is Bob = 5");
    expect(refs).not.toContain("hi");
    expect(refs).not.toContain("my");
    expect(refs).not.toContain("name");
    expect(refs).not.toContain("is");
    expect(refs).not.toContain("Bob");
    expect(refs).toEqual([]);
  });

  it("still splits boolean-connected bare columns (col1 and col2)", () => {
    expect(exprColumnRefs("col1 and col2")).toEqual(["col1", "col2"]);
    expect(exprColumnRefs("a > 1 OR b < 2")).toEqual(["a", "b"]);
  });

  it("still yields a lone bare column and operator-separated columns", () => {
    expect(exprColumnRefs("amount * 2")).toEqual(["amount"]);
    expect(exprColumnRefs("qty + price")).toEqual(["qty", "price"]);
  });

  it("multijoin: an unprobed input port flags no missing keys on that side", () => {
    // `against` (in1) is known; the joined input (in2) has not been probed yet.
    // Only the left side's key is checked -- the right side stays silent rather
    // than reporting every key as missing against an empty column set.
    const stale = staleNodeflowColumnRefs(
      "multijoin",
      {
        base: "in1",
        joins: [{ input: "in2", against: "in1", on: [{ left: "id", right: "ref" }] }],
      },
      { in1: ["id", "name"] },
    );
    expect(stale).toEqual([]);
    const staleGone = staleNodeflowColumnRefs(
      "multijoin",
      {
        base: "in1",
        joins: [{ input: "in2", against: "in1", on: [{ left: "missing", right: "ref" }] }],
      },
      { in1: ["id", "name"] },
    );
    expect(staleGone).toEqual([
      { area: "join 1 key 1 left", columns: ["missing"] },
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
