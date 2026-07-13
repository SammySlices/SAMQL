// .533: ONE in-window confirmation for the whole app -- the same look as
// the NodeFlow's in-canvas "delete this node?" popup (it reuses those CSS
// classes), anchored beside whatever control asked. Replaces every
// window.confirm: the native dialog is dialog-host dependent in the
// pywebview window (the .524 lesson) and looks nothing like SamQL.
import React, { useCallback, useState } from "react";

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

  const ask: Ask = useCallback((anchor, msg, onOk, label = "Delete") => {
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

  const ui = st ? (
    <>
      <div
        className="nb2-delconfirm-backdrop"
        onClick={() => setSt(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setSt(null);
        }}
      />
      <div
        className={"nb2-delconfirm side-" + st.side}
        style={{ left: st.left, top: st.top }}
        role="dialog"
      >
        <div className="nb2-delconfirm-msg">{st.msg}</div>
        <div className="nb2-delconfirm-row">
          <button className="btn sm ghost" onClick={() => setSt(null)}>
            Cancel
          </button>
          <button
            className="btn sm danger"
            autoFocus
            onClick={() => {
              const f = st.onOk;
              setSt(null);
              f();
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
