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
  it("covers every frontend node type exactly once", () => {
    expect(Object.keys(NODE_DEFINITIONS).sort()).toEqual(Object.keys(PORTS).sort());
    expect(new Set(NODE_PALETTE_ORDER).size).toBe(NODE_PALETTE_ORDER.length);

    const grouped = NODE_GROUPS.flatMap((group) => group.types);
    expect(grouped).toEqual(expect.arrayContaining(NODE_PALETTE_ORDER));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(grouped)).toEqual(new Set(NODE_PALETTE_ORDER));
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
