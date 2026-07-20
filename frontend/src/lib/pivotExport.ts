import type { Cell } from "./types";

/**
 * CSV for the pivot grid shown in the IDE and the Journal.
 *
 * Values are written raw, not through the grid's display formatter: the on
 * screen text uses `toLocaleString` (thousands separators), which would turn a
 * number into a quoted string in a spreadsheet.
 */

// RFC-4180 style cell: quote only when needed (comma, quote, newline), and
// double any embedded quotes.
const cell = (v: Cell): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * Build the CSV text for a pivot result.
 *
 * Pass the rows in the order the grid is showing them (the sorted view) so the
 * file matches what the user is looking at. Collapsed groups are deliberately
 * NOT folded — the export carries the whole pivot, since a collapsed group is a
 * reading convenience rather than a filter.
 */
export function pivotCsv(columns: string[], rows: Cell[][]): string {
  const out: string[] = [];
  out.push(columns.map((c) => cell(c)).join(","));
  for (const r of rows) {
    // A short row (ragged backend result) still needs its trailing commas so
    // the column count stays consistent.
    const line: string[] = [];
    for (let i = 0; i < columns.length; i += 1) line.push(cell(r[i] ?? null));
    out.push(line.join(","));
  }
  return out.join("\n") + "\n";
}

/** A filesystem-safe CSV name for a pivot of `source`, e.g. pivot_sales.csv. */
export function pivotCsvFilename(source?: string | null): string {
  const base = ("pivot_" + (source || ""))
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return (base || "pivot") + ".csv";
}
