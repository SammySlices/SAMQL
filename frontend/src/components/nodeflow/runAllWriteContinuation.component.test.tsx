import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { clearRunAllParallelHint } from "../../lib/runAllConcurrency";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
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

const node = (
  id: string,
  type: NbNode["type"],
  config: Record<string, unknown> = {},
): NbNode => ({
  id,
  type,
  x: 10,
  y: 10,
  config: { label: id, ...config },
});

const wire = (from: string, fromPort: string, to: string, toPort: string): NbEdge => ({
  id: `${from}.${fromPort}->${to}.${toPort}`,
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

// input → sql (join logic) → write → sql2: the reported dead-end shape. The
// write is the only exporter, so before .698 Run all ran it and stopped —
// sql2 is not an exporter, and leaves mode never activates while a connected
// exporter exists, so the chain wired off the write's out port never ran.
const makeGraph = () => {
  const nodes = [
    node("src", "input", { table: "source" }),
    node("sqlj", "sql", { sql: "SELECT * FROM {{in}}" }),
    node("w", "write", { name: "t_out", dest: "duckdb", mode: "overwrite" }),
    node("sql2", "sql", { sql: "SELECT * FROM {{in}}" }),
  ];
  const edges = [
    wire("src", "out", "sqlj", "in"),
    wire("sqlj", "out", "w", "in"),
    wire("w", "out", "sql2", "in"),
  ];
  return { nodes, edges };
};

function useRunAllHarness(nodes: NbNode[], edges: NbEdge[], toast = vi.fn()) {
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

const flushMicrotasks = () => act(async () => {});

beforeEach(() => {
  window.localStorage.clear();
  clearRunAllParallelHint();
  vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
    parallel_nodeflows: false,
  } as Awaited<ReturnType<typeof api.flowCacheInfo>>);
  vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
    results: [],
  } as unknown as Awaited<ReturnType<typeof api.nodeflowRunBatch>>);
  vi.spyOn(api, "nodeflowColumnsBatch").mockResolvedValue({
    results: [],
  } as unknown as Awaited<ReturnType<typeof api.nodeflowColumnsBatch>>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Run all continuation past a Write node (.698)", () => {
  it("runs the data chain wired off the write's out port, after the write commits", async () => {
    const write = deferred<any>();
    const writeSpy = vi
      .spyOn(api, "nodeflowToTable")
      .mockReturnValue(write.promise as ReturnType<typeof api.nodeflowToTable>);
    const leafSpy = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["a"],
      rows: [[1]],
      total_rows: 1,
    } as unknown as Awaited<ReturnType<typeof api.nodeflowRun>>);
    const toast = vi.fn();
    const { nodes, edges } = makeGraph();
    const { result } = renderHook(() => useRunAllHarness(nodes, edges, toast));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runAll();
    });
    await flushMicrotasks();

    // The write is in flight; the continuation leaf must NOT have started —
    // it may read the written table by name, so ordering is part of the
    // contract, not an implementation detail.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(leafSpy).not.toHaveBeenCalled();

    write.resolve({ ok: true, table: "t_out", engine: "duckdb", rows: 1 });
    await act(async () => {
      await pending;
    });

    // The leaf ran, targeted at the downstream sql node.
    expect(leafSpy).toHaveBeenCalledTimes(1);
    expect(leafSpy.mock.calls[0][1]).toBe("sql2");
    // Both terminals count in the finish toast: "2 ran".
    const finish = toast.mock.calls.find((c) => c[1] === "Run all finished");
    expect(finish).toBeTruthy();
    expect(finish![0]).toBe("ok");
    expect(finish![2]).toContain("2 ran");
  });

  it("skips the continuation leaf when the write fails", async () => {
    vi.spyOn(api, "nodeflowToTable").mockResolvedValue({
      error: "boom",
    } as unknown as Awaited<ReturnType<typeof api.nodeflowToTable>>);
    const leafSpy = vi.spyOn(api, "nodeflowRun").mockResolvedValue({
      columns: ["a"],
      rows: [[1]],
      total_rows: 1,
    } as unknown as Awaited<ReturnType<typeof api.nodeflowRun>>);
    const toast = vi.fn();
    const { nodes, edges } = makeGraph();
    const { result } = renderHook(() => useRunAllHarness(nodes, edges, toast));

    await act(async () => {
      await result.current.runAll();
    });

    // The failed write already reported; running the leaf would only add a
    // second error over missing/stale data.
    expect(leafSpy).not.toHaveBeenCalled();
    const finish = toast.mock.calls.find((c) => c[1] === "Run all finished");
    expect(finish).toBeTruthy();
    expect(finish![0]).toBe("error");
    expect(finish![2]).toContain("1 failed");
  });
});
