import React, { StrictMode } from "react";
import {
  act,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { NodeFlowScene } from "./NodeFlowScene";
import { useNodeFlowAnimations } from "./useNodeFlowAnimations";
import { useNodeFlowChartHydration } from "./useNodeFlowChartHydration";

interface DebugWindow extends Window {
  __SAMQL_RENDER_DEBUG__?: boolean;
  __samqlRenders?: Record<string, number>;
}

const debugWindow = window as DebugWindow;

const makeNode = (
  id: string,
  x: number,
  y: number,
  type: NbNode["type"] = "input",
): NbNode => ({
  id,
  type,
  x,
  y,
  config: { label: id },
});

function makeSceneProps(
  nodes: NbNode[],
  selectedId: string | null = null,
): React.ComponentProps<typeof NodeFlowScene> {
  const selectedIdsRef = { current: [] as string[] };
  return {
    nodes,
    edges: [],
    running: false,
    runningNodeIds: new Set(),
    wrapRef: { current: null },
    contentRef: { current: null },
    onScroll: vi.fn(),
    onCanvasPointerDown: vi.fn(),
    toContent: (x, y) => ({ x, y }),
    groupAtContentPoint: () => null,
    setCanvasMenu: vi.fn(),
    addNodeAt: vi.fn(),
    groupAddChild: vi.fn(),
    zoom: 1,
    snap: false,
    dyingIds: new Set(),
    dyingEdgeIds: new Set(),
    selectedEdge: null,
    setSelectedEdge: vi.fn(),
    deleteEdge: vi.fn(),
    pendingWire: null,
    marquee: null,
    selectedId,
    selectedIds: [],
    selectedIdsRef,
    setSelectedId: vi.fn(),
    setSelectedIds: vi.fn(),
    viewport: { x: 0, y: 0, w: 600, h: 400 },
    minimapMini: true,
    toggleMinimap: vi.fn(),
    panTo: vi.fn(),
    groupHover: null,
    nodeErrors: {},
    nodeWarnings: {},
    ripple: false,
    snapId: null,
    bornId: null,
    lineageFlashId: null,
    chartData: {},
    patchNode: vi.fn(),
    ensureChartFor: async () => {},
    upstreamChartNode: () => null,
    setDashboardPane: vi.fn(),
    groupReorder: vi.fn(),
    extractChildToCanvas: vi.fn(),
    startNodeDrag: vi.fn(),
    startNodeResize: vi.fn(),
    startWire: vi.fn(),
    setHoveredInput: vi.fn(),
    setNodeMenu: vi.fn(),
    denseMode: false,
    sphereMode: false,
  };
}

function renderScene(nodes: NbNode[], selectedId: string | null = null) {
  return render(<NodeFlowScene {...makeSceneProps(nodes, selectedId)} />);
}

beforeEach(() => {
  debugWindow.__SAMQL_RENDER_DEBUG__ = true;
  debugWindow.__samqlRenders = {};
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  delete debugWindow.__SAMQL_RENDER_DEBUG__;
  delete debugWindow.__samqlRenders;
  vi.restoreAllMocks();
});

describe("NodeFlow Phase 9 canvas performance", () => {
  it("renders every card for normal workflows", () => {
    const nodes = Array.from({ length: 12 }, (_, index) =>
      makeNode(`n${index}`, index * 80, 20),
    );
    const { container } = renderScene(nodes);

    expect(screen.getAllByTestId("nodeflow-node")).toHaveLength(12);
    expect(container.querySelector(".nb2-canvas")).toHaveAttribute(
      "data-virtualized",
      "false",
    );
  });

  it("virtualizes an oversized graph but keeps an off-screen selection mounted", () => {
    const nodes = Array.from({ length: 130 }, (_, index) =>
      makeNode(
        `n${index}`,
        index < 4 ? index * 120 : 5000 + index * 10,
        index < 4 ? 20 : 5000,
      ),
    );
    const { container } = renderScene(nodes, "n129");

    expect(screen.getAllByTestId("nodeflow-node")).toHaveLength(5);
    const canvas = container.querySelector(".nb2-canvas");
    expect(canvas).toHaveAttribute("data-total-nodes", "130");
    expect(canvas).toHaveAttribute("data-rendered-nodes", "5");
    expect(canvas).toHaveAttribute("data-virtualized", "true");
    expect(container.querySelector('[data-node-id="n129"]')).not.toBeNull();
  });

  it("rerenders the moved card without rerendering a stationary sibling", () => {
    const first = makeNode("first", 20, 20);
    const second = makeNode("second", 220, 20);
    const props = makeSceneProps([first, second]);
    const view = render(<NodeFlowScene {...props} />);

    expect(debugWindow.__samqlRenders).toMatchObject({
      "NodeFlowNode:first": 1,
      "NodeFlowNode:second": 1,
    });

    view.rerender(
      <NodeFlowScene {...props} nodes={[{ ...first, x: 140 }, second]} />,
    );

    expect(debugWindow.__samqlRenders).toMatchObject({
      "NodeFlowNode:first": 2,
      "NodeFlowNode:second": 1,
    });
  });

  it("does not rebuild stationary card summaries while a sibling moves", async () => {
    const defs = await import("./nodeDefinitions");
    const spy = vi.spyOn(defs, "getNodeCardSummary");
    const first = makeNode("first", 20, 20, "select");
    const second = makeNode("second", 220, 20, "select");
    const props = makeSceneProps([first, second]);
    const view = render(<NodeFlowScene {...props} />);
    const afterMount = spy.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(2);

    view.rerender(
      <NodeFlowScene {...props} nodes={[{ ...first, x: 140 }, second]} />,
    );
    // Only the moved select card rebuilds its summary; stationary stays put.
    expect(spy.mock.calls.length).toBe(afterMount + 1);
    spy.mockRestore();
  });

  it("survives StrictMode replay and deduplicates transient delete timers", () => {
    vi.useFakeTimers();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const staleCommit = vi.fn();
    const latestCommit = vi.fn();
    const { result } = renderHook(() => useNodeFlowAnimations(), { wrapper });

    act(() => result.current.fireBorn("fresh"));
    expect(result.current.bornId).toBe("fresh");
    act(() => {
      vi.advanceTimersByTime(321);
    });
    expect(result.current.bornId).toBeNull();

    act(() => result.current.withImplosion(["old"], staleCommit));
    // The document mutation commits immediately in the originating scope;
    // a duplicate request is ignored while the visual tombstone is active.
    expect(staleCommit).toHaveBeenCalledTimes(1);
    act(() => result.current.withImplosion(["old"], latestCommit));
    expect(latestCommit).not.toHaveBeenCalled();
    expect(result.current.dyingIds.has("old")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(231);
    });

    expect(staleCommit).toHaveBeenCalledTimes(1);
    expect(latestCommit).not.toHaveBeenCalled();
    expect(result.current.dyingIds.has("old")).toBe(false);
  });

  it("hydrates a newly loaded expanded chart in the same tab", () => {
    vi.useFakeTimers();
    const first: NbNode = {
      ...makeNode("chart-one", 20, 20, "chart"),
      config: { label: "chart one", collapsed: false },
    };
    const second: NbNode = {
      ...makeNode("chart-two", 240, 20, "chart"),
      config: { label: "chart two", collapsed: false },
    };
    const ensureChartFor = vi.fn(async () => {});

    const { rerender } = renderHook(
      ({ nodes, signature }: { nodes: NbNode[]; signature: string }) =>
        useNodeFlowChartHydration({
          activeTabId: "tab-a",
          graphSignature: signature,
          dataEpoch: 0,
          nodes,
          edges: [] as NbEdge[],
          ensureChartFor,
        }),
      { initialProps: { nodes: [first], signature: "graph-one" } },
    );

    act(() => {
      vi.runAllTimers();
    });
    expect(ensureChartFor).toHaveBeenCalledWith(first);

    rerender({ nodes: [first, second], signature: "graph-two" });
    act(() => {
      vi.runAllTimers();
    });
    expect(ensureChartFor).toHaveBeenCalledWith(second);

    const callsAfterStructuralLoad = ensureChartFor.mock.calls.length;
    rerender({
      nodes: [{ ...first, x: 900 }, { ...second, y: 700 }],
      signature: "graph-two",
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(ensureChartFor).toHaveBeenCalledTimes(callsAfterStructuralLoad);
  });
});
