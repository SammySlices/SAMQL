import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  testId?: string;
  /**
   * Cheaper open/close for large interactive shells (Load File, file browser):
   * opacity-only motion, lighter shadow. Visual language stays the same;
   * skips scale/translate that thrash with the dimmed app.
   */
  fast?: boolean;
  /**
   * When true, Escape and backdrop click do not dismiss. The header Close
   * control still closes. Pair with onTogglePin to show a pin control.
   */
  pinned?: boolean;
  onTogglePin?: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Stack of mounted modals (push on mount, pop on unmount). Only the
// topmost entry answers Escape / backdrop dismissal, so Escape in a nested
// shell (Load File → Browse) closes just that shell, not the modal below.
const modalStack: symbol[] = [];

export const Modal: React.FC<Props> = ({
  title,
  onClose,
  children,
  footer,
  wide,
  testId,
  fast,
  pinned,
  onTogglePin,
}) => {
  // .435: every modal EXITS as smoothly as it enters -- a short
  // closing phase plays the soft pop-out (modal-out), then onClose fires.
  // Reduce motion closes immediately.
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const closeMs = fast ? 120 : 160;
  const [stackId] = useState(() => Symbol("modal"));
  const isTopmost = useCallback(
    () => modalStack[modalStack.length - 1] === stackId,
    [stackId],
  );

  useEffect(() => {
    modalStack.push(stackId);
    return () => {
      const i = modalStack.lastIndexOf(stackId);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [stackId]);

  const beginClose = useCallback(() => {
    if (closing || closeTimer.current != null) return;
    if (document.body.classList.contains("motion-reduced")) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onClose();
    }, closeMs);
  }, [closing, closeMs, onClose]);

  const beginDismiss = useCallback(() => {
    if (pinned) return;
    // A nested modal above this one owns dismissal; leave it to them.
    if (!isTopmost()) return;
    beginClose();
  }, [beginClose, pinned, isTopmost]);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first || dialog)?.focus();

    return () => {
      if (closeTimer.current != null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      const prior = previousFocus.current;
      if (prior?.isConnected) prior.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A nested modal above this one owns Escape; leave it to them.
        if (!isTopmost()) return;
        e.preventDefault();
        beginDismiss();
        return;
      }
      if (e.key !== "Tab" || !isTopmost()) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
      if (!items.length) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [beginDismiss, isTopmost]);

  // Portal to body so nested shells (Load File → Browse) are not trapped by
  // an ancestor's contain/overflow/radius — fixed backdrops must cover the
  // viewport, not the parent modal's padding box.
  return createPortal(
    <div
      className={
        "modal-backdrop" +
        (fast ? " fast" : "") +
        (closing ? " closing" : "")
      }
      onMouseDown={beginDismiss}
    >
      <div
        ref={dialogRef}
        data-testid={testId}
        className={
          "modal" +
          (wide ? " wide" : "") +
          (fast ? " fast" : "") +
          (closing ? " closing" : "")
        }
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <span className="spacer" />
          {onTogglePin && (
            <button
              type="button"
              className={
                "btn ghost sm modal-pin-btn" + (pinned ? " pin-on" : "")
              }
              onClick={onTogglePin}
              title={pinned ? "Unpin — allow panel to close" : "Keep panel open"}
              aria-label={pinned ? "Unpin panel" : "Keep panel open"}
              aria-pressed={!!pinned}
              data-testid="modal-pin"
            >
              <Icon.Pin size={14} className={pinned ? "pin-on" : undefined} />
              {pinned ? "Pinned" : "Pin"}
            </button>
          )}
          <button
            className="btn ghost icon"
            onClick={beginClose}
            title="Close"
            aria-label={`Close ${title}`}
          >
            <Icon.X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};
