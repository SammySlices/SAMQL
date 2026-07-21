import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { startPointerDrag } from "../lib/pointerDrag";
import { api, saveToDownloads } from "../lib/api";
import { pivotCsv, pivotCsvFilename } from "../lib/pivotExport";
import {
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
  wasCancelled,
} from "../lib/runController";
import type {
  TableInfo,
  PivotResult,
  PivotAgg,
  Cell,
} from "../lib/types";
import {
  defaultPivotAgg,
  fieldRole,
  groupColumnsByRole,
  inferColumnTypes,
  roleLabel,
  shortFieldType,
  type FieldRole,
} from "../lib/fieldRoles";
import { Icon } from "./Icon";

// ---- field drawer source --------------------------------------------------
interface ResultSource {
  id: string;
  columns: string[];
  /** Optional SQL / inferred types keyed by column name. */
  columnTypes?: Record<string, string> | null;
  /** Sample rows used to infer types when columnTypes is absent. */
  sampleRows?: Cell[][] | null;
}

interface Props {
  tables: TableInfo[];
  result?: ResultSource | null;
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  onExpired?: () => void;
  onPopOut?: () => void;
}

type TileKind = "rows" | "cols" | "filters" | "values";

interface ValueItem {
  id: number;
  field: string | null;
  agg: PivotAgg;
}
interface FilterItem {
  id: number;
  field: string;
  op: string;
  value?: string;
  value2?: string;
  values?: string[];
}

interface DragPayload {
  field?: string;
  from: TileKind | "drawer";
  id?: number;
}

const RESULT_SRC = "__result__";

const AGGS: { value: PivotAgg; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "count", label: "Count" },
  { value: "count_distinct", label: "Count (distinct)" },
];

const OPS: { value: string; label: string; arity: 0 | 1 | 2 | "list" }[] = [
  { value: "equals", label: "equals", arity: 1 },
  { value: "not_equals", label: "does not equal", arity: 1 },
  { value: "contains", label: "contains", arity: 1 },
  { value: "not_contains", label: "does not contain", arity: 1 },
  { value: "starts_with", label: "starts with", arity: 1 },
  { value: "ends_with", label: "ends with", arity: 1 },
  { value: "gt", label: "greater than", arity: 1 },
  { value: "lt", label: "less than", arity: 1 },
  { value: "gte", label: "at least (≥)", arity: 1 },
  { value: "lte", label: "at most (≤)", arity: 1 },
  { value: "between", label: "between", arity: 2 },
  { value: "in", label: "is one of", arity: "list" },
  { value: "not_in", label: "is not one of", arity: "list" },
  { value: "is_null", label: "is blank", arity: 0 },
  { value: "not_null", label: "is not blank", arity: 0 },
];

const OP_SYM: Record<string, string> = {
  equals: "=",
  not_equals: "≠",
  contains: "⊃",
  not_contains: "⊅",
  starts_with: "^",
  ends_with: "$",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
};

function aggLabel(v: ValueItem): string {
  if (!v.field) return "Count";
  const short: Record<PivotAgg, string> = {
    sum: "Sum",
    avg: "Avg",
    min: "Min",
    max: "Max",
    count: "Count",
    count_distinct: "Count≠",
  };
  return `${short[v.agg]} of ${v.field}`;
}

function filterLabel(f: FilterItem): string {
  if (f.op === "is_null") return `${f.field} is blank`;
  if (f.op === "not_null") return `${f.field} is not blank`;
  if (f.op === "in" || f.op === "not_in") {
    const n = (f.values || []).length;
    const word = f.op === "in" ? "in" : "not in";
    return `${f.field} ${word} (${n})`;
  }
  if (f.op === "between")
    return `${f.field} ${f.value ?? "?"}–${f.value2 ?? "?"}`;
  const sym = OP_SYM[f.op] || f.op;
  return `${f.field} ${sym} ${f.value ?? ""}`.trim();
}

function fmtCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v)
      ? v.toLocaleString()
      : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(v);
}

