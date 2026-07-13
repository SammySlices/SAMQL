import React from "react";
import { Icon } from "./Icon";

export interface Opt {
  value: string;
  label: string;
}

// A checkbox dropdown that closes when you click anywhere outside it. A
// full-screen backdrop captures the outside click (same pattern the grid /
// sidebar context menus use), so every open select closes cleanly when the
// user clicks away. Shared by the Reconcile tool and the notebook reconcile
// cell so both pick keys/fields the same way. `label` is optional: omit it
// when the surrounding layout already supplies a label.
export const MultiSelect: React.FC<{
  label?: string;
  placeholder: string;
  options: Opt[];
  selected: string[];
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (next: string[]) => void;
  showAllNone?: boolean;
}> = ({
  label,
  placeholder,
  options,
  selected,
  open,
  onToggleOpen,
  onClose,
  onChange,
  showAllNone,
}) => {
  const btnRef = React.useRef<HTMLButtonElement>(null);
  // The menu renders as a viewport-fixed overlay positioned from the trigger,
  // so it floats on top of (and escapes the clipping of) a modal/card whose
  // body has overflow:auto/hidden. It flips above the trigger when there isn't
  // room below.
  const [pos, setPos] = React.useState<{
    left: number;
    width: number;
    top: number | null;
    bottom: number | null;
  } | null>(null);
  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuMax = 240; // keep in sync with .rc-menu max-height
      const below = window.innerHeight - r.bottom;
      const flipUp = below < Math.min(menuMax, 220) && r.top > below;
      setPos({
        left: r.left,
        width: r.width,
        top: flipUp ? null : Math.round(r.bottom + 4),
        bottom: flipUp ? Math.round(window.innerHeight - r.top + 4) : null,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const toggle = (v: string) =>
    onChange(
      selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v],
    );
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 2
        ? selected.map(labelOf).join(", ")
        : `${selected.length} selected`;
  return (
    <div className="field rc-field">
      {label ? <label>{label}</label> : null}
      <div className="rc-multi">
        <button
          type="button"
          ref={btnRef}
          className={"rc-multi-btn" + (selected.length ? " has" : "")}
          disabled={options.length === 0}
          onClick={onToggleOpen}
        >
          <span className="rc-multi-summary">
            {options.length === 0 ? "—" : summary}
          </span>
          <Icon.Chevron size={14} className="rc-chev" />
        </button>
        {open && (
          <>
            <div className="rc-backdrop" onMouseDown={onClose} />
            <div
              className="rc-menu rc-menu-float"
              style={
                pos
                  ? {
                      position: "fixed",
                      left: pos.left,
                      minWidth: pos.width,
                      top: pos.top ?? "auto",
                      bottom: pos.bottom ?? "auto",
                    }
                  : undefined
              }
              onMouseDown={(e) => e.stopPropagation()}
            >
              {showAllNone && (
                <div className="rc-menu-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onChange(options.map((o) => o.value))}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onChange([])}
                  >
                    None
                  </button>
                </div>
              )}
              <div className="rc-menu-list">
                {options.map((o) => (
                  <label key={o.value} className="rc-opt">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.value)}
                      onChange={() => toggle(o.value)}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
