import React, { useLayoutEffect, useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { PORTS, type NbEdge, type NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowDocumentController } from "./useNodeFlowDocumentController";
import {
  clearLastRunPreviewCacheForTests,
  connectorMayPeek,
  descendantNodeIds,
  isFilterPreviewPort,
  isJoinSidePreviewPort,
  isSemanticConfigPatch,
  lastRunSeedRequests,
  leafRunPort,
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

  it("opens an empty preview drawer on Select output click without executing", async () => {
    // Select (and most transforms) stay cache-only on miss. Load/source,
    // Join sides, and Filter True/False may peek — covered separately.
    const run = vi.spyOn(api, "nodeflowRun");
    const batch = vi.spyOn(api, "nodeflowRunBatch");
    const sel: NbNode = {
      id: "sel-a",
      type: "select",
      x: 10,
      y: 10,
      config: {
        label: "Select",
        fields: [{ name: "x", keep: true }],
      },
    };
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [sel], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [sel],
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
      await result.current.doPreview(sel, "out", "Select · output");
    });

    expect(run).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(result.current.running).toBe(false);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Select · output",
        columns: [],
        rows: [],
        total: 0,
        sourceNodeId: "sel-a",
        sourcePort: "out",
      }),
    );
    expect(result.current.status.text).toMatch(/no cached results/i);
  });

  it("Filter True/False Preview peeks on cache miss", async () => {
    // Preview UX gap: cache-only Filter left Preview True empty until Run all
    // seeded last-run rows. Users filtering demo_orders (order_id = 101)
    // expect matching rows from Preview True alone — same peek bound as Join.
    expect(isFilterPreviewPort("true")).toBe(true);
    expect(isFilterPreviewPort("false")).toBe(true);
    expect(isFilterPreviewPort("out")).toBe(false);

    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["order_id", "region"],
      rows: [[101, "East"]],
      total_rows: 1,
      preview_limited: true,
    } as any);
    const batch = vi.spyOn(api, "nodeflowRunBatch");
    const src = node("src-ord");
    const flt: NbNode = {
      id: "flt-ord",
      type: "filter",
      x: 160,
      y: 10,
      config: {
        label: "Filter",
        filterMode: "simple",
        field: "order_id",
        op: "=",
        value: "101",
        condition: "[order_id] = 101",
      },
    };
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "src-ord", port: "out" },
        to: { node: "flt-ord", port: "in" },
      },
    ];
    const graph = { nodes: [src, flt], edges };
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: graph,
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-filter-peek",
        nodes: [src, flt],
        edges,
        liveRef,
        graphSig: "graph-filter-peek",
        graphForApi: () => graph,
        graphForRun: () => graph,
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
      await result.current.doPreview(flt, "true", "Filter · True");
    });

    expect(batch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    const call = run.mock.calls[0];
    expect(call?.[1]).toBe("flt-ord");
    expect(call?.[2]).toBe("true");
    expect(call?.[5]).toBe(true); // preview flag
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Filter · True",
        columns: ["order_id", "region"],
        rows: [[101, "East"]],
        total: 1,
        sourceNodeId: "flt-ord",
        sourcePort: "true",
      }),
    );
  });

  it("Join left_only / right_only Preview peeks on cache miss", async () => {
    // Code was wrong for Join side UX: cache-only doPreview left only L / only R
    // empty whenever Run-all seeded solely the wired ``inner`` port (or never
    // ran). Prefer a preview-limited join-side peek — same bound as sources.
    expect(isJoinSidePreviewPort("left_only")).toBe(true);
    expect(isJoinSidePreviewPort("right_only")).toBe(true);
    expect(isJoinSidePreviewPort("inner")).toBe(true);
    expect(isJoinSidePreviewPort("left")).toBe(false);

    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[1]],
      total_rows: 1,
      preview_limited: true,
    } as any);
    const batch = vi.spyOn(api, "nodeflowRunBatch");
    const leftSrc = node("src-l");
    const rightSrc: NbNode = {
      ...node("src-r"),
      config: { label: "src-r", table: "right" },
    };
    const join: NbNode = {
      id: "join-1",
      type: "join",
      x: 200,
      y: 10,
      config: {
        label: "Join",
        keys: [{ left: "id", right: "id" }],
      },
    };
    const edges: NbEdge[] = [
      {
        id: "e-l",
        from: { node: "src-l", port: "out" },
        to: { node: "join-1", port: "left" },
      },
      {
        id: "e-r",
        from: { node: "src-r", port: "out" },
        to: { node: "join-1", port: "right" },
      },
    ];
    const graph = { nodes: [leftSrc, rightSrc, join], edges };
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: graph,
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-join",
        nodes: [leftSrc, rightSrc, join],
        edges,
        liveRef,
        graphSig: "graph-join",
        dataEpoch: 1,
        graphForApi: () => graph,
        graphForRun: () => graph,
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
      await result.current.doPreview(join, "left_only", "Join · only L");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe("join-1");
    expect(run.mock.calls[0]?.[2]).toBe("left_only");
    expect(run.mock.calls[0]?.[5]).toBe(true); // preview
    expect(run.mock.calls[0]?.[6]).toBe(200); // limit
    expect(batch).not.toHaveBeenCalled();
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Join · only L",
        columns: ["id"],
        rows: [[1]],
        total: 1,
        sourceNodeId: "join-1",
        sourcePort: "left_only",
      }),
    );

    run.mockClear();
    run.mockResolvedValue({
      columns: ["id"],
      rows: [[9]],
      total_rows: 1,
      preview_limited: true,
    } as any);
    await act(async () => {
      await result.current.doPreview(join, "right_only", "Join · only R");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[2]).toBe("right_only");
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        sourcePort: "right_only",
        rows: [[9]],
      }),
    );
  });

  it("Join Preview left/right resolves upstream source without join execute", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id", "name"],
      rows: [[1, "a"]],
      total_rows: 1,
      preview_limited: false,
    } as any);
    const leftSrc = node("src-l");
    const rightSrc: NbNode = {
      ...node("src-r"),
      config: { label: "src-r", table: "right" },
    };
    const join: NbNode = {
      id: "join-1",
      type: "join",
      x: 200,
      y: 10,
      config: {
        label: "Join",
        keys: [{ left: "id", right: "id" }],
      },
    };
    const edges: NbEdge[] = [
      {
        id: "e-l",
        from: { node: "src-l", port: "out" },
        to: { node: "join-1", port: "left" },
      },
      {
        id: "e-r",
        from: { node: "src-r", port: "out" },
        to: { node: "join-1", port: "right" },
      },
    ];
    const graph = { nodes: [leftSrc, rightSrc, join], edges };
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: graph,
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-join-in",
        nodes: [leftSrc, rightSrc, join],
        edges,
        liveRef,
        graphSig: "graph-join-in",
        dataEpoch: 1,
        graphForApi: () => graph,
        graphForRun: () => graph,
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
      await result.current.doPreview(join, "left", "Join · left");
    });
    // Upstream Input peek — not a join-port execute.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe("src-l");
    expect(run.mock.calls[0]?.[2]).toBe("out");
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Join · left",
        columns: ["id", "name"],
        rows: [[1, "a"]],
        sourceNodeId: "src-l",
        sourcePort: "out",
      }),
    );

    run.mockClear();
    run.mockResolvedValue({
      columns: ["id"],
      rows: [[2]],
      total_rows: 1,
    } as any);
    await act(async () => {
      await result.current.doPreview(join, "right", "Join · right");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe("src-r");
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        title: "Join · right",
        sourceNodeId: "src-r",
        rows: [[2]],
      }),
    );
  });

  it("lastRunSeedRequests always includes all Join side ports when only inner is wired", () => {
    const leftSrc = node("src-l");
    const rightSrc = node("src-r");
    const join: NbNode = {
      id: "join-1",
      type: "join",
      x: 200,
      y: 0,
      config: { label: "Join", keys: [{ left: "id", right: "id" }] },
    };
    const out: NbNode = {
      id: "out-1",
      type: "output",
      x: 360,
      y: 0,
      config: { label: "Output", format: "csv" },
    };
    const edges: NbEdge[] = [
      {
        id: "e-l",
        from: { node: "src-l", port: "out" },
        to: { node: "join-1", port: "left" },
      },
      {
        id: "e-r",
        from: { node: "src-r", port: "out" },
        to: { node: "join-1", port: "right" },
      },
      {
        id: "e-o",
        from: { node: "join-1", port: "inner" },
        to: { node: "out-1", port: "in" },
      },
    ];
    const reqs = lastRunSeedRequests(
      [leftSrc, rightSrc, join, out],
      edges,
      ["out-1"],
    );
    expect(reqs).toEqual(
      expect.arrayContaining([
        { node: "join-1", port: "left_only" },
        { node: "join-1", port: "inner" },
        { node: "join-1", port: "right_only" },
      ]),
    );
  });

  it("lastRunSeedRequests always includes Filter True and False when only True is wired", () => {
    const src = node("src-f");
    const flt: NbNode = {
      id: "flt-1",
      type: "filter",
      x: 160,
      y: 0,
      config: { label: "Filter", condition: "id > 0", filterMode: "custom" },
    };
    const out: NbNode = {
      id: "out-f",
      type: "output",
      x: 320,
      y: 0,
      config: { label: "Output", format: "csv" },
    };
    const edges: NbEdge[] = [
      {
        id: "e-in",
        from: { node: "src-f", port: "out" },
        to: { node: "flt-1", port: "in" },
      },
      {
        id: "e-true",
        from: { node: "flt-1", port: "true" },
        to: { node: "out-f", port: "in" },
      },
    ];
    expect(
      lastRunSeedRequests([src, flt, out], edges, ["out-f"]),
    ).toEqual(
      expect.arrayContaining([
        { node: "flt-1", port: "true" },
        { node: "flt-1", port: "false" },
      ]),
    );
  });

  it("connectorMayPeek: a fetched connector is peekable, an unfetched one is not", () => {
    // Regression: a fetched SQL Server node was a dead end -- the fetch's own
    // result patch invalidated its preview, the drawer refused to peek
    // ("No cached results -- use Run all"), and Run all skips connectors too,
    // so freshly fetched rows appeared and then vanished unrecoverably.
    expect(
      connectorMayPeek({ type: "sqlserver", config: { table: "__nbsql_abc" } }),
    ).toBe(true);
    expect(connectorMayPeek({ type: "sqlserver", config: { table: "" } })).toBe(
      false,
    );
    expect(connectorMayPeek({ type: "sqlserver", config: {} })).toBe(false);
    expect(connectorMayPeek({ type: "sqlserver", config: null })).toBe(false);
    // whitespace-only table is not a materialised table
    expect(
      connectorMayPeek({ type: "sqlserver", config: { table: "   " } }),
    ).toBe(false);
    // the other connectors behave the same way
    for (const t of ["apinode", "sharepoint", "webscrape"]) {
      expect(connectorMayPeek({ type: t, config: { table: "t" } })).toBe(true);
      expect(connectorMayPeek({ type: t, config: {} })).toBe(false);
    }
    // non-connectors are never routed through this gate
    expect(connectorMayPeek({ type: "filter", config: { table: "t" } })).toBe(
      false,
    );
    expect(connectorMayPeek({ type: "input", config: { table: "t" } })).toBe(
      false,
    );
  });

  it("isSemanticConfigPatch ignores cosmetic keys and catches execution edits", () => {
    const cfg = { label: "A", condition: "x > 1", collapsed: false };
    expect(isSemanticConfigPatch(cfg, { label: "B" })).toBe(false);
    expect(isSemanticConfigPatch(cfg, { collapsed: true })).toBe(false);
    expect(isSemanticConfigPatch(cfg, { condition: "x > 2" })).toBe(true);
    expect(isSemanticConfigPatch(cfg, { disabled: true })).toBe(true);
    expect(descendantNodeIds(
      [
        {
          id: "e1",
          from: { node: "a", port: "out" },
          to: { node: "b", port: "in" },
        },
        {
          id: "e2",
          from: { node: "b", port: "out" },
          to: { node: "c", port: "in" },
        },
      ],
      ["a"],
    )).toEqual(new Set(["a", "b", "c"]));
  });

  it("semantic config edit invalidates downstream last-run cache (not cosmetics)", async () => {
    // Code must drop stale "(cached)" rows after an upstream Select edit;
    // renaming a label must not wipe seeds.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [["term"]],
      total_rows: 1,
    } as any);
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "src",
          port: "out",
          columns: ["id"],
          rows: [["a"]],
          total_rows: 1,
        },
        {
          node: "sel",
          port: "out",
          columns: ["id"],
          rows: [["b"]],
          total_rows: 1,
        },
        {
          node: "down",
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

    const src: NbNode = {
      id: "src",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "Src", table: "t" },
    };
    const sel: NbNode = {
      id: "sel",
      type: "select",
      x: 120,
      y: 0,
      config: { label: "Sel", fields: [{ name: "id", keep: true }] },
    };
    const down: NbNode = {
      id: "down",
      type: "select",
      x: 240,
      y: 0,
      config: { label: "Down", fields: [{ name: "id", keep: true }] },
    };
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "src", port: "out" },
        to: { node: "sel", port: "in" },
      },
      {
        id: "e2",
        from: { node: "sel", port: "out" },
        to: { node: "down", port: "in" },
      },
    ];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [src, sel, down], edges },
    };
    const patch = vi.fn((id: string, config: Record<string, unknown>) => {
      liveRef.current = {
        ...liveRef.current,
        nodes: liveRef.current.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, ...config } } : n,
        ),
      };
    });
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-inv",
        nodes: [src, sel, down],
        edges,
        liveRef,
        graphSig: "g1",
        dataEpoch: 1,
        graphForApi: () => liveRef.current,
        graphForRun: () => liveRef.current,
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch,
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
    expect(runBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.doPreview(down, "out", "Down · out");
    });
    expect(result.current.status.text).toMatch(/cached/i);
    expect(run).toHaveBeenCalledTimes(1); // terminal only

    // Cosmetic label: seeds must survive.
    await act(async () => {
      result.current.patchNode("sel", { label: "Sel renamed" });
    });
    await act(async () => {
      await result.current.doPreview(down, "out", "Down · out");
    });
    expect(result.current.status.text).toMatch(/cached/i);
    expect(run).toHaveBeenCalledTimes(1);

    // Semantic field edit: drop sel + down; Select stays cache-only on miss.
    await act(async () => {
      result.current.patchNode("sel", {
        fields: [{ name: "id", keep: true, rename: "idx" }],
      });
    });
    await act(async () => {
      await result.current.doPreview(down, "out", "Down · out");
    });
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [],
        total: 0,
        sourceNodeId: "down",
      }),
    );
    expect(result.current.status.text).toMatch(/No cached results/i);
    // Still no re-execute for transform miss.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rewiring invalidates the target downstream last-run cache", async () => {
    // Keep a single leaf (b) so Run all uses nodeflowRun + seed batch.
    // An unused Input would also be a leaf and force the multi-leaf batch path.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [["leaf"]],
      total_rows: 1,
    } as any);
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "a",
          port: "out",
          columns: ["id"],
          rows: [["a"]],
          total_rows: 1,
        },
        {
          node: "b",
          port: "out",
          columns: ["id"],
          rows: [["b"]],
          total_rows: 1,
        },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    const a: NbNode = {
      id: "a",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "A", table: "t1" },
    };
    const b: NbNode = {
      id: "b",
      type: "select",
      x: 160,
      y: 0,
      config: { label: "B", fields: [] },
    };
    const c: NbNode = {
      id: "c",
      type: "input",
      x: 0,
      y: 80,
      config: { label: "C", table: "t2" },
    };
    const edges0: NbEdge[] = [
      {
        id: "e-ab",
        from: { node: "a", port: "out" },
        to: { node: "b", port: "in" },
      },
    ];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [a, b], edges: edges0 },
    };
    const { result, rerender } = renderHook(
      ({ nodes, edges }) =>
        useNodeFlowExecutionController({
          activeTabId: "tab-wire",
          nodes,
          edges,
          liveRef,
          graphSig: "gw",
          dataEpoch: 1,
          graphForApi: () => ({ nodes, edges }),
          graphForRun: () => ({ nodes, edges }),
          childCtx: () => null,
          partialGroupGraph: () => ({ nodes: [], edges: [] }),
          patch: vi.fn(),
          setNodes: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          onToast: vi.fn(),
          fireRipple: vi.fn(),
        }),
      { initialProps: { nodes: [a, b], edges: edges0 } },
    );

    await act(async () => {
      await result.current.runAll();
    });
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.doPreview(b, "out", "B · out");
    });
    expect(result.current.status.text).toMatch(/cached/i);

    const edges1: NbEdge[] = [
      {
        id: "e-cb",
        from: { node: "c", port: "out" },
        to: { node: "b", port: "in" },
      },
    ];
    liveRef.current = { nodes: [a, b, c], edges: edges1 };
    await act(async () => {
      rerender({ nodes: [a, b, c], edges: edges1 });
    });

    await act(async () => {
      await result.current.doPreview(b, "out", "B · out");
    });
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [],
        total: 0,
        sourceNodeId: "b",
      }),
    );
    expect(result.current.status.text).toMatch(/No cached results/i);
    // Transform miss stays cache-only (no peek re-run).
    expect(run).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it("Input Preview on cache miss runs preview-limited and shows rows", async () => {
    // Code was wrong for load/source UX: cache-only doPreview opened an empty
    // drawer ("No cached results — use Run all") even though Input is a
    // zero-upstream table peek. Prefer a preview-limited nodeflowRun.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[7]],
      total_rows: 1,
      preview_limited: false,
    } as any);
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
        dataEpoch: 1,
        graphForApi: () => ({ nodes: [source], edges: [] }),
        graphForRun: () => ({ nodes: [source], edges: [] }),
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
      await result.current.doPreview(source, "out", "Source · output");
    });

    expect(batch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    // nodeflowRun(graph, node, port, queryId, signal, preview, previewLimit)
    expect(run.mock.calls[0][1]).toBe("source-a");
    expect(run.mock.calls[0][2]).toBe("out");
    expect(run.mock.calls[0][5]).toBe(true);
    expect(run.mock.calls[0][6]).toBe(200);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Source · output",
        columns: ["id"],
        rows: [[7]],
        total: 1,
        sourceNodeId: "source-a",
        sourcePort: "out",
      }),
    );
    expect(result.current.status.text).toMatch(/preview/i);

    // Second click is cache-only — no further execute.
    await act(async () => {
      await result.current.doPreview(source, "out", "Source · output");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.status.text).toMatch(/cached/i);
  });

  it("SQL Preview on cache miss runs preview-limited and shows rows", async () => {
    // Former sqljoin was cache-only (not in NODEFLOW_SOURCE_TYPES), so Preview
    // opened empty until Run all. Unified SQL peeks like other sources.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id", "name"],
      rows: [[1, "Alice"]],
      total_rows: 1,
      preview_limited: true,
    } as any);
    const batch = vi.spyOn(api, "nodeflowRunBatch");
    const sqlNode: NbNode = {
      id: "sql-1",
      type: "sql",
      x: 0,
      y: 0,
      config: {
        label: "sql",
        sql: "SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id",
      },
    };
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [sqlNode], edges: [] },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-a",
        nodes: [sqlNode],
        edges: [],
        liveRef,
        graphSig: "graph-sql",
        dataEpoch: 1,
        graphForApi: () => ({ nodes: [sqlNode], edges: [] }),
        graphForRun: () => ({ nodes: [sqlNode], edges: [] }),
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
      await result.current.doPreview(sqlNode, "out", "sql · output");
    });

    expect(batch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe("sql-1");
    expect(run.mock.calls[0][2]).toBe("out");
    expect(run.mock.calls[0][5]).toBe(true);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "sql · output",
        columns: ["id", "name"],
        rows: [[1, "Alice"]],
        total: 1,
        sourceNodeId: "sql-1",
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

  it("keeps passing upstream previews when a downstream Formula fails", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      error: 'Formula node "Formula" failed: bad expression',
      node: "formula",
    } as any);
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "orders",
          port: "out",
          columns: ["order_id", "amount"],
          rows: [[101, 25]],
          total_rows: 1,
        },
        {
          node: "select",
          port: "out",
          columns: ["order_id", "amount"],
          rows: [[101, 25]],
          total_rows: 1,
        },
        {
          node: "formula",
          port: "out",
          error: 'Formula node "Formula" failed: bad expression',
          error_node: "formula",
        },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    const orders: NbNode = {
      id: "orders",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "Demo orders", table: "demo_orders" },
    };
    const select: NbNode = {
      id: "select",
      type: "select",
      x: 120,
      y: 0,
      config: {
        label: "Select",
        fields: [
          { name: "order_id", keep: true },
          { name: "amount", keep: true },
        ],
      },
    };
    const formula: NbNode = {
      id: "formula",
      type: "formula",
      x: 240,
      y: 0,
      config: { label: "Formula", name: "broken", expr: "missing + 1" },
    };
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "orders", port: "out" },
        to: { node: "select", port: "in" },
      },
      {
        id: "e2",
        from: { node: "select", port: "out" },
        to: { node: "formula", port: "in" },
      },
    ];
    const nodes = [orders, select, formula];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes, edges },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-failed-formula",
        nodes,
        edges,
        liveRef,
        graphSig: "graph-failed-formula",
        dataEpoch: 1,
        graphForApi: () => ({ nodes, edges }),
        graphForRun: () => ({ nodes, edges }),
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
    expect(runBatch.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        { node: "orders", port: "out" },
        { node: "select", port: "out" },
        { node: "formula", port: "out" },
      ]),
    );

    for (const passing of [orders, select]) {
      await act(async () => {
        await result.current.doPreview(
          passing,
          "out",
          `${passing.config.label} · out`,
        );
      });
      expect(result.current.preview).toEqual(
        expect.objectContaining({
          kind: "table",
          rows: [[101, 25]],
          sourceNodeId: passing.id,
        }),
      );
      expect(result.current.status.text).toMatch(/cached/i);
    }
    // Clicking either passing node reused the partial last-run seed; it did
    // not execute the failed Formula pipeline again.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("clears last-run cache on dataEpoch bump so Select preview does not re-run", async () => {
    // Select stays cache-only after epoch wipe. Sources / Join / Filter may
    // preview-execute on miss (separate tests).
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["id"],
      rows: [[1]],
      total_rows: 1,
    } as any);
    vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "sel-ep",
          port: "out",
          columns: ["id"],
          rows: [[1]],
          total_rows: 1,
        },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    const sel: NbNode = {
      id: "sel-ep",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "Select",
        fields: [{ name: "id", keep: true }],
      },
    };
    const src = node("src-ep");
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "src-ep", port: "out" },
        to: { node: "sel-ep", port: "in" },
      },
    ];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [src, sel], edges },
    };
    const { result, rerender } = renderHook(
      ({ epoch }) =>
        useNodeFlowExecutionController({
          activeTabId: "tab-a",
          nodes: [src, sel],
          edges,
          liveRef,
          graphSig: "graph-a",
          dataEpoch: epoch,
          graphForApi: () => ({ nodes: [src, sel], edges }),
          graphForRun: () => ({ nodes: [src, sel], edges }),
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
    expect(run).toHaveBeenCalled();
    const afterRun = run.mock.calls.length;

    rerender({ epoch: 2 });
    expect(result.current.preview).toBeNull();

    await act(async () => {
      await result.current.doPreview(sel, "out", "Select · output");
    });
    // File-change epoch cleared cache; Select click shows empty, no execute.
    expect(run).toHaveBeenCalledTimes(afterRun);
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        rows: [],
        total: 0,
        sourcePort: "out",
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

describe("leafRunPort / Filter leaf Run all", () => {
  it("maps Filter to true (not out) so backend never sees Unknown filter output", () => {
    expect(leafRunPort("filter")).toBe("true");
    expect(leafRunPort("select")).toBe("out");
    expect(leafRunPort("input")).toBe("out");
    // Join keeps legacy out even though palette ports are named.
    expect(leafRunPort("join")).toBe("out");
  });

  it("leafRunPort picks a declared output for every PORTS type", () => {
    // Contract: Run-all never invents a port the backend will reject the way
    // Filter used to reject "out". Join keeps the intentional legacy "out".
    for (const type of Object.keys(PORTS) as (keyof typeof PORTS)[]) {
      const outs = PORTS[type].outputs;
      const port = leafRunPort(type);
      if (!outs.length) {
        expect(port).toBe("out");
        continue;
      }
      if (type === "join") {
        expect(port).toBe("out");
        continue;
      }
      expect(outs).toContain(port);
    }
    expect(leafRunPort("usernode")).toBe("out1");
    expect(leafRunPort("apinode")).toBe("out");
  });

  it("Run all on Input→Filter leaf requests port true and seeds True preview", async () => {
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["score"],
      rows: [[80]],
      total_rows: 1,
    } as any);
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        {
          node: "src",
          port: "out",
          columns: ["score"],
          rows: [[80], [30]],
          total_rows: 2,
        },
        {
          node: "flt",
          port: "true",
          columns: ["score"],
          rows: [[80]],
          total_rows: 1,
        },
        {
          node: "flt",
          port: "false",
          columns: ["score"],
          rows: [[30]],
          total_rows: 1,
        },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    const src: NbNode = {
      id: "src",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "Source", table: "t" },
    };
    const flt: NbNode = {
      id: "flt",
      type: "filter",
      x: 160,
      y: 0,
      config: { label: "Filter", condition: "score > 50", filterMode: "custom" },
    };
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "src", port: "out" },
        to: { node: "flt", port: "in" },
      },
    ];
    // Unwired Filter leaf: seed both True and False after a successful run.
    expect(lastRunSeedRequests([src, flt], edges, ["flt"])).toEqual(
      expect.arrayContaining([
        { node: "src", port: "out" },
        { node: "flt", port: "true" },
        { node: "flt", port: "false" },
      ]),
    );

    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes: [src, flt], edges },
    };
    const setNodeErrors = vi.fn();
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-filter",
        nodes: [src, flt],
        edges,
        liveRef,
        graphSig: "graph-filter",
        dataEpoch: 1,
        graphForApi: () => ({ nodes: [src, flt], edges }),
        graphForRun: () => ({ nodes: [src, flt], edges }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors,
        setNodeWarnings: vi.fn(),
        onToast: vi.fn(),
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.runAll();
    });

    // Single Filter leaf → runLeaf (not batch of ≥2 leaves).
    expect(run).toHaveBeenCalled();
    const leafCall = run.mock.calls.find(
      (c) => c[1] === "flt" || (typeof c[1] === "string" && c[1].includes("flt")),
    );
    // nodeflowRun(graph, node, port, ...)
    expect(leafCall?.[2]).toBe("true");
    expect(leafCall?.[2]).not.toBe("out");

    await act(async () => {
      await result.current.doPreview(flt, "true", "Filter · True");
    });
    expect(result.current.preview).toEqual(
      expect.objectContaining({
        kind: "table",
        columns: ["score"],
        rows: [[80]],
        total: 1,
        sourcePort: "true",
      }),
    );
    // Must not surface the historical Unknown filter output error.
    const errPayloads = setNodeErrors.mock.calls.flatMap((c) => c[0]);
    const errTexts = JSON.stringify(errPayloads);
    expect(errTexts).not.toMatch(/Unknown filter output/i);
  });

  it("Run-all batch of two Filter leaves requests port true (not out)", async () => {
    const runBatch = vi.spyOn(api, "nodeflowRunBatch").mockImplementation(
      async (_graph, requests: { node: string; port?: string }[]) => {
        // Terminal batch first, then last-run seed batch.
        return {
          ok: true,
          results: requests.map((q) => ({
            node: q.node,
            port: q.port || "out",
            columns: ["x"],
            rows: [[1]],
            total_rows: 1,
          })),
        } as any;
      },
    );
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    const mk = (id: string): NbNode => ({
      id,
      type: "filter",
      x: 0,
      y: 0,
      config: { label: id, condition: "x > 0", filterMode: "custom" },
    });
    // Two independent Input→Filter chains so Run all uses runLeafBatch (≥2 leaves).
    const inA: NbNode = {
      id: "in-a",
      type: "input",
      x: 0,
      y: 0,
      config: { label: "A", table: "t" },
    };
    const inB: NbNode = {
      id: "in-b",
      type: "input",
      x: 0,
      y: 80,
      config: { label: "B", table: "t" },
    };
    const fa = mk("fa");
    const fb = mk("fb");
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-a", port: "out" },
        to: { node: "fa", port: "in" },
      },
      {
        id: "e2",
        from: { node: "in-b", port: "out" },
        to: { node: "fb", port: "in" },
      },
    ];
    const nodes = [inA, inB, fa, fb];
    const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
      current: { nodes, edges },
    };
    const { result } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-batch-filter",
        nodes,
        edges,
        liveRef,
        graphSig: "graph-batch-filter",
        dataEpoch: 1,
        graphForApi: () => ({ nodes, edges }),
        graphForRun: () => ({ nodes, edges }),
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

    expect(runBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
    const terminalReqs = runBatch.mock.calls[0][1] as {
      node: string;
      port?: string;
    }[];
    expect(terminalReqs).toEqual(
      expect.arrayContaining([
        { node: "fa", port: "true" },
        { node: "fb", port: "true" },
      ]),
    );
    expect(terminalReqs.every((q) => q.port !== "out" || q.node.startsWith("in"))).toBe(
      true,
    );
    // Filter terminals must never request "out".
    expect(terminalReqs.filter((q) => q.node === "fa" || q.node === "fb")).toEqual([
      { node: "fa", port: "true" },
      { node: "fb", port: "true" },
    ]);
  });

  it("Run all treats lone shred and filebrowser as runnable sources", async () => {
    // Code was wrong: SOURCES omitted shred/filebrowser, so a lone source with
    // no outbound wire showed "Nothing to run" even though backend can execute
    // port "out". Connectors stay Fetch-only and are not covered here.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["x"],
      rows: [[1]],
      total_rows: 1,
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    const toast = vi.fn();

    for (const type of ["shred", "filebrowser"] as const) {
      run.mockClear();
      toast.mockClear();
      const n: NbNode = {
        id: `lone-${type}`,
        type,
        x: 0,
        y: 0,
        config:
          type === "shred"
            ? { label: "Shred", table: "big", base: "built" }
            : { label: "Files", pattern: "*.csv" },
      };
      const liveRef: React.MutableRefObject<{
        nodes: NbNode[];
        edges: NbEdge[];
      }> = { current: { nodes: [n], edges: [] } };
      const { result } = renderHook(() =>
        useNodeFlowExecutionController({
          activeTabId: `tab-${type}`,
          nodes: [n],
          edges: [],
          liveRef,
          graphSig: `graph-${type}`,
          dataEpoch: 1,
          graphForApi: () => ({ nodes: [n], edges: [] }),
          graphForRun: () => ({ nodes: [n], edges: [] }),
          childCtx: () => null,
          partialGroupGraph: () => ({ nodes: [], edges: [] }),
          patch: vi.fn(),
          setNodes: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          onToast: toast,
          fireRipple: vi.fn(),
        }),
      );

      await act(async () => {
        await result.current.runAll();
      });

      expect(toast).not.toHaveBeenCalledWith(
        "warn",
        "Nothing to run",
        expect.anything(),
      );
      expect(run).toHaveBeenCalled();
      expect(run.mock.calls[0][1]).toBe(n.id);
      expect(run.mock.calls[0][2]).toBe("out");
    }
  });

  it("Run all treats a FETCHED connector as a runnable leaf", async () => {
    // A fetched SQL Server node (config.table stamped) runs as a Run-all
    // leaf -- the backend re-fetches on run, so the result is current data.
    // An UNFETCHED connector still shows "Nothing to run" (press Fetch).
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["x"],
      rows: [[1]],
      total_rows: 1,
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);

    for (const fetched of [true, false] as const) {
      run.mockClear();
      const toast = vi.fn();
      const n: NbNode = {
        id: "lone-sql",
        type: "sqlserver",
        x: 0,
        y: 0,
        config: fetched
          ? { label: "SQL", table: "__nbsql_abc", query: "SELECT 1" }
          : { label: "SQL", query: "SELECT 1" },
      };
      const liveRef: React.MutableRefObject<{
        nodes: NbNode[];
        edges: NbEdge[];
      }> = { current: { nodes: [n], edges: [] } };
      const { result, unmount } = renderHook(() =>
        useNodeFlowExecutionController({
          activeTabId: `tab-sql-${fetched}`,
          nodes: [n],
          edges: [],
          liveRef,
          graphSig: `graph-sql-${fetched}`,
          dataEpoch: 1,
          graphForApi: () => ({ nodes: [n], edges: [] }),
          graphForRun: () => ({ nodes: [n], edges: [] }),
          childCtx: () => null,
          partialGroupGraph: () => ({ nodes: [], edges: [] }),
          patch: vi.fn(),
          setNodes: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          onToast: toast,
          fireRipple: vi.fn(),
        }),
      );

      await act(async () => {
        await result.current.runAll();
      });

      if (fetched) {
        expect(toast).not.toHaveBeenCalledWith(
          "warn",
          "Nothing to run",
          expect.anything(),
        );
        expect(run).toHaveBeenCalled();
        expect(run.mock.calls[0][1]).toBe(n.id);
        expect(run.mock.calls[0][2]).toBe("out");
      } else {
        expect(toast).toHaveBeenCalledWith(
          "warn",
          "Nothing to run",
          expect.anything(),
        );
      }
      unmount();
    }
  });

  it("Run all runs a flow that ENDS in a chart (upstream chain runs)", async () => {
    // sqlserver(fetched) -> summarize -> chart: the chart is a valid leaves
    // terminal (backend passthrough materialises the chain), so Run all must
    // not say "Nothing to run", and it runs the chart's "out" port.
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["category", "total"],
      rows: [["a", 4]],
      total_rows: 1,
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    const nodes: NbNode[] = [
      { id: "src", type: "sqlserver", x: 0, y: 0,
        config: { query: "SELECT 1", table: "__nbsql_x" } },
      { id: "sum", type: "summarize", x: 0, y: 0,
        config: { group_by: ["category"], aggs: [] } },
      { id: "ch", type: "chart", x: 0, y: 0, config: {} },
    ];
    const edges: NbEdge[] = [
      { id: "e1",
        from: { node: "src", port: "out" },
        to: { node: "sum", port: "in" } },
      { id: "e2",
        from: { node: "sum", port: "out" },
        to: { node: "ch", port: "in" } },
    ];
    const liveRef: React.MutableRefObject<{
      nodes: NbNode[];
      edges: NbEdge[];
    }> = { current: { nodes, edges } };
    const toast = vi.fn();
    const { result, unmount } = renderHook(() =>
      useNodeFlowExecutionController({
        activeTabId: "tab-chartflow",
        nodes,
        edges,
        liveRef,
        graphSig: "graph-chartflow",
        dataEpoch: 1,
        graphForApi: () => ({ nodes, edges }),
        graphForRun: () => ({ nodes, edges }),
        childCtx: () => null,
        partialGroupGraph: () => ({ nodes: [], edges: [] }),
        patch: vi.fn(),
        setNodes: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        onToast: toast,
        fireRipple: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.runAll();
    });

    expect(toast).not.toHaveBeenCalledWith(
      "warn",
      "Nothing to run",
      expect.anything(),
    );
    expect(run).toHaveBeenCalled();
    const calledNodes = run.mock.calls.map((c) => c[1]);
    expect(calledNodes).toContain("ch");
    unmount();
  });

  it("run seeds survive the catalog epoch bump after a connector fetch", async () => {
    // A sqlserver fetch bumps the backend data epoch mid-run (result carries
    // data_epoch 2 while the catalog prop still says 1). Seeds must key with
    // the RUN's epoch so the later poll bump (prop -> 2) does not prune them
    // ("No cached results" on every node after Run all).
    const run = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["v"],
      rows: [[1]],
      total_rows: 1,
      data_epoch: 2,
    } as any);
    const batch = vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
      ok: true,
      results: [
        { node: "src", port: "out", columns: ["v"], rows: [[1]],
          total_rows: 1, data_epoch: 2 },
        { node: "sel", port: "out", columns: ["v"], rows: [[1]],
          total_rows: 1, data_epoch: 2 },
      ],
    } as any);
    vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
      parallel_nodeflows: false,
    } as any);
    const nodes: NbNode[] = [
      { id: "src", type: "sqlserver", x: 0, y: 0,
        config: { query: "SELECT 1", table: "__nbsql_x" } },
      { id: "sel", type: "select", x: 0, y: 0,
        config: { fields: [{ name: "v", keep: true }] } },
    ];
    const edges: NbEdge[] = [
      { id: "e1",
        from: { node: "src", port: "out" },
        to: { node: "sel", port: "in" } },
    ];
    const liveRef: React.MutableRefObject<{
      nodes: NbNode[];
      edges: NbEdge[];
    }> = { current: { nodes, edges } };
    const toast = vi.fn();
    const hookProps = (epoch: number) => ({
      activeTabId: "tab-epochseed",
      nodes,
      edges,
      liveRef,
      graphSig: "graph-epochseed",
      dataEpoch: epoch,
      graphForApi: () => ({ nodes, edges }),
      graphForRun: () => ({ nodes, edges }),
      childCtx: () => null,
      partialGroupGraph: () => ({ nodes: [], edges: [] }),
      patch: vi.fn(),
      setNodes: vi.fn(),
      setNodeErrors: vi.fn(),
      setNodeWarnings: vi.fn(),
      onToast: toast,
      fireRipple: vi.fn(),
    });
    const { result, rerender, unmount } = renderHook(
      (props: { epoch: number }) =>
        useNodeFlowExecutionController(hookProps(props.epoch)),
      { initialProps: { epoch: 1 } },
    );

    await act(async () => {
      await result.current.runAll();
    });

    const keyedWithRunEpoch = [...result.current.previewCache.current.keys()]
      .filter((k) => k.split("::")[1] === "2");
    expect(keyedWithRunEpoch.length).toBeGreaterThan(0);

    // the catalog poll catches up (prop -> 2): seeds must NOT be pruned
    act(() => {
      rerender({ epoch: 2 });
    });
    const survivors = [...result.current.previewCache.current.keys()].filter(
      (k) => k.split("::")[1] === "2",
    );
    expect(survivors.length).toBe(keyedWithRunEpoch.length);
    unmount();
  });
});
