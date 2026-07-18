import React, { useRef } from "react";
import { wirePath } from "../lib/nodegraph";
import type { NodeFlowWire } from "./nodeflow/nodeFlowRenderModel";
import { useRenderCount } from "../lib/renderDebug";
import {
  type NbNode,
  type CanvasNodeMemoState,
  isNodeFlowPointerDragging,
  nodeHeight,
  nodeWidth,
  sameCanvasNodeMemoState,
} from "../lib/nodeFlowModel";

export type Wire = NodeFlowWire;

const WireRow = React.memo(
  function WireRow({
    w,
    selected,
    retracting,
    glowing,
    onSelect,
    onDelete,
  }: {
    w: Wire;
    selected: boolean;
    retracting: boolean;
    glowing: boolean;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
  }) {
    // One Bezier string shared by hit / line / glow (was 3× wirePath per wire).
    const d = wirePath(w.ax, w.ay, w.bx, w.by);
    const mx = (w.ax + w.bx) / 2;
    const my = (w.ay + w.by) / 2;
    return (
      <g
        className={
          "nb2-wire" + (selected ? " sel" : "") + (retracting ? " retract" : "")
        }
        data-testid={retracting ? "nodeflow-wire-retracting" : undefined}
      >
        <path
          className="nb2-wire-hit"
          d={d}
          onClick={(e) => {
            e.stopPropagation();
            if (retracting) return;
            onSelect(w.id);
          }}
        />
        <path className="nb2-wire-line" d={d} pathLength={1} />
        <path
          className={"nb2-wire-glow" + (glowing ? " active" : "")}
          d={d}
          pathLength={1}
        />
        <g
          className="nb2-wire-del"
          transform={`translate(${mx},${my})`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (retracting) return;
            onDelete(w.id);
          }}
        >
          <title>Delete connection</title>
          <circle className="nb2-wire-del-hit" r="13" />
          <circle className="nb2-wire-del-dot" r="9" />
          <path
            className="nb2-wire-del-x"
            d="M -3.2 -3.2 L 3.2 3.2 M 3.2 -3.2 L -3.2 3.2"
          />
        </g>
      </g>
    );
  },
  // Ignore unstable dispatcher identity — Scene may recreate callbacks each
  // render; wire geometry / selection flags are what matter for paint.
  (prev, next) =>
    prev.w === next.w &&
    prev.selected === next.selected &&
    prev.retracting === next.retracting &&
    prev.glowing === next.glowing,
);

// Committed wires are pure geometry. Keeping them outside NodeFlow means
// inspector/config state cannot make the SVG tree reconcile unnecessarily.
// Per-wire memo: dirty-wire patch preserves object identity for stationary
// wires so only moved endpoints re-render.
export const WireLayer = React.memo(function WireLayer({
  wires,
  selectedId,
  onSelect,
  onDelete,
  dying,
  dyingEdges,
  runningNodeIds = null,
}: {
  wires: Wire[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** Node ids whose connected wires should retract (node delete). */
  dying?: Set<string>;
  /** Edge ids currently playing the connector-delete retract animation. */
  dyingEdges?: Set<string>;
  /** Null means per-node state is unavailable, so CSS may use the global fallback. */
  runningNodeIds?: Set<string> | null;
}) {
  return (
    <svg className="nb2-wires">
      {wires.map((w) => {
        const retracting =
          !!dyingEdges?.has(w.id) ||
          !!(dying && (dying.has(w.fromN) || dying.has(w.toN)));
        const glowing = runningNodeIds == null || runningNodeIds.has(w.toN);
        return (
          <WireRow
            key={w.id}
            w={w}
            selected={w.id === selectedId}
            retracting={retracting}
            glowing={glowing}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        );
      })}
    </svg>
  );
});

interface CanvasNodeFrameProps extends CanvasNodeMemoState {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, node: NbNode) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, node: NbNode) => void;
  children: React.ReactNode;
}

