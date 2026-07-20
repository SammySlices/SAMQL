import React, { useLayoutEffect, useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowDocumentController } from "./useNodeFlowDocumentController";
import {
  clearLastRunPreviewCacheForTests,
  lastRunSeedRequests,
  useNodeFlowExecutionController,
} from "./useNodeFlowExecutionController";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const node = (id: string): NbNode => ({
  id,
  type: "input",
  x: 10,
  y: 10,
  config: { label: id, table: "source" },
});

const executionOpts = (
  source: NbNode,
  liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }>,
  overrides: Partial<{
    activeTabId: string;
    graphSig: string;
    dataEpoch: number;
  }> = {},
) => ({
  activeTabId: overrides.activeTabId ?? "tab-a",
  nodes: [source],
  edges: [] as NbEdge[],
  liveRef,
  graphSig: overrides.graphSig ?? "graph-a",
  dataEpoch: overrides.dataEpoch ?? 3,
  graphForApi: () => ({ nodes: [], edges: [] }),
  graphForRun: () => ({ nodes: [], edges: [] }),
  childCtx: () => null,
  partialGroupGraph: () => ({ nodes: [], edges: [] }),
  patch: vi.fn(),
  setNodes: vi.fn(),
  setNodeErrors: vi.fn(),
  setNodeWarnings: vi.fn(),
  onToast: vi.fn(),
  fireRipple: vi.fn(),
});

beforeEach(() => {
  window.localStorage.clear();
  clearLastRunPreviewCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearLastRunPreviewCacheForTests();
});

