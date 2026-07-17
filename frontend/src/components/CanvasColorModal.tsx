import React, { useState } from "react";
import { createPortal } from "react-dom";
import {
  CANVAS_COLOR_PRESETS,
  DEFAULT_CANVAS_COLOR,
  type CanvasColors,
  type CanvasSurface,
} from "../lib/canvasColor";
import { Icon } from "./Icon";
import { useWinDrag } from "./ActivityShared";

const TABS: { id: CanvasSurface; label: string }[] = [
  { id: "ide", label: "IDE" },
  { id: "journal", label: "Journal" },
  { id: "node", label: "Node" },
];

type Props = {
  open: boolean;
  colors: CanvasColors;
  onPick: (surface: CanvasSurface, color: string) => void;
  onReset: (surface: CanvasSurface) => void;
  onClose: () => void;
};

export const CanvasColorModal: React.FC<Props> = ({
  open,
  colors,
  onPick,
  onReset,
  onClose,
}) => {
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag({
    x: Math.max(24, Math.round((window.innerWidth - 320) / 2)),
    y: Math.max(64, Math.round((window.innerHeight - 280) / 2)),
  });
  const [tab, setTab] = useState<CanvasSurface>("ide");

  if (!open) return null;

  const current = colors[tab];
  const wheelValue = current ?? DEFAULT_CANVAS_COLOR;

  return createPortal(
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className={
        "canvas-color-win win-float" +
        (dragging ? " dragging" : "") +
        (settled ? " settle" : "")
      }
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Change Canvas Color"
      data-testid="settings-canvas-color-panel"
    >
      <div
        className="canvas-color-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <Icon.Layers size={14} />
        <span className="canvas-color-title">Canvas Color</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm ghost"
          title="Close"
          data-testid="settings-canvas-color-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>
      <div className="canvas-color-tabs" role="tablist" aria-label="Surface">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-testid={`settings-canvas-tab-${t.id}`}
            aria-selected={tab === t.id}
            className={"canvas-color-tab" + (tab === t.id ? " on" : "")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="canvas-color-body" role="tabpanel">
        <label className="settings-canvas-color-wheel">
          <span className="settings-canvas-color-label">Color</span>
          <input
            type="color"
            data-testid="settings-canvas-color-input"
            value={wheelValue}
            aria-label={`${TABS.find((t) => t.id === tab)?.label ?? tab} canvas color`}
            onInput={(e) =>
              onPick(tab, (e.target as HTMLInputElement).value)
            }
            onChange={(e) =>
              onPick(tab, (e.target as HTMLInputElement).value)
            }
          />
        </label>
        <div
          className="settings-canvas-swatches"
          role="listbox"
          aria-label="Basic colors"
        >
          {CANVAS_COLOR_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              role="option"
              data-testid={`settings-canvas-swatch-${p.value.slice(1)}`}
              className={
                "settings-canvas-swatch" +
                ((current ?? "").toLowerCase() === p.value ? " on" : "")
              }
              title={p.label}
              aria-label={p.label}
              aria-selected={(current ?? "").toLowerCase() === p.value}
              style={{ background: p.value }}
              onClick={() => onPick(tab, p.value)}
            />
          ))}
        </div>
        <button
          type="button"
          className="btn sm ghost canvas-color-reset"
          data-testid="settings-canvas-color-reset"
          title="Restore the default background for this surface"
          onClick={() => onReset(tab)}
        >
          Reset to default
        </button>
      </div>
    </div>,
    document.body,
  );
};
