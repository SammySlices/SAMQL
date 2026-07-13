import React from "react";
import { createPortal } from "react-dom";
import { startPointerDrag } from "../../lib/pointerDrag";

export const InspectorShell: React.FC<{
  host: HTMLElement | null | undefined;
  docked: boolean;
  empty: boolean;
  hasResize: boolean;
  hidden: boolean;
  width?: number | null;
  onResize?: (w: number) => void;
  children: React.ReactNode;
}> = ({ host, docked, empty, hasResize, hidden, width, onResize, children }) => {
  if (hidden) return null;
  const cls =
    "nb2-inspector" +
    (empty ? " is-empty" : "") +
    (hasResize ? " has-resize" : "") +
    (docked ? " docked" : "");
  const style: React.CSSProperties | undefined =
    !docked && typeof width === "number"
      ? { width, maxWidth: width }
      : undefined;
  const el = (
    <div className={cls} style={style}>
      {children}
      {!docked && !empty && onResize && (
        <div
          className="nb2-insp-resize"
          title="Drag to resize the panel"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const panel = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
            const startW = panel ? panel.getBoundingClientRect().width : 300;
            const onMove = (ev: PointerEvent) => {
              const dx = ev.clientX - startX;
              const cap = Math.max(320, window.innerWidth - 120);
              onResize(Math.max(280, Math.min(cap, startW + dx)));
            };
            startPointerDrag({ onMove });
          }}
        />
      )}
    </div>
  );
  if (docked && host && !empty) return createPortal(el, host);
  return el;
};
