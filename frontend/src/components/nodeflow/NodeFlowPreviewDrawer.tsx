import React, { useEffect, useMemo, useState } from "react";
import { startPointerDrag } from "../../lib/pointerDrag";
import type { Cell, ResultPage } from "../../lib/types";
import type { ColumnLineageOpenArgs } from "../../lib/columnLineage";
import { ChartView } from "../ChartView";
import { ColumnLineageModal } from "../ColumnLineageModal";
import { DataGrid } from "../DataGrid";
import type { NodeFlowPreview } from "./useNodeFlowExecutionController";

const PREVIEW_CHART_FALLBACK = (
  <div className="faint">Couldn't render this chart.</div>
);

interface NodeFlowPreviewDrawerProps {
  preview: NodeFlowPreview | null;
  height: number;
  setHeight: React.Dispatch<React.SetStateAction<number>>;
  onClose: () => void;
  /** Live graph snapshot for column lineage (same source as Excel export). */
  getLineageGraph?: () => unknown;
  onHighlightNode?: (nodeId: string) => void;
}

export const NodeFlowPreviewDrawer = React.memo(
  function NodeFlowPreviewDrawer({
    preview,
    height,
    setHeight,
    onClose,
    getLineageGraph,
    onHighlightNode,
  }: NodeFlowPreviewDrawerProps) {
    const [lineageOpen, setLineageOpen] = useState<ColumnLineageOpenArgs | null>(
      null,
    );
    // Sort applies to the loaded preview slice only (not a full server re-page).
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [descending, setDescending] = useState(false);

    const previewKey =
      preview?.kind === "table"
        ? `${preview.sourceNodeId || ""}:${preview.title}:${preview.total}:${preview.rows.length}`
        : "";
    useEffect(() => {
      setSortCol(null);
      setDescending(false);
    }, [previewKey]);

    const page = useMemo<ResultPage | null>(() => {
      if (preview?.kind !== "table") return null;
      const cols = preview.columns;
      let rows = preview.rows as Cell[][];
      if (sortCol && cols.includes(sortCol)) {
        const ci = cols.indexOf(sortCol);
        rows = [...rows].sort((a, b) => {
          const av = a[ci];
          const bv = b[ci];
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
      }
      return {
        columns: cols,
        rows,
        total_rows: preview.total,
      };
    }, [preview, sortCol, descending]);

    if (!preview) return null;

    return (
      <div
        className="nb2-preview"
        data-testid="nodeflow-preview"
        style={{ height }}
      >
        <div
          className="nb2-preview-resize"
          title="Drag to resize the results viewer"
          onPointerDown={(event) => {
            event.preventDefault();
            const startY = event.clientY;
            const startHeight = height;
            startPointerDrag({
              onMove: (moveEvent) => {
                const delta = startY - moveEvent.clientY;
                const cap = Math.max(160, window.innerHeight - 260);
                setHeight(
                  Math.max(120, Math.min(cap, startHeight + delta)),
                );
              },
            });
          }}
        />
        <div className="nb2-preview-head">
          <span>
            {preview.title}
            {preview.kind === "table"
              ? ` — ${preview.total.toLocaleString()}${
                  preview.limited ? "+" : ""
                } row${
                  preview.total === 1 && !preview.limited ? "" : "s"
                }${
                  preview.rows.length < preview.total
                    ? ` (showing ${preview.rows.length})`
                    : ""
                }`
              : ""}
          </span>
          <button className="btn ghost icon xbtn" onClick={onClose}>
            ×
          </button>
        </div>
        {preview.kind === "table" && page && (
          <DataGrid
            page={page}
            sortCol={sortCol}
            descending={descending}
            onSort={(col) => {
              if (sortCol === col) setDescending((d) => !d);
              else {
                setSortCol(col);
                setDescending(false);
              }
            }}
            onShowLineage={(col, cell) => {
              setLineageOpen({
                column: col,
                graph: getLineageGraph?.() || null,
                nodeId:
                  preview.kind === "table" ? preview.sourceNodeId : null,
                port:
                  preview.kind === "table"
                    ? preview.sourcePort || "out"
                    : null,
                rowIndex: cell?.rowIndex,
                cellValue: cell?.value ?? null,
              });
            }}
          />
        )}
        {preview.kind === "chart" && (
          <div className="nb2-preview-chart">
            <ChartView data={preview.data} fallback={PREVIEW_CHART_FALLBACK} />
          </div>
        )}
        {preview.kind === "profile" && (
          <div className="nb2-preview-grid">
            <div className="nb2-recon-totals">
              <span className="nb2-recon-pill">
                <b>
                  {preview.total.toLocaleString()}
                  {preview.limited ? "+" : ""}
                </b>{" "}
                rows
              </span>
              <span className="nb2-recon-pill">
                <b>{preview.columns.length}</b> columns
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Nulls</th>
                  <th>Distinct</th>
                  <th>Min</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {preview.columns.map((column, index) => (
                  <tr key={index}>
                    <td>{String(column.column ?? "")}</td>
                    <td>{String(column.type ?? "")}</td>
                    <td>
                      {(column.nulls ?? 0).toLocaleString?.() ??
                        String(column.nulls)}
                      {typeof column.null_pct === "number"
                        ? ` (${column.null_pct}%)`
                        : ""}
                    </td>
                    <td>
                      {(column.distinct ?? 0).toLocaleString?.() ??
                        String(column.distinct)}
                    </td>
                    <td>
                      {column.min === null || column.min === undefined
                        ? ""
                        : String(column.min)}
                    </td>
                    <td>
                      {column.max === null || column.max === undefined
                        ? ""
                        : String(column.max)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview.kind === "report" && (
          <div className="nb2-preview-grid">
            <div className="nb2-recon-totals">
              {[
                ["Matching", preview.totals.matching],
                ["Differing", preview.totals.non_matching],
                ["Only left", preview.totals.a_only],
                ["Only right", preview.totals.b_only],
                ["Total", preview.totals.total],
              ].map(([label, value]) => (
                <span key={label as string} className="nb2-recon-pill">
                  <b>{(value as number)?.toLocaleString?.() ?? "0"}</b>{" "}
                  {label}
                </span>
              ))}
            </div>
            {preview.fields.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Matching</th>
                    <th>Differing</th>
                    <th>Only L</th>
                    <th>Only R</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.fields.map((field) => (
                    <tr key={field.field}>
                      <td>{field.label || field.field}</td>
                      <td>{field.matching?.toLocaleString?.()}</td>
                      <td>{field.non_matching?.toLocaleString?.()}</td>
                      <td>{field.a_only?.toLocaleString?.()}</td>
                      <td>{field.b_only?.toLocaleString?.()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <ColumnLineageModal
          open={lineageOpen}
          onClose={() => setLineageOpen(null)}
          onHighlightNode={onHighlightNode}
        />
      </div>
    );
  },
);
