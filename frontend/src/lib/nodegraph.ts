// Pure geometry + graph helpers for the node canvas (the "Node" view).
//
// These were extracted out of NodeFlow.tsx so the behaviour that backs wiring,
// snap-to-connect, marquee multi-select, viewport clamping and the graph we
// send to the backend can be unit-tested under Node without a browser. Nothing
// here touches React, the DOM, or component state -- everything operates on
// plain numbers and shapes, and NodeFlow imports these so the tests exercise
// the real code paths.

// Cubic-bezier connector path between an output point (x1,y1) and an input
// point (x2,y2). The 46px horizontal handles give the wires their S-curve.
export function wirePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  return `M ${x1} ${y1} C ${x1 + 46} ${y1}, ${x2 - 46} ${y2}, ${x2} ${y2}`;
}

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ids of boxes that intersect the marquee rectangle. The rect corners are
// unordered (drag can go any direction), so we normalise first. A box counts
// as hit if it overlaps the rect at all (touching edges included).
export function marqueeHits(boxes: Box[], rect: MarqueeRect): string[] {
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  return boxes
    .filter(
      (b) =>
        !(b.x > maxX || b.x + b.w < minX || b.y > maxY || b.y + b.h < minY),
    )
    .map((b) => b.id);
}

export interface PortPoint {
  node: string;
  port: string;
  x: number;
  y: number;
}

// The input port closest to (x,y), but only if it's within maxDist (canvas
// units). Powers snap-to-connect: a wire dropped near an input lands on it
// instead of needing a pixel-perfect hit. Returns null when nothing is close.
export function nearestPort(
  ports: PortPoint[],
  x: number,
  y: number,
  maxDist: number,
): { node: string; port: string } | null {
  let best: { node: string; port: string } | null = null;
  let bestD = maxDist;
  for (const p of ports) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = { node: p.node, port: p.port };
    }
  }
  return best;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Clamp a point into a box. Used to keep the marquee inside the visible canvas
// viewport so it can't be drawn over the side panels.
export function clampPointToBox(
  x: number,
  y: number,
  b: Bounds,
): { x: number; y: number } {
  return {
    x: Math.max(b.left, Math.min(b.right, x)),
    y: Math.max(b.top, Math.min(b.bottom, y)),
  };
}

export interface GraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  // x/y and other fields may be present; they are intentionally dropped.
  [k: string]: unknown;
}
export interface GraphEdge {
  from: unknown;
  to: unknown;
  [k: string]: unknown;
}

// The shape sent to the backend: only id/type/config per node and from/to per
// edge (positions and UI-only fields are stripped so dragging a node around
// doesn't change the graph signature the executor sees).
export function serializeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): {
  nodes: { id: string; type: string; config: Record<string, unknown> }[];
  edges: { from: unknown; to: unknown }[];
} {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, config: n.config })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

/**
 * UI-only NodeFlow config keys. Changing these must NOT invalidate columns
 * probes, Select reconcile / missing-fields, or preview cache. Keep selected
 * fields, renames, formulas, joins, filters, sql, disabled, input table, etc.
 */
export const NODEFLOW_COSMETIC_CONFIG_KEYS = [
  "bodyW",
  "bodyH",
  "label",
  "style",
  "collapsed",
] as const;

const COSMETIC_KEY_SET = new Set<string>(NODEFLOW_COSMETIC_CONFIG_KEYS);

/** Drop cosmetic keys from a node config (shallow). */
export function stripCosmeticNodeConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const src = config || {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (COSMETIC_KEY_SET.has(key)) continue;
    out[key] = src[key];
  }
  return out;
}

/**
 * Graph fingerprint for columns / missing-fields reconcile / preview cache.
 * Same wiring + schema-affecting config as ``serializeGraph``, minus cosmetics.
 */
export function serializeGraphForExecution(
  nodes: GraphNode[],
  edges: GraphEdge[],
): {
  nodes: { id: string; type: string; config: Record<string, unknown> }[];
  edges: { from: unknown; to: unknown }[];
} {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      config: stripCosmeticNodeConfig(n.config),
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

export function executionGraphSignature(
  nodes: GraphNode[],
  edges: GraphEdge[],
): string {
  return JSON.stringify(serializeGraphForExecution(nodes, edges));
}
