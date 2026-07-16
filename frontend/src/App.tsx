import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AboutModal } from "./components/AboutModal";
import { TablePropsModal } from "./components/TablePropsModal";
import { useConfirmPop } from "./components/ConfirmPop";
import { ServerWatchdog } from "./components/ServerWatchdog";
import { api,
  ApiError,
  exportResultToFile,
  saveToDownloads } from "./lib/api";
import type { RootIdChoice } from "./lib/api";
import { dropManyConfirmMessage } from "./lib/dropManyConfirm";
import { menuPos } from "./lib/menuPos";
import { startPointerDrag } from "./lib/pointerDrag";
import { statementAt } from "./lib/sql";
import { wfEnvelope, wfFileName } from "./lib/workflowFile";
import { backupLocalStorageValue, runMigrations } from "./lib/migrations";
import type {
  StatementEntry,
  Health, TableInfo, HistoryEntry, SavedQuery, ResultPage,
  TableProfile, EngineKind, MemInfo, LoadProgress, ColumnFilter, FilterOp,
  ReconcileResult, TaskCard,
} from "./lib/types";
import { Icon } from "./components/Icon";
import { Sidebar } from "./components/Sidebar";
import { SqlEditor } from "./components/SqlEditor";
import { DataGrid } from "./components/DataGrid";
import { Profiler } from "./components/Profiler";
import { ChartPanel } from "./components/ChartPanel";
import { PivotPanel } from "./components/PivotPanel";
import { LoadDataModal, FileBrowser, RootIdPicker } from "./components/LoadDataModal";
// .547 startup: lazy-load NodeFlow so its canvas + chart libraries are
// fetched only when the user opens that view, not on first paint.
const NodeFlow = lazy(() =>
  import("./components/NodeFlow").then((m) => ({ default: m.NodeFlow })),
);
const Dashboard = lazy(() =>
  import("./components/Dashboard").then((m) => ({ default: m.Dashboard })),
);
import { Modal } from "./components/Modal";
import { ErrorLogModal } from "./components/ErrorLogModal";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import {
  StorageMemoryModal,
  type StorageMemoryTab,
} from "./components/StorageMemoryModal";
import { ActivityModal } from "./components/ActivityModal";
import { useCreatedNodesSettings } from "./components/CreatedNodesSettings";
import { useDashboardSettings } from "./components/DashboardSettings";
import {
  useActivityStatus,
  useEngineReset,
  ActivityMonitor,
  useTasks,
  TaskWatcher,
} from "./components/ActivityShared";
import { ProgressBar } from "./components/ProgressBar";
import { useRunProgress } from "./lib/useRunProgress";
import { cancelOne, isCancelledError, registerRun, unregisterRun, wasCancelled } from "./lib/runController";
import { uid } from "./lib/ids";
import { setNodeFlowDenseMode } from "./lib/nodeFlowModel";
import { ReconcileModal, ReconSpec } from "./components/ReconcileModal";
import { DocsModal } from "./components/DocsModal";
import { Notebook } from "./components/Notebook";
import { FieldExplorer } from "./components/FieldExplorer";
import { CommandPalette, type CommandPaletteItem } from "./components/CommandPalette";
import { ReconReport } from "./components/ReconReport";
import { reconReportCsv, reconCsvFilename } from "./lib/reconExport";
import { createReconDetailController } from "./lib/reconDetailActions";
import { profileCsv, profileCsvFilename } from "./lib/profileExport";
import type { EdTab, ResultTab } from "./controllers/appTypes";
import { useBackgroundOperations } from "./controllers/useBackgroundOperations";
import { useCatalogController } from "./controllers/useCatalogController";
import { useResultController } from "./controllers/useResultController";
import { useIdeController } from "./controllers/useIdeController";
import { useWorkspaceController } from "./controllers/useWorkspaceController";
import { FloatingPanel } from "./components/FloatingPanel";
import {
  moveFloat as moveFloatById,
  resizeFloat as resizeFloatById,
  hasFloat,
  applyCompareDrop,
} from "./lib/docking";

interface Toast {
  id: number;
  kind: "ok" | "error" | "warn";
  title: string;
  msg?: string;
  leaving?: boolean;
}

function moveById<T extends { id: string }>(
  list: T[],
  fromId: string,
  toId: string,
): T[] {
  const from = list.findIndex((x) => x.id === fromId);
  const to = list.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0 || from === to) return list;
  const copy = list.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

// Resolve the loaded table a result's column maps to, but only for a
// straightforward single-table view (e.g. `SELECT * FROM t`). Returns null
// for joins, unions, subqueries or computed columns so we never change the
// wrong table's data.
function backingColumn(
  sql: string | undefined,
  col: string,
  tables: TableInfo[],
): { table: string; engine: EngineKind; currentType: string } | null {
  if (!sql) return null;
  const s = sql.trim().replace(/;+\s*$/, "");
  if (/\bjoin\b/i.test(s) || /\bunion\b/i.test(s)) return null;
  const froms = s.match(/\bfrom\b/gi) || [];
  if (froms.length !== 1) return null; // reject subqueries / multiple sources
  const m = s.match(/\bfrom\s+["'`[]?([A-Za-z_][\w$]*)["'`\]]?/i);
  if (!m) return null;
  const t = tables.find((x) => x.name === m[1]);
  if (!t || (t.engine !== "sqlite" && t.engine !== "duckdb")) return null;
  const c = t.columns.find((cc) => cc.name === col);
  if (!c) return null;
  return { table: t.name, engine: t.engine, currentType: c.type };
}

const TYPE_CHOICES: [string, string][] = [
  ["TEXT", "Text"],
  ["INTEGER", "Integer"],
  ["REAL", "Decimal / float"],
];

// Column-filter operators offered in the grid header menu.
const FILTER_OPS: [FilterOp, string][] = [
  ["contains", "contains"],
  ["equals", "equals"],
  ["ne", "not equals"],
  ["gt", "greater than"],
  ["gte", "greater or equal"],
  ["lt", "less than"],
  ["lte", "less or equal"],
  ["starts", "starts with"],
  ["ends", "ends with"],
  ["is_null", "is null"],
  ["not_null", "is not null"],
];
const NO_VALUE_OPS = new Set<FilterOp>(["is_null", "not_null"]);

// ---- session persistence (browser localStorage) ----
// Persists open query tabs + their SQL, panel sizes, and engine/read-only,
// so a reload doesn't lose the user's work. Result rows are NOT persisted
// (they live in the server's memory and are cheap to re-run).
const SESSION_KEY = "samql.session.v1";
const SESSION_VERSION = 2;
const SESSION_MIGRATIONS = {
  0: (raw: any) => ({ ...raw, version: 1 }),
  1: (raw: any) => ({ ...raw, version: 2 }),
};
const VIEW_KEY = "samql.view.v1";
// Future-version session bytes are preserved verbatim. The current build may
// open with a clean in-memory workspace, but it must not overwrite data that a
// newer SamQL release may still understand.
let sessionPersistenceBlocked = false;
// rows fetched per lazy "load more" step as the user scrolls a big result
const LAZY_CHUNK = 1000;
function loadSession(): any | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupLocalStorageValue(SESSION_KEY, raw);
    return null;
  }

  if (
    parsed &&
    Number.isInteger(parsed.version) &&
    parsed.version > SESSION_VERSION
  ) {
    backupLocalStorageValue(SESSION_KEY, raw);
    sessionPersistenceBlocked = true;
    return null;
  }

  try {
    const migrated = runMigrations<any>(
      parsed,
      SESSION_VERSION,
      SESSION_MIGRATIONS,
      "SamQL session state",
    );
    if (migrated.migrated) {
      backupLocalStorageValue(SESSION_KEY, raw);
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(migrated.value));
    }
    return migrated.value;
  } catch {
    backupLocalStorageValue(SESSION_KEY, raw);
    return null;
  }
}
const SAVED = loadSession();
const SAFE_TARGETS = new Set(["auto", "__local__", "__duckdb__"]);
const HAS_SAVED_TARGET = SAFE_TARGETS.has(SAVED?.target);

const SAMPLE = `-- Welcome to SamQL. Load a file from the sidebar, then query it.
-- Ctrl/Cmd+Enter runs the whole editor (or the selection).
-- F5 runs just the statement at the cursor.

SELECT 1 AS hello, 'world' AS greeting;`;

