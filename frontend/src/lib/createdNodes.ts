import { uid } from "./ids";
import type { NbEdge, NbNode, NodeType } from "./nodeFlowModel";

/** Persist user-authored NodeFlow macros across app restarts. */
export const CREATED_NODES_KEY = "samql.nodeflow.created.v1";
export const CREATED_NODE_FILE_FORMAT = "samql-created-node";
export const CREATED_NODE_FILE_VERSION = 1;
export const USERNODE_MAX_PORTS = 10;

/** Icons offered when creating a custom node. */
export const CREATED_NODE_ICON_CHOICES = [
  "Sparkle",
  "Star",
  "Workflow",
  "Layers",
  "Beaker",
  "Code",
  "Filter",
  "Database",
  "Table",
  "Grid",
  "Sigma",
  "GitMerge",
  "Repeat",
  "Cloud",
  "ShieldCheck",
  "LayoutGrid",
] as const;

export type CreatedNodeIcon = (typeof CREATED_NODE_ICON_CHOICES)[number];

export interface CreatedNodePort {
  /** dyn_input / dyn_output node id inside the saved graph */
  nodeId: string;
  /** External port on the usernode instance (in1, out2, …) */
  port: string;
  label: string;
}

export interface CreatedNodeDefinition {
  id: string;
  name: string;
  icon: CreatedNodeIcon;
  createdAt: string;
  updatedAt: string;
  graph: { nodes: NbNode[]; edges: NbEdge[] };
  inputs: CreatedNodePort[];
  outputs: CreatedNodePort[];
}

export interface CreatedNodeFile {
  format: typeof CREATED_NODE_FILE_FORMAT;
  version: number;
  node: CreatedNodeDefinition;
}

function sortDynNodes(nodes: NbNode[], type: NodeType): NbNode[] {
  return nodes
    .filter((n) => n.type === type)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

/** Derive ordered external ports from Dynamic Input / Output nodes. */
export function analyzeCreatedNodePorts(
  nodes: NbNode[],
  _edges: NbEdge[],
): { inputs: CreatedNodePort[]; outputs: CreatedNodePort[]; error?: string } {
  const inputs = sortDynNodes(nodes, "dyn_input");
  const outputs = sortDynNodes(nodes, "dyn_output");
  if (inputs.length === 0) {
    return {
      inputs: [],
      outputs: [],
      error: "Add at least one Dynamic Input node before creating a node.",
    };
  }
  if (outputs.length === 0) {
    return {
      inputs: [],
      outputs: [],
      error: "Add at least one Dynamic Output node before creating a node.",
    };
  }
  if (inputs.length > USERNODE_MAX_PORTS || outputs.length > USERNODE_MAX_PORTS) {
    return {
      inputs: [],
      outputs: [],
      error: `A created node supports at most ${USERNODE_MAX_PORTS} inputs and ${USERNODE_MAX_PORTS} outputs.`,
    };
  }
  if (nodes.some((n) => n.type === "usernode")) {
    return {
      inputs: [],
      outputs: [],
      error: "Remove Created Node instances from the tab before saving a new node.",
    };
  }
  return {
    inputs: inputs.map((n, i) => ({
      nodeId: n.id,
      port: `in${i + 1}`,
      label: String(n.config?.label || `in ${i + 1}`),
    })),
    outputs: outputs.map((n, i) => ({
      nodeId: n.id,
      port: `out${i + 1}`,
      label: String(n.config?.label || `out ${i + 1}`),
    })),
  };
}

export function buildCreatedNodeDefinition(
  name: string,
  icon: CreatedNodeIcon,
  nodes: NbNode[],
  edges: NbEdge[],
): { ok: true; definition: CreatedNodeDefinition } | { ok: false; error: string } {
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, error: "Enter a name for the node." };
  if (!CREATED_NODE_ICON_CHOICES.includes(icon)) {
    return { ok: false, error: "Pick an icon from the list." };
  }
  const ports = analyzeCreatedNodePorts(nodes, edges);
  if (ports.error) return { ok: false, error: ports.error };
  const now = new Date().toISOString();
  const graphNodes = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    x: n.x,
    y: n.y,
    config: { ...(n.config || {}) },
  }));
  return {
    ok: true,
    definition: {
      id: uid() + uid(),
      name: trimmed,
      icon,
      createdAt: now,
      updatedAt: now,
      graph: { nodes: graphNodes, edges: edges.map((e) => ({ ...e })) },
      inputs: ports.inputs,
      outputs: ports.outputs,
    },
  };
}

