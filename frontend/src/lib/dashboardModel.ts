/** App Dashboard workspace (multi-board) + widget bindings.
 *  Distinct from the NodeFlow chart-board node type named `dashboard`. */

export const DASHBOARD_WORKSPACE_KEY = "samql.dashboard.workspace.v2";
/** Legacy single-layout key (migrated on load). */
export const DASHBOARD_LAYOUT_KEY = "samql.dashboard.layout.v1";

export type DashboardOutputKind = "table" | "chart" | "pivot" | "reconcile";

export interface DashboardWidget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** data = NodeFlow-backed; text = section header / label strip. */
  kind?: "data" | "text";
  /** Body copy for text widgets (editable). */
  text?: string;
  /** Text body font size in px. */
  textSize?: number;
  /** CSS font-family for text body. */
  fontFamily?: string;
  /** Bold text body. */
  textBold?: boolean;
  /** Italic text body. */
  textItalic?: boolean;
  /** Underlined text body. */
  textUnderline?: boolean;
  /** Header chrome background (CSS color). Empty/undefined = theme default. */
  headerColor?: string;
  /** Widget surface background (CSS color). Empty/undefined = theme default. */
  backgroundColor?: string;
  /** Frosted / liquid-glass transparency on the widget surface. */
  liquidGlass?: boolean;
  /** Saved NodeFlow workflow name (kind=node) with a SamQL Dashboard sink. */
  workflowName?: string;
  title?: string;
  /** When false, the title chrome is hidden. */
  showHeader?: boolean;
  /** Header height in px (clamped). */
  headerHeight?: number;
}

export interface DashboardDoc {
  id: string;
  name: string;
  widgets: DashboardWidget[];
  /** Epoch ms when the board last finished a Run (success or cancel). */
  lastRunAt?: number;
  /** Wall time of that Run in milliseconds. */
  lastRunMs?: number;
}

export interface DashboardWorkspace {
  version: 2;
  activeId: string;
  /** Saved server name for the whole workspace (kind=dashboard), if any. */
  savedName?: string;
  /** Editable page heading (defaults to "Dashboard"). */
  pageTitle?: string;
  /** Page heading font size in px. */
  pageTitleSize?: number;
  /** CSS font-family for the page heading. */
  pageTitleFontFamily?: string;
  /** Bold page heading. */
  pageTitleBold?: boolean;
  /** Italic page heading. */
  pageTitleItalic?: boolean;
  /** Underlined page heading. */
  pageTitleUnderline?: boolean;
  /** Page heading text color (CSS color). Empty/undefined = theme default. */
  pageTitleColor?: string;
  dashboards: DashboardDoc[];
}

export const DASH_PAGE_TITLE_DEFAULT = "Dashboard";
export const DASH_PAGE_TITLE_SIZE_DEFAULT = 22;
export const DASH_PAGE_TITLE_SIZE_MIN = 14;
export const DASH_PAGE_TITLE_SIZE_MAX = 48;

/** Downloads bundle: boards + the NodeFlow graphs they reference. */
export interface DashboardExportBundle {
  samql: "dashboard-bundle";
  version: 1;
  exportedAt: string;
  workspace: DashboardWorkspace;
  workflows: { name: string; kind: "node"; graph: unknown }[];
}

export const DASH_COLS = 12;
export const DASH_ROW_PX = 96;
export const DASH_GAP = 12;
export const DASH_HEADER_DEFAULT = 34;
export const DASH_HEADER_MIN = 22;
export const DASH_HEADER_MAX = 72;
export const DASH_H_MAX = 40;
export const DASH_H_MIN_DATA = 2;
/** Fractional rows — text widgets hug their content. */
export const DASH_H_MIN_TEXT = 0.35;
export const DASH_TEXT_SIZE_DEFAULT = 22;
export const DASH_TEXT_SIZE_MIN = 12;
export const DASH_TEXT_SIZE_MAX = 72;
export const DASH_TEXT_FONTS: { label: string; value: string }[] = [
  { label: "Default", value: "inherit" },
  { label: "Segoe UI", value: '"Segoe UI", system-ui, sans-serif' },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet", value: '"Trebuchet MS", sans-serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times", value: '"Times New Roman", Times, serif' },
  { label: "Garamond", value: "Garamond, serif" },
  { label: "Courier", value: '"Courier New", Courier, monospace' },
];


