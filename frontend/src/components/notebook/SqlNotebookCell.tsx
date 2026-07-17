import React, { useState } from "react";
import { ChartPanel } from "../ChartPanel";
import { ColumnLineageModal } from "../ColumnLineageModal";
import { DataGrid } from "../DataGrid";
import { ExportResultsButton } from "../ExportResultsMenu";
import { Icon } from "../Icon";
import { PivotPanel } from "../PivotPanel";
import type { ColumnLineageOpenArgs } from "../../lib/columnLineage";
import { backendResultExportFormats } from "../../lib/resultExportFormats";
import type { NotebookCellProps } from "./NotebookCellTypes";
import {
  NotebookMoveDeleteActions,
  NotebookResizeGrip,
  NotebookSqlEditor,
} from "./NotebookCellShared";

export const SqlNotebookCell: React.FC<NotebookCellProps> = (props) => {
  const { cell } = props;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState<ColumnLineageOpenArgs | null>(
    null,
  );

  const loaded = cell.page?.rows?.length ?? 0;
  const total = cell.page?.total_rows ?? 0;
  const hasMore = loaded < total;
  const gridH = Math.min(Math.max(Math.min(loaded, 12), 1) * 28 + 40, 380);

  const startRename = () => {
    setNameDraft(cell.name || "");
    setEditingName(true);
  };
  const commitRename = () => {
    setEditingName(false);
    const value = nameDraft.trim();
    if (value && value !== cell.name) props.onRename?.(value);
  };

  return (
    <div
      className="nb-card"
      style={{ width: cell.boxW, maxWidth: cell.boxW, height: cell.boxH }}
    >
      <div className="nb-cardhead">
        {editingName ? (
          <input
            className="nb-handle-edit"
            autoFocus
            spellCheck={false}
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              else if (event.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <button
            className="nb-handle"
            title="Click to rename — later cells reference this cell by this name"
            onClick={startRename}
          >
            <Icon.Compare size={11} /> {cell.name}
          </button>
        )}
        {props.stale && (
          <span
            className="nb-stale"
            title="An edit upstream or here changed this cell's query since it last ran. Re-run to refresh."
          >
            stale
          </span>
        )}
        <span className="spacer" />
        <NotebookMoveDeleteActions
          canMoveUp={props.canMoveUp}
          canMoveDown={props.canMoveDown}
          onMove={props.onMove}
          onDelete={props.onDelete}
        >
          <div className="nb-runmenu">
            <button
              className="iconbtn"
              title="Run options"
              onClick={() => setRunMenuOpen((value) => !value)}
            >
              ▸▾
            </button>
            {runMenuOpen && (
              <>
                <div
                  className="rc-backdrop"
                  onMouseDown={() => setRunMenuOpen(false)}
                />
                <div
                  className="nb-runmenu-pop"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      setRunMenuOpen(false);
                      props.onRun();
                    }}
                  >
                    Run this cell
                  </button>
                  <button
                    onClick={() => {
                      setRunMenuOpen(false);
                      props.onRunUpstream();
                    }}
                  >
                    Run with upstream
                  </button>
                  <button
                    onClick={() => {
                      setRunMenuOpen(false);
                      props.onRunDownstream();
                    }}
                  >
                    Run downstream
                  </button>
                  <button
                    onClick={() => {
                      setRunMenuOpen(false);
                      props.onRunBranch();
                    }}
                  >
                    Run whole branch
                  </button>
                </div>
              </>
            )}
          </div>
        </NotebookMoveDeleteActions>
      </div>

      {((props.deps && props.deps.length > 0) ||
        (props.dependents && props.dependents.length > 0)) && (
        <div className="nb-lineage">
          {props.deps && props.deps.length > 0 && (
            <span className="nb-lin-part" title="Cells this query reads from">
              <span className="nb-lin-key">uses</span> {props.deps.join(", ")}
            </span>
          )}
          {props.dependents && props.dependents.length > 0 && (
            <span className="nb-lin-part" title="Cells that read from this one">
              <span className="nb-lin-key">feeds</span>{" "}
              {props.dependents.join(", ")}
            </span>
          )}
        </div>
      )}

      <NotebookSqlEditor
        cell={cell}
        tables={props.tables}
        onChangeCode={props.onChangeCode}
        onRun={props.onRun}
      />

      <div className="nb-outbar">
        <span
          className={
            "nb-status" + (cell.error ? " err" : cell.ranOnce ? " ok" : "")
          }
        >
          {cell.running
            ? "running…"
            : cell.error
              ? "error"
              : cell.ranOnce
                ? `✓ ${total.toLocaleString()} row${total === 1 ? "" : "s"}${
                    cell.elapsedMs != null ? ` · ${cell.elapsedMs} ms` : ""
                  }`
                : "ready"}
        </span>

        {cell.ranOnce && !cell.error && cell.resultId && (
          <>
            <span className="nb-dot">·</span>
            <button
              className={
                "nb-tabchip" +
                ((cell.outView ?? "grid") === "grid" ? " on" : "")
              }
              onClick={() => props.onSetOutView("grid")}
            >
              Table
            </button>
            <button
              className={
                "nb-tabchip" + (cell.outView === "chart" ? " on" : "")
              }
              onClick={() => props.onSetOutView("chart")}
            >
              Chart
            </button>
            <button
              className={
                "nb-tabchip" + (cell.outView === "pivot" ? " on" : "")
              }
              onClick={() => props.onSetOutView("pivot")}
            >
              Pivot
            </button>
            <ExportResultsButton
              className="nb-export"
              triggerClassName="nb-tabchip"
              testId="notebook-export-results"
              formats={backendResultExportFormats(props.features)}
              onExport={props.onExport}
            />
          </>
        )}

        <span className="spacer" />
        {cell.ranOnce && !cell.error && (
          <button
            className="iconbtn"
            title={cell.collapsed ? "Show output" : "Hide output"}
            onClick={props.onToggleCollapse}
          >
            {cell.collapsed ? "⌄" : "⌃"}
          </button>
        )}
      </div>

      {cell.error ? (
        <div className="nb-err">{cell.error}</div>
      ) : cell.ranOnce && !cell.collapsed && cell.resultId && cell.page ? (
        cell.outView === "chart" ? (
          <div className="nb-out-chart">
            <ChartPanel
              resultId={cell.resultId}
              columns={cell.page.columns}
              sampleRows={cell.page.rows}
            />
          </div>
        ) : cell.outView === "pivot" ? (
          <div className="nb-out-pivot">
            <PivotPanel
              tables={props.tables}
              result={{
                id: cell.resultId,
                columns: cell.page.columns,
                sampleRows: cell.page.rows,
              }}
              onToast={props.onToast}
            />
          </div>
        ) : (
          <div className="nb-out" style={{ height: gridH }}>
            <DataGrid
              page={cell.page}
              sortCol={cell.sortCol ?? null}
              descending={!!cell.descending}
              onSort={props.onSort}
              onLoadMore={props.onLoadMore}
              hasMore={hasMore}
              loadingMore={!!cell.loadingMore}
              cellFetch={{
                resultId: cell.resultId ?? null,
                filters: (cell as RunCellWithFilters).filters,
              }}
              onShowLineage={(col, ctx) =>
                setLineageOpen({
                  column: col,
                  rowIndex: ctx?.rowIndex,
                  cellValue: ctx?.value ?? null,
                })
              }
            />
            <ColumnLineageModal
              open={lineageOpen}
              onClose={() => setLineageOpen(null)}
            />
          </div>
        )
      ) : null}
      <NotebookResizeGrip minW={320} minH={120} onResize={props.onResize} />
    </div>
  );
};

type RunCellWithFilters = NotebookCellProps["cell"] & {
  filters?: Record<string, string>;
};
