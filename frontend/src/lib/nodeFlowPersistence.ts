import {
  TAB_KEY,
  serializeNodeFlowGraph,
  type NbEdge,
  type NbNode,
} from "./nodeFlowModel";

export type NodeFlowSnapshot = { nodes: NbNode[]; edges: NbEdge[] };

/**
 * Persist one NodeFlow canvas atomically from the caller's latest snapshot.
 * Returns false when Web Storage is unavailable/full instead of letting a
 * lifecycle event throw during pagehide/unmount.
 */
export function persistNodeFlowSnapshot(
  storage: Storage | null | undefined,
  tabId: string,
  snapshot: NodeFlowSnapshot,
): boolean {
  if (!storage || !tabId) return false;
  try {
    storage.setItem(
      TAB_KEY(tabId),
      JSON.stringify(serializeNodeFlowGraph(snapshot.nodes, snapshot.edges)),
    );
    return true;
  } catch {
    return false;
  }
}
