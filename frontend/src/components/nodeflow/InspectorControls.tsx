import React, { useState } from "react";

export function ReorderList<T>(props: {
  items: T[];
  onChange: (next: T[]) => void;
  keyOf: (item: T, i: number) => string | number;
  renderItem: (item: T, i: number) => React.ReactNode;
}) {
  const { items, onChange, keyOf, renderItem } = props;
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    const next = items.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };
  return (
    <div className="nb2-reorder">
      {items.map((it, i) => (
        <div
          key={keyOf(it, i)}
          className={
            "nb2-reorder-item" +
            (over === i && drag !== null && drag !== i ? " over" : "") +
            (drag === i ? " dragging" : "")
          }
          draggable
          onDragStart={(e) => {
            setDrag(i);
            e.dataTransfer.effectAllowed = "move";
            try {
              e.dataTransfer.setData("text/plain", String(i));
            } catch {
              /* some browsers require setData; ignore if unsupported */
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== i) setOver(i);
          }}
          onDragEnd={() => {
            setDrag(null);
            setOver(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drag !== null && drag !== i) move(drag, i);
            setDrag(null);
            setOver(null);
          }}
        >
          <span className="nb2-grip" aria-hidden="true">
            ⠿
          </span>
          <div className="nb2-reorder-body">{renderItem(it, i)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * True when `name` is absent from `available` (case-insensitive).
 * `null` / `undefined` available = upstream unknown (do not flash missing).
 * Empty array = known empty upstream (name is missing).
 */
export function isColumnMissingUpstream(
  name: string | null | undefined,
  available: string[] | null | undefined,
): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  if (available == null) return false;
  const up = new Set(available.map((c) => String(c).toLowerCase()));
  return !up.has(n.toLowerCase());
}

/**
 * Option list for a column `<select>`: keeps a missing current value visible
 * (so the control is not blank) and marks it for strikethrough styling.
 */
export function ColumnOptions(props: {
  available?: string[] | null;
  value?: string | null;
  emptyLabel?: string;
}) {
  const avail = props.available;
  const list = avail || [];
  const v = String(props.value || "").trim();
  const missing = isColumnMissingUpstream(v, avail);
  return (
    <>
      {props.emptyLabel != null && (
        <option value="">{props.emptyLabel}</option>
      )}
      {missing && (
        <option value={v} data-missing="1">
          {v}
        </option>
      )}
      {list.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </>
  );
}

export function ColumnPicker(props: {
  chosen: string[];
  available?: string[] | null;
  onChange: (next: string[]) => void;
  addLabel: string;
}) {
  const { chosen, available, onChange, addLabel } = props;
  const list = available || [];
  const addable = list.filter((c) => !chosen.includes(c));
  return (
    <>
      {chosen.length > 0 && (
        <ReorderList
          items={chosen}
          keyOf={(c) => c}
          onChange={onChange}
          renderItem={(c) => {
            const missing = isColumnMissingUpstream(c, available);
            return (
              <>
                <span
                  className={
                    "nb2-reorder-name" + (missing ? " nb2-col-missing" : "")
                  }
                  data-missing={missing ? "1" : undefined}
                  title={
                    missing
                      ? "This field is no longer in the upstream output"
                      : c
                  }
                >
                  {c}
                </span>
                <button
                  className="btn ghost icon xbtn"
                  title="Remove"
                  onClick={() => onChange(chosen.filter((x) => x !== c))}
                >
                  ×
                </button>
              </>
            );
          }}
        />
      )}
      {addable.length > 0 && (
        <select
          className="nb2-in nb2-addfield"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange([...chosen, e.target.value]);
          }}
        >
          <option value="">{addLabel}</option>
          {addable.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
