import React, { useEffect, useRef } from "react";
import { startPointerDrag } from "../lib/pointerDrag";
import { Icon } from "./Icon";

export type TablesSideTab = "tables" | "history" | "saved";

/** Match NodeFlow: under this px of movement counts as a click, not a drag. */
const HANDLE_CLICK_SLOP_PX = 5;

export interface TablesSidebarDrawerProps {
  /** Settings → Toolbar Toggle: when false the whole rail is gone. */
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width: number;
  onResizePointerDown: (e: React.PointerEvent) => void;
  /** When true, inspector fills the drawer (force-open chrome). */
  inspectorMode?: boolean;
  children: React.ReactNode;
}

/**
 * Overlay slide-out for Tables / History / Workflows.
 * Closed = short left-edge folder-handle tab with hamburger; open = slide-in
 * with the same handle nested on the panel's right edge (drag to resize,
 * quick click to close). Inspector mode force-opens the panel but keeps the
 * same handle mounted. In-panel tabs (Sidebar) switch content while open
 * without re-sliding.
 */
export const TablesSidebarDrawer: React.FC<TablesSidebarDrawerProps> = ({
  enabled,
  open,
  onOpenChange,
  width,
  onResizePointerDown,
  inspectorMode = false,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  /** Suppress the synthetic click after an open-handle pointer gesture. */
  const suppressClickRef = useRef(false);
  const shown = enabled;
  const drawerOpen = shown && (open || inspectorMode);

  useEffect(() => {
    if (!drawerOpen || !shown) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target as Node | null;
      if (target && root.contains(target)) return;
      // Leave modal / menu / floating chrome alone (portaled outside .body).
      const el = target as Element | null;
      if (
        el?.closest?.(
          ".modal, .ctx-menu, .win-float, .confirm-pop, .toast, .drop-overlay, [role='dialog']",
        )
      ) {
        return;
      }
      // NodeFlow node press/drag must not close (or re-open via selection race)
      // the drawer — empty-canvas clicks still dismiss.
      if (document.documentElement.dataset.samqlNfDrag === "1") return;
      if (el?.closest?.(".nb2-node")) return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    // pointerdown so NodeFlow canvas / Journal clicks close before other handlers.
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen, shown, onOpenChange]);

  if (!shown) return null;

  const handleLabel = drawerOpen
    ? "Drag to resize, click to close tables panel"
    : "Open tables panel";

  const onPeekClick = () => {
    // After open-handle pointerdown we own close-vs-resize; ignore the follow-up click.
    if (suppressClickRef.current) return;
    onOpenChange(!drawerOpen);
  };

  const onPeekPointerDown = (e: React.PointerEvent) => {
    if (!drawerOpen) return;
    suppressClickRef.current = true;
    // Reuse gutter resize immediately so width tracks the pointer from frame 1.
    onResizePointerDown(e);
    const startX = e.clientX;
    const startY = e.clientY;
    let dragged = false;
    startPointerDrag({
      onMove: (ev) => {
        if (
          Math.abs(ev.clientX - startX) >= HANDLE_CLICK_SLOP_PX ||
          Math.abs(ev.clientY - startY) >= HANDLE_CLICK_SLOP_PX
        ) {
          dragged = true;
        }
      },
      onEnd: () => {
        if (!dragged) onOpenChange(false);
        // Clear after the click that follows pointerup in the same gesture.
        queueMicrotask(() => {
          suppressClickRef.current = false;
        });
      },
    });
  };

  return (
    <div
      ref={rootRef}
      className={
        "tables-sidebar-drawer" +
        (drawerOpen ? " is-open" : " is-closed") +
        (inspectorMode ? " is-inspector" : "")
      }
      style={{ ["--tables-sidebar-w" as string]: `${width}px` }}
      data-testid="tables-sidebar-drawer"
      data-open={drawerOpen ? "1" : "0"}
    >
      <div
        className="tables-sidebar-panel"
        data-testid="tables-sidebar-panel"
        aria-hidden={drawerOpen ? undefined : true}
      >
        <div className="sidebar tables-sidebar-inner">{children}</div>
        {!inspectorMode && (
          <div
            className="gutter-v tables-sidebar-gutter"
            onPointerDown={onResizePointerDown}
            data-testid="tables-sidebar-gutter"
          />
        )}
        {/* Nested on the panel's right edge so it cannot lag behind width changes. */}
        <div
          className="tables-sidebar-peek"
          data-testid="tables-sidebar-peek"
        >
          <button
            type="button"
            className="tables-sidebar-peek-menu"
            data-testid="tables-sidebar-peek-menu"
            title={handleLabel}
            aria-label={handleLabel}
            aria-expanded={drawerOpen}
            onClick={onPeekClick}
            onPointerDown={onPeekPointerDown}
          >
            <Icon.Menu size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
