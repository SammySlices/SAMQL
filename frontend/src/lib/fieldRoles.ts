// Classify result / table columns as measure vs dimension for Pivot and
// Chart pickers. Prefers SQL type strings (ColumnInfo / DESCRIBE-like);
// falls back to a light sample of Cell values when types are absent
// (query result pages only ship column *names*).

import type { Cell } from "./types";

export type FieldRole = "measure" | "dimension" | "unknown";

const MEASURE_RE =
  /^(U?INT(EGER)?|BIGINT|SMALLINT|TINYINT|HUGEINT|UBIGINT|USMALLINT|UTINYINT|UINTEGER|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|NUMBER|HUGEINT|DECIMAL\(\d+(,\s*\d+)?\))$/i;

const DATE_RE =
  /^(DATE|TIME|TIMESTAMP|TIMESTAMPTZ|DATETIME|INTERVAL|TIMESTAMP WITH TIME ZONE)$/i;

const BOOL_RE = /^(BOOL(EAN)?|BIT)$/i;

/** Map a SQL / DuckDB / SQLite type string to a picker role. */
export function classifySqlType(type?: string | null): FieldRole {
  const raw = String(type || "").trim();
  if (!raw) return "unknown";
  // Strip list/array suffix and take the leaf scalar when nested.
  let t = raw.toUpperCase();
  if (t.endsWith("[]")) t = t.slice(0, -2).trim();
  // STRUCT / LIST / MAP / JSON / VARCHAR → dimension (categorical / opaque).
  if (
    t.startsWith("STRUCT") ||
    t.startsWith("MAP") ||
    t.startsWith("LIST") ||
    t === "JSON" ||
    t === "VARCHAR" ||
    t === "TEXT" ||
    t === "STRING" ||
    t === "CHAR" ||
    t.startsWith("CHAR(") ||
    t.startsWith("VARCHAR(") ||
    t === "UUID" ||
    t === "BLOB" ||
    t === "BYTEA" ||
    DATE_RE.test(t) ||
    BOOL_RE.test(t)
  ) {
    return "dimension";
  }
  if (MEASURE_RE.test(t) || /^DECIMAL\b/.test(t) || /^NUMERIC\b/.test(t)) {
    return "measure";
  }
  // Mixed / unknown SQL dialects: treat anything with INT/FLOAT/DOUBLE as measure.
  if (/\b(INT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|NUMBER)\b/.test(t)) {
    return "measure";
  }
  return "dimension";
}

/** Infer a coarse SQL-ish type label from non-null sample cells. */
export function inferTypeFromSamples(samples: Cell[]): string {
  const vals = samples.filter((v) => v !== null && v !== undefined);
  if (!vals.length) return "";
  if (vals.every((v) => typeof v === "boolean")) return "BOOLEAN";
  if (
    vals.every(
      (v) => typeof v === "number" && Number.isFinite(v) && !Number.isNaN(v),
    )
  ) {
    return vals.every((v) => Number.isInteger(v as number))
      ? "INTEGER"
      : "DOUBLE";
  }
  if (vals.every((v) => typeof v === "string")) {
    const strs = vals as string[];
    // ISO-ish date / datetime → dimension date role.
    if (
      strs.every((s) =>
        /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
          s.trim(),
        ),
      )
    ) {
      return "TIMESTAMP";
    }
    // Numeric strings that look like measures (all parse as finite numbers).
    if (
      strs.every((s) => {
        const t = s.trim();
        if (!t) return false;
        const n = Number(t);
        return Number.isFinite(n);
      })
    ) {
      return "DOUBLE";
    }
    return "VARCHAR";
  }
  return "";
}

/** Build `{ columnName: typeLabel }` from a result page sample. */
export function inferColumnTypes(
  columns: string[],
  rows: Cell[][] | undefined | null,
  maxRows = 40,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!columns.length) return out;
  const sample = (rows || []).slice(0, maxRows);
  for (let i = 0; i < columns.length; i++) {
    const cells: Cell[] = [];
    for (const r of sample) {
      if (r && i < r.length) cells.push(r[i]);
    }
    const t = inferTypeFromSamples(cells);
    if (t) out[columns[i]] = t;
  }
  return out;
}

export function fieldRole(
  type?: string | null,
): FieldRole {
  return classifySqlType(type);
}

export function shortFieldType(type?: string | null): string {
  const t = String(type || "").trim();
  if (!t) return "?";
  const tu = t.toUpperCase();
  if (tu.endsWith("[]")) {
    const base = tu.slice(0, -2).trim();
    if (base.startsWith("STRUCT")) return "list";
    return "list";
  }
  if (tu.startsWith("STRUCT")) return "record";
  if (tu.startsWith("MAP")) return "map";
  if (tu === "JSON") return "json";
  if (MEASURE_RE.test(tu) || /^DECIMAL\b/.test(tu) || /^NUMERIC\b/.test(tu)) {
    if (/INT/.test(tu)) return "int";
    if (/DOUBLE|FLOAT|REAL/.test(tu)) return "num";
    return "num";
  }
  if (DATE_RE.test(tu)) return "date";
  if (BOOL_RE.test(tu)) return "bool";
  if (tu === "VARCHAR" || tu === "TEXT" || tu === "STRING" || tu.startsWith("VARCHAR"))
    return "text";
  return t.length > 10 ? t.slice(0, 10) + "…" : t.toLowerCase();
}

export function roleLabel(role: FieldRole): string {
  if (role === "measure") return "Measures";
  if (role === "dimension") return "Dimensions";
  return "Other";
}

/** Group columns for optgroups / drawer sections. Unknowns sit with dimensions
 *  so they stay visible; empty groups are omitted by callers. */
export function groupColumnsByRole(
  columns: string[],
  types: Record<string, string> | undefined | null,
): { dimensions: string[]; measures: string[]; other: string[] } {
  const dimensions: string[] = [];
  const measures: string[] = [];
  const other: string[] = [];
  for (const c of columns) {
    const role = fieldRole(types?.[c]);
    if (role === "measure") measures.push(c);
    else if (role === "dimension") dimensions.push(c);
    else other.push(c);
  }
  return { dimensions, measures, other };
}

/** Prefer a dimension for category/X and a measure for value/Y without
 *  changing an already-valid selection. Falls back to index order. */
export function pickDefaultChartAxes(
  columns: string[],
  types: Record<string, string> | undefined | null,
  prev?: { x?: string; y?: string },
): { x: string; y: string } {
  if (!columns.length) return { x: "", y: "" };
  const { dimensions, measures, other } = groupColumnsByRole(columns, types);
  const dimFirst = [...dimensions, ...other, ...measures];
  const measFirst = [...measures, ...other, ...dimensions];
  const x =
    prev?.x && columns.includes(prev.x)
      ? prev.x
      : dimFirst[0] || columns[0];
  let y =
    prev?.y && columns.includes(prev.y)
      ? prev.y
      : measFirst.find((c) => c !== x) ||
        columns.find((c) => c !== x) ||
        columns[0];
  // If Y landed on the same column as X and we have another choice, prefer it.
  if (y === x && columns.length > 1) {
    y = measFirst.find((c) => c !== x) || columns.find((c) => c !== x) || y;
  }
  return { x, y };
}

/** Default pivot aggregation when dropping a field onto Values.
 *  Known dimensions → count (avoids sum-on-text mistakes). Measures and
 *  unknown types keep the historical sum default so untyped result pages
 *  behave as before. */
export function defaultPivotAgg(type?: string | null): "sum" | "count" {
  return fieldRole(type) === "dimension" ? "count" : "sum";
}
