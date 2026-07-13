import { describe, expect, it } from "vitest";
import {
  buildJournalDependencyGraph,
  planJournalRunAll,
  type ChainCell,
} from "./notebook";

function sql(
  id: string,
  name: string,
  code: string,
  extra: Partial<ChainCell> = {},
): ChainCell {
  return { id, name, code, type: "sql", ...extra };
}

function fresh(
  id: string,
  name: string,
  code: string,
  compiled: string,
  extra: Partial<ChainCell> = {},
): ChainCell {
  return sql(id, name, code, {
    ranOnce: true,
    resultId: `result-${id}`,
    ranCompiledSql: compiled,
    ...extra,
  });
}

describe("Journal dependency optimization", () => {
  it("skips every unchanged complete result", () => {
    const cells = [
      fresh("a", "cell1", "SELECT 1", "A"),
      fresh("b", "cell2", "SELECT * FROM cell1", "B"),
    ];
    const plan = planJournalRunAll(cells, [], { a: "A", b: "B" });
    expect(plan.runIds).toEqual([]);
    expect(plan.reusedIds).toEqual(["a", "b"]);
    expect(plan.waves).toEqual([]);
  });

  it("runs only a changed cell and its stale descendants", () => {
    const cells = [
      fresh("a", "cell1", "SELECT 1 AS n", "A"),
      fresh("b", "cell2", "SELECT * FROM cell1", "B-old"),
      fresh("c", "cell3", "SELECT * FROM cell2", "C-old"),
    ];
    const plan = planJournalRunAll(cells, [], {
      a: "A",
      b: "B-new",
      c: "C-new",
    });
    expect(plan.reusedIds).toEqual(["a"]);
    expect(plan.runIds).toEqual(["b", "c"]);
    expect(plan.waves).toEqual([["b"], ["c"]]);
  });

  it("runs independent stale branches in the same wave", () => {
    const cells = [
      sql("a", "left", "SELECT 1 AS id"),
      sql("b", "right", "SELECT 2 AS id"),
      sql("c", "joined", "SELECT * FROM left UNION ALL SELECT * FROM right"),
    ];
    const plan = planJournalRunAll(cells, [], {
      a: "A",
      b: "B",
      c: "C",
    });
    expect(plan.graph.depIds.c).toEqual(["a", "b"]);
    expect(plan.waves).toEqual([["a", "b"], ["c"]]);
  });

  it("orders a later group after the earlier group's last SQL cell", () => {
    const groups = [
      { id: "g1", name: "Load" },
      { id: "g2", name: "Report" },
    ];
    const cells = [
      fresh("a", "raw", "SELECT 1 AS id", "A", { group: "g1" }),
      sql("b", "clean", "SELECT * FROM raw", { group: "g1" }),
      sql("c", "summary", 'SELECT COUNT(*) FROM "Load"', { group: "g2" }),
    ];
    const graph = buildJournalDependencyGraph(cells, groups);
    expect(graph.depIds.c).toEqual(["b"]);
    const plan = planJournalRunAll(cells, groups, {
      a: "A",
      b: "B",
      c: "C",
    });
    expect(plan.reusedIds).toEqual(["a"]);
    expect(plan.waves).toEqual([["b"], ["c"]]);
  });

  it("never reuses a capped result", () => {
    const cells = [fresh("a", "cell1", "SELECT 1", "A")];
    const plan = planJournalRunAll(cells, [], { a: "A" }, { a: true });
    expect(plan.reusedIds).toEqual([]);
    expect(plan.runIds).toEqual(["a"]);
    expect(plan.waves).toEqual([["a"]]);
  });

  it("tracks chart and reconcile dependencies with the same graph", () => {
    const cells: ChainCell[] = [
      sql("a", "left", "SELECT 1 AS id"),
      sql("b", "right", "SELECT 1 AS id"),
      { id: "chart", type: "chart", code: "", sourceName: "left" },
      {
        id: "reconcile",
        type: "reconcile",
        code: "",
        leftSource: "left",
        rightSource: "right",
      },
    ];
    const graph = buildJournalDependencyGraph(cells);
    expect(graph.depIds.chart).toEqual(["a"]);
    expect(graph.depIds.reconcile).toEqual(["a", "b"]);
  });
});
