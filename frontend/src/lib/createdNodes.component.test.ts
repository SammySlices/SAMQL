import { beforeEach, describe, expect, it } from "vitest";
import {
  CREATED_NODES_KEY,
  analyzeCreatedNodePorts,
  buildCreatedNodeDefinition,
  loadCreatedNodes,
  parseCreatedNodeFile,
  removeCreatedNode,
  serializeCreatedNodeFile,
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

  it("rejects graphs without Dynamic Input / Output", () => {
    const ports = analyzeCreatedNodePorts(
      [{ id: "a", type: "select", x: 0, y: 0, config: {} }],
      [],
    );
    expect(ports.error).toMatch(/Dynamic Input/);
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
});
