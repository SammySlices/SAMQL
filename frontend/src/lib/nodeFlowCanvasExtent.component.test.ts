import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN_H,
  CANVAS_MIN_W,
  canvasWorldSize,
  canvasWorldSizeExpandOnly,
  nodeHeight,
  type NbNode,
} from "./nodeFlowModel";

describe("canvasWorldSize / SQL node height", () => {
  it("grows the canvas past 3200×2000 when nodes sit past the edge", () => {
    const nodes: NbNode[] = [
      {
        id: "a",
        type: "input",
        x: 4000,
        y: 2500,
        config: {},
      },
    ];
    const world = canvasWorldSize(nodes);
    expect(world.w).toBeGreaterThan(CANVAS_MIN_W);
    expect(world.h).toBeGreaterThan(CANVAS_MIN_H);
    expect(world.w).toBeGreaterThan(4000);
    expect(world.h).toBeGreaterThan(2500);
  });

  it("keeps the default minimum canvas when nodes fit inside", () => {
    const nodes: NbNode[] = [
      { id: "a", type: "input", x: 40, y: 40, config: {} },
    ];
    expect(canvasWorldSize(nodes)).toEqual({
      w: CANVAS_MIN_W,
      h: CANVAS_MIN_H,
    });
  });

  it("auto-grows SQL node height with query lines (no 96px stuck preview)", () => {
    const short: NbNode = {
      id: "s",
      type: "sql",
      x: 0,
      y: 0,
      config: { sql: "SELECT 1" },
    };
    const tall: NbNode = {
      id: "t",
      type: "sql",
      x: 0,
      y: 0,
      config: {
        sql: Array.from({ length: 60 }, (_, i) => `SELECT ${i}`).join("\n"),
      },
    };
    expect(nodeHeight(tall)).toBeGreaterThan(nodeHeight(short));
    expect(nodeHeight(tall)).toBeGreaterThan(200);
  });

  it("expand-only mid-drag world size grows but does not shrink", () => {
    const far: NbNode[] = [
      { id: "a", type: "input", x: 4000, y: 2500, config: {} },
    ];
    const near: NbNode[] = [
      { id: "a", type: "input", x: 40, y: 40, config: {} },
    ];
    const grown = canvasWorldSize(far);
    const shrunk = canvasWorldSizeExpandOnly(grown, near);
    expect(shrunk.w).toBe(grown.w);
    expect(shrunk.h).toBe(grown.h);
    const farther: NbNode[] = [
      { id: "a", type: "input", x: 5000, y: 3000, config: {} },
    ];
    const expanded = canvasWorldSizeExpandOnly(grown, farther);
    expect(expanded.w).toBeGreaterThan(grown.w);
    expect(expanded.h).toBeGreaterThan(grown.h);
  });
});
