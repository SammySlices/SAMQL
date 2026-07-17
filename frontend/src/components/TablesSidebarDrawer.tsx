import React, { useEffect, useRef } from "react";
import { Icon } from "./Icon";

export type TablesSideTab = "tables" | "history" | "saved";

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
 * with the same handle on the panel's right edge (toggle to close).
 * Inspector mode force-opens the panel but keeps the same handle mounted.
 * In-panel tabs (Sidebar) switch content while open without re-sliding.
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

  const handleLabel = drawerOpen ? "Close tables panel" : "Open tables panel";

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
      {/* Folder-handle tab stays mounted open + closed, including inspector. */}
      <div className="tables-sidebar-peek" data-testid="tables-sidebar-peek">
        <button
          type="button"
          className="tables-sidebar-peek-menu"
          data-testid="tables-sidebar-peek-menu"
          title={handleLabel}
          aria-label={handleLabel}
          aria-expanded={drawerOpen}
          onClick={() => onOpenChange(!drawerOpen)}
        >
          <Icon.Menu size={18} />
        </button>
      </div>

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
      </div>
    </div>
  );
};
