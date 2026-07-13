import { beforeEach, describe, expect, it } from "vitest";
import { Icon } from "../components/Icon";
import {
  CREATED_NODE_ICON_CHOICES,
  CREATED_NODES_KEY,
  analyzeCreatedNodePorts,
  applyCreatedNodeToGraph,
  buildCreatedNodeDefinition,
  loadCreatedNodes,
  parseCreatedNodeFile,
  removeCreatedNode,
  serializeCreatedNodeFile,
  updateCreatedNodeDefinition,
  upsertCreatedNode,
  usernodeConfigFromDefinition,
} from "./createdNodes";
import {
  portsOf,
  visibleInputCount,
  visibleOutputCount,
  type NbEdge,
  type NbNode,
} from "./nodeFlowModel";

/** Multi-port authoring graph: 2 Dynamic Inputs + transform + 2 Dynamic Outputs. */
function multiPortGraph(): { nodes: NbNode[]; edges: NbEdge[] } {
  const nodes: NbNode[] = [
    { id: "di1", type: "dyn_input", x: 0, y: 10, config: { label: "left" } },
    { id: "di2", type: "dyn_input", x: 0, y: 80, config: { label: "right" } },
    {
      id: "jn",
      type: "join",
      x: 140,
      y: 40,
      config: { keys: [{ left: "id", right: "id" }], label: "join" },
    },
    { id: "do1", type: "dyn_output", x: 300, y: 10, config: { label: "matched" } },
    { id: "do2", type: "dyn_output", x: 300, y: 80, config: { label: "copy" } },
    {
      id: "sel",
      type: "select",
      x: 140,
      y: 120,
      config: {
        fields: [{ name: "id", keep: true }],
        label: "select",
      },
    },
  ];
  const edges: NbEdge[] = [
    {
      id: "e1",
      from: { node: "di1", port: "out" },
      to: { node: "jn", port: "left" },
    },
    {
      id: "e2",
      from: { node: "di2", port: "out" },
      to: { node: "jn", port: "right" },
    },
    {
      id: "e3",
      from: { node: "jn", port: "inner" },
      to: { node: "do1", port: "in" },
    },
    {
      id: "e4",
      from: { node: "di1", port: "out" },
      to: { node: "sel", port: "in" },
    },
    {
      id: "e5",
      from: { node: "sel", port: "out" },
      to: { node: "do2", port: "in" },
    },
  ];
  return { nodes, edges };
}

function simpleGraph(): { nodes: NbNode[]; edges: NbEdge[] } {
  const nodes: NbNode[] = [
    { id: "di", type: "dyn_input", x: 0, y: 10, config: { label: "in" } },
    {
      id: "sel",
      type: "select",
      x: 120,
      y: 10,
      config: { fields: [{ name: "a", keep: true }], label: "select" },
    },
    { id: "do", type: "dyn_output", x: 240, y: 10, config: { label: "out" } },
  ];
  const edges: NbEdge[] = [
    {
      id: "e1",
      from: { node: "di", port: "out" },
      to: { node: "sel", port: "in" },
    },
    {
      id: "e2",
      from: { node: "sel", port: "out" },
      to: { node: "do", port: "in" },
    },
  ];
  return { nodes, edges };
}

