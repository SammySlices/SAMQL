import { describe, expect, it } from "vitest";
import { tablesCatalogEqual } from "./useCatalogController";
import type { TableInfo } from "../lib/types";

function table(
  partial: Partial<TableInfo> & Pick<TableInfo, "engine" | "name">,
): TableInfo {
  return {
    columns: [],
    row_count: 0,
    source: "",
    ...partial,
  };
}

describe("tablesCatalogEqual", () => {
  it("returns true for identical snapshots", () => {
    const a = [
      table({
        engine: "duckdb",
        name: "t1",
        row_count: 3,
        columns: [{ name: "id", type: "INTEGER" }],
      }),
    ];
    const b = [
      table({
        engine: "duckdb",
        name: "t1",
        row_count: 3,
        columns: [{ name: "id", type: "INTEGER" }],
      }),
    ];
    expect(tablesCatalogEqual(a, b)).toBe(true);
  });

  it("returns false when row_count changes", () => {
    const a = [table({ engine: "duckdb", name: "t1", row_count: 1 })];
    const b = [table({ engine: "duckdb", name: "t1", row_count: 2 })];
    expect(tablesCatalogEqual(a, b)).toBe(false);
  });

  it("returns false when a column type changes", () => {
    const a = [
      table({
        engine: "sqlite",
        name: "t1",
        columns: [{ name: "v", type: "TEXT" }],
      }),
    ];
    const b = [
      table({
        engine: "sqlite",
        name: "t1",
        columns: [{ name: "v", type: "INTEGER" }],
      }),
    ];
    expect(tablesCatalogEqual(a, b)).toBe(false);
  });

  it("treats missing source as empty string", () => {
    const a = [table({ engine: "duckdb", name: "t1" })];
    a[0].source = undefined as unknown as string;
    const b = [table({ engine: "duckdb", name: "t1", source: "" })];
    expect(tablesCatalogEqual(a, b)).toBe(true);
  });
});
