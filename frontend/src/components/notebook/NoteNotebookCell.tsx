import React, { useEffect, useRef, useState } from "react";
import type { NotebookCellProps } from "./NotebookCellTypes";
import {
  NotebookMoveDeleteActions,
  NotebookResizeGrip,
  renderNotebookNote,
} from "./NotebookCellShared";

export const NoteNotebookCell: React.FC<NotebookCellProps> = (props) => {
  const { cell } = props;
  const [editing, setEditing] = useState(!cell.text);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  return (
    <div
      className="nb-note"
      style={{ width: cell.boxW, maxWidth: cell.boxW, height: cell.boxH }}
      onDoubleClick={() => setEditing(true)}
    >
      {editing ? (
        <textarea
          ref={editorRef}
          className="nb-note-edit"
          value={cell.text}
          onChange={(event) => props.onChangeText(event.target.value)}
          onBlur={() => setEditing(false)}
          placeholder="Write a note…  **bold**, `code`, # heading, - bullet"
          spellCheck={false}
        />
      ) : (
        <div className="nb-note-view" title="Double-click to edit">
          {cell.text.trim() ? (
            renderNotebookNote(cell.text)
          ) : (
            <span className="nb-note-empty">
              Empty note — double-click to edit
            </span>
          )}
        </div>
      )}
      <NotebookMoveDeleteActions
        className="nb-note-actions"
        canMoveUp={props.canMoveUp}
        canMoveDown={props.canMoveDown}
        onMove={props.onMove}
        onDelete={props.onDelete}
        deleteTitle="Delete note"
      />
      <NotebookResizeGrip minW={220} minH={70} onResize={props.onResize} />
    </div>
  );
};
