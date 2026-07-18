import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_W,
  SPHERE_SIZE,
  nodeFlowSphereActive,
  nodeUsesSphereChrome,
  nodeWidth,
  setNodeFlowSphereMode,
  spherePortOffset,
  type NbNode,
} from "./nodeFlowModel";

function leaf(type: NbNode["type"], config: Record<string, unknown> = {}): NbNode {
  return { id: "n1", type, x: 0, y: 0, config };
}

describe("Sphere NodeFlow chrome", () => {
  afterEach(() => {
    setNodeFlowSphereMode(false);
  });

  it("shrinks leaf nodes to the sphere diameter when sphere mode is on", () => {
    const node = leaf("filter", { label: "orders filter" });
    setNodeFlowSphereMode(false);
    expect(nodeFlowSphereActive()).toBe(false);
    expect(nodeUsesSphereChrome(node)).toBe(false);
    expect(nodeWidth(node)).toBe(NODE_W);

    setNodeFlowSphereMode(true);
    expect(nodeFlowSphereActive()).toBe(true);
    expect(nodeUsesSphereChrome(node)).toBe(true);
    expect(nodeWidth(node)).toBe(SPHERE_SIZE);
  });

  it("keeps groups, notes, SQL, and expanded charts as boxes", () => {
    setNodeFlowSphereMode(true);
    expect(nodeUsesSphereChrome(leaf("group", { children: [] }))).toBe(false);
    expect(nodeUsesSphereChrome(leaf("text", { text: "note" }))).toBe(false);
    expect(nodeUsesSphereChrome(leaf("variable", { vars: [] }))).toBe(false);
    expect(nodeUsesSphereChrome(leaf("sql", { sql: "SELECT 1" }))).toBe(false);
    expect(
      nodeUsesSphereChrome(leaf("chart", { collapsed: false, label: "chart" })),
    ).toBe(false);
    expect(
      nodeUsesSphereChrome(leaf("chart", { collapsed: true, label: "chart" })),
    ).toBe(true);
  });

  it("places a single input/output on the left/right rim", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("filter");
    const inn = spherePortOffset(node, "in", 0, 1);
    const out = spherePortOffset(node, "out", 0, 1);
    expect(inn.left).toBeCloseTo(0, 10);
    expect(inn.top).toBeCloseTo(SPHERE_SIZE / 2, 10);
    expect(out.left).toBeCloseTo(SPHERE_SIZE, 10);
    expect(out.top).toBeCloseTo(SPHERE_SIZE / 2, 10);
  });
});
