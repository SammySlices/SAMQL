import { describe, expect, it } from "vitest";
import { PORTS, type NbEdge, type NbNode, type NodeType } from "../../lib/nodeFlowModel";
import {
  NODE_DEFINITIONS,
  NODE_GROUPS,
  NODE_PALETTE_ORDER,
  createDefaultNodeConfig,
  getNodeCardSummary,
  getNodeDefinition,
  getNodeInspectorType,
  nodeInspectorIsResizable,
} from "./nodeDefinitions";

const node = (
  type: NodeType,
  config: Record<string, unknown> = {},
  id = `${type}-1`,
): NbNode => ({ id, type, x: 0, y: 0, config });

describe("node definition registry", () => {
  it("covers every frontend node type; SQL may appear in two palette groups", () => {
    expect(Object.keys(NODE_DEFINITIONS).sort()).toEqual(Object.keys(PORTS).sort());
    expect(new Set(NODE_PALETTE_ORDER).size).toBe(NODE_PALETTE_ORDER.length);

    const grouped = NODE_GROUPS.flatMap((group) => group.types);
    expect(grouped).toEqual(expect.arrayContaining(NODE_PALETTE_ORDER));
    // Most types appear once; SQL is intentionally listed in Combine and Create.
    const MULTI_GROUP = new Set<string>(["sql"]);
    const counts = new Map<string, number>();
    for (const t of grouped) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of counts) {
      if (MULTI_GROUP.has(t)) expect(n).toBeGreaterThanOrEqual(2);
      else expect(n).toBe(1);
    }
    expect(new Set(grouped)).toEqual(new Set(NODE_PALETTE_ORDER));

    const combine = NODE_GROUPS.find((g) => g.id === "combine")!;
    const create = NODE_GROUPS.find((g) => g.id === "create")!;
    expect(combine.types).toContain("sql");
    expect(create.types).toContain("sql");
    expect(PORTS.sql.inputs).toHaveLength(10);
    expect(PORTS.sql.outputs).toEqual(["out"]);
    expect(getNodeDefinition("sql").label).toBe("SQL");
    expect(nodeInspectorIsResizable("sql")).toBe(true);
  });

  it("returns fresh default configuration objects", () => {
    const first = createDefaultNodeConfig("formula");
    const second = createDefaultNodeConfig("formula");

    expect(first).toEqual({
      formulas: [{ name: "", expr: "", mode: "new" }],
      label: "formula",
    });
    expect(first).not.toBe(second);
    expect(first.formulas).not.toBe(second.formulas);

    first.formulas[0].name = "changed";
    expect(second.formulas[0].name).toBe("");

    const fileBrowser = createDefaultNodeConfig("filebrowser");
    expect(fileBrowser).toEqual({
      pattern: "",
      source_column: "",
      label: "file browser",
    });

    const apiFirst = createDefaultNodeConfig("apinode");
    const apiSecond = createDefaultNodeConfig("apinode");
    expect(apiFirst).toEqual({
      url: "",
      params: [],
      json_path: "",
      auth_user: "",
      retry: { retries: 0 },
      continue_on_error: false,
      label: "api",
    });
    expect(apiFirst.params).not.toBe(apiSecond.params);
    expect(apiFirst.retry).not.toBe(apiSecond.retry);

    expect(createDefaultNodeConfig("while")).toEqual({
      table: "",
      var: "",
      reset_first: true,
      replace_keys: [],
      accumulate: "append",
      max_iters: 100,
      label: "repeat until",
    });
  });

  it("centralizes inspector selection and resize behavior", () => {
    expect(getNodeInspectorType("input")).toBe("input");
    expect(getNodeDefinition("perioddelta").label).toBe("Period change");
    expect(nodeInspectorIsResizable("formula")).toBe(true);
    expect(nodeInspectorIsResizable("filter")).toBe(false);
  });

  it("builds card summaries from node configuration and edges", () => {
    expect(getNodeCardSummary(node("input", { table: "orders" }), [])).toBe("orders");
    expect(getNodeCardSummary(node("input", { table: "" }), [])).toBe(
      "(pick a table)",
    );
    expect(
      getNodeCardSummary(node("filter", { condition: "score > 50" }), []),
    ).toBe("score > 50");
    expect(getNodeCardSummary(node("filter", { condition: "" }), [])).toBe(
      "(set a condition)",
    );
    expect(getNodeCardSummary(node("filter", { condition: "   " }), [])).toBe(
      "(set a condition)",
    );
    expect(
      getNodeCardSummary(
        node("formula", {
          formulas: [{ name: "total", expr: "[price] * [qty]", mode: "new" }],
        }),
        [],
      ),
    ).toBe("total = [price] * [qty]");
    expect(
      getNodeCardSummary(
        node("formula", {
          formulas: [
            { name: "a", expr: "1", mode: "new" },
            { name: "b", expr: "2", mode: "new" },
          ],
        }),
        [],
      ),
    ).toBe("a = 1; b = 2");
    expect(
      getNodeCardSummary(
        node("formula", { formulas: [{ name: "", expr: "", mode: "new" }] }),
        [],
      ),
    ).toBe("(set expression)");
    expect(
      getNodeCardSummary(
        node("join", { keys: [{ left: "id", right: "order_id" }] }),
        [],
      ),
    ).toBe("on id");

    const edges: NbEdge[] = [
      { id: "e1", from: { node: "chart-1", port: "out" }, to: { node: "dash-1", port: "in1" } },
      { id: "e2", from: { node: "chart-2", port: "out" }, to: { node: "dash-1", port: "in2" } },
    ];
    expect(getNodeCardSummary(node("dashboard", {}, "dash-1"), edges)).toBe("2/4 charts");
  });
});
