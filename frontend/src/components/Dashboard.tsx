import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api, saveToDownloads } from "../lib/api";
import { exportDashboardElementToPdf } from "../lib/dashboardPdf";
import {
  activeDashboard,
  collectWorkflowNames,
  DASH_COLS,
  DASH_GAP,
  DASH_HEADER_DEFAULT,
  DASH_HEADER_MAX,
  DASH_HEADER_MIN,
  DASH_H_MIN_DATA,
  DASH_ROW_PX,
  emptyDashboardDoc,
  findSamqlDashboardTargets,
  formatDashboardLastRun,
  formatDashboardRuntime,
  graphHasSamqlDashboard,
  gridUnitsForContent,
  kindFromUpstream,
  loadDashboardWorkspace,
  newDashboardWidgetId,
  normalizeWorkspace,
  packAroundFocus,
  packWidgetsNoOverlap,
  resizeWidgetFitting,
  saveDashboardWorkspace,
  DASH_PAGE_TITLE_DEFAULT,
  DASH_PAGE_TITLE_SIZE_DEFAULT,
  DASH_PAGE_TITLE_SIZE_MAX,
  DASH_PAGE_TITLE_SIZE_MIN,
  groupDashTextFonts,
  DASH_TEXT_SIZE_DEFAULT,
  DASH_TEXT_SIZE_MAX,
  DASH_TEXT_SIZE_MIN,
  type DashboardDoc,
  type DashboardExportBundle,
  type DashboardWidget,
  type DashboardWorkspace,
  withFittedTextHeight,
} from "../lib/dashboardModel";
import type { ChartData, ResultPage } from "../lib/types";
import {
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
  wasCancelled,
} from "../lib/runController";
import { uid } from "../lib/ids";
import { parseWfFile, wfEnvelope, wfFileName, wfKindSurface } from "../lib/workflowFile";
import { Icon } from "./Icon";
import { DataGrid } from "./DataGrid";
import { ChartView } from "./ChartView";
import { FileBrowser } from "./LoadDataModal";
import { useWinDrag } from "./ActivityShared";
import { useConfirmPop } from "./ConfirmPop";

