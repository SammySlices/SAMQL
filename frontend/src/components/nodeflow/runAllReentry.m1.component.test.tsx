import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { clearRunAllParallelHint } from "../../lib/runAllConcurrency";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";

// M-1: after its terminals finish, Run all still seeds the last-run previews
// over the network. The Run button came back (and Stop disappeared) during
// that step, so a second Run all could start and reset the first batch's
// state while its seed wrote into it.

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

describe("Run all is not re-entrant (M-1)", () => {
  it("stays running through the seed step; a second Run all is a no-op", async () => {
    const write = vi
      .spyOn(api, "nodeflowToTable")
      .mockResolvedValue({ ok: true, table: "t1", engine: "duckdb", rows: 1 });
    const seed = deferred<any>();
    const seedCalls: unknown[][] = [];
    (api.nodeflowRunBatch as any).mockImplementation((...args: unknown[]) => {
      seedCalls.push(args);
      return seed.promise;
    });
    const nodes = [
      node("src", "input", { table: "source" }),
      node("w1", "write", { name: "t1", dest: "duckdb", mode: "overwrite" }),
    ];
    const edges = [wire("src", "w1")];
    const { result } = renderHook(() => useHarness(nodes, edges, vi.fn()));

    let first!: Promise<void>;
    act(() => {
      first = result.current.runAll();
    });
    await act(async () => {
      for (let i = 0; i < 20 && !seedCalls.length; i++) await Promise.resolve();
    });
    // the write finished; the seed is in flight
    expect(write).toHaveBeenCalledTimes(1);
    expect(seedCalls.length).toBe(1);
    // still running, so the UI keeps Stop up and Run disabled
    expect(result.current.running).toBe(true);

    await act(async () => {
      await result.current.runAll();
    });
    expect(write).toHaveBeenCalledTimes(1);

    seed.resolve({ ok: true, results: [] });
    await act(async () => {
      await first;
    });
    expect(result.current.running).toBe(false);
  });
});