// The top-bar logo. Renders /logo.png (22x22, in frontend/public/); if that
// file is missing or fails to decode it gracefully falls back to the original
// lettered "S" badge so the header never shows a broken image.
const BrandMark: React.FC = () => {
  // .469: the header wears the SAME art as the window. Either custom
  // file name works (app-icon.png or logo.png -- the server serves the
  // embedded SQ when neither is shipped, so the first candidate only
  // ever "errors" if the request itself fails).
  const [srcIdx, setSrcIdx] = useState(0);
  const sources = ["/app-icon.png", "/logo.png"];
  return srcIdx < sources.length ? (
    // .475: the icon sits in a clipping box so its transparent margin
    // is cropped and the actual mark fills the footprint.
    <span className="mark-img-wrap">
      <img
        className="mark-img"
        src={sources[srcIdx]}
        alt="SamQL"
        onError={() => setSrcIdx((i) => i + 1)}
      />
    </span>
  ) : (
    <span className="mark">S</span>
  );
};

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  // DuckDB concurrent ("async") reads -- mirrors /api/health, toggled in Settings
  // on (matches the server default) so the toggle shows the right state before
  const {
    edTabs,
    setEdTabs,
    activeId,
    setActiveId,
    activeTab,
    edTabsRef,
    activeIdRef,
    dragTab,
    runs,
    setRuns,
    runsNow,
    running,
    endRun,
    cancelRunning,
    queryError,
    setQueryError,
    conflict,
    setConflict,
    okMessage,
    setOkMessage,
    target,
    setTarget,
    readOnly,
    setReadOnly,
    dialect,
    setDialect,
    setSql,
    undoIde,
    redoIde,
    canUndoIde,
    canRedoIde,
    onEditorKeyDown,
    newTab,
    loadSqlIntoEditor,
    insertText,
    titleForTab,
    runFlash,
    flashRun,
    tabsRef,
    tabUl,
  } = useIdeController({
    saved: SAVED,
    sampleSql: SAMPLE,
    safeTargets: SAFE_TARGETS,
  });

  // cancels a still-running query when a new one is launched, so a stale
  // response can't land in the wrong result tab (and we don't wait on it).
  // Holds both the fetch controller and the server-side query id so the
  // superseded query is interrupted on the backend, not just abandoned.
  // Live completion for the Run bar (next to Run/Stop). Determinate when the
  // running op reports a fraction (e.g. a multi-step build); indeterminate for
  // a single opaque query.
  const runProg = useRunProgress(running, runs[activeTab?.id ?? ""]?.queryId);

  const [loadOpen, setLoadOpen] = useState(false);
  // OS drag-and-drop file load: `dragging` drives the drop overlay; once files
  // are dropped they wait in `dropFiles` for a "how to load" choice.
  const [dragging, setDragging] = useState(false);
  const [dropFiles, setDropFiles] = useState<File[] | null>(null);
  const [dropDest, setDropDest] = useState("auto");
  const [dropMode, setDropMode] = useState("materialize"); // copy vs view
  const [dropDelim, setDropDelim] = useState("");
  // JSON only: comma-separated keys/paths to skip when flattening. Skipping a
  // heavy nested array drops its rows + child table, so a huge nested file can
  // load a usable subset in a fraction of the time.
  const [dropExclude, setDropExclude] = useState("");
  // drop-modal: JSON→DuckDB flatten-to-relational (shred) toggle
  const [dropShred, setDropShred] = useState(false);
  // .521: the drop prompt's unique-identifier choice; a new drop resets it.
  const [dropRootId, setDropRootId] = useState<RootIdChoice | null>(null);
  useEffect(() => {
    setDropRootId(null);
  }, [dropFiles]);
  useEffect(() => {
    // Keep the drop prompt aligned with the Load modal: never leave DuckDB /
    // view-mode selected when this machine has no DuckDB.
    if (!health?.features?.duckdb) {
      setDropDest((d) => (d === "duckdb" ? "auto" : d));
      setDropMode("materialize");
    }
  }, [health?.features?.duckdb]);
  const [dropSheets, setDropSheets] = useState<string[] | null>(null);
  const [dropSheet, setDropSheet] = useState(""); // "" = all sheets
  const [dropHeaderRow, setDropHeaderRow] = useState(1);
  const [saveOpen, setSaveOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [saveTableOpen, setSaveTableOpen] = useState(false);
  const [saveTableName, setSaveTableName] = useState("");
  const [saveTableEngine, setSaveTableEngine] = useState("auto");
  const [exitOpen, setExitOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [joinGuideOpen, setJoinGuideOpen] = useState(false);
  const [reconcileInitial, setReconcileInitial] = useState<string | undefined>(
    undefined,
  );
  const openReconcileWith = (name: string) => {
    setReconcileInitial(name);
    setReconcileOpen(true);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  // floating field-access explorer; stays open across IDE / Journal / Node
  const [fieldExplorerOpen, setFieldExplorerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Tools & Tables is NodeFlow-only; open flag lives here so Ctrl+K can open it
  // and it reappears when returning to NodeFlow (hidden in IDE/Journal).
  const [toolsTablesOpen, setToolsTablesOpen] = useState(false);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [storage, setStorage] = useState<{
    open: boolean;
    busy: boolean;
    tab?: StorageMemoryTab;
    rep?: Awaited<ReturnType<typeof api.storageReport>> | null;
  } | null>(null);
  const [storageMem, setStorageMem] = useState<MemInfo | null>(null);
  const openStorage = async (tab: StorageMemoryTab = "storage") => {
    setSettingsOpen(false);
    setStorage({ open: true, busy: true, tab });
    api.memory().then(setStorageMem).catch(() => setStorageMem(null));
    try {
      const rep = await api.storageReport();
      setStorage({ open: true, busy: false, tab, rep });
    } catch (e: any) {
      toast("error", "Storage report failed", e.message || String(e));
      setStorage(null);
    }
  };

  // load the files captured by a drag-and-drop, using the chosen destination.
  // Runs as a background job (so it can be cancelled mid-load): the upload is
  // quick, then the progress modal takes over and polls / offers Cancel.
  const doDropLoad = () => {
    if (!dropFiles || !dropFiles.length) return;
    const files = dropFiles;
    const isExcel =
      files.length === 1 && /\.(xlsx|xlsm|xls)$/i.test(files[0].name);
    const dest = dropDest;
    const delim = dropDelim.trim() || undefined;
    const sheet = isExcel && dropSheet ? dropSheet : undefined;
    const headerRow = isExcel ? dropHeaderRow : undefined;
    const mode = isExcel ? "materialize" : dropMode;
    const isJson =
      !isExcel && files.some((f) => /\.(json|ndjson|jsonl)$/i.test(f.name));
    const shredEligible =
      isJson && !!health?.features?.duckdb && dest !== "sqlite";
    const exclude =
      isJson && !shredEligible ? dropExclude.trim() || undefined : undefined;
    // Close the prompt and return to the main screen at once; the upload + load
    // run in the background and surface as a cancellable card in the activity
    // tray + stat popover, exactly like the file-browser load.
    setDropFiles(null);
    setDropDelim("");
    setDropExclude("");
    setDropSheets(null);
    setDropSheet("");
    setDropHeaderRow(1);
    setDropMode("materialize");
    setDropShred(false);
    setDropRootId(null);
    const startLabel =
      files.length === 1 ? files[0].name : `${files.length} files`;
    toast(
      "ok",
      `Loading ${startLabel}`,
      "Started — tracking in the activity panel.",
    );
    api.loadFilesStart(
      files, dest, delim, sheet, headerRow, mode, exclude,
      shredEligible
        ? {
            flatten: false,
            shred: dropShred,
            ...(dropRootId ? { root_id: dropRootId } : {}),
          }
        : undefined,
    ).catch(
      (e: any) => toast("error", "Load failed", e?.message),
    );
  };

  // window-wide drag-and-drop: show an overlay while a file is dragged in, and
  // on drop hand the files to the "how to load" prompt. preventDefault on
  // dragover/drop stops the browser from just opening the dropped file.
  useEffect(() => {
    let depth = 0;
    let peekCtrl: AbortController | null = null;
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer &&
      Array.from(e.dataTransfer.types || []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files || []);
      depth = 0;
      setDragging(false);
      if (!files.length) return;
      e.preventDefault();
      setDropChip({
        x: e.clientX,
        y: e.clientY,
        name:
          files.length === 1
            ? files[0].name
            : files.length + " files",
        tick: Date.now(),
      });
      if (chipTimer.current != null)
        window.clearTimeout(chipTimer.current);
      chipTimer.current = window.setTimeout(() => {
        setDropChip(null);
        chipTimer.current = null;
      }, 700);
      setDropDest("auto");
      setDropMode("materialize");
      setDropSheet("");
      setDropHeaderRow(1);
      setDropExclude("");
      setDropSheets(null);
      setDropFiles(files);
      // If exactly one Excel workbook was dropped, read its sheet names (the
      // file is uploaded once for the peek, then discarded) so the prompt can
      // offer the same sheet picker + header-row choice as the file browser.
      // Abort any prior peek so a superseded drop cannot patch stale sheets.
      peekCtrl?.abort();
      peekCtrl = null;
      if (files.length === 1 && /\.(xlsx|xlsm|xls)$/i.test(files[0].name)) {
        const ctrl = new AbortController();
        peekCtrl = ctrl;
        api
          .excelPeek(files[0], ctrl.signal)
          .then((r) => {
            if (!ctrl.signal.aborted) setDropSheets(r.sheets || []);
          })
          .catch((err) => {
            if (isCancelledError(err)) return;
            setDropSheets(null);
          });
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      peekCtrl?.abort();
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  // optional warm ivory canvas background for the NodeFlow (toggle in Settings);
  // applied as a body class so the NodeFlow canvas CSS can pick it up
  const [ivoryCanvas, setIvoryCanvas] = useState(() => {
    try {
      return window.localStorage?.getItem("samql.canvasIvory") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.body.classList.toggle("canvas-ivory", ivoryCanvas);
    try {
      window.localStorage?.setItem(
        "samql.canvasIvory",
        ivoryCanvas ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [ivoryCanvas]);
  // optional reduced motion -- defaults to the OS "reduce motion" setting and is
  // toggleable in Settings; applied as a body class that zeroes the animations
  const [reduceMotion, setReduceMotion] = useState(() => {
    try {
      const saved = window.localStorage?.getItem("samql.reduceMotion");
      if (saved != null) return saved === "1";
      return (
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.body.classList.toggle("motion-reduced", reduceMotion);
    try {
      window.localStorage?.setItem(
        "samql.reduceMotion",
        reduceMotion ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [reduceMotion]);
  // Eye Care: enlarge text, buttons, nodes, and containers together.
  const [eyeCare, setEyeCare] = useState(() => {
    try {
      return window.localStorage?.getItem("samql.eyeCare") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("eye-care", eyeCare);
    document.documentElement.setAttribute(
      "data-eye-care",
      eyeCare ? "on" : "off",
    );
    try {
      window.localStorage?.setItem("samql.eyeCare", eyeCare ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [eyeCare]);
  // Dense NodeFlow: shrink canvas geometry so more nodes fit. Pairs with
  // Eye Care (chrome larger, graph denser). Apply the layout flag in the
  // state initializer / click handler so the same render sees densified sizes.
  const [nodeFlowDense, setNodeFlowDense] = useState(() => {
    let on = false;
    try {
      on = window.localStorage?.getItem("samql.nodeFlowDense") === "1";
    } catch {
      on = false;
    }
    setNodeFlowDenseMode(on);
    return on;
  });
  useLayoutEffect(() => {
    setNodeFlowDenseMode(nodeFlowDense);
    try {
      window.localStorage?.setItem(
        "samql.nodeFlowDense",
        nodeFlowDense ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [nodeFlowDense]);
  // optional ivory background for the SQL editor (separate toggle in Settings)
  const [ivoryEditor, setIvoryEditor] = useState(() => {
    try {
      return window.localStorage?.getItem("samql.editorIvory") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.body.classList.toggle("editor-ivory", ivoryEditor);
    try {
      window.localStorage?.setItem("samql.editorIvory", ivoryEditor ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [ivoryEditor]);
  const [exiting, setExiting] = useState<null | "kept" | "stopped">(null);
  // While true, the browser shows a native "leave site?" prompt on tab
  // close / reload. We flip it off only for an intentional exit.
  const exitGuard = useRef(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [sidebarW, setSidebarW] = useState(() =>
    typeof SAVED?.sidebarW === "number" ? SAVED.sidebarW : 290,
  );
  // whether the left tables panel is shown (toggle in Settings); hiding it
  // gives the results the full width.
  const [showTables, setShowTables] = useState<boolean>(() =>
    typeof SAVED?.showTables === "boolean" ? SAVED.showTables : true,
  );
  // when in the Node view with the tables panel shown, selecting a node swaps
  // the tables list for that node's config panel (and back, on deselect).
  const [nbSel, setNbSel] = useState(false);
  const [nbHostEl, setNbHostEl] = useState<HTMLElement | null>(null);
  const [dashSel, setDashSel] = useState(false);
  const [dashHostEl, setDashHostEl] = useState<HTMLElement | null>(null);
  const [dashReloadKey, setDashReloadKey] = useState(0);
  // whether the Node view's palette shows its "Search nodes…" bar
  const [showNodeSearch, setShowNodeSearch] = useState<boolean>(() =>
    typeof SAVED?.showNodeSearch === "boolean" ? SAVED.showNodeSearch : true,
  );
  // node palette/toolbar visibility lives here so both the in-canvas button and
  // the Settings > View toggle share one source of truth (persisted; the key is
  // the one the NodeFlow used before, so an existing preference carries over).
  const [nodeToolbarHidden, setNodeToolbarHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("samql.nb2.paletteHidden") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "samql.nb2.paletteHidden",
        nodeToolbarHidden ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [nodeToolbarHidden]);
  const [resultsH, setResultsH] = useState(() =>
    typeof SAVED?.resultsH === "number" ? SAVED.resultsH : 340,
  );

  // ---- toasts ----
  const toast = useCallback(
    (kind: Toast["kind"], title: string, msg?: string) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, kind, title, msg }]);
      setTimeout(
        () => {
          // mark it leaving so it animates out, then drop it after the exit
          setToasts((t) =>
            t.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
          );
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 220);
        },
        kind === "error" ? 6500 : 3800,
      );
    },
    [],
  );
  const createdNodesUi = useCreatedNodesSettings(toast);

  const {
    tables,
    setTables,
    history,
    setHistory,
    saved,
    setSaved,
    workflows,
    refreshTables,
    refreshHistory,
    refreshSaved,
    refreshWorkflows,
    onDisconnect,
  } = useCatalogController(toast);

  const {
    startBgOp,
    endBgOp,
    cancelBgOp,
    beginLoad,
    beginLoadFolder,
    beginHdfsFileLoad,
    beginOptimize,
    onTaskComplete,
  } = useBackgroundOperations({
    toast,
    refreshTables,
    setLoadOpen,
  });

  const {
    resTabs,
    setResTabs,
    activeResId,
    setActiveResId,
    activeRes,
    activeResultTab,
    resTabsRef,
    activeResIdRef,
    dragRes,
    patchRes,
    resMenu,
    setResMenu,
    colMenu,
    setColMenu,
    filterDraft,
    setFilterDraft,
    floats,
    setFloats,
    compare,
    setCompare,
    dockHot,
    setDockHot,
    resultPaneRef,
    dockRect,
    floatView,
    dockFloat,
    focusFloat,
    resultPaging,
    rerunExpiredResultRef,
  } = useResultController(toast, LAZY_CHUNK);

  const { ui: confirmUi, ask: askConfirm } = useConfirmPop();

  const {
    view,
    viewRef,
    switchView,
    journalCmd,
    setJournalCmd,
    nodeCmd,
    setNodeCmd,
    dashboardCmd,
    setDashboardCmd,
    ideWfNames,
    journalLoad,
    setJournalLoad,
    nodeLoad,
    setNodeLoad,
    dashboardLoad,
    setDashboardLoad,
    ideFile,
    setIdeFile,
    onLoadWorkflow,
    onDeleteWorkflow,
    openWorkflowContent,
    activeSave,
    activeSaveAs,
    activeOpen,
  } = useWorkspaceController({
    viewKey: VIEW_KEY,
    toast,
    askConfirm,
    refreshWorkflows,
    edTabsRef,
    activeIdRef,
    loadSqlIntoEditor,
  });

  const dashboardUi = useDashboardSettings(toast, () => {
    setDashReloadKey((k) => k + 1);
    switchView("dashboard");
  });
  // ---- exit / tab-close handling ----
  // Browsers only allow their own generic confirmation during an actual
  // tab close, so this guard provides the "really exit?" prompt (Cancel =
  // stay). The three-way choice lives in the in-app Exit modal below.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!exitGuard.current) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const exitKeepServer = useCallback(() => {
    exitGuard.current = false;
    setExitOpen(false);
    setExiting("kept");
    // user-opened tabs usually can't be closed by script; the goodbye
    // screen covers that case.
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 60);
  }, []);

  const exitStopServer = useCallback(async () => {
    exitGuard.current = false;
    setExitOpen(false);
    setExiting("stopped");
    try {
      await api.shutdownServer();
    } catch {
      /* server may drop the connection as it stops; that's expected */
    }
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 60);
  }, []);
  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        // Prefer DuckDB only for a brand-new workspace. A persisted or
        // migrated engine choice is user state and must survive reload.
        if (h.features?.duckdb && !HAS_SAVED_TARGET) setTarget("__duckdb__");
        if (h.restoring) {
          // Session restore is rebuilding the previously-loaded tables in the
          // background; refresh the panel as they arrive until it finishes.
          let tries = 0;
          const poll = () => {
            api
              .health()
              .then((h2) => {
                setHealth(h2);
                refreshTables();
                tries += 1;
                if (h2.restoring && tries < 40) {
                  window.setTimeout(poll, 1200);
                } else if (!h2.restoring && h2.restored) {
                  toast(
                    "ok",
                    "Session restored",
                    `${h2.restored} table(s) reloaded`,
                  );
                }
              })
              .catch(() => {});
          };
          window.setTimeout(poll, 1000);
        }
      })
      .catch(() =>
        toast(
          "error",
          "Backend unreachable",
          "Is the Python server running on this port?",
        ),
      );
    refreshTables();
    refreshHistory();
    refreshSaved();
    refreshWorkflows();
    // If a background load is still running (e.g. the page was reloaded
    // mid-load), reattach to it so its progress bar reappears and the
    // table shows up automatically when it finishes.
    // (in-flight loads re-appear on their own: the activity tray polls
    // /api/tasks, so a reload re-attaches to running work without help here.)
    // One catch-up refresh shortly after load, in case a load committed
    // right as the page was (re)loaded.
    const t = window.setTimeout(refreshTables, 1300);
    return () => window.clearTimeout(t);
  }, [refreshTables, refreshHistory, refreshSaved, refreshWorkflows, setTarget, toast]);

  // Whenever the tab regains focus, re-sync the table list so it never
  // goes stale relative to the backend.
  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden) refreshTables();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshTables]);

  // The completion poll lives in a self-contained TaskWatcher (rendered
  // below) so the 1.5s /api/tasks tick re-renders only it, not the whole IDE.
  // double-click-to-rename for editor tabs; the title also labels the
  // tab's runs in the stat window
  const [renamingTab, setRenamingTab] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const commitRename = () => {
    setRenamingTab((r) => {
      if (r) {
        const name = r.draft.trim();
        if (name) {
          setEdTabs((tabs) =>
            tabs.map((x) => (x.id === r.id ? { ...x, title: name } : x)),
          );
          // the result tabs this editor tab produced follow the rename,
          // so grid/chart/pivot stay visibly associated with their query
          setResTabs((tabs) =>
            tabs.map((x) =>
              x.kind === "result" && x.originTabId === r.id
                ? { ...x, title: name }
                : x,
            ),
          );
        }
      }
      return null;
    });
  };

  const [aboutOpen, setAboutOpen] = useState(false);
  const [tableProps, setTableProps] = useState<
    { engine: string; name: string } | null
  >(null);

  // .533: closing a query tab that HAS text asks first (in-window, the
  // node-style popup); a pristine tab closes silently.
  const closeTab = (id: string, anchor?: HTMLElement | null) => {
    const t = edTabs.find((x) => x.id === id);
    const hasText = !!(t && (t.sql || "").trim());
    if (!hasText) return reallyCloseTab(id);
    askConfirm(
      anchor || { left: window.innerWidth / 2 - 94, top: 80, side: "right" },
      `Close “${t?.title}”? Its editor text will be lost.`,
      () => reallyCloseTab(id),
      "Close",
    );
  };

  const reallyCloseTab = (id: string) => {

    setEdTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = { id: uid(), title: "Query 1", sql: "" };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) {
        setActiveId(next[Math.max(0, idx - 1)].id);
      }
      return next;
    });
  };

  const runResolved = useCallback(
    async (
      sql: string,
      _retry = false,
      previewLimit?: number,
      lockedTabId?: string,
    ) => {
      const trimmed = (sql || "").trim();
      if (!trimmed) return;
      // supersede THIS TAB's in-flight query only: other tabs' queries run
      // concurrently and are left alone. Abort the fetch *and* tell the
      // backend to interrupt it so it stops burning CPU. Freeze tabId for
      // the whole run so a mid-query switch cannot rebind or retry elsewhere.
      const tabId = lockedTabId || activeIdRef.current;
      const prev = runsNow()[tabId];
      if (prev) cancelOne(prev.queryId, prev.ctrl);
      const ctrl = new AbortController();
      const queryId = uid() + uid();
      const stillOwnsRun = () => runsNow()[tabId]?.queryId === queryId;
      setRuns((m) => ({
        ...m,
        [tabId]: { ctrl, queryId, startedAt: Date.now() },
      }));
      registerRun(queryId, ctrl); // .519: modal Cancel can abort this fetch
      setQueryError(null);
      setConflict(null);
      let ranOk = false;
      setOkMessage(null);
      try {
        const res = await api.query(
          trimmed,
          target,
          readOnly,
          queryId,
          ctrl.signal,
          dialect,
          undefined,
          { surface: "ide", label: titleForTab(tabId),
            per_statement: previewLimit == null,
            preview_limit: previewLimit },
        );
        if (!stillOwnsRun()) return res;
        if (res.error) {
          if (res.error === "cross_engine_conflict") {
            setConflict(res.detail);
          } else if (res.cancelled || res.error === "cancelled") {
            // superseded/cancelled: leave the prior result in place
          } else {
            setQueryError(res.error);
          }
          return res; // .460: callers ping the failing span in red
        } else if (res.result_id == null) {
          // non-SELECT statement succeeded
          setOkMessage(
            `Statement executed on ${res.engine}. ${res.elapsed_ms ?? 0} ms.`,
          );
          refreshTables();
        } else {
          // SELECT result -> bind to the tab that started this run.
          if (res.result_capped)
            toast(
              "warn",
              "Result capped",
              `Stopped at the ${(res.result_cap ?? 0).toLocaleString()}-row safety limit — the query produced more. Add a filter (or raise SAMQL_MAX_RESULT_ROWS) to see everything.`,
            );
          const originId = tabId;
          const edTab = edTabsRef.current.find((t) => t.id === originId);
          const liveId = edTab?.liveResId;
          const cur = resTabsRef.current;
          const live = cur.find(
            (r) => r.kind === "result" && !r.pinned && r.id === liveId,
          );
          if (live) {
            // re-run / edit of the same query updates its result in place
            setResTabs(
              cur.map((r) =>
                r.id === live.id
                  ? {
                      ...r,
                      resultId: res.result_id ?? null,
                      queryId,
                      page: res,
                      sql: trimmed,
                      sortCol: null,
                      descending: false,
                      filters: [],
                      allColumns: res.columns || [],
                      visibleColumns: null,
                      statements:
                        (res.statements?.length ?? 0) > 1
                          ? res.statements
                          : undefined,
                      activeStmt: res.statements?.find(
                        (e) => e.result_id === res.result_id,
                      )?.index,
                      title: titleForTab(originId),
                    }
                  : r,
              ),
            );
            setActiveResId(live.id);
          } else {
            const nid = uid();
            const nt: ResultTab = {
              id: nid,
              kind: "result",
              title: titleForTab(originId),
              resultId: res.result_id ?? null,
              queryId,
              originTabId: originId,
              pinned: false,
              page: res,
              sortCol: null,
              descending: false,
              allColumns: res.columns || [],
              visibleColumns: null,
              view: "grid",
              sql: trimmed,
              statements:
                (res.statements?.length ?? 0) > 1
                  ? res.statements
                  : undefined,
              activeStmt: res.statements?.find(
                (e) => e.result_id === res.result_id,
              )?.index,
            };
            setResTabs([...cur, nt]);
            setEdTabs((ts) =>
              ts.map((t) =>
                t.id === originId ? { ...t, liveResId: nid } : t,
              ),
            );
            setActiveResId(nid);
          }
          // a pure read can't have changed the catalog; skip the recount
          if ((res as any).stmt_kind !== "read") refreshTables();
        }
        ranOk = true;
        return res;
      } catch (e: any) {
        if (isCancelledError(e, queryId)) return; // cancelled (any surface)
        if (!stillOwnsRun()) return;
        const network =
          !(e instanceof ApiError) &&
          (e instanceof TypeError ||
            /failed to fetch|networkerror|load failed/i.test(
              e?.message || "",
            ));
        // .519: NEVER auto-retry a run the user cancelled -- the old path
        // resurrected the query under a fresh id right after a Cancel.
        if (network && !_retry && !wasCancelled(queryId)) {
          // the local server retired a poisoned keep-alive socket (e.g.
          // right after cancelling a long query). Reap any phantom run,
          // breathe, and retry ONCE on a fresh connection + id for the
          // same originating tab.
          void api.cancelQuery(queryId).catch(() => {});
          await new Promise((r) => setTimeout(r, 350));
          return runResolved(trimmed, true, previewLimit, tabId);
        }
        const msg =
          e instanceof ApiError ? e.message : e.message || String(e);
        setQueryError(
          network ? msg + " — the local server didn't answer; it may still" +
            " be unwinding a cancelled query. Run again in a moment." : msg,
        );
      } finally {
        unregisterRun(queryId);
        endRun(tabId, ctrl);
        refreshHistory();
        if (ranOk) flashRun();
      }
    },
    [
      activeIdRef,
      dialect,
      edTabsRef,
      endRun,
      flashRun,
      readOnly,
      refreshHistory,
      refreshTables,
      resTabsRef,
      runsNow,
      setActiveResId,
      setConflict,
      setEdTabs,
      setOkMessage,
      setQueryError,
      setResTabs,
      setRuns,
      target,
      titleForTab,
      toast,
    ],
  );

  // ---- result-tab management ----
  const pinRes = (id: string) => {
    setResTabs((rs) =>
      rs.map((r) => (r.id === id ? { ...r, pinned: true } : r)),
    );
    // detach from its query tab so the next run opens a fresh result
    setEdTabs((ts) =>
      ts.map((t) => (t.liveResId === id ? { ...t, liveResId: undefined } : t)),
    );
    setResMenu(null);
  };
  const unpinRes = (id: string) => {
    const r = resTabsRef.current.find((x) => x.id === id);
    setResTabs((rs) =>
      rs.map((x) => (x.id === id ? { ...x, pinned: false } : x)),
    );
    // re-bind to its origin query so the next run updates this tab again
    if (r?.originTabId) {
      const origin = r.originTabId;
      setEdTabs((ts) =>
        ts.map((t) => (t.id === origin ? { ...t, liveResId: id } : t)),
      );
    }
    setResMenu(null);
  };
  const closeRes = async (id: string) => {
    setResMenu(null);
    resultPaging.cancelPending(id);
    const r = resTabsRef.current.find((x) => x.id === id);
    if (!r) return;
    const list = resTabsRef.current;
    const idx = list.findIndex((x) => x.id === id);
    const remaining = list.filter((x) => x.id !== id);
    setResTabs(remaining);
    setEdTabs((ts) =>
      ts.map((t) => (t.liveResId === id ? { ...t, liveResId: undefined } : t)),
    );
    if (activeResIdRef.current === id) {
      setActiveResId(
        remaining.length ? remaining[Math.max(0, idx - 1)].id : null,
      );
    }
    // closing a profile tab cancels its in-flight profile (fetch + backend)
    if (r.kind === "profile") cancelBgOp(r.profileQueryId);
    // closing a result frees it from server memory and cleans cache
    if (r.kind === "result" && r.resultId) {
      try {
        await api.discardResult(r.resultId);
      } catch {
        /* ignore */
      }
    }
  };
  const setResView = (id: string, view: "grid" | "chart" | "pivot") =>
    patchRes(id, { view });

  const reorderResTabs = (toId: string) => {
    const from = dragRes.current;
    dragRes.current = null;
    if (!from || from === toId) return;
    setResTabs((rs) => moveById(rs, from, toId));
  };
  const reorderEdTabs = (toId: string) => {
    const from = dragTab.current;
    dragTab.current = null;
    if (!from || from === toId) return;
    setEdTabs((ts) => moveById(ts, from, toId));
  };

  // live caret/selection from the editor: the toolbar's Run and
  // Statement buttons act on the SELECTION first, then the real cursor
  const editorCaret = useRef({ start: 0, end: 0 });
  const selectedSql = () => {
    const { start, end } = editorCaret.current;
    return start !== end ? activeTab.sql.slice(start, end) : "";
  };

  const runAll = (sql: string) => runResolved(sql);

  // .459: flash the statement (or selection) that just ran, once.
  const [stmtFlash, setStmtFlash] = useState<{
    start: number;
    end: number;
    kind?: "err";
    tick: number;
  } | null>(null);
  const flashTimer = useRef<number | null>(null);
  // .460: on a file drop, a little chip "falls" toward the sidebar.
  const [dropChip, setDropChip] =
    useState<{ x: number; y: number; name: string; tick: number } | null>(
      null,
    );
  const chipTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (chipTimer.current != null)
        window.clearTimeout(chipTimer.current);
    },
    [],
  );

  const flashRange = (start: number, end: number, kind?: "err") => {
    if (end <= start) return;
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    setStmtFlash({ start, end, kind, tick: Date.now() });
    flashTimer.current = window.setTimeout(() => {
      setStmtFlash(null);
      flashTimer.current = null;
    }, 950);
  };
  useEffect(
    () => () => {
      if (flashTimer.current != null)
        window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const runStatementAt = async (pos: number, previewLimit?: number) => {
    const sql = activeTab.sql;
    try {
      const span = await api.statementAt(sql, pos);
      if (span && span.sql && span.sql.trim()) {
        const hasPos =
          typeof span.start === "number" && typeof span.end === "number";
        if (hasPos) flashRange(span.start, span.end);
        const out = await runResolved(span.sql, false, previewLimit);
        // .460: if that statement FAILED, ping the same span in red.
        if (hasPos && out && out.error)
          flashRange(span.start, span.end, "err");
        return out;
      }
    } catch {
      /* fall back to client-side split below */
    }
    const span = statementAt(sql, pos);
    if (span) {
      flashRange(span.start, span.end);
      const out = await runResolved(
        sql.slice(span.start, span.end), false, previewLimit,
      );
      if (out && out.error) flashRange(span.start, span.end, "err");
    }
  };

  // .462: a selection run flashes its exact range (and pings red on
  // failure), same contract as a statement run.
  const runSelection = async (start: number, end: number) => {
    const sql = activeTab.sql.slice(start, end);
    if (!sql.trim()) return;
    flashRange(start, end);
    const out = await runResolved(sql);
    if (out && out.error) flashRange(start, end, "err");
  };

  // .460: a quick left-to-right shimmer says "cleaned".
  const [fmtShimmer, setFmtShimmer] = useState(0);
  const fmtTimer = useRef<number | null>(null);
  const fireFmtShimmer = () => {
    if (fmtTimer.current != null) window.clearTimeout(fmtTimer.current);
    setFmtShimmer(Date.now());
    fmtTimer.current = window.setTimeout(() => {
      setFmtShimmer(0);
      fmtTimer.current = null;
    }, 750);
  };
  useEffect(
    () => () => {
      if (fmtTimer.current != null) window.clearTimeout(fmtTimer.current);
    },
    [],
  );

  // ---- format ----
  const doFormat = async () => {
    try {
      const res = await api.formatSql(activeTab.sql);
      if (res.ok) {
        setSql(res.result);
        fireFmtShimmer();
        toast("ok", "Formatted");
      } else {
        toast(
          "warn",
          "Formatting unavailable",
          "Install sqlglot on the backend to enable SQL formatting.",
        );
      }
    } catch (e: any) {
      toast("error", "Format failed", e.message);
    }
  };

  // ---- sort (server-side) ----
  // .458: swap the grid to statement i's own result (Run-all ledger).
  const openStmt = async (tabId: string, i: number) => {
    const tab = resTabsRef.current.find((t) => t.id === tabId);
    const ent = tab?.statements?.[i];
    if (!tab || !ent) return;
    if (!ent.result_id) return; // DDL/DML entry: nothing to show
    if (tab.activeStmt === i) return;
    try {
      const pg = await api.page(ent.result_id, { offset: 0 });
      if (pg.error) return;
      setResTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                resultId: ent.result_id ?? null,
                page: { ...pg, result_id: ent.result_id },
                sortCol: null,
                descending: false,
                filters: [],
                activeStmt: i,
              }
            : t,
        ),
      );
    } catch {
      /* expired result: leave the grid as-is */
    }
  };

  const stmtStrip = (tab: ResultTab) => {
    const st = tab.statements;
    if (!st || st.length < 2) return null;
    return (
      <div className="stmt-strip" title="Each statement in this run">
        {st.map((e) => {
          const runnable = !!e.result_id;
          const on = tab.activeStmt === e.index;
          const label = e.error
            ? `S${e.index + 1} ✕`
            : runnable
              ? `S${e.index + 1} · ${(e.total_rows ?? 0).toLocaleString()}`
              : `S${e.index + 1} · ok`;
          return (
            <button
              key={e.index}
              className={
                "stmt-pill" +
                (on ? " on" : "") +
                (e.error ? " err" : "") +
                (runnable ? "" : " mute")
              }
              disabled={!runnable}
              onClick={() => openStmt(tab.id, e.index)}
              title={(e.sql_preview || "") + (e.ms != null ? `\n${e.ms} ms` : "")}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  };

  const doSortFor = async (resId: string | null, col: string) => {
    if (!resId) return;
    await resultPaging.sortBy(resId, col);
  };
  const doSort = (col: string) =>
    void doSortFor(activeResIdRef.current, col);

  // ---- lazy paging + column filtering (shared with Journal) ----------
  const loadMoreRows = (tabId: string) => resultPaging.loadMore(tabId);

  const refetchWithFilters = (id: string, filters: ColumnFilter[]) =>
    resultPaging.applyFilters(id, filters);

  const applyColFilter = (col: string, op: FilterOp, value: string) => {
    setColMenu(null);
    const r = activeResultTab;
    if (!r) return;
    const others = (r.filters || []).filter((f) => f.column !== col);
    const keep = NO_VALUE_OPS.has(op) || value.trim() !== "";
    const next = keep
      ? [
          ...others,
          NO_VALUE_OPS.has(op)
            ? { column: col, op }
            : { column: col, op, value },
        ]
      : others;
    void refetchWithFilters(r.id, next);
  };
  const clearColFilter = (col: string) => {
    setColMenu(null);
    const r = activeResultTab;
    if (!r) return;
    void refetchWithFilters(
      r.id,
      (r.filters || []).filter((f) => f.column !== col),
    );
  };
  const clearAllFilters = () => {
    const r = activeResultTab;
    if (!r) return;
    void resultPaging.clearFilters(r.id);
  };

  // ---- persist session (debounced) ----
  useEffect(() => {
    if (
      sessionPersistenceBlocked ||
      typeof window === "undefined" ||
      !window.localStorage
    ) {
      return;
    }
    const h = setTimeout(() => {
      try {
        window.localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            version: SESSION_VERSION,
            edTabs: edTabs.map((t) => ({
              id: t.id,
              title: t.title,
              sql: t.sql,
            })),
            activeId,
            target,
            readOnly,
            dialect,
            sidebarW,
            showTables,
            showNodeSearch,
            resultsH,
          }),
        );
      } catch {
        toast(
          "warn",
          "Session not saved",
          "Browser storage refused the workspace snapshot (quota or private mode). Your tabs may not survive a reload.",
        );
      }
    }, 500);
    return () => clearTimeout(h);
  }, [edTabs, activeId, target, readOnly, dialect, sidebarW, showTables, showNodeSearch, resultsH, toast]);

  // Ctrl/Cmd+K command palette (global).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.shiftKey) return;
      if (event.key !== "k" && event.key !== "K") return;
      event.preventDefault();
      setCommandPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openToolsTables = useCallback(() => {
    switchView("nodeflow");
    setToolsTablesOpen(true);
  }, [switchView]);

  const commandPaletteCommands = useMemo((): CommandPaletteItem[] => {
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform || "");
    const mod = isMac ? "⌘" : "Ctrl";
    return [
      {
        id: "tools-tables",
        label: "Open Tools & Tables",
        group: "NodeFlow",
        keywords: "palette nodes tables floating",
        hint: view === "nodeflow" ? undefined : "opens NodeFlow",
        run: openToolsTables,
      },
      {
        id: "view-ide",
        label: "Switch to IDE",
        group: "Navigation",
        run: () => switchView("ide"),
      },
      {
        id: "view-journal",
        label: "Switch to Journal",
        group: "Navigation",
        run: () => switchView("notebook"),
      },
      {
        id: "view-nodeflow",
        label: "Switch to NodeFlow",
        group: "Navigation",
        run: () => switchView("nodeflow"),
      },
      {
        id: "view-dashboard",
        label: "Switch to Dashboard",
        group: "Navigation",
        run: () => switchView("dashboard"),
      },
      {
        id: "load-data",
        label: "Load data…",
        group: "Data",
        run: () => setLoadOpen(true),
      },
      {
        id: "refresh-tables",
        label: "Refresh tables",
        group: "Data",
        run: () => {
          void refreshTables();
        },
      },
      {
        id: "toggle-tables",
        label: showTables ? "Hide tables panel" : "Show tables panel",
        group: "View",
        run: () => setShowTables((v) => !v),
      },
      {
        id: "toggle-node-toolbar",
        label: nodeToolbarHidden
          ? "Show node toolbar"
          : "Hide node toolbar",
        group: "View",
        run: () => setNodeToolbarHidden((v) => !v),
      },
      {
        id: "field-explorer",
        label: "Open Field explorer",
        group: "Tools",
        run: () => setFieldExplorerOpen(true),
      },
      {
        id: "activity",
        label: "Open Activity & connections",
        group: "Tools",
        run: () => setActivityOpen(true),
      },
      {
        id: "docs",
        label: "Open Documentation",
        group: "Tools",
        run: () => setJoinGuideOpen(true),
      },
      {
        id: "save",
        label: "Save",
        group: "File",
        hint: `${mod}+S`,
        run: () => activeSave(),
      },
      {
        id: "save-as",
        label: "Save as…",
        group: "File",
        run: () => activeSaveAs(),
      },
      {
        id: "open",
        label: "Open…",
        group: "File",
        run: () => activeOpen(),
      },
      {
        id: "eye-care",
        label: eyeCare ? "Turn Eye Care off" : "Turn Eye Care on",
        group: "View",
        run: () => setEyeCare((v) => !v),
      },
      {
        id: "dense-nodeflow",
        label: nodeFlowDense
          ? "Turn Dense NodeFlow off"
          : "Turn Dense NodeFlow on",
        group: "View",
        run: () =>
          setNodeFlowDense((v) => {
            const next = !v;
            setNodeFlowDenseMode(next);
            return next;
          }),
      },
      {
        id: "settings",
        label: "Open Settings",
        group: "Tools",
        run: () => setSettingsOpen(true),
      },
    ];
  }, [
    activeOpen,
    activeSave,
    activeSaveAs,
    eyeCare,
    nodeFlowDense,
    nodeToolbarHidden,
    openToolsTables,
    refreshTables,
    showTables,
    switchView,
    view,
  ]);

  // ---- export ----
  const doSaveResultAsTable = async () => {
    const r = activeResultTab;
    if (!r || !r.resultId) return;
    const nm = saveTableName.trim();
    if (!nm) return;
    const { queryId, ctrl } = startBgOp();
    try {
      const res = await api.materializeResult(
        r.resultId,
        nm,
        saveTableEngine,
        queryId,
        ctrl.signal,
      );
      if (res.cancelled) return;
      if (res.error || !res.ok) {
        toast("error", "Couldn't save table", res.error || "Failed.");
        return;
      }
      setSaveTableOpen(false);
      setSaveTableName("");
      refreshTables();
      toast(
        "ok",
        "Saved as table",
        `${res.table} — ${(res.rows ?? 0).toLocaleString()} rows in ${res.engine}`,
      );
    } catch (e: any) {
      if (isCancelledError(e)) return;
      toast("error", "Couldn't save table", e.message || String(e));
    } finally {
      endBgOp(queryId);
    }
  };

  // Universal exporter. Result tabs (normal queries AND reconcile drill-down /
  // drill-forward, which are kind "result") go through the backend exporter,
  // which holds the materialized rows by id and can emit every format. Recon +
  // profile tabs have no result_id -- they hold their report / profile object,
  // so we format those client-side (CSV or JSON).
  const exportResultTab = async (
    r: ResultTab | null | undefined,
    fmt: string,
  ) => {
    setOutputOpen(false);
    if (!r) return;
    try {
      if (r.kind === "result") {
        if (!r.resultId) return;
        const exp = await exportResultToFile(r.resultId, fmt, {
          sortCol: r.sortCol,
          descending: r.descending,
        });
        if (exp.cancelled) {
          toast("warn", "Export cancelled", "");
          return;
        }
        toast("ok", "Exported", exp.path || "saved");
        return;
      }
      if (r.kind === "recon" && r.recon && r.reconSpec) {
        const base = reconCsvFilename(r.reconSpec);
        if (fmt === "json") {
          const name = base.replace(/\.csv$/i, ".json");
          const sv = await saveToDownloads(name, {
            text: JSON.stringify(r.recon, null, 2),
          });
          toast("ok", "Exported", sv.path);
        } else {
          const sv = await saveToDownloads(base, {
            text: reconReportCsv(r.recon, r.reconSpec),
          });
          toast("ok", "Exported", sv.path);
        }
        return;
      }
      if (r.kind === "profile" && r.profile) {
        const base = profileCsvFilename(r.profile.table);
        if (fmt === "json") {
          const name = base.replace(/\.csv$/i, ".json");
          const sv = await saveToDownloads(name, {
            text: JSON.stringify(r.profile, null, 2),
          });
          toast("ok", "Exported", sv.path);
        } else {
          const sv = await saveToDownloads(base, {
            text: profileCsv(r.profile),
          });
          toast("ok", "Exported", sv.path);
        }
        return;
      }
    } catch (e: any) {
      toast("error", "Export failed", e.message);
    }
  };
  // A tab is exportable when it has the data its kind needs (so the IDE's
  // Export button lights up for profile + reconcile tabs too, not just queries).
  const canExport = (r: ResultTab | null | undefined) =>
    !!r &&
    (r.kind === "result"
      ? !!r.resultId
      : r.kind === "recon"
        ? !!(r.recon && r.reconSpec)
        : r.kind === "profile"
          ? !!r.profile
          : false);
  // recon + profile are formatted client-side, so only CSV / JSON apply there;
  // result tabs can use every backend format.
  const exportFormatsFor = (
    r: ResultTab | null | undefined,
  ): [string, string][] =>
    r && r.kind === "result"
      ? ([
          ["csv", "CSV"],
          ["tsv", "TSV"],
          ["json", "JSON"],
          ["ndjson", "NDJSON"],
          ...(feats?.openpyxl ? [["xlsx", "Excel (xlsx)"]] : []),
          // Parquet is typed + columnar and opens directly in Tableau and
          // Power BI, so a dedicated option for each isn't needed. Needs
          // pyarrow.
          ...(feats?.pyarrow ? [["parquet", "Parquet"]] : []),
        ] as [string, string][])
      : ([
          ["csv", "CSV"],
          ["json", "JSON"],
        ] as [string, string][]);
  const doExport = (fmt: string) => exportResultTab(activeRes, fmt);

  // ---- table ops ----
  const onProfile = async (table: string, engine: EngineKind) => {
    // reuse an existing profile tab for the same table, else open one
    const existing = resTabsRef.current.find(
      (r) => r.kind === "profile" && r.profileTable === table,
    );
    let id: string;
    if (existing) {
      id = existing.id;
      // a re-profile of the same tab supersedes any in-flight one
      cancelBgOp(existing.profileQueryId);
      setResTabs((rs) =>
        rs.map((r) =>
          r.id === id
            ? { ...r, profileLoading: true, profileEngine: engine }
            : r,
        ),
      );
    } else {
      id = uid();
      setResTabs((rs) => [
        ...rs,
        {
          id,
          kind: "profile",
          title: table,
          profileTable: table,
          profileEngine: engine,
          profileLoading: true,
          profile: null,
        },
      ]);
    }
    setActiveResId(id);
    const { queryId, ctrl } = startBgOp();
    setResTabs((rs) =>
      rs.map((r) => (r.id === id ? { ...r, profileQueryId: queryId } : r)),
    );
    try {
      const p = await api.profile(table, engine, queryId, ctrl.signal);
      if (p.cancelled) {
        setResTabs((rs) =>
          rs.map((r) =>
            r.id === id
              ? { ...r, profileLoading: false, profileQueryId: undefined }
              : r,
          ),
        );
        return;
      }
      setResTabs((rs) =>
        rs.map((r) =>
          r.id === id
            ? { ...r, profile: p, profileLoading: false, profileQueryId: undefined }
            : r,
        ),
      );
    } catch (e: any) {
      if (isCancelledError(e)) {
        setResTabs((rs) =>
          rs.map((r) =>
            r.id === id
              ? { ...r, profileLoading: false, profileQueryId: undefined }
              : r,
          ),
        );
        return;
      }
      toast("error", "Profile failed", e.message);
      setResTabs((rs) =>
        rs.map((r) => (r.id === id ? { ...r, profileLoading: false } : r)),
      );
    } finally {
      endBgOp(queryId);
    }
  };

  // Profile a single field of the active result (right-click a column header →
  // Profile field). Mirrors onProfile but targets one column via the result.
  const onProfileField = async (column: string) => {
    const rt = resTabsRef.current.find((r) => r.id === activeResId);
    if (!rt || rt.kind !== "result") return;
    const engine = (rt.page?.engine || "sqlite") as EngineKind;
    const id = uid();
    setResTabs((rs) => [
      ...rs,
      {
        id,
        kind: "profile",
        title: `${column} · field`,
        profileTable: column,
        profileEngine: engine,
        profileLoading: true,
        profile: null,
      },
    ]);
    setActiveResId(id);
    const { queryId, ctrl } = startBgOp();
    setResTabs((rs) =>
      rs.map((r) => (r.id === id ? { ...r, profileQueryId: queryId } : r)),
    );
    try {
      const p = await api.profileField(
        {
          result_id: rt.resultId,
          engine,
          column,
        },
        queryId,
        ctrl.signal,
      );
      if (p.cancelled) {
        setResTabs((rs) =>
          rs.map((r) =>
            r.id === id
              ? { ...r, profileLoading: false, profileQueryId: undefined }
              : r,
          ),
        );
        return;
      }
      setResTabs((rs) =>
        rs.map((r) =>
          r.id === id
            ? { ...r, profile: p, profileLoading: false, profileQueryId: undefined }
            : r,
        ),
      );
    } catch (e: any) {
      if (isCancelledError(e)) {
        setResTabs((rs) =>
          rs.map((r) =>
            r.id === id
              ? { ...r, profileLoading: false, profileQueryId: undefined }
              : r,
          ),
        );
        return;
      }
      toast("error", "Profile failed", e.message);
      setResTabs((rs) =>
        rs.map((r) => (r.id === id ? { ...r, profileLoading: false } : r)),
      );
    } finally {
      endBgOp(queryId);
    }
  };

  // Shred a nested JSON column into its relational family, launched from the
  // Field Explorer. Runs the same memory-lean pipeline as the load-time
  // flatten, tracked as a cancellable background op (Stop it from the activity
  // panel), and refreshes the table list on success. Steers users off the
  // OOM-prone full-column UNNEST for large nested data.
  const onShredColumn = async (
    engine: string,
    table: string,
    column: string,
    shredTables: string[],
  ): Promise<{
    ok?: boolean;
    error?: string;
    created?: number;
    cancelled?: boolean;
  }> => {
    const { queryId } = startBgOp();
    toast(
      "ok",
      `Shredding ${column}`,
      "Building relational tables — tracking in the activity panel.",
    );
    try {
      const r = await api.shredRun(
        engine,
        table,
        column,
        shredTables,
        undefined,
        queryId,
      );
      if (r.cancelled) {
        toast("warn", "Shred cancelled", column);
        return { cancelled: true };
      }
      if (r.error) {
        toast("error", "Shred failed", r.error);
        return { error: r.error };
      }
      const n = (r.created || []).length;
      toast(
        "ok",
        "Shredded to tables",
        `${n} table${n === 1 ? "" : "s"} created from ${column}.`,
      );
      refreshTables();
      return { ok: true, created: n };
    } catch (e: any) {
      if (isCancelledError(e)) {
        toast("warn", "Shred cancelled", column);
        return { cancelled: true };
      }
      toast("error", "Shred failed", e?.message || String(e));
      return { error: e?.message || String(e) };
    } finally {
      endBgOp(queryId);
    }
  };

  // Flatten a nested JSON table into its relational family from the Field
  // Explorer. Runs as a background JOB (flatten-start) so the HTTP request
  // returns immediately — the old synchronous /flatten held the connection
  // for the whole CTAS and the UI looked stalled. Poll loadProgress; Stop
  // cancels via loadCancel + query interrupt.
  const onFlattenColumn = async (
    engine: string,
    table: string,
    rootId?: RootIdChoice | null,
    column?: string | null,
    path?: string | null,
  ): Promise<{
    ok?: boolean;
    error?: string;
    created?: number;
    cancelled?: boolean;
  }> => {
    const { queryId, ctrl } = startBgOp();
    const nestLabel = path || column || table;
    toast(
      "ok",
      `Flattening ${nestLabel}`,
      rootId?.label
        ? `Building relational tables with unique id ${rootId.label} — source table kept.`
        : "Building relational tables for this nest — source table kept.",
    );
    let jobId: string | null = null;
    try {
      const started = await api.flattenTableStart(
        engine,
        table,
        rootId,
        column,
        path,
      );
      jobId = started.job_id;
      // Prefer cancelling the job when Stop is pressed (Abort alone only
      // stops our poll loop; the engine work keeps going otherwise).
      const onAbort = () => {
        if (jobId) api.loadCancel(jobId).catch(() => {});
      };
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          if (ctrl.signal.aborted) {
            toast("warn", "Flatten cancelled", table);
            return { cancelled: true };
          }
          const p = await api.loadProgress(jobId);
          if (p.state === "done") {
            const n = (p.loaded || []).length;
            toast(
              "ok",
              "Flattened to tables",
              `${n} table${n === 1 ? "" : "s"} created from ${nestLabel}; ${table} kept.`,
            );
            refreshTables();
            return { ok: true, created: n };
          }
          if (p.state === "cancelled") {
            toast("warn", "Flatten cancelled", nestLabel);
            return { cancelled: true };
          }
          if (p.state === "error") {
            const err = p.error || "Flatten failed";
            toast("error", "Flatten failed", err);
            return { error: err };
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      } finally {
        ctrl.signal.removeEventListener("abort", onAbort);
      }
    } catch (e: any) {
      if (isCancelledError(e) || ctrl.signal.aborted) {
        if (jobId) api.loadCancel(jobId).catch(() => {});
        toast("warn", "Flatten cancelled", table);
        return { cancelled: true };
      }
      toast("error", "Flatten failed", e?.message || String(e));
      return { error: e?.message || String(e) };
    } finally {
      endBgOp(queryId);
    }
  };

  // Reconcile: a run drops a pinned "recon" result tab holding the report.
  const onRunReconcile = (report: ReconcileResult, spec: ReconSpec) => {
    const id = uid();
    setResTabs((rs) => [
      ...rs,
      {
        id,
        kind: "recon",
        title: `Recon: ${spec.left} vs ${spec.right}`,
        recon: report,
        reconSpec: spec,
        pinned: true,
      },
    ]);
    setActiveResId(id);
    setReconcileOpen(false);
  };

  const { reconDrill, reconProfile } = useMemo(
    () =>
      createReconDetailController({
        toast,
        setResTabs: setResTabs as any,
        setActiveResId,
        patchRes: patchRes as any,
        pageLimit: LAZY_CHUNK,
      }),
    [toast, setResTabs, setActiveResId, patchRes],
  );

  // re-run a specific result tab's query and refresh its rows in place
  const rerunResultTab = async (id: string): Promise<string | null> => {
    const r = resTabsRef.current.find((x) => x.id === id);
    if (!r || r.kind !== "result" || !r.sql) return null;
    const oldRid = r.resultId;
    // Same Run/Stop machinery as the main path: supersede any in-flight query
    // (abort the fetch + interrupt the backend) and run this re-run with a
    // query_id + signal so it's trackable and cancellable too -- otherwise a
    // slow re-run would have no Stop and keep burning CPU after a new launch.
    const key = "res:" + id;
    const prev = runsNow()[key];
    if (prev) cancelOne(prev.queryId, prev.ctrl);
    const ctrl = new AbortController();
    const queryId = uid() + uid();
    setRuns((m) => ({
      ...m,
      [key]: { ctrl, queryId, startedAt: Date.now() },
    }));
    let freshResultId: string | null = null;
    try {
      const res = await api.query(
        r.sql, target, readOnly, queryId, ctrl.signal,
        undefined, undefined,
        // .458: a tab that carried a statement ledger refetches WITH one,
        // so its pills never point at discarded results.
        r.statements ? { per_statement: true } : undefined,
      );
      if (!res.error && res.result_id != null) {
        freshResultId = res.result_id;
        setResTabs((prev) =>
          prev.map((x) =>
            x.id === id
              ? {
                  ...x,
                  resultId: res.result_id ?? null,
                  queryId,
                  page: res,
                  sortCol: null,
                  descending: false,
                  filters: [],
                  allColumns: res.columns || [],
                  visibleColumns: null,
                  statements:
                    (res.statements?.length ?? 0) > 1
                      ? res.statements
                      : undefined,
                  activeStmt: res.statements?.find(
                    (e) => e.result_id === res.result_id,
                  )?.index,
                }
              : x,
          ),
        );
        if (oldRid && oldRid !== res.result_id) {
          try {
            await api.discardResult(oldRid);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore refresh errors (incl. abort when superseded) */
    } finally {
      endRun(key, ctrl);
    }
    return freshResultId;
  };
  rerunExpiredResultRef.current = (id) => rerunResultTab(id);

  // change a loaded column's type from the grid, then auto-refresh + persist
  const changeColType = async (
    engine: EngineKind,
    table: string,
    col: string,
    newType: string,
  ) => {
    setColMenu(null);
    const { queryId, ctrl } = startBgOp();
    try {
      const r = await api.changeType(
        engine,
        table,
        col,
        newType,
        queryId,
        ctrl.signal,
      );
      if (r.cancelled) return;
      if ((r as any).error || (r as any).ok === false) {
        toast(
          "error",
          "Change type failed",
          (r as any).error ||
            `Couldn't convert "${col}" to ${newType}. Some values may not fit.`,
        );
        return;
      }
      toast("ok", "Type changed", `${col} → ${newType}`);
      await refreshTables();
      const act = activeResIdRef.current;
      if (act) await rerunResultTab(act);
    } catch (e: any) {
      if (isCancelledError(e)) return;
      toast("error", "Change type failed", e.message);
    } finally {
      endBgOp(queryId);
    }
  };

  const onRename = async (engine: EngineKind, oldName: string) => {
    const next = window.prompt(`Rename "${oldName}" to:`, oldName);
    if (!next || next === oldName) return;
    try {
      const r = await api.renameTable(engine, oldName, next);
      if ((r as any).error) toast("error", "Rename failed", (r as any).error);
      else {
        toast("ok", "Renamed", `${oldName} → ${next}`);
        refreshTables();
      }
    } catch (e: any) {
      toast("error", "Rename failed", e.message);
    }
  };

  const onDrop = async (engine: EngineKind, name: string) => {
    askConfirm(
      { left: 268, top: 150, side: "right" as const },
      `Drop table "${name}"? This cannot be undone.`,
      () => reallyDrop(engine, name),
      "Drop",
    );
  };
  const reallyDrop = async (engine: EngineKind, name: string) => {
    try {
      await api.dropTable(engine, name);
      toast("ok", "Dropped", name);
      // close any profile tab for the dropped table
      setResTabs((rs) =>
        rs.filter((r) => !(r.kind === "profile" && r.profileTable === name)),
      );
      refreshTables();
    } catch (e: any) {
      toast("error", "Drop failed", e.message);
    }
  };

  // Drop several selected tables at once (multi-select in the sidebar).
  const onDropMany = async (
    items: { engine: EngineKind; name: string }[],
  ) => {
    if (!items.length) return;
    const allLocal = tables
      .filter((t) => !t.remote)
      .map((t) => ({ engine: t.engine, name: t.name }));
    askConfirm(
      { left: 268, top: 150, side: "right" as const },
      dropManyConfirmMessage(items, allLocal),
      () => reallyDropMany(items),
      "Drop",
    );
  };
  const reallyDropMany = async (
    items: { engine: EngineKind; name: string }[],
  ) => {
    let ok = 0;
    const failed: string[] = [];
    for (const it of items) {
      try {
        await api.dropTable(it.engine, it.name);
        ok++;
      } catch {
        failed.push(it.name);
      }
    }
    const dropped = new Set(items.map((i) => i.name));
    setResTabs((rs) =>
      rs.filter(
        (r) => !(r.kind === "profile" && dropped.has(r.profileTable || "")),
      ),
    );
    refreshTables();
    if (failed.length) {
      toast("error", "Some drops failed", `${ok} dropped · failed: ${failed.join(", ")}`);
    } else {
      toast("ok", "Tables dropped", `${ok} dropped`);
    }
  };


  const onImport = async (name: string) => {
    toast("ok", "Importing", `${name} — pulling from SQL Server…`);
    try {
      const r = await api.catalogImport(name);
      if (r.error) {
        toast("error", "Import failed", r.error);
        return;
      }
      toast(
        "ok",
        "Imported",
        `${name} → ${r.table} (${r.engine})`,
      );
      refreshTables();
    } catch (e: any) {
      toast("error", "Import failed", e.message);
    }
  };

  const onDeleteSaved = async (name: string) => {
    try {
      await api.deleteSaved(name);
      refreshSaved();
    } catch (e: any) {
      toast("error", "Delete failed", e.message);
    }
  };

  const onClearHistory = async () => {
    try {
      await api.clearHistory();
      refreshHistory();
    } catch {}
  };

  const onClearAll = async () => {
    askConfirm(
      { left: 268, top: 150, side: "right" as const },
      "Remove all loaded tables and cached results?",
      () => reallyClearAll(),
      "Remove",
    );
  };
  const reallyClearAll = async () => {
    try {
      await api.clearAll();
      setTables([]);
      setResTabs([]);
      setActiveResId(null);
      setEdTabs((ts) => ts.map((t) => ({ ...t, liveResId: undefined })));
      setQueryError(null);
      setConflict(null);
      setOkMessage(null);
      toast("ok", "Workspace cleared");
    } catch (e: any) {
      toast("error", "Clear failed", e.message);
    }
  };

  // ---- save query ----
  const saveQuery = async (name: string, tags: string[]) => {
    try {
      await api.saveQuery(name, activeTab.sql, tags);
      setSaveOpen(false);
      refreshSaved();
      toast("ok", "Saved", name);
    } catch (e: any) {
      toast("error", "Save failed", e.message);
    }
  };

  // ---- resizers ----
  const dragSidebar = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: PointerEvent) =>
      setSidebarW(Math.max(180, Math.min(560, startW + ev.clientX - startX)));
    startPointerDrag({ onMove: move });
  };
  const dragResults = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = resultsH;
    const move = (ev: PointerEvent) =>
      setResultsH(
        Math.max(120, Math.min(window.innerHeight - 220, startH + (startY - ev.clientY))),
      );
    startPointerDrag({ onMove: move });
  };

  const feats = health?.features;

  // a DataGrid bound to a specific result id (used by the compare split, where
  // each side sorts/pages independently).
  const renderGridForRes = (resId: string) => {
    const r = resTabs.find((x) => x.id === resId && x.kind === "result");
    if (!r || !r.page)
      return (
        <div className="empty">
          <div className="inner">
            <p>No rows.</p>
          </div>
        </div>
      );
    return (
      <DataGrid
        page={r.page}
        sortCol={r.sortCol ?? null}
        descending={!!r.descending}
        onSort={(col) => doSortFor(r.id, col)}
        onLoadMore={() => loadMoreRows(r.id)}
        hasMore={(r.page.rows?.length ?? 0) < (r.page.total_rows ?? 0)}
        loadingMore={!!r.loadingMore}
        onExportResults={(fmt) => exportResultTab(r, fmt)}
        cellFetch={{ resultId: r.page.result_id ?? null, filters: (r as any).filters }}
      />
    );
  };
  const floatPlaceholder = (label: string) => (
    <div className="float-placeholder">
      <Icon.PopOut size={22} className="faint" />
      <p>{label} is open in a floating window.</p>
      <p className="hint">
        Drag the window back over this pane — or click its dock button — to snap
        it back.
      </p>
    </div>
  );

  return (
    <div
      className="app"
      data-testid="samql-app"
      data-ready={health ? "true" : "false"}
    >
      {/* .545: server-down banner (overnight sleep / IT policy reaping
          the backend) -- explains itself and offers Reconnect instead
          of leaving a dead window */}
      <ServerWatchdog />
      {/* ---------- top bar ---------- */}
      <div className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Sam<span className="ql">QL</span></span>
          {/* .538: the version moved to Settings -> About */}
        </div>
        <div className="view-toggle" title="Switch between the IDE editor, Journal, and NodeFlow views (Dashboard too)">
          <button
            className={"vt-seg" + (view === "ide" ? " on" : "")}
            data-testid="view-ide"
            onClick={() => switchView("ide")}
          >
            IDE
          </button>
          <button
            className={"vt-seg" + (view === "notebook" ? " on" : "")}
            data-testid="view-journal"
            onClick={() => switchView("notebook")}
          >
            Journal
          </button>
          <button
            className={"vt-seg" + (view === "nodeflow" ? " on" : "")}
            data-testid="view-nodeflow"
            onClick={() => switchView("nodeflow")}
          >
            NodeFlow
          </button>
          <button
            className={"vt-seg" + (view === "dashboard" ? " on" : "")}
            data-testid="view-dashboard"
            onClick={() => switchView("dashboard")}
          >
            Dashboard
          </button>
        </div>
        <div className="settings-wrap">
          <button
            className="btn ghost"
            data-testid="settings-button"
            onClick={() => setSettingsOpen((v) => !v)}
            title="Settings & tools"
          >
            <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
              ⚙
            </span>{" "}
            Settings
          </button>
          {settingsOpen && (
            <>
              <div
                className="rc-backdrop"
                onMouseDown={() => setSettingsOpen(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSettingsOpen(false);
                }}
              />
              <div
                className="ctx-menu settings-menu"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="label">View</div>
                <button
                  onClick={() => {
                    setShowTables((v) => !v);
                    setSettingsOpen(false);
                  }}
                >
                  {showTables ? "Hide tables panel" : "Show tables panel"}
                </button>
                <button
                  onClick={() => {
                    setShowNodeSearch((v) => !v);
                    setSettingsOpen(false);
                  }}
                >
                  {showNodeSearch
                    ? "Hide node search bar"
                    : "Show node search bar"}
                </button>
                <button
                  disabled={view !== "nodeflow"}
                  title={
                    view === "nodeflow"
                      ? "Floating tables list and node palette"
                      : "Available only in NodeFlow"
                  }
                  onClick={() => {
                    setToolsTablesOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Tools &amp; Tables…
                </button>
                <button
                  onClick={() => {
                    setNodeToolbarHidden((v) => !v);
                    setSettingsOpen(false);
                  }}
                >
                  {nodeToolbarHidden
                    ? "Show node toolbar"
                    : "Hide node toolbar"}
                </button>
                <button
                  onClick={() => {
                    // one switch for the whole app: light = ivory canvas +
                    // ivory editor; dark = both dark. Flip them together.
                    const goLight = !(ivoryCanvas && ivoryEditor);
                    setIvoryCanvas(goLight);
                    setIvoryEditor(goLight);
                    setSettingsOpen(false);
                  }}
                >
                  {ivoryCanvas && ivoryEditor
                    ? "Toggle Dark Mode"
                    : "Toggle Light Mode"}
                </button>
                <button
                  onClick={() => {
                    setReduceMotion((v) => !v);
                    setSettingsOpen(false);
                  }}
                >
                  {reduceMotion ? "Enable animations" : "Reduce motion"}
                </button>
                <button
                  data-testid="eye-care-toggle"
                  aria-pressed={eyeCare}
                  title="Enlarge text, buttons, nodes, and panels for easier reading"
                  onClick={() => setEyeCare((v) => !v)}
                >
                  {eyeCare ? "Eye Care: on" : "Eye Care"}
                </button>
                <button
                  data-testid="nodeflow-dense-toggle"
                  aria-pressed={nodeFlowDense}
                  title="Shrink NodeFlow node geometry so more of the graph fits on screen (works with Eye Care)"
                  onClick={() =>
                    setNodeFlowDense((v) => {
                      const next = !v;
                      setNodeFlowDenseMode(next);
                      return next;
                    })
                  }
                >
                  {nodeFlowDense ? "Dense NodeFlow: on" : "Dense NodeFlow"}
                </button>
                <div className="sep" />
                <div className="label">Engine</div>
                <button
                  disabled={!health?.features?.duckdb}
                  title={
                    health?.features?.duckdb
                      ? "Adjust DuckDB's memory limit and thread count live (this session)"
                      : "Requires the DuckDB engine"
                  }
                  onClick={async () => {
                    setSettingsOpen(false);
                    try {
                      const cur = await api.engineTuning({});
                      if (cur.busy || cur.error) {
                        toast("warn", "Engine tuning", cur.error);
                        return;
                      }
                      const mem = window.prompt(
                        "DuckDB memory limit (GB):",
                        String(parseFloat(cur.memory_limit || "") || ""),
                      );
                      if (mem === null) return;
                      const th = window.prompt(
                        "DuckDB threads:",
                        String(cur.threads ?? ""),
                      );
                      if (th === null) return;
                      const r = await api.engineTuning({
                        memory_gb: parseFloat(mem) || undefined,
                        threads: parseInt(th, 10) || undefined,
                      });
                      if (r.error) toast("error", "Engine tuning failed", r.error);
                      else
                        toast(
                          "ok",
                          "Engine tuned",
                          `memory_limit ${r.memory_limit} · ${r.threads} threads (this session; SAMQL_DUCKDB_MEMORY_GB persists)`,
                        );
                    } catch (e: any) {
                      toast("error", "Engine tuning failed", e?.message);
                    }
                  }}
                >
                  Engine tuning (memory / threads)…
                </button>
                {createdNodesUi.menu(() => setSettingsOpen(false))}
                {dashboardUi.menu(() => setSettingsOpen(false))}
                <div className="sep" />
                <div className="label">Workflow</div>
                <button
                  onClick={() => {
                    setSettingsOpen(false);
                    activeSave();
                  }}
                >
                  <Icon.Save size={13} /> Save
                </button>
                <button
                  onClick={() => {
                    setSettingsOpen(false);
                    activeSaveAs();
                  }}
                >
                  Save As…
                </button>
                <button
                  onClick={() => {
                    setSettingsOpen(false);
                    activeOpen();
                  }}
                >
                  <Icon.Folder size={13} /> Open…
                </button>
                <div className="sep" />
                <div className="label">Data</div>
                <button
                  data-testid="load-data-menu"
                  onClick={() => {
                    setLoadOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Load data…
                </button>
                <button
                  onClick={() => {
                    setFieldExplorerOpen(true);
                    setSettingsOpen(false);
                  }}
                  title="Floating panel: pick a JSON source, click a field, get the query to access it"
                >
                  <Icon.ListTree size={13} /> Field explorer…
                </button>
                <button
                  disabled={!canExport(activeRes)}
                  onClick={() => {
                    setSettingsOpen(false);
                    void doExport("csv");
                  }}
                >
                  <Icon.Download size={13} /> Export results (CSV)
                </button>
                <button
                  disabled={!canExport(activeRes)}
                  onClick={() => {
                    setSettingsOpen(false);
                    void doExport("json");
                  }}
                >
                  <Icon.Download size={13} /> Export results (JSON)
                </button>
                {view === "nodeflow" ? (
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      setNodeCmd({ id: Date.now(), action: "exportLineage" });
                    }}
                  >
                    <Icon.Download size={13} /> Export data lineage (Excel)
                  </button>
                ) : null}
                {view === "notebook" && (
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      setJournalCmd({ id: Date.now(), action: "exportGraph" });
                    }}
                    title="Export every cell with its SQL and what it uses / feeds"
                  >
                    <Icon.Download size={13} /> Export journal (CSV)
                  </button>
                )}
                <div className="sep" />
                <div className="label">Tools</div>
                <button
                  disabled={tables.length < 2}
                  onClick={() => {
                    setReconcileInitial(undefined);
                    setReconcileOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Reconcile tables…
                </button>
                <button
                  title="Joins, Journal, JSON querying, NodeFlow (every node explained), and a live list of every SQL function both engines expose."
                  onClick={() => {
                    setJoinGuideOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Documentation…
                </button>
                <button
                  onClick={() => {
                    switchView("notebook");
                    setSettingsOpen(false);
                  }}
                >
                  Open Journal
                </button>
                <button
                  onClick={() => {
                    switchView("nodeflow");
                    setSettingsOpen(false);
                  }}
                >
                  Open NodeFlow
                </button>
                <div className="sep" />
                <div className="label">Maintenance</div>
                <button
                  onClick={() => {
                    setActivityOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Activity &amp; connections…
                </button>
                <button
                  onClick={() => {
                    setErrorLogOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Error log…
                </button>
                <button
                  onClick={() => {
                    setAboutOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  About SamQL…
                </button>
                <button
                  onClick={() => {
                    setDiagOpen(true);
                    setSettingsOpen(false);
                  }}
                >
                  Diagnostics…
                </button>
                <button
                  data-testid="storage-memory-menu"
                  onClick={() => void openStorage()}
                >
                  Storage &amp; memory…
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setSettingsOpen(false);
                    void onClearAll();
                  }}
                >
                  Clear workspace…
                </button>
              </div>
            </>
          )}
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            setReconcileInitial(undefined);
            setReconcileOpen(true);
          }}
          disabled={tables.length < 2}
          title={
            tables.length < 2
              ? "Load at least two tables to reconcile"
              : "Reconcile two tables"
          }
        >
          <Icon.Compare size={15} /> Reconcile
        </button>
        <span className="spacer" />
        <StatIndicator onOpenActivity={() => setActivityOpen(true)} />
        <TaskWatcher onComplete={onTaskComplete} />
        <button
          className="btn ghost"
          onClick={() => setExitOpen(true)}
          title="Exit SamQL"
        >
          <Icon.Power size={15} /> Exit
        </button>
      </div>

      {/* ---------- body ---------- */}
      <div className="body">
        <div
          className="sidebar"
          style={showTables ? { width: sidebarW } : { display: "none" }}
        >
          {((view === "nodeflow" && showTables && nbSel) ||
            (view === "dashboard" && showTables && dashSel)) ? (
            // config panel takes over this slot; portals into this host
            <div
              className="nb-inspector-host"
              ref={view === "dashboard" ? setDashHostEl : setNbHostEl}
            />
          ) : (
            <Sidebar
            onTableProps={(engine, name) => setTableProps({ engine, name })}
              tables={tables}
              history={history}
              saved={saved}
              workflows={workflows}
              onInsertTable={insertText}
              onInsertColumn={insertText}
              onLoadSql={(sql) => {
                loadSqlIntoEditor(sql);
                switchView("ide");
              }}
              onProfile={onProfile}
              onReconcile={(name) => openReconcileWith(name)}
              onChangeType={changeColType}
              onRename={onRename}
              onDrop={onDrop}
              onDropMany={onDropMany}
              onOptimize={beginOptimize}
              onImport={onImport}
              onDisconnect={onDisconnect}
              onDeleteSaved={onDeleteSaved}
              onLoadWorkflow={onLoadWorkflow}
              onDeleteWorkflow={onDeleteWorkflow}
              onActiveSave={activeSave}
              onActiveSaveAs={activeSaveAs}
              onActiveOpen={activeOpen}
              activeView={view}
              onRefresh={refreshTables}
              onClearHistory={onClearHistory}
              onOpenLoad={() => setLoadOpen(true)}
            />
          )}
        </div>
        {showTables && (
          <div className="gutter-v" onPointerDown={dragSidebar} />
        )}
        {!showTables && (
          <button
            className="tables-reopen"
            title="Show tables panel"
            onClick={() => setShowTables(true)}
          >
            <Icon.Chevron size={14} />
          </button>
        )}

        <div className="main">
          {/* Journal stays MOUNTED across view switches (display:none, not an
              unmount) so a running query — and its result — survives switching
              to another tab and is still there when you come back. */}
          <div style={{ display: view === "notebook" ? "contents" : "none" }}>
            <Notebook
              appVersion={health?.version}
              appBuild={(health as any)?.build}
              tables={tables}
              target={target}
              onTargetChange={setTarget}
              dialect={dialect}
              onDialectChange={setDialect}
              onToast={toast}
              onTablesMaybeChanged={refreshTables}
              loadRequest={journalLoad}
              onLoadConsumed={() => setJournalLoad(null)}
              onWorkflowsChanged={refreshWorkflows}
              command={journalCmd}
              features={feats || null}
            />
          </div>
          <FieldExplorer
            open={fieldExplorerOpen}
            onClose={() => setFieldExplorerOpen(false)}
            tables={tables}
            onToast={toast}
            onTablesChanged={refreshTables}
            onShred={onShredColumn}
            onFlatten={onFlattenColumn}
          />
          <CommandPalette
            open={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            commands={commandPaletteCommands}
          />
          {view === "nodeflow" ? (
            <Suspense
              fallback={
                <div className="view-loading">Loading NodeFlow…</div>
              }
            >
              <NodeFlow tables={tables} onToast={toast} features={feats || null} onTablesChanged={refreshTables} showTables={showTables} inspectorHost={nbHostEl} onSelectionChange={setNbSel} showNodeSearch={showNodeSearch} loadRequest={nodeLoad} onLoadConsumed={() => setNodeLoad(null)} onWorkflowsChanged={refreshWorkflows} command={nodeCmd} paletteHidden={nodeToolbarHidden} onTogglePalette={() => setNodeToolbarHidden((v) => !v)} toolsTablesOpen={toolsTablesOpen} onToolsTablesOpenChange={setToolsTablesOpen} onOpenLoad={() => setLoadOpen(true)} denseMode={nodeFlowDense} />
            </Suspense>
          ) : view === "dashboard" ? (
            <Suspense
              fallback={
                <div className="view-loading">Loading Dashboard…</div>
              }
            >
              <Dashboard
                key={dashReloadKey}
                onToast={toast}
                command={dashboardCmd}
                onCommandConsumed={() => setDashboardCmd(null)}
                loadRequest={dashboardLoad}
                onLoadConsumed={() => setDashboardLoad(null)}
                onWorkflowsChanged={refreshWorkflows}
                inspectorHost={dashHostEl}
                onSelectionChange={setDashSel}
              />
            </Suspense>
          ) : view === "ide" ? (
            <>
              {/* editor tabs */}
              <div className="tabs ed-tabs" ref={tabsRef}>
            {edTabs.map((t) => (
              <div
                key={t.id}
                className={"tab" + (t.id === activeId ? " active" : "")}
                draggable
                onDragStart={() => {
                  dragTab.current = t.id;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  reorderEdTabs(t.id);
                }}
                onClick={() => setActiveId(t.id)}
              >
                <Icon.Grid size={13} />
                {renamingTab?.id === t.id ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    value={renamingTab.draft}
                    onChange={(e) =>
                      setRenamingTab({ id: t.id, draft: e.target.value })
                    }
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenamingTab(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingTab({ id: t.id, draft: t.title });
                    }}
                    title="Double-click to rename"
                  >
                    {t.title}
                  </span>
                )}
                {runsNow()[t.id] ? (
                  <span className="tab-pulse" title="Running" />
                ) : null}
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id, e.currentTarget as HTMLElement);
                  }}
                >
                  <Icon.X size={12} />
                </span>
              </div>
            ))}
            <button
              className="btn ghost icon"
              title="New query tab"
              onClick={newTab}
              style={{ margin: "auto 6px" }}
            >
              <Icon.Plus size={16} />
            </button>
            <div
              className="tab-underline"
              style={{
                transform: `translateX(${tabUl.left}px)`,
                width: tabUl.width,
              }}
            />
          </div>

          {/* toolbar */}
          <div className="toolbar">
            {running ? (
              <button
                className="btn sm danger"
                data-testid="stop-query"
                onClick={cancelRunning}
                title="Stop the running query"
              >
                <Icon.Square size={14} /> Stop
              </button>
            ) : (
              <button
                className={"btn primary sm" + (runFlash ? " flash-ok" : "")}
                data-testid="run-query"
                onClick={() => {
                  const sel = selectedSql();
                  void runAll(sel.trim() ? sel : activeTab.sql);
                }}
                title="Run all / selection (Ctrl/Cmd+Enter)"
              >
                <Icon.Play size={14} /> Run
              </button>
            )}
            <button
              className="btn sm"
              disabled={running}
              onClick={() => {
                const sel = selectedSql();
                if (sel.trim()) {
                  void runAll(sel);
                  return;
                }
                // the REAL cursor -- a caret in the gap after a
                // semicolon runs the statement just finished
                void runStatementAt(editorCaret.current.start);
              }}
              title="Run the highlighted selection, or the statement at the cursor (F5)"
            >
              <Icon.Step size={14} /> Statement
            </button>
            <button
              className="btn sm"
              disabled={running}
              onClick={() => {
                const sel = selectedSql();
                if (sel.trim()) {
                  void runResolved(sel, false, 5000);
                  return;
                }
                void runStatementAt(editorCaret.current.start, 5000);
              }}
              title="Preview up to 5,000 rows without materializing the full result"
            >
              <Icon.Eye size={14} /> Preview
            </button>
            <button className="btn sm" onClick={doFormat} title="Format SQL">
              <Icon.Format size={14} /> Format
            </button>
            {running && (
              <div
                className="run-progress"
                title={
                  runProg.value != null
                    ? Math.round(runProg.value * 100) +
                      "% complete — click Stop to cancel"
                    : "Query running… click Stop to cancel"
                }
              >
                <ProgressBar
                  value={runProg.value}
                  rows={runProg.rows}
                  unit={runProg.unit}
                  done={runProg.done}
                  total={runProg.total}
                />
                <span className="run-elapsed">
                  <RunTimer
                    startedAt={
                      runs[activeTab?.id ?? ""]?.startedAt ?? Date.now()
                    }
                  />
                </span>
              </div>
            )}
            <div className="sep" />
            <label className="dim" style={{ fontSize: 12 }}>
              Engine
            </label>
            <select
              data-testid="ide-engine"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              style={{ padding: "5px 8px" }}
            >
              <option value="auto">Auto-route</option>
              <option value="__local__">SQLite</option>
              <option value="__duckdb__" disabled={!feats?.duckdb}>
                DuckDB{feats?.duckdb ? "" : " (n/a)"}
              </option>
            </select>
            <label className="dim" style={{ fontSize: 12 }}>
              Dialect
            </label>
            <select
              value={dialect}
              onChange={(e) => setDialect(e.target.value)}
              style={{ padding: "5px 8px" }}
              title="Input SQL dialect. Spark SQL is translated to the engine's dialect before running (needs sqlglot); unsupported constructs are reported, not run."
            >
              <option value="native">Native SQL</option>
              <option value="spark">Spark SQL</option>
            </select>
            <label className="toggle">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              Read-only
            </label>
            <span className="spacer" />
            <button
              className="btn sm"
              disabled={!canUndoIde}
              onClick={undoIde}
              title="Undo edit (Ctrl+Z)"
            >
              <Icon.Undo size={14} />
            </button>
            <button
              className="btn sm"
              disabled={!canRedoIde}
              onClick={redoIde}
              title="Redo edit (Ctrl+Shift+Z)"
            >
              <Icon.Redo size={14} />
            </button>
            <div style={{ position: "relative" }}>
              <button
                className="btn sm"
                data-testid="output-button"
                disabled={
                  !(canExport(activeRes) || !!activeResultTab?.resultId)
                }
                onClick={() => {
                  setSaveTableOpen(false);
                  setOutputOpen((v) => !v);
                }}
                title="Export this result or save it as a table"
              >
                <Icon.Download size={14} /> Output
              </button>
              {outputOpen &&
                (canExport(activeRes) || activeResultTab?.resultId) && (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "110%",
                      background: "var(--raised)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: 7,
                      boxShadow: "var(--shadow)",
                      zIndex: 20,
                      minWidth: 168,
                      overflow: "hidden",
                    }}
                    onMouseLeave={() => setOutputOpen(false)}
                  >
                    {canExport(activeRes) && (
                      <>
                        <div
                          style={{
                            padding: "6px 10px 2px",
                            fontSize: 11,
                            letterSpacing: 0.3,
                            textTransform: "uppercase",
                            color: "var(--text-dim)",
                          }}
                        >
                          Export
                        </div>
                        {exportFormatsFor(activeRes).map(([fmt, label]) => (
                          <button
                            key={fmt}
                            className="btn ghost"
                            data-testid={`export-${fmt}`}
                            style={{
                              display: "block",
                              width: "100%",
                              textAlign: "left",
                              borderRadius: 0,
                            }}
                            onClick={() => {
                              void doExport(fmt);
                              setOutputOpen(false);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </>
                    )}
                    {activeResultTab?.resultId && (
                      <>
                        {canExport(activeRes) && (
                          <div
                            style={{
                              height: 1,
                              background: "var(--border)",
                              margin: "4px 0",
                            }}
                          />
                        )}
                        <button
                          className="btn ghost"
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            borderRadius: 0,
                          }}
                          onClick={() => {
                            const base = (activeResultTab?.title || "result")
                              .replace(/[^A-Za-z0-9_]/g, "_")
                              .replace(/^_+|_+$/g, "")
                              .slice(0, 28);
                            setSaveTableName(
                              /^[A-Za-z_]/.test(base) ? base : "t_" + base,
                            );
                            setOutputOpen(false);
                            setSaveTableOpen(true);
                          }}
                        >
                          <Icon.Database size={13} /> Save as table…
                        </button>
                      </>
                    )}
                  </div>
                )}
              {saveTableOpen && activeResultTab?.resultId && (
                <div
                  className="save-table-pop"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <label className="stp-label">Save result as table</label>
                  <input
                    className="stp-input"
                    value={saveTableName}
                    autoFocus
                    onChange={(e) => setSaveTableName(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && doSaveResultAsTable()
                    }
                    placeholder="my_table"
                  />
                  {feats?.duckdb && (
                    <select
                      className="stp-input"
                      value={saveTableEngine}
                      onChange={(e) => setSaveTableEngine(e.target.value)}
                    >
                      <option value="auto">Auto — DuckDB</option>
                      <option value="duckdb">DuckDB</option>
                      <option value="sqlite">SQLite</option>
                    </select>
                  )}
                  <div className="stp-actions">
                    <button
                      className="btn sm ghost"
                      onClick={() => setSaveTableOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={!saveTableName.trim()}
                      onClick={doSaveResultAsTable}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* editor */}
          <div
            className="editor-wrap"
            style={{ flex: 1 }}
            onKeyDown={onEditorKeyDown}
          >
            <SqlEditor
              flash={stmtFlash}
              fmtShimmer={fmtShimmer}
              caretRef={editorCaret}
              value={activeTab.sql}
              onChange={setSql}
              onRunAll={runAll}
              onRunStatement={runStatementAt}
              onRunSelection={runSelection}
              tables={tables}
              testId="ide-sql-editor"
              placeholder="Write SQL here…  Ctrl/Cmd+Enter to run, F5 for the current statement."
            />
          </div>

          {/* results resizer */}
          <div className="gutter-h" onPointerDown={dragResults} />

          {/* results */}
          <div className="results" style={{ height: resultsH }}>
            {/* result tabs (one per query; profiles open here too) */}
            <div className="tabs res-tabs">
              {resTabs.length === 0 && (
                <div className="tab empty-tab">Results</div>
              )}
              {resTabs.map((r) => (
                <div
                  key={r.id}
                  className={"tab" + (r.id === activeResId ? " active" : "")}
                  draggable
                  onDragStart={() => {
                    dragRes.current = r.id;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    reorderResTabs(r.id);
                  }}
                  onClick={() => setActiveResId(r.id)}
                  data-pulse={
                    r.kind === "result" &&
                    (r as { originTabId?: string }).originTabId &&
                    runsNow()[(r as { originTabId?: string })
                      .originTabId as string]
                      ? "1"
                      : undefined
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setResMenu({ id: r.id, x: e.clientX, y: e.clientY });
                  }}
                  title={
                    r.kind === "profile"
                      ? `Profile: ${r.profileTable}`
                      : r.sql || r.title
                  }
                >
                  {r.kind === "profile" ? (
                    <Icon.Info size={13} />
                  ) : r.kind === "recon" ? (
                    <Icon.Compare size={13} />
                  ) : (
                    <Icon.Grid size={13} />
                  )}
                  {r.pinned && <Icon.Pin size={11} className="pin-on" />}
                  <span>{r.title}</span>
                  <span
                    className="close"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeRes(r.id);
                    }}
                  >
                    <Icon.X size={12} />
                  </span>
                </div>
              ))}
            </div>

            {/* status row */}
            <div className="result-status">
              {activeResultTab && (
                <div className="seg">
                  <button
                    className={
                      "seg-btn" +
                      ((activeResultTab.view ?? "grid") === "grid"
                        ? " on"
                        : "")
                    }
                    onClick={() => setResView(activeResultTab.id, "grid")}
                  >
                    <Icon.Grid size={12} /> Grid
                  </button>
                  <button
                    className={
                      "seg-btn" +
                      (activeResultTab.view === "chart" ? " on" : "")
                    }
                    onClick={() => setResView(activeResultTab.id, "chart")}
                  >
                    <Icon.Chart size={12} /> Chart
                  </button>
                  <button
                    className={
                      "seg-btn" +
                      (activeResultTab.view === "pivot" ? " on" : "")
                    }
                    onClick={() => setResView(activeResultTab.id, "pivot")}
                  >
                    <Icon.Table size={12} /> Pivot
                  </button>
                </div>
              )}
              <span className="spacer" />
              {activeResultTab?.page && (
                <>
                  {activeResultTab.page.engine && (
                    <span
                      className={"chip " + engineCls(activeResultTab.page.engine)}
                    >
                      <span className="dot" /> {activeResultTab.page.engine}
                    </span>
                  )}
                  <span className="stat">
                    <b>
                      {(activeResultTab.page.total_rows ?? 0).toLocaleString()}
                    </b>{" "}
                    rows
                  </span>
                  {(activeResultTab.page.result_capped ||
                    activeResultTab.page.truncated) && (
                    <span
                      className="chip"
                      data-testid="result-capped-chip"
                      title={
                        activeResultTab.page.result_cap != null
                          ? `Stopped at the ${activeResultTab.page.result_cap.toLocaleString()}-row safety limit`
                          : "Result was truncated"
                      }
                      style={{ color: "#c98a2b" }}
                    >
                      Capped
                    </span>
                  )}
                  {activeResultTab.visibleColumns &&
                    activeResultTab.visibleColumns.length > 0 &&
                    (activeResultTab.allColumns?.length || 0) >
                      activeResultTab.visibleColumns.length && (
                      <button
                        className="chip filter-chip"
                        title="Show all columns"
                        onClick={() => {
                          patchRes(activeResultTab.id, {
                            visibleColumns: null,
                          });
                          void resultPaging.refresh(activeResultTab.id);
                        }}
                      >
                        {activeResultTab.visibleColumns.length} of{" "}
                        {(activeResultTab.allColumns || []).length} cols
                        <Icon.X size={11} />
                      </button>
                    )}
                  {activeResultTab.filters &&
                    activeResultTab.filters.length > 0 && (
                      <button
                        className="chip filter-chip"
                        title="Clear all filters"
                        onClick={clearAllFilters}
                      >
                        <Icon.Filter size={11} />{" "}
                        {activeResultTab.filters.length} filter
                        {activeResultTab.filters.length > 1 ? "s" : ""}
                        <Icon.X size={11} />
                      </button>
                    )}
                  {(activeResultTab.page.rows?.length ?? 0) <
                    (activeResultTab.page.total_rows ?? 0) && (
                    <span className="stat faint">
                      {activeResultTab.page.rows.length.toLocaleString()} of{" "}
                      {(
                        activeResultTab.page.total_rows ?? 0
                      ).toLocaleString()}{" "}
                      loaded
                    </span>
                  )}
                  {activeResultTab.page.elapsed_ms != null && (
                    <span className="stat">
                      <b>{activeResultTab.page.elapsed_ms}</b> ms
                    </span>
                  )}
                </>
              )}
            </div>

            {/* messages banner */}
            {(queryError || conflict || okMessage) && (
              <div
                className={
                  "msg-banner " + (queryError || conflict ? "err" : "ok")
                }
              >
                <span className="mt">
                  {queryError
                    ? "Query error"
                    : conflict
                      ? "Cross-engine conflict"
                      : "Success"}
                </span>
                <span className="mb">
                  {queryError
                    ? queryError
                    : conflict
                      ? typeof conflict === "string"
                        ? conflict
                        : JSON.stringify(conflict)
                      : okMessage && (
                          <span key={okMessage} className="ok-type">
                            {okMessage}
                          </span>
                        )}
                </span>
                <span className="spacer" />
                <button
                  className="close"
                  title="Dismiss"
                  onClick={() => {
                    setQueryError(null);
                    setConflict(null);
                    setOkMessage(null);
                  }}
                >
                  <Icon.X size={13} />
                </button>
              </div>
            )}

            {/* content */}
            <div
              className={"result-pane" + (dockHot ? " dock-hot" : "")}
              ref={resultPaneRef}
              onDragOver={(e) => {
                if (dragRes.current) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!dragRes.current) return;
                e.preventDefault();
                const from = dragRes.current;
                dragRes.current = null;
                setCompare((c) =>
                  applyCompareDrop(c, activeResIdRef.current, from),
                );
              }}
            >
              {compare ? (
                (() => {
                  const lr = resTabs.find((x) => x.id === compare.left);
                  const rr = resTabs.find((x) => x.id === compare.right);
                  return (
                    <div className="compare-split">
                      <div className="compare-pane">
                        <div className="compare-head">
                          <Icon.Grid size={12} />
                          <span>{lr?.title ?? "Left"}</span>
                        </div>
                        <div className="compare-body">
                          {renderGridForRes(compare.left)}
                        </div>
                      </div>
                      <div className="compare-pane">
                        <div className="compare-head">
                          <Icon.Grid size={12} />
                          <span>{rr?.title ?? "Right"}</span>
                          <span className="spacer" />
                          <button
                            className="float-btn"
                            title="Exit compare (back to one result)"
                            onClick={() => setCompare(null)}
                          >
                            <Icon.X size={13} />
                          </button>
                        </div>
                        <div className="compare-body">
                          {renderGridForRes(compare.right)}
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : activeRes?.kind === "recon" ? (
                <ReconReport
                  report={activeRes.recon!}
                  spec={activeRes.reconSpec!}
                  onProfile={(b, f) =>
                    reconProfile(activeRes.reconSpec!, b, f)
                  }
                  onDrill={(b, f) => reconDrill(activeRes.reconSpec!, b, f)}
                  onExport={(filename, csv) => {
                    saveToDownloads(filename, { text: csv })
                      .then((r) => toast("ok", "Exported", r.path))
                      .catch((e: any) =>
                        toast(
                          "error",
                          "Export failed",
                          e?.message || String(e),
                        ),
                      );
                  }}
                  onExportFailures={async () => {
                    // .540: the FULL failed-values CSV, server-side into
                    // Downloads; a cancellable export card while it runs.
                    const expId =
                      "exp-" +
                      ((crypto as any).randomUUID?.() ||
                        Math.random().toString(36).slice(2));
                    try {
                      const r = await api.reconFailuresCsv(
                        activeRes!.reconSpec!,
                        expId,
                      );
                      if (r.cancelled) {
                        toast("warn", "Export cancelled", "");
                        return;
                      }
                      toast(
                        "ok",
                        `Exported ${r.rows ?? 0} failed values`,
                        r.path || "",
                      );
                    } catch (e: any) {
                      toast(
                        "error",
                        "Export failed",
                        e?.message || String(e),
                      );
                    }
                  }}
                />
              ) : activeRes?.kind === "profile" ? (
                <Profiler
                  profile={activeRes.profile ?? null}
                  loading={!!activeRes.profileLoading}
                  tableName={activeRes.profileTable}
                  onCancel={
                    activeRes.profileQueryId
                      ? () => cancelBgOp(activeRes.profileQueryId)
                      : undefined
                  }
                />
              ) : activeResultTab ? (
                (activeResultTab.view ?? "grid") === "chart" ? (
                  hasFloat(floats, activeResultTab.resultId ?? "", "chart") ? (
                    floatPlaceholder("Chart")
                  ) : (
                    <ChartPanel
                      resultId={activeResultTab.resultId ?? null}
                      columns={activeResultTab.page?.columns || []}
                      onPopOut={() => floatView(activeResultTab.id, "chart")}
                    />
                  )
                ) : activeResultTab.view === "pivot" ? (
                  hasFloat(floats, activeResultTab.resultId ?? "", "pivot") ? (
                    floatPlaceholder("Pivot")
                  ) : (
                    <PivotPanel
                      tables={tables}
                      result={
                        activeResultTab.resultId
                          ? {
                              id: activeResultTab.resultId,
                              columns: activeResultTab.page?.columns || [],
                            }
                          : null
                      }
                      onToast={toast}
                      onPopOut={() => floatView(activeResultTab.id, "pivot")}
                    />
                  )
                ) : activeResultTab.page ? (
                  hasFloat(floats, activeResultTab.resultId ?? "", "grid") ? (
                    floatPlaceholder("This result")
                  ) : (
                    <>
                      {stmtStrip(activeResultTab)}
                      <DataGrid
                      page={activeResultTab.page}
                      sortCol={activeResultTab.sortCol ?? null}
                      descending={!!activeResultTab.descending}
                      onSort={doSort}
                      onLoadMore={() =>
                        loadMoreRows(activeResIdRef.current as string)
                      }
                      hasMore={
                        (activeResultTab.page.rows?.length ?? 0) <
                        (activeResultTab.page.total_rows ?? 0)
                      }
                      loadingMore={!!activeResultTab.loadingMore}
                      onExportResults={(fmt) =>
                        exportResultTab(activeResultTab, fmt)
                      }
                      cellFetch={{
                        resultId: activeResultTab.page.result_id ?? null,
                        filters: activeResultTab.filters,
                      }}
                      onColumnContextMenu={(col, x, y) => {
                        const cur = resTabsRef.current.find(
                          (t) => t.id === activeResIdRef.current,
                        );
                        const ex = (cur?.filters || []).find(
                          (f) => f.column === col,
                        );
                        setFilterDraft({
                          op: ex?.op ?? "contains",
                          value: ex?.value ?? "",
                        });
                        setColMenu({ col, x, y });
                      }}
                      />
                    </>
                  )
                ) : (
                  <div className="empty">
                    <div className="inner">
                      <p>No rows.</p>
                    </div>
                  </div>
                )
              ) : (
                <div className="empty">
                  <div className="inner">
                    <Icon.Grid size={26} className="faint" />
                    <h3>No results yet</h3>
                    <p>
                      Run a query with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> +{" "}
                      <kbd>Enter</kbd>, or press <kbd>F5</kbd> to run the
                      statement at the cursor. Each query tab gets its own
                      result tab.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* result-tab right-click menu */}
            {resMenu &&
              (() => {
                const r = resTabs.find((x) => x.id === resMenu.id);
                if (!r) return null;
                return (
                  <>
                    <div
                      className="ctx-backdrop"
                      onClick={() => setResMenu(null)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setResMenu(null);
                      }}
                    />
                    <div
                      className="ctx-menu"
                      style={menuPos(resMenu.x, resMenu.y)}
                    >
                      {r.kind === "result" &&
                        (r.pinned ? (
                          <button onClick={() => unpinRes(r.id)}>
                            <Icon.Pin size={13} /> Unpin (resume syncing)
                          </button>
                        ) : (
                          <button onClick={() => pinRes(r.id)}>
                            <Icon.Pin size={13} /> Pin (freeze this result)
                          </button>
                        ))}
                      {r.kind === "result" && (
                        <button
                          onClick={() => {
                            floatView(r.id, r.view ?? "grid");
                            setResMenu(null);
                          }}
                        >
                          <Icon.PopOut size={13} /> Open in new window
                        </button>
                      )}
                      {r.kind === "result" && r.resultId && (
                        <>
                          <div className="sep" />
                          <button
                            onClick={() => {
                              void exportResultTab(r, "csv");
                              setResMenu(null);
                            }}
                          >
                            <Icon.Download size={13} /> Export results (CSV)
                          </button>
                          <button
                            onClick={() => {
                              void exportResultTab(r, "json");
                              setResMenu(null);
                            }}
                          >
                            <Icon.Download size={13} /> Export results (JSON)
                          </button>
                        </>
                      )}
                      <button onClick={() => closeRes(r.id)}>
                        <Icon.X size={13} /> Close &amp; clear from memory
                      </button>
                    </div>
                  </>
                );
              })()}

            {/* grid column right-click menu: change data type */}
            {colMenu &&
              (() => {
                const info = activeResultTab
                  ? backingColumn(activeResultTab.sql, colMenu.col, tables)
                  : null;
                return (
                  <>
                    <div
                      className="ctx-backdrop"
                      onClick={() => setColMenu(null)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setColMenu(null);
                      }}
                    />
                    <div
                      className="ctx-menu"
                      style={menuPos(colMenu.x, colMenu.y, 250)}
                    >
                      <div className="ctx-head">
                        {colMenu.col}
                        {info ? ` · ${info.currentType}` : ""}
                      </div>
                      <button
                        onClick={() => {
                          void onProfileField(colMenu.col);
                          setColMenu(null);
                        }}
                      >
                        Profile field
                      </button>
                      <button
                        data-testid="grid-hide-column"
                        onClick={() => {
                          const tab = activeResultTab;
                          if (!tab) return;
                          const all =
                            tab.allColumns || tab.page?.columns || [];
                          const current =
                            tab.visibleColumns && tab.visibleColumns.length
                              ? tab.visibleColumns
                              : all;
                          if (current.length <= 1) {
                            toast(
                              "warn",
                              "Keep at least one column",
                              "Hide other columns instead, or clear the projection.",
                            );
                            setColMenu(null);
                            return;
                          }
                          const next = current.filter((c) => c !== colMenu.col);
                          patchRes(tab.id, {
                            allColumns: all.length ? all : undefined,
                            visibleColumns: next,
                          });
                          setColMenu(null);
                          void resultPaging.refresh(tab.id);
                        }}
                      >
                        Hide column
                      </button>
                      {!!(
                        activeResultTab?.visibleColumns &&
                        activeResultTab.visibleColumns.length > 0 &&
                        (activeResultTab.allColumns?.length || 0) >
                          activeResultTab.visibleColumns.length
                      ) && (
                        <button
                          data-testid="grid-show-all-columns"
                          onClick={() => {
                            if (!activeResultTab) return;
                            patchRes(activeResultTab.id, {
                              visibleColumns: null,
                            });
                            setColMenu(null);
                            void resultPaging.refresh(activeResultTab.id);
                          }}
                        >
                          Show all columns
                        </button>
                      )}
                      <div className="ctx-sep" />
                      {info ? (
                        TYPE_CHOICES.map(([ty, label]) => (
                          <button
                            key={ty}
                            disabled={
                              info.currentType.toUpperCase() === ty
                            }
                            onClick={() =>
                              changeColType(
                                info.engine,
                                info.table,
                                colMenu.col,
                                ty,
                              )
                            }
                          >
                            Change to {label}
                          </button>
                        ))
                      ) : (
                        <div className="ctx-note">
                          Type changes apply to a column of a loaded table
                          shown directly (e.g. <code>SELECT * FROM table</code>).
                        </div>
                      )}

                      <div className="ctx-sep" />
                      <div className="ctx-sub">Filter rows</div>
                      <div className="flt-row">
                        <select
                          className="flt-op"
                          data-testid="grid-filter-op"
                          value={filterDraft.op}
                          onChange={(e) =>
                            setFilterDraft((d) => ({
                              ...d,
                              op: e.target.value as FilterOp,
                            }))
                          }
                        >
                          {FILTER_OPS.map(([op, label]) => (
                            <option key={op} value={op}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {!NO_VALUE_OPS.has(filterDraft.op) && (
                          <input
                            className="flt-val"
                            data-testid="grid-filter-value"
                            placeholder="value"
                            value={filterDraft.value}
                            onChange={(e) =>
                              setFilterDraft((d) => ({
                                ...d,
                                value: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                applyColFilter(
                                  colMenu.col,
                                  filterDraft.op,
                                  filterDraft.value,
                                );
                            }}
                          />
                        )}
                      </div>
                      <div className="flt-actions">
                        <button
                          className="primary sm"
                          data-testid="grid-filter-apply"
                          onClick={() =>
                            applyColFilter(
                              colMenu.col,
                              filterDraft.op,
                              filterDraft.value,
                            )
                          }
                        >
                          Apply filter
                        </button>
                        {(activeResultTab?.filters || []).some(
                          (f) => f.column === colMenu.col,
                        ) && (
                          <button
                            className="ghost sm"
                            onClick={() => clearColFilter(colMenu.col)}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
          </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------- modals ---------- */}
      {errorLogOpen && <ErrorLogModal onClose={() => setErrorLogOpen(false)} />}
      {diagOpen && (
        <DiagnosticsModal onClose={() => setDiagOpen(false)} tables={tables} />
      )}
      {activityOpen && (
        <ActivityModal
          onClose={() => setActivityOpen(false)}
          onTablesChanged={refreshTables}
        />
      )}
      {ideFile && (
        <FileBrowser
          saveMode={ideFile.mode === "save"}
          defaultFileName={(() => {
            const tab = edTabs.find((t) => t.id === activeId);
            return wfFileName(
              (tab && ideWfNames[tab.id]) || tab?.title || "query",
            );
          })()}
          onClose={() => setIdeFile(null)}
          onPick={async (path) => {
            const mode = ideFile.mode;
            setIdeFile(null);
            try {
              if (mode === "save") {
                const tab = edTabs.find((t) => t.id === activeId);
                const content = wfEnvelope(
                  "ide",
                  tab?.title || "query",
                  { sql: tab?.sql || "" },
                );
                const r = await api.saveFile(path, content);
                if (r.error) toast("error", "Save failed", r.error);
                else toast("ok", "Saved", r.name || path);
              } else {
                const r = await api.openFile(path);
                if (r.error || typeof r.content !== "string") {
                  toast("error", "Open failed", r.error || "Empty file.");
                  return;
                }
                openWorkflowContent(r.content, r.name || "Opened");
              }
            } catch (e: any) {
              toast("error", "File error", e?.message || String(e));
            }
          }}
        />
      )}
      {loadOpen && (
        <LoadDataModal
          features={feats || null}
          onClose={() => setLoadOpen(false)}
          onBeginLoad={beginLoad}
          onBeginLoadFolder={beginLoadFolder}
          onBeginHdfsFileLoad={beginHdfsFileLoad}
          onError={(m) => toast("error", "Load failed", m)}
          onLoaded={(res, label) => {
            setLoadOpen(false);
            // Pull the authoritative table list asynchronously so the
            // sidebar updates without a page refresh (covers file, path,
            // and API loads regardless of their response shape).
            refreshTables();
            const n =
              res.loaded?.reduce(
                (acc, l) => acc + (l.tables?.length || 0),
                0,
              ) || 0;
            toast("ok", "Loaded", `${n} table(s) from ${label}`);
          }}
        />
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">
            <Icon.Upload size={26} />
            <div className="drop-overlay-title">Drop to load</div>
            <div className="drop-overlay-sub">
              Release to choose how to load
            </div>
          </div>
        </div>
      )}

      {confirmUi}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {createdNodesUi.modals}
      {dashboardUi.modals}
      {tableProps && (
        <TablePropsModal
          engine={tableProps.engine}
          table={tableProps.name}
          onClose={() => setTableProps(null)}
        />
      )}
      {storage?.open && (
        <StorageMemoryModal
          busy={storage.busy}
          report={storage.rep}
          mem={storageMem}
          initialTab={storage.tab}
          onClose={() => setStorage(null)}
          onToast={toast}
          onRefreshReport={() => void openStorage(storage.tab || "storage")}
          onMemFreed={setStorageMem}
        />
      )}
      {dropFiles && (
        <Modal
          title={`Load ${dropFiles.length} file${dropFiles.length === 1 ? "" : "s"}`}
          onClose={() => setDropFiles(null)}
          footer={
            <>
              <button
                className="btn ghost"
                onClick={() => setDropFiles(null)}
              >
                Cancel
              </button>
              <span className="spacer" />
              <button
                className="btn primary"
                onClick={doDropLoad}
              >
                Load
              </button>
            </>
          }
        >
          <div className="drop-files">
            {dropFiles.map((f, i) => (
              <div className="drop-file" key={i}>
                <Icon.File size={13} />{" "}
                <span className="mono">{f.name}</span>
              </div>
            ))}
          </div>
          <label className="drop-dest">
            Load into
            <select
              value={dropDest}
              onChange={(e) => setDropDest(e.target.value)}
            >
              <option value="auto">
                Auto
                {health?.features?.duckdb
                  ? " — DuckDB (recommended)"
                  : " — SQLite"}
              </option>
              <option
                value="duckdb"
                disabled={!health?.features?.duckdb}
              >
                DuckDB
                {health?.features?.duckdb
                  ? ""
                  : " (install duckdb to enable)"}
              </option>
              <option value="sqlite">SQLite</option>
            </select>
          </label>
          {health?.features?.duckdb &&
          !(
            dropFiles.length === 1 &&
            /\.(xlsx|xlsm|xls)$/i.test(dropFiles[0].name)
          ) ? (
            <>
              <label className="drop-dest">
                How to load
                <select
                  value={dropMode}
                  onChange={(e) => setDropMode(e.target.value)}
                >
                  <option value="materialize">
                    Copy into a table (default)
                  </option>
                  <option value="view">
                    Query the file in place — don&apos;t copy
                  </option>
                </select>
              </label>
              {dropMode === "view" ? (
                <div
                  className="hint"
                  style={{ margin: "0 0 4px", fontSize: 12 }}
                >
                  The file is uploaded once, then read in place as a read-only
                  DuckDB view (no table copy) — instant and light on memory.
                  Best for Parquet; a CSV is re-parsed per query.
                </div>
              ) : null}
            </>
          ) : null}
          {dropFiles.length === 1 &&
          /\.(xlsx|xlsm|xls)$/i.test(dropFiles[0].name) ? (
            <>
              <label className="drop-dest">
                Excel sheet
                <select
                  value={dropSheet}
                  onChange={(e) => setDropSheet(e.target.value)}
                >
                  <option value="">
                    {dropSheets === null
                      ? "Reading sheets…"
                      : "All sheets (one table each)"}
                  </option>
                  {(dropSheets || []).map((sn) => (
                    <option key={sn} value={sn}>
                      {sn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="drop-dest">
                Start at row (the header row)
                <input
                  type="number"
                  min={1}
                  value={dropHeaderRow}
                  onChange={(e) =>
                    setDropHeaderRow(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </label>
            </>
          ) : (
            <label className="drop-dest">
              Delimiter (CSV / text)
              <input
                value={dropDelim}
                onChange={(e) => setDropDelim(e.target.value)}
                placeholder={"auto — e.g.  ~  ;  |  or  \\t  for tab"}
              />
            </label>
          )}
          {dropFiles.some((f) => /\.(json|ndjson|jsonl)$/i.test(f.name)) &&
          !!health?.features?.duckdb &&
          dropDest !== "sqlite" ? (
            <label
              className="drop-dest chk"
              title="One table per nested array (with join keys: _rid + ordinals), created right after the load from the Parquet cache — one vectorized pass per table. Off = a single nested table you can query in place."
            >
              <input
                type="checkbox"
                checked={dropShred}
                onChange={(e) => setDropShred(e.target.checked)}
              />{" "}
              Flatten into relational tables (off by default — leave off for
              large nested JSON unless you need joinable child tables)
            </label>
          ) : null}
          {dropShred &&
          dropFiles.length === 1 &&
          /\.(json|ndjson|jsonl)$/i.test(dropFiles[0].name) &&
          !!health?.features?.duckdb &&
          dropDest !== "sqlite" ? (
            <RootIdPicker
              enabled
              file={dropFiles[0]}
              value={dropRootId}
              onChange={setDropRootId}
            />
          ) : null}
          {dropFiles.some((f) => /\.(json|ndjson|jsonl)$/i.test(f.name)) &&
          !(!!health?.features?.duckdb && dropDest !== "sqlite") &&
          !(
            dropFiles.length === 1 &&
            /\.(xlsx|xlsm|xls)$/i.test(dropFiles[0].name)
          ) ? (
            <label className="drop-dest">
              Skip these fields (JSON, optional)
              <input
                value={dropExclude}
                onChange={(e) => setDropExclude(e.target.value)}
                placeholder={"e.g.  cashFlows, floatingFlowsList"}
              />
              <div className="hint" style={{ marginTop: 4 }}>
                Comma-separated. A field name is skipped wherever it appears —
                its column and, if it's a nested array, the whole child table.
                Skipping a big array can turn a very long load into a quick one.
              </div>
            </label>
          ) : null}
        </Modal>
      )}

      {saveOpen && (
        <SaveModal
          defaultSql={activeTab.sql}
          onClose={() => setSaveOpen(false)}
          onSave={saveQuery}
        />
      )}


      {exitOpen && (
        <ExitModal
          serverUrl={window.location.origin}
          onCancel={() => setExitOpen(false)}
          onKeepServer={exitKeepServer}
          onStopServer={exitStopServer}
        />
      )}

      {joinGuideOpen && (
        <DocsModal
          tables={tables}
          onClose={() => setJoinGuideOpen(false)}
        />
      )}
      {reconcileOpen && (
        <ReconcileModal
          initialLeft={reconcileInitial}
          tables={tables}
          onClose={() => setReconcileOpen(false)}
          onRun={onRunReconcile}
          onToast={toast}
        />
      )}

      {exiting && (
        <ExitGoodbye mode={exiting} serverUrl={window.location.origin} />
      )}

      {/* ---------- detachable floating panels (pop-outs) ---------- */}
      {floats.map((f) => {
        const r = resTabs.find((x) => x.id === f.resId);
        const title = (r?.title ?? "Result") + " · " + f.view;
        let body: React.ReactNode;
        if (f.view === "chart")
          body = (
            <ChartPanel
              resultId={r?.resultId ?? null}
              columns={r?.page?.columns || []}
            />
          );
        else if (f.view === "pivot")
          body = (
            <PivotPanel
              tables={tables}
              result={
                r?.resultId
                  ? { id: r.resultId, columns: r.page?.columns || [] }
                  : null
              }
              onToast={toast}
            />
          );
        else body = renderGridForRes(f.resId);
        return (
          <FloatingPanel
            key={f.id}
            title={title}
            x={f.x}
            y={f.y}
            width={f.width}
            height={f.height}
            z={f.z}
            getDockRect={dockRect}
            onMove={(x, y) => setFloats((fs) => moveFloatById(fs, f.id, x, y))}
            onResize={(w, h) =>
              setFloats((fs) => resizeFloatById(fs, f.id, w, h))
            }
            onDockHover={setDockHot}
            onDock={() => dockFloat(f.id)}
            onFocus={() => focusFloat(f.id)}
          >
            {body}
          </FloatingPanel>
        );
      })}

      {/* ---------- toasts ---------- */}
      {dropChip && (
        <div
          key={dropChip.tick}
          className="drop-chip"
          style={
            {
              left: dropChip.x,
              top: dropChip.y,
              "--fly-dx": 24 - dropChip.x + "px",
              "--fly-dy": 180 - dropChip.y + "px",
            } as React.CSSProperties
          }
        >
          {dropChip.name}
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "toast " +
              (t.kind === "ok" ? "" : t.kind) +
              (t.leaving ? " leaving" : "")
            }
          >
            <div className="tt">{t.title}</div>
            {t.msg && <div className="dim">{t.msg}</div>}
            {!t.leaving && (
              <div
                className="toast-bar"
                style={{
                  animationDuration:
                    (t.kind === "error" ? 6500 : 3800) + "ms",
                }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function engineCls(e: string) {
  return e === "duckdb" ? "duckdb" : e === "remote" ? "remote" : "sqlite";
}

const ExitModal: React.FC<{
  serverUrl: string;
  onCancel: () => void;
  onKeepServer: () => void;
  onStopServer: () => void;
}> = ({ serverUrl, onCancel, onKeepServer, onStopServer }) => (
  <Modal
    title="Exit SamQL?"
    onClose={onCancel}
    footer={
      <>
        <button className="btn ghost" onClick={onCancel}>
          Don’t exit
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onKeepServer}>
          Exit, keep server running
        </button>
        <button className="btn danger" onClick={onStopServer}>
          <Icon.Power size={14} /> Exit &amp; stop server
        </button>
      </>
    }
  >
    <p style={{ marginTop: 0 }}>Do you really want to exit SamQL?</p>
    <ul className="exit-opts">
      <li>
        <b>Exit, keep server running</b> — close this view but leave the local
        server running, so you can reopen SamQL instantly at{" "}
        <code>{serverUrl}</code>.
      </li>
      <li>
        <b>Exit &amp; stop server</b> — shut the server down and clear its
        temporary files. You’ll need to start it again to use SamQL.
      </li>
      <li>
        <b>Don’t exit</b> — stay right here.
      </li>
    </ul>
  </Modal>
);

const ExitGoodbye: React.FC<{
  mode: "kept" | "stopped";
  serverUrl: string;
}> = ({ mode, serverUrl }) => (
  <div className="exit-goodbye">
    <div className="exit-card">
      <div className="mark-lg">S</div>
      {mode === "stopped" ? (
        <>
          <h2>SamQL server stopped</h2>
          <p>The server has shut down and its temporary files were cleared.</p>
          <p className="dim">You can close this tab now.</p>
        </>
      ) : (
        <>
          <h2>SamQL closed</h2>
          <p>
            The server is still running — reopen SamQL any time at{" "}
            <a href={serverUrl}>{serverUrl}</a>.
          </p>
          <p className="dim">You can close this tab, or reopen the link above.</p>
        </>
      )}
    </div>
  </div>
);

const SaveModal: React.FC<{
  defaultSql: string;
  onClose: () => void;
  onSave: (name: string, tags: string[]) => void;
}> = ({ defaultSql, onClose, onSave }) => {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  return (
    <Modal
      title="Save query"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() =>
              onSave(
                name.trim(),
                tags
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Monthly revenue by region"
        />
      </div>
      <div className="form-row">
        <label>Tags (comma-separated, optional)</label>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="finance, monthly"
        />
      </div>
      <div className="form-row">
        <label>SQL preview</label>
        <pre
          className="mono"
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
            maxHeight: 160,
            overflow: "auto",
            fontSize: 12,
            margin: 0,
            whiteSpace: "pre-wrap",
          }}
        >
          {defaultSql || "(empty)"}
        </pre>
      </div>
    </Modal>
  );
};

// Live server connection + activity status for the memory widget. Reuses the
// Activity modal's shared monitor, polling, and reset (no duplicated logic);
// it polls only while the memory popover is open (mounts/unmounts with it).
const StatIndicator: React.FC<{
  onOpenActivity: () => void;
}> = ({ onOpenActivity }) => {
  // persistent activity badge (.412): background tasks PLUS running
  // operations (queries/flows/flattens), red when a stall is flagged
  // .463: and a one-shot PULSE the moment any background task lands.
  const [pulse, setPulse] = React.useState(false);
  const pulseTimer = React.useRef<number | null>(null);
  const firePulse = React.useCallback(() => {
    if (pulseTimer.current != null)
      window.clearTimeout(pulseTimer.current);
    setPulse(false);
    requestAnimationFrame(() => setPulse(true));
    pulseTimer.current = window.setTimeout(() => {
      setPulse(false);
      pulseTimer.current = null;
    }, 700);
  }, []);
  React.useEffect(
    () => () => {
      if (pulseTimer.current != null)
        window.clearTimeout(pulseTimer.current);
    },
    [],
  );
  const { activeCount, opsCount, stalled } = useTasks(true, firePulse);
  const inFlight = activeCount + (opsCount || 0);
  return (
    <div
      className={
        "mem-top ok" +
        (stalled ? " stalled" : "") +
        (pulse ? " pulse" : "")
      }
      title="Activity dashboard — everything running right now"
      onClick={onOpenActivity}
    >
      <span className="dot" />
      <span className="mono">Activity</span>
      {inFlight > 0 && (
        <span
          className="task-badge"
          title={`${inFlight} thing${
            inFlight === 1 ? "" : "s"
          } running (tasks + queries/flows)`}
        >
          <span className="spin" />
          {inFlight}
        </span>
      )}
    </div>
  );
};

// Owns its own 100ms tick so the running-query elapsed counter never
// re-renders the whole IDE. Mounted only while a query is running.
const RunTimer: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(id);
  }, []);
  return <>{(Math.max(0, Date.now() - startedAt) / 1000).toFixed(1)}s</>;
};
