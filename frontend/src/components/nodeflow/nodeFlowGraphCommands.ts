import { uid } from "../../lib/ids";
import {
  GROUP_W,
  NODE_W,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import { createDefaultNodeConfig } from "./nodeDefinitions";

export interface NodeFlowGraphState {
  nodes: NbNode[];
  edges: NbEdge[];
}

export interface ChildNodeContext {
  groupId: string;
  index: number;
  child: NbNode;
}

export function findChildNode(
  nodes: NbNode[],
  id: string | null,
): ChildNodeContext | null {
  if (!id) return null;
  for (const group of nodes) {
    if (group.type !== "group" && group.type !== "iterator") continue;
    const children = (group.config.children || []) as any[];
    const index = children.findIndex((child) => child?.id === id);
    if (index >= 0) {
      const child = children[index];
      return {
        groupId: group.id,
        index,
        child: {
          id: child.id,
          type: child.type,
          x: 0,
          y: 0,
          config: child.config || {},
        },
      };
    }
  }
  return null;
}

export function createGraphNode(
  type: NodeType,
  x: number,
  y: number,
  id = uid(),
): NbNode {
  return {
    id,
    type,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    config: createDefaultNodeConfig(type),
  };
}

export function patchNodeConfig(
  nodes: NbNode[],
  id: string,
  config: Record<string, any>,
): NbNode[] {
  const child = findChildNode(nodes, id);
  if (child) {
    return nodes.map((node) => {
      if (node.id !== child.groupId) return node;
      const children = [...((node.config.children || []) as any[])];
      const index = children.findIndex((item) => item?.id === id);
      if (index < 0) return node;
      children[index] = {
        ...children[index],
        config: { ...(children[index].config || {}), ...config },
      };
      return { ...node, config: { ...node.config, children } };
    });
  }
  return nodes.map((node) =>
    node.id === id
      ? { ...node, config: { ...node.config, ...config } }
      : node,
  );
}

export function appendGroupChild(
  nodes: NbNode[],
  groupId: string,
  type: NodeType,
  childId = uid(),
): { nodes: NbNode[]; childId: string } {
  const child = {
    id: childId,
    type,
    config: createDefaultNodeConfig(type),
  };
  return {
    childId,
    nodes: nodes.map((node) =>
      node.id === groupId
        ? {
            ...node,
            config: {
              ...node.config,
              children: [...((node.config.children || []) as any[]), child],
            },
          }
        : node,
    ),
  };
}

export function removeGroupChild(
  nodes: NbNode[],
  groupId: string,
  childId: string,
): NbNode[] {
  return nodes.map((node) =>
    node.id === groupId
      ? {
          ...node,
          config: {
            ...node.config,
            children: ((node.config.children || []) as any[]).filter(
              (child) => child?.id !== childId,
            ),
          },
        }
      : node,
  );
}

export function reorderGroupChildren(
  nodes: NbNode[],
  groupId: string,
  from: number,
  to: number,
): NbNode[] {
  return nodes.map((node) => {
    if (node.id !== groupId) return node;
    const children = [...((node.config.children || []) as any[])];
    if (from < 0 || from >= children.length || to < 0 || to > children.length) {
      return node;
    }
    const [moved] = children.splice(from, 1);
    children.splice(to > from ? to - 1 : to, 0, moved);
    return { ...node, config: { ...node.config, children } };
  });
}

export function extractGroupChild(
  nodes: NbNode[],
  groupId: string,
  childId: string,
): { nodes: NbNode[]; extractedId: string | null } {
  const group = nodes.find((node) => node.id === groupId);
  if (!group) return { nodes, extractedId: null };
  const child = ((group.config.children || []) as any[]).find(
    (item) => item?.id === childId,
  );
  if (!child) return { nodes, extractedId: null };
  const x = Math.max(0, Math.min(group.x + GROUP_W + 40, 2980));
  const y = Math.max(0, group.y + 10);
  const next = removeGroupChild(nodes, groupId, childId).concat([
    {
      id: child.id,
      type: child.type,
      x,
      y,
      config: child.config || {},
    } as NbNode,
  ]);
  return { nodes: next, extractedId: child.id };
}

export function dissolveContainerGraph(
  nodes: NbNode[],
  edges: NbEdge[],
  id: string,
): { graph: NodeFlowGraphState; selectedId: string | null } {
  const container = nodes.find((node) => node.id === id);
  if (!container) return { graph: { nodes, edges }, selectedId: null };
  const children = ((container.config.children || []) as any[]).filter(
    (child) => child?.id,
  );
  if (!children.length) return { graph: { nodes, edges }, selectedId: null };
  const step = NODE_W + 48;
  const placed = children.map(
    (child, index): NbNode => ({
      id: child.id,
      type: child.type as NodeType,
      x: Math.max(0, Math.min(container.x + index * step, 3200)),
      y: Math.max(0, container.y),
      config: child.config || {},
    }),
  );
  return {
    graph: {
      nodes: nodes.filter((node) => node.id !== id).concat(placed),
      edges: edges.filter(
        (edge) => edge.from.node !== id && edge.to.node !== id,
      ),
    },
    selectedId: placed[0]?.id || null,
  };
}

export function removeGraphNodes(
  nodes: NbNode[],
  edges: NbEdge[],
  ids: Iterable<string>,
): NodeFlowGraphState {
  const removed = new Set(ids);
  return {
    nodes: nodes.filter((node) => !removed.has(node.id)),
    edges: edges.filter(
      (edge) => !removed.has(edge.from.node) && !removed.has(edge.to.node),
    ),
  };
}

export function moveNodeIntoContainer(
  nodes: NbNode[],
  edges: NbEdge[],
  nodeId: string,
  groupId: string,
): NodeFlowGraphState {
  const moved = nodes.find((node) => node.id === nodeId);
  const container = nodes.find((node) => node.id === groupId);
  if (
    !moved ||
    !container ||
    (container.type !== "group" && container.type !== "iterator") ||
    moved.type === "group" ||
    moved.type === "iterator"
  ) {
    return { nodes, edges };
  }
  return {
    nodes: nodes
      .filter((node) => node.id !== nodeId)
      .map((node) =>
        node.id === groupId
          ? {
              ...node,
              config: {
                ...node.config,
                children: [
                  ...((node.config.children || []) as any[]),
                  { id: moved.id, type: moved.type, config: moved.config },
                ],
              },
            }
          : node,
      ),
    edges: edges.filter(
      (edge) => edge.from.node !== nodeId && edge.to.node !== nodeId,
    ),
  };
}
