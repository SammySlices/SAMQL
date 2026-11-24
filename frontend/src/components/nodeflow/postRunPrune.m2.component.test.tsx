import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { clearRunAllParallelHint } from "../../lib/runAllConcurrency";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowExecutionController } from "./useNodeFlowExecutionController";

// M-2: after a run, columns are probed from a snapshot of the graph and the
// answer is applied to the CURRENT nodes. A field the user added while the
// probe was in flight was missing from the answer, so it was pruned.

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const src: NbNode = { id: "src", type: "input", x: 0, y: 0, config: { label: "src", table: "source" } };
const sel = (fields: string[]): NbNode => ({
  id: "sel",
  type: "select",
  x: 0,
  y: 0,
  config: { label: "sel", fields: fields.map((name) => ({ name, keep: true })) },
});
const edges: NbEdge[] = [
  { id: "e1", from: { node: "src", port: "out" }, to: { node: "sel", port: "in" } },
];

beforeEach(() => {
  window.localStorage.clear();
  clearRunAllParallelHint();
  vi.spyOn(api, "flowCacheInfo").mockResolvedValue({
    parallel_nodeflows: true,
  } as Awaited<ReturnType<typeof api.flowCacheInfo>>);
  vi.spyOn(api, "nodeflowRun").mockResolvedValue({
    columns: ["a"],
    rows: [["1"]],
    total_rows: 1,
  } as unknown as Awaited<ReturnType<typeof api.nodeflowRun>>);
  vi.spyOn(api, "nodeflowRunBatch").mockResolvedValue({
    results: [],
  } as unknown as Awaited<ReturnType<typeof api.nodeflowRunBatch>>);
  vi.spyOn(api, "cancelAll").mockResolvedValue({} as never);
  vi.spyOn(api, "cancelQuery").mockResolvedValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const nodes = [src, sel(["a"])];
  const liveRef: React.MutableRefObject<{ nodes: NbNode[]; edges: NbEdge[] }> = {
    current: { nodes, edges },
  };
  const setNodes = vi.fn();
  const hook = renderHook(() =>
    useNodeFlowExecutionController({
      activeTabId: "tab-a",
      nodes,
      edges,
      liveRef,
      graphSig: "graph-a",
      graphForApi: () => ({ nodes: liveRef.current.nodes, edges }),
      graphForRun: () => ({ nodes: liveRef.current.nodes, edges }),
      childCtx: () => null,
      partialGroupGraph: () => ({ nodes, edges }),
      patch: vi.fn(),
      setNodes,
      setNodeErrors: vi.fn(),
      setNodeWarnings: vi.fn(),
      onToast: vi.fn(),
      fireRipple: vi.fn(),
    }),
  );
  // Apply every setNodes updater to the live graph, as the editor does.
  setNodes.mockImplementation((u: unknown) => {
    liveRef.current = {
      ...liveRef.current,
      nodes: typeof u === "function" ? (u as (p: NbNode[]) => NbNode[])(liveRef.current.nodes) : (u as NbNode[]),
    };
  });
  return { hook, liveRef };
}

describe("post-run column prune keeps config edited mid-probe (M-2)", () => {
  it("a field added while the probe runs survives", async () => {
    const probe = deferred<any>();
    // The first probe answers late, from before the edit; any later probe
    // (Run all prunes per leaf and again per batch) sees the new column.
    let calls = 0;
    vi.spyOn(api, "nodeflowColumnsBatch").mockImplementation((() =>
      ++calls === 1
        ? probe.promise
        : Promise.resolve({ results: [{ columns: ["a", "new_col"] }] })) as never);
    const { hook, liveRef } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.runAll();
    });
    await vi.waitFor(() => expect(api.nodeflowColumnsBatch).toHaveBeenCalled());
    // The user adds new_col to the Select while the probe is in flight.
    liveRef.current = { ...liveRef.current, nodes: [src, sel(["a", "new_col"])] };
    probe.resolve({ results: [{ columns: ["a"] }] });
    await act(async () => {
      await pending;
    });
    const s = liveRef.current.nodes.find((n) => n.id === "sel")!;
    expect((s.config.fields as { name: string }[]).map((f) => f.name)).toEqual(["a", "new_col"]);
  });

  it("an unchanged node is still pruned", async () => {
    vi.spyOn(api, "nodeflowColumnsBatch").mockResolvedValue({
      results: [{ columns: ["a"] }],
    } as never);
    const { hook, liveRef } = setup();
    liveRef.current = { ...liveRef.current, nodes: [src, sel(["a", "gone"])] };
    await act(async () => {
      await hook.result.current.runAll();
    });
    const s = liveRef.current.nodes.find((n) => n.id === "sel")!;
    expect((s.config.fields as { name: string }[]).map((f) => f.name)).toEqual(["a"]);
  });
});
