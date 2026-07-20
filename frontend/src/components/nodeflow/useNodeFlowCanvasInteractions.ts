import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { uid } from "../../lib/ids";
import {
  clampPointToBox,
  marqueeHits,
  nearestPort,
  sameIdList,
} from "../../lib/nodegraph";
import {
  CHART_BODY_H,
  DASH_BODY_H,
  HEAD_H,
  NODE_W,
  PORTS,
  SQL_BODY_H,
  nodeHeight,
  nodeUnderBodySize,
  nodeUsesSphereChrome,
  nodeWidth,
  nodeWorldBounds,
  portsOf,
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
  /** True once pointer moved past click/drag threshold. */
  moved?: boolean;
  /** Group/iterator nodes snapshot at drag start (skip full scan each RAF). */
  groups?: NbNode[];
};
type ResizeDrag = {
  mode: "resize";
  nodeId: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  /** Fallback body height before this resize gesture. */
  baseBodyH: number;
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
  /** Hit-test boxes built once at marquee start (nodes don't move mid-marquee). */
  boxes: { id: string; x: number; y: number; w: number; h: number }[];
};
export type NodeFlowDragState =
  | NodeDrag
  | ResizeDrag
  | WireDrag
  | PanDrag
  | MarqueeDrag;

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
  /** Canvas grid snap while dragging (App Settings → Visual). Default OFF. */
  snap?: boolean;
  /** Quick click (pointerup under drag threshold) opens the inspector drawer. */
  onInspectorOpen?: () => void;
  /** Confirmed drag: keep the tables/inspector panel closed. */
  onInspectorClose?: () => void;
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
  const snap = options.snap === true;
  const snapRef = useRef(snap);
  const [snapId, setSnapId] = useState<string | null>(null);
  const snapTimer = useRef<number | null>(null);

  useEffect(() => {
    snapRef.current = options.snap === true;
  }, [options.snap]);

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
    (x: number, y: number, excludeId?: string, groups?: NbNode[]) => {
      const nodes =
        groups ||
        (optionsRef.current.nodesRef.current || []).filter(
          (node) => node.type === "group" || node.type === "iterator",
        );
      for (const node of nodes) {
        if (node.id === excludeId) continue;
        if (node.type !== "group" && node.type !== "iterator") continue;
        // Include floating under-panel (sphere children list) so drops onto
        // the window below the sphere still absorb into the container.
        const b = nodeWorldBounds(node);
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          return node;
        }
      }
      return null;
    },
    [],
  );

  const resolveStackPort = useCallback((nodeId: string, edges: NbEdge[], type: "union" | "sql") => {
    const taken = new Set(
      edges.filter((edge) => edge.to.node === nodeId).map((edge) => edge.to.port),
    );
    for (const port of PORTS[type].inputs) {
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
        const inputs = portsOf(node).inputs;
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
        const rawDx = lastX - drag.startX;
        const rawDy = lastY - drag.startY;
        if (!drag.moved) {
          if (Math.abs(rawDx) < 5 && Math.abs(rawDy) < 5) return;
          drag.moved = true;
          // Confirmed drag — never open/keep the side panel expanded.
          current.onInspectorClose?.();
        }
        const dx = rawDx / zoom;
        const dy = rawDy / zoom;
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
          const group = groupAtContentPoint(
            point.x,
            point.y,
            drag.nodeId,
            drag.groups,
          );
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
      } else if (drag.mode === "resize") {
        const zoom = current.zoomRef.current || 1;
        const nextW = Math.max(
          160,
          drag.startW + (lastX - drag.startX) / zoom,
        );
        const nextH = Math.max(
          110,
          drag.baseBodyH + (lastY - drag.startY) / zoom,
        );
        // Geometry-only setNodes (like node drag) — do NOT patchNode each
        // RAF. bodyW/bodyH live on config, but dirtyNodesAreGeometryOnly
        // treats those keys as geometry so the dirty-wire path stays hot.
        current.setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== drag.nodeId) return node;
            const cfg = node.config || {};
            if (cfg.bodyW === nextW && cfg.bodyH === nextH) return node;
            return {
              ...node,
              config: { ...cfg, bodyW: nextW, bodyH: nextH },
            };
          }),
        );
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
        const boxes =
          drag.boxes ||
          (current.nodesRef.current || []).map((node) => ({
            id: node.id,
            x: node.x,
            y: node.y,
            w: nodeWidth(node),
            h: nodeHeight(node),
          }));
        drag.boxes = boxes;
        const ids = marqueeHits(boxes, rect);
        if (!sameIdList(drag.ids, ids)) {
          drag.ids = ids;
          current.setSelectedIds(ids);
        }
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
          if (targetNode?.type === "union" || targetNode?.type === "sql") {
            const existing = (current.edgesRef.current || []).some(
              (edge) =>
                edge.to.node === target?.node &&
                edge.from.node === drag.fromNode &&
                edge.from.port === drag.fromPort,
            );
            if (!existing) {
              const free = resolveStackPort(
                target.node,
                current.edgesRef.current || [],
                targetNode.type,
              );
              if (!free) stackFull = true;
              else toPort = free;
            }
          }
          if (stackFull) {
            const kind = targetNode?.type === "sql" ? "SQL" : "Union";
            current.onToast(
              "warn",
              `${kind} is full`,
              `A ${kind === "SQL" ? "SQL" : "union"} node stacks up to 10 inputs.`,
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
            // First wire onto an empty SQL stub: seed FROM <table> when possible.
            if (
              targetNode?.type === "sql" &&
              /^in\d+$/.test(String(finalPort))
            ) {
              current.setNodes((nodes) =>
                nodes.map((node) => {
                  if (node.id !== target?.node || node.type !== "sql") return node;
                  const sql = String(node.config.sql || "").trim();
                  if (
                    sql &&
                    !/^SELECT \*\s*\nFROM\s*$/i.test(sql) &&
                    sql !== "SELECT *\nFROM "
                  ) {
                    return node;
                  }
                  const fromNode = (current.nodesRef.current || []).find(
                    (n) => n.id === drag.fromNode,
                  );
                  const table =
                    (fromNode?.config?.table &&
                      String(fromNode.config.table).trim()) ||
                    "";
                  if (!table) return node;
                  return {
                    ...node,
                    config: {
                      ...node.config,
                      sql: `SELECT *\nFROM ${table}`,
                    },
                  };
                }),
              );
            }
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
        const wasDrag = !!drag.moved;
        delete document.documentElement.dataset.samqlNfDrag;
        // Left quick-click only: right-click never starts a node drag
        // (startNodeDrag returns on button === 2), but still ignore
        // secondary-button ups so inspector open stays left-click only.
        if (!wasDrag && event.button !== 2) {
          current.onInspectorOpen?.();
        }
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
        const boxes =
          drag.boxes ||
          (current.nodesRef.current || []).map((node) => ({
            id: node.id,
            x: node.x,
            y: node.y,
            w: nodeWidth(node),
            h: nodeHeight(node),
          }));
        const ids = marqueeHits(boxes, {
          x0: drag.x0,
          y0: drag.y0,
          x1: point.x,
          y1: point.y,
        });
        if (!sameIdList(drag.ids, ids)) {
          current.setSelectedIds(ids);
        }
        current.setSelectedId(ids.length === 1 ? ids[0] : null);
        setMarquee(null);
      }

      delete document.documentElement.dataset.samqlNfDrag;
      dragRef.current = null;
      setWireEnd(null);
      setGroupHover(null);
      setMarquee(null);
    };

    const cancel = () => {
      // Browser/OS stole the gesture — same chrome unlock as pointerup,
      // without committing wire/marquee side effects mid-flight.
      if (rafHandle) {
        cancelAnimationFrame(rafHandle);
        rafHandle = 0;
      }
      delete document.documentElement.dataset.samqlNfDrag;
      dragRef.current = null;
      setWireEnd(null);
      setGroupHover(null);
      setMarquee(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [clampToViewport, fireSnap, groupAtContentPoint, nearestInputPort, resolveStackPort, toContent]);

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
      // Block folder-handle / drawer chrome for the whole press (click or drag).
      document.documentElement.dataset.samqlNfDrag = "1";
      const groups = (current.nodesRef.current || []).filter(
        (item) => item.type === "group" || item.type === "iterator",
      );
      dragRef.current = {
        mode: "node",
        nodeId: node.id,
        ids,
        origins,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        groups,
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
      // Sphere chart/dashboard: resize the floating under-node panel, not the
      // sphere diameter (nodeWidth/Height stay at SPHERE_SIZE).
      const under =
        nodeUsesSphereChrome(node) &&
        (node.type === "chart" || node.type === "dashboard")
          ? nodeUnderBodySize(node)
          : null;
      const startW = under ? under.w : nodeWidth(node);
      const baseBodyH =
        under?.h ??
        node.config.bodyH ??
        (node.type === "dashboard"
          ? DASH_BODY_H
          : node.type === "sql"
            ? SQL_BODY_H
            : CHART_BODY_H);
      // Same chrome lock + RAF path as node drag (no per-pixel patchNode).
      document.documentElement.dataset.samqlNfDrag = "1";
      dragRef.current = {
        mode: "resize",
        nodeId: node.id,
        startX: event.clientX,
        startY: event.clientY,
        startW,
        startH: under ? under.h : nodeHeight(node),
        baseBodyH: Number(baseBodyH) || SQL_BODY_H,
      };
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
      const boxes = (current.nodesRef.current || []).map((node) => ({
        id: node.id,
        x: node.x,
        y: node.y,
        w: nodeWidth(node),
        h: nodeHeight(node),
      }));
      dragRef.current = {
        mode: "marquee",
        x0: point.x,
        y0: point.y,
        ids: [],
        boxes,
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
