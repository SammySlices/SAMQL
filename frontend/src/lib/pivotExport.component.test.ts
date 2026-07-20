import { describe, expect, it } from "vitest";
import { pivotCsv, pivotCsvFilename } from "./pivotExport";

describe("pivotCsv", () => {
  it("writes a header row followed by the data rows", () => {
    const csv = pivotCsv(
      ["region", "Q1", "Q2"],
      [
        ["North", 1, 2],
        ["South", 3, 4],
      ],
    );
    expect(csv).toBe("region,Q1,Q2\nNorth,1,2\nSouth,3,4\n");
  });

  it("quotes cells containing commas, quotes or newlines", () => {
    const csv = pivotCsv(
      ["label", "note"],
      [["a,b", 'say "hi"'], ["multi\nline", null]],
    );
    expect(csv).toBe(
      'label,note\n"a,b","say ""hi"""\n"multi\nline",\n',
    );
  });

  it("writes numbers raw, without the grid's thousands separators", () => {
    // The on-screen cell reads "1,234,567"; a spreadsheet needs 1234567.
    expect(pivotCsv(["n"], [[1234567]])).toBe("n\n1234567\n");
    expect(pivotCsv(["n"], [[1234.5678]])).toBe("n\n1234.5678\n");
  });

  it("renders null and undefined as empty cells", () => {
    expect(pivotCsv(["a", "b"], [[null, undefined as never]])).toBe("a,b\n,\n");
  });

  it("pads a ragged row out to the column count", () => {
    expect(pivotCsv(["a", "b", "c"], [[1]])).toBe("a,b,c\n1,,\n");
  });

  it("emits just the header when there are no rows", () => {
    expect(pivotCsv(["a", "b"], [])).toBe("a,b\n");
  });

  it("keeps subtotal marker rows verbatim", () => {
    const csv = pivotCsv(
      ["region", "quarter", "total"],
      [
        ["North", "Q1", 5],
        ["North", "Total", 5],
      ],
    );
    expect(csv).toContain("North,Total,5");
  });
});

describe("pivotCsvFilename", () => {
  it("builds a name from the source table", () => {
    expect(pivotCsvFilename("sales")).toBe("pivot_sales.csv");
  });

  it("replaces characters that are unsafe in a filename", () => {
    expect(pivotCsvFilename("my table/2026")).toBe("pivot_my_table_2026.csv");
  });

  it("falls back when the source is missing or unusable", () => {
    expect(pivotCsvFilename("")).toBe("pivot.csv");
    expect(pivotCsvFilename(null)).toBe("pivot.csv");
    expect(pivotCsvFilename("///")).toBe("pivot.csv");
  });
});
