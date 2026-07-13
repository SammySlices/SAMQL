import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConfirmPop } from "./ConfirmPop";
import { NotebookCell, type RunCell } from "./NotebookCell";
import { ProgressBar } from "./ProgressBar";
import { Icon } from "./Icon";
import { api, exportResultToFile, saveToDownloads } from "../lib/api";
import { cancelOne, cancelAllRuns, isCancelledError, registerRun, unregisterRun } from "../lib/runController";
import { uid } from "../lib/ids";
import { startPointerDrag } from "../lib/pointerDrag";
import { usePagedResult, type PagedResultOperation } from "../lib/usePagedResult";
import type { TableInfo, ReconBucket } from "../lib/types";
import { FileBrowser } from "./LoadDataModal";
import { wfEnvelope, parseWfFile, wfFileName } from "../lib/workflowFile";
import type { ReconSpec } from "./ReconcileModal";
import { buildReconcileRequest } from "../lib/reconcileRequest";
import {
  composeChainedSql,
  referencedNames,
  cellIsFresh,
  reorderByGroups,
  lastSqlCellByGroup,
  planChainReuse,
  buildJournalDependencyGraph,
  planJournalRunAll,
  journalGraphCsv,
  nextCellName,
  sanitizeCellName,
  uniqueCellName,
  renameInSql,
  serializeNotebook,
  parseNotebookFile,
  parseNotebookGroups,
  ensureNotebookStore,
  listNotebooks,
  saveNotebookDoc,
  loadNotebookDoc,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  setCurrentNotebookId,
  currentNotebookId,
  writeRecovery,
  clearRecovery,
  loadGroups,
  saveGroups,
  defaultGroups,
  DEFAULT_GROUP_ID,
  type NbCellDef,
  type NbGroupDef,
  type NbMeta,
  type NbRecovery,
  type NbReconSpec,
} from "../lib/notebook";

interface Props {
  appVersion?: string;
  appBuild?: string;
  tables: TableInfo[];
  target: string;
  // change the active engine (Auto-route / SQLite / DuckDB). Shared with the
  // SQL editor: the Journal runs its cells on this same target.
  onTargetChange?: (t: string) => void;
  // SQL input dialect, shared with the editor: "native" runs as-is, "spark"
  // transpiles Spark SQL to the engine's dialect before running.
  dialect?: string;
  onDialectChange?: (d: string) => void;
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  onTablesMaybeChanged?: () => void;
  // a one-shot request from the sidebar to open a saved (kind=journal) workflow
  loadRequest?: { id: number; name: string; doc: string } | null;
  onLoadConsumed?: () => void;
  onWorkflowsChanged?: () => void;
  // a one-shot command (from sidebar/settings) to run save / save-as / open
  command?: {
    id: number;
    action: "save" | "saveAs" | "open" | "exportGraph";
  } | null;
  // engine capability flags, used to gate the engine selector's DuckDB option
  // and export formats (parquet needs pyarrow) the same way the SQL editor does
  features?: { pyarrow?: boolean; openpyxl?: boolean; duckdb?: boolean } | null;
}

const LAZY_CHUNK = 1000;
// Cap the rows a single cell retains in memory from scroll-loading. The grid
// virtualises rendering, so this is purely a memory guard against runaway
// infinite-scroll; sort/filter still work against the full result server-side.
const MAX_RETAINED_ROWS = 50000;

// A change-detection token for a reconcile cell: it changes when a source cell
// is re-run (its resultId changes), a real-table source is reloaded (row_count
// changes), or the keys/compare/balance/source selection changes. Editing an
// upstream cell's SQL without re-running it does NOT change this (the cell's
// result -- what reconcile compares -- only changes on run), so auto-rerun
// tracks results, not keystrokes.
function reconInputSig(
  c: RunCell,
  list: RunCell[],
  tables: TableInfo[],
): string {
  const part = (name?: string) => {
    if (!name) return "\u2205";
    const sc = list.find((x) => x.type === "sql" && x.name === name);
    if (sc) return `c:${sc.id}:${sc.resultId ?? ""}`;
    const t = tables.find((x) => x.name === name);
    if (t) return `t:${t.name}:${t.row_count ?? ""}`;
    return `?:${name}`;
  };
  const r = c.recon || { keys: [], compare: [] };
  return [
    part(c.leftSource),
    part(c.rightSource),
    r.keys.join(","),
    r.compare.join(","),
    r.balance || "",
  ].join("|");
}

// Auto-rerun is gated by source size: a re-run materialises each cell source
// (a full CTAS) and aggregates over both inputs, so above this many rows we
// leave it manual (click Reconcile) rather than firing heavy work on every
// upstream change. One number, easy to tune.
const AUTO_RECON_MAX_ROWS = 250000;

function reconSourceRows(
  name: string | undefined,
  list: RunCell[],
  tables: TableInfo[],
): number {
  if (!name) return 0;
  const sc = list.find((x) => x.type === "sql" && x.name === name);
  if (sc) return sc.page?.total_rows ?? 0;
  return tables.find((x) => x.name === name)?.row_count ?? 0;
}

// True when both sources are small enough to auto-rerun. An unknown size (e.g.
// a table whose count hasn't been computed yet) counts as small.
function reconAutoEligible(
  c: RunCell,
  list: RunCell[],
  tables: TableInfo[],
): boolean {
  return (
    Math.max(
      reconSourceRows(c.leftSource, list, tables),
      reconSourceRows(c.rightSource, list, tables),
    ) <= AUTO_RECON_MAX_ROWS
  );
}

function defToCell(d: NbCellDef): RunCell {
  return {
    id: d.id || uid(),
    type: d.type,
    name: d.name,
    group: d.group,
    code: d.code || "",
    text: d.text || "",
    sourceName: d.sourceName,
    leftSource: d.leftSource,
    rightSource: d.rightSource,
    recon: d.recon,
    outView: "grid",
    collapsed: !!d.collapsed,
    boxW: d.boxW,
    boxH: d.boxH,
  };
}

