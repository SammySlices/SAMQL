import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { clearNodeflowColsCache } from "../../lib/nodeflowColumnsCache";
import {
  useNodeFlowInspectorController,
  type NodeFlowInspectorRuntime,
} from "./useNodeFlowInspectorController";

const nodeflowColumnsBatch = vi.hoisted(() =>
  vi.fn(async () => ({
    results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
  })),
);

vi.mock("../../lib/api", () => ({
  api: {
    nodeflowColumnsBatch,
    nodeflowColumns: vi.fn(async () => ({ columns: [] })),
  },
}));

vi.mock("../../lib/prettyStruct", () => ({
  runAfterPaint: (task: () => void) => {
    queueMicrotask(task);
    return () => {};
  },
}));

const runtime = {
  chartData: {},
  DATA_FORMATS: [],
  dirList: { folder: "", files: [], loading: false },
  dissolveContainer: vi.fn(),
  doChart: vi.fn(),
  doCreateTable: vi.fn(),
  doExport: vi.fn(),
  doFetchApi: vi.fn(),
  doPreview: vi.fn(),
  doProfile: vi.fn(),
  doReadDirectory: vi.fn(),
  doReadFolder: vi.fn(),
  doReconcile: vi.fn(),
  doRunIterator: vi.fn(),
  doRunWhile: vi.fn(),
  doValidate: vi.fn(),
  doWriteTable: vi.fn(),
  ensureChartFor: vi.fn(),
  FORMAT_LABELS: {},
  IMAGE_FORMATS_CHART: [],
  IMAGE_FORMATS_DASH: [],
  loadDirList: vi.fn(),
  onToast: vi.fn(),
  outputKind: () => "none" as const,
  patchSeriesColor: vi.fn(),
  patchStyle: vi.fn(),
  removeNode: vi.fn(),
  running: false,
  setBrowseFolder: vi.fn(),
  setDashPane: vi.fn(),
  setHelpFor: vi.fn(),
  tables: [],
  upstreamChartNode: () => null,
  validateResults: {},
} as unknown as NodeFlowInspectorRuntime;

function nodesAndEdges(): { nodes: NbNode[]; edges: NbEdge[] } {
  const nodes: NbNode[] = [
    { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t" } },
    {
      id: "sel-1",
      type: "select",
      x: 120,
      y: 0,
      config: { fields: [], label: "select" },
    },
  ];
  const edges: NbEdge[] = [
    {
      id: "e1",
      from: { node: "in-1", port: "out" },
      to: { node: "sel-1", port: "in" },
    },
  ];
  return { nodes, edges };
}

describe("useNodeFlowInspectorController column probe cache", () => {
  beforeEach(() => {
    clearNodeflowColsCache();
    nodeflowColumnsBatch.mockClear();
    nodeflowColumnsBatch.mockResolvedValue({
      results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
    });
  });

  it("cache hit on re-select avoids another inspector probe; graphSig change refetches", async () => {
    const { nodes, edges } = nodesAndEdges();
    const patch = vi.fn();

    const { result, rerender } = renderHook(
      (props: { graphSig: string; selectedId: string | null }) => {
        const sel =
          props.selectedId == null
            ? null
            : nodes.find((n) => n.id === props.selectedId) || null;
        return useNodeFlowInspectorController({
          scopeKey: "test",
          nodes,
          edges,
          selectedId: props.selectedId,
          selectedNode: sel,
          childSelection: null,
          graphSig: props.graphSig,
          graphForApi: () => ({ nodes, edges }),
          partialGroupGraph: () => ({ nodes, edges }),
          patch,
          runtime,
        });
      },
      {
        initialProps: {
          graphSig: "sig-1",
          selectedId: "sel-1" as string | null,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["a", "b"]);
      expect(result.current.inspColsProbing).toBe(false);
    });
    // Inspector probe + wired-Select reconcile may each batch once on first load.
    const afterFirst = nodeflowColumnsBatch.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Leave and re-select with same graphSig → inspector path hits cache.
    act(() => {
      rerender({ graphSig: "sig-1", selectedId: null });
    });
    act(() => {
      rerender({ graphSig: "sig-1", selectedId: "sel-1" });
    });
    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["a", "b"]);
      expect(result.current.inspColsProbing).toBe(false);
    });
    expect(nodeflowColumnsBatch.mock.calls.length).toBe(afterFirst);

    // Upstream config change bumps graphSig → must refetch inspector columns.
    nodeflowColumnsBatch.mockResolvedValue({
      results: [{ node: "in-1", port: "out", columns: ["a", "b", "c"] }],
    });
    act(() => {
      rerender({ graphSig: "sig-2", selectedId: "sel-1" });
    });
    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["a", "b", "c"]);
    });
    expect(nodeflowColumnsBatch.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
