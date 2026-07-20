import { describe, expect, it } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import {
  resolveSqlJoinWiredTables,
  sqlJoinEditorTables,
  sqlJoinRelationName,
  SQLJOIN_INPUT_CAP,
} from "./sqlJoinTableNames";

const node = (
  id: string,
  type: NbNode["type"],
  config: Record<string, unknown> = {},
): NbNode => ({ id, type, x: 0, y: 0, config });

describe("sqlJoinTableNames", () => {
  it("caps stacked inputs at the Union hard cap (10)", () => {
    expect(SQLJOIN_INPUT_CAP).toBe(10);
  });

  it("resolves Input table names through a Select rename node", () => {
    const nodes = [
      node("o", "input", { table: "orders", label: "orders in" }),
      node("s", "select", {
        fields: [{ name: "id", rename: "order_id", keep: true }],
        label: "select",
      }),
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "o", port: "out" },
        to: { node: "s", port: "in" },
      },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(sqlJoinRelationName(byId, edges, "s")).toBe("orders");
  });

  it("builds editor tables from wired ports with latest columns", () => {
    const sj = node("j", "sql", { sql: "SELECT *\nFROM orders", label: "sql" });
    const nodes = [
      node("o", "input", { table: "orders" }),
      node("c", "input", { table: "customers" }),
      sj,
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "o", port: "out" },
        to: { node: "j", port: "in1" },
      },
      {
        id: "e2",
        from: { node: "c", port: "out" },
        to: { node: "j", port: "in2" },
      },
    ];
    const wired = resolveSqlJoinWiredTables(sj, nodes, edges, {
      in1: ["order_id", "customer_id"],
      in2: ["id", "name"],
    });
    expect(wired.map((t) => t.name)).toEqual(["orders", "customers"]);
    const tables = sqlJoinEditorTables(wired, [
      {
        engine: "duckdb",
        name: "orders",
        source: "file",
        row_count: 2,
        columns: [{ name: "id", type: "INTEGER" }],
      },
      {
        engine: "sqlite",
        name: "customers",
        source: "file",
        row_count: 2,
        columns: [{ name: "id", type: "INTEGER" }],
      },
    ]);
    expect(tables[0].columns.map((c) => c.name)).toEqual([
      "order_id",
      "customer_id",
    ]);
    // Columns stay flowed (inspCols), engine follows the loaded table.
    expect(tables[0].engine).toBe("duckdb");
    expect(tables[1].name).toBe("customers");
    expect(tables[1].engine).toBe("sqlite");
  });

  it("defaults editor engine to duckdb when catalog has no match", () => {
    const tables = sqlJoinEditorTables([
      { port: "in1", name: "orders", columns: ["id"] },
    ]);
    expect(tables[0].engine).toBe("duckdb");
  });

  it("falls back to tN when no Input table name exists", () => {
    const sj = node("j", "sql", { sql: "SELECT 1", label: "sql" });
    const nodes = [
      node("p", "python", { code: "out = [{'a': 1}]", label: "python" }),
      sj,
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "p", port: "out" },
        to: { node: "j", port: "in1" },
      },
    ];
    const wired = resolveSqlJoinWiredTables(sj, nodes, edges, { in1: ["a"] });
    expect(wired[0].name).toBe("t1");
  });
});
