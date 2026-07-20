import React, { useEffect, useRef, useState } from "react";
import { startPointerDrag } from "../lib/pointerDrag";
import { Icon } from "./Icon";

export type TablesSideTab = "tables" | "history" | "saved";

/** Match NodeFlow: under this px of movement counts as a click, not a drag. */
const HANDLE_CLICK_SLOP_PX = 5;
/** Leave-delay so moving from the edge strip onto the hamburger / panel is not lost. */
const HIDE_DELAY_MS = 280;

export interface TablesSidebarDrawerProps {
  /** Settings → Toolbar Toggle: when false the whole rail is gone. */
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width: number;
  onResizePointerDown: (e: React.PointerEvent) => void;
  /** When true, inspector fills the drawer (force-open chrome). */
  inspectorMode?: boolean;
  /**
   * Settings → Visual Toggles: when true, edge hover opens the full drawer
   * (legacy). When false (default), hover shows only the hamburger; click opens.
   */
  hoverOpenFull?: boolean;
  /** When true, stay open — ignore Escape / outside click / handle close. */
  pinned?: boolean;
  children: React.ReactNode;
}

/**
 * Overlay slide-out for Tables / History / Workflows.
 * Default: closed = thin left-edge hit strip; hover reveals only the
 * folder-handle hamburger — click it to open. Close via Escape, outside
 * click, or a quick handle click. With hoverOpenFull, edge hover opens the
 * full panel and leave auto-hides (legacy). Inspector mode force-opens and
 * skips auto-hide. In-panel tabs switch content while open without re-sliding.
 */
export const TablesSidebarDrawer: React.FC<TablesSidebarDrawerProps> = ({
  enabled,
  open,
  onOpenChange,
  width,
  onResizePointerDown,
  inspectorMode = false,
  hoverOpenFull = false,
  pinned = false,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  /** Suppress the synthetic click after an open-handle pointer gesture. */
  const suppressClickRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const hoverOpenFullRef = useRef(hoverOpenFull);
  hoverOpenFullRef.current = hoverOpenFull;
  /** Edge approach while closed (hamburger-only mode): show handle, not panel. */
  const [peeking, setPeeking] = useState(false);
  const shown = enabled;
  const drawerOpen = shown && (open || inspectorMode || pinned);
  const handleVisible = drawerOpen || peeking;

  const clearHideTimer = () => {
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const onEdgeApproach = () => {
    clearHideTimer();
    if (document.documentElement.dataset.samqlNfDrag === "1") return;
    if (hoverOpenFullRef.current) {
      setPeeking(false);
      if (!open) onOpenChangeRef.current(true);
      return;
    }
    if (!drawerOpen) setPeeking(true);
  };

  const scheduleLeave = () => {
    if (inspectorMode || pinned) return;
    // Default mode: once open, stay until Escape / outside / handle close.
    if (!hoverOpenFullRef.current && (open || inspectorMode || pinned)) return;
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setPeeking(false);
      if (hoverOpenFullRef.current) {
        onOpenChangeRef.current(false);
      }
    }, HIDE_DELAY_MS);
  };

  useEffect(() => () => clearHideTimer(), []);

  useEffect(() => {
    if (drawerOpen) {
      clearHideTimer();
      setPeeking(false);
    }
  }, [drawerOpen]);

  useEffect(() => {
    if (hoverOpenFull) setPeeking(false);
  }, [hoverOpenFull]);

  useEffect(() => {
    if (!drawerOpen || !shown || pinned) return;
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
      clearHideTimer();
      setPeeking(false);
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearHideTimer();
        setPeeking(false);
        onOpenChange(false);
      }
    };
    // pointerdown so NodeFlow canvas / Journal clicks close before other handlers.
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen, shown, pinned, onOpenChange]);

  if (!shown) return null;

  const handleLabel = drawerOpen
    ? "Drag to resize, click to close tables panel"
    : "Open tables panel";

  const edgeLabel = hoverOpenFull
    ? "Open tables panel"
    : "Show tables panel handle";

  const onPeekClick = () => {
    // After open-handle pointerdown we own close-vs-resize; ignore the follow-up click.
    if (suppressClickRef.current) return;
    clearHideTimer();
    setPeeking(false);
    // Pinned: stay open (handle click must not dismiss).
    if (pinned && drawerOpen) return;
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
        if (!dragged && !pinned) {
          clearHideTimer();
          setPeeking(false);
          onOpenChange(false);
        }
        // Clear after the click that follows pointerup in the same gesture.
        queueMicrotask(() => {
          suppressClickRef.current = false;
        });
      },
    });
  };

  const onRootBlurCapture = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    scheduleLeave();
  };

  return (
    <div
      ref={rootRef}
      className={
        "tables-sidebar-drawer" +
        (drawerOpen ? " is-open" : " is-closed") +
        (peeking && !drawerOpen ? " is-peek" : "") +
        (inspectorMode ? " is-inspector" : "")
      }
      style={{ ["--tables-sidebar-w" as string]: `${width}px` }}
      data-testid="tables-sidebar-drawer"
      data-open={drawerOpen ? "1" : "0"}
      data-peek={peeking && !drawerOpen ? "1" : "0"}
      data-hover-open-full={hoverOpenFull ? "1" : "0"}
      onPointerEnter={onEdgeApproach}
      onPointerLeave={scheduleLeave}
      onFocusCapture={onEdgeApproach}
      onBlurCapture={onRootBlurCapture}
    >
      {/* Full-height left hit strip while closed. */}
      <button
        type="button"
        className="tables-sidebar-edge"
        data-testid="tables-sidebar-edge"
        tabIndex={drawerOpen ? -1 : 0}
        aria-hidden={drawerOpen ? true : undefined}
        aria-label={edgeLabel}
        aria-expanded={drawerOpen}
        title={edgeLabel}
        onClick={() => {
          clearHideTimer();
          if (hoverOpenFull) {
            setPeeking(false);
            onOpenChange(true);
          } else {
            setPeeking(true);
          }
        }}
      />
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
        {/* Nested on the panel's right edge so it cannot lag behind width changes.
            While closed+peeking the panel stays off-screen; the handle sits at
            the viewport left edge (left:100% of a -100% translated panel). */}
        <div
          className="tables-sidebar-peek"
          data-testid="tables-sidebar-peek"
        >
          <button
            type="button"
            className="tables-sidebar-peek-menu"
            data-testid="tables-sidebar-peek-menu"
            tabIndex={handleVisible ? 0 : -1}
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
