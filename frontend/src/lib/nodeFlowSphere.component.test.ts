import { afterEach, describe, expect, it } from "vitest";
import {
  CHART_BODY_H,
  DASH_BODY_H,
  DASH_W,
  GROUP_W,
  HEAD_H,
  NODE_W,
  PORTS,
  SPHERE_PORT_OUTSET,
  SPHERE_PORT_SPREAD,
  SPHERE_RING,
  SPHERE_SIZE,
  SPHERE_UNDER_GAP,
  SPHERE_UNDER_GAP_CONTAINER,
  SPHERE_CONTAINER_PILL_BOTTOM,
  nodeFlowSphereActive,
  nodeHeight,
  nodeShowsBody,
  nodeSpawnOrigin,
  nodeUnderBodySize,
  nodeUsesSphereChrome,
  nodeWidth,
  nodeWorldBounds,
  portXY,
  setNodeFlowSphereMode,
  spherePortOffset,
  sphereUnderGap,
  type NbNode,
  type NodeType,
} from "./nodeFlowModel";

function leaf(type: NbNode["type"], config: Record<string, unknown> = {}): NbNode {
  return { id: "n1", type, x: 0, y: 0, config };
}

/** Types that stay classic boxes even when sphere mode is on. */
const BOX_ALWAYS: NodeType[] = ["text"];

function distinctKey(p: { left: number; top: number }): string {
  return `${p.left.toFixed(3)},${p.top.toFixed(3)}`;
}

