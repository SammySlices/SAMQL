import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  testId?: string;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export const Modal: React.FC<Props> = ({
  title,
  onClose,
  children,
  footer,
  wide,
  testId,
}) => {
  // .435: every modal EXITS as smoothly as it enters -- a short
  // closing phase plays the reverse pop, then the real onClose fires.
  // Reduce motion closes immediately.
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

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
    }, 140);
  }, [closing, onClose]);

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
        e.preventDefault();
        beginClose();
        return;
      }
      if (e.key !== "Tab") return;
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
  }, [beginClose]);

  return (
    <div
      className={"modal-backdrop" + (closing ? " closing" : "")}
      onMouseDown={beginClose}
    >
      <div
        ref={dialogRef}
        data-testid={testId}
        className={"modal" + (wide ? " wide" : "") + (closing ? " closing" : "")}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <span className="spacer" />
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
    </div>
  );
};
