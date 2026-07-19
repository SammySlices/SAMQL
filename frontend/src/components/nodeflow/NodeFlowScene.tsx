import React, { useCallback, useMemo, useRef } from "react";
import type { ChartData } from "../../lib/types";
import {
  PORTS,
  nodeSpawnOrigin,
  portsOf,
  portXY,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import { useRenderCount } from "../../lib/renderDebug";
import {
  loadCreatedNodes,
  usernodeConfigFromDefinition,
} from "../../lib/createdNodes";
import {
  NodeFlowCanvasCard,
  type NodeFlowCanvasCardActions,
} from "./NodeFlowCanvasCard";
import { NodeFlowCanvasShell } from "./NodeFlowCanvasShell";
import type { CanvasMenuState, NodeMenuState } from "./NodeFlowMenus";
import type { NodeFlowMarquee } from "./useNodeFlowCanvasInteractions";
import type { NodeFlowViewportRect } from "./useNodeFlowViewport";
import {
  buildNodeFlowRenderModel,
  dirtyNodeIdsFromIdentity,
  dirtyNodesAreGeometryOnly,
  patchNodeFlowRenderModelForDirtyNodes,
  selectVisibleCanvasNodes,
  selectVisibleCanvasWires,
} from "./nodeFlowRenderModel";

interface PendingWireState {
  node: string;
  port: string;
  end: { x: number; y: number };
}

interface NodeFlowSceneProps {
  nodes: NbNode[];
  edges: NbEdge[];
  running: boolean;
  runningNodeIds: Set<string>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onCanvasPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  toContent: (clientX: number, clientY: number) => { x: number; y: number };
  groupAtContentPoint: (x: number, y: number, excludeId?: string) => NbNode | null;
  setCanvasMenu: React.Dispatch<React.SetStateAction<CanvasMenuState | null>>;
  addNodeAt: (
    type: NodeType,
    x: number,
    y: number,
    config?: Record<string, any>,
  ) => void;
  groupAddChild: (groupId: string, type: NodeType) => void;
  zoom: number;
  snap: boolean;
  dyingIds: Set<string>;
  dyingEdgeIds: Set<string>;
  selectedEdge: string | null;
  setSelectedEdge: React.Dispatch<React.SetStateAction<string | null>>;
  deleteEdge: (id: string) => void;
  pendingWire: PendingWireState | null;
  marquee: NodeFlowMarquee | null;
  selectedId: string | null;
  selectedIds: string[];
  selectedIdsRef: React.RefObject<string[]>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  viewport: NodeFlowViewportRect;
  minimapMini: boolean;
  toggleMinimap: () => void;
  panTo: (x: number, y: number) => void;
  groupHover: string | null;
  nodeErrors: Record<string, string>;
  nodeWarnings: Record<string, string>;
  ripple: boolean;
  snapId: string | null;
  bornId: string | null;
  lineageFlashId: string | null;
  chartData: Record<
    string,
    { data?: ChartData; loading?: boolean; error?: string }
  >;
  patchNode: (id: string, config: Record<string, unknown>) => void;
  ensureChartFor: (node: NbNode | null, force?: boolean) => Promise<void>;
  upstreamChartNode: (dashboard: NbNode, inputPort: string) => NbNode | null;
  setDashboardPane: (dashboard: NbNode, index: number, port: string) => void;
  groupReorder: (groupId: string, from: number, to: number) => void;
  extractChildToCanvas: (groupId: string, childId: string) => void;
  startNodeDrag: (event: React.PointerEvent, node: NbNode) => void;
  startNodeResize: (event: React.PointerEvent, node: NbNode) => void;
  startWire: (event: React.PointerEvent, node: NbNode, port: string) => void;
  setHoveredInput: (nodeId: string, port: string | null) => void;
  setNodeMenu: React.Dispatch<React.SetStateAction<NodeMenuState | null>>;
  /** Dense NodeFlow — prop so memo'd Scene re-renders when Settings toggles it. */
  denseMode: boolean;
  /** Icon-sphere chrome — prop so memo'd Scene re-renders when Settings toggles it. */
  sphereMode: boolean;
}

export const NodeFlowScene = React.memo(function NodeFlowScene({
  nodes,
  edges,
  running,
  runningNodeIds,
  wrapRef,
  contentRef,
  onScroll,
  onCanvasPointerDown,
  toContent,
  groupAtContentPoint,
  setCanvasMenu,
  addNodeAt,
  groupAddChild,
  zoom,
  snap,
  dyingIds,
  dyingEdgeIds,
  selectedEdge,
  setSelectedEdge,
  deleteEdge,
  pendingWire,
  marquee,
  selectedId,
  selectedIds,
  selectedIdsRef,
  setSelectedId,
  setSelectedIds,
  viewport,
  minimapMini,
  toggleMinimap,
  panTo,
  groupHover,
  nodeErrors,
  nodeWarnings,
  ripple,
  snapId,
  bornId,
  lineageFlashId,
  chartData,
  patchNode,
  ensureChartFor,
  upstreamChartNode,
  setDashboardPane,
  groupReorder,
  extractChildToCanvas,
  startNodeDrag,
  startNodeResize,
  startWire,
  setHoveredInput,
  setNodeMenu,
  denseMode,
  sphereMode,
}: NodeFlowSceneProps) {
  useRenderCount("NodeFlowScene");
  const groupDnd = useRef<{
    groupId: string;
    from: number;
    to?: number;
  } | null>(null);
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;
  // Stable action identity so NodeFlowCanvasCard memo is not busted every frame.
  const cardActionsRef = useRef<NodeFlowCanvasCardActions>(null!);
  cardActionsRef.current = {
    startNodeDrag,
    startNodeResize,
    startWire,
    patchNode,
    ensureChartFor,
    upstreamChartNode,
    setDashboardPane,
    groupReorder,
    groupAddChild,
    extractChildToCanvas,
    setHoveredInput,
    setSelectedId,
    setSelectedIds,
    setNodeMenu,
  };
  const cardActions = useMemo<NodeFlowCanvasCardActions>(
    () => ({
      startNodeDrag: (event, node) =>
        cardActionsRef.current.startNodeDrag(event, node),
      startNodeResize: (event, node) =>
        cardActionsRef.current.startNodeResize(event, node),
      startWire: (event, node, port) =>
        cardActionsRef.current.startWire(event, node, port),
      patchNode: (id, config) => cardActionsRef.current.patchNode(id, config),
      ensureChartFor: (node, force) =>
        cardActionsRef.current.ensureChartFor(node, force),
      upstreamChartNode: (dashboard, inputPort) =>
        cardActionsRef.current.upstreamChartNode(dashboard, inputPort),
      setDashboardPane: (dashboard, index, port) =>
        cardActionsRef.current.setDashboardPane(dashboard, index, port),
      groupReorder: (groupId, from, to) =>
        cardActionsRef.current.groupReorder(groupId, from, to),
      groupAddChild: (groupId, type) =>
        cardActionsRef.current.groupAddChild(groupId, type),
      extractChildToCanvas: (groupId, childId) =>
        cardActionsRef.current.extractChildToCanvas(groupId, childId),
      setHoveredInput: (nodeId, port) =>
        cardActionsRef.current.setHoveredInput(nodeId, port),
      setSelectedId: (value) => cardActionsRef.current.setSelectedId(value),
      setSelectedIds: (value) => cardActionsRef.current.setSelectedIds(value),
      setNodeMenu: (value) => cardActionsRef.current.setNodeMenu(value),
    }),
    [],
  );
  const chartObjectIds = useRef(new WeakMap<object, number>());
  const nextChartObjectId = useRef(1);

  // densify()/sphere helpers read html flags; denseMode/sphereMode props bust Scene memo.
  // Drag/resize only change node object identity for moved cards — patch those
  // wires instead of rebuilding O(edges) geometry every RAF.
  const renderModelCacheRef = useRef<{
    nodes: NbNode[];
    edges: NbEdge[];
    denseMode: boolean;
    sphereMode: boolean;
    model: ReturnType<typeof buildNodeFlowRenderModel>;
  } | null>(null);
  const renderModel = useMemo(() => {
    const prev = renderModelCacheRef.current;
    if (
      prev &&
      prev.edges === edges &&
      prev.denseMode === denseMode &&
      prev.sphereMode === sphereMode
    ) {
      const dirty = dirtyNodeIdsFromIdentity(prev.nodes, nodes);
      if (dirty && dirty.size === 0) return prev.model;
      // Position-only drag: patch wires. Config/type edits: full rebuild so
      // dashboard cards see upstream chart source revisions.
      if (
        dirty &&
        dirty.size > 0 &&
        dirty.size < nodes.length &&
        dirtyNodesAreGeometryOnly(prev.nodes, nodes, dirty)
      ) {
        const patched = patchNodeFlowRenderModelForDirtyNodes(
          prev.model,
          nodes,
          edges,
          dirty,
        );
        if (patched) {
          renderModelCacheRef.current = {
            nodes,
            edges,
            denseMode,
            sphereMode,
            model: patched,
          };
          return patched;
        }
      }
    }
    const model = buildNodeFlowRenderModel(
      nodes,
      edges,
      denseMode,
      sphereMode,
    );
    renderModelCacheRef.current = {
      nodes,
      edges,
      denseMode,
      sphereMode,
      model,
    };
    return model;
  }, [nodes, edges, denseMode, sphereMode]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const forcedNodeIds = useMemo(() => {
    const ids = new Set(selectedIds);
    if (selectedId) ids.add(selectedId);
    if (groupHover) ids.add(groupHover);
    if (snapId) ids.add(snapId);
    if (bornId) ids.add(bornId);
    if (lineageFlashId) ids.add(lineageFlashId);
    if (pendingWire?.node) ids.add(pendingWire.node);
    for (const id of dyingIds) ids.add(id);
    return ids;
  }, [bornId, lineageFlashId, dyingIds, groupHover, pendingWire?.node, selectedId, selectedIds, snapId]);

  const visibleCullIdsRef = useRef<string[] | null>(null);
  const visibleWireIdsRef = useRef<string[] | null>(null);
  const visibleNodes = useMemo(() => {
    const dragging =
      typeof document !== "undefined" &&
      document.documentElement.dataset.samqlNfDrag === "1";
    if (dragging && visibleCullIdsRef.current) {
      const want = new Set(visibleCullIdsRef.current);
      for (const id of forcedNodeIds) want.add(id);
      return nodes.filter((node) => want.has(node.id));
    }
    const next = selectVisibleCanvasNodes(
      nodes,
      viewport,
      zoom,
      forcedNodeIds,
      undefined,
      undefined,
      denseMode,
      sphereMode,
    );
    visibleCullIdsRef.current = next.map((node) => node.id);
    return next;
  }, [forcedNodeIds, nodes, viewport, zoom, denseMode, sphereMode]);
  const visibleWires = useMemo(() => {
    const dragging =
      typeof document !== "undefined" &&
      document.documentElement.dataset.samqlNfDrag === "1";
    if (dragging && visibleWireIdsRef.current) {
      const want = new Set(visibleWireIdsRef.current);
      if (selectedEdge) want.add(selectedEdge);
      return renderModel.wires.filter((wire) => {
        if (want.has(wire.id)) return true;
        if (forcedNodeIds.has(wire.fromN) || forcedNodeIds.has(wire.toN))
          return true;
        if (selectedEdge && wire.id === selectedEdge) return true;
        return false;
      });
    }
    const next = selectVisibleCanvasWires(
      renderModel.wires,
      viewport,
      zoom,
      forcedNodeIds,
      selectedEdge,
    );
    visibleWireIdsRef.current = next.map((wire) => wire.id);
    return next;
  }, [forcedNodeIds, renderModel.wires, selectedEdge, viewport, zoom]);

  const chartVersionByNode = useMemo(() => {
    // Do not depend on the full ``nodes`` array — drag would re-scan every RAF.
    // Chart versions follow chartData; dashboards follow wired chart sources.
    const result: Record<string, unknown> = {};
    const objectId = (value: object | undefined): number => {
      if (!value) return 0;
      const existing = chartObjectIds.current.get(value);
      if (existing) return existing;
      const created = nextChartObjectId.current++;
      chartObjectIds.current.set(value, created);
      return created;
    };
    for (const id of Object.keys(chartData)) {
      result[id] = chartData[id] || null;
    }
    for (const [dashId, sourceIds] of Object.entries(
      renderModel.dashboardSourceIdsByNode,
    )) {
      result[dashId] = (sourceIds || [])
        .map((sourceId) => `${sourceId}:${objectId(chartData[sourceId])}`)
        .join("|");
    }
    return result;
  }, [chartData, renderModel.dashboardSourceIdsByNode]);

  const onSelectEdge = useCallback(
    (id: string) => {
      setSelectedEdge(id);
      setSelectedId(null);
      setSelectedIds([]);
    },
    [setSelectedEdge, setSelectedId, setSelectedIds],
  );

  const pendingWireGeometry = useMemo(() => {
    if (!pendingWire) return null;
    const source = renderModel.nodeById.get(pendingWire.node);
    if (!source) return null;
    const outputIndex = portsOf(source).outputs.indexOf(pendingWire.port);
    const start = portXY(source, "out", outputIndex < 0 ? 0 : outputIndex);
    return {
      ax: start.x,
      ay: start.y,
      bx: pendingWire.end.x,
      by: pendingWire.end.y,
    };
  }, [pendingWire, renderModel.nodeById]);

  return (
    <NodeFlowCanvasShell
      running={running}
      runningNodeIds={runningNodeIds}
      isWiring={!!pendingWire}
      wrapRef={wrapRef}
      contentRef={contentRef}
      onScroll={onScroll}
      onPointerDown={onCanvasPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        const point = toContent(event.clientX, event.clientY);
        setCanvasMenu({
          x: event.clientX,
          y: event.clientY,
          cx: point.x,
          cy: point.y,
        });
      }}
      onDrop={(event) => {
        event.preventDefault();
        const createdId = event.dataTransfer.getData(
          "application/x-nb-created-node",
        );
        const point = toContent(event.clientX, event.clientY);
        if (createdId) {
          const definition = loadCreatedNodes().find((d) => d.id === createdId);
          if (!definition) return;
          const origin = nodeSpawnOrigin(
            "usernode",
            point.x,
            point.y,
            sphereMode,
          );
          addNodeAt(
            "usernode",
            origin.x,
            origin.y,
            usernodeConfigFromDefinition(definition),
          );
          return;
        }
        const type = event.dataTransfer.getData(
          "application/x-nb-node",
        ) as NodeType;
        if (!type || !PORTS[type]) return;
        const group = groupAtContentPoint(point.x, point.y);
        if (
          group &&
          type !== "group" &&
          type !== "iterator" &&
          type !== "usernode"
        ) {
          groupAddChild(group.id, type);
          return;
        }
        const origin = nodeSpawnOrigin(type, point.x, point.y, sphereMode);
        addNodeAt(type, origin.x, origin.y);
      }}
      zoom={zoom}
      snap={snap}
      wires={visibleWires}
      dyingIds={dyingIds}
      dyingEdgeIds={dyingEdgeIds}
      selectedEdge={selectedEdge}
      onSelectEdge={onSelectEdge}
      onDeleteEdge={deleteEdge}
      pendingWire={pendingWireGeometry}
      marquee={marquee}
      nodes={nodes}
      selectedId={selectedId}
      viewport={viewport}
      minimapMini={minimapMini}
      onToggleMinimap={toggleMinimap}
      onPan={panTo}
      renderedNodeCount={visibleNodes.length}
    >
      {visibleNodes.map((node) => {
        const ports = portsOf(node);
        const visibleInputCount =
          renderModel.visibleInputCountByNode[node.id] ?? ports.inputs.length;
        const incomingEdges = renderModel.incomingByNode[node.id] || [];
        const childSelection =
          (node.type === "group" || node.type === "iterator") &&
          (node.config.children || []).some((child: any) => child.id === selectedId)
            ? selectedId
            : null;
        return (
          <NodeFlowCanvasCard
            key={node.id}
            node={node}
            index={renderModel.nodeIndexById.get(node.id) || 0}
            selected={selectedIdSet.has(node.id)}
            dropHover={groupHover === node.id}
            error={nodeErrors[node.id]}
            warning={nodeWarnings[node.id]}
            ripple={ripple}
            snapped={snapId === node.id}
            dying={dyingIds.has(node.id)}
            born={bornId === node.id}
            lineageFlash={lineageFlashId === node.id}
            denseMode={denseMode}
            sphereMode={sphereMode}
            renderVersion={renderModel.renderVersionByNode[node.id] || "-"}
            chartVersion={chartVersionByNode[node.id] ?? null}
            childSelection={childSelection}
            visibleInputCount={visibleInputCount}
            incomingCount={renderModel.incomingCountByNode[node.id] || 0}
            incomingEdges={incomingEdges}
            actions={cardActions}
            groupDnd={groupDnd}
            chartDataRef={chartDataRef}
            selectedIdsRef={selectedIdsRef}
          />
        );
      })}
    </NodeFlowCanvasShell>
  );
});
