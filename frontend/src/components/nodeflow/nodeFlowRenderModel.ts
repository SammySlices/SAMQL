import {
  PORTS,
  isTopInput,
  nodeWorldBounds,
  portsOf,
  portXY,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";

// Canvas rendering is intentionally split from execution graph serialization.
// The backend signature ignores x/y, while this model owns only the geometry,
// local edge revisions, and viewport filtering needed to paint the editor.

export interface NodeFlowWire {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  fromN: string;
  toN: string;
  /** Source output port — used to style Filter True/False edges. */
  fromPort: string;
}

export interface NodeFlowViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeFlowViewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NodeFlowRenderModel {
  nodeById: ReadonlyMap<string, NbNode>;
  nodeIndexById: ReadonlyMap<string, number>;
  incomingByNode: Readonly<Record<string, readonly NbEdge[]>>;
  incomingCountByNode: Readonly<Record<string, number>>;
  visibleInputCountByNode: Readonly<Record<string, number>>;
  renderVersionByNode: Readonly<Record<string, string>>;
  dashboardSourceIdsByNode: Readonly<Record<string, readonly string[]>>;
  wires: readonly NodeFlowWire[];
  /** Edge lookup by id — reused on geometry-only patches. */
  edgeById: ReadonlyMap<string, NbEdge>;
  /** Wire indexes incident to each node — avoids mapping every wire on drag. */
  incidentWireIndexesByNode: ReadonlyMap<string, readonly number[]>;
}

export const LARGE_GRAPH_NODE_THRESHOLD = 80;
export const LARGE_GRAPH_WIRE_THRESHOLD = 160;
export const LARGE_GRAPH_OVERSCAN_PX = 320;

function indexedVisibleInputCount(
  node: NbNode,
  incoming: readonly NbEdge[],
): number {
  const inputs = portsOf(node).inputs;
  if (node.type === "union") return 1;
  if (node.type === "usernode") return inputs.length;
  if (node.type !== "group") return PORTS[node.type].inputs.length;

  let maxIndex = -1;
  for (const edge of incoming) {
    const index = PORTS[node.type].inputs.indexOf(edge.to.port);
    if (index > maxIndex) maxIndex = index;
  }
  return Math.min(PORTS[node.type].inputs.length, Math.max(1, maxIndex + 2));
}

function edgeRevision(edge: NbEdge): string {
  return `${edge.id}:${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`;
}

function safeConfigRevision(node: NbNode): string {
  try {
    return JSON.stringify(node.config || {});
  } catch {
    // Persisted NodeFlow configs are JSON, but keep a defensive identity token
    // so a malformed in-memory plugin value cannot break the whole canvas.
    return String(node.config);
  }
}

export function buildNodeFlowRenderModel(
  nodes: readonly NbNode[],
  edges: readonly NbEdge[],
  /** React cache key — densify() reads the shared layout flag. */
  denseMode = false,
  /** React cache key — sphere helpers read the shared layout flag. */
  sphereMode = false,
): NodeFlowRenderModel {
  void denseMode;
  void sphereMode;
  const nodeById = new Map<string, NbNode>();
  const nodeIndexById = new Map<string, number>();
  const incomingMutable: Record<string, NbEdge[]> = {};
  const incidentRevisions: Record<string, string[]> = {};

  nodes.forEach((node, index) => {
    nodeById.set(node.id, node);
    nodeIndexById.set(node.id, index);
    incomingMutable[node.id] = [];
    incidentRevisions[node.id] = [];
  });

  for (const edge of edges) {
    if (incomingMutable[edge.to.node]) incomingMutable[edge.to.node].push(edge);
    const revision = edgeRevision(edge);
    if (incidentRevisions[edge.from.node]) {
      incidentRevisions[edge.from.node].push(revision);
    }
    if (edge.to.node !== edge.from.node && incidentRevisions[edge.to.node]) {
      incidentRevisions[edge.to.node].push(revision);
    }
  }

  const incomingCountByNode: Record<string, number> = {};
  const visibleInputCountByNode: Record<string, number> = {};
  const renderVersionByNode: Record<string, string> = {};
  const dashboardSourceIdsByNode: Record<string, string[]> = {};

  for (const node of nodes) {
    const incoming = incomingMutable[node.id] || [];
    incomingCountByNode[node.id] = incoming.length;
    visibleInputCountByNode[node.id] = indexedVisibleInputCount(node, incoming);

    // Most cards depend only on their own node object plus incident wiring.
    // Dashboards additionally display labels/types/styles from directly wired
    // chart nodes, so include only those source configs rather than invalidating
    // every card for an unrelated graph edit.
    let revision = (incidentRevisions[node.id] || []).join("\u001f") || "-";
    if (node.type === "dashboard") {
      const sourceIds: string[] = [];
      for (const edge of incoming) {
        const source = nodeById.get(edge.from.node);
        if (!source || source.type !== "chart") continue;
        sourceIds.push(source.id);
        revision += `\u001e${source.id}:${safeConfigRevision(source)}`;
      }
      dashboardSourceIdsByNode[node.id] = sourceIds;
    }
    renderVersionByNode[node.id] = revision;
  }

  const wires: NodeFlowWire[] = [];
  const edgeById = new Map<string, NbEdge>();
  const incidentMutable = new Map<string, number[]>();
  for (const edge of edges) {
    const fromNode = nodeById.get(edge.from.node);
    const toNode = nodeById.get(edge.to.node);
    if (!fromNode || !toNode) continue;
    const outputIndex = portsOf(fromNode).outputs.indexOf(edge.from.port);
    const inputIndex = portsOf(toNode).inputs.indexOf(edge.to.port);
    const start = portXY(fromNode, "out", outputIndex < 0 ? 0 : outputIndex);
    const end = portXY(
      toNode,
      "in",
      inputIndex < 0 ? 0 : inputIndex,
      visibleInputCountByNode[toNode.id],
    );
    const wireIndex = wires.length;
    wires.push({
      id: edge.id,
      ax: start.x,
      ay: start.y,
      bx: end.x,
      by: end.y,
      fromN: edge.from.node,
      toN: edge.to.node,
      fromPort: edge.from.port,
    });
    edgeById.set(edge.id, edge);
    const fromList = incidentMutable.get(edge.from.node) || [];
    fromList.push(wireIndex);
    incidentMutable.set(edge.from.node, fromList);
    if (edge.to.node !== edge.from.node) {
      const toList = incidentMutable.get(edge.to.node) || [];
      toList.push(wireIndex);
      incidentMutable.set(edge.to.node, toList);
    }
  }

  return {
    nodeById,
    nodeIndexById,
    incomingByNode: incomingMutable,
    incomingCountByNode,
    visibleInputCountByNode,
    renderVersionByNode,
    dashboardSourceIdsByNode,
    wires,
    edgeById,
    incidentWireIndexesByNode: incidentMutable,
  };
}

/**
 * Patch wire endpoints (and port counts) for nodes whose object identity
 * changed — typically a drag/resize RAF — without rebuilding every wire.
 * Returns null when a full rebuild is required (edge list / membership change).
 */
export function patchNodeFlowRenderModelForDirtyNodes(
  prev: NodeFlowRenderModel,
  nodes: readonly NbNode[],
  edges: readonly NbEdge[],
  dirtyIds: ReadonlySet<string>,
): NodeFlowRenderModel | null {
  if (!dirtyIds.size) return prev;
  if (nodes.length !== prev.nodeById.size) return null;
  if (edges.length !== prev.edgeById.size) return null;

  const nodeById = new Map<string, NbNode>();
  const nodeIndexById = new Map<string, number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!prev.nodeById.has(node.id)) return null;
    nodeById.set(node.id, node);
    nodeIndexById.set(node.id, index);
  }

  // Incoming wiring is edge-owned; reuse when the edge list is unchanged.
  const incomingByNode = prev.incomingByNode;
  const incomingCountByNode = prev.incomingCountByNode;
  const visibleInputCountByNode: Record<string, number> = {
    ...prev.visibleInputCountByNode,
  };
  const renderVersionByNode = prev.renderVersionByNode;
  const dashboardSourceIdsByNode = prev.dashboardSourceIdsByNode;
  const edgeById = prev.edgeById;
  const incidentWireIndexesByNode = prev.incidentWireIndexesByNode;

  for (const id of dirtyIds) {
    const node = nodeById.get(id);
    if (!node) return null;
    const incoming = incomingByNode[id] || [];
    visibleInputCountByNode[id] = indexedVisibleInputCount(node, incoming);
  }

  // Copy wires once, then rewrite only indexes incident to dirty nodes.
  const wires = prev.wires.slice();
  const touched = new Set<number>();
  for (const id of dirtyIds) {
    const indexes = incidentWireIndexesByNode.get(id);
    if (!indexes) continue;
    for (const wireIndex of indexes) touched.add(wireIndex);
  }
  for (const wireIndex of touched) {
    const wire = wires[wireIndex];
    if (!wire) continue;
    const fromNode = nodeById.get(wire.fromN);
    const toNode = nodeById.get(wire.toN);
    if (!fromNode || !toNode) continue;
    const edge = edgeById.get(wire.id);
    if (!edge) continue;
    const outputIndex = portsOf(fromNode).outputs.indexOf(edge.from.port);
    const inputIndex = portsOf(toNode).inputs.indexOf(edge.to.port);
    const start = portXY(fromNode, "out", outputIndex < 0 ? 0 : outputIndex);
    const end = portXY(
      toNode,
      "in",
      inputIndex < 0 ? 0 : inputIndex,
      visibleInputCountByNode[toNode.id],
    );
    wires[wireIndex] = {
      id: wire.id,
      ax: start.x,
      ay: start.y,
      bx: end.x,
      by: end.y,
      fromN: wire.fromN,
      toN: wire.toN,
      fromPort: edge.from.port,
    };
  }

  return {
    nodeById,
    nodeIndexById,
    incomingByNode,
    incomingCountByNode,
    visibleInputCountByNode,
    renderVersionByNode,
    dashboardSourceIdsByNode,
    wires,
    edgeById,
    incidentWireIndexesByNode,
  };
}

