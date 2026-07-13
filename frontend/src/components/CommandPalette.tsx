import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

export type CommandPaletteItem = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
};

interface Props {
  open: boolean;
  onClose: () => void;
  commands: CommandPaletteItem[];
}

function matches(item: CommandPaletteItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.label} ${item.group} ${item.keywords || ""} ${item.hint || ""}`
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token));
}

export const CommandPalette: React.FC<Props> = ({
  open,
  onClose,
  commands,
}) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () => commands.filter((item) => matches(item, query)),
    [commands, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${active}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, filtered.length]);

  if (!open) return null;

  const runAt = (index: number) => {
    const item = filtered[index];
    if (!item || item.disabled) return;
    onClose();
    // Defer so the palette unmounts before the action opens another modal.
    window.setTimeout(() => item.run(), 0);
  };

  const groups: { name: string; items: { item: CommandPaletteItem; index: number }[] }[] =
    [];
  filtered.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (!last || last.name !== item.group) {
      groups.push({ name: item.group, items: [{ item, index }] });
    } else {
      last.items.push({ item, index });
    }
  });

  return (
    <div
      className="cmd-palette-backdrop"
      data-testid="command-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmd-palette-head">
          <Icon.ScanSearch size={16} />
          <input
            ref={inputRef}
            className="cmd-palette-input"
            data-testid="command-palette-input"
            placeholder="Type a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) =>
                  filtered.length ? (i + 1) % filtered.length : 0,
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) =>
                  filtered.length
                    ? (i - 1 + filtered.length) % filtered.length
                    : 0,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                runAt(active);
              }
            }}
          />
          <kbd className="cmd-palette-kbd">Esc</kbd>
        </div>
        <div className="cmd-palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div className="cmd-palette-empty">No matching commands.</div>
          ) : (
            groups.map((group) => (
              <div key={group.name} className="cmd-palette-group">
                <div className="cmd-palette-group-label">{group.name}</div>
                {group.items.map(({ item, index }) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-cmd-index={index}
                    data-testid={`command-palette-item-${item.id}`}
                    className={
                      "cmd-palette-item" +
                      (index === active ? " active" : "") +
                      (item.disabled ? " disabled" : "")
                    }
                    disabled={item.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runAt(index)}
                  >
                    <span className="cmd-palette-item-label">{item.label}</span>
                    {item.hint && (
                      <kbd className="cmd-palette-item-hint">{item.hint}</kbd>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmd-palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
};
