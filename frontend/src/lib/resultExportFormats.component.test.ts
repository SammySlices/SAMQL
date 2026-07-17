import { describe, expect, it } from "vitest";
import {
  backendResultExportFormats,
  clientResultExportFormats,
  exportFormatsForResultTab,
} from "./resultExportFormats";

describe("resultExportFormats", () => {
  it("includes optional Excel and Parquet when features allow", () => {
    const fmts = backendResultExportFormats({ openpyxl: true, pyarrow: true });
    expect(fmts.map(([fmt]) => fmt)).toEqual([
      "csv",
      "tsv",
      "json",
      "ndjson",
      "xlsx",
      "parquet",
    ]);
  });

  it("limits recon/profile tabs to CSV and JSON", () => {
    expect(exportFormatsForResultTab("recon", { openpyxl: true })).toEqual(
      clientResultExportFormats(),
    );
    expect(exportFormatsForResultTab("profile")).toEqual(
      clientResultExportFormats(),
    );
  });
});
