// Builds a CSV from a TableProfile, entirely client-side (the profile is
// computed once and held on the result tab; there is no result_id to hand to
// the backend exporter, so we format it here -- mirrors lib/reconExport.ts).
import { TableProfile } from "./types";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

// A metadata block (table + row count) followed by one row per column with its
// profiled stats. Nested top_values are omitted (CSV is flat); use JSON export
// for the full structure.
export function profileCsv(profile: TableProfile): string {
  const rows: string[] = [];
  rows.push("Profile report");
  rows.push([cell("Table"), cell(profile.table)].join(","));
  rows.push([cell("Total rows"), cell(profile.total_rows)].join(","));
  rows.push("");

  const head = [
    "Column", "Type", "Raw type", "Date format",
    "Nulls", "Null %", "Distinct", "Distinct %",
    "Min", "Max", "Mean", "Std", "Outliers",
  ];
  rows.push(head.map(cell).join(","));

  for (const c of profile.columns || []) {
    rows.push([
      cell(c.column),
      cell(c.type),
      cell(c.raw_type),
      cell(c.date_fmt),
      num(c.nulls),
      num(c.null_pct),
      num(c.distinct),
      num(c.distinct_pct),
      cell(c.min),
      cell(c.max),
      num(c.mean),
      num(c.std),
      num(c.outliers),
    ].join(","));
  }

  return rows.join("\n") + "\n";
}

export function profileCsvFilename(table: string): string {
  const safe =
    (table || "profile").replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "profile";
  return `profile_${safe}.csv`;
}
