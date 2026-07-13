// Pure geometry + state helpers behind the detachable panels (pop-out into a
// floating panel, drag it back over the pane to snap/dock) and the
// side-by-side result compare. Kept dependency-free and side-effect-free so
// the behaviour can be unit-tested without a DOM.

export type FloatView = "grid" | "chart" | "pivot";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FloatPanel {
  id: string; // stable key, "<resId>::<view>"
  resId: string; // the result tab this panel detached from
  view: FloatView; // which view (grid/chart/pivot) is floating
  x: number;
  y: number;
  width: number;
  height: number;
  z: number; // stacking order; higher is on top
}

export interface CompareState {
  left: string; // result id shown on the left
  right: string; // result id shown on the right
}

// A floating panel is uniquely identified by its result + view, so the same
// view can't be popped out twice.
export function floatKey(resId: string, view: FloatView): string {
  return resId + "::" + view;
}

export function hasFloat(
  floats: FloatPanel[],
  resId: string,
  view: FloatView,
): boolean {
  const k = floatKey(resId, view);
  return floats.some((f) => f.id === k);
}

// Place a new panel with a slight cascade so stacked pop-outs don't perfectly
// overlap. Clamped to stay on-screen.
export function addFloat(
  floats: FloatPanel[],
  resId: string,
  view: FloatView,
  viewport: { width: number; height: number },
  topZ: number,
): FloatPanel[] {
  if (hasFloat(floats, resId, view)) {
    // already open -> just raise it
    return bringToFront(floats, floatKey(resId, view), topZ);
  }
  const w = Math.min(720, Math.max(360, Math.round(viewport.width * 0.55)));
  const h = Math.min(520, Math.max(260, Math.round(viewport.height * 0.55)));
  const offset = (floats.length % 6) * 28;
  const x = clamp(
    Math.round(viewport.width * 0.22) + offset,
    8,
    Math.max(8, viewport.width - w - 8),
  );
  const y = clamp(
    Math.round(viewport.height * 0.16) + offset,
    8,
    Math.max(8, viewport.height - h - 8),
  );
  return floats.concat({
    id: floatKey(resId, view),
    resId,
    view,
    x,
    y,
    width: w,
    height: h,
    z: topZ + 1,
  });
}

export function removeFloat(floats: FloatPanel[], id: string): FloatPanel[] {
  return floats.filter((f) => f.id !== id);
}

// Drop every floating panel that belongs to a result tab (used when the tab is
// closed) so we never leave an orphaned window behind.
export function removeFloatsForResult(
  floats: FloatPanel[],
  resId: string,
): FloatPanel[] {
  return floats.filter((f) => f.resId !== resId);
}

export function bringToFront(
  floats: FloatPanel[],
  id: string,
  topZ: number,
): FloatPanel[] {
  return floats.map((f) => (f.id === id ? { ...f, z: topZ + 1 } : f));
}

export function maxZ(floats: FloatPanel[]): number {
  return floats.reduce((m, f) => (f.z > m ? f.z : m), 0);
}

export function moveFloat(
  floats: FloatPanel[],
  id: string,
  x: number,
  y: number,
): FloatPanel[] {
  return floats.map((f) => (f.id === id ? { ...f, x, y } : f));
}

export function resizeFloat(
  floats: FloatPanel[],
  id: string,
  width: number,
  height: number,
): FloatPanel[] {
  return floats.map((f) =>
    f.id === id
      ? { ...f, width: Math.max(220, width), height: Math.max(140, height) }
      : f,
  );
}

export function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// Keep a panel's top-left so the panel stays within the viewport (leaving a
// small margin and always keeping the title bar reachable).
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  vw: number,
  vh: number,
  margin = 8,
): { x: number; y: number } {
  return {
    x: clamp(x, margin - width + 80, vw - 80),
    y: clamp(y, margin, Math.max(margin, vh - 40)),
  };
}

// Fraction of `panel` that lies inside `zone` (0..1). Used to decide whether a
// dragged panel is over its home pane enough to snap back.
export function overlapFraction(panel: Rect, zone: Rect): number {
  const ix = Math.max(
    0,
    Math.min(panel.left + panel.width, zone.left + zone.width) -
      Math.max(panel.left, zone.left),
  );
  const iy = Math.max(
    0,
    Math.min(panel.top + panel.height, zone.top + zone.height) -
      Math.max(panel.top, zone.top),
  );
  const inter = ix * iy;
  const area = panel.width * panel.height;
  return area <= 0 ? 0 : inter / area;
}

// True when the dragged panel covers the dock zone enough to snap. We also
// accept the case where the pointer itself is inside the zone, which makes
// docking feel responsive even with a large panel.
export function shouldDock(
  panel: Rect,
  zone: Rect | null,
  pointer?: { x: number; y: number },
  threshold = 0.35,
): boolean {
  if (!zone) return false;
  if (
    pointer &&
    pointer.x >= zone.left &&
    pointer.x <= zone.left + zone.width &&
    pointer.y >= zone.top &&
    pointer.y <= zone.top + zone.height
  ) {
    return true;
  }
  return overlapFraction(panel, zone) >= threshold;
}

// ---- compare (two results in one pane) ------------------------------------

// Start (or retarget) a side-by-side compare: the currently active result on
// the left, the dragged-in result on the right. Dropping a tab that is already
// part of the pair collapses back to a single result (the literal "drag a tab
// back over the main result to snap back to one").
export function applyCompareDrop(
  current: CompareState | null,
  activeResId: string | null,
  draggedResId: string,
): CompareState | null {
  if (current) {
    if (draggedResId === current.left || draggedResId === current.right) {
      return null; // drop one of the compared tabs back -> un-split
    }
    return { left: current.left, right: draggedResId };
  }
  if (!activeResId || activeResId === draggedResId) return null;
  return { left: activeResId, right: draggedResId };
}

// Drop a compare if either side's result no longer exists (closed/expired).
export function pruneCompare(
  compare: CompareState | null,
  liveResIds: string[],
): CompareState | null {
  if (!compare) return null;
  const live = new Set(liveResIds);
  return live.has(compare.left) && live.has(compare.right) ? compare : null;
}
