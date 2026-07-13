import type { ReconcileResult } from "./types";

// just the bits of the reconcile spec the export needs (left/right table names)
export interface ReconExportSpec {
  left: string;
  right: string;
}

// RFC-4180 style cell: quote only when needed (comma, quote, newline), and
// double any embedded quotes.
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * Build a CSV of a reconcile report: a small metadata block (which two tables,
 * the keys, engine, balance field) followed by the per-field breakdown table
 * and a Total row. Balance columns are included only when the report compared a
 * balance field. Pure and side-effect free, so it can be unit-tested; the
 * caller turns the string into a download.
 */
export function reconReportCsv(
  report: ReconcileResult,
  spec: ReconExportSpec,
): string {
  const t = report.totals;
  const hasBal = !!report.balance_field;
  const rows: string[] = [];

  rows.push("Reconcile report");
  rows.push([cell("Left"), cell(spec.left)].join(","));
  rows.push([cell("Right"), cell(spec.right)].join(","));
  rows.push([cell("Keys"), cell((report.keys || []).join("; "))].join(","));
  if (report.engine) rows.push([cell("Engine"), cell(report.engine)].join(","));
  if (report.balance_field)
    rows.push([cell("Balance field"), cell(report.balance_field)].join(","));
  rows.push("");

  const head = ["Field", "A only", "B only", "Not matching", "Matching"];
  if (hasBal) head.push("Sum matching balance", "Sum non-matching balance");
  rows.push(head.map(cell).join(","));

  for (const f of report.fields || []) {
    const r: unknown[] = [
      f.label || f.field,
      f.a_only,
      f.b_only,
      f.non_matching,
      f.matching,
    ];
    if (hasBal)
      r.push(f.sum_matching_balance ?? "", f.sum_non_matching_balance ?? "");
    rows.push(r.map(cell).join(","));
  }

  const tot: unknown[] = [
    "Total",
    t.a_only,
    t.b_only,
    t.non_matching,
    t.matching,
  ];
  if (hasBal) tot.push("", "");
  rows.push(tot.map(cell).join(","));

  return rows.join("\n") + "\n";
}

/** A filesystem-safe name for a report's CSV, e.g. recon_A_vs_B.csv. */
export function reconCsvFilename(spec: ReconExportSpec): string {
  const base = ("recon_" + spec.left + "_vs_" + spec.right)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return (base || "recon_report") + ".csv";
}
