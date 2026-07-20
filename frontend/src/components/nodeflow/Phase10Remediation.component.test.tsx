import React, { useLayoutEffect, useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import {
  NODEFLOW_FILE_FORMAT,
  NODEFLOW_FILE_VERSION,
  TAB_KEY,
  TABS_KEY,
  parseNodeFlowGraph,
  serializeNodeFlowGraph,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";
import { useNodeFlowAnimations } from "./useNodeFlowAnimations";
import { useNodeFlowDocumentController } from "./useNodeFlowDocumentController";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";
import { useNodeFlowGraphController } from "./useNodeFlowGraphController";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeNode = (id: string, type: NbNode["type"] = "input"): NbNode => ({
  id,
  type,
  x: 10,
  y: 10,
  config: {
    label: id,
    table: "source",
    checks: [],
    x: "category",
    columns: ["value"],
    rows: [["one"]],
    dest: "duckdb",
  },
});

function useExecutionHarness(tabId: string, source: NbNode, toast = vi.fn()) {
  const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
    current: { nodes: [source], edges: [] },
  };
  return useNodeFlowExecutionController({
    activeTabId: tabId,
    nodes: [source],
    edges: [],
    liveRef,
    graphSig: "graph-a",
    graphForApi: () => ({ nodes: [source], edges: [] }),
    graphForRun: () => ({ nodes: [source], edges: [] }),
    childCtx: () => null,
    partialGroupGraph: () => ({ nodes: [source], edges: [] }),
    patch: vi.fn(),
    setNodes: vi.fn(),
    setNodeErrors: vi.fn(),
    setNodeWarnings: vi.fn(),
    onToast: toast,
    fireRipple: vi.fn(),
  });
}

function useDocumentHarness() {
  const [nodes, setNodes] = useState<NbNode[]>([]);
  const [edges, setEdges] = useState<NbEdge[]>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useLayoutEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);
  return useNodeFlowDocumentController({
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
    onToast: vi.fn(),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("post-Phase-10 remediation", () => {
  it("drops stale validation state and notifications after a tab switch", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "nodeflowValidate").mockReturnValue(
      request.promise as ReturnType<typeof api.nodeflowValidate>,
    );
    const toast = vi.fn();
    const source = makeNode("validate-a", "validate");
    const { result, rerender } = renderHook(
      ({ tabId }) => useExecutionHarness(tabId, source, toast),
      { initialProps: { tabId: "tab-a" } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.doValidate(source);
    });
    rerender({ tabId: "tab-b" });

    await act(async () => {
      request.resolve({ ok: true, total_rows: 1, results: [] });
      await pending;
    });

    expect(result.current.validateResults).toEqual({});
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not recreate stale chart state after a tab switch", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "nodeflowChart").mockReturnValue(
      request.promise as ReturnType<typeof api.nodeflowChart>,
    );
    const source = makeNode("chart-a", "chart");
    const { result, rerender } = renderHook(
      ({ tabId }) => useExecutionHarness(tabId, source),
      { initialProps: { tabId: "tab-a" } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.ensureChartFor(source);
    });
    rerender({ tabId: "tab-b" });

    await act(async () => {
      request.reject(new Error("old chart failed"));
      await pending;
    });

    expect(result.current.chartData).toEqual({});
  });

  it("coalesces same-tick chart hydration requests", async () => {
    const request = deferred<any>();
    const chart = vi.spyOn(api, "nodeflowChart").mockReturnValue(
      request.promise as ReturnType<typeof api.nodeflowChart>,
    );
    const source = makeNode("chart-a", "chart");
    const { result } = renderHook(() => useExecutionHarness("tab-a", source));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.ensureChartFor(source);
      second = result.current.ensureChartFor(source);
    });
    expect(chart).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve({ series: [], categories: [] });
      await Promise.all([first, second]);
    });
  });

  it("recovers an immediate Stop even when the run promise remains pending", async () => {
    vi.useFakeTimers();
    const request = deferred<any>();
    vi.spyOn(api, "nodeflowRun").mockReturnValue(
      request.promise as ReturnType<typeof api.nodeflowRun>,
    );
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    vi.spyOn(api, "cancelAll").mockResolvedValue({ ok: true } as any);
    vi.spyOn(api, "cancelQuery").mockResolvedValue({ ok: true } as any);
    const source = makeNode("source-a");
    const { result } = renderHook(() => useExecutionHarness("tab-a", source));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.runAll();
      // Let runAll pass flowCacheInfo and enter startRun before Stop.
      await Promise.resolve();
      await Promise.resolve();
      void result.current.cancelRun();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(result.current.running).toBe(false);
    expect(result.current.status.text).toBe("Cancelled");

    await act(async () => {
      request.resolve({ cancelled: true });
      await pending;
    });
  });

  it("aborts an owned NodeFlow request on unmount", async () => {
    const request = deferred<any>();
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "nodeflowRun").mockImplementation((...args: any[]) => {
      signal = args[4] as AbortSignal;
      return request.promise as ReturnType<typeof api.nodeflowRun>;
    });
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    vi.spyOn(api, "cancelQuery").mockResolvedValue({ ok: true } as any);
    const source = makeNode("source-a");
    const { result, unmount } = renderHook(() =>
      useExecutionHarness("tab-a", source),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.runAll();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);

    request.resolve({ cancelled: true });
    await pending;
  });

  it("recovers a malformed tab index into a valid backed-up blank tab", () => {
    window.localStorage.setItem(TABS_KEY, "{broken-json");
    const { result } = renderHook(useDocumentHarness);

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(result.current.tabs[0].id);
    expect(window.localStorage.getItem(`${TABS_KEY}.pre-migration-backup`)).toBe(
      "{broken-json",
    );
  });

  it("keeps valid tabs when another stored tab body is corrupt", () => {
    const valid = makeNode("valid");
    window.localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        version: 3,
        tabs: [
          { id: "good", name: "Good" },
          { id: "bad", name: "Bad" },
        ],
        activeTabId: "good",
      }),
    );
    window.localStorage.setItem(
      TAB_KEY("good"),
      JSON.stringify(serializeNodeFlowGraph([valid], [])),
    );
    window.localStorage.setItem(TAB_KEY("bad"), "{broken-json");

    const { result } = renderHook(useDocumentHarness);
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["good", "bad"]);
    expect(result.current.activeTabId).toBe("good");
  });

  it("commits deletion synchronously in the originating document and deduplicates it", () => {
    vi.useFakeTimers();
    const shared = makeNode("same");
    const aOnly = makeNode("a-only");
    const bOnly = makeNode("b-only");
    const setNodesA = vi.fn();
    const setNodesB = vi.fn();

    const { result, rerender } = renderHook(
      ({ currentNodes, setNodes }) => {
        const nodesRef = useRef<NbNode[]>(currentNodes);
        const edgesRef = useRef<NbEdge[]>([]);
        const liveRef = useRef({ nodes: currentNodes, edges: [] as NbEdge[] });
        nodesRef.current = currentNodes;
        liveRef.current = { nodes: currentNodes, edges: [] };
        const effects = useNodeFlowAnimations();
        return useNodeFlowGraphController({
          nodesRef,
          edgesRef,
          liveRef,
          setNodes: setNodes as React.Dispatch<React.SetStateAction<NbNode[]>>,
          setEdges: vi.fn(),
          selectedId: null,
          setSelectedId: vi.fn(),
          setSelectedIds: vi.fn(),
          setNodeErrors: vi.fn(),
          setDeleteConfirm: vi.fn(),
          contentRef: { current: null },
          zoomRef: { current: 1 },
          fireBorn: vi.fn(),
          withImplosion: effects.withImplosion,
        });
      },
      { initialProps: { currentNodes: [shared, aOnly], setNodes: setNodesA } },
    );

    act(() => {
      result.current.doRemoveNode("same");
      result.current.doRemoveNode("same");
    });
    expect(setNodesA).toHaveBeenCalledTimes(1);
    expect(setNodesA).toHaveBeenCalledWith([aOnly]);

    rerender({ currentNodes: [shared, bOnly], setNodes: setNodesB });
    void act(() => vi.advanceTimersByTime(230));
    expect(setNodesB).not.toHaveBeenCalled();
  });

  it("makes directory listings latest-request-wins and tab-scoped", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    vi.spyOn(api, "fsList").mockImplementation((folder?: string) =>
      (folder === "/a" ? first.promise : second.promise) as ReturnType<
        typeof api.fsList
      >,
    );
    const source = makeNode("dir", "directory");
    const { result, rerender } = renderHook(
      ({ tabId }) => useExecutionHarness(tabId, source),
      { initialProps: { tabId: "tab-a" } },
    );

    let firstPending!: Promise<void>;
    let secondPending!: Promise<void>;
    act(() => {
      firstPending = result.current.loadDirList("/a");
      secondPending = result.current.loadDirList("/b");
    });
    await act(async () => {
      second.resolve({
        entries: [
          { name: "new.csv", path: "/b/new.csv", ext: "csv", is_dir: false },
        ],
      });
      await secondPending;
    });
    await act(async () => {
      first.resolve({
        entries: [
          { name: "old.csv", path: "/a/old.csv", ext: "csv", is_dir: false },
        ],
      });
      await firstPending;
    });
    expect(result.current.dirList.folder).toBe("/b");

    const stale = deferred<any>();
    vi.spyOn(api, "fsList").mockReturnValue(
      stale.promise as ReturnType<typeof api.fsList>,
    );
    let stalePending!: Promise<void>;
    act(() => {
      stalePending = result.current.loadDirList("/old-tab");
    });
    rerender({ tabId: "tab-b" });
    await act(async () => {
      stale.reject(new Error("old listing failed"));
      await stalePending;
    });
    expect(result.current.dirList).toEqual({
      folder: "",
      files: [],
      loading: false,
    });
  });

  it("suppresses stale create-table failures after a tab switch", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "tableCreate").mockReturnValue(
      request.promise as ReturnType<typeof api.tableCreate>,
    );
    const toast = vi.fn();
    const source = makeNode("grid", "createtable");
    const { result, rerender } = renderHook(
      ({ tabId }) => useExecutionHarness(tabId, source, toast),
      { initialProps: { tabId: "tab-a" } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.doCreateTable(source);
    });
    rerender({ tabId: "tab-b" });
    await act(async () => {
      request.reject(new Error("old create failed"));
      await pending;
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("rejects unknown node types, dangling endpoints, and invalid ports", () => {
    expect(() =>
      parseNodeFlowGraph({
        format: NODEFLOW_FILE_FORMAT,
        version: NODEFLOW_FILE_VERSION,
        nodes: [{ ...makeNode("future"), type: "not-registered" }],
        edges: [],
      }),
    ).toThrow(/unknown node type/i);

    expect(() =>
      parseNodeFlowGraph({
        format: NODEFLOW_FILE_FORMAT,
        version: NODEFLOW_FILE_VERSION,
        nodes: [makeNode("present", "filter")],
        edges: [
          {
            id: "dangling",
            from: { node: "missing", port: "out" },
            to: { node: "present", port: "in" },
          },
        ],
      }),
    ).toThrow(/missing node/i);

    expect(() =>
      parseNodeFlowGraph({
        format: NODEFLOW_FILE_FORMAT,
        version: NODEFLOW_FILE_VERSION,
        nodes: [makeNode("a"), makeNode("b", "filter")],
        edges: [
          {
            id: "bad-port",
            from: { node: "a", port: "not-an-output" },
            to: { node: "b", port: "in" },
          },
        ],
      }),
    ).toThrow(/unknown output port/i);
  });
});
