import type { Features } from "./types";

export type ExportFormatOption = readonly [fmt: string, label: string];

/** Backend-backed query result formats (CSV through Parquet when available). */
export function backendResultExportFormats(
  features?: Partial<Features> | null,
): ExportFormatOption[] {
  return [
    ["csv", "CSV"],
    ["tsv", "TSV"],
    ["json", "JSON"],
    ["ndjson", "NDJSON"],
    ...(features?.openpyxl ? ([["xlsx", "Excel (xlsx)"]] as const) : []),
    ...(features?.pyarrow ? ([["parquet", "Parquet"]] as const) : []),
  ];
}

/** Client-side report/profile exports (formatted in the browser). */
export function clientResultExportFormats(): ExportFormatOption[] {
  return [
    ["csv", "CSV"],
    ["json", "JSON"],
  ];
}

/** Formats for a result tab: full backend set for queries, CSV/JSON for recon/profile. */
export function exportFormatsForResultTab(
  kind: "result" | "recon" | "profile" | string | undefined,
  features?: Partial<Features> | null,
): ExportFormatOption[] {
  return kind === "result"
    ? backendResultExportFormats(features)
    : clientResultExportFormats();
}
