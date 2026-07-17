import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface NodeFlowViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2.5;

/** Optional client-space pivot so zoom keeps that screen point fixed. */
export interface NodeFlowZoomPivot {
  clientX: number;
  clientY: number;
}

interface PendingZoomPivot {
  worldX: number;
  worldY: number;
  cursorX: number;
  cursorY: number;
}

export function useNodeFlowViewport(
  wrapRef: React.RefObject<HTMLDivElement | null>,
) {
  const [mmMini, setMmMini] = useState(() => {
    try {
      return window.localStorage?.getItem("samql.nbMinimapMini") === "1";
    } catch {
      return false;
    }
  });
  const [scrollPos, setScrollPos] = useState<NodeFlowViewportRect>({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const viewportFrameRef = useRef<number | null>(null);
  const pendingPivotRef = useRef<PendingZoomPivot | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const readViewport = useCallback(() => {
    const element = wrapRef.current;
    if (!element) return;
    const next = {
      x: element.scrollLeft,
      y: element.scrollTop,
      w: element.clientWidth,
      h: element.clientHeight,
    };
    setScrollPos((current) =>
      current.x === next.x &&
      current.y === next.y &&
      current.w === next.w &&
      current.h === next.h
        ? current
        : next,
    );
  }, [wrapRef]);

  // Scroll can emit many events in one paint. Coalesce them into one viewport
  // update so large canvases do not repeatedly cull the same frame.
  const measureViewport = useCallback(() => {
    if (viewportFrameRef.current != null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      readViewport();
    });
  }, [readViewport]);

  useEffect(() => {
    readViewport();
    window.addEventListener("resize", measureViewport);
    const element = wrapRef.current;
    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measureViewport())
        : null;
    if (element && observer) observer.observe(element);
    return () => {
      window.removeEventListener("resize", measureViewport);
      observer?.disconnect();
      if (viewportFrameRef.current != null) {
        cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = null;
      }
    };
  }, [measureViewport, readViewport, wrapRef]);

  // Apply cursor pivot after the scaler size updates with the new zoom.
  useLayoutEffect(() => {
    const pending = pendingPivotRef.current;
    const element = wrapRef.current;
    if (!pending || !element) return;
    pendingPivotRef.current = null;
    element.scrollLeft = pending.worldX * zoom - pending.cursorX;
    element.scrollTop = pending.worldY * zoom - pending.cursorY;
    readViewport();
  }, [zoom, readViewport, wrapRef]);

  const panTo = useCallback(
    (cx: number, cy: number) => {
      const element = wrapRef.current;
      if (!element) return;
      element.scrollLeft = cx * zoomRef.current - element.clientWidth / 2;
      element.scrollTop = cy * zoomRef.current - element.clientHeight / 2;
      readViewport();
    },
    [readViewport, wrapRef],
  );

  const toggleMinimap = useCallback(() => {
    setMmMini((current) => {
      const next = !current;
      try {
        window.localStorage?.setItem("samql.nbMinimapMini", next ? "1" : "0");
      } catch {
        // Private mode/quota: keep the in-memory preference for this session.
      }
      return next;
    });
  }, []);

  const zoomBy = useCallback(
    (multiplier: number, pivot?: NodeFlowZoomPivot) => {
      const prev = zoomRef.current;
      const next = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, prev * multiplier),
      );
      if (next === prev) return;

      const element = wrapRef.current;
      if (element && pivot) {
        const rect = element.getBoundingClientRect();
        const cursorX = pivot.clientX - rect.left;
        const cursorY = pivot.clientY - rect.top;
        pendingPivotRef.current = {
          worldX: (element.scrollLeft + cursorX) / prev,
          worldY: (element.scrollTop + cursorY) / prev,
          cursorX,
          cursorY,
        };
      } else {
        pendingPivotRef.current = null;
      }

      zoomRef.current = next;
      setZoom(next);
      measureViewport();
    },
    [measureViewport, wrapRef],
  );

  const resetZoom = useCallback(() => {
    zoomBy(1 / zoomRef.current);
  }, [zoomBy]);

  // Ctrl+wheel (and Windows Precision Touchpad pinch → ctrl+wheel) zooms the
  // canvas. Plain wheel keeps overflow scroll/pan. Non-passive so we can block
  // browser page-zoom while over the wrap.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const delta =
        event.deltaY !== 0
          ? event.deltaY
          : event.deltaX !== 0
            ? event.deltaX
            : 0;
      if (delta === 0) return;

      // Negative delta (scroll up / pinch-out) → zoom in; positive → zoom out.
      // Scale with |deltaY| so trackpad pinch (small deltas) and mouse wheel
      // ticks both feel responsive; per-event clamp keeps a single tick from
      // jumping too far while ZOOM_MIN/MAX still bound the absolute range.
      const raw = Math.exp(-delta * 0.005);
      const multiplier = Math.min(1.35, Math.max(1 / 1.35, raw));
      zoomBy(multiplier, { clientX: event.clientX, clientY: event.clientY });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [wrapRef, zoomBy]);

  return {
    mmMini,
    scrollPos,
    zoom,
    zoomRef,
    measureViewport,
    panTo,
    toggleMinimap,
    zoomBy,
    resetZoom,
  };
}
