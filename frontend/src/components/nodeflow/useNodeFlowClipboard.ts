import React, { useCallback, useRef } from "react";
import { uid } from "../../lib/ids";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";

interface UseNodeFlowClipboardOptions {
  nodesRef: React.RefObject<NbNode[]>;
  edgesRef: React.RefObject<NbEdge[]>;
  selectedId: string | null;
  selectedIdsRef: React.RefObject<string[]>;
  setNodes: React.Dispatch<React.SetStateAction<NbNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<NbEdge[]>>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
}

type ClipboardGraph = { nodes: NbNode[]; edges: NbEdge[] };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function useNodeFlowClipboard({
  nodesRef,
  edgesRef,
  selectedId,
  selectedIdsRef,
  setNodes,
  setEdges,
  setSelectedId,
  setSelectedIds,
}: UseNodeFlowClipboardOptions) {
  const clipboardRef = useRef<ClipboardGraph | null>(null);
  const [clipboardVersion, setClipboardVersion] = React.useState(0);

  const copySelection = useCallback(() => {
    const ids = selectedIdsRef.current?.length
      ? selectedIdsRef.current
      : selectedId
        ? [selectedId]
        : [];
    const selected = new Set(ids);
    const nodes = (nodesRef.current || []).filter((node) => selected.has(node.id));
    if (!nodes.length) return false;
    const edges = (edgesRef.current || []).filter(
      (edge) => selected.has(edge.from.node) && selected.has(edge.to.node),
    );
    clipboardRef.current = clone({ nodes, edges });
    setClipboardVersion((version) => version + 1);
    return true;
  }, [edgesRef, nodesRef, selectedId, selectedIdsRef]);

  const pasteClipboard = useCallback(
    (at?: { x: number; y: number }) => {
      const clipboard = clipboardRef.current;
      if (!clipboard?.nodes.length) return [] as string[];

      let dx = 30;
      let dy = 30;
      if (at) {
        const minX = Math.min(...clipboard.nodes.map((node) => node.x || 0));
        const minY = Math.min(...clipboard.nodes.map((node) => node.y || 0));
        dx = at.x - minX;
        dy = at.y - minY;
      }

      const idMap: Record<string, string> = {};
      const nodes = clipboard.nodes.map((node): NbNode => {
        const id = uid();
        idMap[node.id] = id;
        const config = clone(node.config || {});
        if (
          (node.type === "group" || node.type === "iterator") &&
          Array.isArray(config.children)
        ) {
          // Children get fresh ids; anything keyed by a child id must follow.
          // `config.bindings` maps childId -> {inputPort: groupInputPort} and is
          // read that way by the backend group planner, so leaving it on the old
          // ids silently drops every explicit step-input binding (a bound join
          // side falls back to linear chaining and the paste computes different
          // results than the original).
          const childIdMap: Record<string, string> = {};
          config.children = config.children.map((child: Record<string, unknown>) => {
            const newId = uid();
            const oldId = child.id;
            if (typeof oldId === "string") childIdMap[oldId] = newId;
            return { ...child, id: newId };
          });
          const bindings = config.bindings;
          if (bindings && typeof bindings === "object") {
            const remapped: Record<string, unknown> = {};
            for (const [childId, value] of Object.entries(bindings)) {
              remapped[childIdMap[childId] ?? childId] = value;
            }
            config.bindings = remapped;
          }
        }
        return {
          id,
          type: node.type,
          x: Math.max(0, Math.min((node.x || 0) + dx, 2980)),
          y: Math.max(0, (node.y || 0) + dy),
          config,
        };
      });
      const edges = clipboard.edges
        .map(
          (edge): NbEdge => ({
            id: uid(),
            from: { node: idMap[edge.from.node], port: edge.from.port },
            to: { node: idMap[edge.to.node], port: edge.to.port },
          }),
        )
        .filter((edge) => edge.from.node && edge.to.node);

      setNodes((current) => [...current, ...nodes]);
      setEdges((current) => [...current, ...edges]);
      const ids = nodes.map((node) => node.id);
      setSelectedIds(ids);
      setSelectedId(ids.length === 1 ? ids[0] : null);
      return ids;
    },
    [setEdges, setNodes, setSelectedId, setSelectedIds],
  );

  return {
    clipboardRef,
    clipboardVersion,
    canPaste: clipboardVersion >= 0 && !!clipboardRef.current?.nodes.length,
    copySelection,
    pasteClipboard,
  };
}
