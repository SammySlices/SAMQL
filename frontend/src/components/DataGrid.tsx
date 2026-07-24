import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { startPointerDrag } from "../lib/pointerDrag";
import { api, copyText } from "../lib/api";
import { useWinDrag } from "./ActivityShared";
import type { Cell, ResultPage } from "../lib/types";
import { useRenderCount } from "../lib/renderDebug";
import { menuPos } from "../lib/menuPos";
import {
  prettyStruct,
  looksStructy,
  runAfterPaint,
} from "../lib/prettyStruct";
import { ExportResultsCtxItem } from "./ExportResultsMenu";
import type { ExportFormatOption } from "../lib/resultExportFormats";

/** Only the most recently selected grid responds to Ctrl/Cmd+C. */
let copyOwnerToken = 0;
let nextCopyOwnerToken = 1;

interface Props {
  page: ResultPage;
  sortCol: string | null;
  descending: boolean;
  onSort: (col: string) => void;
  onColumnContextMenu?: (col: string, x: number, y: number) => void;
  /** Open column lineage for a cell (row/cell right-click only — not headers). */
  onShowLineage?: (
    col: string,
    ctx?: { rowIndex: number; value: Cell },
  ) => void;
  // Lazy paging: fetch the next chunk of rows when the user scrolls near
  // the bottom. `hasMore` is true while loaded rows < total_rows.
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  // export the result this grid is showing (right-click menu)
  onExportResults?: (fmt: string) => void;
  exportFormats?: ExportFormatOption[];
  // Full-value fetch context: when present, expanding a TRUNCATED cell pulls
  // its complete value from the server (same sort/filter view this grid is
  // showing; the grid's row index is the absolute view index because lazy
  // pages append from offset 0).
  cellFetch?: { resultId?: string | null; filters?: any } | null;
  /** Report full table pixel size (for dashboard widgets that auto-fit). */
  onContentMetrics?: (m: { widthPx: number; heightPx: number }) => void;
}

// display-truncation marker written by the server's _cap_page_rows
const TRUNC_RE = /… \[\d+ chars — truncated\]$/;

const ROW_H = 28;
const OVERSCAN = 12;
/** Ceiling for "copy all results" — a clipboard-sized slice of a big result. */
const COPY_ALL_MAX = 5000;
const DEFAULT_W = 150;
const ROWNUM_W = 56;
/** Virtualize data columns only past this count (small grids stay simple). */
const COL_VIRT_MIN_COLS = 64;
/** And only when the table is materially wider than the viewport. */
const COL_VIRT_MIN_BODY_PX = 6000;
const COL_OVERSCAN_PX = 600;
const EMPTY_ROWS: Cell[][] = [];
/** Fixed value-inspector size — reserved so Loading… → pretty does not resize/flicker. */
const VIEWER_W = 520;
const VIEWER_H = 380;

function centerViewerPos(): { x: number; y: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    x: Math.max(16, Math.round((vw - VIEWER_W) / 2)),
    y: Math.max(16, Math.round((vh - VIEWER_H) / 2)),
  };
}

function isNumeric(v: Cell): boolean {
  return typeof v === "number";
}

function fmtCell(v: Cell): { text: string; cls: string } {
  if (v === null || v === undefined) return { text: "NULL", cls: "null" };
  if (typeof v === "number") {
    return { text: String(v), cls: "num" };
  }
  if (typeof v === "boolean") return { text: v ? "true" : "false", cls: "" };
  return { text: String(v), cls: "" };
}

/** Prefix sums of column widths: prefix[i] = sum of widths of cols[0..i). */
function buildColPrefix(
  cols: readonly string[],
  widthOf: (c: string) => number,
): number[] {
  const prefix = new Array<number>(cols.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < cols.length; i += 1) {
    prefix[i + 1] = prefix[i] + widthOf(cols[i]);
  }
  return prefix;
}

/** First column index whose right edge is > leftPx (0-based). */
function colIndexAtOrAfter(prefix: readonly number[], leftPx: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] <= leftPx) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** Exclusive end column index whose left edge is < rightPx. */
function colIndexBefore(prefix: readonly number[], rightPx: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < rightPx) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

