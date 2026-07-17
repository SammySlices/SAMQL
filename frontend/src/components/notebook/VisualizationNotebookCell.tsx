import React from "react";
import { ChartPanel } from "../ChartPanel";
import { PivotPanel } from "../PivotPanel";
import type { NotebookCellProps } from "./NotebookCellTypes";
import {
  NotebookMoveDeleteActions,
  NotebookResizeGrip,
} from "./NotebookCellShared";

export const VisualizationNotebookCell: React.FC<NotebookCellProps> = (
  props,
) => {
  const { cell } = props;
  const source = cell.sourceName
    ? (props.sources || []).find((candidate) => candidate.name === cell.sourceName)
    : undefined;
  const ready = !!(source && source.resultId);

  return (
    <div
      className={"nb-card nb-viz" + (cell.collapsed ? " nb-collapsed" : "")}
      style={{ width: cell.boxW, maxWidth: cell.boxW, height: cell.boxH }}
    >
      <div className="nb-cardhead">
        <span className="nb-viz-label">
          {cell.type === "chart" ? "Chart of" : "Pivot of"}
        </span>
        <select
          className="nb-viz-src"
          value={cell.sourceName ?? ""}
          onChange={(event) => props.onSetSource?.(event.target.value)}
        >
          <option value="">Select a cell…</option>
          {(props.sources || []).map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.name}
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

      {ready && source ? (
        cell.type === "chart" ? (
          <div className="nb-out-chart">
            <ChartPanel
              resultId={source.resultId as string}
              columns={source.columns}
              sampleRows={source.sampleRows}
              onExpired={props.onSourceExpired}
            />
          </div>
        ) : (
          <div className="nb-out-pivot">
            <PivotPanel
              tables={props.tables}
              result={{
                id: source.resultId as string,
                columns: source.columns,
                sampleRows: source.sampleRows,
              }}
              onToast={props.onToast}
              onExpired={props.onSourceExpired}
            />
          </div>
        )
      ) : (
        <div className="nb-viz-empty">
          {(props.sources || []).length === 0
            ? `Run a SQL cell above first, then choose it here to ${
                cell.type === "chart" ? "chart" : "pivot"
              } its result.`
            : `Choose a source cell above to ${
                cell.type === "chart" ? "chart" : "pivot"
              } its result.`}
        </div>
      )}
      <NotebookResizeGrip minW={320} minH={160} onResize={props.onResize} />
    </div>
  );
};