function CanvasNodeFrameImpl({
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
  onPointerDown,
  onContextMenu,
  children,
}: CanvasNodeFrameProps) {
  useRenderCount(`NodeFlowNode:${node.id}`);
  return (
    <div
      data-testid="nodeflow-node"
      data-node-id={node.id}
      data-node-type={node.type}
      data-node-label={String(node.config.label || node.type)}
      className={
        "nb2-node " +
        node.type +
        (selected ? " sel" : "") +
        (dropHover ? " drophover" : "") +
        (error ? " err" : warning ? " warn" : "") +
        (node.config.disabled ? " bypassed" : "") +
        (ripple ? " ripple" : "") +
        (snapped ? " snap" : "") +
        (dying ? " dying" : "") +
        (born ? " born" : "") +
        (lineageFlash ? " lineage-flash" : "")
      }
      title={error ? "Error: " + error : warning || undefined}
      style={{
        left: node.x,
        top: node.y,
        width: nodeWidth(node),
        height: nodeHeight(node),
        ...(ripple
          ? { animationDelay: Math.min(index * 35, 420) + "ms" }
          : {}),
      }}
      onPointerDown={(e) => onPointerDown(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      {children}
    </div>
  );
}

// React normally treats the freshly-created JSX children/callbacks as changed
// on every parent render. The custom comparison intentionally keys the node
// body on the actual model + explicit external versions instead. During a
// multi-node drag, setNodes preserves object identity for every stationary
// node, so only the moved nodes and wire/minimap geometry reconcile each frame.
export const CanvasNodeFrame = React.memo(
  CanvasNodeFrameImpl,
  (a, b) => sameCanvasNodeMemoState(a, b),
);

export interface MinimapViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const NodeMinimap = React.memo(function NodeMinimap({
  nodes,
  selectedId,
  zoom,
  viewport,
  mini,
  onToggle,
  onPan,
}: {
  nodes: NbNode[];
  selectedId: string | null;
  zoom: number;
  viewport: MinimapViewport;
  mini: boolean;
  onToggle: () => void;
  onPan: (x: number, y: number) => void;
}) {
  const boundsRef = useRef<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    scale: number;
  } | null>(null);
  if (!nodes.length) return null;
  const MM_W = 172;
  const MM_H = 116;
  const PAD = 60;
  const z = zoom || 1;
  const vx = viewport.x / z;
  const vy = viewport.y / z;
  const vw = viewport.w / z;
  const vh = viewport.h / z;
  const dragging = isNodeFlowPointerDragging();
  // Mid-drag: freeze world bounds (no O(n) rescan). Node rects still use live
  // positions so the dragged card moves on the minimap.
  if (!dragging || !boundsRef.current) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + nodeWidth(n));
      maxY = Math.max(maxY, n.y + nodeHeight(n));
    }
    minX = Math.min(minX, vx) - PAD;
    minY = Math.min(minY, vy) - PAD;
    maxX = Math.max(maxX, vx + vw) + PAD;
    maxY = Math.max(maxY, vy + vh) + PAD;
    boundsRef.current = {
      minX,
      minY,
      maxX,
      maxY,
      scale: Math.min(
        MM_W / Math.max(1, maxX - minX),
        MM_H / Math.max(1, maxY - minY),
      ),
    };
  }
  const frozen = boundsRef.current;
  const minX = frozen.minX;
  const minY = frozen.minY;
  const maxX = frozen.maxX;
  const maxY = frozen.maxY;
  const scale = frozen.scale;
  const tx = (cx: number) => (cx - minX) * scale;
  const ty = (cy: number) => (cy - minY) * scale;
  const onMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPan(minX + (e.clientX - r.left) / scale,
          minY + (e.clientY - r.top) / scale);
  };

  return (
    <div
      className={"nb2-minimap" + (mini ? " mini" : "")}
      style={mini ? { width: 30, height: 30 } : { width: MM_W, height: MM_H }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={mini ? undefined : onMouseDown}
      title={mini ? "Expand the minimap" : "Click to jump there"}
    >
      <button
        className="nb2-mm-toggle"
        title={mini ? "Expand the minimap" : "Shrink the minimap"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {mini ? "◱" : "–"}
      </button>
      {!mini && (
        <svg width={MM_W} height={MM_H}>
          {nodes.map((n) => (
            <rect
              key={n.id}
              x={tx(n.x)}
              y={ty(n.y)}
              width={Math.max(2, nodeWidth(n) * scale)}
              height={Math.max(2, nodeHeight(n) * scale)}
              rx={1.5}
              className={"nb2-mm-node" + (n.id === selectedId ? " sel" : "")}
            />
          ))}
          <rect
            x={tx(vx)}
            y={ty(vy)}
            width={Math.max(4, vw * scale)}
            height={Math.max(4, vh * scale)}
            className="nb2-mm-view"
          />
        </svg>
      )}
    </div>
  );
});
