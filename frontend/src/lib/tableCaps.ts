import type { TableInfo } from "./types";

// A DuckDB column type that carries nested structure the flattener can explode
// into child tables: STRUCT / ROW, MAP, UNION, JSON, or any LIST / array
// ("...[]"). Case-insensitive; tolerant of leading/trailing space.
export function isNestedColumnType(ty: string): boolean {
  const t = (ty || "").toUpperCase().trim();
  return (
    t.startsWith("STRUCT") ||
    t.startsWith("ROW(") ||
    t.startsWith("MAP") ||
    t.startsWith("UNION") ||
    t.startsWith("JSON") ||
    t.startsWith("LIST") ||
    t.includes("[]")
  );
}

// Whether to offer "Flatten JSON into tables" for a table. Flatten explodes
// nested JSON structure into linked child tables, and the backend can flatten
// ANY DuckDB table -- when the source isn't a JSON file it dumps the table's
// nested STRUCT/LIST columns back out to JSON and flattens that. So the option
// should track nested *content*, not the source file's extension: a table whose
// JSON arrived as a .txt bundle, or that is backed by a Parquet cache from a
// large load, is still flattenable. Show it for a DuckDB table that either came
// from a JSON file or still has at least one nested column.
export function canFlattenTable(t: TableInfo): boolean {
  if (t.engine !== "duckdb") return false;
  if (/\.(json|ndjson|jsonl)$/i.test(t.source || "")) return true;
  return (t.columns || []).some((c) => isNestedColumnType(c.type));
}
