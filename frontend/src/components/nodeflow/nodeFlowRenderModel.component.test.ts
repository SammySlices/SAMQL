import { describe, expect, it } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import {
  buildNodeFlowRenderModel,
  dirtyNodesAreGeometryOnly,
  patchNodeFlowRenderModelForDirtyNodes,
  selectVisibleCanvasNodes,
  selectVisibleCanvasWires,
} from "./nodeFlowRenderModel";

const node = (id: string, x: number, y: number, type: NbNode["type"] = "input"): NbNode => ({
  id,
  type,
  x,
  y,
  config: { label: id },
});

const edge = (
  id: string,
  from: string,
  to: string,
  fromPort = "out",
  toPort = "in",
): NbEdge => ({
  id,
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

describe("NodeFlow render model", () => {
  it("invalidates only incident cards for an unrelated branch wiring change", () => {
    const nodes = [node("a", 0, 0), node("b", 240, 0, "output"), node("c", 0, 300), node("d", 240, 300, "output")];
    const first = buildNodeFlowRenderModel(nodes, [edge("ab", "a", "b")]);
    const second = buildNodeFlowRenderModel(nodes, [edge("ab", "a", "b"), edge("cd", "c", "d")]);

    expect(second.renderVersionByNode.a).toBe(first.renderVersionByNode.a);
    expect(second.renderVersionByNode.b).toBe(first.renderVersionByNode.b);
    expect(second.renderVersionByNode.c).not.toBe(first.renderVersionByNode.c);
    expect(second.renderVersionByNode.d).not.toBe(first.renderVersionByNode.d);
  });

  it("tracks dashboard source config without globally invalidating other cards", () => {
    const chart: NbNode = { ...node("chart", 0, 0, "chart"), config: { label: "Chart", chart_type: "bar" } };
    const dashboard = node("dash", 300, 0, "dashboard");
    const other = node("other", 0, 400, "input");
    const links = [edge("chart-dash", "chart", "dash", "out", "in1")];
    const first = buildNodeFlowRenderModel([chart, dashboard, other], links);
    const changedChart = { ...chart, config: { ...chart.config, chart_type: "line" } };
    const second = buildNodeFlowRenderModel([changedChart, dashboard, other], links);

    expect(second.renderVersionByNode.dash).not.toBe(first.renderVersionByNode.dash);
    expect(second.renderVersionByNode.other).toBe(first.renderVersionByNode.other);
  });

  it("virtualizes only above the large-graph threshold and always keeps forced nodes", () => {
    const nodes = Array.from({ length: 130 }, (_, index) =>
      node(`n${index}`, index < 4 ? index * 120 : 5000 + index * 10, index < 4 ? 20 : 5000),
    );
    const visible = selectVisibleCanvasNodes(
      nodes,
      { x: 0, y: 0, w: 600, h: 400 },
      1,
      new Set(["n129"]),
      120,
      0,
    );

    expect(visible.map((item) => item.id)).toEqual(["n0", "n1", "n2", "n3", "n129"]);
    const underThreshold = nodes.slice(0, 10);
    expect(
      selectVisibleCanvasNodes(underThreshold, { x: 0, y: 0, w: 1, h: 1 }, 1, new Set(), 120, 0),
    ).toBe(underThreshold);
    const underWire = Array.from({ length: 10 }, (_, index) => ({
      id: `w${index}`,
      ax: 0,
      ay: 0,
      bx: 10,
      by: 10,
      fromN: `a${index}`,
      toN: `b${index}`,
    }));
    expect(
      selectVisibleCanvasWires(underWire, { x: 0, y: 0, w: 1, h: 1 }, 1, new Set(), null, 220, 0),
    ).toBe(underWire);
  });

  it("builds a four-thousand-node render model without quadratic edge scans", () => {
    const size = 4_000;
    const nodes = Array.from({ length: size }, (_, index) =>
      node(`n${index}`, index * 12, index * 5, index === 0 ? "input" : "select"),
    );
    const edges = Array.from({ length: size - 1 }, (_, index) =>
      edge(`e${index + 1}`, `n${index}`, `n${index + 1}`),
    );

    const started = performance.now();
    const model = buildNodeFlowRenderModel(nodes, edges);
    const elapsed = performance.now() - started;

    expect(model.wires).toHaveLength(size - 1);
    expect(model.incomingCountByNode[`n${size - 1}`]).toBe(1);
    expect(model.wires[model.wires.length - 1]?.toN).toBe(`n${size - 1}`);
    // Generous enough for constrained CI workers, but catches an accidental
    // return to scanning the complete edge list for every card.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("culls off-screen wires while retaining selected and forced-node connections", () => {
    const wires = Array.from({ length: 230 }, (_, index) => ({
      id: `w${index}`,
      ax: index < 2 ? 10 : 5000,
      ay: index < 2 ? index * 40 : 5000 + index,
      bx: index < 2 ? 300 : 5200,
      by: index < 2 ? index * 40 : 5200 + index,
      fromN: `a${index}`,
      toN: `b${index}`,
    }));
    const visible = selectVisibleCanvasWires(
      wires,
      { x: 0, y: 0, w: 600, h: 400 },
      1,
      new Set(["a229"]),
      "w228",
      220,
      0,
    );

    expect(visible.map((item) => item.id)).toEqual(["w0", "w1", "w228", "w229"]);
  });

  it("patches only incident wires when one node moves (preserves other wire refs)", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 240, 0, "select"),
      node("c", 480, 0, "output"),
      node("d", 0, 300),
      node("e", 240, 300, "output"),
    ];
    const edges = [
      edge("ab", "a", "b"),
      edge("bc", "b", "c"),
      edge("de", "d", "e"),
    ];
    const first = buildNodeFlowRenderModel(nodes, edges);
    const moved = nodes.map((item) =>
      item.id === "b" ? { ...item, x: item.x + 80, y: item.y + 40 } : item,
    );
    const patched = patchNodeFlowRenderModelForDirtyNodes(
      first,
      moved,
      edges,
      new Set(["b"]),
    );
    expect(patched).not.toBeNull();
    const wireById = Object.fromEntries(patched!.wires.map((w) => [w.id, w]));
    const prevById = Object.fromEntries(first.wires.map((w) => [w.id, w]));
    // Unrelated branch keeps the same wire object.
    expect(wireById.de).toBe(prevById.de);
    // Incident wires are new objects with updated endpoints.
    expect(wireById.ab).not.toBe(prevById.ab);
    expect(wireById.bc).not.toBe(prevById.bc);
    expect(wireById.ab.bx).not.toBe(prevById.ab.bx);
    expect(wireById.bc.ax).not.toBe(prevById.bc.ax);
  });

  it("treats position-only dirty nodes as geometry-only (config edits are not)", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 240, 0, "select"),
      node("dash", 480, 0, "dashboard"),
    ];
    const moved = nodes.map((item) =>
      item.id === "b" ? { ...item, x: item.x + 40 } : item,
    );
    expect(dirtyNodesAreGeometryOnly(nodes, moved, new Set(["b"]))).toBe(true);
    const edited = nodes.map((item) =>
      item.id === "b"
        ? { ...item, config: { ...item.config, label: "renamed" } }
        : item,
    );
    expect(dirtyNodesAreGeometryOnly(nodes, edited, new Set(["b"]))).toBe(false);
  });
});
