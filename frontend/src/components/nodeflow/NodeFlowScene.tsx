import React, { useMemo, useRef } from "react";
import type { ChartData } from "../../lib/types";
import {
  HEAD_H,
  NODE_W,
  PORTS,
  PORT_LABEL,
  inputPortMark,
  isTopInput,
  nodeShowsBody,
  portsOf,
  portTopOffset,
  portXY,
  sidePortLabel,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import { useRenderCount } from "../../lib/renderDebug";
import { ChartView } from "../ChartView";
import { Icon } from "../Icon";
import { CanvasNodeFrame } from "../NodeFlowCanvas";
import {
  loadCreatedNodes,
  usernodeConfigFromDefinition,
} from "../../lib/createdNodes";
import { getNodeCardSummary, NODE_BY_TYPE } from "./nodeDefinitions";
import { NodeFlowCanvasShell } from "./NodeFlowCanvasShell";
import type { CanvasMenuState, NodeMenuState } from "./NodeFlowMenus";
import type { NodeFlowMarquee } from "./useNodeFlowCanvasInteractions";
import type { NodeFlowViewportRect } from "./useNodeFlowViewport";
import {
  buildNodeFlowRenderModel,
  selectVisibleCanvasNodes,
  selectVisibleCanvasWires,
} from "./nodeFlowRenderModel";

const CHART_FALLBACK = (
  <div className="nb2-chart-msg">Can’t draw this chart.</div>
);

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
}: NodeFlowSceneProps) {
  useRenderCount("NodeFlowScene");
  const groupDnd = useRef<{
    groupId: string;
    from: number;
    to?: number;
  } | null>(null);
  const chartObjectIds = useRef(new WeakMap<object, number>());
  const nextChartObjectId = useRef(1);

  // densify() reads html.nb-dense / module flag; denseMode prop busts Scene memo.
  const renderModel = useMemo(
    () => buildNodeFlowRenderModel(nodes, edges, denseMode),
    [nodes, edges, denseMode],
  );
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

  const visibleNodes = useMemo(
    () =>
      selectVisibleCanvasNodes(nodes, viewport, zoom, forcedNodeIds, undefined, undefined, denseMode),
    [forcedNodeIds, nodes, viewport, zoom, denseMode],
  );
  const visibleWires = useMemo(
    () =>
      selectVisibleCanvasWires(
        renderModel.wires,
        viewport,
        zoom,
        forcedNodeIds,
        selectedEdge,
      ),
    [forcedNodeIds, renderModel.wires, selectedEdge, viewport, zoom],
  );

  const chartVersionByNode = useMemo(() => {
    const result: Record<string, unknown> = {};
    const objectId = (value: object | undefined): number => {
      if (!value) return 0;
      const existing = chartObjectIds.current.get(value);
      if (existing) return existing;
      const created = nextChartObjectId.current++;
      chartObjectIds.current.set(value, created);
      return created;
    };
    for (const node of nodes) {
      if (node.type === "chart") {
        result[node.id] = chartData[node.id] || null;
      } else if (node.type === "dashboard") {
        result[node.id] = (renderModel.dashboardSourceIdsByNode[node.id] || [])
          .map((sourceId) => `${sourceId}:${objectId(chartData[sourceId])}`)
          .join("|");
      }
    }
    return result;
  }, [chartData, nodes, renderModel.dashboardSourceIdsByNode]);

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
          addNodeAt(
            "usernode",
            point.x - NODE_W / 2,
            point.y - HEAD_H,
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
        addNodeAt(type, point.x - NODE_W / 2, point.y - HEAD_H);
      }}
      zoom={zoom}
      snap={snap}
      wires={visibleWires}
      dyingIds={dyingIds}
      dyingEdgeIds={dyingEdgeIds}
      selectedEdge={selectedEdge}
      onSelectEdge={(id) => {
        setSelectedEdge(id);
        setSelectedId(null);
        setSelectedIds([]);
      }}
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
          <CanvasNodeFrame
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
            renderVersion={renderModel.renderVersionByNode[node.id] || "-"}
            chartVersion={chartVersionByNode[node.id] ?? null}
            childSelection={childSelection}
            onPointerDown={(event, currentNode) => {
              // Whole-node press: drag if moved past threshold; left quick
              // click opens inspector (via startNodeDrag → onInspectorOpen).
              startNodeDrag(event, currentNode);
            }}
            onContextMenu={(event, currentNode) => {
              // Right-click: select + node menu only. Do not open the
              // inspector/config drawer (that is left-click quick-click).
              event.preventDefault();
              event.stopPropagation();
              const currentSelection = selectedIdsRef.current || [];
              const inMulti =
                currentSelection.length > 1 &&
                currentSelection.includes(currentNode.id);
              if (!inMulti) {
                setSelectedId(currentNode.id);
                setSelectedIds([currentNode.id]);
              }
              setNodeMenu({
                x: event.clientX,
                y: event.clientY,
                id: currentNode.id,
              });
            }}
          >
            <div
              className="nb2-node-head"
              onPointerDown={(event) => startNodeDrag(event, node)}
            >
              <span className="nb2-node-type">
                {node.type === "usernode"
                  ? "created"
                  : node.type === "dyn_input"
                    ? "dyn in"
                    : node.type === "dyn_output"
                      ? "dyn out"
                      : node.type}
              </span>
              <span className="nb2-node-label">
                {node.config.label ||
                  node.config.name ||
                  node.type}
              </span>
              {ports.inputs.length >= 1 && ports.outputs.length >= 1 && (
                <button
                  className={
                    "nb2-node-bypass " +
                    (node.config.disabled ? "off" : "on")
                  }
                  title={
                    node.config.disabled
                      ? "Bypassed — input passes straight through. Click to enable."
                      : "Enabled. Click to bypass (pass the input straight through)."
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    patchNode(node.id, { disabled: !node.config.disabled })
                  }
                />
              )}
              {(node.type === "chart" || node.type === "dashboard") && (
                <button
                  className="nb2-node-collapse"
                  title={nodeShowsBody(node) ? "Hide output" : "Show output"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    const shown = nodeShowsBody(node);
                    patchNode(node.id, { collapsed: shown });
                    if (!shown) {
                      if (node.type === "chart") void ensureChartFor(node);
                      else {
                        (node.config.panes || ["in1", "in2", "in3", "in4"]).forEach(
                          (port: string) =>
                            void ensureChartFor(upstreamChartNode(node, port)),
                        );
                      }
                    }
                  }}
                >
                  {nodeShowsBody(node) ? "▾" : "▸"}
                </button>
              )}
            </div>

            {node.type === "text" ? (
              <div className="nb2-textnote-body">
                {node.config.text || "(empty note — type in the panel)"}
              </div>
            ) : node.type === "variable" ? (
              <div className="nb2-var-body">
                {(node.config.vars || []).filter((value: any) => value && value.name).length ? (
                  (node.config.vars || [])
                    .filter((value: any) => value && value.name)
                    .map((value: any, index: number) => (
                      <div key={index} className="nb2-var-chip">
                        <span className="nb2-var-chip-k">{value.name}</span>
                        <span className="nb2-var-chip-v">
                          {value.value || "∅"}
                        </span>
                      </div>
                    ))
                ) : (
                  <div className="nb2-var-empty">
                    (no variables — add some in the panel)
                  </div>
                )}
              </div>
            ) : node.type === "group" || node.type === "iterator" ? (
              <div
                className="nb2-group-body"
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const drag = groupDnd.current;
                  if (drag && drag.groupId === node.id) {
                    groupReorder(
                      node.id,
                      drag.from,
                      drag.to ?? (node.config.children || []).length,
                    );
                    groupDnd.current = null;
                    return;
                  }
                  const type = event.dataTransfer.getData(
                    "application/x-nb-node",
                  ) as NodeType;
                  if (type && PORTS[type]) groupAddChild(node.id, type);
                }}
              >
                {(node.config.children || []).length === 0 ? (
                  <div className="nb2-group-empty">
                    Drag nodes here to build a pipeline
                  </div>
                ) : (
                  (node.config.children || []).map((child: any, index: number) => (
                    <div
                      key={child.id}
                      className={
                        "nb2-group-child" +
                        (selectedId === child.id ? " sel" : "")
                      }
                      draggable
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setSelectedId(child.id);
                        setSelectedIds([]);
                      }}
                      onDragStart={(event) => {
                        event.stopPropagation();
                        groupDnd.current = { groupId: node.id, from: index };
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const drag = groupDnd.current;
                        if (drag && drag.groupId === node.id) {
                          const rect = event.currentTarget.getBoundingClientRect();
                          drag.to =
                            event.clientY > rect.top + rect.height / 2
                              ? index + 1
                              : index;
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const drag = groupDnd.current;
                        if (drag && drag.groupId === node.id) {
                          groupReorder(node.id, drag.from, drag.to ?? index);
                          groupDnd.current = null;
                          return;
                        }
                        const type = event.dataTransfer.getData(
                          "application/x-nb-node",
                        ) as NodeType;
                        if (type && PORTS[type]) groupAddChild(node.id, type);
                      }}
                      title="Drag to reorder · click to edit"
                    >
                      <span className="nb2-gc-idx">{index + 1}</span>
                      {(() => {
                        const item = NODE_BY_TYPE[child.type as NodeType];
                        const NodeIcon = item
                          ? (Icon[item.icon] as React.FC<{ size?: number }>)
                          : null;
                        return NodeIcon ? <NodeIcon size={12} /> : null;
                      })()}
                      <span className="nb2-gc-type">{child.type}</span>
                      <span className="nb2-gc-label">
                        {(child.config && child.config.label) || child.type}
                      </span>
                      <button
                        className="nb2-gc-x"
                        title="Take out of group (back to the canvas)"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          extractChildToCanvas(node.id, child.id);
                        }}
                      >
                        ⤴
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : node.type === "sql" || node.type === "python" ? null : (
              <div className="nb2-node-sub">
                {getNodeCardSummary(node, incomingEdges as NbEdge[])}
              </div>
            )}

            {node.type === "sql" && (
              <div
                className="nb2-node-sql"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <pre className="nb2-node-sql-text">
                  {(node.config.sql || "").trim() ||
                    "SELECT …   (write your query in the panel →)"}
                </pre>
              </div>
            )}

            {node.type === "python" && (
              <div
                className="nb2-node-sql"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <pre className="nb2-node-sql-text">
                  {(node.config.code || "").trim() ||
                    "# write Python in the panel →"}
                </pre>
              </div>
            )}

            {node.type === "chart" && nodeShowsBody(node) && (
              <div
                className="nb2-node-chart"
                onPointerDown={(event) => event.stopPropagation()}
              >
                {(() => {
                  const current = chartData[node.id];
                  if (current?.loading) {
                    return <div className="nb2-chart-msg">Rendering…</div>;
                  }
                  if (current?.error) {
                    return <div className="nb2-chart-msg">{current.error}</div>;
                  }
                  if (current?.data) {
                    return (
                      <ChartView
                        data={current.data}
                        chartType={node.config.chart_type}
                        style={node.config.style}
                        fallback={CHART_FALLBACK}
                      />
                    );
                  }
                  return (
                    <button
                      className="btn sm"
                      onClick={() => void ensureChartFor(node, true)}
                    >
                      <Icon.Chart size={13} /> Show chart
                    </button>
                  );
                })()}
                <button
                  className="nb2-chart-refresh"
                  title="Refresh chart"
                  onClick={() => void ensureChartFor(node, true)}
                >
                  <Icon.Refresh size={11} />
                </button>
              </div>
            )}

            {node.type === "dashboard" && nodeShowsBody(node) && (
              <div
                className="nb2-dash"
                onPointerDown={(event) => event.stopPropagation()}
              >
                {[0, 1, 2, 3].map((index) => {
                  const panes =
                    node.config.panes || ["in1", "in2", "in3", "in4"];
                  const port = panes[index] || `in${index + 1}`;
                  const chartNode = upstreamChartNode(node, port);
                  const current = chartNode ? chartData[chartNode.id] : undefined;
                  return (
                    <div className="nb2-dash-pane" key={index}>
                      <div className="nb2-dash-bar">
                        <select
                          className="nb2-dash-sel"
                          value={port}
                          onPointerDown={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            setDashboardPane(node, index, event.target.value)
                          }
                        >
                          {["in1", "in2", "in3", "in4"].map((inputPort) => {
                            const upstream = upstreamChartNode(node, inputPort);
                            return (
                              <option key={inputPort} value={inputPort}>
                                {upstream
                                  ? upstream.config.label || "chart"
                                  : `in ${inputPort.slice(2)} (empty)`}
                              </option>
                            );
                          })}
                        </select>
                        {chartNode && (
                          <button
                            className="nb2-chart-refresh"
                            title="Refresh"
                            onClick={() => void ensureChartFor(chartNode, true)}
                          >
                            <Icon.Refresh size={10} />
                          </button>
                        )}
                      </div>
                      <div className="nb2-dash-body">
                        {!chartNode ? (
                          <div className="nb2-chart-msg">
                            Connect a chart to {PORT_LABEL[port] || port}
                          </div>
                        ) : current?.loading ? (
                          <div className="nb2-chart-msg">Rendering…</div>
                        ) : current?.error ? (
                          <div className="nb2-chart-msg">{current.error}</div>
                        ) : current?.data ? (
                          <ChartView
                            data={current.data}
                            chartType={chartNode.config.chart_type}
                            style={chartNode.config.style}
                            fallback={CHART_FALLBACK}
                          />
                        ) : (
                          <button
                            className="btn sm"
                            onClick={() => void ensureChartFor(chartNode, true)}
                          >
                            Show
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {(((node.type === "chart" || node.type === "dashboard") &&
              nodeShowsBody(node)) ||
              node.type === "sql" ||
              node.type === "python") && (
              <div
                className="nb2-node-resize"
                title="Drag to resize"
                onPointerDown={(event) => startNodeResize(event, node)}
              />
            )}

            {ports.inputs
              .slice(0, visibleInputCount)
              .filter((port) => !isTopInput(node.type, port))
              .map((port, index, leftPorts) => {
                const mark = inputPortMark(port);
                const label =
                  node.type === "union"
                    ? renderModel.incomingCountByNode[node.id] > 0
                      ? `stack inputs (${renderModel.incomingCountByNode[node.id]}/10)`
                      : "stack inputs"
                    : sidePortLabel(port);
                return (
                  <div
                    key={`i${port}`}
                    className={
                      "nb2-port in" + (mark ? ` port-${port}` : "")
                    }
                    style={{
                      top: portTopOffset(
                        node,
                        "in",
                        index,
                        leftPorts.length,
                      ),
                    }}
                    onPointerEnter={() => setHoveredInput(node.id, port)}
                    onPointerLeave={() => setHoveredInput(node.id, null)}
                    title={
                      mark
                        ? mark === "L"
                          ? "Left input"
                          : "Right input"
                        : undefined
                    }
                  >
                    <span className="nb2-dot">
                      {mark && (
                        <span className="nb2-dot-mark" aria-hidden>
                          {mark}
                        </span>
                      )}
                    </span>
                    {label && (
                      <span className="nb2-port-lbl in">{label}</span>
                    )}
                  </div>
                );
              })}

            {ports.inputs
              .slice(0, visibleInputCount)
              .filter((port) => isTopInput(node.type, port))
              .map((port) => (
                <div
                  key={`t${port}`}
                  className="nb2-port top"
                  onPointerEnter={() => setHoveredInput(node.id, port)}
                  onPointerLeave={() => setHoveredInput(node.id, null)}
                  title="Wire a table here — its rows drive the loop (one pass per row, columns bound as ${vars})"
                >
                  <span className="nb2-port-lbl top">
                    {PORT_LABEL[port] || port}
                  </span>
                  <span className="nb2-dot down" />
                </div>
              ))}

            {ports.outputs.map((port, index) => {
              const label = sidePortLabel(port);
              return (
                <div
                  key={`o${port}`}
                  className={`nb2-port out ${port}`}
                  style={{ top: portTopOffset(node, "out", index) }}
                  onPointerDown={(event) => startWire(event, node, port)}
                  title="Drag to an input to connect · click to preview this output"
                >
                  {label && (
                    <span className="nb2-port-lbl out">{label}</span>
                  )}
                  <span className="nb2-dot" />
                </div>
              );
            })}
          </CanvasNodeFrame>
        );
      })}
    </NodeFlowCanvasShell>
  );
});
