import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { clearNodeflowColsCache } from "../../lib/nodeflowColumnsCache";
import {
  useNodeFlowInspectorController,
  type NodeFlowInspectorRuntime,
} from "./useNodeFlowInspectorController";

const nodeflowColumnsBatch = vi.hoisted(() =>
  vi.fn(
    async (
      _graph?: unknown,
      _reqs?: { node: string; port: string }[],
    ) => ({
      results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
    }),
  ),
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
    // useLayoutEffect cache publish: no empty frame after re-select.
    expect(result.current.inspCols.in).toEqual(["a", "b"]);
    expect(result.current.inspColsProbing).toBe(false);
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

  it("does not cache a failed probe as an empty schema (retry on re-select)", async () => {
    const { nodes, edges } = nodesAndEdges();
    const patch = vi.fn();
    // Reject every batch until we explicitly recover — inspector probe and
    // wired-Select reconcile both call nodeflowColumnsBatch.
    nodeflowColumnsBatch.mockRejectedValue(new Error("engine busy"));

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
          graphSig: "sig-fail",
          selectedId: "sel-1" as string | null,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.inspColsProbing).toBe(false);
    });
    // Failure publishes empty for this selection (probing ends) but must not
    // leave a cache hit — re-select retries the probe.
    expect(result.current.inspCols.in).toBeUndefined();
    const afterFail = nodeflowColumnsBatch.mock.calls.length;
    expect(afterFail).toBeGreaterThanOrEqual(1);

    nodeflowColumnsBatch.mockResolvedValue({
      results: [{ node: "in-1", port: "out", columns: ["recovered"] }],
    });
    act(() => {
      rerender({ graphSig: "sig-fail", selectedId: null });
    });
    act(() => {
      rerender({ graphSig: "sig-fail", selectedId: "sel-1" });
    });
    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["recovered"]);
    });
    expect(nodeflowColumnsBatch.mock.calls.length).toBeGreaterThan(afterFail);
  });

  it("does not seed a newly selected Select from a sibling Select's upstream cols", async () => {
    // Two disconnected inputs + two Selects each wired to one input.
    // Switching selection must not reconcile the bottom Select against the
    // top Select's inspCols (that left false missing-field tombstones).
    const nodes: NbNode[] = [
      { id: "in-top", type: "input", x: 0, y: 0, config: { table: "top" } },
      { id: "in-bot", type: "input", x: 0, y: 80, config: { table: "bot" } },
      {
        id: "sel-top",
        type: "select",
        x: 120,
        y: 0,
        config: { fields: [], label: "select" },
      },
      {
        id: "sel-bot",
        type: "select",
        x: 120,
        y: 80,
        config: { fields: [], label: "select" },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "e-top",
        from: { node: "in-top", port: "out" },
        to: { node: "sel-top", port: "in" },
      },
      {
        id: "e-bot",
        from: { node: "in-bot", port: "out" },
        to: { node: "sel-bot", port: "in" },
      },
    ];
    const colsByNode: Record<string, string[]> = {
      "in-top": ["alpha", "beta"],
      "in-bot": ["gamma", "delta"],
    };
    nodeflowColumnsBatch.mockImplementation(
      async (_graph?: unknown, reqs?: { node: string; port: string }[]) => ({
        results: (reqs || []).map((q) => ({
          node: q.node,
          port: q.port || "out",
          columns: colsByNode[q.node] || [],
        })),
      }),
    );

    const patch = vi.fn((id: string, config: Record<string, any>) => {
      const n = nodes.find((x) => x.id === id);
      if (n) n.config = { ...n.config, ...config };
    });

    const { result, rerender } = renderHook(
      (props: { selectedId: string | null; graphSig: string }) => {
        const sel =
          props.selectedId == null
            ? null
            : nodes.find((n) => n.id === props.selectedId) || null;
        return useNodeFlowInspectorController({
          scopeKey: "test",
          nodes: nodes.map((n) => ({ ...n, config: { ...n.config } })),
          edges,
          selectedId: props.selectedId,
          selectedNode: sel
            ? { ...sel, config: { ...(sel.config || {}) } }
            : null,
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
          selectedId: "sel-top" as string | null,
          graphSig: "sig-sibling-1",
        },
      },
    );

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["alpha", "beta"]);
    });

    act(() => {
      rerender({ selectedId: "sel-bot", graphSig: "sig-sibling-1" });
    });

    // Immediately after switch: must not expose top Select's columns.
    expect(result.current.inspCols.in).toBeUndefined();
    expect(result.current.inspColsProbing).toBe(true);

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["gamma", "delta"]);
      expect(result.current.inspColsProbing).toBe(false);
    });

    const botPatches = patch.mock.calls.filter((c) => c[0] === "sel-bot");
    for (const [, cfg] of botPatches) {
      const names = (cfg.fields || []).map((f: any) => f.name);
      expect(names).not.toContain("alpha");
      expect(names).not.toContain("beta");
    }

    // Bottom Select ends with only its own upstream columns — no false missing.
    const bot = nodes.find((n) => n.id === "sel-bot")!;
    const botNames = (bot.config.fields || []).map((f: any) => f.name);
    expect(botNames).toEqual(["gamma", "delta"]);

    // Changing top input headers (graphSig bump while bottom selected) must
    // not mark bottom Select fields missing / inject top columns.
    colsByNode["in-top"] = ["alpha", "beta", "new_top_only"];
    patch.mockClear();
    act(() => {
      rerender({ selectedId: "sel-bot", graphSig: "sig-sibling-2" });
    });
    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["gamma", "delta"]);
    });
    const botAfterTopChange = nodes.find((n) => n.id === "sel-bot")!;
    expect((botAfterTopChange.config.fields || []).map((f: any) => f.name)).toEqual(
      ["gamma", "delta"],
    );
    for (const [, cfg] of patch.mock.calls.filter((c) => c[0] === "sel-bot")) {
      const names = (cfg.fields || []).map((f: any) => f.name);
      expect(names).not.toContain("new_top_only");
      expect(names).not.toContain("alpha");
    }
  });

  it("disconnected Summarize/Sort chains: InputA change does not mark B-chain missing", async () => {
    // InputA→SelectA→SummarizeA / SortA  and  InputB→SelectB
    // Changing A headers while B is selected must leave B-chain configs and
    // B's inspCols untouched (no false missing from A's schema).
    const nodes: NbNode[] = [
      { id: "in-a", type: "input", x: 0, y: 0, config: { table: "a" } },
      { id: "in-b", type: "input", x: 0, y: 120, config: { table: "b" } },
      {
        id: "sel-a",
        type: "select",
        x: 120,
        y: 0,
        config: {
          fields: [
            { name: "region", keep: true },
            { name: "amount", keep: true },
          ],
          label: "sel-a",
        },
      },
      {
        id: "sum-a",
        type: "summarize",
        x: 260,
        y: 0,
        config: {
          group_by: ["region"],
          aggs: [{ col: "amount", fn: "sum", as: "total" }],
          label: "sum-a",
        },
      },
      {
        id: "sort-a",
        type: "sort",
        x: 400,
        y: 0,
        config: {
          sorts: [{ col: "region", dir: "asc" }],
          label: "sort-a",
        },
      },
      {
        id: "sel-b",
        type: "select",
        x: 120,
        y: 120,
        config: {
          fields: [
            { name: "sku", keep: true },
            { name: "qty", keep: true },
          ],
          label: "sel-b",
        },
      },
      {
        id: "sort-b",
        type: "sort",
        x: 260,
        y: 120,
        config: {
          sorts: [{ col: "sku", dir: "asc" }],
          label: "sort-b",
        },
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
        from: { node: "sel-a", port: "out" },
        to: { node: "sum-a", port: "in" },
      },
      {
        id: "e3",
        from: { node: "sum-a", port: "out" },
        to: { node: "sort-a", port: "in" },
      },
      {
        id: "e4",
        from: { node: "in-b", port: "out" },
        to: { node: "sel-b", port: "in" },
      },
      {
        id: "e5",
        from: { node: "sel-b", port: "out" },
        to: { node: "sort-b", port: "in" },
      },
    ];
    const colsByNode: Record<string, string[]> = {
      "in-a": ["region", "amount"],
      "in-b": ["sku", "qty"],
      "sel-a": ["region", "amount"],
      "sum-a": ["region", "total"],
      "sel-b": ["sku", "qty"],
    };
    nodeflowColumnsBatch.mockImplementation(
      async (_graph?: unknown, reqs?: { node: string; port: string }[]) => ({
        results: (reqs || []).map((q) => ({
          node: q.node,
          port: q.port || "out",
          columns: colsByNode[q.node] || [],
        })),
      }),
    );

    const patch = vi.fn((id: string, config: Record<string, any>) => {
      const n = nodes.find((x) => x.id === id);
      if (n) n.config = { ...n.config, ...config };
    });
    const snapshot = (id: string) =>
      JSON.parse(JSON.stringify(nodes.find((n) => n.id === id)!.config));

    const { result, rerender } = renderHook(
      (props: { selectedId: string | null; graphSig: string }) => {
        const sel =
          props.selectedId == null
            ? null
            : nodes.find((n) => n.id === props.selectedId) || null;
        return useNodeFlowInspectorController({
          scopeKey: "test",
          nodes: nodes.map((n) => ({ ...n, config: { ...n.config } })),
          edges,
          selectedId: props.selectedId,
          selectedNode: sel
            ? { ...sel, config: { ...(sel.config || {}) } }
            : null,
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
          selectedId: "sort-b" as string | null,
          graphSig: "iso-1",
        },
      },
    );

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["sku", "qty"]);
      expect(result.current.staleColRefs).toEqual([]);
    });

    const beforeB = {
      sel: snapshot("sel-b"),
      sort: snapshot("sort-b"),
    };
    const beforeA = {
      sel: snapshot("sel-a"),
      sum: snapshot("sum-a"),
      sort: snapshot("sort-a"),
    };

    // Shrink InputA headers — A-chain Select should gain missing tombstones
    // via wired-batch; B-chain must stay identical while sort-b is selected.
    colsByNode["in-a"] = ["region"];
    colsByNode["sel-a"] = ["region"];
    patch.mockClear();
    act(() => {
      rerender({ selectedId: "sort-b", graphSig: "iso-2" });
    });

    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["sku", "qty"]);
      expect(result.current.staleColRefs).toEqual([]);
    });

    expect(snapshot("sel-b")).toEqual(beforeB.sel);
    expect(snapshot("sort-b")).toEqual(beforeB.sort);
    // Wired-batch may refresh sel-a from in-a; amount becomes a missing tombstone.
    await waitFor(() => {
      const fields = (nodes.find((n) => n.id === "sel-a")!.config.fields ||
        []) as { name: string }[];
      expect(fields.map((f) => f.name)).toEqual(
        expect.arrayContaining(["region", "amount"]),
      );
    });
    // Summarize/Sort on A are not auto-wiped by schema refresh alone.
    expect(snapshot("sum-a")).toEqual(beforeA.sum);
    expect(snapshot("sort-a")).toEqual(beforeA.sort);

    // Selecting sum-a after A shrink: missing amount shows for A only.
    act(() => {
      rerender({ selectedId: "sum-a", graphSig: "iso-2" });
    });
    await waitFor(() => {
      expect(result.current.inspCols.in).toEqual(["region"]);
      expect(result.current.staleColRefs.some((r) => r.columns.includes("amount")))
        .toBe(true);
    });

    // Back to sort-b: no cross-bleed of A's missing refs.
    // Cache hit publishes in useLayoutEffect — columns ready in the same act().
    act(() => {
      rerender({ selectedId: "sort-b", graphSig: "iso-2" });
    });
    expect(result.current.inspCols.in).toEqual(["sku", "qty"]);
    expect(result.current.inspColsProbing).toBe(false);
    expect(result.current.staleColRefs).toEqual([]);
    expect(snapshot("sel-b")).toEqual(beforeB.sel);
    expect(snapshot("sort-b")).toEqual(beforeB.sort);
  });
});
