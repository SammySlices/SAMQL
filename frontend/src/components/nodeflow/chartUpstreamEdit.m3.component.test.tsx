import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";

// M-3: a hydrated chart's cache signature covered its own spec, type, data
// epoch and params, but not the graph above it. After an upstream Filter
// edit, hydration called ensureChartFor again and it returned early, so the
// chart kept its old numbers while the tables refreshed.

const src: NbNode = { id: "src", type: "input", x: 0, y: 0, config: { label: "src", table: "sales" } };
const flt: NbNode = { id: "flt", type: "filter", x: 0, y: 0, config: { label: "flt", where: "amount > 0" } };
const chart: NbNode = {
  id: "ch",
  type: "chart",
  x: 0,
  y: 0,
  config: { label: "ch", x: "region", y: "amount", agg: "sum", chart_type: "bar" },
};
const edges: NbEdge[] = [
  { id: "e1", from: { node: "src", port: "out" }, to: { node: "flt", port: "in" } },
  { id: "e2", from: { node: "flt", port: "out" }, to: { node: "ch", port: "in" } },
];

beforeEach(() => {
  vi.spyOn(api, "nodeflowChart").mockResolvedValue({
    labels: ["EMEA"],
    series: [{ name: "amount", data: [1] }],
  } as never);
  vi.spyOn(api, "flowCacheInfo").mockResolvedValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an upstream edit refreshes a hydrated chart (M-3)", () => {
  it("ensureChartFor fetches again after the Filter above it changes", async () => {
    const nodes = [src, flt, chart];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes, edges },
    };
    const patch = vi.fn((id: string, cfg: Record<string, unknown>) => {
      liveRef.current = {
        ...liveRef.current,
        nodes: liveRef.current.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, ...cfg } } : n,
        ),
      };
    });
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes,
        edges,
        liveRef,
        graphSig: "graph-a",
        graphForApi: () => liveRef.current,
        graphForRun: () => liveRef.current,
        childCtx: () => null,
        partialGroupGraph: () => liveRef.current,
        patch,
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.ensureChartFor(chart);
    });
    await act(async () => {
      await result.current.ensureChartFor(chart);
    });
    expect(api.nodeflowChart).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.patchNode("flt", { where: "amount > 100" });
    });
    await act(async () => {
      await result.current.ensureChartFor(chart);
    });
    expect(api.nodeflowChart).toHaveBeenCalledTimes(2);
    // The chart keeps showing its old data while the refresh loads.
    expect(result.current.chartData.ch?.data || result.current.chartData.ch?.loading).toBeTruthy();
  });
});
