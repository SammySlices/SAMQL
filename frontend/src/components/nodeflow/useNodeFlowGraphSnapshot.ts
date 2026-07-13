import { useCallback, useRef } from "react";
import { serializeGraph } from "../../lib/nodegraph";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";

type ApiGraph = ReturnType<typeof serializeGraph>;

type NodeStructureKey = {
  id: string;
  type: string;
  config: Record<string, unknown>;
};

type EdgeStructureKey = {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
};

export interface NodeFlowGraphSnapshot {
  graph: ApiGraph;
  signature: string;
  nodeKeys: NodeStructureKey[];
  edgeKeys: EdgeStructureKey[];
}

function sameNodeStructure(
  keys: NodeStructureKey[],
  nodes: NbNode[],
): boolean {
  if (keys.length !== nodes.length) return false;
  for (let index = 0; index < nodes.length; index += 1) {
    const key = keys[index];
    const node = nodes[index];
    if (
      key.id !== node.id ||
      key.type !== node.type ||
      key.config !== node.config
    ) {
      return false;
    }
  }
  return true;
}

function sameEdgeStructure(
  keys: EdgeStructureKey[],
  edges: NbEdge[],
): boolean {
  if (keys.length !== edges.length) return false;
  for (let index = 0; index < edges.length; index += 1) {
    const key = keys[index];
    const edge = edges[index];
    if (
      key.id !== edge.id ||
      key.fromNode !== edge.from.node ||
      key.fromPort !== edge.from.port ||
      key.toNode !== edge.to.node ||
      key.toPort !== edge.to.port
    ) {
      return false;
    }
  }
  return true;
}

export function nodeFlowSnapshotMatches(
  snapshot: NodeFlowGraphSnapshot,
  nodes: NbNode[],
  edges: NbEdge[],
): boolean {
  return (
    sameNodeStructure(snapshot.nodeKeys, nodes) &&
    sameEdgeStructure(snapshot.edgeKeys, edges)
  );
}

export function createNodeFlowGraphSnapshot(
  nodes: NbNode[],
  edges: NbEdge[],
): NodeFlowGraphSnapshot {
  const graph = serializeGraph(nodes as any, edges as any);
  return {
    graph,
    signature: JSON.stringify(graph),
    nodeKeys: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      config: node.config,
    })),
    edgeKeys: edges.map((edge) => ({
      id: edge.id,
      fromNode: edge.from.node,
      fromPort: edge.from.port,
      toNode: edge.to.node,
      toPort: edge.to.port,
    })),
  };
}

// Node positions change on every drag frame, but the backend graph excludes
// x/y. Cache the serialized graph by structural identity so dragging does not
// stringify every node config and edge over and over on the main thread.
export function useNodeFlowGraphSnapshot(nodes: NbNode[], edges: NbEdge[]) {
  const cacheRef = useRef<NodeFlowGraphSnapshot | null>(null);
  if (
    cacheRef.current === null ||
    !nodeFlowSnapshotMatches(cacheRef.current, nodes, edges)
  ) {
    cacheRef.current = createNodeFlowGraphSnapshot(nodes, edges);
  }
  const snapshot = cacheRef.current;
  const graphForApi = useCallback(() => snapshot.graph, [snapshot]);
  return {
    graphForApi,
    graphSig: snapshot.signature,
    apiGraph: snapshot.graph,
  };
}