export function emptyWidgets(): DashboardWidget[] {
  return [
    { id: "w1", kind: "data", x: 0, y: 0, w: 6, h: 3, showHeader: true, headerHeight: DASH_HEADER_DEFAULT },
    { id: "w2", kind: "data", x: 6, y: 0, w: 6, h: 3, showHeader: true, headerHeight: DASH_HEADER_DEFAULT },
    { id: "w3", kind: "data", x: 0, y: 3, w: 12, h: 3, showHeader: true, headerHeight: DASH_HEADER_DEFAULT },
  ];
}

export function newDashboardId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newDashboardWidgetId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyDashboardDoc(name = "Main"): DashboardDoc {
  return { id: newDashboardId(), name, widgets: emptyWidgets() };
}

export function emptyDashboardWorkspace(): DashboardWorkspace {
  const main = emptyDashboardDoc("Main");
  return { version: 2, activeId: main.id, dashboards: [main] };
}

/** Move a board by ``delta`` (−1 up / +1 down). No-op if out of range. */
export function moveDashboardInWorkspace(
  ws: DashboardWorkspace,
  id: string,
  delta: number,
): DashboardWorkspace {
  const idx = ws.dashboards.findIndex((d) => d.id === id);
  if (idx < 0) return ws;
  const to = idx + delta;
  if (to < 0 || to >= ws.dashboards.length) return ws;
  const next = ws.dashboards.slice();
  const [item] = next.splice(idx, 1);
  next.splice(to, 0, item!);
  return { ...ws, dashboards: next };
}

/** Rename a board; empty names are ignored. */
export function renameDashboardInWorkspace(
  ws: DashboardWorkspace,
  id: string,
  name: string,
): DashboardWorkspace {
  const trimmed = name.trim();
  if (!trimmed) return ws;
  return {
    ...ws,
    dashboards: ws.dashboards.map((d) =>
      d.id === id ? { ...d, name: trimmed } : d,
    ),
  };
}

/**
 * Remove a board. Always keeps at least one. If the active board is removed,
 * activates the neighbour that took its place (or the first remaining).
 */
