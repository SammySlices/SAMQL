import { describe, expect, it } from "vitest";
import type { NbEdge, NbNode } from "./nodeFlowModel";
import {
  ancestorNodeIds,
  applyMissingRefPruneToNodes,
  columnProbeReqsForNodes,
  pruneNodeConfigMissingRefs,
} from "./pruneNodeflowMissingAfterRun";

describe("pruneNodeflowMissingAfterRun", () => {
  it("ancestorNodeIds includes terminals and upstream parents", () => {
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in", port: "out" },
        to: { node: "sel", port: "in" },
      },
      {
        id: "e2",
        from: { node: "sel", port: "out" },
        to: { node: "sort", port: "in" },
      },
    ];
    expect([...ancestorNodeIds(edges, ["sort"])].sort()).toEqual([
      "in",
      "sel",
      "sort",
    ]);
  });

  it("pruneNodeConfigMissingRefs clears Select missing tombstones", () => {
    const next = pruneNodeConfigMissingRefs(
      "select",
      {
        fields: [
          { name: "a", keep: true },
          { name: "gone", keep: true },
        ],
      },
      { in: ["a"] },
    );
    expect(next).toEqual({ fields: [{ name: "a", keep: true }] });
  });

  it("pruneNodeConfigMissingRefs clears sort missing cols", () => {
    const next = pruneNodeConfigMissingRefs(
      "sort",
      {
        sorts: [
          { col: "a", dir: "asc" },
          { col: "gone", dir: "desc" },
        ],
      },
      { in: ["a", "b"] },
    );
    expect(next).toEqual({
      sorts: [{ col: "a", dir: "asc" }],
    });
  });

  it("applyMissingRefPruneToNodes only patches targeted nodes", () => {
    const nodes: NbNode[] = [
      {
        id: "sel",
        type: "select",
        x: 0,
        y: 0,
        config: {
          fields: [
            { name: "a", keep: true },
            { name: "gone", keep: true },
          ],
        },
      },
      {
        id: "sort",
        type: "sort",
        x: 0,
        y: 0,
        config: {
          sorts: [
            { col: "a", dir: "asc" },
            { col: "gone", dir: "desc" },
          ],
        },
      },
    ];
    const next = applyMissingRefPruneToNodes(
      nodes,
      new Set(["sel"]),
      { sel: { in: ["a"] } },
    );
    expect(next[0].config.fields).toEqual([{ name: "a", keep: true }]);
    // sort not targeted — unchanged
    expect(next[1].config.sorts).toEqual([
      { col: "a", dir: "asc" },
      { col: "gone", dir: "desc" },
    ]);
  });

  it("ancestor closure stays inside one disconnected chain", () => {
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-a", port: "out" },
        to: { node: "sel-a", port: "in" },
      },
      {
        id: "e2",
        from: { node: "sel-a", port: "out" },
        to: { node: "sum-a", port: "in" },
      },
      {
        id: "e3",
        from: { node: "in-b", port: "out" },
        to: { node: "sel-b", port: "in" },
      },
    ];
    expect([...ancestorNodeIds(edges, ["sum-a"])].sort()).toEqual([
      "in-a",
      "sel-a",
      "sum-a",
    ]);
    expect([...ancestorNodeIds(edges, ["sel-b"])].sort()).toEqual([
      "in-b",
      "sel-b",
    ]);
  });

  it("columnProbeReqsForNodes uses only wired parents of targeted nodes", () => {
    const nodes: NbNode[] = [
      { id: "in-a", type: "input", x: 0, y: 0, config: {} },
      { id: "in-b", type: "input", x: 0, y: 80, config: {} },
      {
        id: "sel-a",
        type: "select",
        x: 120,
        y: 0,
        config: { fields: [{ name: "a", keep: true }] },
      },
      {
        id: "sel-b",
        type: "select",
        x: 120,
        y: 80,
        config: { fields: [{ name: "b", keep: true }] },
      },
      {
        id: "join",
        type: "join",
        x: 240,
        y: 40,
        config: { keys: [{ left: "a", right: "b" }] },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-a", port: "out" },
        to: { node: "sel-a", port: "in" },
      },
      {
        id: "e2",
        from: { node: "in-b", port: "out" },
        to: { node: "sel-b", port: "in" },
      },
      {
        id: "e3",
        from: { node: "sel-a", port: "out" },
        to: { node: "join", port: "left" },
      },
      // right port intentionally unwired — must not invent a probe
    ];
    const probes = columnProbeReqsForNodes(
      nodes,
      edges,
      new Set(["sel-a", "sel-b", "join"]),
    );
    expect(probes).toEqual([
      {
        nodeId: "sel-a",
        port: "in",
        fromNode: "in-a",
        fromPort: "out",
      },
      {
        nodeId: "sel-b",
        port: "in",
        fromNode: "in-b",
        fromPort: "out",
      },
      {
        nodeId: "join",
        port: "left",
        fromNode: "sel-a",
        fromPort: "out",
      },
    ]);
  });
});
