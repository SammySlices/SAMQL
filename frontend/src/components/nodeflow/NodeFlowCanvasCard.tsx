import React from "react";
import type { ChartData } from "../../lib/types";
import {
  PORTS,
  PORT_LABEL,
  inputPortMark,
  isTopInput,
  nodeShowsBody,
  portsOf,
  portTopOffset,
  sidePortLabel,
  sameCanvasNodeMemoState,
  type CanvasNodeMemoState,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import { ChartView } from "../ChartView";
import { Icon } from "../Icon";
import { CanvasNodeFrameView } from "../NodeFlowCanvas";
import { getNodeCardSummary, NODE_BY_TYPE } from "./nodeDefinitions";
import type { NodeMenuState } from "./NodeFlowMenus";

const CHART_FALLBACK = (
  <div className="nb2-chart-msg">Can’t draw this chart.</div>
);

export type NodeFlowCanvasCardActions = {
  startNodeDrag: (event: React.PointerEvent, node: NbNode) => void;
  startNodeResize: (event: React.PointerEvent, node: NbNode) => void;
  startWire: (event: React.PointerEvent, node: NbNode, port: string) => void;
  patchNode: (id: string, config: Record<string, unknown>) => void;
  ensureChartFor: (node: NbNode | null, force?: boolean) => Promise<void>;
  upstreamChartNode: (dashboard: NbNode, inputPort: string) => NbNode | null;
  setDashboardPane: (dashboard: NbNode, index: number, port: string) => void;
  groupReorder: (groupId: string, from: number, to: number) => void;
  groupAddChild: (groupId: string, type: NodeType) => void;
  extractChildToCanvas: (groupId: string, childId: string) => void;
  setHoveredInput: (nodeId: string, port: string | null) => void;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setNodeMenu: React.Dispatch<React.SetStateAction<NodeMenuState | null>>;
};

export type NodeFlowCanvasCardProps = CanvasNodeMemoState & {
  visibleInputCount: number;
  incomingCount: number;
  incomingEdges: NbEdge[];
  /** Stable dispatcher bag — identity must not change across Scene renders. */
  actions: NodeFlowCanvasCardActions;
  groupDnd: React.MutableRefObject<{
    groupId: string;
    from: number;
    to?: number;
  } | null>;
  chartDataRef: React.MutableRefObject<
    Record<string, { data?: ChartData; loading?: boolean; error?: string }>
  >;
  selectedIdsRef: React.RefObject<string[]>;
};

function NodeFlowCanvasCardImpl({
  node,
  index,
  selected,
  dropHover,
  error,
  warning,
  ripple,
  snapped,
  dying,
  born,
  lineageFlash,
  denseMode,
  renderVersion,
  chartVersion,
  childSelection,
  visibleInputCount,
  incomingCount,
  incomingEdges,
  actions,
  groupDnd,
  chartDataRef,
  selectedIdsRef,
}: NodeFlowCanvasCardProps) {
  void renderVersion;
  void chartVersion;
  const ports = portsOf(node);
  return (
    <CanvasNodeFrameView
      node={node}
      index={index}
      selected={selected}
      dropHover={dropHover}
      error={error}
      warning={warning}
      ripple={ripple}
      snapped={snapped}
      dying={dying}
      born={born}
      lineageFlash={lineageFlash}
      denseMode={denseMode}
      renderVersion={renderVersion}
      chartVersion={chartVersion}
      childSelection={childSelection}
      onPointerDown={(event, currentNode) => {
        actions.startNodeDrag(event, currentNode);
      }}
      onContextMenu={(event, currentNode) => {
        event.preventDefault();
        event.stopPropagation();
        const currentSelection = selectedIdsRef.current || [];
        const inMulti =
          currentSelection.length > 1 &&
          currentSelection.includes(currentNode.id);
        if (!inMulti) {
          actions.setSelectedId(currentNode.id);
          actions.setSelectedIds([currentNode.id]);
        }
        actions.setNodeMenu({
          x: event.clientX,
          y: event.clientY,
          id: currentNode.id,
        });
      }}
    >
            <div
              className="nb2-node-head"
              onPointerDown={(event) => actions.startNodeDrag(event, node)}
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
                    actions.patchNode(node.id, { disabled: !node.config.disabled })
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
                    actions.patchNode(node.id, { collapsed: shown });
                    if (!shown) {
                      if (node.type === "chart") void actions.ensureChartFor(node);
                      else {
                        (node.config.panes || ["in1", "in2", "in3", "in4"]).forEach(
                          (port: string) =>
                            void actions.ensureChartFor(actions.upstreamChartNode(node, port)),
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
                    actions.groupReorder(
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
                  if (type && PORTS[type]) actions.groupAddChild(node.id, type);
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
                        (childSelection === child.id ? " sel" : "")
                      }
                      draggable
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        actions.setSelectedId(child.id);
                        actions.setSelectedIds([]);
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
                          actions.groupReorder(node.id, drag.from, drag.to ?? index);
                          groupDnd.current = null;
                          return;
                        }
                        const type = event.dataTransfer.getData(
                          "application/x-nb-node",
                        ) as NodeType;
                        if (type && PORTS[type]) actions.groupAddChild(node.id, type);
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
                          actions.extractChildToCanvas(node.id, child.id);
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
                  const current = chartDataRef.current[node.id];
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
                      onClick={() => void actions.ensureChartFor(node, true)}
                    >
                      <Icon.Chart size={13} /> Show chart
                    </button>
                  );
                })()}
                <button
                  className="nb2-chart-refresh"
                  title="Refresh chart"
                  onClick={() => void actions.ensureChartFor(node, true)}
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
                  const chartNode = actions.upstreamChartNode(node, port);
                  const current = chartNode ? chartDataRef.current[chartNode.id] : undefined;
                  return (
                    <div className="nb2-dash-pane" key={index}>
                      <div className="nb2-dash-bar">
                        <select
                          className="nb2-dash-sel"
                          value={port}
                          onPointerDown={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            actions.setDashboardPane(node, index, event.target.value)
                          }
                        >
                          {["in1", "in2", "in3", "in4"].map((inputPort) => {
                            const upstream = actions.upstreamChartNode(node, inputPort);
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
                            onClick={() => void actions.ensureChartFor(chartNode, true)}
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
                            onClick={() => void actions.ensureChartFor(chartNode, true)}
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
                onPointerDown={(event) => actions.startNodeResize(event, node)}
              />
            )}

            {ports.inputs
              .slice(0, visibleInputCount)
              .filter((port) => !isTopInput(node.type, port))
              .map((port, index, leftPorts) => {
                const mark = inputPortMark(port);
                const label =
                  node.type === "union"
                    ? incomingCount > 0
                      ? `stack inputs (${incomingCount}/10)`
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
                    onPointerEnter={() => actions.setHoveredInput(node.id, port)}
                    onPointerLeave={() => actions.setHoveredInput(node.id, null)}
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
                  onPointerEnter={() => actions.setHoveredInput(node.id, port)}
                  onPointerLeave={() => actions.setHoveredInput(node.id, null)}
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
                  onPointerDown={(event) => actions.startWire(event, node, port)}
                  title="Drag to an input to connect · click to preview this output"
                >
                  {label && (
                    <span className="nb2-port-lbl out">{label}</span>
                  )}
                  <span className="nb2-dot" />
                </div>
              );
            })}
    </CanvasNodeFrameView>
  );
}

/** Body construction lives inside memo so drag frames skip stationary cards. */
export const NodeFlowCanvasCard = React.memo(
  NodeFlowCanvasCardImpl,
  (a, b) =>
    sameCanvasNodeMemoState(a, b) &&
    a.visibleInputCount === b.visibleInputCount &&
    a.incomingCount === b.incomingCount &&
    a.incomingEdges === b.incomingEdges &&
    a.actions === b.actions &&
    a.groupDnd === b.groupDnd &&
    a.chartDataRef === b.chartDataRef &&
    a.selectedIdsRef === b.selectedIdsRef,
);
