import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { clearRunAllParallelHint } from "../../lib/runAllConcurrency";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";

// H-7: Stop must halt the WHOLE Run all batch. Before the fix the batch only
// checked cancelRequested, which the 4 s cancel-recovery timer resets; when a
// wedged write finally returned, the worker started the next Write node.
// The Write/Export/Iterator/While fetches also carried no AbortSignal, so
// Stop could not abort them on the client.

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const node = (
  id: string,
  type: NbNode["type"],
  config: Record<string, unknown> = {},
): NbNode => ({ id, type, x: 10, y: 10, config: { label: id, ...config } });

const wire = (from: string, to: string): NbEdge => ({
  id: `${from}->${to}`,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const fourWrites = () => {
  const nodes = [node("src", "input", { table: "source" })];
  const edges: NbEdge[] = [];
  for (const i of [1, 2, 3, 4]) {
    nodes.push(node(`w${i}`, "write", { name: `t${i}`, dest: "duckdb", mode: "overwrite" }));
    edges.push(wire("src", `w${i}`));
  }
  return { nodes, edges };
};

function useHarness(nodes: NbNode[], edges: NbEdge[], toast = vi.fn()) {
  const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
    current: { nodes, edges },
  };
  return useNodeFlowExecutionController({
    activeTabId: "tab-a",
    nodes,
    edges,
    liveRef,
    graphSig: "graph-a",
    graphForApi: () => ({ nodes, edges }),
    graphForRun: () => ({ nodes, edges }),
    childCtx: () => null,
    partialGroupGraph: () => ({ nodes, edges }),
    patch: vi.fn(),
    setNodes: vi.fn(),
    setNodeErrors: vi.fn(),
    setNodeWarnings: vi.fn(),
    onToast: toast,
    fireRipple: vi.fn(),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearRunAllParallelHint();
  // parallel NodeFlow workers on -> Run all pool of 1, so the writes run
  // strictly one after another.
  vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
    parallel_nodeflows: true,
  } as Awaited<ReturnType<typeof api.flowCacheInfo>>);
  vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
    results: [],
  } as unknown as Awaited<ReturnType<typeof api.nodeflowRunBatch>>);
  vi.spyOn(api, "nodeflowColumnsBatch").mockResolvedValue({
    results: [],
  } as unknown as Awaited<ReturnType<typeof api.nodeflowColumnsBatch>>);
  vi.spyOn(api, "cancelAll").mockResolvedValue({} as never);
  vi.spyOn(api, "cancelQuery").mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Stop halts the whole Run all batch (H-7)", () => {
  it("no further Write starts after Stop, even once cancel recovery has run", async () => {
    vi.useFakeTimers();
    const first = deferred<any>();
    const signals: (AbortSignal | undefined)[] = [];
    const writeSpy = vi
      .spyOn(api, "nodeflowToTable")
      .mockImplementation(((...args: unknown[]) => {
        signals.push(args[4] as AbortSignal | undefined);
        return writeSpy.mock.calls.length === 1
          ? first.promise
          : Promise.resolve({ ok: true, table: "t", engine: "duckdb", rows: 1 });
      }) as typeof api.nodeflowToTable);
    const toast = vi.fn();
    const { nodes, edges } = fourWrites();
    const { result } = renderHook(() => useHarness(nodes, edges, toast));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runAll();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.cancelRun();
    });
    // The in-flight write's own fetch is aborted by Stop.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(true);

    // The wedged backend does not answer within the grace period, so the UI
    // recovers itself...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    // ...and only then does the first write's POST come back.
    first.resolve({ ok: true, table: "t1", engine: "duckdb", rows: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await pending;
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls.some((c) => c[1] === "Run all cancelled")).toBe(true);
  });

  it("a stopped Iterator or While reports cancelled to the batch", async () => {
    for (const kind of ["iterator", "while"] as const) {
      const spy =
        kind === "iterator"
          ? vi.spyOn(api, "iteratorRun")
          : vi.spyOn(api, "whileRun");
      const signals: (AbortSignal | undefined)[] = [];
      spy.mockImplementation(((_body: unknown, signal?: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve({ cancelled: true });
      }) as never);
      const toast = vi.fn();
      const nodes = [
        node("src", "input", { table: "source" }),
        node("loop", kind, { table: "acc", var: "v", values: "1,2" }),
      ];
      const edges = [wire("src", "loop")];
      const { result, unmount } = renderHook(() => useHarness(nodes, edges, toast));
      await act(async () => {
        await result.current.runAll();
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(toast.mock.calls.some((c) => c[1] === "Run all cancelled")).toBe(true);
      unmount();
    }
  });
});
