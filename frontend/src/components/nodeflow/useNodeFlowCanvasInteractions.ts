import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { uid } from "../../lib/ids";
import { startPointerDrag } from "../../lib/pointerDrag";
import {
  clampPointToBox,
  marqueeHits,
  nearestPort,
} from "../../lib/nodegraph";
import {
  CHART_BODY_H,
  DASH_BODY_H,
  HEAD_H,
  NODE_W,
  PORTS,
  SQL_BODY_H,
  nodeHeight,
  nodeWidth,
  portXY,
  visibleInputCount,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";

export interface NodeFlowMarquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type NodeDrag = {
  mode: "node";
  nodeId: string;
  ids: string[];
  origins: Record<string, { x: number; y: number }>;
  startX: number;
  startY: number;
};
type WireDrag = {
  mode: "wire";
  fromNode: string;
  fromPort: string;
  startX: number;
  startY: number;
};
type PanDrag = {
  mode: "pan";
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
};
type MarqueeDrag = {
  mode: "marquee";
  x0: number;
  y0: number;
  ids: string[];
};
export type NodeFlowDragState = NodeDrag | WireDrag | PanDrag | MarqueeDrag;

interface UseNodeFlowCanvasInteractionsOptions {
  nodesRef: React.RefObject<NbNode[]>;
  edgesRef: React.RefObject<NbEdge[]>;
  selectedIdsRef: React.RefObject<string[]>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  zoomRef: React.RefObject<number>;
  doPreviewRef: React.RefObject<
    | ((node: NbNode, port: string, title: string) => void)
    | null
  >;
  setNodes: React.Dispatch<React.SetStateAction<NbNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<NbEdge[]>>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedEdge: React.Dispatch<React.SetStateAction<string | null>>;
  moveNodeIntoGroup: (nodeId: string, groupId: string) => void;
  patchNode: (id: string, config: Record<string, unknown>) => void;
  onToast: (
    kind: "ok" | "error" | "warn",
    title: string,
    message?: string,
  ) => void;
}

export function useNodeFlowCanvasInteractions(
  options: UseNodeFlowCanvasInteractionsOptions,
) {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const dragRef = useRef<NodeFlowDragState | null>(null);
  const hoverInputRef = useRef<{ node: string; port: string } | null>(null);
  const [groupHover, setGroupHover] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<NodeFlowMarquee | null>(null);
  const [wireEnd, setWireEnd] = useState<{ x: number; y: number } | null>(null);
  const [snap, setSnap] = useState(false);
  const snapRef = useRef(false);
  const [snapId, setSnapId] = useState<string | null>(null);
  const snapTimer = useRef<number | null>(null);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  useEffect(
    () => () => {
      if (snapTimer.current != null) window.clearTimeout(snapTimer.current);
    },
    [],
  );

  const fireSnap = useCallback((id: string) => {
    if (snapTimer.current != null) window.clearTimeout(snapTimer.current);
    setSnapId(null);
    requestAnimationFrame(() => setSnapId(id));
    snapTimer.current = window.setTimeout(() => {
      setSnapId(null);
      snapTimer.current = null;
    }, 360);
  }, []);

  const toContent = useCallback((clientX: number, clientY: number) => {
    const current = optionsRef.current;
    const rect = current.contentRef.current?.getBoundingClientRect();
    const zoom = current.zoomRef.current || 1;
    return {
      x: (clientX - (rect?.left || 0)) / zoom,
      y: (clientY - (rect?.top || 0)) / zoom,
    };
  }, []);

  const clampToViewport = useCallback((x: number, y: number) => {
    const current = optionsRef.current;
    const element = current.wrapRef.current;
    const zoom = current.zoomRef.current || 1;
    if (!element) return { x, y };
    return clampPointToBox(x, y, {
      left: element.scrollLeft / zoom,
      top: element.scrollTop / zoom,
      right: (element.scrollLeft + element.clientWidth) / zoom,
      bottom: (element.scrollTop + element.clientHeight) / zoom,
    });
  }, []);

  const groupAtContentPoint = useCallback(
    (x: number, y: number, excludeId?: string) => {
      const nodes = optionsRef.current.nodesRef.current || [];
      for (const node of nodes) {
        if (
          (node.type !== "group" && node.type !== "iterator") ||
          node.id === excludeId
        ) {
          continue;
        }
        if (
          x >= node.x &&
          x <= node.x + nodeWidth(node) &&
          y >= node.y &&
          y <= node.y + nodeHeight(node)
        ) {
          return node;
        }
      }
      return null;
    },
    [],
  );

  const resolveUnionPort = useCallback((nodeId: string, edges: NbEdge[]) => {
    const taken = new Set(
      edges.filter((edge) => edge.to.node === nodeId).map((edge) => edge.to.port),
    );
    for (const port of PORTS.union.inputs) {
      if (!taken.has(port)) return port;
    }
    return null;
  }, []);

  const nearestInputPort = useCallback(
    (cx: number, cy: number, fromNode: string, maxDist: number) => {
      const current = optionsRef.current;
      const edges = current.edgesRef.current || [];
      const ports: { node: string; port: string; x: number; y: number }[] = [];
      for (const node of current.nodesRef.current || []) {
        if (node.id === fromNode) continue;
        const inputs = PORTS[node.type]?.inputs || [];
        const visible = visibleInputCount(node, edges);
        for (let index = 0; index < Math.min(inputs.length, visible); index += 1) {
          const point = portXY(node, "in", index, visible);
          ports.push({
            node: node.id,
            port: inputs[index],
            x: point.x,
            y: point.y,
          });
        }
      }
      return nearestPort(ports, cx, cy, maxDist);
    },
    [],
  );

  useEffect(() => {
    let rafHandle = 0;
    let lastX = 0;
    let lastY = 0;

    const apply = () => {
      rafHandle = 0;
      const drag = dragRef.current;
      if (!drag) return;
      const current = optionsRef.current;

      if (drag.mode === "node") {
        const zoom = current.zoomRef.current || 1;
        const dx = (lastX - drag.startX) / zoom;
        const dy = (lastY - drag.startY) / zoom;
        const grid = 16;
        const snapValue = snapRef.current
          ? (value: number) => Math.round(value / grid) * grid
          : (value: number) => value;
        current.setNodes((nodes) =>
          nodes.map((node) => {
            const origin = drag.origins[node.id];
            if (!origin) return node;
            return {
              ...node,
              x: Math.max(0, snapValue(origin.x + dx)),
              y: Math.max(0, snapValue(origin.y + dy)),
            };
          }),
        );
        if (drag.ids.length === 1) {
          const point = toContent(lastX, lastY);
          const group = groupAtContentPoint(point.x, point.y, drag.nodeId);
          const draggedType = current.nodesRef.current?.find(
            (node) => node.id === drag.nodeId,
          )?.type;
          setGroupHover(
            group && draggedType !== "group" && draggedType !== "iterator"
              ? group.id
              : null,
          );
        } else {
          setGroupHover(null);
        }
      } else if (drag.mode === "wire") {
        setWireEnd(toContent(lastX, lastY));
      } else if (drag.mode === "pan") {
        const element = current.wrapRef.current;
        if (element) {
          element.scrollLeft = drag.startScrollLeft - (lastX - drag.startX);
          element.scrollTop = drag.startScrollTop - (lastY - drag.startY);
        }
      } else {
        const target = toContent(lastX, lastY);
        const point = clampToViewport(target.x, target.y);
        const rect = {
          x0: drag.x0,
          y0: drag.y0,
          x1: point.x,
          y1: point.y,
        };
        setMarquee(rect);
        const ids = marqueeHits(
          (current.nodesRef.current || []).map((node) => ({
            id: node.id,
            x: node.x,
            y: node.y,
            w: nodeWidth(node),
            h: nodeHeight(node),
          })),
          rect,
        );
        drag.ids = ids;
        current.setSelectedIds(ids);
      }
    };

    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      lastX = event.clientX;
      lastY = event.clientY;
      if (!rafHandle) rafHandle = requestAnimationFrame(apply);
    };

    const up = (event: PointerEvent) => {
      if (rafHandle) {
        cancelAnimationFrame(rafHandle);
        rafHandle = 0;
      }
      const drag = dragRef.current;
      const current = optionsRef.current;

      if (drag?.mode === "wire") {
        let target = hoverInputRef.current;
        if (!target) {
          const end = toContent(event.clientX, event.clientY);
          target = nearestInputPort(end.x, end.y, drag.fromNode, 38);
        }
        if (target && target.node !== drag.fromNode) {
          const targetNode = current.nodesRef.current?.find(
            (node) => node.id === target?.node,
          );
          let toPort = target.port;
          let stackFull = false;
          if (targetNode?.type === "union") {
            const existing = (current.edgesRef.current || []).some(
              (edge) =>
                edge.to.node === target?.node &&
                edge.from.node === drag.fromNode &&
                edge.from.port === drag.fromPort,
            );
            if (!existing) {
              const free = resolveUnionPort(
                target.node,
                current.edgesRef.current || [],
              );
              if (!free) stackFull = true;
              else toPort = free;
            }
          }
          if (stackFull) {
            current.onToast(
              "warn",
              "Union is full",
              "A union node stacks up to 10 inputs.",
            );
          } else {
            const finalPort = toPort;
            fireSnap(target.node);
            current.setEdges((edges) => [
              ...edges.filter(
                (edge) =>
                  !(edge.to.node === target?.node && edge.to.port === finalPort),
              ),
              {
                id: uid(),
                from: { node: drag.fromNode, port: drag.fromPort },
                to: { node: target.node, port: finalPort },
              },
            ]);
          }
          if (target.port === "in") {
            current.setNodes((nodes) =>
              nodes.map((node) => {
                if (node.id !== target?.node || node.type !== "sql") return node;
                const sql = String(node.config.sql || "").trim();
                if (sql && !/from\s+your_table/i.test(sql)) return node;
                return {
                  ...node,
                  config: { ...node.config, sql: "SELECT *\nFROM input" },
                };
              }),
            );
          }
        } else {
          const dx = Math.abs(event.clientX - (drag.startX ?? event.clientX));
          const dy = Math.abs(event.clientY - (drag.startY ?? event.clientY));
          if (dx < 5 && dy < 5) {
            const node = current.nodesRef.current?.find(
              (item) => item.id === drag.fromNode,
            );
            if (node && current.doPreviewRef.current) {
              current.doPreviewRef.current(
                node,
                drag.fromPort,
                `${node.config.label} · ${drag.fromPort}`,
              );
            }
          }
        }
      } else if (drag?.mode === "node") {
        if (drag.ids.length === 1) {
          const node = current.nodesRef.current?.find(
            (item) => item.id === drag.nodeId,
          );
          if (node && node.type !== "group" && node.type !== "iterator") {
            const point = toContent(event.clientX, event.clientY);
            const group = groupAtContentPoint(point.x, point.y, drag.nodeId);
            if (group) current.moveNodeIntoGroup(drag.nodeId, group.id);
          }
        }
      } else if (drag?.mode === "marquee") {
        const target = toContent(event.clientX, event.clientY);
        const point = clampToViewport(target.x, target.y);
        const ids = marqueeHits(
          (current.nodesRef.current || []).map((node) => ({
            id: node.id,
            x: node.x,
            y: node.y,
            w: nodeWidth(node),
            h: nodeHeight(node),
          })),
          { x0: drag.x0, y0: drag.y0, x1: point.x, y1: point.y },
        );
        current.setSelectedIds(ids);
        current.setSelectedId(ids.length === 1 ? ids[0] : null);
        setMarquee(null);
      }

      dragRef.current = null;
      setWireEnd(null);
      setGroupHover(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [clampToViewport, fireSnap, groupAtContentPoint, nearestInputPort, resolveUnionPort, toContent]);

  const startNodeDrag = useCallback(
    (event: React.PointerEvent, node: NbNode) => {
      event.stopPropagation();
      if (event.button === 2) return;
      const current = optionsRef.current;
      const selectedIds = current.selectedIdsRef.current || [];
      const inMulti = selectedIds.length > 1 && selectedIds.includes(node.id);
      if (!inMulti) {
        current.setSelectedId(node.id);
        current.setSelectedIds([node.id]);
      }
      const ids = inMulti ? selectedIds.slice() : [node.id];
      const origins: Record<string, { x: number; y: number }> = {};
      for (const id of ids) {
        const selected = current.nodesRef.current?.find((item) => item.id === id);
        if (selected) origins[id] = { x: selected.x, y: selected.y };
      }
      dragRef.current = {
        mode: "node",
        nodeId: node.id,
        ids,
        origins,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [],
  );

  const startWire = useCallback(
    (event: React.PointerEvent, node: NbNode, port: string) => {
      event.stopPropagation();
      dragRef.current = {
        mode: "wire",
        fromNode: node.id,
        fromPort: port,
        startX: event.clientX,
        startY: event.clientY,
      };
      setWireEnd(toContent(event.clientX, event.clientY));
    },
    [toContent],
  );

  const startNodeResize = useCallback(
    (event: React.PointerEvent, node: NbNode) => {
      event.preventDefault();
      event.stopPropagation();
      const current = optionsRef.current;
      const zoom = current.zoomRef.current || 1;
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = nodeWidth(node);
      const startH = nodeHeight(node);
      startPointerDrag({
        onMove: (moveEvent) => {
          current.patchNode(node.id, {
            bodyW: startW + (moveEvent.clientX - startX) / zoom,
            bodyH:
              (node.config.bodyH ??
                (node.type === "dashboard"
                  ? DASH_BODY_H
                  : node.type === "sql"
                    ? SQL_BODY_H
                    : CHART_BODY_H)) +
              (moveEvent.clientY - startY) / zoom,
          });
        },
      });
    },
    [],
  );

  const startCanvasPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const current = optionsRef.current;
      if (event.button === 1) {
        event.preventDefault();
        const element = current.wrapRef.current;
        if (!element) return;
        dragRef.current = {
          mode: "pan",
          startX: event.clientX,
          startY: event.clientY,
          startScrollLeft: element.scrollLeft,
          startScrollTop: element.scrollTop,
        };
        return;
      }
      if (event.button !== 0) return;
      current.setSelectedId(null);
      current.setSelectedIds([]);
      current.setSelectedEdge(null);
      const point = toContent(event.clientX, event.clientY);
      dragRef.current = {
        mode: "marquee",
        x0: point.x,
        y0: point.y,
        ids: [],
      };
      setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    },
    [toContent],
  );

  const setHoveredInput = useCallback((node: string, port: string | null) => {
    if (port) hoverInputRef.current = { node, port };
    else if (hoverInputRef.current?.node === node) hoverInputRef.current = null;
  }, []);

  const pendingWire =
    wireEnd && dragRef.current?.mode === "wire"
      ? {
          node: dragRef.current.fromNode,
          port: dragRef.current.fromPort,
          end: wireEnd,
        }
      : null;

  return {
    dragRef,
    groupHover,
    marquee,
    wireEnd,
    pendingWire,
    snap,
    setSnap,
    snapId,
    toContent,
    groupAtContentPoint,
    startCanvasPointer,
    startNodeDrag,
    startNodeResize,
    startWire,
    setHoveredInput,
    defaultNodeDropOffset: { x: NODE_W / 2, y: HEAD_H },
  };
}
