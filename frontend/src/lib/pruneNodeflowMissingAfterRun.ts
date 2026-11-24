// Post-run cleanup of missing upstream column refs. Schema refresh keeps
// struck-through tombstones; a successful NodeFlow run/rerun is when obsolete
// refs are pruned from configs.

import {
  clearMissingSelectFields,
  fieldsDiffer,
  type SelField,
} from "./selectFields";
import { reconcilePivotFields } from "./pivotFields";
import {
  clearStaleNodeflowColumnRefs,
  STALE_REF_NODE_TYPES,
  staleNodeflowColumnRefs,
} from "./staleNodeflowColumnRefs";
import { PORTS, type NbEdge, type NbNode, type NodeType } from "./nodeFlowModel";

const PRUNE_TYPES = new Set<NodeType>([
  "select",
  "pivot",
  ...STALE_REF_NODE_TYPES,
]);

/** Ancestor closure of terminal node ids (includes the terminals). */
export function ancestorNodeIds(
  edges: NbEdge[],
  terminalIds: Iterable<string>,
): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of edges || []) {
    const list = incoming.get(e.to.node) || [];
    list.push(e.from.node);
    incoming.set(e.to.node, list);
  }
  const out = new Set<string>();
  const stack = [...terminalIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const p of incoming.get(id) || []) stack.push(p);
  }
  return out;
}

/**
 * Probe requests for each input port of nodes in `nodeIds` that can hold
 * column refs (select / pivot / stale-ref types).
 */
/** Config signature per target id (top-level and group/iterator children). */
export function pruneConfigSnapshot(
  nodes: NbNode[],
  targetIds: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const sig = (c: unknown) => JSON.stringify(c ?? {});
  for (const n of nodes || []) {
    if (targetIds.has(n.id)) out.set(n.id, sig(n.config));
    if (n.type !== "group" && n.type !== "iterator") continue;
    for (const child of (n.config?.children || []) as any[]) {
      if (child?.id && targetIds.has(child.id)) out.set(child.id, sig(child.config));
    }
  }
  return out;
}

/** Incoming-edge signature per node id. */
export function incomingEdgeSig(edges: NbEdge[], id: string): string {
  return (edges || [])
    .filter((e) => e.to.node === id)
    .map((e) => `${e.from.node}.${e.from.port}>${e.to.port}`)
    .sort()
    .join("|");
}

export function columnProbeReqsForNodes(
  nodes: NbNode[],
  edges: NbEdge[],
  nodeIds: Set<string>,
): { nodeId: string; port: string; fromNode: string; fromPort: string }[] {
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const out: {
    nodeId: string;
    port: string;
    fromNode: string;
    fromPort: string;
  }[] = [];
  for (const id of nodeIds) {
    const n = byId.get(id);
    if (!n || !PRUNE_TYPES.has(n.type)) continue;
    const inputs = PORTS[n.type]?.inputs || [];
    for (const port of inputs) {
      const e = (edges || []).find(
        (x) => x.to.node === id && x.to.port === port,
      );
      if (!e) continue;
      out.push({
        nodeId: id,
        port,
        fromNode: e.from.node,
        fromPort: e.from.port,
      });
    }
  }
  return out;
}

/** Apply missing-ref prune for one node given its live upstream columns. */
export function pruneNodeConfigMissingRefs(
  nodeType: NodeType,
  config: Record<string, any>,
  upstreamCols: Record<string, string[]>,
): Record<string, any> | null {
  const cfg = config || {};
  if (nodeType === "select") {
    const cur = (cfg.fields || []) as SelField[];
    const fields = clearMissingSelectFields(cur, upstreamCols.in);
    if (!fieldsDiffer(fields, cur)) return null;
    return { ...cfg, fields };
  }
  if (nodeType === "pivot") {
    const { patch, changed } = reconcilePivotFields(
      upstreamCols.in || [],
      cfg,
    );
    return changed ? { ...cfg, ...patch } : null;
  }
  const stale = staleNodeflowColumnRefs(nodeType, cfg, upstreamCols);
  if (!stale.length) return null;
  return clearStaleNodeflowColumnRefs(nodeType, cfg, stale);
}

/**
 * Patch top-level nodes (and select/pivot children inside group/iterator)
 * whose ids are in `targetIds`, using per-node upstream column maps.
 * Returns a new nodes array when anything changed, else the same reference.
 */
export function applyMissingRefPruneToNodes<T extends NbNode>(
  nodes: T[],
  targetIds: Set<string>,
  colsByNodeId: Record<string, Record<string, string[]>>,
  // M-2: when given, a node (or group child) is pruned only while its config
  // still matches the snapshot the columns were probed for.
  unchangedSince?: (id: string, config: unknown) => boolean,
): T[] {
  const ok = (id: string, config: unknown) =>
    !unchangedSince || unchangedSince(id, config);
  let changed = false;
  const next = (nodes || []).map((n) => {
    let node = n;
    if (targetIds.has(n.id) && colsByNodeId[n.id] && ok(n.id, n.config)) {
      const pruned = pruneNodeConfigMissingRefs(
        n.type,
        n.config || {},
        colsByNodeId[n.id],
      );
      if (pruned) {
        changed = true;
        node = { ...n, config: pruned } as T;
      }
    }
    if (n.type !== "group" && n.type !== "iterator") return node;
    const children = [...((node.config?.children || []) as any[])];
    let childChanged = false;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child?.id || !targetIds.has(child.id)) continue;
      const cols = colsByNodeId[child.id];
      if (!cols || !ok(child.id, child.config)) continue;
      const pruned = pruneNodeConfigMissingRefs(
        child.type,
        child.config || {},
        cols,
      );
      if (!pruned) continue;
      children[i] = { ...child, config: pruned };
      childChanged = true;
    }
    if (!childChanged) return node;
    changed = true;
    return {
      ...node,
      config: { ...node.config, children },
    } as T;
  });
  return changed ? next : nodes;
}
