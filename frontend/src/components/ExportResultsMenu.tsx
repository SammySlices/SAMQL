import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { menuPos } from "../lib/menuPos";
import type { ExportFormatOption } from "../lib/resultExportFormats";

const FLYOUT_LEAVE_MS = 120;

function useFlyoutLeave(onClose: () => void) {
  const leaveTimer = useRef<number | null>(null);
  const clearLeave = useCallback(() => {
    if (leaveTimer.current != null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);
  const scheduleLeave = useCallback(() => {
    clearLeave();
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      onClose();
    }, FLYOUT_LEAVE_MS);
  }, [clearLeave, onClose]);
  useEffect(() => () => clearLeave(), [clearLeave]);
  return { clearLeave, scheduleLeave };
}

export interface ExportResultsButtonProps {
  formats: ExportFormatOption[];
  onExport: (fmt: string) => void;
  disabled?: boolean;
  className?: string;
  /** Extra classes on the trigger (e.g. nb-tabchip). */
  triggerClassName?: string;
  testId?: string;
  iconSize?: number;
}

/** Standalone Export Results button with a click-open submenu. */
export function ExportResultsButton({
  formats,
  onExport,
  disabled,
  className,
  triggerClassName,
  testId = "export-results-button",
  iconSize = 13,
}: ExportResultsButtonProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { clearLeave, scheduleLeave } = useFlyoutLeave(close);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const pick = (fmt: string) => {
    setOpen(false);
    onExport(fmt);
  };

  return (
    <div
      className={className ?? "export-results-wrap"}
      onMouseEnter={clearLeave}
      onMouseLeave={open ? scheduleLeave : undefined}
    >
      <button
        type="button"
        className={triggerClassName ?? "btn sm"}
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Export results"
        title="Export results"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.Download size={iconSize} /> Export Results{" "}
        <span aria-hidden>▾</span>
      </button>
      {open && !disabled && (
        <>
          <div
            className="rc-backdrop"
            onMouseDown={() => setOpen(false)}
          />
          <div
            className="export-results-menu ctx-menu"
            role="menu"
            aria-label="Export results"
            data-testid={`${testId}-menu`}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={clearLeave}
            onMouseLeave={scheduleLeave}
          >
            {formats.map(([fmt, label]) => (
              <button
                key={fmt}
                type="button"
                role="menuitem"
                data-testid={`export-${fmt}`}
                onClick={() => pick(fmt)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export interface ExportResultsCtxItemProps {
  formats: ExportFormatOption[];
  onExport: (fmt: string) => void;
  disabled?: boolean;
  onSiblingEnter?: () => void;
  testId?: string;
  showIcon?: boolean;
}

/** Context-menu row with a hover/click flyout of export formats. */
export function ExportResultsCtxItem({
  formats,
  onExport,
  disabled,
  onSiblingEnter,
  testId = "export-results-ctx",
  showIcon = true,
}: ExportResultsCtxItemProps) {
  const [flyout, setFlyout] = useState<null | { x: number; y: number }>(null);
  const closeFlyout = useCallback(() => setFlyout(null), []);
  const { clearLeave, scheduleLeave } = useFlyoutLeave(closeFlyout);

  const openAt = (el: HTMLElement) => {
    if (disabled) return;
    clearLeave();
    const r = el.getBoundingClientRect();
    setFlyout({ x: r.right - 3, y: r.top });
  };

  const toggleAt = (el: HTMLElement) => {
    if (disabled) return;
    clearLeave();
    const r = el.getBoundingClientRect();
    setFlyout((cur) =>
      cur ? null : { x: r.right - 3, y: r.top },
    );
  };

  const pick = (fmt: string) => {
    closeFlyout();
    onExport(fmt);
  };

  return (
    <>
      <button
        type="button"
        className="has-sub"
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={!!flyout}
        aria-label="Export results"
        onMouseEnter={(e) => {
          onSiblingEnter?.();
          openAt(e.currentTarget);
        }}
        onMouseLeave={scheduleLeave}
        onMouseDown={(e) => {
          e.preventDefault();
          toggleAt(e.currentTarget);
        }}
      >
        <span>
          {showIcon && <Icon.Download size={13} />} Export Results
        </span>
        <span className="chev" aria-hidden>
          ▸
        </span>
      </button>
      {flyout && !disabled && (
        <div
          className="ctx-menu export-results-flyout"
          role="menu"
          aria-label="Export results"
          data-testid={`${testId}-menu`}
          style={{ ...menuPos(flyout.x, flyout.y, 200), zIndex: 133 }}
          onMouseEnter={clearLeave}
          onMouseLeave={scheduleLeave}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {formats.map(([fmt, label]) => (
            <button
              key={fmt}
              type="button"
              role="menuitem"
              data-testid={`export-${fmt}`}
              onClick={() => pick(fmt)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Format buttons for an already-open panel (e.g. IDE Output menu). */
export function ExportResultsMenuItems({
  formats,
  onExport,
  onDone,
}: {
  formats: ExportFormatOption[];
  onExport: (fmt: string) => void;
  onDone?: () => void;
}) {
  return (
    <>
      {formats.map(([fmt, label]) => (
        <button
          key={fmt}
          type="button"
          className="btn ghost"
          role="menuitem"
          data-testid={`export-${fmt}`}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            borderRadius: 0,
          }}
          onClick={() => {
            onExport(fmt);
            onDone?.();
          }}
        >
          {label}
        </button>
      ))}
    </>
  );
}
