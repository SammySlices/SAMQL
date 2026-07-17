import { afterEach, describe, expect, it } from "vitest";
import {
  NB_DENSE_SCALE,
  NODE_W,
  nodeFlowDenseActive,
  nodeWidth,
  setNodeFlowDenseMode,
} from "./nodeFlowModel";
import type { NbNode } from "./nodeFlowModel";

describe("Dense NodeFlow", () => {
  afterEach(() => {
    setNodeFlowDenseMode(false);
  });

  it("shrinks node width when dense mode is on", () => {
    const node: NbNode = {
      id: "n1",
      type: "filter",
      x: 0,
      y: 0,
      config: {},
    };
    setNodeFlowDenseMode(false);
    expect(nodeFlowDenseActive()).toBe(false);
    expect(nodeWidth(node)).toBe(NODE_W);
    setNodeFlowDenseMode(true);
    expect(nodeFlowDenseActive()).toBe(true);
    expect(nodeWidth(node)).toBe(Math.round(NODE_W * NB_DENSE_SCALE));
  });

  it("treats denseMode as a canvas memo invalidation key", async () => {
    const { sameCanvasNodeMemoState } = await import("./nodeFlowModel");
    const node: NbNode = {
      id: "n1",
      type: "filter",
      x: 0,
      y: 0,
      config: {},
    };
    const base = {
      node,
      index: 0,
      selected: false,
      dropHover: false,
      ripple: false,
      snapped: false,
      dying: false,
      born: false,
      lineageFlash: false,
      denseMode: false,
      renderVersion: "g1",
      chartVersion: null,
      childSelection: null,
    };
    expect(sameCanvasNodeMemoState(base, { ...base, denseMode: true })).toBe(
      false,
    );
    expect(sameCanvasNodeMemoState(base, { ...base })).toBe(true);
  });
});
