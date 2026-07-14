import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { startPointerDrag } from "../lib/pointerDrag";
import { api, copyText } from "../lib/api";
import { useWinDrag } from "./ActivityShared";
import type { Cell, ResultPage } from "../lib/types";
import { useRenderCount } from "../lib/renderDebug";
import { menuPos } from "../lib/menuPos";
import { prettyStruct, looksStructy } from "../lib/prettyStruct";

/** Only the most recently selected grid responds to Ctrl/Cmd+C. */
let copyOwnerToken = 0;
let nextCopyOwnerToken = 1;

interface Props {
  page: ResultPage;
  sortCol: string | null;
  descending: boolean;
  onSort: (col: string) => void;
  onColumnContextMenu?: (col: string, x: number, y: number) => void;
  // Lazy paging: fetch the next chunk of rows when the user scrolls near
  // the bottom. `hasMore` is true while loaded rows < total_rows.
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  // export the result this grid is showing (right-click menu)
  onExportResults?: (fmt: string) => void;
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
const DEFAULT_W = 150;
const ROWNUM_W = 56;
const EMPTY_ROWS: Cell[][] = [];

function isNumeric(v: Cell): boolean {
  return typeof v === "number";
}

function fmtCell(v: Cell): { text: string; cls: string } {
  if (v === null || v === undefined) return { text: "NULL", cls: "null" };
  if (typeof v === "number") {
    const t = Number.isInteger(v) ? String(v) : String(v);
    return { text: t, cls: "num" };
  }
  if (typeof v === "boolean") return { text: v ? "true" : "false", cls: "" };
  return { text: String(v), cls: "" };
}

const DataGridImpl: React.FC<Props> = ({
  page,
  sortCol,
  descending,
  onSort,
  onColumnContextMenu,
  onLoadMore,
  hasMore,
  loadingMore,
  onExportResults,
  cellFetch,
  onContentMetrics,
}) => {
  useRenderCount("DataGrid");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // .460: the row-number rail only shadows once you scroll sideways.
  const [hScrolled, setHScrolled] = useState(false);
  const [viewH, setViewH] = useState(400);
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
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
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
  const bodyWidth =
    ROWNUM_W + cols.reduce((acc, c) => acc + colWidth(c), 0);
  const contentHeight = 32 + Math.max(1, rows.length) * ROW_H + 8;

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
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // expandable viewer for a struct / JSON cell, anchored at the click
  const [viewer, setViewer] = useState<{
    loading?: boolean;
    note?: string;
    x: number;
    y: number;
    text: string;
  } | null>(null);
  // Pretty text is computed AFTER the window opens so the first click isn't
  // blocked on a sync walk of a large JSON/struct string.
  const [viewerPretty, setViewerPretty] = useState<string>("");
  const [viewerFormatting, setViewerFormatting] = useState(false);
  // Latest-wins guard for full-cell fetches. A slow response from a prior
  // cell must never replace the viewer after the user opens another cell,
  // closes the viewer, or switches to a different result page.
  const viewerRequestSeq = useRef(0);

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
      setViewerPretty("");
      setViewerFormatting(false);
      return;
    }
    const raw = viewer.text || "";
    // Paint the raw text immediately; format on the next task.
    setViewerPretty(raw);
    setViewerFormatting(looksStructy(raw));
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setViewerPretty(prettyStruct(raw));
      setViewerFormatting(false);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [viewer]);

  // the value inspector window (.412) rides the shared drag hook (.413)
  const {
    pos: vposRaw,
    setPos: setVposRaw,
    startDrag: startVDrag,
    dragging: vDragging,
    settled: vSettled,
    winRef: vWinRef,
  } = useWinDrag({ x: -1, y: -1 });
  const vpos = vposRaw.x < 0 ? null : vposRaw;
  const setVpos = (p: { x: number; y: number } | null) =>
    setVposRaw(p ?? { x: -1, y: -1 });

  // a fresh result clears any prior selection
  useEffect(() => {
    viewerRequestSeq.current += 1;
    setSel(null);
    setCellMenu(null);
    setViewer(null);
     
  }, [page]);

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
  const onCellContext = (idx: number, ci: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    claimCopyOwner();
    if (!inSel(idx, ci)) {
      selMode.current = "cell";
      setSel({ aR: idx, aC: ci, fR: idx, fC: ci });
    }
    setCellMenu({ x: e.clientX, y: e.clientY });
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
            style={{ color: "#c98a2b" }}
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
        }
      }}
      onScroll={(e) => {
        const el = e.target as HTMLDivElement;
        setScrollTop(el.scrollTop);
        // .460: the row-number rail only casts a shadow once you have
        // actually scrolled sideways.
        setHScrolled(el.scrollLeft > 0);
        maybeLoadMore(el);
      }}
    >
      <div className="grid-inner" style={{ width: bodyWidth }}>
        <div className="grid-head">
          <div className="gh-cell rownum" style={{ width: ROWNUM_W }}>
            #
          </div>
          {cols.map((c) => {
            const active = sortCol === c;
            return (
              <div
                key={c}
                className="gh-cell"
                data-column={c}
                style={{ width: colWidth(c) }}
                onClick={() => onSort(c)}
                onContextMenu={(e) => {
                  if (onColumnContextMenu) {
                    e.preventDefault();
                    onColumnContextMenu(c, e.clientX, e.clientY);
                  }
                }}
                title={`Sort by ${c}  ·  right-click to change type`}
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
              {cols.map((c, ci) => {
                const f = fmtCell(row[ci]);
                const truncated = TRUNC_RE.test(f.text);
                const nested = looksStructy(f.text) || truncated;
                return (
                  <div
                    key={c}
                    className={"gc-cell " + f.cls + (inSel(idx, ci) ? " sel" : "")}
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
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          const x = e.clientX;
                          const y = e.clientY;
                          const request = ++viewerRequestSeq.current;
                          if (truncated && cellFetch?.resultId) {
                            // Fetch the COMPLETE value under this grid's view.
                            // Absolute row = window offset + local index.
                            // The sequence guard prevents an older request from
                            // overwriting a newer viewer selection.
                            setViewer({ x, y, text: f.text, loading: true });
                            api
                              .resultCell({
                                result_id: cellFetch.resultId,
                                row: rowBase + idx,
                                column: c,
                                sort_col: sortCol,
                                descending,
                                filters: cellFetch.filters || undefined,
                              })
                              .then((r) => {
                                if (request !== viewerRequestSeq.current) return;
                                setViewer((v) =>
                                  v && {
                                    ...v,
                                    loading: false,
                                    text:
                                      r.error != null
                                        ? f.text
                                        : String(r.value ?? ""),
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
                                setViewer((v) =>
                                  v && {
                                    ...v,
                                    loading: false,
                                    note: `couldn't fetch full value: ${err?.message || err}`,
                                  },
                                );
                              });
                          } else {
                            setViewer({ x, y, text: f.text });
                          }
                        }}
                      >
                        {"{ }"}
                      </button>
                    )}
                  </div>
                );
              })}
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
            {onExportResults && (
              <>
                <div className="sep" />
                <button
                  type="button"
                  onClick={() => {
                    onExportResults("csv");
                    setCellMenu(null);
                  }}
                >
                  Export results (CSV)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onExportResults("json");
                    setCellMenu(null);
                  }}
                >
                  Export results (JSON)
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
    {viewer &&
      createPortal(
        <div
          ref={vWinRef as React.RefObject<HTMLDivElement>}
          data-testid="structured-value-viewer"
          className={
            "gc-json-pop val-win win-float" +
            (vDragging ? " dragging" : "") +
            (vSettled ? " settle" : "")
          }
          style={{
            position: "fixed",
            left: (vpos ?? viewer).x,
            top: (vpos ?? viewer).y,
            zIndex: 220,
            resize: "both",
            overflow: "auto",
            width: 520,
            height: 380,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="gc-json-head"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!vpos) setVposRaw({ x: viewer.x, y: viewer.y });
              startVDrag(e);
            }}
            title="Drag to move; resize from the corner"
          >
            <span className="label">
              Value
              {viewer.loading
                ? " · fetching full…"
                : viewerFormatting
                  ? " · formatting…"
                  : ""}
            </span>
            <button
              type="button"
              onClick={() => copyText(viewerPretty || viewer.text)}
            >
              Copy
            </button>
            <button
              type="button"
              className="gc-json-x"
              aria-label="Close"
              onClick={() => {
                viewerRequestSeq.current += 1;
                setViewer(null);
                setVpos(null);
              }}
            >
              ✕
            </button>
          </div>
          <pre className="gc-json-body">{viewerPretty || viewer.text}</pre>
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
