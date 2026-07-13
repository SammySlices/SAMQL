import {
  PORTS,
  isTopInput,
  nodeHeight,
  nodeWidth,
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
}

export const LARGE_GRAPH_NODE_THRESHOLD = 120;
export const LARGE_GRAPH_WIRE_THRESHOLD = 220;
export const LARGE_GRAPH_OVERSCAN_PX = 320;

function indexedVisibleInputCount(
  node: NbNode,
  incoming: readonly NbEdge[],
): number {
  const inputs = PORTS[node.type].inputs;
  if (node.type === "union") return 1;
  if (node.type !== "group") return inputs.length;

  let maxIndex = -1;
  for (const edge of incoming) {
    const index = inputs.indexOf(edge.to.port);
    if (index > maxIndex) maxIndex = index;
  }
  return Math.min(inputs.length, Math.max(1, maxIndex + 2));
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
): NodeFlowRenderModel {
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
  for (const edge of edges) {
    const fromNode = nodeById.get(edge.from.node);
    const toNode = nodeById.get(edge.to.node);
    if (!fromNode || !toNode) continue;
    const outputIndex = PORTS[fromNode.type].outputs.indexOf(edge.from.port);
    const inputIndex = PORTS[toNode.type].inputs.indexOf(edge.to.port);
    const start = portXY(fromNode, "out", outputIndex < 0 ? 0 : outputIndex);
    const end = portXY(
      toNode,
      "in",
      inputIndex < 0 ? 0 : inputIndex,
      visibleInputCountByNode[toNode.id],
    );
    wires.push({
      id: edge.id,
      ax: start.x,
      ay: start.y,
      bx: end.x,
      by: end.y,
      fromN: edge.from.node,
      toN: edge.to.node,
    });
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
  };
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
): NbNode[] {
  if (nodes.length <= threshold) return nodes.slice();
  const bounds = nodeFlowViewBounds(viewport, zoom, overscanPx);
  if (!bounds) return nodes.slice();
  return nodes.filter(
    (node) =>
      forcedIds.has(node.id) ||
      intersects(
        node.x,
        node.y,
        node.x + nodeWidth(node),
        node.y + nodeHeight(node),
        bounds,
      ),
  );
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
  if (wires.length <= threshold) return wires.slice();
  const bounds = nodeFlowViewBounds(viewport, zoom, overscanPx);
  if (!bounds) return wires.slice();

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
