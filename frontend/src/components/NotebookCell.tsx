import React from "react";
import { Icon } from "./Icon";
import { NotebookAddControls } from "./notebook/NotebookCellShared";
import type {
  NotebookCellProps,
  RunCell,
} from "./notebook/NotebookCellTypes";
import { NoteNotebookCell } from "./notebook/NoteNotebookCell";
import { ReconcileNotebookCell } from "./notebook/ReconcileNotebookCell";
import { SqlNotebookCell } from "./notebook/SqlNotebookCell";
import { VisualizationNotebookCell } from "./notebook/VisualizationNotebookCell";

export type { NotebookCellProps, RunCell } from "./notebook/NotebookCellTypes";

/**
 * Shared notebook-cell shell.
 *
 * The shell owns only cross-cell concerns: status flash, drag/drop chrome,
 * execution badge, renderer dispatch, and add-below controls. SQL, note,
 * visualization, and reconcile behavior each live in a focused renderer under
 * components/notebook/ so a change to one cell type cannot disturb the others.
 */
const NotebookCellImpl: React.FC<NotebookCellProps> = (props) => {
  const [justOk, setJustOk] = React.useState(false);
  const okTimer = React.useRef<number | null>(null);
  const wasRunning = React.useRef(false);

  React.useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = !!props.cell.running;
    if (was && !props.cell.running && !props.cell.error && props.cell.ranOnce) {
      if (okTimer.current != null) window.clearTimeout(okTimer.current);
      setJustOk(false);
      requestAnimationFrame(() => setJustOk(true));
      okTimer.current = window.setTimeout(() => {
        setJustOk(false);
        okTimer.current = null;
      }, 1000);
    }
  }, [props.cell.running, props.cell.error, props.cell.ranOnce]);

  React.useEffect(
    () => () => {
      if (okTimer.current != null) window.clearTimeout(okTimer.current);
    },
    [],
  );

  const { cell } = props;
  const isSql = cell.type === "sql";
  const isVisualization = cell.type === "chart" || cell.type === "pivot";
  const isReconcile = cell.type === "reconcile";

  return (
    <div
      data-testid="journal-cell"
      data-cellid={cell.id}
      data-cell-name={cell.name}
      data-cell-type={cell.type}
      className={
        "nb-cell" +
        (cell.running ? " running" : "") +
        (justOk ? " just-ok" : "") +
        (isSql
          ? ""
          : isVisualization
            ? " viz"
            : isReconcile
              ? " recon"
              : " note") +
        (props.dragging ? " dragging" : "") +
        (props.dropEdge === "top" ? " drop-top" : "") +
        (props.dropEdge === "bottom" ? " drop-bottom" : "")
      }
      data-cell-id={cell.id}
    >
      <div className="nb-gutter">
        <button
          className="nb-grip"
          title="Drag to reorder"
          style={{ touchAction: "none" }}
          onPointerDown={props.onReorderStart}
        >
          ⠿
        </button>
        <div className="nb-spine" />
        {isSql ? (
          <button
            data-testid="journal-cell-run"
            className={
              "nb-badge" +
              (cell.running ? " run" : cell.ranOnce ? " ran" : "")
            }
            title={cell.running ? "Cancel" : "Run this cell"}
            onClick={cell.running ? props.onCancel : props.onRun}
          >
            {cell.running ? "■" : cell.ranOnce ? props.index : "▸"}
          </button>
        ) : isVisualization ? (
          <div
            className="nb-badge viz"
            title={cell.type === "chart" ? "Chart" : "Pivot"}
          >
            {cell.type === "chart" ? (
              <Icon.Chart size={12} />
            ) : (
              <Icon.Table size={12} />
            )}
          </div>
        ) : isReconcile ? (
          <div className="nb-badge recon" title="Reconcile">
            ⇄
          </div>
        ) : (
          <div className="nb-badge note" title="Note">
            ✎
          </div>
        )}
      </div>

      <div className="nb-body">
        {isSql ? (
          <SqlNotebookCell {...props} />
        ) : isVisualization ? (
          <VisualizationNotebookCell {...props} />
        ) : isReconcile ? (
          <ReconcileNotebookCell {...props} />
        ) : (
          <NoteNotebookCell {...props} />
        )}
        <NotebookAddControls onAddBelow={props.onAddBelow} />
      </div>
    </div>
  );
};

function cellPropsEqual(
  previous: NotebookCellProps,
  next: NotebookCellProps,
): boolean {
  if (previous.sources || next.sources) return false;
  return (
    previous.cell === next.cell &&
    previous.index === next.index &&
    previous.stale === next.stale &&
    previous.dragging === next.dragging &&
    previous.dropEdge === next.dropEdge &&
    previous.canMoveUp === next.canMoveUp &&
    previous.canMoveDown === next.canMoveDown &&
    previous.tables === next.tables &&
    previous.deps === next.deps &&
    previous.dependents === next.dependents &&
    !!previous.features?.pyarrow === !!next.features?.pyarrow
  );
}

export const NotebookCell = React.memo(NotebookCellImpl, cellPropsEqual);
