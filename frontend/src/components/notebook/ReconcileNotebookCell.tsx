import React, { useState } from "react";
import { api, saveToDownloads } from "../../lib/api";
import { DataGrid } from "../DataGrid";
import { MultiSelect } from "../MultiSelect";
import { Profiler } from "../Profiler";
import { ReconReport } from "../ReconReport";
import type { NotebookCellProps } from "./NotebookCellTypes";
import { NotebookMoveDeleteActions } from "./NotebookCellShared";

export const ReconcileNotebookCell: React.FC<NotebookCellProps> = (props) => {
  const { cell } = props;
  const recon = cell.recon || { keys: [], compare: [] };
  const sources = props.reconSources || [];
  const columnsOf = (name?: string) =>
    name ? sources.find((source) => source.name === name)?.columns || [] : [];
  const common = columnsOf(cell.leftSource).filter((column) =>
    columnsOf(cell.rightSource).includes(column),
  );
  const [openSelector, setOpenSelector] = useState<"keys" | "compare" | null>(
    null,
  );

  return (
    <div
      className={"nb-card nb-recon" + (cell.collapsed ? " nb-collapsed" : "")}
    >
      <div className="nb-cardhead">
        <span className="nb-viz-label">Reconcile</span>
        <select
          className="nb-viz-src"
          value={cell.leftSource ?? ""}
          onChange={(event) =>
            props.onSetReconSource?.("left", event.target.value)
          }
        >
          <option value="">Left…</option>
          {sources.map((source) => (
            <option key={source.name} value={source.name}>
              {source.name}
            </option>
          ))}
        </select>
        <span className="nb-recon-vs">vs</span>
        <select
          className="nb-viz-src"
          value={cell.rightSource ?? ""}
          onChange={(event) =>
            props.onSetReconSource?.("right", event.target.value)
          }
        >
          <option value="">Right…</option>
          {sources.map((source) => (
            <option key={source.name} value={source.name}>
              {source.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <NotebookMoveDeleteActions
          canMoveUp={props.canMoveUp}
          canMoveDown={props.canMoveDown}
          onMove={props.onMove}
          onDelete={props.onDelete}
          after={
            <button
              className="iconbtn"
            title={cell.collapsed ? "Expand" : "Minimize"}
            onClick={props.onToggleCollapse}
          >
            {cell.collapsed ? "⌄" : "⌃"}
            </button>
          }
        />
      </div>

      {!cell.leftSource || !cell.rightSource ? (
        <div className="nb-viz-empty">
          Choose a left and right source (an earlier SQL cell or a loaded table)
          to compare.
        </div>
      ) : common.length === 0 ? (
        <div className="nb-viz-empty">
          No shared columns yet — run the source cells (or pick tables) so their
          columns are known.
        </div>
      ) : (
        <div className="nb-recon-cfg">
          <div className="nb-recon-row">
            <span className="nb-recon-lbl">Keys</span>
            <MultiSelect
              placeholder="Select keys…"
              options={common.map((column) => ({ value: column, label: column }))}
              selected={recon.keys}
              open={openSelector === "keys"}
              onToggleOpen={() =>
                setOpenSelector((open) => (open === "keys" ? null : "keys"))
              }
              onClose={() => setOpenSelector(null)}
              onChange={(keys) => props.onSetReconSpec?.({ ...recon, keys })}
            />
          </div>
          <div className="nb-recon-row">
            <span className="nb-recon-lbl">Compare</span>
            <MultiSelect
              placeholder="Select fields…"
              options={common
                .filter((column) => !recon.keys.includes(column))
                .map((column) => ({ value: column, label: column }))}
              selected={recon.compare}
              open={openSelector === "compare"}
              onToggleOpen={() =>
                setOpenSelector((open) =>
                  open === "compare" ? null : "compare",
                )
              }
              onClose={() => setOpenSelector(null)}
              onChange={(compare) =>
                props.onSetReconSpec?.({ ...recon, compare })
              }
              showAllNone
            />
          </div>
          <div className="nb-recon-row">
            <span className="nb-recon-lbl">Balance</span>
            <select
              className="nb-viz-src"
              value={recon.balance ?? ""}
              onChange={(event) =>
                props.onSetReconSpec?.({
                  ...recon,
                  balance: event.target.value || undefined,
                })
              }
            >
              <option value="">(none)</option>
              {recon.compare.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button
              className={"btn sm " + (cell.reconRunning ? "ghost" : "primary")}
              disabled={!recon.keys.length && !cell.reconRunning}
              onClick={cell.reconRunning ? props.onCancel : props.onRunReconcile}
              title={
                cell.reconRunning
                  ? "Cancel this reconcile"
                  : "Run the reconcile"
              }
            >
              {cell.reconRunning ? "■ Stop" : "Reconcile"}
            </button>
          </div>
        </div>
      )}

      {cell.reconError ? (
        <div className="nb-cell-error">{cell.reconError}</div>
      ) : cell.reconReport && cell.reconRanSpec ? (
        <div className="nb-recon-out">
          {props.reconNeedsManualRefresh && !cell.reconRunning ? (
            <div className="nb-recon-stale">
              Inputs changed — click <b>Reconcile</b> to refresh (auto-refresh is
              off for large sources).
            </div>
          ) : null}
          <ReconReport
            report={cell.reconReport}
            spec={cell.reconRanSpec}
            onDrill={(bucket, field) => props.onReconDrill?.(bucket, field)}
            onProfile={(bucket, field) => props.onReconProfile?.(bucket, field)}
            onExport={(filename, csv) => {
              saveToDownloads(filename, { text: csv })
                .then((result) =>
                  props.onToast?.("ok", "Exported", result.path),
                )
                .catch((error: unknown) =>
                  props.onToast?.(
                    "error",
                    "Export failed",
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
            onExportFailures={async () => {
              const exportId =
                "exp-" +
                (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
              try {
                const result = await api.reconFailuresCsv(
                  cell.reconRanSpec!,
                  exportId,
                );
                if (result.cancelled) {
                  props.onToast?.("warn", "Export cancelled", "");
                  return;
                }
                props.onToast?.(
                  "ok",
                  `Exported ${result.rows ?? 0} failed values`,
                  result.path || "",
                );
              } catch (error: unknown) {
                props.onToast?.(
                  "error",
                  "Export failed",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
          {cell.reconDetail ? (
            <div className="nb-recon-detail">
              <div className="nb-recon-detailhead">
                <span>
                  {cell.reconDetail.kind === "drill" ? "Rows" : "Profile"}:{" "}
                  {cell.reconDetail.title}
                </span>
                <button
                  className="iconbtn"
                  title="Close"
                  onClick={props.onReconDetailClose}
                >
                  ✕
                </button>
              </div>
              {cell.reconDetail.loading ? (
                <div className="nb-viz-empty">Loading…</div>
              ) : cell.reconDetail.kind === "drill" &&
                cell.reconDetail.page ? (
                <div className="nb-out-grid" style={{ height: 320 }}>
                  <DataGrid
                    page={cell.reconDetail.page}
                    sortCol={null}
                    descending={false}
                    onSort={() => {}}
                    onLoadMore={() => {}}
                    hasMore={false}
                    loadingMore={false}
                  />
                </div>
              ) : cell.reconDetail.kind === "profile" &&
                cell.reconDetail.profile ? (
                <Profiler
                  profile={cell.reconDetail.profile}
                  loading={false}
                  tableName={cell.reconDetail.title}
                />
              ) : (
                <div className="nb-viz-empty">No rows.</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
