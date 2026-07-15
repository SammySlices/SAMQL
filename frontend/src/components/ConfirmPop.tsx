// .533: ONE in-window confirmation for the whole app -- the same look as
// the NodeFlow's in-canvas "delete this node?" popup (it reuses those CSS
// classes), anchored beside whatever control asked. Replaces every
// window.confirm: the native dialog is dialog-host dependent in the
// pywebview window (the .524 lesson) and looks nothing like SamQL.
import React, { useCallback, useEffect, useRef, useState } from "react";

/** Matches `.modal.closing` / `modal-out` duration in styles.css. */
export const POP_EXIT_MS = 160;

type Ask = (
  anchor: HTMLElement | { left: number; top: number; side?: "left" | "right" },
  message: React.ReactNode,
  onConfirm: () => void,
  confirmLabel?: string,
) => void;

export function useConfirmPop(): { ui: React.ReactNode; ask: Ask } {
  const [st, setSt] = useState<null | {
    left: number;
    top: number;
    side: "left" | "right";
    msg: React.ReactNode;
    label: string;
    onOk: () => void;
  }>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const ask: Ask = useCallback((anchor, msg, onOk, label = "Delete") => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    let left = 0;
    let top = 0;
    let side: "left" | "right" = "left";
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      // open toward the roomier half so the popup never leaves the screen
      side = r.left > window.innerWidth / 2 ? "left" : "right";
      left = side === "left" ? Math.max(8, r.left - 196) : r.right + 8;
      top = Math.max(8, r.top - 6);
    } else {
      left = anchor.left;
      top = anchor.top;
      side = anchor.side || "left";
    }
    setSt({ left, top, side, msg, label, onOk });
  }, []);

  const dismiss = useCallback((after?: () => void) => {
    if (closing || closeTimer.current != null) return;
    if (document.body.classList.contains("motion-reduced")) {
      setSt(null);
      setClosing(false);
      after?.();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setClosing(false);
      setSt(null);
      after?.();
    }, POP_EXIT_MS);
  }, [closing]);

  const ui = st ? (
    <>
      <div
        className={
          "nb2-delconfirm-backdrop" + (closing ? " closing" : "")
        }
        onClick={() => dismiss()}
        onContextMenu={(e) => {
          e.preventDefault();
          dismiss();
        }}
      />
      <div
        className={
          "nb2-delconfirm side-" + st.side + (closing ? " closing" : "")
        }
        style={{ left: st.left, top: st.top }}
        role="dialog"
      >
        <div className="nb2-delconfirm-msg">{st.msg}</div>
        <div className="nb2-delconfirm-row">
          <button className="btn sm ghost" onClick={() => dismiss()}>
            Cancel
          </button>
          <button
            className="btn sm danger"
            autoFocus
            onClick={() => {
              const f = st.onOk;
              dismiss(() => f());
            }}
          >
            {st.label}
          </button>
        </div>
      </div>
    </>
  ) : null;

  return { ui, ask };
}