export function loadCreatedNodes(): CreatedNodeDefinition[] {
  try {
    const raw = localStorage.getItem(CREATED_NODES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        item.graph &&
        Array.isArray(item.graph.nodes) &&
        Array.isArray(item.graph.edges) &&
        Array.isArray(item.inputs) &&
        Array.isArray(item.outputs),
    ) as CreatedNodeDefinition[];
  } catch {
    return [];
  }
}

export function saveCreatedNodes(defs: CreatedNodeDefinition[]): boolean {
  try {
    localStorage.setItem(CREATED_NODES_KEY, JSON.stringify(defs));
    try {
      window.dispatchEvent(new Event("samql-created-nodes-changed"));
    } catch {
      // Non-browser or Event unsupported — storage write still succeeded.
    }
    return true;
  } catch {
    return false;
  }
}

export function upsertCreatedNode(
  definition: CreatedNodeDefinition,
): CreatedNodeDefinition[] {
  const current = loadCreatedNodes().filter((d) => d.id !== definition.id);
  const next = [...current, definition];
  saveCreatedNodes(next);
  return next;
}

export function removeCreatedNode(id: string): CreatedNodeDefinition[] {
  const next = loadCreatedNodes().filter((d) => d.id !== id);
  saveCreatedNodes(next);
  return next;
}

export function usernodeConfigFromDefinition(
  definition: CreatedNodeDefinition,
): Record<string, unknown> {
  return {
    label: definition.name,
    definitionId: definition.id,
    name: definition.name,
    icon: definition.icon,
    inputCount: definition.inputs.length,
    outputCount: definition.outputs.length,
    inputs: definition.inputs,
    outputs: definition.outputs,
    graph: definition.graph,
  };
}

export function serializeCreatedNodeFile(
  definition: CreatedNodeDefinition,
): CreatedNodeFile {
  return {
    format: CREATED_NODE_FILE_FORMAT,
    version: CREATED_NODE_FILE_VERSION,
    node: definition,
  };
}

export function parseCreatedNodeFile(
  raw: unknown,
): { ok: true; definition: CreatedNodeDefinition } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "This file is not a SamQL created-node export." };
  }
  const doc = raw as CreatedNodeFile;
  if (doc.format !== CREATED_NODE_FILE_FORMAT) {
    return { ok: false, error: "Unrecognized created-node file format." };
  }
  if (typeof doc.version !== "number" || doc.version > CREATED_NODE_FILE_VERSION) {
    return { ok: false, error: "This created-node file needs a newer SamQL." };
  }
  const node = doc.node;
  if (
    !node ||
    typeof node.id !== "string" ||
    typeof node.name !== "string" ||
    !node.graph ||
    !Array.isArray(node.graph.nodes) ||
    !Array.isArray(node.graph.edges)
  ) {
    return { ok: false, error: "Created-node file is missing its definition." };
  }
  const ports = analyzeCreatedNodePorts(node.graph.nodes, node.graph.edges);
  if (ports.error) return { ok: false, error: ports.error };
  const now = new Date().toISOString();
  return {
    ok: true,
    definition: {
      ...node,
      icon: (CREATED_NODE_ICON_CHOICES as readonly string[]).includes(node.icon)
        ? node.icon
        : "Sparkle",
      inputs: ports.inputs,
      outputs: ports.outputs,
      createdAt: typeof node.createdAt === "string" ? node.createdAt : now,
      updatedAt: now,
    },
  };
}

/** Bridge so App settings can read the active NodeFlow tab graph. */
let _graphGetter: (() => { nodes: NbNode[]; edges: NbEdge[] } | null) | null =
  null;

export function registerActiveNodeFlowGraphGetter(
  getter: (() => { nodes: NbNode[]; edges: NbEdge[] } | null) | null,
): void {
  _graphGetter = getter;
}

export function getActiveNodeFlowGraph(): {
  nodes: NbNode[];
  edges: NbEdge[];
} | null {
  try {
    return _graphGetter ? _graphGetter() : null;
  } catch {
    return null;
  }
}