const DataGridImpl: React.FC<Props> = ({
  page,
  sortCol,
  descending,
  onSort,
  onColumnContextMenu,
  onShowLineage,
  onLoadMore,
  hasMore,
  loadingMore,
  onExportResults,
  exportFormats,
  cellFetch,
  onContentMetrics,
}) => {
  useRenderCount("DataGrid");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  // .460: the row-number rail only shadows once you scroll sideways.
  const [hScrolled, setHScrolled] = useState(false);
  const [viewH, setViewH] = useState(400);
  const [viewW, setViewW] = useState(
    typeof window !== "undefined" ? window.innerWidth || 1000 : 1000,
  );
  const [widths, setWidths] = useState<Record<string, number>>({});

  const cols = page.columns;
  const rows = page.rows ?? EMPTY_ROWS;
  const rowBase = page.offset || 0;
  const isCapped = !!(page.result_capped || page.truncated);
  const windowEnd = rowBase + rows.length;
  const totalRows = page.total_rows || rows.length;

  // Sliding-window retain: when oldest rows are dropped, bump scroll so the
  // same absolute rows stay under the viewport.
  const prevRowBase = useRef(rowBase);
  useEffect(() => {
    const prev = prevRowBase.current;
    prevRowBase.current = rowBase;
    if (rowBase <= prev) return;
    const el = scrollRef.current;
    if (!el) return;
    const delta = (rowBase - prev) * ROW_H;
    el.scrollTop = Math.max(0, el.scrollTop - delta);
    setScrollTop(el.scrollTop);
  }, [rowBase]);

  // estimate sensible initial widths from the header + first rows. Only
  // sizes columns that don't have a width yet (user resizes and prior sizing
  // are preserved), and returns the previous map unchanged when there's
  // nothing new to size -- so appending a page on infinite-scroll doesn't
  // trigger a redundant re-render of the grid.
  useEffect(() => {
    setWidths((prev) => {
      let changed = false;
      const next = { ...prev };
      cols.forEach((c, i) => {
        if (next[c] != null) return;
        let max = c.length;
        const sample = Math.min(rows.length, 40);
        for (let r = 0; r < sample; r++) {
          const v = rows[r][i];
          const len = v === null ? 4 : String(v).length;
          if (len > max) max = len;
        }
        next[c] = Math.max(64, Math.min(420, max * 8 + 26));
        changed = true;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight);
      setViewW(el.clientWidth || viewW);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN,
  );
  const visible = useMemo(() => {
    const out: { idx: number; row: Cell[] }[] = [];
    for (let i = start; i < end; i++) out.push({ idx: i, row: rows[i] });
    return out;
  }, [start, end, rows]);

  const colWidth = (c: string) => widths[c] ?? DEFAULT_W;
  const colPrefix = useMemo(
    () => buildColPrefix(cols, colWidth),
    // widths + cols identity drive prefix; colWidth closes over widths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cols, widths],
  );
  const bodyWidth = ROWNUM_W + (colPrefix[cols.length] || 0);
  const contentHeight = 32 + Math.max(1, rows.length) * ROW_H + 8;

  const virtCols = useMemo(() => {
    const n = cols.length;
    if (
      n < COL_VIRT_MIN_COLS ||
      bodyWidth <= Math.max(viewW * 2, COL_VIRT_MIN_BODY_PX)
    ) {
      return {
        active: false,
        start: 0,
        end: n,
        leftPad: 0,
        rightPad: 0,
        items: cols.map((c, ci) => ({ c, ci })),
      };
    }
    // Column coords are relative to the data area (after the sticky rownum).
    const dataScroll = Math.max(0, scrollLeft);
    const dataView = Math.max(1, viewW - ROWNUM_W);
    const leftPx = Math.max(0, dataScroll - COL_OVERSCAN_PX);
    const rightPx = dataScroll + dataView + COL_OVERSCAN_PX;
    let cStart = colIndexAtOrAfter(colPrefix, leftPx);
    let cEnd = colIndexBefore(colPrefix, rightPx);
    cStart = Math.max(0, Math.min(cStart, n - 1));
    cEnd = Math.max(cStart + 1, Math.min(cEnd, n));
    const leftPad = colPrefix[cStart] || 0;
    const rightPad = (colPrefix[n] || 0) - (colPrefix[cEnd] || 0);
    const items: { c: string; ci: number }[] = [];
    for (let ci = cStart; ci < cEnd; ci += 1) {
      items.push({ c: cols[ci], ci });
    }
    return {
      active: true,
      start: cStart,
      end: cEnd,
      leftPad,
      rightPad,
      items,
    };
  }, [cols, colPrefix, bodyWidth, viewW, scrollLeft]);

  useEffect(() => {
    onContentMetrics?.({ widthPx: bodyWidth, heightPx: contentHeight });
    // Intentionally omit onContentMetrics from deps — callers often pass an
    // inline function; we only re-report when the measured size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyWidth, contentHeight]);

  // column resize via pointer drag
  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(
    null,
  );
  const onResizeDown = (e: React.PointerEvent, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { col, startX: e.clientX, startW: colWidth(col) };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.max(48, d.startW + (ev.clientX - d.startX));
      setWidths((prev) => ({ ...prev, [d.col]: w }));
    };
    startPointerDrag({
      onMove: move,
      onEnd: () => {
        dragRef.current = null;
      },
      onCancel: () => {
        dragRef.current = null;
      },
    });
  };

  // ---- cell selection (drag to highlight, right-click / Ctrl+C to copy) ----
  const [sel, setSel] = useState<{
    aR: number;
    aC: number;
    fR: number;
    fC: number;
  } | null>(null);
  const dragging = useRef(false);
  const selMode = useRef<"cell" | "row">("cell");
  const copyOwnerRef = useRef(0);
  /** True while a whole-result copy is fetching rows from the server. */
  const [copyingAll, setCopyingAll] = useState(false);
  /** Right-click on the panel background (no cell under the pointer). */
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [cellMenu, setCellMenu] = useState<{
    x: number;
    y: number;
    col: string;
    rowIndex: number;
    value: Cell;
  } | null>(null);
  // Expandable viewer for a struct / JSON cell. Position lives in useWinDrag
  // (viewport-centered on open); never paint raw text before pretty-print.
  const [viewer, setViewer] = useState<{
    loading?: boolean;
    note?: string;
    text: string;
    cellKey: string;
  } | null>(null);
  // null = still preparing (show "Loading..."); string = ready body text.
  const [viewerPretty, setViewerPretty] = useState<string | null>(null);
  // Latest-wins guard for full-cell fetches. A slow response from a prior
  // cell must never replace the viewer after the user opens another cell,
  // closes the viewer, or switches to a different result page.
  const viewerRequestSeq = useRef(0);
  // Separate from fetch seq: pretty-print generations must not cancel an
  // in-flight resultCell request (and vice versa).
  const viewerFormatSeq = useRef(0);
  // Sync guard so pointerdown+click (or rapid repeats) cannot reopen the
  // same cell and restart formatting mid-flight.
  const viewerOpenKeyRef = useRef<string | null>(null);

  const claimCopyOwner = () => {
    copyOwnerRef.current = nextCopyOwnerToken++;
    copyOwnerToken = copyOwnerRef.current;
  };

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useEffect(() => {
    if (!viewer) {
      setViewerPretty(null);
      return;
    }
    // Full-value fetch in flight: keep Loading...; do not pretty-print the
    // truncated preview (it would be thrown away when the full value arrives).
    if (viewer.loading) {
      return;
    }
    const raw = viewer.text || "";
    if (!looksStructy(raw)) {
      setViewerPretty(raw);
      return;
    }
    // viewerPretty is already null from the open handler — do not clear again
    // (that caused an extra render / flicker). Format only after paint.
    const formatGen = ++viewerFormatSeq.current;
    const cancel = runAfterPaint(() => {
      if (formatGen !== viewerFormatSeq.current) return;
      const pretty = prettyStruct(raw);
      if (formatGen !== viewerFormatSeq.current) return;
      setViewerPretty(pretty);
    });
    return () => {
      cancel();
    };
  }, [viewer]);

  // the value inspector window (.412) rides the shared drag hook (.413)
  const {
    pos: vposRaw,
    setPos: setVposRaw,
    startDrag: startVDrag,
    dragging: vDragging,
    winRef: vWinRef,
  } = useWinDrag({ x: -1, y: -1 });
  const vpos = vposRaw.x < 0 ? null : vposRaw;
  const setVpos = (p: { x: number; y: number } | null) =>
    setVposRaw(p ?? { x: -1, y: -1 });

  const closeViewer = () => {
    viewerRequestSeq.current += 1;
    viewerFormatSeq.current += 1;
    viewerOpenKeyRef.current = null;
    setViewer(null);
    setViewerPretty(null);
    setVpos(null);
  };

  /** Open synchronously with Loading...; pretty-print runs after paint. */
  const openStructuredViewer = (opts: {
    text: string;
    truncated: boolean;
    column: string;
    absRow: number;
  }) => {
    const cellKey = `${opts.absRow}:${opts.column}`;
    // Single instance: ignore duplicate opens of the same cell while open.
    if (viewerOpenKeyRef.current === cellKey) return;
    viewerOpenKeyRef.current = cellKey;
    const request = ++viewerRequestSeq.current;
    viewerFormatSeq.current += 1;
    // Same-event batch: open + Loading... + center before any raw text paints.
    setViewerPretty(null);
    setVposRaw(centerViewerPos());
    if (opts.truncated && cellFetch?.resultId) {
      setViewer({ cellKey, text: opts.text, loading: true });
      api
        .resultCell({
          result_id: cellFetch.resultId,
          row: opts.absRow,
          column: opts.column,
          sort_col: sortCol,
          descending,
          filters: cellFetch.filters || undefined,
        })
        .then((r) => {
          if (request !== viewerRequestSeq.current) return;
          setViewer(
            (v) =>
              v && {
                ...v,
                loading: false,
                text:
                  r.error != null ? opts.text : String(r.value ?? ""),
                note: r.error
                  ? `couldn't fetch full value: ${r.error}`
                  : r.clipped
                    ? "fetch clipped at the server limit (SAMQL_CELL_FETCH_MAX)"
                    : undefined,
              },
          );
        })
        .catch((err: any) => {
          if (request !== viewerRequestSeq.current) return;
          setViewer(
            (v) =>
              v && {
                ...v,
                loading: false,
                note: `couldn't fetch full value: ${err?.message || err}`,
              },
          );
        });
    } else {
      setViewer({ cellKey, text: opts.text, loading: false });
    }
  };

  // a fresh result clears any prior selection
  useEffect(() => {
    viewerRequestSeq.current += 1;
    viewerFormatSeq.current += 1;
    viewerOpenKeyRef.current = null;
    setSel(null);
    setCellMenu(null);
    setViewer(null);
    setViewerPretty(null);
    // setVposRaw is stable (useWinDrag); avoid the setVpos wrapper so the
    // effect does not depend on a per-render arrow and re-fire every paint.
    setVposRaw({ x: -1, y: -1 });
  }, [page, setVposRaw]);

  const bounds = sel
    ? {
        r0: Math.min(sel.aR, sel.fR),
        r1: Math.max(sel.aR, sel.fR),
        c0: Math.min(sel.aC, sel.fC),
        c1: Math.max(sel.aC, sel.fC),
      }
    : null;
  const inSel = (idx: number, ci: number) =>
    !!bounds &&
    idx >= bounds.r0 &&
    idx <= bounds.r1 &&
    ci >= bounds.c0 &&
    ci <= bounds.c1;
  const selCount = bounds
    ? (bounds.r1 - bounds.r0 + 1) * (bounds.c1 - bounds.c0 + 1)
    : 0;

  const startCell = (idx: number, ci: number, e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button begins a drag-select
    dragging.current = true;
    selMode.current = "cell";
    claimCopyOwner();
    setSel({ aR: idx, aC: ci, fR: idx, fC: ci });
    setCellMenu(null);
    scrollRef.current?.focus();
  };
  const enterCell = (idx: number, ci: number) => {
    if (!dragging.current || selMode.current !== "cell") return;
    setSel((s) => (s ? { ...s, fR: idx, fC: ci } : s));
  };
  const startRow = (idx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    selMode.current = "row";
    claimCopyOwner();
    setSel({ aR: idx, aC: 0, fR: idx, fC: Math.max(0, cols.length - 1) });
    setCellMenu(null);
    scrollRef.current?.focus();
  };
  const enterRow = (idx: number) => {
    if (!dragging.current || selMode.current !== "row") return;
    setSel((s) =>
      s ? { ...s, fR: idx, aC: 0, fC: Math.max(0, cols.length - 1) } : s,
    );
  };

  const buildTSV = (withHeaders: boolean) => {
    if (!bounds) return "";
    const out: string[] = [];
    if (withHeaders) out.push(cols.slice(bounds.c0, bounds.c1 + 1).join("\t"));
    for (let r = bounds.r0; r <= bounds.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = bounds.c0; c <= bounds.c1; c++) {
        const v = row[c];
        cells.push(v === null || v === undefined ? "" : String(v));
      }
      out.push(cells.join("\t"));
    }
    return out.join("\n");
  };
  const copySel = async (withHeaders: boolean) => {
    const tsv = buildTSV(withHeaders);
    setCellMenu(null);
    if (!tsv) return;
    await copyText(tsv);
  };

  /**
   * How many rows a "copy all" would actually put on the clipboard.
   *
   * Without a result id there is no way to reach past the loaded window (a
   * NodeFlow preview holds a fixed slice), so the count must reflect the rows
   * in hand rather than the result's true size — otherwise the menu would
   * promise more than it copies.
   */
  const copyableRows = Math.min(
    cellFetch?.resultId ? totalRows : rows.length,
    COPY_ALL_MAX,
  );

  /** Serialize whole rows (every column) rather than a selected block. */
  const buildTSVAll = (all: Cell[][], withHeaders: boolean) => {
    const out: string[] = [];
    if (withHeaders) out.push(cols.join("\t"));
    for (const row of all) {
      const cells: string[] = [];
      for (let c = 0; c < cols.length; c += 1) {
        const v = row[c];
        cells.push(v === null || v === undefined ? "" : String(v));
      }
      out.push(cells.join("\t"));
    }
    return out.join("\n");
  };

  /**
   * Copy the whole result — not just what is selected or scrolled into view —
   * capped at COPY_ALL_MAX rows.
   *
   * The grid holds a sliding window, so when the result is larger than what is
   * loaded this refetches from the server using the same sort/filter view the
   * user is looking at. Without a result id (NodeFlow previews build their page
   * inline) it falls back to the loaded rows.
   */
  const copyAllRows = async (withHeaders: boolean) => {
    setCellMenu(null);
    if (copyingAll) return;
    const resultId = cellFetch?.resultId;
    const wanted = copyableRows;
    // Fast path (copy the loaded rows) ONLY when the window still starts at row
    // 0. The grid keeps a sliding window: once you scroll far enough it drops
    // the oldest rows and rowBase (page.offset) moves past 0, so the loaded
    // rows no longer begin at the top -- slicing them would copy from the
    // middle while claiming to be the whole result. When the window has slid we
    // fall through to the server refetch below (offset 0), which is correct.
    // Without a resultId (NodeFlow inline previews) there's nothing to refetch,
    // so use the loaded rows regardless.
    if (!resultId || (rowBase === 0 && rows.length >= wanted)) {
      await copyText(buildTSVAll(rows.slice(0, wanted), withHeaders));
      return;
    }
    setCopyingAll(true);
    try {
      const full = await api.page(resultId, {
        offset: 0,
        limit: wanted,
        sort_col: sortCol,
        descending,
        filters: cellFetch?.filters,
      });
      const fetched = full.rows ?? [];
      await copyText(buildTSVAll(fetched.slice(0, wanted), withHeaders));
    } catch {
      // Fall back to what is already loaded rather than copying nothing.
      await copyText(buildTSVAll(rows.slice(0, wanted), withHeaders));
    } finally {
      setCopyingAll(false);
    }
  };
  const onCellContext = (idx: number, ci: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    claimCopyOwner();
    if (!inSel(idx, ci)) {
      selMode.current = "cell";
      setSel({ aR: idx, aC: ci, fR: idx, fC: ci });
    }
    setCellMenu({
      x: e.clientX,
      y: e.clientY,
      col: cols[ci],
      rowIndex: rowBase + idx,
      value: rows[idx]?.[ci] ?? null,
    });
  };

  // Ctrl/Cmd+C works even when focus left the grid (common in dashboard widgets).
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "c" && e.key !== "C") return;
      if (copyOwnerToken !== copyOwnerRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      e.stopPropagation();
      void copySel(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // copySel closes over latest bounds/rows via this render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, page, cols]);

  if (cols.length === 0) {
    return (
      <div className="empty">
        <div className="inner">
          <p>This statement returned no columns.</p>
        </div>
      </div>
    );
  }

  const maybeLoadMore = (el: HTMLDivElement) => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    // within ~8 rows of the bottom
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 8) {
      onLoadMore();
    }
  };

  return (
    <div className="grid-shell" data-testid="grid-shell">
    {(isCapped || rowBase > 0) && (
      <div
        className="grid-status"
        data-testid="grid-status"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          padding: "6px 10px",
          fontSize: 12,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.12)",
        }}
      >
        {isCapped && (
          <span
            className="chip"
            data-testid="result-capped-badge"
            title={
              page.result_cap != null
                ? `Stopped at the ${page.result_cap.toLocaleString()}-row safety limit`
                : "Result was truncated"
            }
            style={{ color: "var(--warn)" }}
          >
            Capped
            {page.result_cap != null
              ? ` at ${page.result_cap.toLocaleString()} rows`
              : ""}
          </span>
        )}
        {rowBase > 0 && (
          <span className="stat faint" data-testid="grid-window-range">
            Showing rows {(rowBase + 1).toLocaleString()}–
            {windowEnd.toLocaleString()} of {totalRows.toLocaleString()}
            {" "}(scroll window)
          </span>
        )}
      </div>
    )}
    <div
      className={"grid" + (hScrolled ? " hscrolled" : "")}
      data-testid="result-grid"
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
          e.preventDefault();
          void copySel(false);
        } else if (e.key === "Escape") {
          setSel(null);
          setCellMenu(null);
          setPanelMenu(null);
        }
      }}
      onContextMenu={(e) => {
        // Cells and headers handle their own right-click and stop propagation;
        // reaching here means the click landed on the panel background (below
        // the last row, or the empty gutter), so offer whole-result actions.
        e.preventDefault();
        setCellMenu(null);
        setPanelMenu({ x: e.clientX, y: e.clientY });
      }}
      onScroll={(e) => {
        const el = e.target as HTMLDivElement;
        setScrollTop(el.scrollTop);
        setScrollLeft(el.scrollLeft);
        // .460: the row-number rail only casts a shadow once you have
        // actually scrolled sideways.
        setHScrolled(el.scrollLeft > 0);
        maybeLoadMore(el);
      }}
    >
      <div
        className="grid-inner"
        style={{ width: bodyWidth }}
        data-col-virt={virtCols.active ? "1" : "0"}
      >
        <div className="grid-head">
          <div className="gh-cell rownum" style={{ width: ROWNUM_W }}>
            #
          </div>
          {virtCols.active && virtCols.leftPad > 0 && (
            <div
              className="gh-cell grid-col-spacer"
              aria-hidden="true"
              style={{ width: virtCols.leftPad }}
            />
          )}
          {virtCols.items.map(({ c }) => {
            const active = sortCol === c;
            return (
              <div
                key={c}
                className="gh-cell"
                data-column={c}
                data-testid="grid-col-header"
                style={{ width: colWidth(c) }}
                onClick={() => onSort(c)}
                onContextMenu={(e) => {
                  if (onColumnContextMenu) {
                    e.preventDefault();
                    e.stopPropagation();
                    onColumnContextMenu(c, e.clientX, e.clientY);
                  }
                }}
                title={`Sort by ${c}  ·  right-click for column menu`}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c}
                </span>
                {active && (
                  <span className="sort">{descending ? "▼" : "▲"}</span>
                )}
                <span
                  className="resize"
                  onPointerDown={(e) => onResizeDown(e, c)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
          {virtCols.active && virtCols.rightPad > 0 && (
            <div
              className="gh-cell grid-col-spacer"
              aria-hidden="true"
              style={{ width: virtCols.rightPad }}
            />
          )}
        </div>

        <div
          className="grid-rows"
          style={{ height: total * ROW_H + (loadingMore ? ROW_H : 0) }}
        >
          {visible.map(({ idx, row }) => (
            <div
              key={rowBase + idx}
              className={"grow" + ((rowBase + idx) % 2 ? " odd" : "")}
              style={{ top: idx * ROW_H, height: ROW_H }}
            >
              <div
                className="gc-cell rownum"
                style={{ width: ROWNUM_W, lineHeight: `${ROW_H - 12}px` }}
                onMouseDown={(e) => startRow(idx, e)}
                onMouseEnter={() => enterRow(idx)}
                title="Click to select row"
              >
                {rowBase + idx + 1}
              </div>
              {virtCols.active && virtCols.leftPad > 0 && (
                <div
                  className="gc-cell grid-col-spacer"
                  aria-hidden="true"
                  style={{ width: virtCols.leftPad }}
                />
              )}
              {virtCols.items.map(({ c, ci }) => {
                const f = fmtCell(row[ci]);
                const truncated = TRUNC_RE.test(f.text);
                const nested = looksStructy(f.text) || truncated;
                return (
                  <div
                    key={c}
                    className={
                      "gc-cell " +
                      f.cls +
                      (inSel(idx, ci) ? " sel" : "") +
                      (nested ? " has-expand" : "")
                    }
                    data-column={c}
                    data-row-index={rowBase + idx}
                    style={{ width: colWidth(c) }}
                    title={f.text}
                    onMouseDown={(e) => startCell(idx, ci, e)}
                    onMouseEnter={() => enterCell(idx, ci)}
                    onContextMenu={(e) => onCellContext(idx, ci, e)}
                  >
                    {f.text}
                    {nested && (
                      <button
                        type="button"
                        className="gc-expand"
                        data-testid="structured-cell-expand"
                        data-column={c}
                        data-row-index={rowBase + idx}
                        aria-label={`View formatted value for ${c}, row ${rowBase + idx + 1}`}
                        title="View formatted"
                        onPointerDown={(e) => {
                          // Open on pointerdown so the full hit box works (center
                          // included) and cell drag-select never steals the gesture.
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.stopPropagation();
                          openStructuredViewer({
                            text: f.text,
                            truncated,
                            column: c,
                            absRow: rowBase + idx,
                          });
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Fallback for environments that only synthesize click
                          // (tests); ref guard skips if pointerdown already opened.
                          openStructuredViewer({
                            text: f.text,
                            truncated,
                            column: c,
                            absRow: rowBase + idx,
                          });
                        }}
                      >
                        {"{ }"}
                      </button>
                    )}
                  </div>
                );
              })}
              {virtCols.active && virtCols.rightPad > 0 && (
                <div
                  className="gc-cell grid-col-spacer"
                  aria-hidden="true"
                  style={{ width: virtCols.rightPad }}
                />
              )}
            </div>
          ))}
          {loadingMore && (
            <div
              className="grid-loadmore"
              style={{ top: total * ROW_H, height: ROW_H }}
            >
              <span className="spinner-sm" /> Loading more rows…
            </div>
          )}
        </div>
      </div>
    </div>
    {selCount > 0 ? (
      <div className="grid-sel-bar" data-testid="grid-sel-bar">
        <span>
          {selCount} cell{selCount === 1 ? "" : "s"} selected
        </span>
        <button
          type="button"
          data-testid="grid-copy"
          onClick={() => void copySel(false)}
          title="Copy (Ctrl+C)"
        >
          Copy
        </button>
        <button
          type="button"
          data-testid="grid-copy-headers"
          onClick={() => void copySel(true)}
        >
          Copy with headers
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setSel(null);
            setCellMenu(null);
          }}
        >
          Clear
        </button>
      </div>
    ) : null}
    {cellMenu &&
      createPortal(
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 120 }}
            onMouseDown={() => setCellMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCellMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            data-testid="grid-cell-menu"
            style={{ ...menuPos(cellMenu.x, cellMenu.y, 220), zIndex: 121 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="label">
              {selCount} cell{selCount === 1 ? "" : "s"} selected
            </div>
            <button
              type="button"
              data-testid="grid-menu-copy"
              onClick={() => void copySel(false)}
            >
              Copy
            </button>
            <button
              type="button"
              data-testid="grid-menu-copy-headers"
              onClick={() => void copySel(true)}
            >
              Copy with headers
            </button>
            <div className="sep" />
            <button
              type="button"
              data-testid="grid-menu-copy-all"
              disabled={copyingAll}
              title={`Copy the whole result with headers (up to ${COPY_ALL_MAX.toLocaleString()} rows)`}
              onClick={() => void copyAllRows(true)}
            >
              {copyingAll
                ? "Copying results…"
                : `Copy all results with headers (${copyableRows.toLocaleString()} rows)`}
            </button>
            {onExportResults && exportFormats && exportFormats.length > 0 && (
              <>
                <div className="sep" />
                <ExportResultsCtxItem
                  testId="grid-export-results"
                  showIcon={false}
                  formats={exportFormats}
                  onExport={(fmt) => {
                    onExportResults(fmt);
                    setCellMenu(null);
                  }}
                />
              </>
            )}
            {onShowLineage && cellMenu.col && (
              <>
                <div className="sep" />
                <button
                  type="button"
                  data-testid="show-column-lineage"
                  onClick={() => {
                    onShowLineage(cellMenu.col, {
                      rowIndex: cellMenu.rowIndex,
                      value: cellMenu.value,
                    });
                    setCellMenu(null);
                  }}
                >
                  Show lineage
                </button>
              </>
            )}
            <div className="sep" />
            <button
              type="button"
              onClick={() => {
                setSel(null);
                setCellMenu(null);
              }}
            >
              Clear selection
            </button>
          </div>
        </>,
        document.body,
      )}
    {panelMenu &&
      createPortal(
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 120 }}
            onMouseDown={() => setPanelMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPanelMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            data-testid="grid-panel-menu"
            style={{ ...menuPos(panelMenu.x, panelMenu.y, 260), zIndex: 121 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="label">
              {totalRows.toLocaleString()} row{totalRows === 1 ? "" : "s"}
            </div>
            <button
              type="button"
              data-testid="grid-panel-copy-all"
              disabled={copyingAll}
              title={`Copy the whole result with headers (up to ${COPY_ALL_MAX.toLocaleString()} rows)`}
              onClick={() => {
                setPanelMenu(null);
                void copyAllRows(true);
              }}
            >
              {copyingAll
                ? "Copying results…"
                : `Copy results with headers (${copyableRows.toLocaleString()} rows)`}
            </button>
            <button
              type="button"
              data-testid="grid-panel-copy-all-noheaders"
              disabled={copyingAll}
              onClick={() => {
                setPanelMenu(null);
                void copyAllRows(false);
              }}
            >
              Copy results without headers
            </button>
            {totalRows > copyableRows && (
              <div className="label faint">
                {totalRows.toLocaleString()} rows total — copying{" "}
                {copyableRows.toLocaleString()}. Export the result for the full
                set.
              </div>
            )}
            {onExportResults && exportFormats && exportFormats.length > 0 && (
              <>
                <div className="sep" />
                <ExportResultsCtxItem
                  testId="grid-panel-export"
                  showIcon={false}
                  formats={exportFormats}
                  onExport={(fmt) => {
                    onExportResults(fmt);
                    setPanelMenu(null);
                  }}
                />
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    {viewer &&
      createPortal(
        <div
          ref={vWinRef as React.RefObject<HTMLDivElement>}
          data-testid="structured-value-viewer"
          className={
            "gc-json-pop val-win win-float" + (vDragging ? " dragging" : "")
          }
          style={{
            position: "fixed",
            left: (vpos ?? centerViewerPos()).x,
            top: (vpos ?? centerViewerPos()).y,
            zIndex: 220,
            resize: "both",
            overflow: "auto",
            width: VIEWER_W,
            height: VIEWER_H,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="gc-json-head"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!vpos) setVposRaw(centerViewerPos());
              startVDrag(e);
            }}
            title="Drag to move; resize from the corner"
          >
            <span className="label">
              Value
              {viewer.loading || viewerPretty === null ? " · Loading..." : ""}
            </span>
            <button
              type="button"
              onClick={() => copyText(viewerPretty ?? viewer.text)}
            >
              Copy
            </button>
            <button
              type="button"
              className="gc-json-x"
              aria-label="Close"
              onClick={closeViewer}
            >
              ✕
            </button>
          </div>
          <pre
            className={
              "gc-json-body" +
              (viewer.loading || viewerPretty === null ? " is-loading" : "")
            }
          >
            {viewer.loading || viewerPretty === null
              ? "Loading..."
              : viewerPretty}
          </pre>
          {viewer.note && <div className="gc-json-note">{viewer.note}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
};

// Skip re-render when the displayed result state is unchanged. Callbacks read
// live refs / take ids as arguments, so their identity is ignored. `page` is a
// stable reference until the result actually changes (run / sort / load-more).
function dataGridPropsEqual(a: Props, b: Props): boolean {
  return (
    a.page === b.page &&
    a.sortCol === b.sortCol &&
    a.descending === b.descending &&
    a.hasMore === b.hasMore &&
    a.loadingMore === b.loadingMore &&
    a.cellFetch?.resultId === b.cellFetch?.resultId &&
    a.cellFetch?.filters === b.cellFetch?.filters
  );
}
export const DataGrid = React.memo(DataGridImpl, dataGridPropsEqual);
