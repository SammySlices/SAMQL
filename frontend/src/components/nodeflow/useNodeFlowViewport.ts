import { useCallback, useEffect, useRef, useState } from "react";

export interface NodeFlowViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;

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
    (multiplier: number) => {
      const next = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, zoomRef.current * multiplier),
      );
      zoomRef.current = next;
      setZoom(next);
      measureViewport();
    },
    [measureViewport],
  );

  const resetZoom = useCallback(() => {
    zoomBy(1 / zoomRef.current);
  }, [zoomBy]);

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
