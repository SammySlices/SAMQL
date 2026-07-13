import { uid } from "./ids";
import type { NbEdge, NbNode, NodeType } from "./nodeFlowModel";

/** Persist user-authored NodeFlow macros across app restarts. */
export const CREATED_NODES_KEY = "samql.nodeflow.created.v1";
export const CREATED_NODE_FILE_FORMAT = "samql-created-node";
export const CREATED_NODE_FILE_VERSION = 1;
export const USERNODE_MAX_PORTS = 10;

/** Icons offered when creating a custom node (must exist on `Icon`). */
export const CREATED_NODE_ICON_CHOICES = [
  "Sparkle",
  "Star",
  "Lightbulb",
  "Workflow",
  "Layers",
  "Beaker",
  "Code",
  "Braces",
  "Variable",
  "Filter",
  "Database",
  "Table",
  "Grid",
  "Grid3",
  "LayoutGrid",
  "Columns",
  "Rows",
  "Sigma",
  "Chart",
  "Dashboard",
  "GitMerge",
  "Merge",
  "Swap",
  "Split",
  "Shuffle",
  "Group",
  "Repeat",
  "RotateCw",
  "Refresh",
  "Cloud",
  "Globe",
  "ShieldCheck",
  "Scale",
  "ScanSearch",
  "Eye",
  "Binary",
  "Dice",
  "SortArrows",
  "ListOrdered",
  "ListTree",
  "Calendar",
  "Clock",
  "Folder",
  "FolderOpen",
  "FolderSearch",
  "File",
  "Files",
  "FileDown",
  "Download",
  "Upload",
  "ArrowDownToLine",
  "StickyNote",
  "Bookmark",
  "Pin",
  "Window",
  "Ruler",
  "Eraser",
  "Format",
  "FoldHorizontal",
  "SquarePlus",
  "SquarePen",
  "SquareMinus",
  "Copy",
  "CopyMinus",
  "Edit",
  "Play",
  "Check",
  "Step",
  "Compare",
  "ChevronsUp",
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

function collectNodesDeep(nodes: NbNode[]): NbNode[] {
  const out: NbNode[] = [];
  for (const node of nodes) {
    out.push(node);
    const children = node.config?.children;
    if (Array.isArray(children) && children.length) {
      out.push(...collectNodesDeep(children as NbNode[]));
    }
  }
  return out;
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
  if (collectNodesDeep(nodes).some((n) => n.type === "usernode")) {
    return {
      inputs: [],
      outputs: [],
      error:
        "Remove Created Node instances from the tab (including inside groups) before saving.",
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
  try {
    window.dispatchEvent(
      new CustomEvent("samql-created-node-updated", {
        detail: { definition },
      }),
    );
  } catch {
    // Non-browser — catalog write still succeeded.
  }
  return next;
}

export function removeCreatedNode(id: string): CreatedNodeDefinition[] {
  const next = loadCreatedNodes().filter((d) => d.id !== id);
  saveCreatedNodes(next);
  try {
    window.dispatchEvent(
      new CustomEvent("samql-created-node-deleted", {
        detail: { definitionId: id },
      }),
    );
  } catch {
    // Non-browser — catalog write still succeeded.
  }
  return next;
}

/** Rename a catalog entry; refreshes canvas instances via the updated event. */
export function renameCreatedNode(
  id: string,
  nextName: string,
): { ok: true; definition: CreatedNodeDefinition } | { ok: false; error: string } {
  const name = nextName.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  const existing = loadCreatedNodes().find((d) => d.id === id);
  if (!existing) return { ok: false, error: "That created node is gone." };
  if (existing.name === name) {
    return { ok: true, definition: existing };
  }
  const definition: CreatedNodeDefinition = {
    ...existing,
    name,
    updatedAt: new Date().toISOString(),
  };
  upsertCreatedNode(definition);
  return { ok: true, definition };
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

/** Snapshot the active tab over an existing Created Node (keeps id / name / icon). */
export function updateCreatedNodeDefinition(
  definitionId: string,
  nodes: NbNode[],
  edges: NbEdge[],
  fallback?: { name: string; icon: CreatedNodeIcon; createdAt?: string },
): { ok: true; definition: CreatedNodeDefinition } | { ok: false; error: string } {
  const existing = loadCreatedNodes().find((d) => d.id === definitionId);
  const name = (existing?.name || fallback?.name || "").trim();
  const icon = (existing?.icon ||
    fallback?.icon ||
    "Sparkle") as CreatedNodeIcon;
  if (!name) {
    return {
      ok: false,
      error: "Open a created node first (right-click → Open Node).",
    };
  }
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
  const definition: CreatedNodeDefinition = {
    id: definitionId,
    name,
    icon,
    createdAt: existing?.createdAt || fallback?.createdAt || now,
    updatedAt: now,
    graph: { nodes: graphNodes, edges: edges.map((e) => ({ ...e })) },
    inputs: ports.inputs,
    outputs: ports.outputs,
  };
  upsertCreatedNode(definition);
  return { ok: true, definition };
}

function mapNodesDeep(
  nodes: NbNode[],
  mapFn: (node: NbNode) => NbNode,
): { nodes: NbNode[]; changed: boolean } {
  let changed = false;
  const next = nodes.map((node) => {
    let mapped = mapFn(node);
    if (mapped !== node) changed = true;
    const children = mapped.config?.children;
    if (Array.isArray(children) && children.length) {
      const nested = mapNodesDeep(children as NbNode[], mapFn);
      if (nested.changed) {
        changed = true;
        mapped = {
          ...mapped,
          config: { ...mapped.config, children: nested.nodes },
        };
      }
    }
    return mapped;
  });
  return { nodes: next, changed };
}

/** Refresh usernode instances that match a definition; drop edges to removed ports. */
export function applyCreatedNodeToGraph(
  nodes: NbNode[],
  edges: NbEdge[],
  definition: CreatedNodeDefinition,
): { nodes: NbNode[]; edges: NbEdge[]; changed: boolean } {
  const refreshed = mapNodesDeep(nodes, (node) => {
    if (node.type !== "usernode") return node;
    if (String(node.config?.definitionId || "") !== definition.id) return node;
    const nextConfig = {
      ...(node.config || {}),
      ...usernodeConfigFromDefinition(definition),
    };
    if (
      Number(node.config?.inputCount) === Number(nextConfig.inputCount) &&
      Number(node.config?.outputCount) === Number(nextConfig.outputCount) &&
      String(node.config?.name || "") === String(nextConfig.name || "") &&
      String(node.config?.icon || "") === String(nextConfig.icon || "") &&
      JSON.stringify(node.config?.inputs || []) ===
        JSON.stringify(nextConfig.inputs || []) &&
      JSON.stringify(node.config?.outputs || []) ===
        JSON.stringify(nextConfig.outputs || []) &&
      JSON.stringify(node.config?.graph || null) ===
        JSON.stringify(nextConfig.graph || null)
    ) {
      return node;
    }
    return { ...node, config: nextConfig };
  });
  if (!refreshed.changed) {
    return { nodes, edges, changed: false };
  }
  const byId = new Map(
    collectNodesDeep(refreshed.nodes).map((n) => [n.id, n] as const),
  );
  const nextEdges = edges.filter((edge) => {
    const fromNode = byId.get(edge.from.node);
    const toNode = byId.get(edge.to.node);
    if (!fromNode || !toNode) return true;
    if (fromNode.type === "usernode") {
      const outs = usernodePortNames(fromNode, "out");
      if (!outs.includes(edge.from.port)) return false;
    }
    if (toNode.type === "usernode") {
      const inns = usernodePortNames(toNode, "in");
      if (!inns.includes(edge.to.port)) return false;
    }
    return true;
  });
  return {
    nodes: refreshed.nodes,
    edges: nextEdges.length === edges.length ? edges : nextEdges,
    changed: true,
  };
}

/** Remove every usernode instance for a definition (and edges touching them). */
export function stripCreatedNodeFromGraph(
  nodes: NbNode[],
  edges: NbEdge[],
  definitionId: string,
): { nodes: NbNode[]; edges: NbEdge[]; changed: boolean; removedIds: string[] } {
  const collectIds = (list: NbNode[], acc: string[]) => {
    for (const node of list) {
      if (
        node.type === "usernode" &&
        String(node.config?.definitionId || "") === definitionId
      ) {
        acc.push(node.id);
      }
      const children = node.config?.children;
      if (Array.isArray(children)) collectIds(children as NbNode[], acc);
    }
  };
  const ids: string[] = [];
  collectIds(nodes, ids);
  if (!ids.length) {
    return { nodes, edges, changed: false, removedIds: [] };
  }
  const doomed = new Set(ids);
  const filterTree = (list: NbNode[]): NbNode[] =>
    list
      .filter((node) => !doomed.has(node.id))
      .map((node) => {
        const children = node.config?.children;
        if (!Array.isArray(children)) return node;
        const nextChildren = filterTree(children as NbNode[]);
        if (nextChildren.length === children.length) {
          let same = true;
          for (let i = 0; i < nextChildren.length; i++) {
            if (nextChildren[i] !== children[i]) {
              same = false;
              break;
            }
          }
          if (same) return node;
        }
        return {
          ...node,
          config: { ...node.config, children: nextChildren },
        };
      });
  const nextNodes = filterTree(nodes);
  const nextEdges = edges.filter(
    (edge) => !doomed.has(edge.from.node) && !doomed.has(edge.to.node),
  );
  return {
    nodes: nextNodes,
    edges: nextEdges,
    changed: true,
    removedIds: ids,
  };
}

function usernodePortNames(node: NbNode, side: "in" | "out"): string[] {
  const count = Math.max(
    0,
    Math.min(
      USERNODE_MAX_PORTS,
      Number(side === "in" ? node.config?.inputCount : node.config?.outputCount) ||
        0,
    ),
  );
  return Array.from({ length: count }, (_, i) => `${side}${i + 1}`);
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
let _editingDefinitionGetter:
  | (() => {
      id: string;
      name: string;
      icon: CreatedNodeIcon;
    } | null)
  | null = null;

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

export function registerActiveEditingDefinitionGetter(
  getter:
    | (() => {
        id: string;
        name: string;
        icon: CreatedNodeIcon;
      } | null)
    | null,
): void {
  _editingDefinitionGetter = getter;
}

export function getActiveEditingDefinition(): {
  id: string;
  name: string;
  icon: CreatedNodeIcon;
} | null {
  try {
    return _editingDefinitionGetter ? _editingDefinitionGetter() : null;
  } catch {
    return null;
  }
}
