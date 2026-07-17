import { describe, expect, it } from "vitest";
import { reconcileSelectFields } from "./selectFields";
import { staleNodeflowColumnRefs } from "./staleNodeflowColumnRefs";
import { isSelectFieldMissingUpstream } from "./selectFields";

/**
 * Input rename → Select keeps missing tombstones; Select *output* schema
 * (live columns only) feeds Summarize, which must flag refs to the old name.
 */
describe("missing column propagate Select → Summarize", () => {
  it("Select marks renamed-away field missing; Summarize sees stale on live output", () => {
    const before = reconcileSelectFields(
      ["region", "amount"],
      [],
    );
    // After input header rename region → region_2, Select still has region.
    const after = reconcileSelectFields(["region_2", "amount"], before);
    expect(
      after.some(
        (f) =>
          f.name === "region" && isSelectFieldMissingUpstream(f, ["region_2", "amount"]),
      ),
    ).toBe(true);

    // Backend Select output omits tombstones → Summarize inspCols are live only.
    const selectOutputLive = ["region_2", "amount"];
    const summarizeStale = staleNodeflowColumnRefs(
      "summarize",
      {
        group_by: ["region"],
        aggs: [{ col: "amount", func: "sum" }],
      },
      { in: selectOutputLive },
    );
    expect(summarizeStale).toEqual([
      { area: "group by", columns: ["region"] },
    ]);
  });
});