function seedDefs(): NbCellDef[] {
  return [
    {
      id: uid(),
      type: "note",
      text:
        "# Journal\nA query and its result live together in each cell. Run one with ⌘/Ctrl+Enter, or **Run all** above. Reference an earlier cell by its name (e.g. `cell1`) to chain a step onto its result.",
    },
    {
      id: uid(),
      type: "sql",
      name: "cell1",
      code: "-- Query a loaded table, then run this cell.\nSELECT *\nFROM your_table\nLIMIT 100;",
    },
  ];
}
function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const Notebook: React.FC<Props> = ({
  appVersion,
  appBuild,
  tables,
  target,
  onTargetChange,
  dialect,
  onDialectChange,
  onToast,
  onTablesMaybeChanged,
  loadRequest,
  onLoadConsumed,
  onWorkflowsChanged,
  command,
  features,
}) => {
  const boot = useRef<ReturnType<typeof ensureNotebookStore> | null>(null);
  if (boot.current === null) boot.current = ensureNotebookStore(seedDefs);
  const [cells, setCells] = useState<RunCell[]>(() =>
    boot.current!.cells.map(defToCell),
  );
  const [nbId, setNbId] = useState<string>(() => boot.current!.meta.id);
  const [nbName, setNbName] = useState<string>(() => boot.current!.meta.name);
  // Groups (sections). Load the sidecar for this notebook, else one default
  // group. Cells laid out left-to-right by group; each runs top-to-bottom.
  const [groups, setGroups] = useState<NbGroupDef[]>(
    () => loadGroups(boot.current!.meta.id) || defaultGroups(),
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // Every cell must belong to an existing group; a cell with no/orphaned group
  // (old journals, or one whose group was deleted) falls back to the first.
  const groupIdSet = useMemo(
    () => new Set(groups.map((g) => g.id)),
    [groups],
  );
  const groupOf = (c: RunCell) =>
    c.group && groupIdSet.has(c.group) ? c.group : groups[0]?.id || DEFAULT_GROUP_ID;
  // stable ordering: earlier groups' cells precede later groups' cells, so the
  // run order (and the backward-only chaining) matches the left-to-right group
  // layout -- a later group can reference an earlier group's cells by name.
  // .474: the tab strip is ordered by CREATION (stable), not recency --
  // listNotebooks() is recency-sorted for the library, but tabs must not
  // shuffle on open or when one is edited. refreshTabs() then keeps this
  // order and only appends/removes.
  const [nbList, setNbList] = useState<NbMeta[]>(() =>
    [...listNotebooks()].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    ),
  );
  // .473: refresh the tab strip WITHOUT reordering it. listNotebooks()
  // is recency-sorted (for the library), so switching to a tab -- which
  // bumps its updatedAt via the pre-switch save -- would otherwise yank
  // it to the front. This keeps every existing tab where it sits,
  // appends only new journals, drops deleted ones, and refreshes names.
  const refreshTabs = React.useCallback(() => {
    const fresh = listNotebooks();
    setNbList((prev) => {
      const byId = new Map(fresh.map((m) => [m.id, m]));
      const kept = prev
        .filter((m) => byId.has(m.id))
        .map((m) => byId.get(m.id)!); // refresh name/updatedAt in place
      const seen = new Set(kept.map((m) => m.id));
      const added = fresh.filter((m) => !seen.has(m.id));
      return [...kept, ...added];
    });
  }, []);
  const [recovery, setRecovery] = useState<NbRecovery | null>(
    () => boot.current!.recoveredOrphan,
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "saved",
  );
  const [savedAt, setSavedAt] = useState<number | null>(Date.now());
  // name this journal was last saved/loaded under in Saved Workflows (so a
  // re-save updates in place instead of re-prompting)
  const [jwfName, setJwfName] = useState<string>("");
  // a ticking clock so the "saved Xm ago" label stays current
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const nbIdRef = useRef(nbId);
  nbIdRef.current = nbId;
  const nbNameRef = useRef(nbName);
  nbNameRef.current = nbName;
  const aborts = useRef<Map<string, { ctrl: AbortController; queryId: string }>>(
    new Map(),
  );
  // whether a "Run all" sweep is in progress (drives the Run all / Stop toggle)
  // and a flag the sweep checks between cells so Stop halts it immediately.
  const [runningAll, setRunningAll] = useState(false);
  // Determinate "Run all" progress for the bar next to Run all/Stop: SQL cells
  // completed of the total to run. null when not sweeping.
  const [journalProg, setJournalProg] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const cancelAllRef = useRef(false);
  // temp tables materialised for each reconcile cell's inputs, so we can drop
  // them when the cell re-runs or is deleted.
  const reconTemps = useRef<Map<string, { name: string; engine: string }[]>>(
    new Map(),
  );
  // synchronous in-flight guard so a debounced auto-rerun can't start a second
  // materialise/reconcile pass for the same cell before reconRunning (state)
  // has propagated.
  const reconRunningRef = useRef<Set<string>>(new Set());

  // Cheap structural signatures, recomputed once per cells change (one pass,
  // no regex). The expensive graph/stale work keys on the SQL signature
  // *debounced*, so fast typing doesn't trigger an O(n^2) recompute every
  // keystroke; autosave keys on the full persisted signature so transient
  // run-state updates (running/page/resultId) don't re-serialise the doc.
  const { sqlSig, persistSig } = useMemo(() => {
    let s = "";
    let p = "";
    for (const c of cells) {
      // sources (sourceName / left+right) belong in both signatures because
      // they change the dependency graph; the reconcile key/compare spec only
      // needs to trigger a save, so it goes in the persist signature alone.
      const head = `${c.id}\u0001${c.type}\u0001${c.name || ""}\u0001${
        c.sourceName || ""
      }\u0001${c.leftSource || ""}\u0001${c.rightSource || ""}`;
      s += head + "\u0001" + (c.type === "sql" ? c.code : "") + "\u0002";
      const reconSig = c.recon
        ? `${c.recon.keys.join(",")}|${c.recon.compare.join(",")}|${
            c.recon.balance || ""
          }`
        : "";
      p +=
        head +
        "\u0001" +
        (c.type === "sql"
          ? c.code
          : c.type === "note"
            ? c.text
            : c.type === "reconcile"
              ? reconSig
              : "") +
        "\u0001" +
        (c.boxW || "") +
        "x" +
        (c.boxH || "") +
        "\u0002";
    }
    return { sqlSig: s, persistSig: p };
  }, [cells]);
  const [debSqlSig, setDebSqlSig] = useState(sqlSig);
  useEffect(() => {
    if (debSqlSig === sqlSig) return;
    const t = setTimeout(() => setDebSqlSig(sqlSig), 200);
    return () => clearTimeout(t);
  }, [sqlSig, debSqlSig]);

  // persist the current notebook's cells (debounced) + a recovery snapshot,
  // and surface save status in the toolbar.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return; // don't re-write what we just loaded
    }
    setSaveState("saving");
    const t = setTimeout(() => {
      const defs = cellsRef.current as NbCellDef[];
      saveNotebookDoc(nbIdRef.current, defs);
      writeRecovery(nbIdRef.current, nbNameRef.current, defs);
      setSaveState("saved");
      setSavedAt(Date.now());
    }, 400);
    return () => clearTimeout(t);
  }, [persistSig]);

  // persist groups (sidecar) when they change; a load resets the guard so we
  // don't immediately re-write what we just read.
  const firstGroupSave = useRef(true);
  useEffect(() => {
    if (firstGroupSave.current) {
      firstGroupSave.current = false;
      return;
    }
    saveGroups(nbIdRef.current, groups);
  }, [groups]);

  // ---- notebook undo / redo ----
  // A history of whole-notebook snapshots. We record on persistSig (which
  // already excludes transient run-state), so undo tracks *edits* — cell text,
  // add / delete / move / resize — never a query simply finishing. Rapid edits
  // coalesce into one step; snapshots keep results (cells share references, so
  // this is cheap). Reset when switching notebooks so undo can't cross them.
  const nbHist = useRef<{ past: RunCell[][]; future: RunCell[][]; at: number }>({
    past: [],
    future: [],
    at: 0,
  });
  const nbPrevCells = useRef<RunCell[]>(cells);
  const nbApplying = useRef(false);
  const nbHistNbId = useRef<string>(""); // sentinel forces a reset on first run
  const [, bumpNbHist] = useState(0);
  const bumpNb = () => bumpNbHist((n) => n + 1);

  useEffect(() => {
    if (nbHistNbId.current !== nbIdRef.current) {
      // first mount or a notebook switch: drop history, don't record the load
      nbHistNbId.current = nbIdRef.current;
      nbHist.current = { past: [], future: [], at: 0 };
      nbPrevCells.current = cellsRef.current;
      nbApplying.current = false;
      bumpNb();
      return;
    }
    if (nbApplying.current) {
      // this change came from undo / redo itself, not a user edit
      nbApplying.current = false;
      nbPrevCells.current = cellsRef.current;
      return;
    }
    const now = Date.now();
    if (now - nbHist.current.at > 600 || nbHist.current.past.length === 0) {
      nbHist.current.past.push(nbPrevCells.current);
      if (nbHist.current.past.length > 50) nbHist.current.past.shift();
    }
    nbHist.current.future = []; // a fresh edit invalidates the redo trail
    nbHist.current.at = now;
    nbPrevCells.current = cellsRef.current;
    bumpNb();
  }, [persistSig, nbId]);

  const undoNb = () => {
    const h = nbHist.current;
    if (h.past.length === 0) return;
    h.future.push(cellsRef.current);
    const prev = h.past.pop() as RunCell[];
    nbApplying.current = true;
    nbPrevCells.current = prev;
    setCells(prev);
    bumpNb();
  };
  const redoNb = () => {
    const h = nbHist.current;
    if (h.future.length === 0) return;
    h.past.push(cellsRef.current);
    const next = h.future.pop() as RunCell[];
    nbApplying.current = true;
    nbPrevCells.current = next;
    setCells(next);
    bumpNb();
  };
  const canUndoNb = nbHist.current.past.length > 0;
  const canRedoNb = nbHist.current.future.length > 0;
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y anywhere in the journal (bubbles up from a
  // cell editor); single-line inputs (cell name, etc.) keep their native undo.
  const onJournalKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undoNb();
    } else if ((k === "z" && e.shiftKey) || k === "y") {
      e.preventDefault();
      redoNb();
    }
  };

  // ---- notebook library management ----
  const saveCurrentNow = () => {
    const defs = cellsRef.current as NbCellDef[];
    saveNotebookDoc(nbIdRef.current, defs);
    writeRecovery(nbIdRef.current, nbNameRef.current, defs);
  };
  const loadInto = (meta: NbMeta) => {
    notebookPaging.cancelPending();
    // results aren't persisted across a switch, so free the outgoing
    // notebook's cached results instead of leaving them to LRU eviction
    for (const c of cellsRef.current) discardRid(c.resultId);
    const defs = loadNotebookDoc(meta.id) || seedDefs();
    setCells(defs.map(defToCell));
    setGroups(loadGroups(meta.id) || defaultGroups());
    firstGroupSave.current = true; // a load is not an edit
    setNbId(meta.id);
    setNbName(meta.name);
    setCurrentNotebookId(meta.id);
    refreshTabs();
    firstSave.current = true; // a load is not an edit
    setSaveState("saved");
    setSavedAt(Date.now());
  };
  const switchTo = (id: string) => {
    if (id === nbId) return;
    saveCurrentNow();
    const meta = listNotebooks().find((m) => m.id === id);
    if (meta) loadInto(meta);
  };
  const newNotebook = () => {
    saveCurrentNow();
    const meta = createNotebook("Untitled", seedDefs());
    loadInto(meta);
    onToast("ok", "New Journal", `Created "${meta.name}".`);
  };
  // .471: the switcher popover became a TAB STRIP (the IDE/NodeFlow
  // pattern -- double-click renames, x deletes, + creates); the
  // Duplicate affordance is retired with it.
  const [renamingJ, setRenamingJ] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const commitRenameJ = () => {
    const r = renamingJ;
    setRenamingJ(null);
    if (!r) return;
    const name = r.draft.trim();
    if (!name) return;
    const updated = renameNotebook(r.id, name);
    if (updated) {
      if (r.id === nbId) setNbName(updated.name);
      refreshTabs();
    }
  };
  const renameCurrent = (name: string) => {
    const updated = renameNotebook(nbId, name);
    if (updated) {
      setNbName(updated.name);
      refreshTabs();
    }
  };
  const confirmPop = useConfirmPop();

  const deleteJournal = (id: string, anchor?: HTMLElement | null) => {
    const label = nbList.find((m) => m.id === id)?.name || "this journal";
    confirmPop.ask(
      anchor || { left: window.innerWidth / 2 - 94, top: 96, side: "right" },
      `Delete "${label}"? A recovery snapshot is kept until your next edit.`,
      () => reallyDeleteJournal(id, label),
    );
  };
  const reallyDeleteJournal = (id: string, label: string) => {
    if (id !== nbId) {
      // deleting a background tab never disturbs the open journal
      deleteNotebook(id);
      refreshTabs();
      onToast("ok", "Deleted", `Removed "${label}".`);
      return;
    }
    deleteNotebook(nbId);
    let remaining = listNotebooks();
    if (remaining.length === 0) {
      const fresh = createNotebook("Untitled", seedDefs());
      setCurrentNotebookId(fresh.id);
      remaining = listNotebooks();
    }
    const nextId = currentNotebookId() || remaining[0].id;
    const nextMeta = remaining.find((m) => m.id === nextId) || remaining[0];
    loadInto(nextMeta);
    onToast("ok", "Deleted", `Removed "${label}".`);
  };
  const restoreRecovery = () => {
    if (!recovery) return;
    saveCurrentNow();
    const meta = createNotebook(recovery.name || "Recovered", recovery.cells);
    clearRecovery();
    setRecovery(null);
    loadInto(meta);
    onToast("ok", "Restored", `Recovered "${meta.name}".`);
  };
  const dismissRecovery = () => {
    clearRecovery();
    setRecovery(null);
  };

  const patch = (id: string, p: Partial<RunCell>) =>
    setCells((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  // Phase 4: the Journal and IDE now share one paging state machine. The
  // actual cell rerun is declared later; a ref keeps expiry recovery current
  // without forcing the paging hook to depend on Notebook's execution layout.
  const rerunExpiredCellRef = useRef<
    (id: string, operation: PagedResultOperation) => Promise<string | null>
  >(async () => null);
  const notebookPaging = usePagedResult<RunCell>({
    getItem: (id) => cellsRef.current.find((cell) => cell.id === id),
    patchItem: (id, pagingPatch) =>
      patch(id, pagingPatch as Partial<RunCell>),
    fetchPage: (resultId, pageOptions, signal) =>
      api.page(resultId, pageOptions, signal),
    rerunExpired: (id, operation) =>
      rerunExpiredCellRef.current(id, operation),
    onError: (operation, message) => {
      const title =
        operation === "sort"
          ? "Sort failed"
          : operation === "filter"
            ? "Filter failed"
            : operation === "loadMore"
              ? "Load more failed"
              : "Result refresh failed";
      onToast("error", title, message);
    },
    pageSize: LAZY_CHUNK,
    maxRetainedRows: MAX_RETAINED_ROWS,
  });

  // Rename a cell's reference handle. Keeps it unique, and rewrites references
  // in every other cell's SQL so later cells that query it keep working.
  const renameCell = (id: string, raw: string) => {
    setCells((cs) => {
      const cell = cs.find((c) => c.id === id);
      if (!cell) return cs;
      const old = cell.name || "";
      let neu = sanitizeCellName(raw);
      if (!neu) return cs;
      neu = uniqueCellName(
        neu,
        cs.filter((c) => c.id !== id).map((c) => c.name || ""),
      );
      if (neu === old) return cs;
      return cs.map((c) => {
        if (c.id === id) return { ...c, name: neu };
        let nc = c;
        if (old && c.code) {
          const code2 = renameInSql(c.code, old, neu);
          if (code2 !== c.code) nc = { ...nc, code: code2 };
        }
        if (nc.sourceName === old) nc = { ...nc, sourceName: neu };
        if (nc.leftSource === old) nc = { ...nc, leftSource: neu };
        if (nc.rightSource === old) nc = { ...nc, rightSource: neu };
        return nc;
      });
    });
  };

  const sqlIndex = useMemo(() => {
    const m: Record<string, number> = {};
    let n = 0;
    for (const c of cells) if (c.type === "sql") m[c.id] = ++n;
    return m;
  }, [cells]);

  // earlier SQL cells (by position) that can be referenced for chaining, PLUS a
  // "group output" alias per earlier group: the group's name resolves to that
  // group's final SQL cell, so a later group can pull the previous group's
  // output with FROM "<group name>" without naming its last cell.
  const earlierList = (id: string, list: RunCell[]) => {
    const out: { name: string; sql: string }[] = [];
    for (const c of list) {
      if (c.id === id) break;
      if (c.type === "sql" && c.name && c.code.trim())
        out.push({ name: c.name, sql: c.code });
    }
    const gs = groupsRef.current;
    if (gs.length > 1) {
      const rank = new Map(gs.map((g, i) => [g.id, i] as const));
      const gidOf = (c: RunCell) =>
        c.group && rank.has(c.group) ? c.group : gs[0]?.id;
      const target = list.find((c) => c.id === id);
      const targetRank = target
        ? rank.get(gidOf(target) as string) ?? 0
        : gs.length;
      // the LAST SQL cell (with code) in each group, by array order
      const lastByGroup = lastSqlCellByGroup(list, null, gs);
      const cellNames = new Set(
        list
          .filter((c) => c.type === "sql" && c.name)
          .map((c) => (c.name as string).toLowerCase()),
      );
      for (const g of gs) {
        if ((rank.get(g.id) ?? 0) >= targetRank) continue; // earlier groups only
        const last = lastByGroup.get(g.id);
        const nm = g.name.trim();
        // skip if the group is empty or its name would shadow a real cell name
        if (!last || !nm || cellNames.has(nm.toLowerCase())) continue;
        out.push({ name: nm, sql: last.code });
      }
    }
    return out;
  };
  const earlierOf = (id: string) => earlierList(id, cellsRef.current);

  // One shared, tested dependency model powers badges, branch commands,
  // concurrent manual runs, and the optimized Run all scheduler. It includes
  // earlier-group aliases as well as direct cell-name references.
  const buildGraph = (list: RunCell[]) =>
    buildJournalDependencyGraph(list, groupsRef.current);

  const collect = (id: string, edges: Record<string, string[]>) => {
    const out = new Set<string>();
    const stack = [...(edges[id] || [])];
    while (stack.length) {
      const n = stack.pop() as string;
      if (out.has(n)) continue;
      out.add(n);
      for (const m of edges[n] || []) stack.push(m);
    }
    return out;
  };
  const orderByIndex = (ids: Set<string>, list: RunCell[]) =>
    list.filter((c) => ids.has(c.id)).map((c) => c.id);

  // graph + compiled SQL recompute only when the (debounced) SQL structure
  // changes — never on transient result updates or while typing fast.
  const graph = useMemo(
    () => buildGraph(cellsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debSqlSig, groups],
  );
  // signature of the groups (id + name + order) so the compiled SQL — which now
  // inlines earlier groups' output under their names — recomputes on a rename.
  const groupSig = useMemo(
    () => groups.map((g) => g.id + ":" + g.name).join("|"),
    [groups],
  );
  const compiledById = useMemo(() => {
    const m: Record<string, string> = {};
    const list = cellsRef.current;
    for (const c of list)
      if (c.type === "sql") m[c.id] = composeChainedSql(c.code, earlierList(c.id, list));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debSqlSig, groupSig]);
  // staleness is now a cheap string compare against the last-run compiled SQL.
  const staleById = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const c of cells) {
      const comp = compiledById[c.id];
      m[c.id] =
        c.type === "sql" &&
        !!c.ranOnce &&
        c.ranCompiledSql != null &&
        comp !== undefined &&
        comp !== c.ranCompiledSql;
    }
    return m;
  }, [cells, compiledById]);

  const discardRid = (rid?: string | null) => {
    if (rid) api.discardResult(rid).catch(() => {});
  };

  // latest compiled/stale maps for runCell (which lives outside the memos)
  const compiledRef = useRef(compiledById);
  compiledRef.current = compiledById;

  // A cell whose parquet result can stand in for its SQL: it ran, isn't
  // stale against the canonical composition, and wasn't capped (.349 -- a
  // capped store is not the full answer). Shared by chain reuse and
  // reconcile input staging.
  const isCellFresh = (c: RunCell) =>
    cellIsFresh(
      c,
      compiledRef.current[c.id],
      !!(c.page as any)?.result_capped,
    );

  // R1 (chain reuse): compose the SQL to SEND for a run. The canonical
  // compiled SQL (full CTE inlining) stays the staleness key; the transport
  // SQL replaces every FRESH upstream reference with a server-side TEMP VIEW
  // over that cell's already-computed parquet result, so a chained cell never
  // re-executes upstream work. Walk: a fresh direct/indirect reference is
  // materialized (its own deps are already inside its result); a stale one is
  // inlined and ITS references examined the same way.
  const composeForRun = (cell: RunCell) => {
    const list = cellsRef.current;
    const earlier = earlierList(cell.id, list);
    const canonical = composeChainedSql(cell.code, earlier);
    // freshness by referenceable name: real cells by their name; a group
    // alias is fresh when the group's LAST sql cell is fresh.
    const freshRid = new Map<string, string>();
    for (const c of list) {
      if (c.id === cell.id) break;
      if (c.type === "sql" && c.name && isCellFresh(c))
        freshRid.set(c.name.toLowerCase(), c.resultId as string);
    }
    const gs = groupsRef.current;
    if (gs.length > 1) {
      const lastByGroup = lastSqlCellByGroup(list, cell.id, gs);
      for (const g of gs) {
        const last = lastByGroup.get(g.id);
        const nm = g.name.trim().toLowerCase();
        if (last && nm && !freshRid.has(nm) && isCellFresh(last))
          freshRid.set(nm, last.resultId as string);
      }
    }
    const { reuse, materialized } = planChainReuse(
      cell.code,
      earlier,
      freshRid,
    );
    const sendSql = materialized.size
      ? composeChainedSql(cell.code, earlier, materialized)
      : canonical;
    return { canonical, sendSql, reuse };
  };

  // DEPENDENCY GATE: register by cell id, then wait for every currently
  // running direct dependency from the same graph used by Run all. This also
  // covers references through a group-output alias; the former name-only gate
  // could start that dependent while the group's last cell was still running.
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map());

  const runCell = async (id: string): Promise<string | null> => {
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell || cell.type !== "sql") return null;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hadGate = inflightRef.current.get(id);
    inflightRef.current.set(id, gate);
    try {
      if (hadGate) await hadGate; // a re-run waits out its own prior run
      const deps = buildJournalDependencyGraph(
        cellsRef.current,
        groupsRef.current,
      ).depIds[id] || [];
      for (const depId of deps) {
        const dep = inflightRef.current.get(depId);
        if (dep && dep !== gate) await dep;
      }
      if (cancelAllRef.current) return null;
      return await runCellInner(id);
    } finally {
      if (inflightRef.current.get(id) === gate) inflightRef.current.delete(id);
      release();
    }
  };

  const runCellInner = async (id: string): Promise<string | null> => {
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell || cell.type !== "sql") return null;
    const prevRid = cell.resultId;
    const raw = cell.code.trim();
    if (!raw) {
      discardRid(prevRid);
      patch(id, { error: "This cell is empty.", ranOnce: true, page: null, resultId: null });
      return null;
    }
    const { canonical: composed, sendSql, reuse } = composeForRun(cell);
    // supersede any in-flight run of this cell
    const prev = aborts.current.get(id);
    if (prev) {
      prev.ctrl.abort();
      api.cancelQuery(prev.queryId).catch(() => {});
    }
    const ctrl = new AbortController();
    const queryId = uid() + uid();
    aborts.current.set(id, { ctrl, queryId });
    registerRun(queryId, ctrl); // .519: modal Cancel reaches this fetch
    patch(id, { running: true, error: null });
    try {
      let res = await api.query(
        sendSql,
        target,
        false,
        queryId,
        ctrl.signal,
        dialect,
        Object.keys(reuse).length ? reuse : undefined,
        { surface: "journal", label: cell.name || "cell" },
      );
      if ((res as any).reuse_stale) {
        // an upstream result was evicted / capped / not reusable on this
        // engine -- recompose with full inlining and run once more
        res = await api.query(
          composed,
          target,
          false,
          queryId,
          ctrl.signal,
          dialect,
          undefined,
          { surface: "journal", label: cell.name || "cell" },
        );
      }
      if (res.error) {
        if (res.cancelled || res.error === "cancelled") {
          patch(id, { running: false });
        } else {
          patch(id, {
            running: false,
            error: res.detail && typeof res.detail === "string" ? res.detail : res.error,
            ranOnce: true,
          });
        }
        return null;
      } else if (res.result_id == null) {
        // non-SELECT (DDL/DML) — no grid, just acknowledge
        patch(id, {
          running: false,
          error: null,
          ranOnce: true,
          ranCompiledSql: composed,
          resultId: null,
          page: { columns: [], rows: [], total_rows: 0 },
          elapsedMs: res.elapsed_ms ?? null,
        });
        onTablesMaybeChanged?.();
        discardRid(prevRid); // a non-SELECT supersedes any prior result
        return null;
      } else {
        patch(id, {
          running: false,
          error: null,
          ranOnce: true,
          ranCompiledSql: composed,
          resultId: res.result_id,
          queryId, // .520: page fetches ride the run id (cancellable send)
          page: res,
          elapsedMs: res.elapsed_ms ?? null,
          sortCol: null,
          descending: false,
        });
        if (res.result_capped)
          onToast(
            "warn",
            "Result capped",
            `Stopped at the ${(res.result_cap ?? 0).toLocaleString()}-row safety limit — the query produced more. Add a filter (or raise SAMQL_MAX_RESULT_ROWS) to see everything.`,
          );
        // a pure read can't have changed the catalog; skip the recount storm
        // during Run-all. Anything not explicitly "read" still refreshes.
        if ((res as any).stmt_kind !== "read") onTablesMaybeChanged?.();
        if (prevRid && prevRid !== res.result_id) discardRid(prevRid);
        return res.result_id;
      }
    } catch (e: any) {
      if (isCancelledError(e, queryId)) {
        patch(id, { running: false });
        return null;
      }
      patch(id, { running: false, error: e?.message || String(e), ranOnce: true });
      return null;
    } finally {
      unregisterRun(queryId);
      const cur = aborts.current.get(id);
      if (cur && cur.queryId === queryId) aborts.current.delete(id);
    }
  };

  rerunExpiredCellRef.current = (id) => runCell(id);

  const runAll = async () => {
    cancelAllRef.current = false;
    const list = cellsRef.current;
    const sqlCells = list.filter(
      (c) => c.type === "sql" && c.code.trim(),
    );
    const cappedById: Record<string, boolean> = {};
    for (const c of sqlCells)
      cappedById[c.id] = !!(c.page as any)?.result_capped;
    const plan = planJournalRunAll(
      list,
      groupsRef.current,
      compiledRef.current,
      cappedById,
    );
    setRunningAll(true);
    // Fresh cells are already complete at the start: their full parquet result
    // is reused by stale descendants instead of sending the SQL again.
    setJournalProg({ done: plan.reusedIds.length, total: sqlCells.length });
    try {
      // Each wave contains independent stale cells. Dependencies in the next
      // wave start only after all prerequisite runs have settled.
      for (const wave of plan.waves) {
        if (cancelAllRef.current) break;
        await Promise.allSettled(
          wave.map((id) =>
            runCell(id).finally(() =>
              setJournalProg((pp) =>
                pp ? { done: pp.done + 1, total: pp.total } : pp,
              ),
            ),
          ),
        );
      }
    } finally {
      setRunningAll(false);
      setJournalProg(null);
    }
  };

  // run this cell after first running everything it depends on (upstream)
  const runWithUpstream = async (id: string) => {
    const list = cellsRef.current;
    const g = buildGraph(list);
    const anc = orderByIndex(collect(id, g.depIds), list);
    for (const a of anc) {
       
      await runCell(a);
    }
    await runCell(id);
  };
  // run this cell, then everything that depends on it (downstream)
  const runWithDownstream = async (id: string) => {
    const list = cellsRef.current;
    const g = buildGraph(list);
    await runCell(id);
    const desc = orderByIndex(collect(id, g.dependentIds), list);
    for (const d of desc) {
       
      await runCell(d);
    }
  };
  // run the whole connected branch through this cell: upstream, self, downstream
  const runBranch = async (id: string) => {
    const list = cellsRef.current;
    const g = buildGraph(list);
    const anc = orderByIndex(collect(id, g.depIds), list);
    const desc = orderByIndex(collect(id, g.dependentIds), list);
    for (const a of anc) {
       
      await runCell(a);
    }
    await runCell(id);
    for (const d of desc) {
       
      await runCell(d);
    }
  };

  const cancelCell = (id: string) => {
    const a = aborts.current.get(id);
    if (a) {
      cancelOne(a.queryId, a.ctrl);
      aborts.current.delete(id);
    }
    patch(id, { running: false });
  };
  // Stop a Run-all sweep: halt the loop (cancelAllRef) and cancel any cell that
  // is currently in flight so the backend stops too.
  const cancelAll = () => {
    cancelAllRef.current = true;
    const ids: string[] = [];
    aborts.current.forEach((_v, id) => ids.push(id));
    ids.forEach((id) => cancelCell(id));
    // Free any other in-flight request (status polls, metadata) so a Stop-all
    // can't leave the connection pool occupied.
    cancelAllRuns();
  };

  const addCell = (
    type: "sql" | "note" | "chart" | "pivot" | "reconcile",
    groupId?: string,
    afterId?: string,
  ) => {
    setCells((cs) => {
      const names = cs.filter((c) => c.type === "sql").map((c) => c.name || "");
      const gid = groupId || groupsRef.current[0]?.id || DEFAULT_GROUP_ID;
      // adding into a collapsed group would be invisible -- expand it
      setGroups((gs) =>
        gs.map((g) =>
          g.id === gid && g.collapsed ? { ...g, collapsed: false } : g,
        ),
      );
      const nc: RunCell = {
        ...defToCell({
          id: uid(),
          type,
          name: type === "sql" ? nextCellName(names) : undefined,
          code: type === "sql" ? "" : undefined,
          text: type === "note" ? "" : undefined,
          recon: type === "reconcile" ? { keys: [], compare: [] } : undefined,
        }),
        group: gid,
      };
      let next: RunCell[];
      if (afterId) {
        const i = cs.findIndex((c) => c.id === afterId);
        next = cs.slice();
        next.splice(i + 1, 0, nc);
      } else {
        next = [...cs, nc];
      }
      // keep the array grouped/ordered so chaining + run order match the layout
      return reorderByGroups(next, groupsRef.current);
    });
  };

  // ---- groups (sections) -----------------------------------------------
  const addGroup = () => {
    setGroups((gs) => {
      const names = new Set(gs.map((g) => g.name));
      let k = gs.length + 1;
      let name = "Group " + k;
      while (names.has(name)) name = "Group " + ++k;
      return [...gs, { id: "g" + Date.now().toString(36), name }];
    });
  };
  const renameGroup = (id: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  };
  const toggleGroupCollapse = (id: string) => {
    setGroups((gs) =>
      gs.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
    );
  };
  const deleteGroup = (id: string) => {
    const gs = groupsRef.current;
    if (gs.length <= 1) return; // always keep at least one group
    const g = gs.find((x) => x.id === id);
    const inGroup = cellsRef.current.filter((c) => groupOf(c) === id);
    if (inGroup.length > 0) {
      confirmPop.ask(
        { left: window.innerWidth / 2 - 94, top: 120, side: "right" },
        `Delete group "${g?.name || id}" and its ${inGroup.length} cell${
          inGroup.length === 1 ? "" : "s"
        }?`,
        () => reallyDeleteGroup(id),
      );
      return;
    }
    reallyDeleteGroup(id);
  };
  const reallyDeleteGroup = (id: string) => {
    const inGroup = cellsRef.current.filter((c) => groupOf(c) === id);
    inGroup.forEach((c) => {
      if (c.resultId) discardRid(c.resultId);
    });
    setCells((cs) => cs.filter((c) => groupOf(c) !== id));
    setGroups((prev) => prev.filter((x) => x.id !== id));
  };

  // ---- reconcile cells -------------------------------------------------
  const dropReconTemps = (id: string) => {
    for (const t of reconTemps.current.get(id) || []) {
      api.dropTable(t.engine, t.name).catch(() => {});
    }
    reconTemps.current.delete(id);
  };

  const runReconcile = async (id: string) => {
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell || cell.type !== "reconcile") return;
    const spec = cell.recon || { keys: [], compare: [] };
    if (!cell.leftSource || !cell.rightSource) {
      patch(id, { reconError: "Choose a left and right source." });
      return;
    }
    if (!spec.keys.length) {
      patch(id, { reconError: "Pick at least one key column." });
      return;
    }
    const list = cellsRef.current;
    const tableOf = (name: string) =>
      tables.find((t) => t.name === name) || null;
    const cellOf = (name: string) =>
      list.find((c) => c.type === "sql" && c.name === name) || null;

    // Both inputs must live in one engine: a real-table source anchors it,
    // else default to sqlite (always available to materialise into).
    const lt = tableOf(cell.leftSource);
    const rt = tableOf(cell.rightSource);
    // Engine each input lives in: a real table's engine, else the engine the
    // source cell's result was produced on. Its underlying tables live there,
    // so re-running its SQL to stage it must target that engine -- otherwise a
    // DuckDB-backed cell staged into SQLite throws "no such table".
    const leftEngine = (lt?.engine ||
      cellOf(cell.leftSource)?.page?.engine) as "sqlite" | "duckdb" | undefined;
    const rightEngine = (rt?.engine ||
      cellOf(cell.rightSource)?.page?.engine) as "sqlite" | "duckdb" | undefined;
    if (leftEngine && rightEngine && leftEngine !== rightEngine) {
      patch(id, {
        reconError: `Both inputs must be in the same engine (left is ${leftEngine}, right is ${rightEngine}).`,
      });
      return;
    }
    const anchor: "sqlite" | "duckdb" = leftEngine || rightEngine || "sqlite";
    const target = anchor === "duckdb" ? "__duckdb__" : "__local__";
    const safe = id.replace(/[^A-Za-z0-9_]/g, "");

    if (reconRunningRef.current.has(id)) return; // already running (sync guard)
    reconRunningRef.current.add(id);
    patch(id, { reconRunning: true, reconError: null });
    dropReconTemps(id); // clear any tables staged by a previous run
    const created: { name: string; engine: string }[] = [];

    const resolve = async (
      src: string,
      slot: "l" | "r",
    ): Promise<string | null> => {
      const tbl = tableOf(src);
      if (tbl) return tbl.name; // real table -> use directly
      const sc = cellOf(src);
      if (!sc) {
        patch(id, {
          reconRunning: false,
          reconError: `Source "${src}" not found.`,
        });
        return null;
      }
      // materialise the source's *last-run* SQL so reconcile reflects what the
      // cell currently shows (and so re-running it is what triggers a refresh)
      const sql =
        sc.ranCompiledSql ||
        composeChainedSql(sc.code, earlierList(sc.id, list));
      // R1 parity: a FRESH source stages straight from its parquet result
      // (the sql still travels as the fallback the server uses when the
      // store isn't reusable), so reconcile never re-runs a fresh chain.
      const r = await api.materialize(
        `__nb_${safe}_${slot}`,
        sql,
        target,
        undefined,
        undefined,
        isCellFresh(sc) ? (sc.resultId as string) : undefined,
      );
      if (r.error || !r.name) {
        patch(id, {
          reconRunning: false,
          reconError: `Couldn't stage "${src}": ${r.error || "unknown error"}`,
        });
        return null;
      }
      created.push({ name: r.name, engine: r.engine || anchor });
      return r.name;
    };

    try {
      const left = await resolve(cell.leftSource, "l");
      if (left == null) {
        reconTemps.current.set(id, created);
        return;
      }
      const right = await resolve(cell.rightSource, "r");
      if (right == null) {
        reconTemps.current.set(id, created);
        return;
      }
      reconTemps.current.set(id, created);
      const ranSpec: ReconSpec = {
        left,
        right,
        keys: spec.keys,
        compare: spec.compare,
        balance: spec.balance || null,
        colmap_a: {},
        colmap_b: {},
      };
      // .471: a running reconcile is cancellable exactly like a query
      // cell -- register the run so cancelCell (and Stop-all) can
      // interrupt the backend statement and abort the HTTP wait.
      const prevA = aborts.current.get(id);
      if (prevA) {
        cancelOne(prevA.queryId, prevA.ctrl);
      }
      const ctrl = new AbortController();
      const queryId = "recon-" + uid() + uid();
      aborts.current.set(id, { ctrl, queryId });
    registerRun(queryId, ctrl); // .519: modal Cancel reaches this fetch
      let report: Awaited<ReturnType<typeof api.reconcile>>;
      try {
        report = await api.reconcile(
          { ...ranSpec, query_id: queryId },
          ctrl.signal,
        );
      } catch (e: any) {
        patch(id, {
          reconRunning: false,
          reconError: ctrl.signal.aborted ? "Cancelled." : e?.message,
        });
        return;
      } finally {
        const cur = aborts.current.get(id);
        if (cur && cur.queryId === queryId) aborts.current.delete(id);
      }
      if (report.error) {
        patch(id, { reconRunning: false, reconError: report.error });
        return;
      }
      const latest = cellsRef.current.find((x) => x.id === id) || cell;
      patch(id, {
        reconRunning: false,
        reconError: null,
        reconReport: report,
        reconRanSpec: ranSpec,
        reconRanSig: reconInputSig(latest, cellsRef.current, tables),
        reconDetail: null,
      });
    } catch (e: any) {
      patch(id, {
        reconRunning: false,
        reconError: e?.message || "Reconcile failed.",
      });
    } finally {
      reconRunningRef.current.delete(id);
    }
  };

  const reconCellDrill = async (
    id: string,
    bucket: ReconBucket,
    field: string | null,
  ) => {
    const spec = cellsRef.current.find((c) => c.id === id)?.reconRanSpec;
    if (!spec) return;
    const fld =
      field && (bucket === "matching" || bucket === "non_matching")
        ? ` · ${field}`
        : "";
    const title = bucket.replace("_", " ") + fld;
    patch(id, {
      reconDetail: { kind: "drill", title, loading: true, page: null },
    });
    try {
      const d = await api.reconcileDrilldown(buildReconcileRequest(spec, bucket, field));
      if (d.error || d.result_id == null || d.count === 0) {
        patch(id, {
          reconDetail: {
            kind: "drill",
            title,
            loading: false,
            page: { columns: [], rows: [], total_rows: 0 },
          },
        });
        if (d.error) onToast("error", "Drill-down failed", d.error);
        return;
      }
      const pg = await api.page(d.result_id, { offset: 0, limit: LAZY_CHUNK });
      patch(id, {
        reconDetail: { kind: "drill", title, loading: false, page: pg },
      });
    } catch (e: any) {
      patch(id, { reconDetail: null });
      onToast("error", "Drill-down failed", e?.message);
    }
  };

  const reconCellProfile = async (
    id: string,
    bucket: ReconBucket,
    field: string | null,
  ) => {
    const spec = cellsRef.current.find((c) => c.id === id)?.reconRanSpec;
    if (!spec) return;
    const title = bucket.replace("_", " ");
    patch(id, {
      reconDetail: { kind: "profile", title, loading: true, profile: null },
    });
    try {
      const pr = await api.reconcileProfile(buildReconcileRequest(spec, bucket, field));
      if ((pr as { error?: string }).error) {
        patch(id, { reconDetail: null });
        onToast("error", "Profile failed", (pr as { error?: string }).error);
        return;
      }
      patch(id, {
        reconDetail: { kind: "profile", title, loading: false, profile: pr },
      });
    } catch (e: any) {
      patch(id, { reconDetail: null });
      onToast("error", "Profile failed", e?.message);
    }
  };

  // Auto-rerun a reconcile cell when its inputs change (an upstream source was
  // re-run, a source table reloaded, or its keys/compare/sources changed). The
  // first run stays manual; after that it refreshes itself, debounced so a
  // burst of edits (e.g. toggling several keys) collapses into one run.
  const reconAutoSig = useMemo(
    () =>
      cells
        .filter((c) => c.type === "reconcile")
        .map(
          (c) =>
            `${c.id}=${reconInputSig(c, cells, tables)}@${
              c.reconRanSig || ""
            }${c.reconRunning ? "R" : ""}${
              c.reconReport || c.reconRanSpec ? "1" : "0"
            }`,
        )
        .join(";"),
    [cells, tables],
  );
  useEffect(() => {
    const t = setTimeout(() => {
      for (const c of cellsRef.current) {
        if (c.type !== "reconcile" || c.reconRunning) continue;
        if (!c.reconReport && !c.reconRanSpec) continue; // first run is manual
        if (!c.leftSource || !c.rightSource || !c.recon?.keys?.length) continue;
        if (
          reconInputSig(c, cellsRef.current, tables) !== c.reconRanSig &&
          reconAutoEligible(c, cellsRef.current, tables)
        )
          void runReconcile(c.id);
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconAutoSig]);

  const deleteCell = (id: string) => {
    notebookPaging.cancelPending(id);
    cancelCell(id);
    discardRid(cellsRef.current.find((c) => c.id === id)?.resultId);
    dropReconTemps(id);
    // .435: the survivors GLIDE UP to close the gap (same FLIP rail as
    // the .434 move) instead of teleporting -- skipped under Reduce
    // motion like everything else on this rail.
    if (!document.body.classList.contains("motion-reduced")) {
      const ids = cellsRef.current
        .filter((c) => c.id !== id)
        .map((c) => c.id);
      const rects = snapshotTops(ids);
      if (rects.size) pendingFlip.current = { lifted: null, rects };
    }
    setCells((cs) => cs.filter((c) => c.id !== id));
  };

  // .434: FLIP the up/down swap -- snapshot the two cells' positions
  // BEFORE the reorder, then (in the layout effect below) apply the
  // inverted transform and release it, so the pressed cell RAISES and
  // both glide into place instead of teleporting. Fully skipped under
  // the Reduce-motion toggle (body.motion-reduced).
  const pendingFlip = useRef<{
    lifted: string | null;
    rects: Map<string, number>;
  } | null>(null);
  const snapshotTops = (ids: string[]) => {
    const rects = new Map<string, number>();
    for (const cid of ids) {
      const el = document.querySelector<HTMLElement>(
        `[data-cellid="${cid}"]`,
      );
      if (el) rects.set(cid, el.getBoundingClientRect().top);
    }
    return rects;
  };
  const moveCell = (id: string, dir: -1 | 1) => {
    const i = cells.findIndex((c) => c.id === id);
    if (i >= 0 && !document.body.classList.contains("motion-reduced")) {
      const gid = groupOf(cells[i]);
      let j = i + dir;
      while (j >= 0 && j < cells.length && groupOf(cells[j]) !== gid)
        j += dir;
      if (j >= 0 && j < cells.length) {
        const rects = snapshotTops([cells[i].id, cells[j].id]);
        if (rects.size === 2) pendingFlip.current = { lifted: id, rects };
      }
    }
    setCells((cs) => {
      const i2 = cs.findIndex((c) => c.id === id);
      if (i2 < 0) return cs;
      const gid = groupOf(cs[i2]);
      // swap with the nearest neighbour IN THE SAME GROUP in that direction, so
      // reordering stays inside the group and never crosses a section boundary.
      let j = i2 + dir;
      while (j >= 0 && j < cs.length && groupOf(cs[j]) !== gid) j += dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = cs.slice();
      [next[i2], next[j]] = [next[j], next[i2]];
      return next;
    });
  };
  useLayoutEffect(() => {
    const flip = pendingFlip.current;
    if (!flip) return;
    pendingFlip.current = null;
    const moved: HTMLElement[] = [];
    flip.rects.forEach((oldTop, cid) => {
      const el = document.querySelector<HTMLElement>(
        `[data-cellid="${cid}"]`,
      );
      if (!el) return;
      const d = oldTop - el.getBoundingClientRect().top;
      if (!d) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${d}px)`;
      if (cid === flip.lifted) el.classList.add("cell-lift");
      moved.push(el);
    });
    if (!moved.length) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const el of moved) {
          el.style.transition = "";
          el.style.transform = "";
        }
        window.setTimeout(() => {
          for (const el of moved) el.classList.remove("cell-lift");
        }, 260);
      }),
    );
  }, [cells]);

  // ---- drag-and-drop reordering (pointer-based) ----
  // HTML5 drag-and-drop on a button is flaky and never smooth; we drive the
  // reorder from pointer events instead. The grip captures the pointer, we hit-
  // test the cell under the cursor each move (via data-cell-id), show a drop
  // indicator, and splice on release. Refs mirror the state so the pointerup
  // handler sees the latest target without waiting for a re-render.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    edge: "top" | "bottom";
  } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ id: string; edge: "top" | "bottom" } | null>(
    null,
  );

  const startCellDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button / primary touch only
    e.preventDefault();
    dragIdRef.current = id;
    dropTargetRef.current = null;
    setDragId(id);
    setDropTarget(null);
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(
        ev.clientX,
        ev.clientY,
      ) as HTMLElement | null;
      const cellEl = el?.closest("[data-cell-id]") as HTMLElement | null;
      let next: { id: string; edge: "top" | "bottom" } | null = null;
      if (cellEl) {
        const tid = cellEl.getAttribute("data-cell-id");
        if (tid && tid !== id) {
          const r = cellEl.getBoundingClientRect();
          next = {
            id: tid,
            edge: ev.clientY < r.top + r.height / 2 ? "top" : "bottom",
          };
        }
      }
      const cur = dropTargetRef.current;
      if (!cur || !next || cur.id !== next.id || cur.edge !== next.edge) {
        dropTargetRef.current = next;
        setDropTarget(next);
      }
    };
    const finish = (commit: boolean) => {
      const from = dragIdRef.current;
      const target = dropTargetRef.current;
      dragIdRef.current = null;
      dropTargetRef.current = null;
      setDragId(null);
      setDropTarget(null);
      if (!commit || !from || !target || from === target.id) return;
      setCells((cs) => {
        const fi = cs.findIndex((c) => c.id === from);
        if (fi < 0) return cs;
        const next = cs.slice();
        const [moved] = next.splice(fi, 1);
        let ti = next.findIndex((c) => c.id === target.id);
        if (ti < 0) return cs;
        if (target.edge === "bottom") ti += 1;
        next.splice(ti, 0, moved);
        return next;
      });
    };
    startPointerDrag({
      onMove: move,
      onEnd: () => finish(true),
      onCancel: () => finish(false),
    });
  };

  const doSort = (id: string, col: string) =>
    notebookPaging.sortBy(id, col);

  const loadMore = (id: string) => notebookPaging.loadMore(id);

  // Collapsing a cell frees its retained rows (keeping column/count metadata so
  // it can be re-fetched); expanding restores the first page through the same
  // latest-wins controller used by IDE result tabs.
  const toggleCollapse = async (id: string) => {
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell) return;
    if (!cell.collapsed) {
      notebookPaging.cancelPending(id);
      patch(id, {
        collapsed: true,
        page: cell.page ? { ...cell.page, rows: [] } : cell.page,
      });
      return;
    }
    patch(id, { collapsed: false });
    const needsRefresh =
      cell.type === "sql" &&
      !!cell.resultId &&
      (cell.page?.rows?.length ?? 0) === 0 &&
      (cell.page?.total_rows ?? 0) > 0;
    if (needsRefresh) await notebookPaging.refresh(id);
  };

  const exportCell = async (id: string, fmt: string) => {
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell || !cell.resultId) return;
    try {
      const exp = await exportResultToFile(cell.resultId, fmt, {
        sortCol: cell.sortCol,
        descending: cell.descending,
      });
      if (exp.cancelled) onToast("warn", "Export cancelled", "");
    } catch (e: any) {
      onToast("error", "Export failed", e?.message);
    }
  };

  // Save the current journal into Saved Workflows (kind = journal). Prompts for
  // a name the first time; silent update afterwards.
  const saveAsWorkflow = async () => {
    let name = jwfName;
    if (!name) {
      const entered = window.prompt("Save journal as:", nbNameRef.current || "");
      name = (entered || "").trim();
      if (!name) return;
    }
    try {
      const doc = serializeNotebook(cellsRef.current as NbCellDef[], groupsRef.current);
      const r = await api.workflowSave(name, { doc }, "journal");
      if (r.error) {
        onToast("error", "Save failed", r.error);
        return;
      }
      setJwfName(name);
      onToast("ok", "Saved to Workflows", name);
      onWorkflowsChanged?.();
    } catch (e: any) {
      onToast("error", "Save failed", e?.message || String(e));
    }
  };

  // open a journal requested from the sidebar (one-shot, keyed by request id)
  const lastJournalReq = useRef<number>(0);
  useEffect(() => {
    if (!loadRequest || loadRequest.id === lastJournalReq.current) return;
    lastJournalReq.current = loadRequest.id;
    loadJournalDoc(loadRequest.doc, loadRequest.name);
    // Clear the one-shot request so switching views (which unmounts this
    // component) can't replay a stale load on the way back.
    onLoadConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRequest]);

  // turn a serialized journal document into a fresh open notebook
  function loadJournalDoc(doc: string, name: string) {
    try {
      const defs = parseNotebookFile(doc);
      const cellsForNb = defs.map((d) => ({ ...d, id: uid() }));
      // Restore the group (section) list: from the file if it carried one,
      // else reconstruct from the cells' distinct group ids, else one default.
      let openGroups = parseNotebookGroups(doc);
      if (!openGroups || openGroups.length === 0) {
        const ids: string[] = [];
        for (const c of cellsForNb)
          if (c.group && !ids.includes(c.group)) ids.push(c.group);
        openGroups = ids.length
          ? ids.map((id, i) => ({ id, name: "Group " + (i + 1) }))
          : defaultGroups();
      }
      saveCurrentNow(); // never clobber the current journal
      const meta = createNotebook(name, cellsForNb);
      saveGroups(meta.id, openGroups); // so loadInto picks these up
      loadInto(meta);
      setJwfName(name);
      onToast(
        "ok",
        "Journal opened",
        `${defs.length} cell${defs.length === 1 ? "" : "s"} → “${meta.name}”.`,
      );
    } catch (err: any) {
      onToast("error", "Couldn't open journal", err?.message || String(err));
    }
  }

  // Save As / Open to a file anywhere on disk (via the file browser)
  const [fileModal, setFileModal] = useState<{ mode: "save" | "open" } | null>(
    null,
  );
  const onPickJournalFile = async (path: string) => {
    const mode = fileModal?.mode;
    setFileModal(null);
    try {
      if (mode === "save") {
        const doc = serializeNotebook(cellsRef.current as NbCellDef[], groupsRef.current);
        const content = wfEnvelope("journal", nbNameRef.current || "journal", {
          doc,
        });
        const r = await api.saveFile(path, content);
        if (r.error) onToast("error", "Save failed", r.error);
        else onToast("ok", "Saved", r.name || path);
      } else {
        const r = await api.openFile(path);
        if (r.error || typeof r.content !== "string") {
          onToast("error", "Open failed", r.error || "Empty file.");
          return;
        }
        const env = parseWfFile(r.content);
        const baseName = (r.name || "Journal").replace(/\.samql\.json$|\.json$/i, "");
        if (env && env.kind === "journal" && typeof env.payload?.doc === "string") {
          loadJournalDoc(env.payload.doc, env.name || baseName);
        } else if (env && env.kind !== "journal") {
          onToast(
            "warn",
            "Not a journal file",
            `That looks like a ${env.kind} workflow — open it from the ${env.kind === "ide" ? "SQL editor" : "Node"}.`,
          );
        } else {
          // a legacy raw journal file (saved before envelopes existed)
          loadJournalDoc(r.content, baseName);
        }
      }
    } catch (e: any) {
      onToast("error", "File error", e?.message || String(e));
    }
  };

  // run a save / save-as / open command sent from the sidebar or settings
  const lastJournalCmd = useRef<number>(0);
  useEffect(() => {
    if (!command || command.id === lastJournalCmd.current) return;
    lastJournalCmd.current = command.id;
    if (command.action === "save") void saveAsWorkflow();
    else if (command.action === "saveAs") setFileModal({ mode: "save" });
    else if (command.action === "open") setFileModal({ mode: "open" });
    else if (command.action === "exportGraph") exportGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // Export the journal as a CSV of every cell: its name, its SQL, and -- from
  // the dependency graph -- which cells it uses and which cells it feeds.
  const exportGraph = () => {
    const list = cellsRef.current;
    const g = buildGraph(list);
    const labelOf = (c: RunCell): string => {
      if (c.type === "sql") return c.name || c.id;
      if (c.type === "note") return "Note";
      if (c.type === "chart")
        return "Chart" + (c.sourceName ? ` (${c.sourceName})` : "");
      if (c.type === "pivot")
        return "Pivot" + (c.sourceName ? ` (${c.sourceName})` : "");
      if (c.type === "reconcile") return "Reconcile";
      return c.type;
    };
    const groupNameOf = (c: RunCell): string =>
      groups.find((g2) => g2.id === c.group)?.name || "";
    const csvRows = list.map((c) => ({
      label: labelOf(c),
      group: groupNameOf(c),
      sql: c.type === "sql" ? c.code || "" : "",
      uses: g.depNames[c.id] || [],
      feeds: g.dependentNames[c.id] || [],
    }));
    const csv = journalGraphCsv(csvRows);
    const base = (nbName || "journal").replace(/[\\/:*?"<>|]+/g, "_");
    saveToDownloads(`${base}.csv`, { text: csv })
      .then((r) => onToast("ok", "Journal exported", r.path))
      .catch((e: any) =>
        onToast("error", "Journal export failed", e?.message || String(e)),
      );
  };

  // Bucket cells by group for the columnar layout, preserving array order (and
  // thus each group's top-to-bottom run order) and each cell's GLOBAL index i
  // (used for cross-group source lists, which may reach any earlier cell).
  const grouped = useMemo(() => {
    const by = new Map<string, { c: RunCell; i: number }[]>();
    for (const g of groups) by.set(g.id, []);
    cells.forEach((c, i) => {
      const g = groupOf(c);
      (by.get(g) || by.set(g, []).get(g)!).push({ c, i });
    });
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, groupIdSet, groups]);

  return (
    <div className="nb" data-testid="journal-view" onKeyDown={onJournalKeyDown}>
      {confirmPop.ui}
      {fileModal && (
        <FileBrowser
          saveMode={fileModal.mode === "save"}
          defaultFileName={wfFileName(jwfName || nbName)}
          onClose={() => setFileModal(null)}
          onPick={onPickJournalFile}
        />
      )}
      {recovery && (
        <div className="nb-recovery">
          <Icon.Compare size={14} />
          <span>
            Recovered an unsaved notebook <strong>{recovery.name}</strong> from{" "}
            {relTime(recovery.at, nowTick)} ({recovery.cells.length} cell
            {recovery.cells.length === 1 ? "" : "s"}).
          </span>
          <span className="spacer" />
          <button className="btn sm primary" onClick={restoreRecovery}>
            Restore
          </button>
          <button className="btn sm" onClick={dismissRecovery}>
            Dismiss
          </button>
        </div>
      )}
      <div className="nb-toolbar">
        {(appVersion || appBuild) && (
          <span
            className="faint nb-version-stamp"
            style={{ marginLeft: "auto", order: 99, fontSize: 11 }}
            title="SamQL version · build date"
          >
            {appVersion ? `v${appVersion}` : ""}
            {appBuild ? ` · ${appBuild}` : ""}
          </span>
        )}
        {runningAll ? (
          <button
            className="btn sm danger"
            data-testid="journal-stop"
            onClick={cancelAll}
            title="Stop the running workflow"
          >
            <Icon.Square size={13} /> Stop
          </button>
        ) : (
          <button data-testid="journal-run-all" className="btn primary sm" onClick={runAll}>
            <Icon.Play size={13} /> Run all
          </button>
        )}
        {runningAll && journalProg && journalProg.total > 0 && (
          <span
            className="run-progress nb-run-progress"
            title={
              Math.round((journalProg.done / journalProg.total) * 100) +
              "% complete"
            }
          >
            <ProgressBar
              value={journalProg.done / journalProg.total}
              unit="cell"
              done={journalProg.done}
              total={journalProg.total}
            />
          </span>
        )}
        <span className="nb-tb-sep" />
        <label className="dim" style={{ fontSize: 12 }}>
          Engine
        </label>
        <select
          data-testid="journal-engine"
          value={target}
          onChange={(e) => onTargetChange?.(e.target.value)}
          style={{ padding: "5px 8px" }}
          title="Engine cells run on — shared with the SQL editor"
        >
          <option value="auto">Auto-route</option>
          <option value="__local__">SQLite</option>
          <option value="__duckdb__" disabled={!features?.duckdb}>
            DuckDB{features?.duckdb ? "" : " (n/a)"}
          </option>
        </select>
        <label className="dim" style={{ fontSize: 12 }}>
          Dialect
        </label>
        <select
          value={dialect || "native"}
          onChange={(e) => onDialectChange?.(e.target.value)}
          style={{ padding: "5px 8px" }}
          title="Input SQL dialect — shared with the editor. Spark SQL is translated to the engine's dialect before running (needs sqlglot); unsupported constructs are reported, not run."
        >
          <option value="native">Native SQL</option>
          <option value="spark">Spark SQL</option>
        </select>
        <span className="nb-tb-sep" />
        <button
          className="btn sm"
          disabled={!canUndoNb}
          onClick={undoNb}
          title="Undo (Ctrl+Z)"
        >
          <Icon.Undo size={13} />
        </button>
        <button
          className="btn sm"
          disabled={!canRedoNb}
          onClick={redoNb}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Icon.Redo size={13} />
        </button>
        <span className="nb-tb-sep" />
        <button
          className="btn sm"
          onClick={addGroup}
          title="Add a new group to the right"
        >
          <Icon.Grid size={13} /> New Group
        </button>
        <span className="nb-tb-sep" />
        <span className="spacer" />
        <span className="nb-save" data-state={saveState} title="Journal autosaves to this browser">
          <span className="nb-save-dot" />
          {saveState === "saving"
            ? "Saving…"
            : savedAt
              ? `Saved ${relTime(savedAt, nowTick)}`
              : "Saved"}
        </span>
        <span className="nb-tb-sep" />
        <span className="nb-hint">
          {cells.filter((c) => c.type === "sql").length} SQL ·{" "}
          {cells.filter((c) => c.type === "note").length} note · chain with{" "}
          <code className="nb-code">cellN</code>
          {groups.length > 1 && (
            <>
              {" "}
              · a later group can use{" "}
              <code className="nb-code">"GroupName"</code>
            </>
          )}
        </span>
      </div>

      {/* .473: journal tabs on their OWN row, under Run all / engine /
          dialect / undo-redo / new group -- consistent with where the
          IDE and NodeFlow keep their tab strips. */}
      <div className="nb-jtab-row">
        <div className="tabs nb-jtabs">
          {nbList.map((m) => (
            <div
              key={m.id}
              className={"tab" + (m.id === nbId ? " active" : "")}
              onClick={() => switchTo(m.id)}
              title={
                m.id === nbId
                  ? "This journal (autosaved)"
                  : "Open \"" + m.name + "\" \u00b7 " +
                    relTime(m.updatedAt, nowTick)
              }
            >
              <Icon.File size={13} />
              {renamingJ?.id === m.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  value={renamingJ.draft}
                  onChange={(e) =>
                    setRenamingJ({ id: m.id, draft: e.target.value })
                  }
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRenameJ();
                    else if (e.key === "Escape") setRenamingJ(null);
                  }}
                  onBlur={commitRenameJ}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingJ({ id: m.id, draft: m.name });
                  }}
                  title="Double-click to rename"
                >
                  {m.name}
                </span>
              )}
              <span
                className="close"
                title="Delete this journal"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteJournal(m.id);
                }}
              >
                <Icon.X size={12} />
              </span>
            </div>
          ))}
          <button
            className="btn ghost icon"
            title="New journal"
            onClick={newNotebook}
            style={{ margin: "auto 6px" }}
          >
            <Icon.Plus size={16} />
          </button>
        </div>

      </div>

      <div className="nb-scroll">
        {cells.length === 0 && groups.length === 1 ? (
          <div className="empty">
            <div className="inner">
              <Icon.Grid size={26} className="faint" />
              <p>Empty journal.</p>
              <button
                className="btn sm"
                onClick={() => addCell("sql", groups[0]?.id)}
              >
                <Icon.Plus size={13} /> Add a SQL cell
              </button>
            </div>
          </div>
        ) : (
          <div className="nb-groups">
            {groups.map((g) => {
              const gc = grouped.get(g.id) || [];
              return (
                <div className="nb-group" key={g.id} data-collapsed={g.collapsed ? "1" : undefined}>
                  <div className="nb-group-head">
                    <button
                      className="btn sm ghost nb-group-caret"
                      title={g.collapsed ? "Expand group" : "Collapse group"}
                      onClick={() => toggleGroupCollapse(g.id)}
                    >
                      {g.collapsed ? "▸" : "▾"}
                    </button>
                    <input
                      className="nb-group-name"
                      value={g.name}
                      onChange={(e) => renameGroup(g.id, e.target.value)}
                      title="Rename this group"
                      spellCheck={false}
                    />
                    {g.collapsed && (
                      <span className="faint nb-group-count">
                        {gc.length} cell{gc.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {groups.length > 1 && (
                      <button
                        className="btn sm ghost nb-group-x"
                        title="Delete this group"
                        onClick={() => deleteGroup(g.id)}
                      >
                        <Icon.X size={13} />
                      </button>
                    )}
                  </div>
                  {!g.collapsed && (
                  <div className="nb-group-cells">
                    {gc.length === 0 ? (
                      <div className="nb-group-empty faint">
                        Empty group.{" "}
                        <button
                          className="btn sm nb-empty-add"
                          onClick={() => addCell("sql", g.id)}
                          title="Add the first cell to this group"
                        >
                          <Icon.Plus size={13} /> SQL
                        </button>
                      </div>
                    ) : (
                      gc.map(({ c, i }, k) => (
                        <NotebookCell
                          key={c.id}
              cell={c}
              index={sqlIndex[c.id]}
              tables={tables}
              canMoveUp={k > 0}
              canMoveDown={k < gc.length - 1}
              onChangeCode={(v) => patch(c.id, { code: v })}
              onChangeText={(v) => patch(c.id, { text: v })}
              onRun={() => runCell(c.id)}
              onCancel={() => cancelCell(c.id)}
              onDelete={(e?: any) => {
                // .533: a cell WITH content asks first (the node-style
                // in-window popup); an empty cell deletes silently.
                const has = (
                  ((c as any).code || "") + ((c as any).text || "")
                ).trim();
                if (!has) return deleteCell(c.id);
                confirmPop.ask(
                  (e?.currentTarget as HTMLElement) || {
                    left: window.innerWidth / 2 - 94,
                    top: 140,
                    side: "right",
                  },
                  "Delete this cell?",
                  () => deleteCell(c.id),
                );
              }}
              onMove={(dir) => moveCell(c.id, dir)}
              stale={!!staleById[c.id]}
              deps={graph.depNames[c.id] || []}
              dependents={graph.dependentNames[c.id] || []}
              onRunUpstream={() => runWithUpstream(c.id)}
              onRunDownstream={() => runWithDownstream(c.id)}
              onRunBranch={() => runBranch(c.id)}
              sources={
                c.type === "chart" || c.type === "pivot"
                  ? cells
                      .slice(0, i)
                      .filter((s) => s.type === "sql" && s.ranOnce && s.resultId)
                      .map((s) => ({
                        name: s.name as string,
                        resultId: s.resultId ?? null,
                        columns: s.page?.columns || [],
                      }))
                  : undefined
              }
              onSetSource={(name) => patch(c.id, { sourceName: name })}
              onRename={(name) => renameCell(c.id, name)}
              onSourceExpired={() => {
                const src = cells.find(
                  (s) => s.type === "sql" && s.name === c.sourceName,
                );
                if (src) void runCell(src.id);
              }}
              reconSources={
                c.type === "reconcile"
                  ? [
                      ...cells
                        .slice(0, i)
                        .filter((s) => s.type === "sql" && s.ranOnce && s.name)
                        .map((s) => ({
                          name: s.name as string,
                          columns: s.page?.columns || [],
                        })),
                      ...tables.map((t) => ({
                        name: t.name,
                        columns: t.columns.map((col) => col.name),
                      })),
                    ]
                  : undefined
              }
              onSetReconSource={(which, name) =>
                patch(
                  c.id,
                  which === "left"
                    ? { leftSource: name }
                    : { rightSource: name },
                )
              }
              onSetReconSpec={(spec) => patch(c.id, { recon: spec })}
              onRunReconcile={() => runReconcile(c.id)}
              onReconDrill={(bucket, field) =>
                reconCellDrill(c.id, bucket, field)
              }
              onReconProfile={(bucket, field) =>
                reconCellProfile(c.id, bucket, field)
              }
              onReconDetailClose={() => patch(c.id, { reconDetail: null })}
              reconNeedsManualRefresh={
                c.type === "reconcile" &&
                !!c.reconRanSpec &&
                reconInputSig(c, cells, tables) !== c.reconRanSig &&
                !reconAutoEligible(c, cells, tables)
              }
              onReorderStart={(e) => startCellDrag(c.id, e)}
              dropEdge={dropTarget?.id === c.id ? dropTarget.edge : null}
              dragging={dragId === c.id}
              onAddBelow={(type) => addCell(type, groupOf(c), c.id)}
              onToggleCollapse={() => toggleCollapse(c.id)}
              onResize={(w, h) => patch(c.id, { boxW: w, boxH: h })}
              onSetOutView={(v) => patch(c.id, { outView: v })}
              onSort={(col) => doSort(c.id, col)}
              onLoadMore={() => loadMore(c.id)}
              onExport={(fmt) => exportCell(c.id, fmt)}
              features={features}
              onToast={onToast}
            />
                      ))
                    )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