export function deleteDashboardInWorkspace(
  ws: DashboardWorkspace,
  id: string,
): { ok: true; workspace: DashboardWorkspace } | { ok: false; error: string } {
  if (ws.dashboards.length <= 1) {
    return { ok: false, error: "Keep at least one dashboard." };
  }
  const idx = ws.dashboards.findIndex((d) => d.id === id);
  if (idx < 0) return { ok: false, error: "Dashboard not found." };
  const remaining = ws.dashboards.filter((d) => d.id !== id);
  let activeId = ws.activeId;
  if (activeId === id) {
    activeId =
      remaining[Math.min(idx, remaining.length - 1)]?.id || remaining[0]!.id;
  }
  return { ok: true, workspace: { ...ws, dashboards: remaining, activeId } };
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function normalizeWidget(raw: any): DashboardWidget | null {
  if (!raw || typeof raw.id !== "string") return null;
  const kind: "data" | "text" = raw.kind === "text" ? "text" : "data";
  const minH = kind === "text" ? DASH_H_MIN_TEXT : DASH_H_MIN_DATA;
  const base: DashboardWidget = {
    id: String(raw.id),
    x: clampInt(raw.x, 0, DASH_COLS - 1),
    y: Math.max(0, Number(raw.y) || 0),
    w: clampInt(raw.w, kind === "text" ? 2 : 2, DASH_COLS),
    h:
      kind === "text"
        ? clampNum(raw.h, minH, DASH_H_MAX, minH)
        : clampInt(raw.h, minH, DASH_H_MAX),
    kind,
    text: typeof raw.text === "string" ? raw.text : undefined,
    workflowName:
      kind === "text"
        ? undefined
        : typeof raw.workflowName === "string" && raw.workflowName.trim()
          ? raw.workflowName.trim()
          : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    showHeader: raw.showHeader !== false,
    headerHeight: clampInt(
      raw.headerHeight ?? DASH_HEADER_DEFAULT,
      DASH_HEADER_MIN,
      DASH_HEADER_MAX,
    ),
  };
  if (kind === "text") {
    base.textSize = clampInt(
      raw.textSize ?? DASH_TEXT_SIZE_DEFAULT,
      DASH_TEXT_SIZE_MIN,
      DASH_TEXT_SIZE_MAX,
    );
    if (typeof raw.fontFamily === "string" && raw.fontFamily.trim()) {
      base.fontFamily = raw.fontFamily.trim();
    }
    base.textBold = !!raw.textBold;
    base.textItalic = !!raw.textItalic;
    base.textUnderline = !!raw.textUnderline;
    base.h = fitTextWidgetHeight(base);
  }
  if (typeof raw.headerColor === "string" && raw.headerColor.trim()) {
    base.headerColor = raw.headerColor.trim();
  }
  if (typeof raw.backgroundColor === "string" && raw.backgroundColor.trim()) {
    base.backgroundColor = raw.backgroundColor.trim();
  }
  if (raw.liquidGlass === true) {
    base.liquidGlass = true;
  }
  return base;
}

/** Pixel height of a text widget body for the current copy + typography. */
export function textWidgetBodyPx(widget: Pick<
  DashboardWidget,
  "text" | "textSize"
>): number {
  const size = clampInt(
    widget.textSize ?? DASH_TEXT_SIZE_DEFAULT,
    DASH_TEXT_SIZE_MIN,
    DASH_TEXT_SIZE_MAX,
  );
  const lines = Math.max(1, String(widget.text || " ").split("\n").length);
  const padY = 14;
  return Math.ceil(size * 1.3 * lines) + padY;
}

/**
 * Grid-row height that hugs text content with only a little spare room under
 * the last line. Uses the same geometry as the absolute board layout.
 */
export function fitTextWidgetHeight(
  widget: Pick<
    DashboardWidget,
    "text" | "textSize" | "showHeader" | "headerHeight"
  >,
): number {
  const headerPx =
    widget.showHeader !== false
      ? widget.headerHeight ?? DASH_HEADER_DEFAULT
      : 0;
  // +8px: slight breathing room under the text, not a full empty row.
  const totalPx = headerPx + textWidgetBodyPx(widget) + 8;
  const pitch = DASH_ROW_PX + DASH_GAP;
  const h = (totalPx + DASH_GAP) / pitch;
  return Math.max(
    DASH_H_MIN_TEXT,
    Math.min(DASH_H_MAX, Math.round(h * 100) / 100),
  );
}

export function withFittedTextHeight(widget: DashboardWidget): DashboardWidget {
  if (widget.kind !== "text") return widget;
  return { ...widget, h: fitTextWidgetHeight(widget) };
}

/** Axis-aligned overlap in grid units (half-open on the right/bottom edge). */
export function widgetsOverlap(
  a: Pick<DashboardWidget, "x" | "y" | "w" | "h">,
  b: Pick<DashboardWidget, "x" | "y" | "w" | "h">,
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Push widgets down until none overlap. Order is top-to-bottom, left-to-right
 * so an expanded widget keeps its place and siblings move out of the way.
 */
/**
 * Pack widgets with vertical gravity: each sits as high as possible without
 * overlapping, so empty rows above are never left unused.
 */
export function packWidgetsNoOverlap(
  widgets: DashboardWidget[],
): DashboardWidget[] {
  const ordered = [...widgets].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );
  const placed: DashboardWidget[] = [];
  for (const w of ordered) {
    let y = 0;
    let guard = 0;
    while (
      guard++ < 400 &&
      placed.some((p) => widgetsOverlap({ ...w, y }, p))
    ) {
      const blockers = placed.filter((p) => widgetsOverlap({ ...w, y }, p));
      y = Math.max(...blockers.map((p) => p.y + p.h));
    }
    placed.push({ ...w, y });
  }
  const byId = new Map(placed.map((p) => [p.id, p]));
  return widgets.map((w) => byId.get(w.id) || w);
}

/** Grow (or set) one widget's size, then reflow with gravity packing. */
export function resizeWidgetFitting(
  widgets: DashboardWidget[],
  id: string,
  size: { w?: number; h?: number },
): DashboardWidget[] {
  const next = widgets.map((w) => {
    if (w.id !== id) return { ...w };
    const minH = w.kind === "text" ? DASH_H_MIN_TEXT : DASH_H_MIN_DATA;
    const nw =
      size.w != null
        ? Math.max(2, Math.min(DASH_COLS - w.x, Math.floor(size.w)))
        : w.w;
    const nh =
      size.h != null
        ? w.kind === "text"
          ? Math.max(minH, Math.min(DASH_H_MAX, size.h))
          : Math.max(minH, Math.min(DASH_H_MAX, Math.floor(size.h)))
        : w.h;
    return { ...w, w: nw, h: nh };
  });
  return packWidgetsNoOverlap(next);
}

/**
 * Keep ``focusId`` fixed (the widget under the pointer) and gravity-pack every
 * other widget around it so gaps close live while dragging/resizing.
 */
export function packAroundFocus(
  widgets: DashboardWidget[],
  focusId: string,
): DashboardWidget[] {
  const focus = widgets.find((w) => w.id === focusId);
  if (!focus) return packWidgetsNoOverlap(widgets);
  const others = widgets
    .filter((w) => w.id !== focusId)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const placed: DashboardWidget[] = [{ ...focus }];
  for (const w of others) {
    let y = 0;
    let guard = 0;
    while (
      guard++ < 400 &&
      placed.some((p) => widgetsOverlap({ ...w, y }, p))
    ) {
      const blockers = placed.filter((p) => widgetsOverlap({ ...w, y }, p));
      y = Math.max(...blockers.map((p) => p.y + p.h));
    }
    placed.push({ ...w, y });
  }
  const byId = new Map(placed.map((p) => [p.id, p]));
  return widgets.map((w) => byId.get(w.id) || w);
}

/** Convert content pixel size into grid units for the current board width. */
export function gridUnitsForContent(
  contentWidthPx: number,
  contentHeightPx: number,
  boardWidthPx: number,
  opts?: { minW?: number; minH?: number },
): { w: number; h: number } {
  const bw = Math.max(1, boardWidthPx);
  const colPitch = (bw - DASH_GAP * (DASH_COLS - 1)) / DASH_COLS + DASH_GAP;
  const rowPitch = DASH_ROW_PX + DASH_GAP;
  const w = Math.max(
    opts?.minW ?? 2,
    Math.min(DASH_COLS, Math.ceil((contentWidthPx + DASH_GAP) / colPitch)),
  );
  const h = Math.max(
    opts?.minH ?? DASH_H_MIN_DATA,
    Math.min(DASH_H_MAX, Math.ceil((contentHeightPx + DASH_GAP) / rowPitch)),
  );
  return { w, h };
}

export function normalizeDashboardDoc(raw: any): DashboardDoc | null {
  if (!raw || typeof raw.id !== "string") return null;
  const widgetsSrc = Array.isArray(raw.widgets)
    ? raw.widgets
    : Array.isArray(raw.cells)
      ? raw.cells
      : [];
  const widgets = widgetsSrc
    .map(normalizeWidget)
    .filter(Boolean) as DashboardWidget[];
  const lastRunAt =
    typeof raw.lastRunAt === "number" && Number.isFinite(raw.lastRunAt)
      ? raw.lastRunAt
      : undefined;
  const lastRunMs =
    typeof raw.lastRunMs === "number" && Number.isFinite(raw.lastRunMs)
      ? Math.max(0, Math.round(raw.lastRunMs))
      : undefined;
  return {
    id: String(raw.id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Dashboard",
    widgets: widgets.length ? widgets : emptyWidgets(),
    ...(lastRunAt != null ? { lastRunAt } : {}),
    ...(lastRunMs != null ? { lastRunMs } : {}),
  };
}

export function normalizeWorkspace(raw: any): DashboardWorkspace {
  if (!raw || raw.version === 2) {
    const docs = Array.isArray(raw?.dashboards)
      ? (raw.dashboards.map(normalizeDashboardDoc).filter(Boolean) as DashboardDoc[])
      : [];
    if (!docs.length) return emptyDashboardWorkspace();
    const activeId =
      typeof raw.activeId === "string" && docs.some((d) => d.id === raw.activeId)
        ? raw.activeId
        : docs[0].id;
    return {
      version: 2,
      activeId,
      savedName:
        typeof raw.savedName === "string" && raw.savedName.trim()
          ? raw.savedName.trim()
          : undefined,
      pageTitle:
        typeof raw.pageTitle === "string" && raw.pageTitle.trim()
          ? raw.pageTitle.trim()
          : undefined,
      pageTitleSize: clampInt(
        raw.pageTitleSize ?? DASH_PAGE_TITLE_SIZE_DEFAULT,
        DASH_PAGE_TITLE_SIZE_MIN,
        DASH_PAGE_TITLE_SIZE_MAX,
      ),
      ...(typeof raw.pageTitleFontFamily === "string" &&
      raw.pageTitleFontFamily.trim()
        ? { pageTitleFontFamily: raw.pageTitleFontFamily.trim() }
        : {}),
      ...(raw.pageTitleBold ? { pageTitleBold: true } : {}),
      ...(raw.pageTitleItalic ? { pageTitleItalic: true } : {}),
      ...(raw.pageTitleUnderline ? { pageTitleUnderline: true } : {}),
      ...(typeof raw.pageTitleColor === "string" && raw.pageTitleColor.trim()
        ? { pageTitleColor: raw.pageTitleColor.trim() }
        : {}),
      dashboards: docs,
    };
  }
  // Migrate v1 { version:1, cells } → workspace
  if (raw?.version === 1 && Array.isArray(raw.cells)) {
    const widgets = raw.cells.map(normalizeWidget).filter(Boolean) as DashboardWidget[];
    const doc: DashboardDoc = {
      id: newDashboardId(),
      name: "Main",
      widgets: widgets.length ? widgets : emptyWidgets(),
    };
    return { version: 2, activeId: doc.id, dashboards: [doc] };
  }
  return emptyDashboardWorkspace();
}

export function loadDashboardWorkspace(): DashboardWorkspace {
  try {
    const raw = window.localStorage?.getItem(DASHBOARD_WORKSPACE_KEY);
    if (raw) return normalizeWorkspace(JSON.parse(raw));
    const legacy = window.localStorage?.getItem(DASHBOARD_LAYOUT_KEY);
    if (legacy) {
      const ws = normalizeWorkspace(JSON.parse(legacy));
      saveDashboardWorkspace(ws);
      return ws;
    }
  } catch {
    /* fall through */
  }
  return emptyDashboardWorkspace();
}

export function saveDashboardWorkspace(ws: DashboardWorkspace): void {
  try {
    window.localStorage?.setItem(DASHBOARD_WORKSPACE_KEY, JSON.stringify(ws));
  } catch {
    /* best-effort */
  }
}

export function activeDashboard(ws: DashboardWorkspace): DashboardDoc {
  return ws.dashboards.find((d) => d.id === ws.activeId) || ws.dashboards[0];
}

export function collectWorkflowNames(ws: DashboardWorkspace): string[] {
  const names = new Set<string>();
  for (const d of ws.dashboards) {
    for (const w of d.widgets) {
      if (w.workflowName) names.add(w.workflowName);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** True when a NodeFlow graph includes at least one SamQL Dashboard sink. */
export function graphHasSamqlDashboard(graph: unknown): boolean {
  const nodes = (graph as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some(
    (n) => n && typeof n === "object" && (n as { type?: string }).type === "samqldash",
  );
}

export function findSamqlDashboardTargets(graph: {
  nodes?: { id?: string; type?: string; config?: Record<string, unknown> }[];
  edges?: {
    from?: { node?: string; port?: string };
    to?: { node?: string; port?: string };
  }[];
}): {
  dashId: string;
  upstreamId: string;
  upstreamType: string;
  upstreamConfig: Record<string, unknown>;
}[] {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const byId = new Map(nodes.filter((n) => n?.id).map((n) => [n.id as string, n]));
  const out: {
    dashId: string;
    upstreamId: string;
    upstreamType: string;
    upstreamConfig: Record<string, unknown>;
  }[] = [];
  for (const n of nodes) {
    if (!n || n.type !== "samqldash" || !n.id) continue;
    const edge = edges.find((e) => e?.to?.node === n.id && e?.to?.port === "in");
    const upId = edge?.from?.node;
    if (!upId) continue;
    const up = byId.get(upId);
    if (!up?.type) continue;
    out.push({
      dashId: n.id,
      upstreamId: upId,
      upstreamType: up.type,
      upstreamConfig: (up.config && typeof up.config === "object" ? up.config : {}) as Record<
        string,
        unknown
      >,
    });
  }
  return out;
}

export function kindFromUpstream(type: string): DashboardOutputKind {
  if (type === "chart") return "chart";
  if (type === "pivot") return "pivot";
  if (type === "reconcile") return "reconcile";
  return "table";
}

/** Compact wall-time label for the Run button footnote. */
export function formatDashboardRuntime(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n} ms`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.round(n / 1000)} s`;
}

/**
 * Last-run footnote: calendar date + time, with duration (always notes ms when
 * under 1s; otherwise keeps the compact runtime label which may include a
 * decimal second).
 */
export function formatDashboardLastRun(
  lastRunAt?: number,
  lastRunMs?: number,
): string {
  const parts: string[] = [];
  if (
    typeof lastRunAt === "number" &&
    Number.isFinite(lastRunAt) &&
    lastRunAt > 0
  ) {
    const d = new Date(lastRunAt);
    if (!Number.isNaN(d.getTime())) {
      parts.push(
        d.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    }
  }
  if (typeof lastRunMs === "number" && Number.isFinite(lastRunMs)) {
    parts.push(formatDashboardRuntime(lastRunMs));
  }
  if (!parts.length) return "";
  return parts.join(" · ");
}

// Back-compat aliases used by older tests
export type DashboardCell = DashboardWidget;
export type DashboardLayout = { version: 1; cells: DashboardWidget[] };
export const emptyDashboardLayout = (): DashboardLayout => ({
  version: 1,
  cells: emptyWidgets(),
});
export const loadDashboardLayout = (): DashboardLayout => {
  const ws = loadDashboardWorkspace();
  return { version: 1, cells: activeDashboard(ws).widgets };
};
export const saveDashboardLayout = (layout: DashboardLayout): void => {
  const ws = loadDashboardWorkspace();
  const active = activeDashboard(ws);
  active.widgets = layout.cells.map(normalizeWidget).filter(Boolean) as DashboardWidget[];
  saveDashboardWorkspace(ws);
};
export const newDashboardCellId = newDashboardWidgetId;
