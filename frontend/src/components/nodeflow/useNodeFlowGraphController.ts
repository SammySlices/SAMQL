import React, { useCallback } from "react";
import { uid } from "../../lib/ids";
import { serializeGraph } from "../../lib/nodegraph";
import {
  NODE_W,
  HEAD_H,
  nodeWidth,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import type { DeleteConfirmState } from "./NodeFlowMenus";
import type { NodeFlowSnapshot } from "./useNodeFlowDocumentController";
import {
  appendGroupChild,
  createGraphNode,
  dissolveContainerGraph,
  extractGroupChild,
  findChildNode,
  moveNodeIntoContainer,
  patchNodeConfig,
  removeGraphNodes,
  removeGroupChild,
  reorderGroupChildren,
} from "./nodeFlowGraphCommands";

interface UseNodeFlowGraphControllerOptions {
  nodesRef: React.MutableRefObject<NbNode[]>;
  edgesRef: React.MutableRefObject<NbEdge[]>;
  liveRef: React.MutableRefObject<NodeFlowSnapshot>;
  setNodes: React.Dispatch<React.SetStateAction<NbNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<NbEdge[]>>;
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setNodeErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setDeleteConfirm: React.Dispatch<React.SetStateAction<DeleteConfirmState | null>>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  zoomRef: React.MutableRefObject<number>;
  fireBorn: (id: string) => void;
  withImplosion: (ids: string[], commit: () => void) => void;
}

export function useNodeFlowGraphController({
  nodesRef,
  edgesRef,
  liveRef,
  setNodes,
  setEdges,
  selectedId,
  setSelectedId,
  setSelectedIds,
  setNodeErrors,
  setDeleteConfirm,
  contentRef,
  zoomRef,
  fireBorn,
  withImplosion,
}: UseNodeFlowGraphControllerOptions) {
  const syncNodes = useCallback(
    (next: NbNode[]) => {
      nodesRef.current = next;
      liveRef.current = { nodes: next, edges: edgesRef.current };
      return next;
    },
    [edgesRef, liveRef, nodesRef],
  );

  const commitGraph = useCallback(
    (next: NodeFlowSnapshot) => {
      nodesRef.current = next.nodes;
      edgesRef.current = next.edges;
      liveRef.current = next;
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [edgesRef, liveRef, nodesRef, setEdges, setNodes],
  );

  const addNodeAt = useCallback(
    (type: NodeType, x: number, y: number) => {
      const node = createGraphNode(type, x, y);
      setNodes((current) => syncNodes([...current, node]));
      setSelectedId(node.id);
      fireBorn(node.id);
    },
    [fireBorn, setNodes, setSelectedId, syncNodes],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      const index = nodesRef.current.length;
      addNodeAt(type, 80 + (index % 5) * 60, 70 + (index % 5) * 54);
    },
    [addNodeAt, nodesRef],
  );

  const patch = useCallback(
    (id: string, config: Record<string, any>) => {
      setNodeErrors((current) => {
        if (!(id in current)) return current;
        const { [id]: _drop, ...rest } = current;
        return rest;
      });
      setNodes((current) => syncNodes(patchNodeConfig(current, id, config)));
    },
    [setNodeErrors, setNodes, syncNodes],
  );

  const groupAddChild = useCallback(
    (groupId: string, type: NodeType) => {
      const childId = uid();
      setNodes((current) =>
        syncNodes(appendGroupChild(current, groupId, type, childId).nodes),
      );
      setSelectedId(childId);
    },
    [setNodes, setSelectedId, syncNodes],
  );

  const groupRemoveChild = useCallback(
    (groupId: string, childId: string) => {
      setNodes((current) =>
        syncNodes(removeGroupChild(current, groupId, childId)),
      );
    },
    [setNodes, syncNodes],
  );

  const groupReorder = useCallback(
    (groupId: string, from: number, to: number) => {
      setNodes((current) =>
        syncNodes(reorderGroupChildren(current, groupId, from, to)),
      );
    },
    [setNodes, syncNodes],
  );

  const partialGroupGraph = useCallback(
    (groupId: string, count: number) => {
      const graph = serializeGraph(
        nodesRef.current as any,
        edgesRef.current as any,
      ) as any;
      return {
        ...graph,
        nodes: graph.nodes.map((node: any) =>
          node.id === groupId
            ? {
                ...node,
                config: {
                  ...node.config,
                  children: ((node.config.children || []) as any[]).slice(
                    0,
                    count,
                  ),
                },
              }
            : node,
        ),
      };
    },
    [edgesRef, nodesRef],
  );

  const extractChildToCanvas = useCallback(
    (groupId: string, childId: string) => {
      const result = extractGroupChild(nodesRef.current, groupId, childId);
      if (!result.extractedId) return;
      setNodes(syncNodes(result.nodes));
      setSelectedId(result.extractedId);
    },
    [nodesRef, setNodes, setSelectedId, syncNodes],
  );

  const dissolveContainer = useCallback(
    (id: string) => {
      const result = dissolveContainerGraph(
        nodesRef.current,
        edgesRef.current,
        id,
      );
      if (!result.selectedId) return;
      commitGraph(result.graph);
      setSelectedId(result.selectedId);
      setSelectedIds([]);
    },
    [commitGraph, edgesRef, nodesRef, setSelectedId, setSelectedIds],
  );

  const doRemoveNode = useCallback(
    (id: string) => {
      const child = findChildNode(nodesRef.current, id);
      if (child) {
        groupRemoveChild(child.groupId, id);
        if (selectedId === id) setSelectedId(null);
        return;
      }
      withImplosion([id], () => {
        commitGraph(
          removeGraphNodes(nodesRef.current, edgesRef.current, [id]),
        );
      });
      const currentSelection = findChildNode(nodesRef.current, selectedId);
      if (selectedId === id || currentSelection?.groupId === id) {
        setSelectedId(null);
      }
    },
    [
      commitGraph,
      edgesRef,
      groupRemoveChild,
      nodesRef,
      selectedId,
      setSelectedId,
      withImplosion,
    ],
  );

  const removeNode = useCallback(
    (id: string) => {
      const popupWidth = 188;
      const child = findChildNode(nodesRef.current, id);
      const anchorId = child ? child.groupId : id;
      const node = nodesRef.current.find((item) => item.id === anchorId);
      const canvasRect = contentRef.current?.getBoundingClientRect();
      if (!node || !canvasRect) {
        setDeleteConfirm({
          id,
          left: Math.round(window.innerWidth / 2 - popupWidth / 2),
          top: 110,
          side: "right",
        });
        return;
      }
      const zoom = zoomRef.current || 1;
      const nodeLeft = canvasRect.left + node.x * zoom;
      const nodeTop = canvasRect.top + node.y * zoom;
      const renderedWidth = nodeWidth(node) * zoom;
      const center = nodeLeft + renderedWidth / 2;
      const side: "left" | "right" =
        center < window.innerWidth / 2 ? "right" : "left";
      let left =
        side === "right"
          ? nodeLeft + renderedWidth + 12
          : nodeLeft - popupWidth - 12;
      left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
      let top = Math.max(8, Math.min(nodeTop - 14, window.innerHeight - 130));
      setDeleteConfirm({ id, left, top, side });
    },
    [contentRef, nodesRef, setDeleteConfirm, zoomRef],
  );

  const reallyDeleteMany = useCallback(
    (ids: string[]) => {
      withImplosion(ids, () => {
        commitGraph(removeGraphNodes(nodesRef.current, edgesRef.current, ids));
      });
      setSelectedIds([]);
      setSelectedId(null);
    },
    [
      commitGraph,
      edgesRef,
      nodesRef,
      setSelectedId,
      setSelectedIds,
      withImplosion,
    ],
  );

  const deleteMany = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      setDeleteConfirm({
        left: Math.round(window.innerWidth / 2 - 94),
        top: 110,
        side: "right",
        msg: `Delete ${ids.length} nodes?`,
        onOk: () => reallyDeleteMany(ids),
      });
    },
    [reallyDeleteMany, setDeleteConfirm],
  );

  const moveNodeIntoGroup = useCallback(
    (nodeId: string, groupId: string) => {
      const next = moveNodeIntoContainer(
        nodesRef.current,
        edgesRef.current,
        nodeId,
        groupId,
      );
      if (next.nodes === nodesRef.current) return;
      commitGraph(next);
      setSelectedId(nodeId);
    },
    [commitGraph, edgesRef, nodesRef, setSelectedId],
  );

  return {
    addNodeAt,
    addNode,
    patch,
    groupAddChild,
    groupRemoveChild,
    groupReorder,
    partialGroupGraph,
    extractChildToCanvas,
    dissolveContainer,
    doRemoveNode,
    removeNode,
    deleteMany,
    reallyDeleteMany,
    moveNodeIntoGroup,
    canvasDropOffset: { x: NODE_W / 2, y: HEAD_H },
  };
}
