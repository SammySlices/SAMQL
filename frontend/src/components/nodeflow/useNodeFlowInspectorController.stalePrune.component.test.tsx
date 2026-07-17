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

const onToast = vi.fn();

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
  onToast,
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

describe("useNodeFlowInspectorController auto-prune stale column refs (F2)", () => {
  beforeEach(() => {
    clearNodeflowColsCache();
    nodeflowColumnsBatch.mockClear();
    onToast.mockClear();
    nodeflowColumnsBatch.mockResolvedValue({
      results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
    });
  });

  it("prunes stale refs once when inspCols arrive and toasts the node label", async () => {
    const nodes: NbNode[] = [
      { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t" } },
      {
        id: "sort-1",
        type: "sort",
        x: 120,
        y: 0,
        config: {
          label: "My Sort",
          sorts: [
            { col: "a", dir: "asc" },
            { col: "gone", dir: "desc" },
          ],
        },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-1", port: "out" },
        to: { node: "sort-1", port: "in" },
      },
    ];
    const patch = vi.fn((id: string, config: Record<string, any>) => {
      const n = nodes.find((x) => x.id === id);
      if (n) n.config = { ...n.config, ...config };
    });

    const { result, rerender } = renderHook(
      (props: { selectedId: string | null }) => {
        const sel =
          props.selectedId == null
            ? null
            : nodes.find((n) => n.id === props.selectedId) || null;
        return useNodeFlowInspectorController({
          scopeKey: "test",
          nodes: [...nodes],
          edges,
          selectedId: props.selectedId,
          selectedNode: sel ? { ...sel, config: { ...sel.config } } : null,
          childSelection: null,
          graphSig: "sig-1",
          graphForApi: () => ({ nodes, edges }),
          partialGroupGraph: () => ({ nodes, edges }),
          patch,
          runtime,
        });
      },
      { initialProps: { selectedId: "sort-1" as string | null } },
    );

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["a", "b"]);
    });

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(
        "sort-1",
        expect.objectContaining({
          sorts: [{ col: "a", dir: "asc" }],
        }),
      );
    });
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith(
      "ok",
      "Removed stale column refs on My Sort",
    );

    // Re-render with pruned config: no second prune/toast for the same stale set.
    act(() => {
      rerender({ selectedId: "sort-1" });
    });
    await waitFor(() => {
      expect(result.current.staleColRefs).toEqual([]);
    });
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls.filter((c) => c[0] === "sort-1").length).toBe(1);
  });

  it("does not toast when there are no stale refs", async () => {
    const nodes: NbNode[] = [
      { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t" } },
      {
        id: "sort-1",
        type: "sort",
        x: 120,
        y: 0,
        config: {
          label: "sort",
          sorts: [{ col: "a", dir: "asc" }],
        },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-1", port: "out" },
        to: { node: "sort-1", port: "in" },
      },
    ];
    const patch = vi.fn();

    const { result } = renderHook(() =>
      useNodeFlowInspectorController({
        scopeKey: "test",
        nodes,
        edges,
        selectedId: "sort-1",
        selectedNode: nodes[1],
        childSelection: null,
        graphSig: "sig-1",
        graphForApi: () => ({ nodes, edges }),
        partialGroupGraph: () => ({ nodes, edges }),
        patch,
        runtime,
      }),
    );

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["a", "b"]);
      expect(result.current.staleColRefs).toEqual([]);
    });
    expect(onToast).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});