describe("Created Nodes — save / export / load / ports", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("offers a broad icon palette that all resolve on Icon", () => {
    expect(CREATED_NODE_ICON_CHOICES.length).toBeGreaterThanOrEqual(40);
    for (const name of CREATED_NODE_ICON_CHOICES) {
      expect(Icon[name], name).toBeTypeOf("function");
    }
  });

  it("accepts newly added palette icons when creating a node", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition(
      "Analyzer",
      "ScanSearch",
      nodes,
      edges,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.definition.icon).toBe("ScanSearch");
  });

  it("saves a created node into localStorage (Create a node)", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Scaler", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const saved = upsertCreatedNode(built.definition);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Scaler");

    const raw = localStorage.getItem(CREATED_NODES_KEY);
    expect(raw).toBeTruthy();
    expect(loadCreatedNodes()).toEqual(saved);
  });

  it("exports a created node as a shareable JSON file payload", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Scaler", "Sparkle", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const file = serializeCreatedNodeFile(built.definition);
    expect(file.format).toBe("samql-created-node");
    expect(file.version).toBe(1);
    expect(file.node.name).toBe("Scaler");
    expect(file.node.graph.nodes).toHaveLength(3);
    expect(file.node.inputs).toHaveLength(1);
    expect(file.node.outputs).toHaveLength(1);
  });

  it("loads an exported created-node file into the catalog", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Shared", "Cloud", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const exported = serializeCreatedNodeFile(built.definition);
    const parsed = parseCreatedNodeFile(JSON.parse(JSON.stringify(exported)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    upsertCreatedNode(parsed.definition);
    const loaded = loadCreatedNodes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Shared");
    expect(loaded[0].graph.edges).toHaveLength(2);
  });

  it("exposes one input/output arrow per Dynamic Input/Output in the definition", () => {
    const { nodes, edges } = multiPortGraph();
    const ports = analyzeCreatedNodePorts(nodes, edges);
    expect(ports.error).toBeUndefined();
    expect(ports.inputs.map((p) => p.port)).toEqual(["in1", "in2"]);
    expect(ports.outputs.map((p) => p.port)).toEqual(["out1", "out2"]);

    const built = buildCreatedNodeDefinition("Joiner", "GitMerge", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const cfg = usernodeConfigFromDefinition(built.definition);
    expect(cfg.inputCount).toBe(2);
    expect(cfg.outputCount).toBe(2);

    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 0,
      y: 0,
      config: cfg,
    };
    const effective = portsOf(instance);
    expect(effective.inputs).toEqual(["in1", "in2"]);
    expect(effective.outputs).toEqual(["out1", "out2"]);
    expect(visibleInputCount(instance, [])).toBe(2);
    expect(visibleOutputCount(instance)).toBe(2);
    expect(effective.inputs).not.toContain("in3");
    expect(effective.outputs).not.toContain("out3");
  });

  it("orders Dynamic Input/Output ports top-to-bottom on the canvas", () => {
    const { nodes, edges } = multiPortGraph();
    const ports = analyzeCreatedNodePorts(nodes, edges);
    expect(ports.inputs[0].nodeId).toBe("di1");
    expect(ports.inputs[1].nodeId).toBe("di2");
    expect(ports.outputs[0].nodeId).toBe("do1");
    expect(ports.outputs[1].nodeId).toBe("do2");
  });

  it("rejects Created Node instances nested inside groups", () => {
    const ports = analyzeCreatedNodePorts(
      [
        { id: "di", type: "dyn_input", x: 0, y: 0, config: {} },
        {
          id: "g",
          type: "group",
          x: 40,
          y: 0,
          config: {
            children: [
              {
                id: "u",
                type: "usernode",
                config: { graph: { nodes: [], edges: [] } },
              },
            ],
          },
        },
        { id: "do", type: "dyn_output", x: 80, y: 0, config: {} },
      ],
      [],
    );
    expect(ports.error).toMatch(/groups/i);
  });

  it("can remove a saved created node from the catalog", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Temp", "Star", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);
    expect(loadCreatedNodes()).toHaveLength(1);
    removeCreatedNode(built.definition.id);
    expect(loadCreatedNodes()).toHaveLength(0);
  });

  it("updates an existing created node from an edited definition graph", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Scaler", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const editedNodes: NbNode[] = [
      ...nodes,
      {
        id: "di2",
        type: "dyn_input",
        x: 0,
        y: 100,
        config: { label: "extra" },
      },
      {
        id: "do2",
        type: "dyn_output",
        x: 240,
        y: 100,
        config: { label: "extra-out" },
      },
    ];
    const editedEdges: NbEdge[] = [
      ...edges,
      {
        id: "e3",
        from: { node: "di2", port: "out" },
        to: { node: "sel", port: "in" },
      },
      {
        id: "e4",
        from: { node: "sel", port: "out" },
        to: { node: "do2", port: "in" },
      },
    ];
    const updated = updateCreatedNodeDefinition(
      built.definition.id,
      editedNodes,
      editedEdges,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.definition.id).toBe(built.definition.id);
    expect(updated.definition.name).toBe("Scaler");
    expect(updated.definition.inputs).toHaveLength(2);
    expect(updated.definition.outputs).toHaveLength(2);
    expect(loadCreatedNodes()[0].inputs.map((p) => p.port)).toEqual([
      "in1",
      "in2",
    ]);
  });

  it("refreshes usernode instances and drops edges to removed ports", () => {
    const { nodes, edges } = multiPortGraph();
    const built = buildCreatedNodeDefinition("Joiner", "GitMerge", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 0,
      y: 0,
      config: usernodeConfigFromDefinition(built.definition),
    };
    const source: NbNode = {
      id: "src",
      type: "input",
      x: -100,
      y: 0,
      config: {},
    };
    const canvasEdges: NbEdge[] = [
      {
        id: "c1",
        from: { node: "src", port: "out" },
        to: { node: "u1", port: "in2" },
      },
      {
        id: "c2",
        from: { node: "u1", port: "out2" },
        to: { node: "src", port: "in" },
      },
    ];

    const shrunk = updateCreatedNodeDefinition(
      built.definition.id,
      simpleGraph().nodes,
      simpleGraph().edges,
    );
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;

    const refreshed = applyCreatedNodeToGraph(
      [source, instance],
      canvasEdges,
      shrunk.definition,
    );
    expect(refreshed.changed).toBe(true);
    const next = refreshed.nodes.find((n) => n.id === "u1")!;
    expect(next.config.inputCount).toBe(1);
    expect(next.config.outputCount).toBe(1);
    expect(portsOf(next).inputs).toEqual(["in1"]);
    expect(portsOf(next).outputs).toEqual(["out1"]);
    expect(refreshed.edges.map((e) => e.id)).toEqual([]);
  });

  it("preserves id / name / icon / createdAt when saving an opened node", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("KeepMe", "Cloud", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const original = {
      ...built.definition,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    upsertCreatedNode(original);

    const updated = updateCreatedNodeDefinition(original.id, nodes, edges);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.definition.id).toBe(original.id);
    expect(updated.definition.name).toBe("KeepMe");
    expect(updated.definition.icon).toBe("Cloud");
    expect(updated.definition.createdAt).toBe(original.createdAt);
    expect(updated.definition.updatedAt).not.toBe(original.updatedAt);
  });

  it("recreates a missing catalog entry from Open Node fallback metadata", () => {
    const { nodes, edges } = simpleGraph();
    const result = updateCreatedNodeDefinition("missing-id", nodes, edges, {
      name: "Restored",
      icon: "Star",
      createdAt: "2021-02-03T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.id).toBe("missing-id");
    expect(result.definition.name).toBe("Restored");
    expect(result.definition.icon).toBe("Star");
    expect(result.definition.createdAt).toBe("2021-02-03T00:00:00.000Z");
    expect(loadCreatedNodes()).toHaveLength(1);
  });

  it("rejects Save node when the editing graph has no Dynamic ports", () => {
    const result = updateCreatedNodeDefinition(
      "bad",
      [{ id: "a", type: "select", x: 0, y: 0, config: {} }],
      [],
      { name: "Bad", icon: "Sparkle" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Dynamic Input/);
  });

  it("expands instance ports when Save node adds Dynamic Input/Output", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Grow", "Layers", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 0,
      y: 0,
      config: usernodeConfigFromDefinition(built.definition),
    };
    expect(portsOf(instance).inputs).toEqual(["in1"]);

    const grown = updateCreatedNodeDefinition(
      built.definition.id,
      multiPortGraph().nodes,
      multiPortGraph().edges,
    );
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;

    const refreshed = applyCreatedNodeToGraph([instance], [], grown.definition);
    expect(refreshed.changed).toBe(true);
    const next = refreshed.nodes[0];
    expect(portsOf(next).inputs).toEqual(["in1", "in2"]);
    expect(portsOf(next).outputs).toEqual(["out1", "out2"]);
    expect(next.config.graph).toEqual(grown.definition.graph);
  });

  it("leaves unrelated created-node instances unchanged on refresh", () => {
    const { nodes, edges } = simpleGraph();
    const a = buildCreatedNodeDefinition("A", "Star", nodes, edges);
    const b = buildCreatedNodeDefinition("B", "Cloud", nodes, edges);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    upsertCreatedNode(a.definition);
    upsertCreatedNode(b.definition);

    const nodesOnCanvas: NbNode[] = [
      {
        id: "ua",
        type: "usernode",
        x: 0,
        y: 0,
        config: usernodeConfigFromDefinition(a.definition),
      },
      {
        id: "ub",
        type: "usernode",
        x: 200,
        y: 0,
        config: usernodeConfigFromDefinition(b.definition),
      },
    ];
    const grown = updateCreatedNodeDefinition(
      a.definition.id,
      multiPortGraph().nodes,
      multiPortGraph().edges,
    );
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;

    const refreshed = applyCreatedNodeToGraph(
      nodesOnCanvas,
      [],
      grown.definition,
    );
    expect(refreshed.changed).toBe(true);
    expect(refreshed.nodes[0].config.inputCount).toBe(2);
    expect(refreshed.nodes[1].config.inputCount).toBe(1);
    expect(refreshed.nodes[1].config.definitionId).toBe(b.definition.id);
  });

  it("is a no-op when the instance already matches the definition", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Same", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 0,
      y: 0,
      config: usernodeConfigFromDefinition(built.definition),
    };
    const refreshed = applyCreatedNodeToGraph(
      [instance],
      [],
      built.definition,
    );
    expect(refreshed.changed).toBe(false);
    expect(refreshed.nodes[0]).toBe(instance);
  });

  it("refreshes created-node instances nested inside a group", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Nested", "Grid", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const canvas: NbNode[] = [
      {
        id: "g1",
        type: "group",
        x: 0,
        y: 0,
        config: {
          children: [
            {
              id: "u-child",
              type: "usernode",
              config: usernodeConfigFromDefinition(built.definition),
            },
          ],
        },
      },
    ];
    const grown = updateCreatedNodeDefinition(
      built.definition.id,
      multiPortGraph().nodes,
      multiPortGraph().edges,
    );
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;

    const refreshed = applyCreatedNodeToGraph(canvas, [], grown.definition);
    expect(refreshed.changed).toBe(true);
    const child = (refreshed.nodes[0].config.children as NbNode[])[0];
    expect(child.config.inputCount).toBe(2);
    expect(child.config.outputCount).toBe(2);
  });

  it("dispatches samql-created-node-updated when a definition is upserted", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Event", "Sparkle", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const seen: string[] = [];
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      seen.push(String(detail?.definition?.id || ""));
    };
    window.addEventListener("samql-created-node-updated", handler);
    try {
      upsertCreatedNode(built.definition);
    } finally {
      window.removeEventListener("samql-created-node-updated", handler);
    }
    expect(seen).toEqual([built.definition.id]);
  });
});
