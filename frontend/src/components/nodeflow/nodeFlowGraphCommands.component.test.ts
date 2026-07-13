import { describe, expect, it } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import {
  appendGroupChild,
  createGraphNode,
  dissolveContainerGraph,
  extractGroupChild,
  findChildNode,
  moveNodeIntoContainer,
  patchNodeConfig,
  removeGraphNodes,
  removeGroupChild,
  reorderGroupChildren,
} from "./nodeFlowGraphCommands";

const node = (
  id: string,
  type: NbNode["type"],
  x = 0,
  y = 0,
  config: Record<string, unknown> = {},
): NbNode => ({ id, type, x, y, config });

const edge = (id: string, from: string, to: string): NbEdge => ({
  id,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

describe("NodeFlow graph commands", () => {
  it("creates bounded nodes with fresh registry defaults", () => {
    const first = createGraphNode("formula", -4.8, 20.6, "formula-a");
    const second = createGraphNode("formula", 12, 22, "formula-b");

    expect(first).toMatchObject({ id: "formula-a", x: 0, y: 21 });
    expect(first.config).toEqual({
      formulas: [{ name: "", expr: "", mode: "new" }],
      label: "formula",
    });
    expect(first.config.formulas).not.toBe(second.config.formulas);
  });

  it("locates and patches a nested child without mutating siblings", () => {
    const graph = [
      node("group", "group", 10, 20, {
        children: [
          { id: "child-a", type: "filter", config: { condition: "a = 1" } },
          { id: "child-b", type: "select", config: { fields: ["a"] } },
        ],
      }),
    ];

    expect(findChildNode(graph, "child-a")).toMatchObject({
      groupId: "group",
      index: 0,
      child: { id: "child-a", x: 0, y: 0 },
    });

    const next = patchNodeConfig(graph, "child-a", { condition: "a = 2" });
    const children = next[0].config.children as Array<{ config: Record<string, unknown> }>;
    expect(children[0].config.condition).toBe("a = 2");
    expect(children[1].config).toEqual({ fields: ["a"] });
    expect(next).not.toBe(graph);
    expect(graph[0].config.children[0].config.condition).toBe("a = 1");
  });

  it("adds, reorders, and removes container children through one command layer", () => {
    const graph = [node("group", "group", 0, 0, { children: [] })];
    const addedA = appendGroupChild(graph, "group", "filter", "child-a");
    const addedB = appendGroupChild(addedA.nodes, "group", "select", "child-b");
    const reordered = reorderGroupChildren(addedB.nodes, "group", 1, 0);
    const children = reordered[0].config.children as Array<{ id: string }>;

    expect(addedA.childId).toBe("child-a");
    expect(children.map((child) => child.id)).toEqual(["child-b", "child-a"]);
    expect(
      (removeGroupChild(reordered, "group", "child-b")[0].config.children as Array<{ id: string }>).map(
        (child) => child.id,
      ),
    ).toEqual(["child-a"]);
  });

  it("extracts and dissolves containers while preserving child configuration", () => {
    const graph = [
      node("source", "input", 0, 0),
      node("group", "group", 100, 80, {
        children: [
          { id: "child-a", type: "filter", config: { condition: "a > 0" } },
          { id: "child-b", type: "select", config: { fields: ["a"] } },
        ],
      }),
      node("sink", "output", 500, 80),
    ];
    const edges = [edge("in", "source", "group"), edge("out", "group", "sink")];

    const extracted = extractGroupChild(graph, "group", "child-a");
    expect(extracted.extractedId).toBe("child-a");
    expect(extracted.nodes.find((item) => item.id === "child-a")).toMatchObject({
      type: "filter",
      config: { condition: "a > 0" },
    });

    const dissolved = dissolveContainerGraph(graph, edges, "group");
    expect(dissolved.selectedId).toBe("child-a");
    expect(dissolved.graph.nodes.map((item) => item.id)).toEqual([
      "source",
      "sink",
      "child-a",
      "child-b",
    ]);
    expect(dissolved.graph.edges).toEqual([]);
  });

  it("moves ordinary nodes into containers and removes incident external wires", () => {
    const graph = [
      node("source", "input"),
      node("formula", "formula", 100, 100, { label: "calc" }),
      node("group", "group", 300, 100, { children: [] }),
    ];
    const edges = [edge("a", "source", "formula"), edge("b", "formula", "group")];
    const moved = moveNodeIntoContainer(graph, edges, "formula", "group");

    expect(moved.nodes.find((item) => item.id === "formula")).toBeUndefined();
    expect(moved.edges).toEqual([]);
    expect(moved.nodes.find((item) => item.id === "group")?.config.children).toEqual([
      { id: "formula", type: "formula", config: { label: "calc" } },
    ]);

    const invalid = moveNodeIntoContainer(graph, edges, "formula", "missing");
    expect(invalid.nodes).toBe(graph);
    expect(invalid.edges).toBe(edges);
  });

  it("removes selected nodes and every incident edge atomically", () => {
    const nodes = [node("a", "input"), node("b", "filter"), node("c", "output")];
    const edges = [edge("ab", "a", "b"), edge("bc", "b", "c")];
    expect(removeGraphNodes(nodes, edges, ["b"])).toEqual({
      nodes: [nodes[0], nodes[2]],
      edges: [],
    });
  });
});
