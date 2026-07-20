import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SqlEditor } from "../SqlEditor";
import { Icon } from "../Icon";
import { startPointerDragRaf } from "../../lib/pointerDrag";
import type { TableInfo } from "../../lib/types";

const DEFAULT_W = 640;
const DEFAULT_H = 420;
const MIN_W = 420;
const MIN_H = 280;

export const SqlJoinIdeWindow: React.FC<{
  open: boolean;
  title?: string;
  sql: string;
  tables: TableInfo[];
  wiredNames: string[];
  running?: boolean;
  onChange: (sql: string) => void;
  onPreview: () => void;
  onClose: () => void;
}> = ({
  open,
  title = "SQL",
  sql,
  tables,
  wiredNames,
  running,
  onChange,
  onPreview,
  onClose,
}) => {
  const [pos, setPos] = useState(() => ({
    left: Math.max(40, Math.floor(window.innerWidth / 2 - DEFAULT_W / 2)),
    top: Math.max(40, Math.floor(window.innerHeight / 2 - DEFAULT_H / 2)),
  }));
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const posRef = useRef(pos);
  const sizeRef = useRef(size);
  posRef.current = pos;
  sizeRef.current = size;

  useEffect(() => {
    if (!open) return;
    setPos({
      left: Math.max(40, Math.floor(window.innerWidth / 2 - DEFAULT_W / 2)),
      top: Math.max(40, Math.floor(window.innerHeight / 2 - DEFAULT_H / 2)),
    });
    setSize({ w: DEFAULT_W, h: DEFAULT_H });
  }, [open]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = posRef.current;
    startPointerDragRaf({
      onMove: (ev) => {
        const maxL = Math.max(0, window.innerWidth - 120);
        const maxT = Math.max(0, window.innerHeight - 80);
        setPos({
          left: Math.max(0, Math.min(maxL, origin.left + (ev.clientX - startX))),
          top: Math.max(0, Math.min(maxT, origin.top + (ev.clientY - startY))),
        });
      },
    });
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = sizeRef.current;
    startPointerDragRaf({
      onMove: (ev) => {
        const maxW = Math.max(MIN_W, window.innerWidth - posRef.current.left - 16);
        const maxH = Math.max(MIN_H, window.innerHeight - posRef.current.top - 16);
        setSize({
          w: Math.max(MIN_W, Math.min(maxW, origin.w + (ev.clientX - startX))),
          h: Math.max(MIN_H, Math.min(maxH, origin.h + (ev.clientY - startY))),
        });
      },
    });
  }, []);

  const hint = useMemo(() => {
    if (!wiredNames.length) {
      return "Wire table inputs, then reference them by Input table name (e.g. FROM orders).";
    }
    return `Wired tables: ${wiredNames.join(", ")}. SELECT / JOIN / WITH (CTE) allowed; DDL/DML blocked.`;
  }, [wiredNames]);

  if (!open) return null;

  return createPortal(
    <div
      className="nb2-sqljoin-ide"
      data-testid="sql-ide-window"
      style={{ left: pos.left, top: pos.top, width: size.w, height: size.h }}
      role="dialog"
      aria-label={`${title} SQL editor`}
    >
      <div className="nb2-sqljoin-ide-head" onPointerDown={startDrag}>
        <span className="nb2-sqljoin-ide-title">
          <Icon.Code size={14} /> {title}
        </span>
        <span className="nb2-sqljoin-ide-actions">
          <button
            type="button"
            className="btn sm primary"
            disabled={running}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onPreview}
          >
            <Icon.Table size={13} /> Preview
          </button>
          <button
            type="button"
            className="btn ghost icon"
            title="Close editor"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            <Icon.X size={14} />
          </button>
        </span>
      </div>
      <div className="nb2-sqljoin-ide-hint">{hint}</div>
      <div className="nb2-sqljoin-ide-body">
        <SqlEditor
          value={sql}
          onChange={onChange}
          onRunAll={() => onPreview()}
          onRunStatement={() => onPreview()}
          tables={tables}
          placeholder={"SELECT *\nFROM orders\nLEFT JOIN customers ON …"}
          testId="sql-sql-editor"
        />
      </div>
      <div
        className="nb2-sqljoin-ide-resize"
        title="Drag to resize"
        onPointerDown={startResize}
      />
    </div>,
    document.body,
  );
};