describe("Phase 8 NodeFlow controllers", () => {
  it("drops a stale execution result after switching tabs", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "nodeflowRun").mockImplementation(
      () => request.promise as ReturnType<typeof api.nodeflowRun>,
    );
    const toast = vi.fn();
    const setNodeErrors = vi.fn();
    const setNodeWarnings = vi.fn();
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };

    const { result, rerender } = renderHook(
      ({ tabId }) =>
        useNodeFlowExecutionController({
          activeTabId: tabId,
          nodes: [source],
          edges: [],
          liveRef,
          graphSig: "graph-a",
          graphForApi: () => ({ nodes: [], edges: [] }),
          graphForRun: () => ({ nodes: [], edges: [] }),
          childCtx: () => null,
          partialGroupGraph: () => ({ nodes: [], edges: [] }),
          patch: vi.fn(),
          setNodes: vi.fn(),
          setNodeErrors,
          setNodeWarnings,
          onToast: toast,
          fireRipple: vi.fn(),
        }),
      { initialProps: { tabId: "tab-a" } },
    );

    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.runAll();
      // runAll awaits flowCacheInfo before startRun for single-leaf graphs.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.running).toBe(true);
    expect([...result.current.runningNodeIds]).toEqual(["source-a"]);

    rerender({ tabId: "tab-b" });
    expect(result.current.running).toBe(false);
    expect(result.current.runningNodeIds.size).toBe(0);
    expect(result.current.preview).toBeNull();

    await act(async () => {
      request.resolve({
        columns: ["id"],
        rows: [[1]],
        total_rows: 1,
      });
      await pending;
    });

    expect(result.current.preview).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    expect(setNodeErrors).not.toHaveBeenCalled();
  });

  it("keeps concurrent run state active until the final request finishes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    vi.spyOn(api, "nodeflowRun")
      .mockImplementationOnce(() => first.promise as ReturnType<typeof api.nodeflowRun>)
      .mockImplementationOnce(() => second.promise as ReturnType<typeof api.nodeflowRun>);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [source],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    let pendingA!: Promise<void>;
    let pendingB!: Promise<void>;
    await act(async () => {
      // Two overlapping Run-all / leaf runs (preview clicks no longer execute).
      pendingA = result.current.runAll();
      pendingB = result.current.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.running).toBe(true);
    expect(result.current.runningNodeIds).toEqual(new Set(["source-a"]));

    await act(async () => {
      first.resolve({ columns: ["id"], rows: [[1]], total_rows: 1 });
      await pendingA;
    });
    expect(result.current.running).toBe(true);
    expect(result.current.runningNodeIds).toEqual(new Set(["source-a"]));

    await act(async () => {
      second.resolve({ columns: ["id"], rows: [[2]], total_rows: 1 });
      await pendingB;
    });
    expect(result.current.running).toBe(false);
    expect(result.current.runningNodeIds.size).toBe(0);
    expect(result.current.status.kind).toBe("done");
  });

  it("tracks all terminal nodes during a client-side batch run", async () => {
    const batch = deferred<any>();
    vi.spyOn(api, "nodeflowRunBatch").mockImplementation(
      () => batch.promise as ReturnType<typeof api.nodeflowRunBatch>,
    );
    const a = node("source-a");
    const b = node("source-b");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [a, b], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [a, b],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runAll();
    });
    expect(result.current.running).toBe(true);
    expect(result.current.runningNodeIds).toEqual(new Set(["source-a", "source-b"]));

    await act(async () => {
      batch.resolve({
        ok: true,
        results: [
          { node: "source-a", columns: ["id"], rows: [[1]], total_rows: 1 },
          { node: "source-b", columns: ["id"], rows: [[2]], total_rows: 1 },
        ],
      });
      await pending;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.runningNodeIds.size).toBe(0);
    // Product intent: Run all executes without opening the results drawer.
    expect(result.current.preview).toBeNull();
  });

  it("opens an empty preview drawer on output click without executing", async () => {
    const run = vi.spyOn(api, "nodeflowRun");
    const batch = vi.spyOn(api, "nodeflowRunBatch");
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [source],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.doPreview(source, "out", "Source · out");
    });

    expect(run).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(result.current.running).toBe(false);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Source · out",
        columns: [],
        rows: [],
        total: 0,
        sourceNodeId: "source-a",
        sourcePort: "out",
      }),
    );
    expect(result.current.status.text).toMatch(/no cached results/i);
  });

  it("does not open the preview drawer when a single leaf run succeeds", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "nodeflowRun").mockImplementation(
      () => request.promise as ReturnType<typeof api.nodeflowRun>,
    );
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [source],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runAll();
    });

    await act(async () => {
      request.resolve({
        columns: ["id"],
        rows: [[1]],
        total_rows: 1,
      });
      await pending;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.preview).toBeNull();
    expect(result.current.status.kind).toBe("done");
  });

  it("reuses Run-all last-run rows on output click without recomputing", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[42]],
      total_rows: 1,
    } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [source],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        dataEpoch: 3,
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.doPreview(source, "out", "Source · out");
    });
    // Last-run cache from Run all — no second nodeflowRun.
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        columns: ["id"],
        rows: [[42]],
        total: 1,
        sourceNodeId: "source-a",
      }),
    );
    expect(result.current.status.text).toMatch(/cached/i);
  });

  it("replaces open preview with post–Run-all last-run rows", async () => {
    const run = vi
      .spyOn(api, "nodeflowRun")
      .mockResolvedValueOnce({
        columns: ["id"],
        rows: [["old"]],
        total_rows: 1,
      } as any)
      .mockResolvedValueOnce({
        columns: ["id"],
        rows: [["new"]],
        total_rows: 1,
      } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [source],
        edges: [],
        liveRef,
        graphSig: "graph-a",
        dataEpoch: 1,
        graphForApi: () => ({ nodes: [], edges: [] }),
        graphForRun: () => ({ nodes: [], edges: [] }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.runAll();
    });
    await act(async () => {
      await result.current.doPreview(source, "out", "Source · out");
    });
    expect(result.current.preview?.kind === "table" &&
      result.current.preview.rows[0][0]).toBe("old");
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(2);
    // Drawer stays open but must show the new Run-all rows, not "old".
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [["new"]],
        total: 1,
      }),
    );
  });

  it("seeds last-run cache for A→B→C so each node previews without re-run", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[3]],
      total_rows: 1,
    } as any);
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "node-a",
          port: "out",
          columns: ["id"],
          rows: [["a"]],
          total_rows: 1,
        },
        {
          node: "node-b",
          port: "out",
          columns: ["id"],
          rows: [["b"]],
          total_rows: 1,
        },
        {
          node: "node-c",
          port: "out",
          columns: ["id"],
          rows: [["c"]],
          total_rows: 1,
        },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    const nodeA: NbNode = {
      id: "node-a",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "A", table: "t" },
    };
    const nodeB: NbNode = {
      id: "node-b",
      type: "select",
      x: 120,
      y: 0,
      config: { label: "B", fields: [] },
    };
    const nodeC: NbNode = {
      id: "node-c",
      type: "select",
      x: 240,
      y: 0,
      config: { label: "C", fields: [] },
    };
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "node-a", port: "out" },
        to: { node: "node-b", port: "in" },
      },
      {
        id: "e2",
        from: { node: "node-b", port: "out" },
        to: { node: "node-c", port: "in" },
      },
    ];
    expect(lastRunSeedRequests([nodeA, nodeB, nodeC], edges, ["node-c"])).toEqual(
      expect.arrayContaining([
        { node: "node-a", port: "out" },
        { node: "node-b", port: "out" },
        { node: "node-c", port: "out" },
      ]),
    );

    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [nodeA, nodeB, nodeC], edges },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [nodeA, nodeB, nodeC],
        edges,
        liveRef,
        graphSig: "graph-abc",
        dataEpoch: 1,
        graphForApi: () => ({ nodes: [nodeA, nodeB, nodeC], edges }),
        graphForRun: () => ({ nodes: [nodeA, nodeB, nodeC], edges }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
    // Seed pass is preview-limited and targets the full A→B→C closure.
    expect(runBatch.mock.calls[0][4]).toBe(true);
    expect(runBatch.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        { node: "node-a", port: "out" },
        { node: "node-b", port: "out" },
        { node: "node-c", port: "out" },
      ]),
    );

    for (const [n, row] of [
      [nodeA, "a"],
      [nodeB, "b"],
      [nodeC, "c"],
    ] as const) {
      await act(async () => {
        await result.current.doPreview(n, "out", `${n.config.label} · out`);
      });
      expect(result.current.preview).toEqual(
        expect.objectContaining({
          kind: "table",
          rows: [[row]],
          sourceNodeId: n.id,
        }),
      );
      expect(result.current.status.text).toMatch(/cached/i);
    }
    // Cache-only previews — no further execute.
    expect(run).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it("clears last-run cache on dataEpoch bump so output click does not re-run", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[1]],
      total_rows: 1,
    } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result, rerender } = renderHook(
      ({ epoch }) =>
        useNodeFlowExecutionController({
          activeTabId: "tab-a",
          nodes: [source],
          edges: [],
          liveRef,
          graphSig: "graph-a",
          dataEpoch: epoch,
          graphForApi: () => ({ nodes: [], edges: [] }),
          graphForRun: () => ({ nodes: [], edges: [] }),
          childCtx: () => null,
          partialGroupGraph: () => ({ nodes: [], edges: [] }),
          patch: vi.fn(),
          setNodes: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          onToast: vi.fn(),
          fireRipple: vi.fn(),
        }),
      { initialProps: { epoch: 1 } },
    );

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);

    rerender({ epoch: 2 });
    expect(result.current.preview).toBeNull();

    await act(async () => {
      await result.current.doPreview(source, "out", "Source · out");
    });
    // File-change epoch cleared cache; click shows empty, does not execute.
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [],
        total: 0,
      }),
    );
    expect(result.current.running).toBe(false);
  });

  it("keeps last-run cache across remount (IDE / Journal / Dashboard tab switch)", async () => {
    // Real App bootstraps activeTabId as "" then the document tab id.
    // Remount must not treat that as a workflow switch (which clears cache).
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[99]],
      total_rows: 1,
    } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };

    const first = renderHook(
      ({ tabId }) =>
        useNodeFlowExecutionController(
          executionOpts(source, liveRef, { activeTabId: tabId }),
        ),
      { initialProps: { tabId: "" } },
    );
    await act(async () => {
      first.rerender({ tabId: "tab-a" });
    });
    await act(async () => {
      await first.result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);
    first.unmount();

    // Simulate leaving NodeFlow for IDE / Journal / Dashboard, then return.
    const second = renderHook(
      ({ tabId }) =>
        useNodeFlowExecutionController(
          executionOpts(source, liveRef, { activeTabId: tabId }),
        ),
      { initialProps: { tabId: "" } },
    );
    await act(async () => {
      second.rerender({ tabId: "tab-a" });
    });
    await act(async () => {
      await second.result.current.doPreview(source, "out", "Source · out");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [[99]],
        total: 1,
        sourceNodeId: "source-a",
      }),
    );
    expect(second.result.current.status.text).toMatch(/cached/i);
    second.unmount();
  });

  it("keeps last-run cache when graphSig changes after Run all (post-run prune)", async () => {
    // Missing-ref prune patches Select fields → executionGraphSignature flips.
    // Last-run rows must still resolve on output click (no graphSig salt).
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[7]],
      total_rows: 1,
    } as any);
    const source = node("source-a");
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [source], edges: [] },
    };
    const { result, rerender } = renderHook(
      ({ sig }) =>
        useNodeFlowExecutionController(
          executionOpts(source, liveRef, { graphSig: sig, dataEpoch: 1 }),
        ),
      { initialProps: { sig: "graph-before-prune" } },
    );

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);

    rerender({ sig: "graph-after-prune" });
    await act(async () => {
      await result.current.doPreview(source, "out", "Source · out");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [[7]],
        total: 1,
        sourceNodeId: "source-a",
      }),
    );
    expect(result.current.status.text).toMatch(/cached/i);
  });

  it("keeps only the latest asynchronous workflow file open", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    vi.spyOn(api, "openFile")
      .mockImplementationOnce(() => first.promise as ReturnType<typeof api.openFile>)
      .mockImplementationOnce(() => second.promise as ReturnType<typeof api.openFile>);
    const toast = vi.fn();

    const { result } = renderHook(() => {
      const [nodes, setNodes] = useState<NbNode[]>([]);
      const [edges, setEdges] = useState<NbEdge[]>([]);
      const nodesRef = useRef<NbNode[]>(nodes);
      const edgesRef = useRef<NbEdge[]>(edges);
      useLayoutEffect(() => {
        nodesRef.current = nodes;
        edgesRef.current = edges;
      }, [edges, nodes]);
      const controller = useNodeFlowDocumentController({
        nodes,
        edges,
        nodesRef,
        edgesRef,
        setNodes,
        setEdges,
        setSelectedId: vi.fn(),
        setSelectedIds: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        setNodeMenu: vi.fn(),
        setDeleteConfirm: vi.fn(),
        onToast: toast,
      });
      return { controller };
    });

    act(() => result.current.controller.setNodeFileModal({ mode: "open" }));
    let pendingFirst!: Promise<void>;
    act(() => {
      pendingFirst = result.current.controller.onPickNodeFile("first.samql.json");
    });
    act(() => result.current.controller.setNodeFileModal({ mode: "open" }));
    let pendingSecond!: Promise<void>;
    act(() => {
      pendingSecond = result.current.controller.onPickNodeFile("second.samql.json");
    });

    await act(async () => {
      second.resolve({
        name: "Second.samql.json",
        content: JSON.stringify({
          kind: "node",
          name: "Second",
          payload: { nodes: [node("second-node")], edges: [] },
        }),
      });
      await pendingSecond;
    });
    await act(async () => {
      first.resolve({
        name: "First.samql.json",
        content: JSON.stringify({
          kind: "node",
          name: "First",
          payload: { nodes: [node("first-node")], edges: [] },
        }),
      });
      await pendingFirst;
    });

    expect(result.current.controller.tabs.some((tab) => tab.name === "Second")).toBe(true);
    expect(result.current.controller.tabs.some((tab) => tab.name === "First")).toBe(false);
    expect(toast).toHaveBeenCalledWith("ok", "Workflow loaded", "Second");
    expect(toast).not.toHaveBeenCalledWith("ok", "Workflow loaded", "First");
  });
});
