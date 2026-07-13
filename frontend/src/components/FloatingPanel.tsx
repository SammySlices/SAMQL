import React, { useRef } from "react";
import { Icon } from "./Icon";
import { shouldDock, type Rect } from "../lib/docking";

interface Props {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  // the rect of the pane this panel can snap back into (live, in viewport
  // coords); null while unknown.
  getDockRect: () => Rect | null;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
  // fired as the panel crosses in/out of the dock zone while dragging, so the
  // parent can highlight the drop target.
  onDockHover: (over: boolean) => void;
  // snap back into the pane (drag-over-and-release, the dock button, or close)
  onDock: () => void;
  onFocus: () => void;
  children: React.ReactNode;
}

export const FloatingPanel: React.FC<Props> = ({
  title,
  x,
  y,
  width,
  height,
  z,
  getDockRect,
  onMove,
  onResize,
  onDockHover,
  onDock,
  onFocus,
  children,
}) => {
  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
    over: boolean;
    mode: "move" | "resize";
  } | null>(null);

  // .459: shadow deepens while held; a one-shot settle on release.
  const [fpDragging, setFpDragging] = React.useState(false);
  const [fpSettled, setFpSettled] = React.useState(false);
  const settleTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (settleTimer.current != null)
        window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const beginMove = (e: React.PointerEvent) => {
    setFpDragging(true);
    setFpSettled(false);
    if (e.button !== 0) return;
    onFocus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      ox: x,
      oy: y,
      over: false,
      mode: "move",
    };
    e.preventDefault();
  };

  const beginResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onFocus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      ox: width,
      oy: height,
      over: false,
      mode: "resize",
    };
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = elRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.mode === "resize") {
      const w = Math.max(220, d.ox + dx);
      const h = Math.max(140, d.oy + dy);
      el.style.width = w + "px";
      el.style.height = h + "px";
      return;
    }
    // move: mutate the DOM directly for smoothness; commit to state on release
    const nx = d.ox + dx;
    const ny = Math.max(0, d.oy + dy);
    el.style.left = nx + "px";
    el.style.top = ny + "px";
    const rect: Rect = { left: nx, top: ny, width, height };
    const over = shouldDock(rect, getDockRect(), {
      x: e.clientX,
      y: e.clientY,
    });
    if (over !== d.over) {
      d.over = over;
      onDockHover(over);
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = elRef.current;
    drag.current = null;
    setFpDragging(false);
    if (d) {
      setFpSettled(true);
      if (settleTimer.current != null)
        window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        setFpSettled(false);
        settleTimer.current = null;
      }, 320);
    }
    if (!d || !el) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d.mode === "resize") {
      onResize(parseFloat(el.style.width) || width, parseFloat(el.style.height) || height);
      return;
    }
    if (d.over) {
      onDockHover(false);
      onDock(); // snapped back into the pane
      return;
    }
    onMove(parseFloat(el.style.left) || x, parseFloat(el.style.top) || y);
  };

  return (
    <div
      ref={elRef}
      className={
        "float-panel" +
        (fpDragging ? " dragging" : "") +
        (fpSettled ? " settle" : "")
      }
      style={{ left: x, top: y, width, height, zIndex: 1000 + z }}
      onPointerDown={onFocus}
    >
      <div
        className="float-bar"
        onPointerDown={beginMove}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDock}
        title="Drag me back over the pane to dock"
      >
        <Icon.PopOut size={12} />
        <span className="float-title">{title}</span>
        <span className="spacer" />
        <button
          className="float-btn"
          title="Dock back into the pane"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDock}
        >
          <Icon.Dock size={13} />
        </button>
        <button
          className="float-btn"
          title="Close (returns to the pane)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDock}
        >
          <Icon.X size={13} />
        </button>
      </div>
      <div className="float-body">{children}</div>
      <div
        className="float-resize"
        onPointerDown={beginResize}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Resize"
      />
    </div>
  );
};
