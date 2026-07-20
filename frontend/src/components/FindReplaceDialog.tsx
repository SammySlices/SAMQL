import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { startPointerDragRaf } from "../lib/pointerDrag";
import type { FindOptions } from "../lib/findReplace";

const DEFAULT_W = 420;

export interface FindCriteria extends FindOptions {
  query: string;
  replacement: string;
}

interface Props {
  open: boolean;
  /** Replace mode adds the replacement row and its two buttons. */
  replaceMode: boolean;
  /** What is being searched, e.g. "this query" or "12 Journal cells". */
  scopeLabel?: string;
  matchCount: number;
  /** 0-based position of the highlighted match, or -1 when nothing is active. */
  activeIndex: number;
  /** True when a regex query failed to parse (shows an inline warning). */
  invalidPattern?: boolean;
  onCriteriaChange: (c: FindCriteria) => void;
  onNext: () => void;
  onPrev: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
  onToggleReplaceMode: (on: boolean) => void;
  onClose: () => void;
  testId?: string;
}

/**
 * A draggable, non-modal find / replace bar.
 *
 * Deliberately NOT built on `Modal`: that component traps focus and dims the
 * page, which would fight a dialog whose whole job is to act on the editor
 * behind it. This one portals to the body, stays out of the tab cycle of the
 * editor, and can be dragged aside to read the text underneath.
 *
 * The dialog owns its input state and reports it upward; the parent owns the
 * actual searching, so the IDE (one buffer) and the Journal (many cells) can
 * share this UI without it knowing anything about either.
 */
export const FindReplaceDialog: React.FC<Props> = ({
  open,
  replaceMode,
  scopeLabel,
  matchCount,
  activeIndex,
  invalidPattern,
  onCriteriaChange,
  onNext,
  onPrev,
  onReplaceNext,
  onReplaceAll,
  onToggleReplaceMode,
  onClose,
  testId = "find-replace",
}) => {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [pos, setPos] = useState(() => ({
    left: Math.max(16, window.innerWidth - DEFAULT_W - 48),
    top: 72,
  }));
  const posRef = useRef(pos);
  posRef.current = pos;
  const findRef = useRef<HTMLInputElement | null>(null);

  // Report criteria upward on every edit. `onCriteriaChange` is read through a
  // ref so a parent that re-creates the callback each render cannot re-fire
  // this effect and clobber a search already in flight.
  const changeRef = useRef(onCriteriaChange);
  changeRef.current = onCriteriaChange;
  useEffect(() => {
    changeRef.current({ query, replacement, caseSensitive, wholeWord, regex });
  }, [query, replacement, caseSensitive, wholeWord, regex]);

  // Focus (and pre-select) the find box each time the dialog opens, so a second
  // Ctrl+F over an open dialog re-targets the query instead of doing nothing.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      findRef.current?.focus();
      findRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = posRef.current;
    startPointerDragRaf({
      onMove: (ev) => {
        const maxL = Math.max(0, window.innerWidth - 160);
        const maxT = Math.max(0, window.innerHeight - 60);
        setPos({
          left: Math.max(0, Math.min(maxL, origin.left + (ev.clientX - startX))),
          top: Math.max(0, Math.min(maxT, origin.top + (ev.clientY - startY))),
        });
      },
    });
  }, []);

  if (!open) return null;

  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const status = invalidPattern
    ? "Bad pattern"
    : !query
      ? ""
      : matchCount === 0
        ? "No results"
        : `${activeIndex >= 0 ? activeIndex + 1 : 1} of ${matchCount}`;

  return createPortal(
    <div
      className="find-win"
      data-testid={testId}
      style={{ left: pos.left, top: pos.top, width: DEFAULT_W }}
      role="dialog"
      aria-label={replaceMode ? "Find and replace" : "Find"}
    >
      <div className="find-head" onPointerDown={startDrag}>
        <button
          type="button"
          className="btn ghost icon find-toggle"
          aria-label={replaceMode ? "Hide replace" : "Show replace"}
          aria-expanded={replaceMode}
          title={replaceMode ? "Hide replace (Ctrl+F)" : "Show replace (Ctrl+R)"}
          data-testid={`${testId}-toggle-replace`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onToggleReplaceMode(!replaceMode)}
        >
          <Icon.Chevron size={13} />
        </button>
        <span className="find-title">
          {replaceMode ? "Find & replace" : "Find"}
          {scopeLabel ? <span className="find-scope"> · {scopeLabel}</span> : null}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Close find"
          title="Close (Esc)"
          data-testid={`${testId}-close`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>

      <div className="find-row">
        <input
          ref={findRef}
          className="find-input"
          data-testid={`${testId}-query`}
          aria-label="Find"
          placeholder="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKey}
        />
        <span
          className={"find-count" + (invalidPattern || (query && !matchCount) ? " none" : "")}
          data-testid={`${testId}-count`}
        >
          {status}
        </span>
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Previous match"
          title="Previous (Shift+Enter)"
          data-testid={`${testId}-prev`}
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Next match"
          title="Next (Enter)"
          data-testid={`${testId}-next`}
          disabled={matchCount === 0}
          onClick={onNext}
        >
          ↓
        </button>
      </div>

      {replaceMode && (
        <div className="find-row">
          <input
            className="find-input"
            data-testid={`${testId}-replacement`}
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onReplaceNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <button
            type="button"
            className="btn sm"
            data-testid={`${testId}-replace`}
            disabled={matchCount === 0}
            title="Replace the next occurrence"
            onClick={onReplaceNext}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid={`${testId}-replace-all`}
            disabled={matchCount === 0}
            title="Replace every occurrence"
            onClick={onReplaceAll}
          >
            All
          </button>
        </div>
      )}

      <div className="find-opts">
        <label title="Match case">
          <input
            type="checkbox"
            data-testid={`${testId}-case`}
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Aa
        </label>
        <label title="Whole word">
          <input
            type="checkbox"
            data-testid={`${testId}-word`}
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          Word
        </label>
        <label title="Regular expression">
          <input
            type="checkbox"
            data-testid={`${testId}-regex`}
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />
          .*
        </label>
      </div>
    </div>,
    document.body,
  );
};
