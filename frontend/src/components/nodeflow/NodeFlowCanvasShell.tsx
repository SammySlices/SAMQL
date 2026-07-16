import React from "react";
import { canvasWorldSize, type NbNode } from "../../lib/nodeFlowModel";
import { wirePath } from "../../lib/nodegraph";
import {
  NodeMinimap,
  WireLayer,
  type MinimapViewport,
  type Wire,
} from "../NodeFlowCanvas";
import type { NodeFlowMarquee } from "./useNodeFlowCanvasInteractions";

interface NodeFlowCanvasShellProps {
  running: boolean;
  isWiring: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  zoom: number;
  snap: boolean;
  wires: Wire[];
  dyingIds: Set<string>;
  dyingEdgeIds: Set<string>;
  selectedEdge: string | null;
  onSelectEdge: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  pendingWire: { ax: number; ay: number; bx: number; by: number } | null;
  marquee: NodeFlowMarquee | null;
  nodes: NbNode[];
  selectedId: string | null;
  viewport: MinimapViewport;
  minimapMini: boolean;
  onToggleMinimap: () => void;
  onPan: (x: number, y: number) => void;
  renderedNodeCount: number;
  children: React.ReactNode;
}

export const NodeFlowCanvasShell = React.memo(function NodeFlowCanvasShell({
  running,
  isWiring,
  wrapRef,
  contentRef,
  onScroll,
  onPointerDown,
  onContextMenu,
  onDrop,
  zoom,
  snap,
  wires,
  dyingIds,
  dyingEdgeIds,
  selectedEdge,
  onSelectEdge,
  onDeleteEdge,
  pendingWire,
  marquee,
  nodes,
  selectedId,
  viewport,
  minimapMini,
  onToggleMinimap,
  onPan,
  renderedNodeCount,
  children,
}: NodeFlowCanvasShellProps) {
  const world = canvasWorldSize(nodes);
  return (
    <div className="nb2-canvas-col">
      <div
        className={
            "nb2-canvas-wrap" +
            (running ? " flowing" : "") +
            (isWiring ? " wiring" : "")
          }
          ref={wrapRef as React.Ref<HTMLDivElement>}
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onContextMenu={onContextMenu}
          onDrop={onDrop}
        >
          <div
            className="nb2-canvas-scaler"
            style={{ width: world.w * zoom, height: world.h * zoom }}
            data-testid="nb2-canvas-scaler"
            data-canvas-w={world.w}
            data-canvas-h={world.h}
          >
            <div
              className={"nb2-canvas" + (snap ? " snap" : "")}
              data-total-nodes={nodes.length}
              data-rendered-nodes={renderedNodeCount}
              data-virtualized={renderedNodeCount < nodes.length ? "true" : "false"}
              ref={contentRef as React.Ref<HTMLDivElement>}
              style={{
                width: world.w,
                height: world.h,
                transform: `scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              <WireLayer
                wires={wires}
                dying={dyingIds}
                dyingEdges={dyingEdgeIds}
                selectedId={selectedEdge}
                onSelect={onSelectEdge}
                onDelete={onDeleteEdge}
              />
              {pendingWire && (
                <svg className="nb2-wires" style={{ pointerEvents: "none" }}>
                  <path
                    className="nb2-wire-line pending"
                    d={wirePath(
                      pendingWire.ax,
                      pendingWire.ay,
                      pendingWire.bx,
                      pendingWire.by,
                    )}
                  />
                </svg>
              )}
              {children}
              {nodes.length === 0 && (
                <div className="nb2-empty">
                  Add an <b>Input</b>, then a <b>Filter</b> and an <b>Output</b>,
                  and wire them left → right.
                </div>
              )}
              {marquee && (
                <div
                  className="nb2-marquee"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}
            </div>
          </div>
        </div>
        <NodeMinimap
          nodes={nodes}
          selectedId={selectedId}
          zoom={zoom}
          viewport={viewport}
          mini={minimapMini}
          onToggle={onToggleMinimap}
          onPan={onPan}
        />
    </div>
  );
});
