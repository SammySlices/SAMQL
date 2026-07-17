import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NbEdge, NbNode, NodeType } from "../../lib/nodeFlowModel";
import { clearNodeflowColsCache } from "../../lib/nodeflowColumnsCache";
import {
  NO_AUTO_PRUNE_STALE_TYPES,
  STALE_REF_NODE_TYPES,
} from "../../lib/staleNodeflowColumnRefs";
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

type PortKind = "in" | "lr" | "multi";

type TypingCase = {
  type: NodeType;
  ports: PortKind;
  /** Clean starting config (valid or empty — no auto-prune needed). */
  base: Record<string, any>;
  /** Sequential user edits that introduce unknown / mid-type identifiers. */
  edits: Record<string, any>[];
  /** Value that must still be present after all edits. */
  expectSurvives: (cfg: Record<string, any>) => unknown;
};

/** Per-type fixtures covering every STALE_REF_NODE_TYPES entry. */
const TYPING_CASES: TypingCase[] = [
  {
    type: "filter",
    ports: "in",
    base: { filterMode: "custom", condition: "" },
    edits: [{ condition: "s" }, { condition: "sc" }, { condition: "score" }],
    expectSurvives: (c) => c.condition,
  },
  {
    type: "formula",
    ports: "in",
    base: { formulas: [{ name: "x", expr: "" }] },
    edits: [
      { formulas: [{ name: "x", expr: "s" }] },
      { formulas: [{ name: "x", expr: "sc" }] },
      { formulas: [{ name: "x", expr: "score" }] },
    ],
    expectSurvives: (c) => c.formulas?.[0]?.expr,
  },
  {
    type: "summarize",
    ports: "in",
    base: { group_by: ["a"], aggs: [{ col: "b", func: "sum" }] },
    edits: [
      { group_by: ["a", "g"] },
      { group_by: ["a", "gone"] },
      { aggs: [{ col: "b", func: "sum" }, { col: "x", func: "count" }] },
    ],
    expectSurvives: (c) => c.group_by,
  },
  {
    type: "sort",
    ports: "in",
    base: { sorts: [{ col: "a", dir: "asc" }] },
    edits: [
      { sorts: [{ col: "a", dir: "asc" }, { col: "g", dir: "desc" }] },
      { sorts: [{ col: "a", dir: "asc" }, { col: "gone", dir: "desc" }] },
    ],
    expectSurvives: (c) => c.sorts,
  },
  {
    type: "unique",
    ports: "in",
    base: { by: ["a"] },
    edits: [{ by: ["a", "g"] }, { by: ["a", "gone"] }],
    expectSurvives: (c) => c.by,
  },
  {
    type: "unpivot",
    ports: "in",
    base: { keep: ["a"], unpivot: ["b"] },
    edits: [{ keep: ["a", "gone"] }, { unpivot: ["b", "x"] }],
    expectSurvives: (c) => ({ keep: c.keep, unpivot: c.unpivot }),
  },
  {
    type: "window",
    ports: "in",
    base: {
      windows: [{ col: "a", partition_by: ["b"], order_by: [{ col: "a", dir: "asc" }] }],
    },
    edits: [
      {
        windows: [
          { col: "a", partition_by: ["b", "gone"], order_by: [{ col: "a", dir: "asc" }] },
        ],
      },
    ],
    expectSurvives: (c) => c.windows?.[0]?.partition_by,
  },
  {
    type: "perioddelta",
    ports: "in",
    base: { value: "a", order: "b", partition: [] },
    edits: [{ value: "gone" }, { partition: ["x"] }],
    expectSurvives: (c) => ({ value: c.value, partition: c.partition }),
  },
  {
    type: "bin",
    ports: "in",
    base: { col: "a" },
    edits: [{ col: "g" }, { col: "gone" }],
    expectSurvives: (c) => c.col,
  },
  {
    type: "rank",
    ports: "in",
    base: { partition: ["a"], order: "b" },
    edits: [{ order: "gone" }, { partition: ["a", "x"] }],
    expectSurvives: (c) => ({ order: c.order, partition: c.partition }),
  },
  {
    type: "fill",
    ports: "in",
    base: { fills: [{ col: "a", value: "0" }] },
    edits: [{ fills: [{ col: "a", value: "0" }, { col: "gone", value: "1" }] }],
    expectSurvives: (c) => c.fills,
  },
  {
    type: "dedupe",
    ports: "in",
    base: { keys: ["a"], sort: "b" },
    edits: [{ keys: ["a", "gone"] }, { sort: "x" }],
    expectSurvives: (c) => ({ keys: c.keys, sort: c.sort }),
  },
  {
    type: "split",
    ports: "in",
    base: { col: "a" },
    edits: [{ col: "gone" }],
    expectSurvives: (c) => c.col,
  },
  {
    type: "jsonextract",
    ports: "in",
    base: { col: "a" },
    edits: [{ col: "gone" }],
    expectSurvives: (c) => c.col,
  },
  {
    type: "explode",
    ports: "in",
    base: { col: "a" },
    edits: [{ col: "gone" }],
    expectSurvives: (c) => c.col,
  },
  {
    type: "textclean",
    ports: "in",
    base: { cols: ["a"] },
    edits: [{ cols: ["a", "gone"] }],
    expectSurvives: (c) => c.cols,
  },
  {
    type: "maprecode",
    ports: "in",
    base: { col: "a" },
    edits: [{ col: "gone" }],
    expectSurvives: (c) => c.col,
  },
  {
    type: "parse",
    ports: "in",
    base: { cols: ["a"] },
    edits: [{ cols: ["a", "gone"] }],
    expectSurvives: (c) => c.cols,
  },
  {
    type: "topn",
    ports: "in",
    base: { group: ["a"], sort: "b" },
    edits: [{ group: ["a", "gone"] }, { sort: "x" }],
    expectSurvives: (c) => ({ group: c.group, sort: c.sort }),
  },
  {
    type: "coalesce",
    ports: "in",
    base: { cols: ["a", "b"] },
    edits: [{ cols: ["a", "b", "gone"] }],
    expectSurvives: (c) => c.cols,
  },
  {
    type: "renamecols",
    ports: "in",
    base: { mappings: [{ from: "a", to: "aa" }] },
    edits: [{ mappings: [{ from: "a", to: "aa" }, { from: "gone", to: "g" }] }],
    expectSurvives: (c) => c.mappings,
  },
  {
    type: "validate",
    ports: "in",
    base: { checks: [{ type: "not_null", col: "a" }] },
    edits: [
      {
        checks: [
          { type: "not_null", col: "a" },
          { type: "not_null", col: "gone" },
        ],
      },
    ],
    expectSurvives: (c) => c.checks,
  },
  {
    type: "chart",
    ports: "in",
    base: { x: "a", y: "b" },
    edits: [{ x: "gone" }, { y: "x" }],
    expectSurvives: (c) => ({ x: c.x, y: c.y }),
  },
  {
    type: "join",
    ports: "lr",
    base: { keys: [{ left: "a", right: "a" }] },
    edits: [
      { keys: [{ left: "a", right: "a" }, { left: "gone", right: "b" }] },
      { keys: [{ left: "g", right: "gone" }] },
    ],
    expectSurvives: (c) => c.keys,
  },
  {
    type: "antijoin",
    ports: "lr",
    base: { keys: [{ left: "a", right: "a" }] },
    edits: [{ keys: [{ left: "gone", right: "a" }] }],
    expectSurvives: (c) => c.keys,
  },
  {
    type: "reconcile",
    ports: "lr",
    base: { keys: ["a"], compare: ["b"], balance: "" },
    edits: [{ keys: ["a", "gone"] }, { compare: ["b", "x"] }, { balance: "gone" }],
    expectSurvives: (c) => ({
      keys: c.keys,
      compare: c.compare,
      balance: c.balance,
    }),
  },
  {
    type: "multijoin",
    ports: "multi",
    base: {
      base: "in1",
      joins: [{ input: "in2", against: "in1", on: [{ left: "a", right: "a" }] }],
    },
    edits: [
      {
        joins: [
          {
            input: "in2",
            against: "in1",
            on: [
              { left: "a", right: "a" },
              { left: "gone", right: "b" },
            ],
          },
        ],
      },
    ],
    expectSurvives: (c) => c.joins?.[0]?.on,
  },
  {
    type: "groupconcat",
    ports: "in",
    base: { group: ["a"], col: "b" },
    edits: [{ group: ["a", "gone"] }, { col: "x" }],
    expectSurvives: (c) => ({ group: c.group, col: c.col }),
  },
  {
    type: "date",
    ports: "in",
    base: { col: "a", other: "b" },
    edits: [{ col: "gone" }, { other: "x" }],
    expectSurvives: (c) => ({ col: c.col, other: c.other }),
  },
  {
    type: "iterator",
    ports: "in",
    base: { replace_keys: ["a"], accumulate: "append" },
    edits: [{ replace_keys: ["a", "gone"] }],
    expectSurvives: (c) => c.replace_keys,
  },
  {
    type: "while",
    ports: "in",
    base: {
      replace_keys: ["a"],
      accumulate: "reduce",
      reduce_keys: ["b"],
      reduce_aggs: [{ col: "a", func: "sum" }],
    },
    edits: [
      { replace_keys: ["a", "gone"] },
      { reduce_keys: ["b", "x"] },
      { reduce_aggs: [{ col: "a", func: "sum" }, { col: "gone", func: "count" }] },
    ],
    expectSurvives: (c) => ({
      replace_keys: c.replace_keys,
      reduce_keys: c.reduce_keys,
      reduce_aggs: c.reduce_aggs,
    }),
  },
];