/** Collect node ids whose object identity changed vs a prior nodes array. */
export function dirtyNodeIdsFromIdentity(
  prevNodes: readonly NbNode[] | null | undefined,
  nodes: readonly NbNode[],
): Set<string> | null {
  if (!prevNodes || prevNodes.length !== nodes.length) return null;
  const dirty = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const prev = prevNodes[index];
    const next = nodes[index];
    if (prev.id !== next.id) return null;
    if (prev !== next) dirty.add(next.id);
  }
  return dirty;
}

/** Config keys that resize updates without changing node semantics. */
const GEOMETRY_CONFIG_KEYS = new Set(["bodyW", "bodyH"]);

/** True when two configs differ only in bodyW/bodyH (resize mid-gesture). */
export function configDiffersOnlyGeometry(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  if (prev === next) return true;
  const a = prev || {};
  const b = next || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (GEOMETRY_CONFIG_KEYS.has(key)) continue;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** True when dirty nodes only moved/resized (same type; config unchanged
 *  except optional bodyW/bodyH). Chart/dashboard config edits must
 *  full-rebuild so render versions see source changes. */
export function dirtyNodesAreGeometryOnly(
  prevNodes: readonly NbNode[],
  nodes: readonly NbNode[],
  dirtyIds: ReadonlySet<string>,
): boolean {
  if (!dirtyIds.size) return true;
  if (prevNodes.length !== nodes.length) return false;
  for (let index = 0; index < nodes.length; index += 1) {
    const next = nodes[index];
    if (!dirtyIds.has(next.id)) continue;
    const prev = prevNodes[index];
    if (!prev || prev.id !== next.id) return false;
    if (prev.type !== next.type) return false;
    if (
      prev.config !== next.config &&
      !configDiffersOnlyGeometry(
        prev.config as Record<string, unknown>,
        next.config as Record<string, unknown>,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function nodeFlowViewBounds(
  viewport: NodeFlowViewport,
  zoom: number,
  overscanPx = LARGE_GRAPH_OVERSCAN_PX,
): NodeFlowViewBounds | null {
  if (
    !Number.isFinite(viewport.w) ||
    !Number.isFinite(viewport.h) ||
    viewport.w <= 0 ||
    viewport.h <= 0
  ) {
    return null;
  }
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const overscan = Math.max(0, overscanPx) / safeZoom;
  return {
    left: viewport.x / safeZoom - overscan,
    top: viewport.y / safeZoom - overscan,
    right: (viewport.x + viewport.w) / safeZoom + overscan,
    bottom: (viewport.y + viewport.h) / safeZoom + overscan,
  };
}

function intersects(
  left: number,
  top: number,
  right: number,
  bottom: number,
  bounds: NodeFlowViewBounds,
): boolean {
  return !(
    left > bounds.right ||
    right < bounds.left ||
    top > bounds.bottom ||
    bottom < bounds.top
  );
}

export function selectVisibleCanvasNodes(
  nodes: readonly NbNode[],
  viewport: NodeFlowViewport,
  zoom: number,
  forcedIds: ReadonlySet<string> = new Set<string>(),
  threshold = LARGE_GRAPH_NODE_THRESHOLD,
  overscanPx = LARGE_GRAPH_OVERSCAN_PX,
  /** React cache key — densify() reads the shared layout flag. */
  denseMode = false,
  /** React cache key — sphere helpers read the shared layout flag. */
  sphereMode = false,
): NbNode[] {
  void denseMode;
  void sphereMode;
  // Under the large-graph threshold, return the same array identity so
  // Scene/WireLayer memo can skip when nothing else changed.
  if (nodes.length <= threshold) return nodes as NbNode[];
  const bounds = nodeFlowViewBounds(viewport, zoom, overscanPx);
  if (!bounds) return nodes as NbNode[];
  return nodes.filter((node) => {
    if (forcedIds.has(node.id)) return true;
    const b = nodeWorldBounds(node);
    return intersects(b.x0, b.y0, b.x1, b.y1, bounds);
  });
}

export function selectVisibleCanvasWires(
  wires: readonly NodeFlowWire[],
  viewport: NodeFlowViewport,
  zoom: number,
  forcedNodeIds: ReadonlySet<string> = new Set<string>(),
  selectedWireId: string | null = null,
  threshold = LARGE_GRAPH_WIRE_THRESHOLD,
  overscanPx = LARGE_GRAPH_OVERSCAN_PX,
): NodeFlowWire[] {
  if (wires.length <= threshold) return wires as NodeFlowWire[];
  const bounds = nodeFlowViewBounds(viewport, zoom, overscanPx);
  if (!bounds) return wires as NodeFlowWire[];

  // The Bezier control points extend about 46 canvas units beyond each endpoint.
  // Keep a little extra margin so a curve crossing the viewport is not clipped
  // merely because both endpoint dots sit just outside the visible rectangle.
  const curveMargin = 56;
  return wires.filter((wire) => {
    if (
      wire.id === selectedWireId ||
      forcedNodeIds.has(wire.fromN) ||
      forcedNodeIds.has(wire.toN)
    ) {
      return true;
    }
    return intersects(
      Math.min(wire.ax, wire.bx) - curveMargin,
      Math.min(wire.ay, wire.by) - curveMargin,
      Math.max(wire.ax, wire.bx) + curveMargin,
      Math.max(wire.ay, wire.by) + curveMargin,
      bounds,
    );
  });
}

export function visibleLeftInputPorts(node: NbNode, visibleCount: number): string[] {
  return PORTS[node.type].inputs
    .slice(0, visibleCount)
    .filter((port) => !isTopInput(node.type, port));
}
