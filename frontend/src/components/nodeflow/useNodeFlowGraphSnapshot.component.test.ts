import { describe, expect, it } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import {
  executionGraphSignature,
  stripCosmeticNodeConfig,
} from "../../lib/nodegraph";
import {
  createNodeFlowGraphSnapshot,
  nodeFlowSnapshotMatches,
} from "./useNodeFlowGraphSnapshot";

const makeNode = (
  id: string,
  x: number,
  y: number,
  config: Record<string, unknown> = { label: id },
): NbNode => ({ id, type: "input", x, y, config });

const makeEdge = (id: string, from: string, to: string): NbEdge => ({
  id,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

describe("NodeFlow graph snapshot cache", () => {
  it("reuses the backend graph while only canvas positions change", () => {
    const config = { label: "source" };
    const nodes = [makeNode("a", 10, 20, config), makeNode("b", 300, 20)];
    const edges = [makeEdge("ab", "a", "b")];
    const snapshot = createNodeFlowGraphSnapshot(nodes, edges);

    expect(
      nodeFlowSnapshotMatches(
        snapshot,
        [
          { ...nodes[0], x: 450, y: 620 },
          { ...nodes[1], x: 900, y: 40 },
        ],
        edges,
      ),
    ).toBe(true);
    expect(snapshot.graph.nodes[0]).not.toHaveProperty("x");
    expect(snapshot.graph.nodes[0]).not.toHaveProperty("y");
  });

  it("invalidates for config and edge-structure changes", () => {
    const nodes = [makeNode("a", 0, 0), makeNode("b", 300, 0)];
    const edges = [makeEdge("ab", "a", "b")];
    const snapshot = createNodeFlowGraphSnapshot(nodes, edges);

    expect(
      nodeFlowSnapshotMatches(
        snapshot,
        [
          { ...nodes[0], config: { ...nodes[0].config, label: "changed" } },
          nodes[1],
        ],
        edges,
      ),
    ).toBe(false);
    expect(
      nodeFlowSnapshotMatches(snapshot, nodes, [
        { ...edges[0], to: { node: "b", port: "right" } },
      ]),
    ).toBe(false);
  });

  it("execution signature ignores cosmetic config but keeps fields/renames", () => {
    const base = {
      table: "t",
      fields: [{ name: "a", keep: true, rename: "A" }],
      bodyW: 220,
      bodyH: 160,
      label: "Select",
      style: { theme: "dark" },
      collapsed: false,
    };
    const nodesA: NbNode[] = [
      makeNode("sel", 0, 0, base),
      makeNode("out", 300, 0, { table: "x" }),
    ];
    const nodesB: NbNode[] = [
      makeNode("sel", 0, 0, {
        ...base,
        bodyW: 400,
        bodyH: 300,
        label: "Renamed UI",
        style: { theme: "light" },
        collapsed: true,
      }),
      nodesA[1],
    ];
    const edges = [makeEdge("e", "sel", "out")];
    expect(executionGraphSignature(nodesA as any, edges as any)).toBe(
      executionGraphSignature(nodesB as any, edges as any),
    );
    expect(createNodeFlowGraphSnapshot(nodesA, edges).signature).toBe(
      createNodeFlowGraphSnapshot(nodesB, edges).signature,
    );

    const nodesFields: NbNode[] = [
      makeNode("sel", 0, 0, {
        ...base,
        fields: [{ name: "a", keep: true, rename: "Alpha" }],
      }),
      nodesA[1],
    ];
    expect(createNodeFlowGraphSnapshot(nodesA, edges).signature).not.toBe(
      createNodeFlowGraphSnapshot(nodesFields, edges).signature,
    );

    const nodesKeep: NbNode[] = [
      makeNode("sel", 0, 0, {
        ...base,
        fields: [{ name: "a", keep: false, rename: "A" }],
      }),
      nodesA[1],
    ];
    expect(createNodeFlowGraphSnapshot(nodesA, edges).signature).not.toBe(
      createNodeFlowGraphSnapshot(nodesKeep, edges).signature,
    );

    expect(stripCosmeticNodeConfig(base)).toEqual({
      table: "t",
      fields: [{ name: "a", keep: true, rename: "A" }],
    });
  });
});