function minPairDistance(
  pts: Array<{ left: number; top: number }>,
): number {
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].left - pts[j].left;
      const dy = pts[i].top - pts[j].top;
      min = Math.min(min, Math.hypot(dx, dy));
    }
  }
  return min;
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

  it("spheres SQL/Variable/Python/charts/group/iterator; keeps notes as boxes", () => {
    setNodeFlowSphereMode(true);
    expect(nodeUsesSphereChrome(leaf("sql", { sql: "SELECT 1" }))).toBe(true);
    expect(nodeUsesSphereChrome(leaf("variable", { vars: [] }))).toBe(true);
    expect(nodeUsesSphereChrome(leaf("python", { code: "df" }))).toBe(true);
    expect(nodeUsesSphereChrome(leaf("group", { children: [] }))).toBe(true);
    expect(nodeUsesSphereChrome(leaf("iterator", { children: [] }))).toBe(true);
    // Expanded chart/dashboard keep sphere chrome; viz floats under the node.
    expect(
      nodeUsesSphereChrome(leaf("chart", { collapsed: false, label: "chart" })),
    ).toBe(true);
    expect(
      nodeUsesSphereChrome(
        leaf("dashboard", { collapsed: false, panes: ["in1"] }),
      ),
    ).toBe(true);

    expect(nodeUsesSphereChrome(leaf("text", { text: "note" }))).toBe(false);
  });

  it("applies sphere chrome to every leaf type except intentional box keepers", () => {
    setNodeFlowSphereMode(true);
    const allTypes = Object.keys(PORTS) as NodeType[];
    const sphereTypes: NodeType[] = [];
    const boxTypes: NodeType[] = [];
    for (const type of allTypes) {
      // Expanded chart/dashboard must still sphere (floating under panel).
      const cfg: Record<string, unknown> =
        type === "chart" || type === "dashboard" ? { collapsed: false } : {};
      if (nodeUsesSphereChrome(leaf(type, cfg))) sphereTypes.push(type);
      else boxTypes.push(type);
    }
    expect(boxTypes.sort()).toEqual([...BOX_ALWAYS].sort());
    for (const type of [
      "sql",
      "variable",
      "python",
      "select",
      "join",
      "filter",
      "chart",
      "dashboard",
    ] as NodeType[]) {
      expect(sphereTypes).toContain(type);
    }
    expect(sphereTypes.length).toBe(allTypes.length - BOX_ALWAYS.length);
  });

  it("keeps sphere width when chart is shown under the node", () => {
    setNodeFlowSphereMode(true);
    const chart = leaf("chart", { collapsed: false, label: "sales" });
    expect(nodeUsesSphereChrome(chart)).toBe(true);
    expect(nodeWidth(chart)).toBe(SPHERE_SIZE);
  });

  it("keeps sphere width for group/iterator; children float under", () => {
    setNodeFlowSphereMode(true);
    for (const type of ["group", "iterator"] as NodeType[]) {
      const node = leaf(type, {
        children: [{ id: "c1", type: "select", config: {} }],
      });
      expect(nodeUsesSphereChrome(node)).toBe(true);
      expect(nodeWidth(node)).toBe(SPHERE_SIZE);
    }
  });

  it("places a single input/output just outside the left/right rim", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("select");
    const inn = spherePortOffset(node, "in", 0, 1);
    const out = spherePortOffset(node, "out", 0, 1);
    // Padding-box coords: center is (S/2 - ring); rim radius is S/2 + outset.
    const padC = SPHERE_SIZE / 2 - SPHERE_RING;
    const r = SPHERE_SIZE / 2 + SPHERE_PORT_OUTSET;
    expect(inn.left).toBeCloseTo(padC - r, 10);
    expect(inn.top).toBeCloseTo(padC, 10);
    expect(out.left).toBeCloseTo(padC + r, 10);
    expect(out.top).toBeCloseTo(padC, 10);
  });

  it("fans Join three outputs on the right rim with distinct x,y", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("join");
    const outs = PORTS.join.outputs;
    expect(outs).toEqual(["left_only", "inner", "right_only"]);
    const padC = SPHERE_SIZE / 2 - SPHERE_RING;
    const pts = outs.map((_, i) => spherePortOffset(node, "out", i));

    // Distinct positions (not the same x,y stacked on one rim point).
    expect(new Set(pts.map(distinctKey)).size).toBe(3);
    // Top → bottom order.
    expect(pts[0].top).toBeLessThan(pts[1].top);
    expect(pts[1].top).toBeLessThan(pts[2].top);
    // All on the right half of the sphere (not top/bottom dead-center).
    for (const p of pts) {
      expect(p.left).toBeGreaterThan(padC + 8);
    }
    // Clear angular separation → meaningful pixel gap between neighbors.
    expect(minPairDistance(pts)).toBeGreaterThan(14);

    const inPts = PORTS.join.inputs.map((_, i) =>
      spherePortOffset(node, "in", i),
    );
    expect(new Set(inPts.map(distinctKey)).size).toBe(2);
    for (const p of inPts) {
      expect(p.left).toBeLessThan(padC - 8);
    }

    // portXY (wires) must also fan — default total must not collapse to 1.
    node.x = 0;
    node.y = 0;
    const wirePts = outs.map((_, i) => portXY(node, "out", i));
    expect(
      new Set(wirePts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size,
    ).toBe(3);
  });

  it("fans Filter true/false on the right rim when total is omitted", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("filter");
    const padC = SPHERE_SIZE / 2 - SPHERE_RING;
    const a = spherePortOffset(node, "out", 0);
    const b = spherePortOffset(node, "out", 1);
    expect(a.top).not.toBeCloseTo(b.top, 5);
    // Both stay on the right rim (old ±90° fan put them at top/bottom).
    expect(a.left).toBeGreaterThan(padC + 8);
    expect(b.left).toBeGreaterThan(padC + 8);
    expect(Math.hypot(a.left - b.left, a.top - b.top)).toBeGreaterThan(14);
  });

  it("fans every multi-output / multi-input leaf type with distinct rim positions", () => {
    setNodeFlowSphereMode(true);
    const padC = SPHERE_SIZE / 2 - SPHERE_RING;
    const multiOut: Array<{ type: NodeType; config?: Record<string, unknown> }> =
      [
        { type: "join" },
        { type: "filter" },
        { type: "apinode" },
        {
          type: "usernode",
          config: { inputCount: 2, outputCount: 3 },
        },
      ];
    for (const { type, config } of multiOut) {
      const node = leaf(type, config || {});
      const n = type === "usernode" ? 3 : PORTS[type].outputs.length;
      expect(n).toBeGreaterThan(1);
      const pts = Array.from({ length: n }, (_, i) =>
        spherePortOffset(node, "out", i),
      );
      expect(new Set(pts.map(distinctKey)).size).toBe(n);
      for (const p of pts) expect(p.left).toBeGreaterThan(padC + 8);
      expect(minPairDistance(pts)).toBeGreaterThan(10);
    }

    const multiIn: NodeType[] = [
      "join",
      "antijoin",
      "crossjoin",
      "reconcile",
      "iterator",
    ];
    for (const type of multiIn) {
      const node = leaf(type);
      const n = PORTS[type].inputs.length;
      expect(n).toBeGreaterThan(1);
      const pts = Array.from({ length: n }, (_, i) =>
        spherePortOffset(node, "in", i),
      );
      expect(new Set(pts.map(distinctKey)).size).toBe(n);
      for (const p of pts) expect(p.left).toBeLessThan(padC - 8);
      expect(minPairDistance(pts)).toBeGreaterThan(10);
    }
  });

  it("fans iterator vars+in on the left rim (not a hidden top port)", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("iterator", { children: [] });
    expect(PORTS.iterator.inputs).toEqual(["vars", "in"]);
    const padC = SPHERE_SIZE / 2 - SPHERE_RING;
    const pts = PORTS.iterator.inputs.map((_, i) =>
      spherePortOffset(node, "in", i),
    );
    expect(new Set(pts.map(distinctKey)).size).toBe(2);
    expect(pts[0].top).toBeLessThan(pts[1].top);
    for (const p of pts) expect(p.left).toBeLessThan(padC - 8);

    node.x = 0;
    node.y = 0;
    const wirePts = PORTS.iterator.inputs.map((_, i) => portXY(node, "in", i));
    expect(
      new Set(wirePts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size,
    ).toBe(2);
    // Both wire anchors stay left of sphere center (rim fan, not top-edge).
    for (const p of wirePts) expect(p.x).toBeLessThan(SPHERE_SIZE / 2);
  });

  it("keeps multi-port spread under a semicircle so extremes stay on-side", () => {
    expect(SPHERE_PORT_SPREAD).toBeLessThan(Math.PI * 0.75);
    expect(SPHERE_PORT_SPREAD).toBeGreaterThan(Math.PI * 0.35);
  });

  it("maps sphere portXY into border-box world space (ring offset)", () => {
    setNodeFlowSphereMode(true);
    const node = leaf("select", { label: "s" });
    node.x = 100;
    node.y = 200;
    const out = portXY(node, "out", 0);
    const off = spherePortOffset(node, "out", 0, 1);
    expect(out.x).toBeCloseTo(node.x + SPHERE_RING + off.left, 10);
    expect(out.y).toBeCloseTo(node.y + SPHERE_RING + off.top, 10);
  });

  it("leaves classic geometry when sphere mode is off", () => {
    setNodeFlowSphereMode(false);
    expect(nodeUsesSphereChrome(leaf("sql", { sql: "SELECT 1" }))).toBe(false);
    expect(nodeUsesSphereChrome(leaf("variable", { vars: [] }))).toBe(false);
    expect(nodeUsesSphereChrome(leaf("python", { code: "df" }))).toBe(false);
    expect(nodeWidth(leaf("filter"))).toBe(NODE_W);

    // Classic Join still exposes three vertically stacked outs.
    const node = leaf("join");
    const ys = PORTS.join.outputs.map((_, i) => portXY(node, "out", i).y);
    expect(new Set(ys.map((y) => y.toFixed(4))).size).toBe(3);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
  });

  it("gives created usernodes sphere chrome when sphere mode is on", () => {
    setNodeFlowSphereMode(true);
    const created = leaf("usernode", {
      label: "My node",
      icon: "Sparkle",
      inputCount: 2,
      outputCount: 2,
      definitionId: "def-1",
    });
    expect(nodeUsesSphereChrome(created)).toBe(true);
    expect(nodeWidth(created)).toBe(SPHERE_SIZE);
    expect(nodeHeight(created)).toBe(SPHERE_SIZE);
  });

  it("honors sphereMode prop even when the html flag is still off", () => {
    setNodeFlowSphereMode(false);
    expect(nodeFlowSphereActive()).toBe(false);
    expect(nodeUsesSphereChrome(leaf("filter"), true)).toBe(true);
    expect(nodeUsesSphereChrome(leaf("usernode", { inputCount: 1 }), true)).toBe(
      true,
    );
    expect(nodeUsesSphereChrome(leaf("text", { text: "n" }), true)).toBe(false);
    expect(nodeUsesSphereChrome(leaf("filter"), false)).toBe(false);
  });

  it("centers spawn origin on the sphere when sphere mode is on", () => {
    const classic = nodeSpawnOrigin("filter", 200, 100, false);
    expect(classic.x).toBe(200 - NODE_W / 2);
    expect(classic.y).toBe(100 - HEAD_H);

    const sphere = nodeSpawnOrigin("usernode", 200, 100, true);
    expect(sphere.x).toBe(200 - SPHERE_SIZE / 2);
    expect(sphere.y).toBe(100 - SPHERE_SIZE / 2);
  });

  it("sizes floating under-panels for expanded chart/dashboard", () => {
    setNodeFlowSphereMode(true);
    const chart = leaf("chart", { collapsed: false, label: "sales" });
    const dash = leaf("dashboard", { collapsed: false, panes: ["in1"] });
    expect(nodeUnderBodySize(chart)).toEqual({
      w: NODE_W,
      h: CHART_BODY_H,
    });
    expect(nodeUnderBodySize(dash)).toEqual({
      w: DASH_W,
      h: DASH_BODY_H,
    });
    expect(DASH_W).toBeGreaterThan(NODE_W);
    // Collapsed chart has no under panel; sphere chrome stays.
    expect(
      nodeUnderBodySize(leaf("chart", { collapsed: true, label: "hidden" })),
    ).toBeNull();
    expect(nodeUsesSphereChrome(chart)).toBe(true);
    expect(nodeWidth(chart)).toBe(SPHERE_SIZE);
  });

  it("uses SPHERE_UNDER_GAP_CONTAINER so group/iterator panels clear bottom ports", () => {
    setNodeFlowSphereMode(true);
    expect(sphereUnderGap(leaf("chart", { collapsed: false }))).toBe(
      SPHERE_UNDER_GAP,
    );
    expect(sphereUnderGap(leaf("group", { children: [] }))).toBe(
      SPHERE_UNDER_GAP_CONTAINER,
    );
    expect(sphereUnderGap(leaf("iterator", { children: [] }))).toBe(
      SPHERE_UNDER_GAP_CONTAINER,
    );
    expect(SPHERE_UNDER_GAP_CONTAINER).toBeGreaterThan(SPHERE_UNDER_GAP);
    // Pill hangs below the lowest fanned input; under-panel starts below pill.
    expect(SPHERE_CONTAINER_PILL_BOTTOM).toBe(44);
    expect(SPHERE_UNDER_GAP_CONTAINER).toBeGreaterThanOrEqual(
      SPHERE_CONTAINER_PILL_BOTTOM,
    );

    const it = leaf("iterator", {
      children: [{ id: "c1", type: "select", config: {} }],
    });
    const body = nodeUnderBodySize(it);
    expect(body).not.toBeNull();
    expect(body!.w).toBe(GROUP_W);
    // Label bar (30) + body rows — grows with children.
    expect(body!.h).toBeGreaterThanOrEqual(102);

    // Lowest left-rim input center (border-box) must sit above the under-panel.
    const lowestInTop = Math.max(
      ...PORTS.iterator.inputs.map(
        (_, i) => SPHERE_RING + spherePortOffset(it, "in", i).top,
      ),
    );
    const underTop = SPHERE_SIZE + sphereUnderGap(it);
    // Triangle is ~16px tall, centered on the port — leave clearance.
    expect(underTop).toBeGreaterThan(lowestInTop + 8);
    // Pill top (sphere bottom + offset - pill height) clears triangle bottom.
    const pillTop = SPHERE_SIZE + SPHERE_CONTAINER_PILL_BOTTOM - 26;
    expect(pillTop).toBeGreaterThan(lowestInTop + 8);

    const bounds = nodeWorldBounds({ ...it, x: 40, y: 60 });
    expect(bounds.y1).toBe(
      60 + SPHERE_SIZE + SPHERE_UNDER_GAP_CONTAINER + body!.h,
    );
    expect(bounds.x0).toBeLessThan(40);
    expect(bounds.x1).toBeGreaterThan(40 + SPHERE_SIZE);
  });

  it("minimizes group/iterator under-panels via config.collapsed (default open)", () => {
    setNodeFlowSphereMode(true);
    for (const type of ["group", "iterator"] as NodeType[]) {
      const open = leaf(type, {
        children: [
          { id: "c1", type: "select", config: {} },
          { id: "c2", type: "filter", config: {} },
        ],
      });
      expect(nodeShowsBody(open)).toBe(true);
      expect(nodeUnderBodySize(open)).not.toBeNull();
      expect(nodeUsesSphereChrome(open)).toBe(true);
      expect(nodeWidth(open)).toBe(SPHERE_SIZE);

      const closed = leaf(type, {
        collapsed: true,
        children: open.config.children,
      });
      expect(nodeShowsBody(closed)).toBe(false);
      expect(nodeUnderBodySize(closed)).toBeNull();
      // Sphere chrome + ports stay; world bounds shrink to the sphere only.
      expect(nodeUsesSphereChrome(closed)).toBe(true);
      expect(nodeWidth(closed)).toBe(SPHERE_SIZE);
      const b = nodeWorldBounds({ ...closed, x: 10, y: 20 });
      expect(b).toEqual({
        x0: 10,
        y0: 20,
        x1: 10 + SPHERE_SIZE,
        y1: 20 + SPHERE_SIZE,
      });
    }
  });

  it("restores group under-panel size when collapsed is cleared", () => {
    setNodeFlowSphereMode(true);
    const kids = [{ id: "c1", type: "select", config: {} }];
    const minimized = leaf("group", { collapsed: true, children: kids });
    expect(nodeUnderBodySize(minimized)).toBeNull();
    const restored = leaf("group", { collapsed: false, children: kids });
    const body = nodeUnderBodySize(restored);
    expect(body).not.toBeNull();
    expect(body!.w).toBe(GROUP_W);
    expect(body!.h).toBeGreaterThanOrEqual(102);
    const b = nodeWorldBounds({ ...restored, x: 0, y: 0 });
    expect(b.y1).toBe(SPHERE_SIZE + SPHERE_UNDER_GAP_CONTAINER + body!.h);
  });

  it("classic box mode shrinks collapsed group when children drive height", () => {
    setNodeFlowSphereMode(false);
    // Enough children that the list (not the 5 static input slots) sets height.
    const kids = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      type: "select",
      config: {},
    }));
    const open = leaf("group", { children: kids });
    const closed = leaf("group", { collapsed: true, children: kids });
    expect(nodeShowsBody(open)).toBe(true);
    expect(nodeShowsBody(closed)).toBe(false);
    expect(nodeHeight(open)).toBeGreaterThan(nodeHeight(closed));
    expect(nodeHeight(closed)).toBeGreaterThanOrEqual(HEAD_H);
  });

  it("keeps chart under-panel in world bounds without widening the sphere", () => {
    setNodeFlowSphereMode(true);
    const chart = leaf("chart", { collapsed: false, label: "viz" });
    chart.x = 100;
    chart.y = 50;
    const body = nodeUnderBodySize(chart)!;
    const b = nodeWorldBounds(chart);
    expect(nodeWidth(chart)).toBe(SPHERE_SIZE);
    expect(b.y1).toBe(50 + SPHERE_SIZE + SPHERE_UNDER_GAP + body.h);
    expect(b.x1 - b.x0).toBeGreaterThanOrEqual(body.w);
  });
});