type ToastFn = (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;

/** Persisted chrome for the Field Explore–style dashboard config float. */
const DASH_CONFIG_STORE_KEY = "samql.dashboard.configChrome.v1";

type DashConfigChrome = {
  x?: number;
  y?: number;
  minimized?: boolean;
};

function loadDashConfigChrome(): DashConfigChrome {
  try {
    const raw = localStorage.getItem(DASH_CONFIG_STORE_KEY);
    return raw ? (JSON.parse(raw) as DashConfigChrome) : {};
  } catch {
    return {};
  }
}

function saveDashConfigChrome(patch: DashConfigChrome) {
  try {
    const next = { ...loadDashConfigChrome(), ...patch };
    localStorage.setItem(DASH_CONFIG_STORE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Grouped `<option>`s for page-title and text-widget font pickers. */
function DashTextFontSelectOptions() {
  return (
    <>
      {groupDashTextFonts().map(({ group, fonts }) =>
        group === "Default" ? (
          <React.Fragment key={group}>
            {fonts.map((f) => (
              <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                {f.label}
              </option>
            ))}
          </React.Fragment>
        ) : (
          <optgroup key={group} label={group}>
            {fonts.map((f) => (
              <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                {f.label}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </>
  );
}

export type DashboardCommand = {
  id: number;
  action: "save" | "saveAs" | "open" | "export";
};

type WidgetResult =
  | {
      kind: "table" | "pivot";
      page: ResultPage;
      sortCol: string | null;
      descending: boolean;
    }
  | { kind: "chart"; data: ChartData }
  | {
      kind: "reconcile";
      data: {
        totals?: Record<string, number>;
        fields?: {
          field: string;
          matching: number;
          non_matching: number;
          a_only: number;
          b_only: number;
        }[];
      };
    }
  | { kind: "error"; message: string }
  | { kind: "loading" };

function DashboardWidgetBody({
  widget,
  result,
  onOpenPicker,
  onTextChange,
  onSort,
  onContentMetrics,
}: {
  widget: DashboardWidget;
  result: WidgetResult | undefined;
  onOpenPicker: () => void;
  onTextChange: (text: string) => void;
  onSort: (col: string) => void;
  onContentMetrics?: (m: { widthPx: number; heightPx: number }) => void;
}) {
  const isText = widget.kind === "text";
  if (isText) {
    return (
      <textarea
        className="dash-text-body"
        value={widget.text || ""}
        placeholder="Section header text"
        style={{
          fontSize: widget.textSize ?? DASH_TEXT_SIZE_DEFAULT,
          fontFamily: widget.fontFamily || "inherit",
          fontWeight: widget.textBold ? 700 : 500,
          fontStyle: widget.textItalic ? "italic" : "normal",
          textDecoration: widget.textUnderline ? "underline" : "none",
        }}
        onChange={(e) => onTextChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  if (!widget.workflowName) {
    return (
      <button
        type="button"
        className="dash-add"
        data-testid={`dashboard-add-${widget.id}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenPicker();
        }}
      >
        <Icon.Plus size={28} />
        <span>Add NodeFlow workflow</span>
      </button>
    );
  }
  if (!result) {
    return (
      <div className="dash-placeholder">
        Bound to <strong>{widget.workflowName}</strong>. Press Run.
      </div>
    );
  }
  if (result.kind === "loading") {
    return <div className="dash-placeholder dash-loading">Loading…</div>;
  }
  if (result.kind === "error") {
    return <div className="dash-error">{result.message}</div>;
  }
  if (result.kind === "chart") {
    return (
      <div className="dash-chart">
        <ChartView
          data={result.data}
          fallback={
            <div className="dash-placeholder">Chart unavailable</div>
          }
        />
      </div>
    );
  }
  if (result.kind === "reconcile") {
    return <ReconcileSummary data={result.data} />;
  }
  return (
    <div
      className={
        "dash-table-wrap" + (result.kind === "pivot" ? " dash-pivot" : "")
      }
    >
      <DataGrid
        page={sortPageClient(result.page, result.sortCol, result.descending)}
        sortCol={result.sortCol}
        descending={result.descending}
        onSort={onSort}
        onContentMetrics={onContentMetrics}
      />
      {result.kind === "pivot" ? (
        <div className="dash-pivot-note">
          Pivot layout is fixed here — reorder fields in NodeFlow.
        </div>
      ) : null}
    </div>
  );
}

function chartSpecOf(cfg: Record<string, unknown>) {
  return {
    chart_type: cfg.chart_type || "bar",
    x: cfg.x || "",
    y: cfg.y || "",
    agg: cfg.agg || "sum",
    series: cfg.series || "",
    style: cfg.style || undefined,
  };
}

async function runWorkflowWidget(
  workflowName: string,
  signal: AbortSignal,
  queryId: string,
): Promise<Exclude<WidgetResult, { kind: "loading" }>> {
  const loaded = await api.workflowLoad(workflowName, "node", signal);
  if (loaded.error || !loaded.graph) {
    return { kind: "error", message: loaded.error || "Could not load workflow." };
  }
  const graph = loaded.graph as {
    nodes?: { id?: string; type?: string; config?: Record<string, unknown> }[];
    edges?: {
      from?: { node?: string; port?: string };
      to?: { node?: string; port?: string };
    }[];
  };
  if (!graphHasSamqlDashboard(graph)) {
    return {
      kind: "error",
      message: "This workflow has no SamQL Dashboard output node.",
    };
  }
  const targets = findSamqlDashboardTargets(graph);
  if (!targets.length) {
    return {
      kind: "error",
      message: "Wire a chart, pivot, reconcile, or data node into SamQL Dashboard.",
    };
  }
  const target = targets[0];
  const kind = kindFromUpstream(target.upstreamType);

  if (kind === "chart") {
    const r = await api.nodeflowChart(
      graph,
      target.upstreamId,
      chartSpecOf(target.upstreamConfig),
      queryId,
      signal,
    );
    if (wasCancelled(queryId) || r.cancelled) {
      return { kind: "error", message: "cancelled" };
    }
    if (r.error) return { kind: "error", message: r.error };
    return { kind: "chart", data: r as ChartData };
  }

  if (kind === "reconcile") {
    const cfg = target.upstreamConfig;
    const keys = Array.isArray(cfg.keys) ? (cfg.keys as string[]) : [];
    const compare = Array.isArray(cfg.compare) ? (cfg.compare as string[]) : [];
    const balance =
      typeof cfg.balance === "string" && cfg.balance.trim() ? cfg.balance : null;
    const r = await api.nodeflowReconcile(
      graph,
      target.upstreamId,
      keys,
      compare,
      queryId,
      balance,
      signal,
    );
    if (wasCancelled(queryId) || r.cancelled) {
      return { kind: "error", message: "cancelled" };
    }
    if (r.error) return { kind: "error", message: r.error };
    return { kind: "reconcile", data: r as any };
  }

  const r = await api.nodeflowRun(graph, target.upstreamId, "out", queryId, signal);
  if (wasCancelled(queryId) || r.cancelled) {
    return { kind: "error", message: "cancelled" };
  }
  if (r.error) return { kind: "error", message: r.error };
  const page: ResultPage = {
    columns: (r.columns || []).map(String),
    rows: (r.rows || []) as any[][],
    offset: 0,
    total_rows: r.total_rows ?? (r.rows || []).length,
  };
  return {
    kind: kind === "pivot" ? "pivot" : "table",
    page,
    sortCol: null,
    descending: false,
  };
}

/** Exported for unit tests (widget table/pivot column sort). */
export function sortPageClient(
  page: ResultPage,
  sortCol: string | null,
  descending: boolean,
): ResultPage {
  if (!sortCol) return page;
  const idx = page.columns.findIndex((c) => c === sortCol);
  if (idx < 0) return page;
  const rows = [...page.rows].sort((a, b) => {
    const av = a[idx];
    const bv = b[idx];
    if (av == null && bv == null) return 0;
    if (av == null) return descending ? 1 : -1;
    if (bv == null) return descending ? -1 : 1;
    if (typeof av === "number" && typeof bv === "number") {
      return descending ? bv - av : av - bv;
    }
    const as = String(av);
    const bs = String(bv);
    return descending ? bs.localeCompare(as) : as.localeCompare(bs);
  });
  return { ...page, rows };
}

async function gatherWorkflowPayloads(
  names: string[],
): Promise<{ name: string; kind: "node"; graph: unknown }[]> {
  const out: { name: string; kind: "node"; graph: unknown }[] = [];
  for (const name of names) {
    const r = await api.workflowLoad(name, "node");
    if (r.graph) out.push({ name, kind: "node", graph: r.graph });
  }
  return out;
}

export async function buildDashboardExportBundle(
  ws: DashboardWorkspace,
): Promise<DashboardExportBundle> {
  const workflows = await gatherWorkflowPayloads(collectWorkflowNames(ws));
  return {
    samql: "dashboard-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: ws,
    workflows,
  };
}

export async function importDashboardBundle(
  bundle: unknown,
): Promise<{ ok: true; workspace: DashboardWorkspace } | { ok: false; error: string }> {
  const b = bundle as DashboardExportBundle;
  if (!b || b.samql !== "dashboard-bundle" || !b.workspace) {
    return { ok: false, error: "Not a SamQL dashboard bundle." };
  }
  for (const wf of b.workflows || []) {
    if (!wf?.name || !wf.graph) continue;
    const r = await api.workflowSave(wf.name, wf.graph, "node");
    if (r.error) {
      return { ok: false, error: `Could not restore workflow "${wf.name}": ${r.error}` };
    }
  }
  const ws = normalizeWorkspace(b.workspace);
  saveDashboardWorkspace(ws);
  return { ok: true, workspace: ws };
}

export const Dashboard: React.FC<{
  onToast: ToastFn;
  dataEpoch?: number;
  command?: DashboardCommand | null;
  onCommandConsumed?: () => void;
  loadRequest?: { id: number; name: string; graph: unknown } | null;
  onLoadConsumed?: () => void;
  onWorkflowsChanged?: () => void;
  inspectorHost?: HTMLElement | null;
  onSelectionChange?: (hasSelection: boolean) => void;
}> = ({
  onToast,
  dataEpoch = 0,
  command,
  onCommandConsumed,
  loadRequest,
  onLoadConsumed,
  onWorkflowsChanged,
  inspectorHost: _inspectorHost,
  onSelectionChange,
}) => {
  void _inspectorHost;
  const [workspace, setWorkspace] = useState<DashboardWorkspace>(() =>
    loadDashboardWorkspace(),
  );
  const [results, setResults] = useState<Record<string, WidgetResult>>({});
  const [running, setRunning] = useState(false);
  const [animating, setAnimating] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [eligible, setEligible] = useState<{ name: string }[]>([]);
  const [loadingEligible, setLoadingEligible] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [boardSelectOpen, setBoardSelectOpen] = useState(false);
  const [fileModal, setFileModal] = useState<{
    mode: "save" | "open";
  } | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [configKind, setConfigKind] = useState<
    null | "title" | { widgetId: string }
  >(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandSize, setExpandSize] = useState({ w: 920, h: 640 });
  const configChrome = useMemo(() => loadDashConfigChrome(), []);
  const [configMinimized, setConfigMinimized] = useState(
    () => !!configChrome.minimized,
  );
  const configDrag = useWinDrag({
    x: typeof configChrome.x === "number" ? configChrome.x : 96,
    y: typeof configChrome.y === "number" ? configChrome.y : 96,
  });
  const expandDrag = useWinDrag({ x: 72, y: 56 });
  const expandResizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const { ui: confirmUi, ask: askConfirm } = useConfirmPop();
  const runRef = useRef<{ queryId: string; ctrl: AbortController } | null>(null);
  // Latest-data wins: clear widget results when session tables mutate so a
  // prior Run cannot keep showing pre-mutation grids/charts.
  const resultsEpochRef = useRef(dataEpoch);
  useEffect(() => {
    if (resultsEpochRef.current === dataEpoch) return;
    resultsEpochRef.current = dataEpoch;
    const cur = runRef.current;
    if (cur) {
      cancelOne(cur.queryId, cur.ctrl);
      runRef.current = null;
    }
    setResults({});
    setRunning(false);
    setAnimating({});
  }, [dataEpoch]);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    orig: DashboardWidget;
  } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pageTitleRef = useRef<HTMLTextAreaElement>(null);
  const handledCmd = useRef(0);
  const handledLoad = useRef(0);
  // Layout undo/redo — widget snapshots only (not lock, not lastRun*).
  // Coalesce rapid edits (drag/resize/typing) like Journal; reset on board switch.
  const dashHist = useRef<{
    past: DashboardWidget[][];
    future: DashboardWidget[][];
    at: number;
  }>({ past: [], future: [], at: 0 });
  const dashHistPrev = useRef<DashboardWidget[]>([]);
  const dashHistApplying = useRef(false);
  const dashHistBoardId = useRef("");
  const [, bumpDashHist] = useState(0);

  const doc = activeDashboard(workspace);
  const widgetsLocked = !!doc.widgetsLocked;
  const widgetsSig = useMemo(() => JSON.stringify(doc.widgets), [doc.widgets]);

  useEffect(() => {
    saveDashboardWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    if (dashHistBoardId.current !== doc.id) {
      dashHistBoardId.current = doc.id;
      dashHist.current = { past: [], future: [], at: 0 };
      dashHistPrev.current = doc.widgets;
      dashHistApplying.current = false;
      bumpDashHist((n) => n + 1);
      return;
    }
    if (dashHistApplying.current) {
      dashHistApplying.current = false;
      dashHistPrev.current = doc.widgets;
      return;
    }
    // No layout change (e.g. Strict Mode effect re-run) — don't seed a fake undo step.
    if (JSON.stringify(dashHistPrev.current) === widgetsSig) return;
    const now = Date.now();
    if (now - dashHist.current.at > 600 || dashHist.current.past.length === 0) {
      dashHist.current.past.push(dashHistPrev.current);
      if (dashHist.current.past.length > 50) dashHist.current.past.shift();
    }
    dashHist.current.future = [];
    dashHist.current.at = now;
    dashHistPrev.current = doc.widgets;
    bumpDashHist((n) => n + 1);
  }, [widgetsSig, doc.id, doc.widgets]);

  useEffect(() => {
    // Config is a Field Explore–style float; do not steal the tables panel slot.
    onSelectionChange?.(false);
  }, [onSelectionChange]);

  const closeConfig = useCallback(() => {
    setConfigKind(null);
  }, []);

  const closeExpand = useCallback(() => {
    setExpandedId(null);
  }, []);

  const openExpand = useCallback((widgetId: string) => {
    setSelectedId(widgetId);
    setExpandedId(widgetId);
    const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const w = Math.min(960, Math.max(480, Math.round(vw * 0.72)));
    const h = Math.min(720, Math.max(360, Math.round(vh * 0.72)));
    setExpandSize({ w, h });
    expandDrag.setPos({
      x: Math.max(24, Math.round((vw - w) / 2)),
      y: Math.max(24, Math.round((vh - h) / 2)),
    });
  }, [expandDrag]);

  useEffect(() => {
    if (configKind == null) return;
    saveDashConfigChrome({
      x: configDrag.pos.x,
      y: configDrag.pos.y,
      minimized: configMinimized,
    });
  }, [configKind, configDrag.pos.x, configDrag.pos.y, configMinimized]);

  useEffect(() => {
    if (
      configKind &&
      typeof configKind === "object" &&
      !doc.widgets.some((w) => w.id === configKind.widgetId)
    ) {
      setConfigKind(null);
    }
  }, [configKind, doc.widgets]);

  useEffect(() => {
    if (expandedId && !doc.widgets.some((w) => w.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, doc.widgets]);

  useEffect(() => {
    if (configKind == null && expandedId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (expandedId) {
        closeExpand();
        return;
      }
      if (configKind != null && !configMinimized) closeConfig();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configKind, configMinimized, closeConfig, expandedId, closeExpand]);

  const openTitleConfig = useCallback(() => {
    setSelectedId(null);
    setConfigKind((cur) => (cur === "title" ? null : "title"));
    setConfigMinimized(false);
    saveDashConfigChrome({ minimized: false });
  }, []);

  const openWidgetConfig = useCallback((widgetId: string) => {
    setSelectedId(widgetId);
    setConfigKind({ widgetId });
    setConfigMinimized(false);
    saveDashConfigChrome({ minimized: false });
  }, []);

  const setActiveDoc = useCallback((patch: Partial<DashboardDoc> | ((d: DashboardDoc) => DashboardDoc)) => {
    setWorkspace((prev) => {
      const cur = activeDashboard(prev);
      const next =
        typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
      return {
        ...prev,
        dashboards: prev.dashboards.map((d) => (d.id === cur.id ? next : d)),
      };
    });
  }, []);

  const undoDash = useCallback(() => {
    const h = dashHist.current;
    if (h.past.length === 0) return;
    h.future.push(dashHistPrev.current);
    const prev = h.past.pop() as DashboardWidget[];
    dashHistApplying.current = true;
    dashHistPrev.current = prev;
    setActiveDoc((d) => ({
      ...d,
      widgets: packWidgetsNoOverlap(prev),
    }));
    bumpDashHist((n) => n + 1);
  }, [setActiveDoc]);

  const redoDash = useCallback(() => {
    const h = dashHist.current;
    if (h.future.length === 0) return;
    h.past.push(dashHistPrev.current);
    const next = h.future.pop() as DashboardWidget[];
    dashHistApplying.current = true;
    dashHistPrev.current = next;
    setActiveDoc((d) => ({
      ...d,
      widgets: packWidgetsNoOverlap(next),
    }));
    bumpDashHist((n) => n + 1);
  }, [setActiveDoc]);

  const canUndoDash = dashHist.current.past.length > 0;
  const canRedoDash = dashHist.current.future.length > 0;

  const toggleWidgetsLock = useCallback(() => {
    setActiveDoc((d) => ({ ...d, widgetsLocked: !d.widgetsLocked }));
  }, [setActiveDoc]);

  // Scoped to Dashboard mount (view is exclusive); skip editable fields so
  // native text undo and SQL editor (other views) are unaffected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undoDash();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redoDash();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoDash, redoDash]);

  const updateWidget = useCallback(
    (id: string, patch: Partial<DashboardWidget>) => {
      setActiveDoc((d) => {
        const widgets = d.widgets.map((w) => {
          if (w.id !== id) return w;
          let next = { ...w, ...patch };
          if (next.kind === "text") {
            next = withFittedTextHeight(next);
          }
          return next;
        });
        return { ...d, widgets: packWidgetsNoOverlap(widgets) };
      });
    },
    [setActiveDoc],
  );

  const pulse = useCallback((id: string, cls: string, ms = 420) => {
    setAnimating((prev) => ({ ...prev, [id]: cls }));
    window.setTimeout(() => {
      setAnimating((prev) => {
        if (prev[id] !== cls) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, ms);
  }, []);

  const addDataWidget = useCallback(() => {
    const id = newDashboardWidgetId();
    setActiveDoc((d) => {
      const maxY = d.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
      const next: DashboardWidget = {
        id,
        kind: "data",
        x: 0,
        y: maxY,
        w: 6,
        h: 3,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      };
      return {
        ...d,
        widgets: packWidgetsNoOverlap([...d.widgets, next]),
      };
    });
    pulse(id, "dash-anim-add", 520);
    setSelectedId(id);
    setMoreMenuOpen(false);
  }, [pulse, setActiveDoc]);

  const addTextWidget = useCallback(() => {
    const id = newDashboardWidgetId();
    setActiveDoc((d) => {
      const maxY = d.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
      const next = withFittedTextHeight({
        id,
        kind: "text",
        x: 0,
        y: maxY,
        w: 12,
        h: 1,
        title: "Section",
        text: "Section header",
        textSize: DASH_TEXT_SIZE_DEFAULT,
        fontFamily: "inherit",
        textBold: true,
        textItalic: false,
        textUnderline: false,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      });
      return {
        ...d,
        widgets: packWidgetsNoOverlap([...d.widgets, next]),
      };
    });
    pulse(id, "dash-anim-add", 520);
    setSelectedId(id);
    setMoreMenuOpen(false);
  }, [pulse, setActiveDoc]);

  const removeWidget = useCallback(
    (id: string) => {
      pulse(id, "dash-anim-remove", 280);
      window.setTimeout(() => {
        setActiveDoc((d) => ({
          ...d,
          widgets: packWidgetsNoOverlap(d.widgets.filter((w) => w.id !== id)),
        }));
        setResults((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSelectedId((cur) => (cur === id ? null : cur));
        setConfigKind((cur) =>
          cur && typeof cur === "object" && cur.widgetId === id ? null : cur,
        );
      }, 260);
    },
    [pulse, setActiveDoc],
  );

  const addDashboardBoard = useCallback(() => {
    const name = (window.prompt("New dashboard name:", "Dashboard") || "").trim();
    if (!name) return;
    const next = emptyDashboardDoc(name);
    setWorkspace((prev) => ({
      ...prev,
      activeId: next.id,
      dashboards: [...prev.dashboards, next],
    }));
    setResults({});
    closeConfig();
    setSelectedId(null);
  }, [closeConfig]);

  const switchBoard = useCallback((id: string) => {
    setWorkspace((prev) => ({ ...prev, activeId: id }));
    setResults({});
    closeConfig();
    setSelectedId(null);
  }, [closeConfig]);

  const deleteDashboardBoard = useCallback(
    (anchor?: HTMLElement | null) => {
      if (workspace.dashboards.length <= 1) {
        onToast("warn", "Cannot delete", "Keep at least one dashboard.");
        return;
      }
      const current = activeDashboard(workspace);
      const label = current.name || "this dashboard";
      askConfirm(
        anchor || { left: 240, top: 72, side: "right" },
        `Delete dashboard "${label}"? Widgets on this board will be removed.`,
        () => {
          setWorkspace((prev) => {
            const remaining = prev.dashboards.filter(
              (d) => d.id !== prev.activeId,
            );
            if (!remaining.length) return prev;
            const nextActive =
              remaining.find((d) => d.id === prev.activeId)?.id ||
              remaining[0]!.id;
            return { ...prev, dashboards: remaining, activeId: nextActive };
          });
          setResults({});
          closeConfig();
          setSelectedId(null);
          onToast("ok", "Dashboard deleted", `"${label}" removed.`);
        },
        "Delete",
      );
    },
    [askConfirm, closeConfig, onToast, workspace],
  );

  const openPicker = useCallback(
    async (widgetId: string) => {
      setPickerFor(widgetId);
      setLoadingEligible(true);
      try {
        const list = await api.workflowsList();
        const nodeWfs = (list.workflows || []).filter(
          (w) => (w.kind || "node") === "node",
        );
        const ok: { name: string }[] = [];
        for (const w of nodeWfs) {
          const loaded = await api.workflowLoad(w.name, "node");
          if (loaded.graph && graphHasSamqlDashboard(loaded.graph)) {
            ok.push({ name: w.name });
          }
        }
        setEligible(ok);
      } catch (e: any) {
        onToast("error", "Could not list workflows", e?.message || String(e));
        setEligible([]);
      } finally {
        setLoadingEligible(false);
      }
    },
    [onToast],
  );

  const cancelRun = useCallback(async () => {
    const cur = runRef.current;
    if (!cur) return;
    cancelOne(cur.queryId, cur.ctrl);
    try {
      await api.cancelAll();
    } catch {
      /* best-effort backend interrupt */
    }
    onToast("warn", "Cancelled", "Dashboard run stopped.");
  }, [onToast]);

  const runAll = useCallback(async () => {
    if (running) {
      await cancelRun();
      return;
    }
    const bound = doc.widgets.filter((w) => w.workflowName);
    if (!bound.length) {
      onToast(
        "warn",
        "Nothing to run",
        "Add a NodeFlow workflow to at least one widget.",
      );
      return;
    }
    setRunning(true);
    const queryId = uid();
    const ctrl = new AbortController();
    runRef.current = { queryId, ctrl };
    registerRun(queryId, ctrl);
    const startedAt = performance.now();
    let cancelled = false;
    try {
      for (const widget of bound) {
        setResults((prev) => ({ ...prev, [widget.id]: { kind: "loading" } }));
        pulse(widget.id, "dash-anim-load", 900);
        try {
          const result = await runWorkflowWidget(
            widget.workflowName!,
            ctrl.signal,
            queryId,
          );
          if (result.kind === "error" && result.message === "cancelled") {
            cancelled = true;
            break;
          }
          setResults((prev) => ({ ...prev, [widget.id]: result }));
          pulse(widget.id, "dash-anim-reload", 480);
          if (result.kind === "error") {
            onToast("error", widget.workflowName || "Widget", result.message);
          }
        } catch (e: any) {
          if (isCancelledError(e, queryId)) {
            cancelled = true;
            break;
          }
          setResults((prev) => ({
            ...prev,
            [widget.id]: { kind: "error", message: e?.message || String(e) },
          }));
        }
      }
      if (cancelled) {
        onToast("warn", "Cancelled", "Dashboard run stopped.");
      } else {
        onToast("ok", "Dashboard updated", `Ran ${bound.length} widget(s).`);
      }
    } finally {
      const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
      setActiveDoc((d) => ({
        ...d,
        lastRunAt: Date.now(),
        lastRunMs: elapsed,
      }));
      unregisterRun(queryId, ctrl);
      runRef.current = null;
      setRunning(false);
    }
  }, [cancelRun, doc.widgets, onToast, pulse, running, setActiveDoc]);

  const persistWorkspace = useCallback(
    async (nameHint?: string) => {
      let name = nameHint || workspace.savedName;
      if (!name) {
        name = (window.prompt("Save dashboard workspace as:", doc.name) || "").trim();
        if (!name) return;
      }
      const r = await api.workflowSave(name, workspace, "dashboard");
      if (r.error) {
        onToast("error", "Save failed", r.error);
        return;
      }
      // Also ensure referenced node workflows stay listed (already on server).
      setWorkspace((prev) => ({ ...prev, savedName: name }));
      onWorkflowsChanged?.();
      onToast("ok", "Dashboard saved", `"${name}" (${workspace.dashboards.length} board(s)).`);
    },
    [doc.name, onToast, onWorkflowsChanged, workspace],
  );

  const exportWorkspace = useCallback(async () => {
    try {
      const bundle = await buildDashboardExportBundle(workspace);
      const base =
        workspace.savedName ||
        activeDashboard(workspace).name ||
        "dashboard";
      const safe = base.replace(/[^\w.\- ]+/g, "_").trim() || "dashboard";
      const r = await saveToDownloads(`${safe}.samql-dashboard.json`, {
        text: JSON.stringify(bundle, null, 2),
      });
      onToast("ok", "Exported", r.path || "Saved to Downloads.");
    } catch (e: any) {
      onToast("error", "Export failed", e?.message || String(e));
    }
  }, [onToast, workspace]);

  const exportPdf = useCallback(async () => {
    if (exportingPdf) return;
    const board = boardRef.current;
    if (!board) {
      onToast("error", "Export failed", "Dashboard board is not ready.");
      return;
    }
    setExportingPdf(true);
    try {
      const title =
        (workspace.pageTitle ?? DASH_PAGE_TITLE_DEFAULT).trim() ||
        doc.name ||
        workspace.savedName ||
        "Dashboard";
      const r = await exportDashboardElementToPdf(
        board,
        title,
        `SamQL — ${title}`,
      );
      onToast("ok", "PDF exported", r.path || "Saved to Downloads.");
    } catch (e: any) {
      onToast("error", "PDF export failed", e?.message || String(e));
    } finally {
      setExportingPdf(false);
    }
  }, [
    doc.name,
    exportingPdf,
    onToast,
    workspace.pageTitle,
    workspace.savedName,
  ]);

  const applyLoadedGraph = useCallback(
    async (
      graph: unknown,
      name: string,
      isCancelled?: () => boolean,
    ) => {
      const g = graph as any;
      if (g?.samql === "dashboard-bundle") {
        const imported = await importDashboardBundle(g);
        if (isCancelled?.()) return;
        if (!imported.ok) {
          onToast("error", "Load failed", imported.error);
          return;
        }
        setWorkspace(imported.workspace);
        setResults({});
        onToast("ok", "Dashboard loaded", name);
        onWorkflowsChanged?.();
        return;
      }
      const ws = normalizeWorkspace(g);
      if (Array.isArray(g?.workflows)) {
        for (const wf of g.workflows) {
          if (wf?.name && wf?.graph) {
            await api.workflowSave(wf.name, wf.graph, "node");
          }
        }
      } else {
        for (const wfName of collectWorkflowNames(ws)) {
          await api.workflowLoad(wfName, "node");
        }
      }
      if (isCancelled?.()) return;
      const next = { ...ws, savedName: name || ws.savedName };
      setWorkspace(next);
      saveDashboardWorkspace(next);
      setResults({});
      onToast("ok", "Dashboard loaded", name);
      onWorkflowsChanged?.();
    },
    [onToast, onWorkflowsChanged],
  );

  const onPickDashboardFile = useCallback(
    async (path: string) => {
      const mode = fileModal?.mode;
      setFileModal(null);
      try {
        if (mode === "save") {
          const content = wfEnvelope(
            "dashboard",
            workspace.savedName || doc.name || "dashboard",
            workspace,
          );
          const r = await api.saveFile(path, content);
          if (r.error) {
            onToast("error", "Save failed", r.error);
            return;
          }
          onToast("ok", "Saved", r.name || path);
          return;
        }
        const r = await api.openFile(path);
        if (r.error || typeof r.content !== "string") {
          onToast("error", "Open failed", r.error || "Empty file.");
          return;
        }
        const baseName = (r.name || "Dashboard").replace(
          /\.samql(-dashboard)?\.json$|\.json$/i,
          "",
        );
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(r.content);
        } catch {
          onToast("error", "Open failed", "Not a dashboard file.");
          return;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { samql?: string }).samql === "dashboard-bundle"
        ) {
          await applyLoadedGraph(parsed, baseName);
          return;
        }
        const env = parseWfFile(r.content);
        if (env?.kind === "dashboard") {
          await applyLoadedGraph(env.payload, env.name || baseName);
          return;
        }
        if (env) {
          onToast(
            "warn",
            "Not a dashboard file",
            `That looks like a ${env.kind} workflow — open it from the ${wfKindSurface(env.kind)}.`,
          );
          return;
        }
        // Bare workspace JSON (no envelope / bundle wrapper).
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { dashboards?: unknown }).dashboards)
        ) {
          await applyLoadedGraph(parsed, baseName);
          return;
        }
        onToast("error", "Open failed", "Not a dashboard file.");
      } catch (e: any) {
        onToast("error", "File error", e?.message || String(e));
      }
    },
    [applyLoadedGraph, doc.name, fileModal?.mode, onToast, workspace],
  );

  useEffect(() => {
    if (!command || command.id === handledCmd.current) return;
    handledCmd.current = command.id;
    void (async () => {
      if (command.action === "save") await persistWorkspace();
      else if (command.action === "saveAs") setFileModal({ mode: "save" });
      else if (command.action === "export") await exportWorkspace();
      else if (command.action === "open") setFileModal({ mode: "open" });
      onCommandConsumed?.();
    })();
  }, [command, exportWorkspace, onCommandConsumed, persistWorkspace]);

  useEffect(() => {
    if (!loadRequest || loadRequest.id === handledLoad.current) return;
    handledLoad.current = loadRequest.id;
    let cancelled = false;
    void (async () => {
      try {
        await applyLoadedGraph(
          loadRequest.graph,
          loadRequest.name,
          () => cancelled,
        );
      } catch (e: any) {
        if (!cancelled) onToast("error", "Load failed", e?.message || String(e));
      } finally {
        if (!cancelled) onLoadConsumed?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoadedGraph, loadRequest, onLoadConsumed, onToast]);

  const onPointerDownMove = (e: React.PointerEvent, widget: DashboardWidget) => {
    if (widgetsLocked) return;
    if (
      (e.target as HTMLElement).closest(
        [
          ".dash-resize",
          ".dash-widget-actions",
          ".dash-text-body",
          ".dash-text-grab",
          ".dash-chart",
          ".dash-table-wrap",
          ".dash-add",
          ".grid-shell",
          ".grid",
          ".grid-sel-bar",
          "button",
          "input",
          "select",
          "textarea",
          "a",
        ].join(", "),
      )
    ) {
      return;
    }
    e.preventDefault();
    setSelectedId(widget.id);
    dragRef.current = {
      id: widget.id,
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...widget },
    };
    pulse(widget.id, "dash-anim-drag", 200);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerDownResize = (e: React.PointerEvent, widget: DashboardWidget) => {
    if (widgetsLocked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(widget.id);
    dragRef.current = {
      id: widget.id,
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...widget },
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const board = boardRef.current;
    if (!d || !board) return;
    const colW = (board.clientWidth - DASH_GAP * (DASH_COLS - 1)) / DASH_COLS;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      const nx = Math.max(
        0,
        Math.min(DASH_COLS - d.orig.w, d.orig.x + Math.round(dx / (colW + DASH_GAP))),
      );
      const ny = Math.max(0, d.orig.y + Math.round(dy / (DASH_ROW_PX + DASH_GAP)));
      setActiveDoc((doc) => {
        const cur = doc.widgets.find((w) => w.id === d.id);
        if (cur && cur.x === nx && cur.y === ny) return doc;
        const moved = doc.widgets.map((w) =>
          w.id === d.id ? { ...w, x: nx, y: ny } : w,
        );
        return { ...doc, widgets: packAroundFocus(moved, d.id) };
      });
    } else if (d.mode === "resize") {
      const nw = Math.max(
        2,
        Math.min(DASH_COLS - d.orig.x, d.orig.w + Math.round(dx / (colW + DASH_GAP))),
      );
      const nh =
        d.orig.kind === "text"
          ? d.orig.h
          : Math.max(
              DASH_H_MIN_DATA,
              d.orig.h + Math.round(dy / (DASH_ROW_PX + DASH_GAP)),
            );
      setActiveDoc((doc) => {
        const cur = doc.widgets.find((w) => w.id === d.id);
        if (cur && cur.w === nw && cur.h === nh) return doc;
        const resized = doc.widgets.map((w) =>
          w.id === d.id ? { ...w, w: nw, h: nh } : w,
        );
        return { ...doc, widgets: packAroundFocus(resized, d.id) };
      });
    }
  };

  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActiveDoc((d) => ({
      ...d,
      widgets: packWidgetsNoOverlap(d.widgets),
    }));
  };

  const fitWidgetToMetrics = useCallback(
    (widgetId: string, widthPx: number, heightPx: number) => {
      if (widgetsLocked) return;
      const board = boardRef.current;
      if (!board) return;
      setActiveDoc((d) => {
        const cur = d.widgets.find((w) => w.id === widgetId);
        if (!cur || cur.kind === "text") return d;
        const headerPx =
          cur.showHeader !== false
            ? cur.headerHeight ?? DASH_HEADER_DEFAULT
            : 0;
        const units = gridUnitsForContent(
          widthPx + 16,
          heightPx + headerPx + 16,
          board.clientWidth,
          { minW: cur.w, minH: Math.max(DASH_H_MIN_DATA, cur.h) },
        );
        // Grow only — never shrink from content metrics (user can resize manually).
        const needW = Math.max(cur.w, Math.min(DASH_COLS - cur.x, units.w));
        const needH = Math.max(cur.h, units.h);
        if (needW === cur.w && needH === cur.h) return d;
        return {
          ...d,
          widgets: resizeWidgetFitting(d.widgets, widgetId, {
            w: needW,
            h: needH,
          }),
        };
      });
    },
    [setActiveDoc, widgetsLocked],
  );

  const boardHeight = useMemo(() => {
    const maxY = doc.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 6);
    return maxY * (DASH_ROW_PX + DASH_GAP) + DASH_GAP;
  }, [doc.widgets]);

  const selected =
    configKind && typeof configKind === "object"
      ? doc.widgets.find((w) => w.id === configKind.widgetId) || null
      : null;

  const patchPageTitle = useCallback(
    (patch: Partial<DashboardWorkspace>) => {
      setWorkspace((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  /** Grow page-title height with wrapped lines so the board below shifts down. */
  const syncPageTitleHeight = useCallback(() => {
    const el = pageTitleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(el.scrollHeight, 1)}px`;
  }, []);

  useLayoutEffect(() => {
    syncPageTitleHeight();
  }, [
    syncPageTitleHeight,
    workspace.pageTitle,
    workspace.pageTitleSize,
    workspace.pageTitleFontFamily,
    workspace.pageTitleBold,
    workspace.pageTitleItalic,
    workspace.pageTitleUnderline,
  ]);

  useEffect(() => {
    const el = pageTitleRef.current;
    const wrap = el?.parentElement;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncPageTitleHeight());
    // Observe the wrap width (not the textarea height) so grow sync cannot loop.
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [syncPageTitleHeight]);

  const titleConfigPanel = (
    <div className="dash-config" data-testid="dashboard-title-config">
      <label className="nb2-lbl">Font size</label>
      <div className="dash-text-size-row">
        <input
          className="nb2-in"
          type="range"
          data-testid="dashboard-title-size"
          min={DASH_PAGE_TITLE_SIZE_MIN}
          max={DASH_PAGE_TITLE_SIZE_MAX}
          value={workspace.pageTitleSize ?? DASH_PAGE_TITLE_SIZE_DEFAULT}
          onChange={(e) =>
            patchPageTitle({
              pageTitleSize:
                Number(e.target.value) || DASH_PAGE_TITLE_SIZE_DEFAULT,
            })
          }
        />
        <span className="dash-text-size-val">
          {workspace.pageTitleSize ?? DASH_PAGE_TITLE_SIZE_DEFAULT}px
        </span>
      </div>
      <label className="nb2-lbl">Font</label>
      <select
        className="nb2-in"
        data-testid="dashboard-title-font"
        value={workspace.pageTitleFontFamily || "inherit"}
        onChange={(e) =>
          patchPageTitle({ pageTitleFontFamily: e.target.value })
        }
      >
        {DashTextFontSelectOptions()}
      </select>
      <label className="nb2-lbl">Style</label>
      <div className="dash-text-style-row">
        <button
          type="button"
          className={"btn sm" + (workspace.pageTitleBold ? " primary" : "")}
          title="Bold"
          data-testid="dashboard-title-bold"
          aria-pressed={!!workspace.pageTitleBold}
          onClick={() =>
            patchPageTitle({ pageTitleBold: !workspace.pageTitleBold })
          }
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={"btn sm" + (workspace.pageTitleItalic ? " primary" : "")}
          title="Italic"
          data-testid="dashboard-title-italic"
          aria-pressed={!!workspace.pageTitleItalic}
          onClick={() =>
            patchPageTitle({ pageTitleItalic: !workspace.pageTitleItalic })
          }
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={
            "btn sm" + (workspace.pageTitleUnderline ? " primary" : "")
          }
          title="Underline"
          data-testid="dashboard-title-underline"
          aria-pressed={!!workspace.pageTitleUnderline}
          onClick={() =>
            patchPageTitle({
              pageTitleUnderline: !workspace.pageTitleUnderline,
            })
          }
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </button>
      </div>
      <label className="nb2-lbl">Color</label>
      <div className="dash-color-row">
        <input
          className="nb2-in dash-color-input"
          type="color"
          data-testid="dashboard-title-color"
          value={
            workspace.pageTitleColor &&
            /^#[0-9a-fA-F]{6}$/.test(workspace.pageTitleColor)
              ? workspace.pageTitleColor
              : "#e8eaed"
          }
          onChange={(e) => patchPageTitle({ pageTitleColor: e.target.value })}
        />
        {workspace.pageTitleColor ? (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="dashboard-title-color-reset"
            onClick={() => patchPageTitle({ pageTitleColor: undefined })}
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );

  const widgetConfigPanel = selected ? (
    <div className="dash-config" data-testid="dashboard-config">
      <label className="nb2-lbl">Title</label>
      <input
        className="nb2-in"
        value={selected.title || ""}
        placeholder="Widget title"
        onChange={(e) => updateWidget(selected.id, { title: e.target.value })}
      />
      <label className="nb2-check" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={selected.showHeader !== false}
          onChange={(e) =>
            updateWidget(selected.id, { showHeader: e.target.checked })
          }
        />{" "}
        Show header
      </label>
      {selected.showHeader !== false ? (
        <>
          <label className="nb2-lbl">Header height</label>
          <input
            className="nb2-in"
            type="range"
            min={DASH_HEADER_MIN}
            max={DASH_HEADER_MAX}
            value={selected.headerHeight ?? DASH_HEADER_DEFAULT}
            onChange={(e) =>
              updateWidget(selected.id, {
                headerHeight: Number(e.target.value) || DASH_HEADER_DEFAULT,
              })
            }
          />
          <label className="nb2-lbl">Header color</label>
          <div className="dash-color-row">
            <input
              className="nb2-in dash-color-input"
              type="color"
              data-testid="dashboard-header-color"
              value={
                selected.headerColor &&
                /^#[0-9a-fA-F]{6}$/.test(selected.headerColor)
                  ? selected.headerColor
                  : "#2a3140"
              }
              onChange={(e) =>
                updateWidget(selected.id, { headerColor: e.target.value })
              }
            />
            {selected.headerColor ? (
              <button
                type="button"
                className="btn sm ghost"
                data-testid="dashboard-header-color-reset"
                onClick={() =>
                  updateWidget(selected.id, { headerColor: undefined })
                }
              >
                Reset
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <label className="nb2-lbl">Widget background</label>
      <div className="dash-color-row">
        <input
          className="nb2-in dash-color-input"
          type="color"
          data-testid="dashboard-widget-bg"
          value={
            selected.backgroundColor &&
            /^#[0-9a-fA-F]{6}$/.test(selected.backgroundColor)
              ? selected.backgroundColor
              : "#1e2430"
          }
          onChange={(e) =>
            updateWidget(selected.id, { backgroundColor: e.target.value })
          }
        />
        {selected.backgroundColor ? (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="dashboard-widget-bg-reset"
            onClick={() =>
              updateWidget(selected.id, { backgroundColor: undefined })
            }
          >
            Reset
          </button>
        ) : null}
      </div>
      {selected.kind === "text" ? (
        <>
          <label className="nb2-lbl">Text</label>
          <textarea
            className="nb2-in"
            rows={3}
            value={selected.text || ""}
            placeholder="Section header text"
            onChange={(e) => updateWidget(selected.id, { text: e.target.value })}
          />
          <label className="nb2-lbl">Text size</label>
          <div className="dash-text-size-row">
            <input
              className="nb2-in"
              type="range"
              min={DASH_TEXT_SIZE_MIN}
              max={DASH_TEXT_SIZE_MAX}
              value={selected.textSize ?? DASH_TEXT_SIZE_DEFAULT}
              onChange={(e) =>
                updateWidget(selected.id, {
                  textSize: Number(e.target.value) || DASH_TEXT_SIZE_DEFAULT,
                })
              }
            />
            <span className="dash-text-size-val">
              {selected.textSize ?? DASH_TEXT_SIZE_DEFAULT}px
            </span>
          </div>
          <label className="nb2-lbl">Font</label>
          <select
            className="nb2-in"
            data-testid="dashboard-widget-font"
            value={selected.fontFamily || "inherit"}
            onChange={(e) =>
              updateWidget(selected.id, { fontFamily: e.target.value })
            }
          >
            {DashTextFontSelectOptions()}
          </select>
          <label className="nb2-lbl">Style</label>
          <div className="dash-text-style-row">
            <button
              type="button"
              className={
                "btn sm" + (selected.textBold ? " primary" : "")
              }
              title="Bold"
              aria-pressed={!!selected.textBold}
              onClick={() =>
                updateWidget(selected.id, { textBold: !selected.textBold })
              }
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className={
                "btn sm" + (selected.textItalic ? " primary" : "")
              }
              title="Italic"
              aria-pressed={!!selected.textItalic}
              onClick={() =>
                updateWidget(selected.id, { textItalic: !selected.textItalic })
              }
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className={
                "btn sm" + (selected.textUnderline ? " primary" : "")
              }
              title="Underline"
              aria-pressed={!!selected.textUnderline}
              onClick={() =>
                updateWidget(selected.id, {
                  textUnderline: !selected.textUnderline,
                })
              }
            >
              <span style={{ textDecoration: "underline" }}>U</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="nb2-lbl">NodeFlow workflow</label>
          <div className="nb2-row2">
            <input
              className="nb2-in"
              readOnly
              value={selected.workflowName || ""}
              placeholder="(none)"
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => void openPicker(selected.id)}
            >
              Pick…
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        className="btn sm danger"
        style={{ marginTop: 14 }}
        onClick={() => removeWidget(selected.id)}
      >
        × Delete widget
      </button>
    </div>
  ) : null;

  const configPanel =
    configKind === "title"
      ? titleConfigPanel
      : configKind && typeof configKind === "object"
        ? widgetConfigPanel
        : null;
  const configTitle =
    configKind === "title"
      ? "Page title"
      : selected?.kind === "text"
        ? "Text widget"
        : "Widget";

  const configFloat =
    configPanel &&
    (configMinimized ? (
      <button
        ref={configDrag.winRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className={
          "tt-mini win-float" +
          (configDrag.dragging ? " dragging" : "") +
          (configDrag.settled ? " settle" : "")
        }
        style={{ left: configDrag.pos.x, top: configDrag.pos.y }}
        data-testid="dashboard-config-mini"
        title="Configure — drag to move; click to expand"
        onMouseDown={(event) => {
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          const onMove = (ev: MouseEvent) => {
            if (
              Math.abs(ev.clientX - startX) > 4 ||
              Math.abs(ev.clientY - startY) > 4
            ) {
              moved = true;
            }
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            if (!moved) {
              setConfigMinimized(false);
              saveDashConfigChrome({ minimized: false });
            }
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          configDrag.startDrag(event);
        }}
      >
        <Icon.Edit size={14} />
        <span>Config</span>
      </button>
    ) : (
      <div
        ref={configDrag.winRef as React.RefObject<HTMLDivElement>}
        className={
          "dash-config-panel win-float" +
          (configDrag.dragging ? " dragging" : "") +
          (configDrag.settled ? " settle" : "")
        }
        style={{ left: configDrag.pos.x, top: configDrag.pos.y }}
        role="dialog"
        aria-label={configTitle}
        data-testid="dashboard-config-panel"
      >
        <div
          className="dash-config-panel-head"
          onMouseDown={configDrag.startDrag}
          title="Drag to move"
        >
          <Icon.Edit size={14} />
          <span className="dash-config-panel-title">{configTitle}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm ghost"
            title="Minimize"
            data-testid="dashboard-config-minimize"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setConfigMinimized(true);
              saveDashConfigChrome({
                minimized: true,
                x: configDrag.pos.x,
                y: configDrag.pos.y,
              });
            }}
          >
            <Icon.SquareMinus size={14} />
          </button>
          <button
            type="button"
            className="btn sm ghost"
            title="Close"
            data-testid="dashboard-config-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={closeConfig}
          >
            <Icon.X size={14} />
          </button>
        </div>
        <div className="dash-config-panel-body">{configPanel}</div>
      </div>
    ));

  return (
    <div className="dash-root" data-testid="dashboard-root">
      {confirmUi}
      {fileModal && (
        <FileBrowser
          saveMode={fileModal.mode === "save"}
          defaultFileName={wfFileName(workspace.savedName || doc.name || "dashboard")}
          onClose={() => setFileModal(null)}
          onPick={onPickDashboardFile}
        />
      )}
      <div className="dash-toolbar">
        <div className="dash-toolbar-left">
          <div className="dash-title-wrap">
            <textarea
              ref={pageTitleRef}
              className="dash-title-input"
              data-testid="dashboard-page-title"
              rows={1}
              wrap="soft"
              spellCheck={false}
              aria-label="Dashboard heading"
              value={workspace.pageTitle ?? DASH_PAGE_TITLE_DEFAULT}
              onChange={(e) => {
                setWorkspace((prev) => ({
                  ...prev,
                  pageTitle: e.target.value,
                }));
                // Sync before paint when possible; layout effect covers style changes.
                const el = e.currentTarget;
                el.style.height = "0px";
                el.style.height = `${Math.max(el.scrollHeight, 1)}px`;
              }}
              style={{
                fontSize:
                  workspace.pageTitleSize ?? DASH_PAGE_TITLE_SIZE_DEFAULT,
                fontFamily: workspace.pageTitleFontFamily || "inherit",
                fontWeight: workspace.pageTitleBold ? 700 : 650,
                fontStyle: workspace.pageTitleItalic ? "italic" : "normal",
                textDecoration: workspace.pageTitleUnderline
                  ? "underline"
                  : "none",
                ...(workspace.pageTitleColor
                  ? { color: workspace.pageTitleColor }
                  : null),
              }}
              title="Rename dashboard heading"
            />
            <button
              type="button"
              className={
                "btn sm ghost dash-title-config-btn" +
                (configKind === "title" ? " active" : "")
              }
              data-testid="dashboard-title-configure"
              title="Configure page title"
              aria-pressed={configKind === "title"}
              onClick={openTitleConfig}
            >
              <Icon.Format size={14} />
            </button>
          </div>
        </div>
        <div className="dash-toolbar-right">
          <div className="dash-board-select-wrap">
            <button
              type="button"
              className={
                "dash-board-select" + (boardSelectOpen ? " open" : "")
              }
              data-testid="dashboard-select"
              aria-expanded={boardSelectOpen}
              aria-haspopup="listbox"
              title="Switch or add dashboards"
              onClick={() => {
                setMoreMenuOpen(false);
                setBoardSelectOpen((v) => !v);
              }}
            >
              <span className="dash-board-select-label">{doc.name}</span>
              <Icon.Chevron size={14} className="dash-board-select-caret" />
            </button>
            {boardSelectOpen ? (
              <>
                <div
                  className="rc-backdrop"
                  data-testid="dashboard-select-backdrop"
                  onMouseDown={() => setBoardSelectOpen(false)}
                />
                <div
                  className="dash-board-select-menu"
                  role="listbox"
                  data-testid="dashboard-select-menu"
                  aria-label="Dashboards"
                >
                  {workspace.dashboards.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      role="option"
                      aria-selected={d.id === workspace.activeId}
                      className={
                        "dash-board-select-item" +
                        (d.id === workspace.activeId ? " selected" : "")
                      }
                      data-testid={`dashboard-select-option-${d.id}`}
                      onClick={() => {
                        setBoardSelectOpen(false);
                        if (d.id !== workspace.activeId) switchBoard(d.id);
                      }}
                    >
                      {d.name}
                    </button>
                  ))}
                  <div className="dash-board-select-sep" role="separator" />
                  <button
                    type="button"
                    className="dash-board-select-item dash-board-select-add"
                    data-testid="dashboard-select-add"
                    onClick={() => {
                      setBoardSelectOpen(false);
                      addDashboardBoard();
                    }}
                  >
                    + Add dashboard…
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <div className="dash-more-wrap">
            <button
              type="button"
              className={
                "btn sm ghost" +
                (moreMenuOpen || widgetsLocked ? " active" : "")
              }
              data-testid="dashboard-more"
              aria-expanded={moreMenuOpen}
              aria-haspopup="menu"
              title={
                widgetsLocked
                  ? "More actions (widgets locked)"
                  : "More actions"
              }
              onClick={() => {
                setBoardSelectOpen(false);
                setMoreMenuOpen((v) => !v);
              }}
            >
              <Icon.MoreHorizontal size={14} />
              More
              {widgetsLocked ? (
                <span className="dash-more-lock-badge" aria-hidden="true">
                  <Icon.Lock size={11} />
                </span>
              ) : null}
            </button>
            {moreMenuOpen ? (
              <>
                <div
                  className="rc-backdrop"
                  data-testid="dashboard-more-backdrop"
                  onMouseDown={() => setMoreMenuOpen(false)}
                />
                <div
                  className="dash-more-menu"
                  data-testid="dashboard-more-menu"
                  role="menu"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="dash-more-menu-item"
                    role="menuitem"
                    data-testid="dashboard-undo"
                    disabled={!canUndoDash}
                    onClick={() => {
                      undoDash();
                      setMoreMenuOpen(false);
                    }}
                    title="Undo layout edit (Ctrl+Z)"
                  >
                    <span className="dash-more-menu-label">
                      <Icon.Undo size={14} />
                      Undo
                    </span>
                    <span className="dash-more-menu-note">Ctrl+Z</span>
                  </button>
                  <button
                    type="button"
                    className="dash-more-menu-item"
                    role="menuitem"
                    data-testid="dashboard-redo"
                    disabled={!canRedoDash}
                    onClick={() => {
                      redoDash();
                      setMoreMenuOpen(false);
                    }}
                    title="Redo layout edit (Ctrl+Shift+Z)"
                  >
                    <span className="dash-more-menu-label">
                      <Icon.Redo size={14} />
                      Redo
                    </span>
                    <span className="dash-more-menu-note">Ctrl+Shift+Z</span>
                  </button>
                  <button
                    type="button"
                    className={
                      "dash-more-menu-item" +
                      (widgetsLocked ? " active" : "")
                    }
                    role="menuitem"
                    data-testid="dashboard-lock"
                    aria-pressed={widgetsLocked}
                    onClick={() => {
                      toggleWidgetsLock();
                      setMoreMenuOpen(false);
                    }}
                    title={
                      widgetsLocked
                        ? "Unlock widgets (allow move & resize)"
                        : "Lock widgets (prevent move & resize)"
                    }
                  >
                    <span className="dash-more-menu-label">
                      {widgetsLocked ? (
                        <Icon.Lock size={14} />
                      ) : (
                        <Icon.Unlock size={14} />
                      )}
                      {widgetsLocked ? "Unlock widgets" : "Lock widgets"}
                    </span>
                    <span className="dash-more-menu-note">
                      {widgetsLocked ? "Locked" : "Unlocked"}
                    </span>
                  </button>
                  <div className="dash-more-menu-sep" role="separator" />
                  <button
                    type="button"
                    className="dash-more-menu-item"
                    role="menuitem"
                    data-testid="dashboard-add-text"
                    onClick={addTextWidget}
                  >
                    <span className="dash-more-menu-label">
                      <Icon.StickyNote size={14} />
                      Add Text
                    </span>
                    <span className="dash-more-menu-note">Section header</span>
                  </button>
                  <button
                    type="button"
                    className="dash-more-menu-item"
                    role="menuitem"
                    data-testid="dashboard-add-empty"
                    onClick={addDataWidget}
                  >
                    <span className="dash-more-menu-label">
                      <Icon.Plus size={14} />
                      Empty Widget
                    </span>
                    <span className="dash-more-menu-note">
                      Bind a NodeFlow workflow
                    </span>
                  </button>
                  <div className="dash-more-menu-sep" role="separator" />
                  <button
                    type="button"
                    className="dash-more-menu-item"
                    role="menuitem"
                    data-testid="dashboard-export-pdf"
                    disabled={exportingPdf}
                    title="Export dashboard as PDF to Downloads"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void exportPdf();
                    }}
                  >
                    <span className="dash-more-menu-label">
                      <Icon.FileDown size={14} />
                      {exportingPdf ? "Exporting…" : "Export PDF"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="dash-more-menu-item danger"
                    role="menuitem"
                    data-testid="dashboard-delete"
                    disabled={workspace.dashboards.length <= 1}
                    title={
                      workspace.dashboards.length <= 1
                        ? "Keep at least one dashboard"
                        : "Delete current dashboard"
                    }
                    onClick={(e) => {
                      setMoreMenuOpen(false);
                      deleteDashboardBoard(e.currentTarget);
                    }}
                  >
                    <span className="dash-more-menu-label">
                      ×
                      Delete board
                    </span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <div className="dash-run-wrap">
            <div className="dash-run-actions">
              <button
                type="button"
                className={running ? "btn danger" : "btn primary"}
                data-testid="dashboard-run"
                onClick={() => void runAll()}
              >
                {running ? (
                  <>
                    <Icon.Square size={14} /> Cancel
                  </>
                ) : (
                  <>
                    <Icon.Play size={14} /> Run
                  </>
                )}
              </button>
            </div>
            {doc.lastRunMs != null || doc.lastRunAt != null ? (
              <div
                className="dash-last-runtime"
                data-testid="dashboard-last-runtime"
                title={
                  doc.lastRunAt
                    ? `Finished ${new Date(doc.lastRunAt).toLocaleString()}${
                        doc.lastRunMs != null
                          ? ` · ${formatDashboardRuntime(doc.lastRunMs)}`
                          : ""
                      }`
                    : undefined
                }
              >
                Last run{" "}
                {formatDashboardLastRun(doc.lastRunAt, doc.lastRunMs)}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="dash-board-fill">
      <div
        className={"dash-board" + (widgetsLocked ? " dash-board-locked" : "")}
        ref={boardRef}
        data-testid="dashboard-board"
        data-locked={widgetsLocked ? "true" : "false"}
        style={{
          minHeight: Math.max(boardHeight, 480),
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest(".dash-widget")) return;
          closeConfig();
          setSelectedId(null);
        }}
      >
        {doc.widgets.map((widget) => {
          const result = results[widget.id];
          const headerOn = widget.showHeader !== false;
          const headerH = headerOn
            ? widget.headerHeight ?? DASH_HEADER_DEFAULT
            : 0;
          const anim = animating[widget.id];
          const isText = widget.kind === "text";
          const widgetStyle: React.CSSProperties = {
            left: `calc(${(widget.x / DASH_COLS) * 100}% + ${
              widget.x * (DASH_GAP / DASH_COLS)
            }px)`,
            width: `calc(${(widget.w / DASH_COLS) * 100}% - ${DASH_GAP}px)`,
            top: widget.y * (DASH_ROW_PX + DASH_GAP),
            height: widget.h * DASH_ROW_PX + (widget.h - 1) * DASH_GAP,
          };
          if (widget.backgroundColor) {
            widgetStyle.background = widget.backgroundColor;
          }
          return (
            <div
              key={widget.id}
              className={
                "dash-widget" +
                (isText ? " dash-widget-text" : "") +
                (selectedId === widget.id ? " selected" : "") +
                (widgetsLocked ? " dash-widget-locked" : "") +
                (anim ? " " + anim : "")
              }
              data-testid={`dashboard-widget-${widget.id}`}
              style={widgetStyle}
              onPointerDown={(e) => onPointerDownMove(e, widget)}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedId(widget.id);
              }}
            >
              {isText ? (
                <>
                  <div
                    className="dash-text-grab dash-text-grab-edge"
                    data-testid={`dashboard-text-grab-${widget.id}`}
                    title={widgetsLocked ? "Widgets locked" : "Drag to move"}
                    onPointerDown={(e) => {
                      if (widgetsLocked) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedId(widget.id);
                      dragRef.current = {
                        id: widget.id,
                        mode: "move",
                        startX: e.clientX,
                        startY: e.clientY,
                        orig: { ...widget },
                      };
                      pulse(widget.id, "dash-anim-drag", 200);
                      (e.currentTarget as HTMLElement).setPointerCapture?.(
                        e.pointerId,
                      );
                    }}
                  />
                  <div
                    className="dash-text-grab dash-text-grab-top"
                    title={widgetsLocked ? "Widgets locked" : "Drag to move"}
                    onPointerDown={(e) => {
                      if (widgetsLocked) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedId(widget.id);
                      dragRef.current = {
                        id: widget.id,
                        mode: "move",
                        startX: e.clientX,
                        startY: e.clientY,
                        orig: { ...widget },
                      };
                      pulse(widget.id, "dash-anim-drag", 200);
                      (e.currentTarget as HTMLElement).setPointerCapture?.(
                        e.pointerId,
                      );
                    }}
                  />
                </>
              ) : null}
              {headerOn ? (
                <div
                  className="dash-widget-head"
                  style={{
                    height: headerH,
                    minHeight: headerH,
                    ...(widget.headerColor
                      ? { background: widget.headerColor }
                      : null),
                  }}
                >
                  <span
                    className="dash-widget-title"
                    style={{
                      fontSize: Math.max(10, Math.round(headerH * 0.38)),
                    }}
                  >
                    {widget.title ||
                      widget.workflowName ||
                      (isText ? "Text" : "Empty Widget")}
                  </span>
                  <div className="dash-widget-actions">
                    <button
                      type="button"
                      className="btn sm ghost"
                      title="Configure"
                      data-testid={`dashboard-widget-configure-${widget.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openWidgetConfig(widget.id);
                      }}
                    >
                      <Icon.Edit size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      title="Expand"
                      data-testid={`dashboard-widget-expand-${widget.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openExpand(widget.id);
                      }}
                    >
                      <Icon.Maximize2 size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost icon xbtn"
                      title="Delete widget"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeWidget(widget.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ) : null}
              {!headerOn ? (
                <div className="dash-widget-actions dash-widget-actions-float">
                  <button
                    type="button"
                    className="btn sm ghost"
                    title="Configure"
                    data-testid={`dashboard-widget-configure-${widget.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openWidgetConfig(widget.id);
                    }}
                  >
                    <Icon.Edit size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    title="Expand"
                    data-testid={`dashboard-widget-expand-${widget.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openExpand(widget.id);
                    }}
                  >
                    <Icon.Maximize2 size={12} />
                  </button>
                </div>
              ) : null}
              <div className="dash-widget-body">
                <DashboardWidgetBody
                  widget={widget}
                  result={result}
                  onOpenPicker={() => void openPicker(widget.id)}
                  onTextChange={(text) => updateWidget(widget.id, { text })}
                  onSort={(col) => {
                    setResults((prev) => {
                      const cur = prev[widget.id];
                      if (
                        !cur ||
                        (cur.kind !== "table" && cur.kind !== "pivot")
                      ) {
                        return prev;
                      }
                      const same = cur.sortCol === col;
                      return {
                        ...prev,
                        [widget.id]: {
                          ...cur,
                          sortCol: col,
                          descending: same ? !cur.descending : false,
                        },
                      };
                    });
                  }}
                  onContentMetrics={({ widthPx, heightPx }) =>
                    fitWidgetToMetrics(widget.id, widthPx, heightPx)
                  }
                />
                {isText ? (
                  <div
                    className="dash-resize dash-resize-text"
                    data-testid={`dashboard-text-resize-${widget.id}`}
                    onPointerDown={(e) => onPointerDownResize(e, widget)}
                    onClick={(e) => e.stopPropagation()}
                    title="Resize"
                  />
                ) : null}
              </div>
              {!isText ? (
                <div
                  className="dash-resize"
                  onPointerDown={(e) => onPointerDownResize(e, widget)}
                  onClick={(e) => e.stopPropagation()}
                  title="Resize"
                />
              ) : null}
            </div>
          );
        })}
      </div>
      </div>

      {configFloat ? createPortal(configFloat, document.body) : null}

      {expandedId
        ? createPortal(
            (() => {
              const widget = doc.widgets.find((w) => w.id === expandedId);
              if (!widget) return null;
              const result = results[widget.id];
              const title =
                widget.title ||
                widget.workflowName ||
                (widget.kind === "text" ? "Text" : "Widget");
              return (
                <div
                  className="dash-expand-backdrop"
                  data-testid="dashboard-expand-backdrop"
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) closeExpand();
                  }}
                >
                  <div
                    ref={expandDrag.winRef as React.RefObject<HTMLDivElement>}
                    className={
                      "dash-expand-win win-float" +
                      (expandDrag.dragging ? " dragging" : "") +
                      (expandDrag.settled ? " settle" : "")
                    }
                    style={{
                      left: expandDrag.pos.x,
                      top: expandDrag.pos.y,
                      width: expandSize.w,
                      height: expandSize.h,
                    }}
                    role="dialog"
                    aria-label={`Expanded ${title}`}
                    data-testid={`dashboard-expand-${widget.id}`}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div
                      className="dash-expand-head"
                      onMouseDown={expandDrag.startDrag}
                      title="Drag to move"
                    >
                      <Icon.Maximize2 size={14} />
                      <span className="dash-expand-title">{title}</span>
                      <span className="spacer" />
                      <button
                        type="button"
                        className="btn sm ghost"
                        title="Close"
                        data-testid="dashboard-expand-close"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={closeExpand}
                      >
                        <Icon.X size={14} />
                      </button>
                    </div>
                    <div className="dash-expand-body">
                      <DashboardWidgetBody
                        widget={widget}
                        result={result}
                        onOpenPicker={() => void openPicker(widget.id)}
                        onTextChange={(text) =>
                          updateWidget(widget.id, { text })
                        }
                        onSort={(col) => {
                          setResults((prev) => {
                            const cur = prev[widget.id];
                            if (
                              !cur ||
                              (cur.kind !== "table" && cur.kind !== "pivot")
                            ) {
                              return prev;
                            }
                            const same = cur.sortCol === col;
                            return {
                              ...prev,
                              [widget.id]: {
                                ...cur,
                                sortCol: col,
                                descending: same ? !cur.descending : false,
                              },
                            };
                          });
                        }}
                      />
                    </div>
                    <div
                      className="dash-expand-resize"
                      data-testid="dashboard-expand-resize"
                      title="Resize"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        expandResizeRef.current = {
                          startX: e.clientX,
                          startY: e.clientY,
                          origW: expandSize.w,
                          origH: expandSize.h,
                        };
                        const el = e.currentTarget as HTMLElement;
                        el.setPointerCapture?.(e.pointerId);
                        const onMove = (ev: PointerEvent) => {
                          const d = expandResizeRef.current;
                          if (!d) return;
                          const next = {
                            w: Math.max(
                              360,
                              Math.min(
                                window.innerWidth - 32,
                                d.origW + (ev.clientX - d.startX),
                              ),
                            ),
                            h: Math.max(
                              240,
                              Math.min(
                                window.innerHeight - 32,
                                d.origH + (ev.clientY - d.startY),
                              ),
                            ),
                          };
                          setExpandSize(next);
                          const win = expandDrag.winRef.current;
                          if (win) {
                            win.style.width = next.w + "px";
                            win.style.height = next.h + "px";
                          }
                        };
                        const onUp = () => {
                          expandResizeRef.current = null;
                          window.removeEventListener("pointermove", onMove);
                          window.removeEventListener("pointerup", onUp);
                        };
                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", onUp);
                      }}
                    />
                  </div>
                </div>
              );
            })(),
            document.body,
          )
        : null}

      {pickerFor ? (
        <div
          className="dash-picker-backdrop"
          onMouseDown={() => setPickerFor(null)}
        >
          <div
            className="dash-modal"
            data-testid="dashboard-picker"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="dash-modal-head">
              <strong>Choose a NodeFlow workflow</strong>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setPickerFor(null)}
              >
                <Icon.X size={14} />
              </button>
            </div>
            <p className="dash-modal-note">
              Only saved Node workflows that include a <em>SamQL Dashboard</em>{" "}
              output node appear here.
            </p>
            {loadingEligible ? (
              <div className="dash-placeholder">Scanning workflows…</div>
            ) : eligible.length === 0 ? (
              <div className="dash-placeholder">
                No eligible workflows yet. In NodeFlow, end a flow with a{" "}
                <strong>SamQL Dashboard</strong> output and save it.
              </div>
            ) : (
              <ul className="dash-picker-list">
                {eligible.map((w) => (
                  <li key={w.name}>
                    <button
                      type="button"
                      className="dash-picker-item"
                      onClick={() => {
                        updateWidget(pickerFor, {
                          workflowName: w.name,
                          title: w.name,
                        });
                        setPickerFor(null);
                      }}
                    >
                      <Icon.Workflow size={14} /> {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

function ReconcileSummary({
  data,
}: {
  data: {
    totals?: Record<string, number>;
    fields?: {
      field: string;
      matching: number;
      non_matching: number;
      a_only: number;
      b_only: number;
    }[];
  };
}) {
  const fields = data.fields || [];
  return (
    <div className="dash-recon">
      {data.totals ? (
        <div className="dash-recon-totals">
          {Object.entries(data.totals).map(([k, v]) => (
            <div key={k} className="dash-recon-chip">
              <span>{k}</span>
              <strong>{Number(v).toLocaleString()}</strong>
            </div>
          ))}
        </div>
      ) : null}
      <table className="dash-recon-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Match</th>
            <th>Diff</th>
            <th>A only</th>
            <th>B only</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.field}>
              <td>{f.field}</td>
              <td>{f.matching}</td>
              <td>{f.non_matching}</td>
              <td>{f.a_only}</td>
              <td>{f.b_only}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