const PivotPanelImpl: React.FC<Props> = ({ tables, result, onToast, onExpired, onPopOut }) => {
  const idRef = useRef(1);
  const nextId = () => idRef.current++;

  // source: the current result (if present) or a loaded table
  const [source, setSource] = useState<string>(
    result ? RESULT_SRC : tables[0]?.name ?? "",
  );
  useEffect(() => {
    // if the result disappears and we were pointed at it, fall back to a table
    if (source === RESULT_SRC && !result) {
      setSource(tables[0]?.name ?? "");
    }
    // adopt a result the first time one appears and nothing is chosen
    if (!source && (result || tables[0])) {
      setSource(result ? RESULT_SRC : tables[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, tables]);

  const sourceCols = useMemo(() => {
    if (source === RESULT_SRC) return result?.columns ?? [];
    return (tables.find((t) => t.name === source)?.columns ?? []).map(
      (c) => c.name,
    );
  }, [source, result, tables]);
  const sourceTypes = useMemo(() => {
    if (source === RESULT_SRC) {
      if (result?.columnTypes && Object.keys(result.columnTypes).length) {
        return result.columnTypes;
      }
      return inferColumnTypes(result?.columns ?? [], result?.sampleRows);
    }
    const cols = tables.find((t) => t.name === source)?.columns ?? [];
    const out: Record<string, string> = {};
    for (const c of cols) {
      if (c.type) out[c.name] = c.type;
    }
    return out;
  }, [source, result, tables]);
  const sourceEngine = useMemo(
    () => tables.find((t) => t.name === source)?.engine,
    [source, tables],
  );
  // Identity of the data behind the current source: the result id when the
  // source is "Current result" (so switching result tabs recomputes instead of
  // reusing the stale aggregate), else the table name. Included in specKey and
  // the layout-reset gate below.
  const srcId = source === RESULT_SRC ? result?.id ?? "" : source;

  const [rows, setRows] = useState<string[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [values, setValues] = useState<ValueItem[]>([]);
  const [filters, setFilters] = useState<FilterItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [fieldQuery, setFieldQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | FieldRole>("all");

  // editing popovers
  const [valEdit, setValEdit] = useState<{ id: number; x: number; y: number } | null>(
    null,
  );
  const [filEdit, setFilEdit] = useState<{ id: number; x: number; y: number } | null>(
    null,
  );
  const valPopTrigger = useRef<HTMLElement | null>(null);
  const filPopTrigger = useRef<HTMLElement | null>(null);
  const valPopRef = useRef<HTMLDivElement | null>(null);
  const filPopRef = useRef<HTMLDivElement | null>(null);
  const closeValEdit = useCallback((restoreFocus = true) => {
    const trigger = valPopTrigger.current;
    valPopTrigger.current = null;
    setValEdit(null);
    if (restoreFocus && trigger && document.contains(trigger)) trigger.focus();
  }, []);
  const closeFilEdit = useCallback((restoreFocus = true) => {
    const trigger = filPopTrigger.current;
    filPopTrigger.current = null;
    setFilEdit(null);
    if (restoreFocus && trigger && document.contains(trigger)) trigger.focus();
  }, []);
  const focusPopover = useCallback((root: HTMLDivElement | null) => {
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable || root).focus();
  }, []);
  useLayoutEffect(() => {
    if (valEdit) focusPopover(valPopRef.current);
  }, [valEdit, focusPopover]);
  useLayoutEffect(() => {
    if (filEdit) focusPopover(filPopRef.current);
  }, [filEdit, focusPopover]);
  // Escape closes whichever editing popover is open (no full modal needed).
  useEffect(() => {
    if (!valEdit && !filEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (valEdit) closeValEdit();
        else if (filEdit) closeFilEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [valEdit, filEdit, closeValEdit, closeFilEdit]);

  const [data, setData] = useState<PivotResult | null>(null);
  const [loading, setLoading] = useState(false);
  // set when the backing result has expired: shows an explicit re-run prompt
  // instead of leaving the panel stuck on "Building…".
  const [expired, setExpired] = useState(false);
  // .471: the running aggregate is a registered, cancellable run --
  // Stop (or a superseding spec change, or unmount) interrupts the
  // backend statement exactly like a query cell's Stop.
  const inflight = React.useRef<{
    qid: string;
    ctrl: AbortController;
  } | null>(null);
  // Debounce timer + stop-before-start: Stop is visible while loading=true
  // for the 300ms settle window, before inflight exists. Without these,
  // stopPivot was a no-op and the aggregate still fired.
  const pendingTimer = React.useRef<number | null>(null);
  const stopRequested = React.useRef(false);
  const cancelInflight = React.useCallback(() => {
    const cur = inflight.current;
    if (!cur) return;
    inflight.current = null;
    cancelOne(cur.qid, cur.ctrl);
  }, []);
  const stopPivot = React.useCallback(() => {
    stopRequested.current = true;
    if (pendingTimer.current != null) {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    cancelInflight();
    setLoading(false);
  }, [cancelInflight]);
  const [elapsed, setElapsed] = useState(0);

  // reset the layout when the underlying source changes (fields differ). Keyed
  // on srcId, not source, so switching result tabs (same "Current result"
  // slot, different result id) also resets instead of reusing a stale layout.
  const firstSrc = useRef(srcId);
  useEffect(() => {
    if (firstSrc.current !== srcId) {
      firstSrc.current = srcId;
      setRows([]);
      setCols([]);
      setValues([]);
      setFilters([]);
      setData(null);
      setExpired(false);
      setValEdit(null);
      setFilEdit(null);
      valPopTrigger.current = null;
      filPopTrigger.current = null;
    }
  }, [srcId]);

  // ---- drag and drop ------------------------------------------------------
  const startDrag = (e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };
  const readPayload = (e: React.DragEvent): DragPayload | null => {
    try {
      return JSON.parse(e.dataTransfer.getData("text/plain"));
    } catch {
      return null;
    }
  };

  const fieldOf = (p: DragPayload): string | null => {
    if (p.field) return p.field;
    if (p.from === "values" && p.id != null)
      return values.find((v) => v.id === p.id)?.field ?? null;
    if (p.from === "filters" && p.id != null)
      return filters.find((f) => f.id === p.id)?.field ?? null;
    return null;
  };

  const dropOnAxis = (
    target: "rows" | "cols",
    p: DragPayload,
    atIndex?: number,
  ) => {
    const field = fieldOf(p);
    if (!field) return;
    const setT = target === "rows" ? setRows : setCols;
    const setOther = target === "rows" ? setCols : setRows;
    // remove the field from the opposite axis no matter where the drag came
    // from -- a drawer field dropped on cols must leave rows (and vice versa)
    // so the same field never sits in both axes.
    if (p.from !== target) {
      setOther((prev) => prev.filter((f) => f !== field));
    }
    setT((prev) => {
      const without = prev.filter((f) => f !== field);
      const at = atIndex == null ? without.length : Math.min(atIndex, without.length);
      without.splice(at, 0, field);
      return [...without];
    });
  };

  const dropOnValues = (p: DragPayload, atIndex?: number) => {
    if (p.from === "values" && p.id != null) {
      setValues((prev) => {
        const idx = prev.findIndex((v) => v.id === p.id);
        if (idx < 0) return prev;
        const item = prev[idx];
        const without = prev.filter((v) => v.id !== p.id);
        const at = atIndex == null ? without.length : Math.min(atIndex, without.length);
        without.splice(at, 0, item);
        return [...without];
      });
      return;
    }
    const field = fieldOf(p);
    if (!field) return;
    setValues((prev) => {
      const item: ValueItem = {
        id: nextId(),
        field,
        agg: defaultPivotAgg(sourceTypes[field]),
      };
      const at = atIndex == null ? prev.length : Math.min(atIndex, prev.length);
      const copy = [...prev];
      copy.splice(at, 0, item);
      return copy;
    });
  };

  const dropOnFilters = (
    p: DragPayload,
    atIndex: number | undefined,
    openAfter: (id: number) => void,
  ) => {
    if (p.from === "filters" && p.id != null) {
      setFilters((prev) => {
        const idx = prev.findIndex((f) => f.id === p.id);
        if (idx < 0) return prev;
        const item = prev[idx];
        const without = prev.filter((f) => f.id !== p.id);
        const at = atIndex == null ? without.length : Math.min(atIndex, without.length);
        without.splice(at, 0, item);
        return [...without];
      });
      return;
    }
    const field = fieldOf(p);
    if (!field) return;
    const id = nextId();
    setFilters((prev) => {
      const item: FilterItem = { id, field, op: "equals", value: "" };
      const at = atIndex == null ? prev.length : Math.min(atIndex, prev.length);
      const copy = [...prev];
      copy.splice(at, 0, item);
      return copy;
    });
    openAfter(id);
  };

  // ---- auto-run -----------------------------------------------------------
  const canRun = sourceCols.length > 0 && (rows.length > 0 || cols.length > 0);
  const specKey = JSON.stringify({
    srcId,
    engine: sourceEngine ?? null,
    rows,
    cols,
    values,
    filters,
  });

  useEffect(() => {
    if (!canRun) {
      setData(null);
      return;
    }
    let alive = true;
    stopRequested.current = false;
    setExpired(false);
    setLoading(true);
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(
      () => alive && setElapsed(Date.now() - started),
      100,
    );
    pendingTimer.current = window.setTimeout(async () => {
      pendingTimer.current = null;
      if (!alive || stopRequested.current) {
        if (alive) {
          setLoading(false);
          window.clearInterval(timer);
        }
        return;
      }
      cancelInflight(); // a superseding run cancels the one in flight
      const ctrl = new AbortController();
      const qid =
        "pivot-" + Math.random().toString(36).slice(2, 12);
      inflight.current = { qid, ctrl };
      registerRun(qid, ctrl);
      const vals = values.map((v) => ({ field: v.field, agg: v.agg }));
      const fils = filters
        .filter(
          (f) =>
            f.op === "is_null" ||
            f.op === "not_null" ||
            (f.op === "in" || f.op === "not_in"
              ? (f.values || []).length > 0
              : f.op === "between"
                ? // a between needs BOTH bounds; a half-filled one used to be
                  // dispatched with the other bound empty -> a wrong/unbounded
                  // aggregate. Wait until both are set.
                  (f.value ?? "") !== "" && (f.value2 ?? "") !== ""
                : (f.value ?? "") !== ""),
        )
        .map((f) => ({
          field: f.field,
          op: f.op,
          value: f.value,
          value2: f.value2,
          values: f.values,
        }));
      try {
        const res = await api.pivot(
          {
            result_id: source === RESULT_SRC ? result?.id : undefined,
            table: source === RESULT_SRC ? undefined : source,
            engine: sourceEngine,
            rows,
            cols,
            values: vals.length ? vals : undefined,
            filters: fils,
            query_id: qid,
          },
          ctrl.signal,
        );
        if (!alive || stopRequested.current || wasCancelled(qid) || ctrl.signal.aborted)
          return;
        if (res.error) {
          // Soft cancel: keep the previous grid (matches reconcile / VERSION).
          if (/interrupt|cancel/i.test(res.error) || wasCancelled(qid)) {
            onToast("warn", "Pivot cancelled", "Stopped at your request.");
            return;
          }
          if (res.error === "result expired") {
            setExpired(true);
            setData(null);
            // notify the host if it wired a handler; otherwise surface it here
            // so an expired result is never silent (no permanent "Building…").
            if (onExpired) onExpired();
            else
              onToast(
                "warn",
                "Result expired",
                "Re-run the query to pivot it again.",
              );
            return;
          }
          onToast("error", "Pivot failed", res.error);
          setData(null);
        } else {
          setData(res);
        }
      } catch (e: any) {
        // a cancel is not a failure -- the previous grid stays put
        if (
          alive &&
          !ctrl.signal.aborted &&
          !wasCancelled(qid) &&
          !isCancelledError(e, qid)
        )
          onToast("error", "Pivot failed", e?.message);
      } finally {
        unregisterRun(qid, ctrl);
        if (inflight.current && inflight.current.qid === qid)
          inflight.current = null;
        if (alive) {
          setLoading(false);
          window.clearInterval(timer);
        }
      }
    }, 300);
    return () => {
      alive = false;
      if (pendingTimer.current != null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
      window.clearInterval(timer);
      stopPivot(); // spec change / unmount frees the backend too
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  const usedAxis = new Set<string>([
    ...rows,
    ...cols,
    ...values.map((v) => v.field).filter((f): f is string => !!f),
    ...filters.map((f) => f.field),
  ]);
  const fieldList = sourceCols.filter((c) => {
    if (!c.toLowerCase().includes(fieldQuery.trim().toLowerCase())) return false;
    if (roleFilter === "all") return true;
    return fieldRole(sourceTypes[c]) === roleFilter;
  });
  const fieldGroups = groupColumnsByRole(fieldList, sourceTypes);
  const hasTypedFields = Object.keys(sourceTypes).length > 0;

  const nDims = rows.length;

  // Result-grid column sort + resize -- shared by the IDE and the Journal
  // since both render this panel. Sort reorders a copy of the rows; resize
  // measures the natural widths once, then locks the grid to a fixed layout
  // whose per-column widths are draggable.
  const gridRef = useRef<HTMLTableElement>(null);
  const [sort, setSort] = useState<{
    col: number;
    dir: "asc" | "desc";
  } | null>(null);
  const [colW, setColW] = useState<number[] | null>(null);
  const colSig = data ? data.columns.join("\u0001") : "";
  // a new pivot shape clears any sort + forces a re-measure of widths
  useEffect(() => {
    setSort(null);
    setColW(null);
  }, [colSig]);
  // measure natural column widths once per shape, then switch to fixed layout
  useLayoutEffect(() => {
    if (colW || !data) return;
    const ths = gridRef.current?.querySelectorAll("thead th");
    if (ths && ths.length === data.columns.length) {
      setColW(Array.from(ths).map((th) => (th as HTMLElement).offsetWidth));
    }
  }, [colW, data]);
  const toggleSort = (i: number) =>
    setSort((s) =>
      !s || s.col !== i
        ? { col: i, dir: "asc" }
        : s.dir === "asc"
          ? { col: i, dir: "desc" }
          : null,
    );
  const startResize = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const base = colW ?? [];
    const startW = base[i] ?? 100;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(44, startW + (ev.clientX - startX));
      setColW((prev) => {
        const next = [...(prev ?? base)];
        next[i] = w;
        return next;
      });
    };
    startPointerDrag({ onMove });
  };
  const viewRows = useMemo(() => {
    if (!data) return [];
    if (!sort || sort.col >= data.columns.length) return data.rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...data.rows].sort((a, b) => {
      const x = a[sort.col];
      const y = b[sort.col];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "number" && typeof y === "number")
        return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }, [data, sort]);

  // Export the pivot as it is sorted on screen. Collapsed groups are not folded
  // out: the file carries the whole pivot, since collapsing is a reading aid
  // rather than a filter.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (!data || !data.rows.length || exporting) return;
    setExporting(true);
    try {
      const name = pivotCsvFilename(
        source === RESULT_SRC ? "result" : source,
      );
      const saved = await saveToDownloads(name, {
        text: pivotCsv(data.columns, viewRows),
      });
      onToast("ok", "Exported", saved.path);
    } catch (e: any) {
      onToast("error", "Export failed", e?.message || String(e));
    } finally {
      setExporting(false);
    }
  };

  // Collapse/expand for nested row groups: a chevron on each non-leaf row-
  // dimension cell folds that group's children into one representative row, so
  // one parent can stay expanded while another is collapsed. When subtotals are
  // on, that group's own subtotal row is promoted to the representative -- its
  // rolled-up values show in place of the hidden detail (Excel / Tableau
  // "collapse to subtotal"); otherwise the representative shows blanked values
  // and a count of what is hidden. Only meaningful while rows are in dimension
  // order, so it is disabled when sorted by a value.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCollapsed(new Set());
  }, [colSig]);
  const canCollapse = nDims > 1 && (!sort || sort.col < nDims);
  const prefixKey = (r: Cell[], k: number) => JSON.stringify(r.slice(0, k + 1));
  // A row that is the subtotal totalling exactly the group collapsed at `lvl`:
  // the 'Total' marker sits in dimension `lvl` and every dimension after it is
  // blank -- the shape the backend emits for a ROLLUP subtotal at that level.
  // This panel's pivot always comes from api.pivot (_pivot_inner), which does a
  // plain GROUP BY and never emits ROLLUP "Total" subtotal rows. So matching a
  // dimension value against the literal "Total" could only ever be a FALSE
  // positive — a genuine innermost value of "Total" would be promoted as a
  // group's subtotal and its siblings blanked, fabricating aggregates. With no
  // real subtotal rows to find, detection is disabled; collapse falls back to
  // the correct blanked-representative + hidden-count behaviour. (If backend
  // ROLLUP subtotals are ever wired into this panel, drive this off an explicit
  // per-row flag from the backend rather than string-matching the value.)
  const isGroupSubtotal = useCallback(
    (_r: Cell[], _lvl: number) => false,
    [],
  );
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const displayRows = useMemo(() => {
    const rows = viewRows;
    const out: {
      r: Cell[];
      collapsedAt: number;
      count: number;
      subtotal: boolean;
    }[] = [];
    if (!canCollapse) {
      for (const r of rows)
        out.push({ r, collapsedAt: -1, count: 0, subtotal: false });
      return out;
    }
    let supLevel = -1; // when >=0, we are skipping rows inside a collapsed group
    let supKey = "";
    let repIdx = -1; // index in out of that group's representative row
    for (const r of rows) {
      if (supLevel >= 0) {
        if (prefixKey(r, supLevel) === supKey) {
          if (repIdx >= 0) {
            // promote this group's own subtotal to the representative row so
            // the collapsed line shows the rolled-up values (once only; any
            // further matching row just counts as hidden).
            if (!out[repIdx].subtotal && isGroupSubtotal(r, supLevel + 1)) {
              out[repIdx].count++; // the detail row it replaces is now hidden
              out[repIdx].r = r;
              out[repIdx].subtotal = true;
            } else {
              out[repIdx].count++;
            }
          }
          continue; // hidden child of a collapsed group
        }
        supLevel = -1;
        supKey = "";
      }
      let collAt = -1; // shallowest collapsed ancestor governs
      for (let k = 0; k <= nDims - 2; k++) {
        if (collapsed.has(prefixKey(r, k))) {
          collAt = k;
          break;
        }
      }
      out.push({ r, collapsedAt: collAt, count: 0, subtotal: false });
      if (collAt >= 0) {
        supLevel = collAt;
        supKey = prefixKey(r, collAt);
        repIdx = out.length - 1;
      }
    }
    return out;
  }, [viewRows, collapsed, canCollapse, nDims, isGroupSubtotal]);

  // ---- render -------------------------------------------------------------
  const Tile = (
    kind: TileKind,
    title: string,
    hint: string,
    children: React.ReactNode,
  ) => (
    <div
      className={"pv-tile pv-" + kind}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const p = readPayload(e);
        if (!p) return;
        if (kind === "rows" || kind === "cols") dropOnAxis(kind, p);
        else if (kind === "values") dropOnValues(p);
        else
          dropOnFilters(p, undefined, (id) =>
            setFilEdit({ id, x: 0, y: 0 }),
          );
      }}
    >
      <div className="pv-tile-head">{title}</div>
      <div className="pv-chips">
        {children}
        {React.Children.count(children) === 0 && (
          <div className="pv-tile-hint">{hint}</div>
        )}
      </div>
    </div>
  );

  const axisChip = (kind: "rows" | "cols", field: string, idx: number) => (
    <div
      key={field}
      className="pv-chip"
      draggable
      onDragStart={(e) => startDrag(e, { field, from: kind, id: idx })}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = readPayload(e);
        if (p) dropOnAxis(kind, p, idx);
      }}
      title={field}
    >
      <span className="pv-grip">⋮⋮</span>
      <span className="pv-chip-label">{field}</span>
      <button
        className="pv-chip-x"
        title="Remove"
        onClick={() =>
          kind === "rows"
            ? setRows(rows.filter((f) => f !== field))
            : setCols(cols.filter((f) => f !== field))
        }
      >
        <Icon.X size={12} />
      </button>
    </div>
  );

  return (
    <div className="pivot-panel">
      <div className="pv-bar">
        <button
          className={"btn ghost sm" + (drawerOpen ? " on" : "")}
          onClick={() => setDrawerOpen((v) => !v)}
          title="Show the list of fields"
        >
          <Icon.Table size={14} /> Fields
        </button>
        <div className="pv-src">
          <label>Source</label>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {result && <option value={RESULT_SRC}>Current result</option>}
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <span className="spacer" />
        {data?.truncated && <span className="pv-note">{data.note}</span>}
        {loading && (
          <span className="pv-status">
            <span className="pv-status-bar">
              <span className="pv-status-fill" />
            </span>
            {(elapsed / 1000).toFixed(1)}s
          </span>
        )}
        {loading && (
          <button
            className="btn ghost sm"
            data-testid="pivot-stop"
            title="Cancel this pivot (interrupts the backend aggregate)"
            onClick={stopPivot}
          >
            ■ Stop
          </button>
        )}
        <button
          className="btn ghost sm"
          data-testid="pivot-export-csv"
          disabled={!data || !data.rows.length || exporting}
          title={
            data && data.rows.length
              ? "Export this pivot to a CSV file in Downloads"
              : "Run a pivot first"
          }
          onClick={exportCsv}
        >
          <Icon.Download size={14} /> {exporting ? "Exporting…" : "Export CSV"}
        </button>
        {onPopOut && (
          <button
            className="btn ghost sm pv-popout"
            title="Open the pivot in a floating window"
            onClick={onPopOut}
          >
            <Icon.PopOut size={14} />
          </button>
        )}
      </div>

      <div className="pv-body">
        {drawerOpen && (
          <div className="pv-drawer">
            <div className="pv-drawer-head">Fields</div>
            <input
              className="pv-field-search"
              placeholder="Search fields…"
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
            />
            {hasTypedFields && (
              <div className="pv-role-filters" role="group" aria-label="Field type filter">
                {(
                  [
                    ["all", "All"],
                    ["dimension", "Dim"],
                    ["measure", "Num"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={
                      "pv-role-chip" + (roleFilter === id ? " on" : "")
                    }
                    onClick={() => setRoleFilter(id)}
                    title={
                      id === "all"
                        ? "Show every field"
                        : id === "dimension"
                          ? "Show dimensions (text, date, bool…)"
                          : "Show measures (numeric)"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="pv-field-list">
              {(hasTypedFields
                ? (
                    [
                      ["dimension", fieldGroups.dimensions],
                      ["measure", fieldGroups.measures],
                      ["unknown", fieldGroups.other],
                    ] as [FieldRole, string[]][]
                  ).flatMap(([role, items]) =>
                    items.length
                      ? [
                          <div key={`sec-${role}`} className="pv-field-section">
                            {roleLabel(role)}
                          </div>,
                          ...items.map((f) => (
                            <div
                              key={f}
                              className={
                                "pv-field" +
                                (usedAxis.has(f) ? " used" : "") +
                                (fieldRole(sourceTypes[f]) === "measure"
                                  ? " pv-field-measure"
                                  : " pv-field-dim")
                              }
                              draggable
                              onDragStart={(e) =>
                                startDrag(e, { field: f, from: "drawer" })
                              }
                              title={`${f}${sourceTypes[f] ? ` · ${sourceTypes[f]}` : ""}\nDrag into a tile`}
                            >
                              <span className="pv-grip">⋮⋮</span>
                              <span className="pv-field-name">{f}</span>
                              <span
                                className={
                                  "pv-ftype" +
                                  (fieldRole(sourceTypes[f]) === "measure"
                                    ? " measure"
                                    : " dim")
                                }
                              >
                                {shortFieldType(sourceTypes[f])}
                              </span>
                            </div>
                          )),
                        ]
                      : [],
                  )
                : fieldList.map((f) => (
                    <div
                      key={f}
                      className={"pv-field" + (usedAxis.has(f) ? " used" : "")}
                      draggable
                      onDragStart={(e) =>
                        startDrag(e, { field: f, from: "drawer" })
                      }
                      title="Drag into a tile"
                    >
                      <span className="pv-grip">⋮⋮</span>
                      {f}
                    </div>
                  )))}
              {fieldList.length === 0 && (
                <div className="pv-tile-hint">No matching fields.</div>
              )}
            </div>
          </div>
        )}

        <div className="pv-main">
          <div className="pv-tiles">
            {Tile(
              "filters",
              "Filters",
              "Drop fields here to filter",
              filters.map((f) => (
                <div
                  key={f.id}
                  className="pv-chip pv-chip-filter"
                  draggable
                  onDragStart={(e) =>
                    startDrag(e, { from: "filters", id: f.id, field: f.field })
                  }
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const p = readPayload(e);
                    const idx = filters.findIndex((x) => x.id === f.id);
                    if (p)
                      dropOnFilters(p, idx, (id) => setFilEdit({ id, x: 0, y: 0 }));
                  }}
                >
                  <button
                    className="pv-chip-label as-btn"
                    onClick={(e) => {
                      filPopTrigger.current = e.currentTarget;
                      setFilEdit({ id: f.id, x: e.clientX, y: e.clientY });
                    }}
                    title="Edit filter"
                  >
                    {filterLabel(f)}
                  </button>
                  <button
                    className="pv-chip-x"
                    title="Remove"
                    onClick={() =>
                      setFilters(filters.filter((x) => x.id !== f.id))
                    }
                  >
                    <Icon.X size={12} />
                  </button>
                </div>
              )),
            )}
            {Tile(
              "cols",
              "Columns",
              "Dimensions for columns (text / date / bool…)",
              cols.map((f, i) => axisChip("cols", f, i)),
            )}
            {Tile(
              "rows",
              "Rows",
              "Dimensions for rows (text / date / bool…)",
              rows.map((f, i) => axisChip("rows", f, i)),
            )}
            {Tile(
              "values",
              "Summarize",
              "Measures to aggregate (numeric preferred)",
              values.map((v, i) => (
                <div
                  key={v.id}
                  className="pv-chip pv-chip-value"
                  draggable
                  onDragStart={(e) =>
                    startDrag(e, {
                      from: "values",
                      id: v.id,
                      field: v.field ?? undefined,
                    })
                  }
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const p = readPayload(e);
                    if (p) dropOnValues(p, i);
                  }}
                >
                  <button
                    className="pv-chip-label as-btn"
                    onClick={(e) => {
                      valPopTrigger.current = e.currentTarget;
                      setValEdit({ id: v.id, x: e.clientX, y: e.clientY });
                    }}
                    title="Choose summary"
                  >
                    {aggLabel(v)}
                  </button>
                  <button
                    className="pv-chip-x"
                    title="Remove"
                    onClick={() => setValues(values.filter((x) => x.id !== v.id))}
                  >
                    <Icon.X size={12} />
                  </button>
                </div>
              )),
            )}
          </div>

          <div className="pv-result">
            {!canRun ? (
              <div className="pv-empty">
                <Icon.Table size={26} />
                <p>
                  Drag fields into <b>Rows</b> or <b>Columns</b> to build a
                  pivot. Add fields to <b>Summarize</b> to aggregate, and{" "}
                  <b>Filters</b> to narrow the data.
                </p>
              </div>
            ) : expired ? (
              <div className="pv-empty" data-testid="pivot-expired">
                <Icon.Table size={26} />
                <p>This result expired — re-run the query to pivot it again.</p>
              </div>
            ) : data && data.rows.length ? (
              <div className="pv-grid-wrap">
                <table
                  ref={gridRef}
                  className={"pv-grid" + (colW ? " pv-fixed" : "")}
                  style={
                    colW ? { width: colW.reduce((a, b) => a + b, 0) } : undefined
                  }
                >
                  {colW && (
                    <colgroup>
                      {data.columns.map((_, i) => (
                        <col key={i} style={{ width: colW[i] }} />
                      ))}
                    </colgroup>
                  )}
                  <thead>
                    <tr>
                      {data.columns.map((c, i) => (
                        <th
                          key={i}
                          className={
                            (i < nDims ? "pv-dim" : "pv-val") +
                            (sort && sort.col === i ? " pv-sorted" : "")
                          }
                        >
                          <span
                            className="pv-th-label"
                            onClick={() => toggleSort(i)}
                            title={"Sort by " + c}
                          >
                            {c}
                            {sort && sort.col === i
                              ? sort.dir === "asc"
                                ? " ▲"
                                : " ▼"
                              : ""}
                          </span>
                          <span
                            className="pv-col-resize"
                            onPointerDown={(e) => startResize(e, i)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((d, ri) => {
                      const r = d.r;
                      const prev = ri > 0 ? displayRows[ri - 1].r : null;
                      // a leading row-dimension cell is a "continuation" of the
                      // group above (so we blank it) when it AND every dim to
                      // its left match the previous *displayed* row.
                      const cont = (ci: number) =>
                        !!prev &&
                        r.slice(0, ci + 1).every((v, k) => v === prev[k]);
                      const groupStart =
                        nDims > 1 && (!prev || r[0] !== prev[0]);
                      const collAt = d.collapsedAt;
                      return (
                        <tr
                          key={ri}
                          className={groupStart ? "pv-group-start" : ""}
                        >
                          {r.map((cell, ci) => {
                            if (ci < nDims) {
                              // dims deeper than the collapse level are hidden
                              const beyond = collAt >= 0 && ci > collAt;
                              const starts = !cont(ci);
                              const collapsible =
                                canCollapse &&
                                ci < nDims - 1 &&
                                starts &&
                                !beyond;
                              const key = prefixKey(r, ci);
                              const isColl = collapsed.has(key);
                              return (
                                <td
                                  key={ci}
                                  className={
                                    "pv-dim" + (ci > 0 ? " pv-subdim" : "")
                                  }
                                  style={{ paddingLeft: 8 + ci * 16 }}
                                >
                                  {collapsible && (
                                    <button
                                      className="pv-collapse"
                                      onClick={() => toggleCollapse(key)}
                                      title={isColl ? "Expand" : "Collapse"}
                                      aria-label={isColl ? "Expand" : "Collapse"}
                                    >
                                      {isColl ? "\u25b8" : "\u25be"}
                                    </button>
                                  )}
                                  {beyond || cont(ci) ? "" : fmtCell(cell)}
                                  {collAt >= 0 &&
                                    ci === collAt &&
                                    d.count > 0 && (
                                      <span className="pv-collapse-count">
                                        {" "}
                                        ({d.subtotal ? d.count : d.count + 1})
                                      </span>
                                    )}
                                </td>
                              );
                            }
                            return (
                              <td key={ci} className="pv-val">
                                {collAt >= 0 && !d.subtotal ? "" : fmtCell(cell)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : data ? (
              <div className="pv-empty">
                <p>No rows match the current pivot.</p>
              </div>
            ) : (
              <div className="pv-empty">
                <p>Building…</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* summarize popover */}
      {valEdit &&
        (() => {
          const v = values.find((x) => x.id === valEdit.id);
          if (!v) return null;
          return (
            <>
              <div className="pv-pop-back" onMouseDown={() => closeValEdit()} />
              <div
                ref={valPopRef}
                role="dialog"
                aria-modal="true"
                aria-label={`Summarize ${v.field ?? "rows"}`}
                tabIndex={-1}
                className="pv-pop"
                style={{
                  left: Math.min(valEdit.x, window.innerWidth - 230),
                  top: Math.min(valEdit.y, window.innerHeight - 280),
                }}
              >
                <div className="pv-pop-title">{v.field ?? "rows"}</div>
                <div className="pv-pop-label">Summarize by</div>
                {AGGS.map((a) => (
                  <button
                    key={a.value}
                    className={"pv-pop-opt" + (v.agg === a.value ? " sel" : "")}
                    onClick={() => {
                      setValues((prev) =>
                        prev.map((x) =>
                          x.id === v.id ? { ...x, agg: a.value } : x,
                        ),
                      );
                      closeValEdit();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          );
        })()}

      {/* filter popover */}
      {filEdit &&
        (() => {
          const f = filters.find((x) => x.id === filEdit.id);
          if (!f) return null;
          const op = OPS.find((o) => o.value === f.op) || OPS[0];
          const patch = (d: Partial<FilterItem>) =>
            setFilters((prev) =>
              prev.map((x) => (x.id === f.id ? { ...x, ...d } : x)),
            );
          return (
            <>
              <div className="pv-pop-back" onMouseDown={() => closeFilEdit()} />
              <div
                ref={filPopRef}
                role="dialog"
                aria-modal="true"
                aria-label={`Filter: ${f.field}`}
                tabIndex={-1}
                className="pv-pop pv-pop-filter"
                style={{
                  left: Math.min(filEdit.x || 80, window.innerWidth - 280),
                  top: Math.min(filEdit.y || 120, window.innerHeight - 320),
                }}
              >
                <div className="pv-pop-title">Filter: {f.field}</div>
                <div className="pv-pop-label">Condition</div>
                <select
                  className="pv-pop-select"
                  value={f.op}
                  onChange={(e) => patch({ op: e.target.value })}
                >
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {op.arity === 1 && (
                  <input
                    className="pv-pop-input"
                    autoFocus
                    placeholder="value"
                    value={f.value ?? ""}
                    onChange={(e) => patch({ value: e.target.value })}
                  />
                )}
                {op.arity === 2 && (
                  <div className="pv-pop-row">
                    <input
                      className="pv-pop-input"
                      placeholder="from"
                      value={f.value ?? ""}
                      onChange={(e) => patch({ value: e.target.value })}
                    />
                    <input
                      className="pv-pop-input"
                      placeholder="to"
                      value={f.value2 ?? ""}
                      onChange={(e) => patch({ value2: e.target.value })}
                    />
                  </div>
                )}
                {op.arity === "list" && (
                  <textarea
                    className="pv-pop-area"
                    placeholder="one value per line"
                    value={(f.values || []).join("\n")}
                    onChange={(e) =>
                      patch({
                        values: e.target.value
                          .split(/[\n,]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                )}
                <div className="pv-pop-actions">
                  <button className="btn ghost sm" onClick={() => closeFilEdit()}>
                    Done
                  </button>
                </div>
              </div>
            </>
          );
        })()}
    </div>
  );
};

// Re-render only when the source result (id + columns) or the tables list
// changes. The parent recreates the `result` object and the callbacks each
// render, so compare result by value and ignore callback identity; `tables`
// is stable app state, compared by reference.
function samePivotCols(a: string[] = [], b: string[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export const PivotPanel = React.memo(
  PivotPanelImpl,
  (a, b) =>
    a.tables === b.tables &&
    (a.result?.id ?? null) === (b.result?.id ?? null) &&
    samePivotCols(a.result?.columns, b.result?.columns) &&
    a.result?.sampleRows === b.result?.sampleRows &&
    (a.result?.columnTypes === b.result?.columnTypes ||
      JSON.stringify(a.result?.columnTypes ?? null) ===
        JSON.stringify(b.result?.columnTypes ?? null)),
);
