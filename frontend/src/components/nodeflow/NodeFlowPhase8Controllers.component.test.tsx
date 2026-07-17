import React, { useLayoutEffect, useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowDocumentController } from "./useNodeFlowDocumentController";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";

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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.doPreview(source, "out", "Source preview");
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

    let pendingA!: Promise<void>;
    let pendingB!: Promise<void>;
    act(() => {
      pendingA = result.current.doPreview(a, "out", "A");
      pendingB = result.current.doPreview(b, "out", "B");
    });
    expect(result.current.running).toBe(true);
    expect(result.current.runningNodeIds).toEqual(new Set(["source-a", "source-b"]));

    await act(async () => {
      first.resolve({ columns: ["id"], rows: [[1]], total_rows: 1 });
      await pendingA;
    });
    expect(result.current.running).toBe(true);
    expect(result.current.runningNodeIds).toEqual(new Set(["source-b"]));

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

  it("opens the preview drawer only when doPreview is invoked (output click)", async () => {
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
      pending = result.current.doPreview(source, "out", "Source · out");
    });
    expect(result.current.preview).toBeNull();

    await act(async () => {
      request.resolve({
        columns: ["id"],
        rows: [[1]],
        total_rows: 1,
      });
      await pending;
    });

    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Source · out",
        columns: ["id"],
        total: 1,
        sourceNodeId: "source-a",
        sourcePort: "out",
      }),
    );
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