function buildGraph(tc: TypingCase, config: Record<string, any>) {
  const nodeId = `n-${tc.type}`;
  if (tc.ports === "in") {
    const nodes: NbNode[] = [
      { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t" } },
      {
        id: nodeId,
        type: tc.type,
        x: 120,
        y: 0,
        config: { label: tc.type, ...config },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "e1",
        from: { node: "in-1", port: "out" },
        to: { node: nodeId, port: "in" },
      },
    ];
    return { nodes, edges, nodeId };
  }
  if (tc.ports === "lr") {
    const nodes: NbNode[] = [
      { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t1" } },
      { id: "in-2", type: "input", x: 0, y: 80, config: { table: "t2" } },
      {
        id: nodeId,
        type: tc.type,
        x: 160,
        y: 40,
        config: { label: tc.type, ...config },
      },
    ];
    const edges: NbEdge[] = [
      {
        id: "eL",
        from: { node: "in-1", port: "out" },
        to: { node: nodeId, port: "left" },
      },
      {
        id: "eR",
        from: { node: "in-2", port: "out" },
        to: { node: nodeId, port: "right" },
      },
    ];
    return { nodes, edges, nodeId };
  }
  // multijoin
  const nodes: NbNode[] = [
    { id: "in-1", type: "input", x: 0, y: 0, config: { table: "t1" } },
    { id: "in-2", type: "input", x: 0, y: 80, config: { table: "t2" } },
    {
      id: nodeId,
      type: tc.type,
      x: 160,
      y: 40,
      config: { label: tc.type, ...config },
    },
  ];
  const edges: NbEdge[] = [
    {
      id: "e1",
      from: { node: "in-1", port: "out" },
      to: { node: nodeId, port: "in1" },
    },
    {
      id: "e2",
      from: { node: "in-2", port: "out" },
      to: { node: nodeId, port: "in2" },
    },
  ];
  return { nodes, edges, nodeId };
}

function mockColsFor(ports: PortKind) {
  if (ports === "in") {
    return {
      results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
    };
  }
  if (ports === "lr") {
    return {
      results: [
        { node: "in-1", port: "out", columns: ["a", "b"] },
        { node: "in-2", port: "out", columns: ["a", "b"] },
      ],
    };
  }
  return {
    results: [
      { node: "in-1", port: "out", columns: ["a", "b"] },
      { node: "in-2", port: "out", columns: ["a", "b"] },
    ],
  };
}

describe("useNodeFlowInspectorController auto-prune stale column refs (F2)", () => {
  beforeEach(() => {
    clearNodeflowColsCache();
    nodeflowColumnsBatch.mockClear();
    onToast.mockClear();
    nodeflowColumnsBatch.mockResolvedValue({
      results: [{ node: "in-1", port: "out", columns: ["a", "b"] }],
    });
  });

  it("covers every stale-ref node type with a typing fixture", () => {
    const covered = new Set(TYPING_CASES.map((c) => c.type));
    expect([...STALE_REF_NODE_TYPES].sort()).toEqual([...covered].sort());
    for (const t of NO_AUTO_PRUNE_STALE_TYPES) {
      expect(covered.has(t)).toBe(true);
    }
  });

  it("does not auto-prune stale refs when inspCols arrive (Clear missing / rerun only)", async () => {
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

    const { result } = renderHook(
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
      expect(result.current.staleColRefs.length).toBeGreaterThan(0);
    });
    expect(onToast).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(result.current.staleColRefs).toEqual([
      { area: "sort", columns: ["gone"] },
    ]);
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

  describe("config edits never auto-wipe refs (all stale-aware nodes)", () => {
    it.each(TYPING_CASES)(
      "$type: user edits after inspCols settle do not auto-prune",
      async (tc) => {
        clearNodeflowColsCache();
        onToast.mockClear();
        nodeflowColumnsBatch.mockClear();
        nodeflowColumnsBatch.mockResolvedValue(mockColsFor(tc.ports));

        let { nodes, edges, nodeId } = buildGraph(tc, tc.base);
        const target = () => nodes.find((n) => n.id === nodeId)!;

        const patch = vi.fn((id: string, config: Record<string, any>) => {
          const n = nodes.find((x) => x.id === id);
          if (n) n.config = { ...n.config, ...config };
        });

        const { result, rerender } = renderHook(
          (props: { cfg: Record<string, any> }) => {
            target().config = { label: tc.type, ...props.cfg };
            nodes = nodes.map((n) =>
              n.id === nodeId ? { ...n, config: { ...target().config } } : n,
            );
            return useNodeFlowInspectorController({
              scopeKey: `test-${tc.type}`,
              nodes: [...nodes],
              edges,
              selectedId: nodeId,
              selectedNode: { ...target(), config: { ...target().config } },
              childSelection: null,
              graphSig: `sig-${tc.type}`,
              graphForApi: () => ({ nodes, edges }),
              partialGroupGraph: () => ({ nodes, edges }),
              patch,
              runtime,
            });
          },
          { initialProps: { cfg: { ...tc.base } } },
        );

        await waitFor(() => {
          if (tc.ports === "in") {
            expect(result.current.inspCols.in?.length).toBeGreaterThan(0);
          } else if (tc.ports === "lr") {
            expect(result.current.inspCols.left?.length).toBeGreaterThan(0);
            expect(result.current.inspCols.right?.length).toBeGreaterThan(0);
          } else {
            expect(
              (result.current.inspCols.in1 || []).length +
                (result.current.inspCols.in2 || []).length,
            ).toBeGreaterThan(0);
          }
        });

        // Freeform nodes must never auto-prune; structured start clean so no toast yet.
        expect(onToast).not.toHaveBeenCalled();
        const patchesBeforeEdits = patch.mock.calls.length;

        for (const edit of tc.edits) {
          const next = { ...target().config, ...edit };
          act(() => {
            rerender({ cfg: next });
          });
        }

        const last = tc.edits.reduce(
          (acc, e) => ({ ...acc, ...e }),
          { ...tc.base },
        );
        const expected = tc.expectSurvives(last);
        expect(tc.expectSurvives(target().config)).toEqual(expected);

        // No prune toast from typing / config edits (inspCols unchanged).
        expect(onToast).not.toHaveBeenCalled();

        // Auto-prune must not have wiped the edited fields after settle.
        const autoWipes = patch.mock.calls
          .slice(patchesBeforeEdits)
          .filter((c) => c[0] === nodeId);
        if (NO_AUTO_PRUNE_STALE_TYPES.has(tc.type)) {
          expect(
            autoWipes.filter((c) => {
              const cfg = c[1] as Record<string, any>;
              if (tc.type === "filter") return cfg.condition === "";
              if (tc.type === "formula")
                return (cfg.formulas || []).some((f: any) => f?.expr === "");
              return false;
            }),
          ).toHaveLength(0);
        } else {
          // Structured: edits may call patch from the test harness only via
          // parent config; controller must not emit prune patches on edit.
          expect(autoWipes).toHaveLength(0);
        }
      },
    );
  });
});
