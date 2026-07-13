import React from "react";
import { startPointerDrag } from "../../lib/pointerDrag";
import { Icon } from "../Icon";
import { SqlEditor } from "../SqlEditor";
import type { TableInfo } from "../../lib/types";
import type { RunCell } from "./NotebookCellTypes";

export function renderNotebookNote(text: string) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: React.ReactNode[] = [];
  const flush = (key: number) => {
    if (!bullets.length) return;
    out.push(
      <ul key={"ul" + key} className="nb-note-ul">
        {bullets}
      </ul>,
    );
    bullets = [];
  };
  const inline = (value: string) =>
    value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={index} className="nb-code">
          {part.slice(1, -1)}
        </code>
      ) : (
        <span key={index}>{part}</span>
      ),
    );

  lines.forEach((line, index) => {
    if (/^#{1,3}\s/.test(line)) {
      flush(index);
      const level = line.match(/^#+/)![0].length;
      out.push(
        <div key={index} className={"nb-note-h h" + level}>
          {inline(line.replace(/^#+\s/, ""))}
        </div>,
      );
    } else if (/^[-*]\s/.test(line)) {
      bullets.push(
        <li key={index}>{inline(line.replace(/^[-*]\s/, ""))}</li>,
      );
    } else if (line.trim() === "") {
      flush(index);
    } else {
      flush(index);
      out.push(
        <p key={index} className="nb-note-p">
          {inline(line)}
        </p>,
      );
    }
  });
  flush(lines.length);
  return out;
}

export const NotebookResizeGrip: React.FC<{
  minW: number;
  minH: number;
  onResize: (width: number, height: number) => void;
}> = ({ minW, minH, onResize }) => (
  <div
    className="nb-resize"
    title="Drag to resize (down + right)"
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const parent = event.currentTarget.parentElement as HTMLElement | null;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = rect.width;
      const startH = rect.height;
      startPointerDrag({
        onMove: (moveEvent) => {
          onResize(
            Math.max(minW, Math.round(startW + moveEvent.clientX - startX)),
            Math.max(minH, Math.round(startH + moveEvent.clientY - startY)),
          );
        },
      });
    }}
  />
);

export const NotebookMoveDeleteActions: React.FC<{
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  deleteTitle?: string;
  className?: string;
  children?: React.ReactNode;
  after?: React.ReactNode;
}> = ({
  canMoveUp,
  canMoveDown,
  onMove,
  onDelete,
  deleteTitle = "Delete cell",
  className = "nb-cell-actions",
  children,
  after,
}) => (
  <div className={className}>
    {children}
    <button
      className="iconbtn"
      title="Move up"
      disabled={!canMoveUp}
      onClick={() => onMove(-1)}
    >
      ↑
    </button>
    <button
      className="iconbtn"
      title="Move down"
      disabled={!canMoveDown}
      onClick={() => onMove(1)}
    >
      ↓
    </button>
    <button className="iconbtn danger" title={deleteTitle} onClick={onDelete}>
      <Icon.Trash size={13} />
    </button>
    {after}
  </div>
);

export const NotebookAddControls: React.FC<{
  onAddBelow: (type: RunCell["type"]) => void;
}> = ({ onAddBelow }) => (
  <div className="nb-add">
    <button onClick={() => onAddBelow("sql")}>
      <Icon.Plus size={11} /> SQL
    </button>
    <button onClick={() => onAddBelow("note")}>
      <Icon.Plus size={11} /> Note
    </button>
    <button onClick={() => onAddBelow("chart")}>
      <Icon.Chart size={11} /> Chart
    </button>
    <button onClick={() => onAddBelow("pivot")}>
      <Icon.Table size={11} /> Pivot
    </button>
    <button onClick={() => onAddBelow("reconcile")}>
      <span style={{ fontSize: 12 }}>⇄</span> Reconcile
    </button>
  </div>
);

export const NotebookSqlEditor: React.FC<{
  cell: RunCell;
  tables: TableInfo[];
  onChangeCode: (value: string) => void;
  onRun: () => void;
}> = ({ cell, tables, onChangeCode, onRun }) => {
  const lines = Math.min(Math.max(cell.code.split("\n").length, 2), 16);
  return (
    <div className="nb-ed" style={{ minHeight: lines * 20 + 22 }}>
      <SqlEditor
        value={cell.code}
        onChange={onChangeCode}
        onRunAll={onRun}
        onRunStatement={onRun}
        tables={tables}
        testId="notebook-sql-editor"
        placeholder="SELECT …   ⌘/Ctrl+Enter to run this cell"
      />
    </div>
  );
};
