import React, { useEffect, useMemo, useState } from "react";
import { useWinDrag } from "./ActivityShared";
import { Icon } from "./Icon";
import type { TableInfo } from "../lib/types";
import { formatCount } from "../lib/format";
import {
  NB_CREATED_NODE_MIME,
  NB_NODE_MIME,
  createdFavoriteKey,
} from "../lib/nodeFlowModel";
import type { CreatedNodeIcon } from "../lib/createdNodes";
import {
  NODE_BY_TYPE,
  NODE_GROUPS,
  type NodeIconName,
} from "./nodeflow/nodeDefinitions";
import type { useNodeFlowPalette } from "./nodeflow/NodeFlowPalette";

// Floating Tools & Tables window — NodeFlow only. Tables list + node palette
// with section mini-tabs, drag-to-canvas, and drag-to-favorites.

export const TOOLS_TABLES_STORE_KEY = "samql.nodeflow.toolsTables.v1";

type ToolsTab = "tables" | "nodes";
type NodeSection = "favorites" | "created" | (typeof NODE_GROUPS)[number]["id"];

type StoredChrome = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  minimized?: boolean;
  tab?: ToolsTab;
  nodeSection?: NodeSection;
};

function loadChrome(): StoredChrome {
  try {
    const raw = localStorage.getItem(TOOLS_TABLES_STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredChrome) : {};
  } catch {
    return {};
  }
}

function saveChrome(patch: StoredChrome) {
  try {
    const next = { ...loadChrome(), ...patch };
    localStorage.setItem(TOOLS_TABLES_STORE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function engineBadge(engine: string): string {
  if (engine === "duckdb") return "duck";
  if (engine === "remote") return "sql";
  return "sqlite";
}

interface Props {
  open: boolean;
  onClose: () => void;
  tables: TableInfo[];
  onRefreshTables?: () => void;
  onOpenLoad?: () => void;
  palette: ReturnType<typeof useNodeFlowPalette>;
}

export const ToolsTablesPanel: React.FC<Props> = ({
  open,
  onClose,
  tables,
  onRefreshTables,
  onOpenLoad,
  palette,
}) => {
  const saved = useMemo(() => loadChrome(), []);
  const [minimized, setMinimized] = useState(() => !!saved.minimized);
  const [tab, setTab] = useState<ToolsTab>(() =>
    saved.tab === "nodes" ? "nodes" : "tables",
  );
  const [nodeSection, setNodeSection] = useState<NodeSection>(() => {
    const s = saved.nodeSection;
    if (s === "favorites" || s === "created") return s;
    if (NODE_GROUPS.some((g) => g.id === s)) return s as NodeSection;
    return "favorites";
  });
  const [tableQ, setTableQ] = useState("");
  const [favDrop, setFavDrop] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const initPos = {
    x: typeof saved.x === "number" ? saved.x : 72,
    y: typeof saved.y === "number" ? saved.y : 96,
  };
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag(initPos);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !minimized) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, minimized, onClose]);

  useEffect(() => {
    if (!open) return;
    saveChrome({
      x: pos.x,
      y: pos.y,
      minimized,
      tab,
      nodeSection,
    });
  }, [open, pos.x, pos.y, minimized, tab, nodeSection]);

  const visibleTables = useMemo(() => {
    const q = tableQ.trim().toLowerCase();
    return tables.filter((t) => {
      if (t.name.startsWith("__")) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        (t.group || "").toLowerCase().includes(q) ||
        (t.source || "").toLowerCase().includes(q)
      );
    });
  }, [tables, tableQ]);

  if (!open) return null;

  const persistSize = () => {
    const el = winRef.current;
    if (!el || minimized) return;
    saveChrome({
      w: el.offsetWidth,
      h: el.offsetHeight,
      x: pos.x,
      y: pos.y,
    });
  };

  if (minimized) {
    return (
      <button
        ref={winRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className={
          "tt-mini win-float" +
          (dragging ? " dragging" : "") +
          (settled ? " settle" : "")
        }
        style={{ left: pos.x, top: pos.y }}
        data-testid="tools-tables-mini"
        title="Tools & Tables — drag to move; click to expand"
        onMouseDown={(event) => {
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          const onMove = (ev: MouseEvent) => {
            if (
              Math.abs(ev.clientX - startX) > 4 ||
              Math.abs(ev.clientY - startY) > 4
            ) {
              moved = true;
            }
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            if (!moved) {
              setMinimized(false);
              saveChrome({ minimized: false });
            }
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          startDrag(event);
        }}
      >
        <Icon.Layers size={14} />
        <span>Tools</span>
      </button>
    );
  }

  const sizeStyle: React.CSSProperties = {
    left: pos.x,
    top: pos.y,
  };
  if (typeof saved.w === "number") sizeStyle.width = saved.w;
  if (typeof saved.h === "number") sizeStyle.height = saved.h;

  const sectionButtons: {
    id: NodeSection;
    label: string;
    icon: NodeIconName | "Star" | "Sparkle";
  }[] = [
    { id: "favorites", label: "Favorites", icon: "Star" },
    ...NODE_GROUPS.map((g) => ({
      id: g.id as NodeSection,
      label: g.label,
      icon: g.icon,
    })),
    { id: "created", label: "Created", icon: "Sparkle" },
  ];

  const renderNodeButtons = () => {
    if (nodeSection === "favorites") {
      if (palette.favorites.length === 0) {
        return (
          <div className="tt-empty">
            Drag nodes here (or onto Favorites in the toolbar) to pin shortcuts.
          </div>
        );
      }
      return palette.favorites.map((key) => {
        if (key.startsWith("created:")) {
          const id = key.slice("created:".length);
          const def = palette.createdNodes.find((d) => d.id === id);
          if (!def) return null;
          const iconName = (def.icon || "Sparkle") as CreatedNodeIcon;
          const NodeIcon = (Icon[iconName] || Icon.Sparkle) as React.FC<{
            size?: number;
          }>;
          return (
            <button
              key={key}
              type="button"
              className="btn sm tt-node"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(NB_CREATED_NODE_MIME, id);
                event.dataTransfer.effectAllowed = "copyMove";
              }}
              title={`Drag ${def.name} onto the canvas`}
            >
              <NodeIcon size={13} /> {def.name}
            </button>
          );
        }
        const item = NODE_BY_TYPE[key as keyof typeof NODE_BY_TYPE];
        if (!item) return null;
        const NodeIcon = Icon[item.icon] as React.FC<{ size?: number }>;
        return (
          <button
            key={key}
            type="button"
            className="btn sm tt-node"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(NB_NODE_MIME, key);
              event.dataTransfer.effectAllowed = "copyMove";
            }}
            title={`Drag ${item.label} onto the canvas`}
          >
            <NodeIcon size={13} /> {item.label}
          </button>
        );
      });
    }
    if (nodeSection === "created") {
      if (palette.createdNodes.length === 0) {
        return (
          <div className="tt-empty">
            No created nodes yet. Settings → Create a node.
          </div>
        );
      }
      return palette.createdNodes.map((definition) => {
        const iconName = (definition.icon || "Sparkle") as CreatedNodeIcon;
        const NodeIcon = (Icon[iconName] || Icon.Sparkle) as React.FC<{
          size?: number;
        }>;
        return (
          <button
            key={definition.id}
            type="button"
            className="btn sm tt-node"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                NB_CREATED_NODE_MIME,
                definition.id,
              );
              event.dataTransfer.effectAllowed = "copy";
            }}
            title={`Drag ${definition.name} onto the canvas`}
          >
            <NodeIcon size={13} /> {definition.name}
          </button>
        );
      });
    }
    const group = NODE_GROUPS.find((g) => g.id === nodeSection);
    if (!group) return null;
    return group.types.map((type) => {
      const item = NODE_BY_TYPE[type];
      if (!item) return null;
      const NodeIcon = Icon[item.icon] as React.FC<{ size?: number }>;
      return (
        <button
          key={type}
          type="button"
          className="btn sm tt-node"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(NB_NODE_MIME, type);
            event.dataTransfer.effectAllowed = "copy";
          }}
          title={`Drag ${item.label} onto the canvas`}
        >
          <NodeIcon size={13} /> {item.label}
        </button>
      );
    });
  };

  return (
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className={
        "tt-panel win-float" +
        (dragging ? " dragging" : "") +
        (settled ? " settle" : "") +
        (favDrop ? " fav-dropping" : "")
      }
      style={sizeStyle}
      role="dialog"
      aria-label="Tools and Tables"
      data-testid="tools-tables-panel"
      onMouseUp={persistSize}
    >
      <div className="tt-head" onMouseDown={startDrag} title="Drag to move">
        <Icon.Layers size={14} />
        <span className="fx-title">Tools &amp; Tables</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm ghost"
          data-testid="tools-tables-minimize"
          title="Minimize"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            setMinimized(true);
            saveChrome({ minimized: true, x: pos.x, y: pos.y });
          }}
        >
          <Icon.SquareMinus size={14} />
        </button>
        <button
          type="button"
          className="btn sm ghost"
          data-testid="tools-tables-close"
          title="Close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>

      <div className="tt-tabs">
        <button
          type="button"
          className={"tt-tab" + (tab === "tables" ? " active" : "")}
          data-testid="tools-tables-tab-tables"
          onClick={() => setTab("tables")}
        >
          Tables
          {visibleTables.length ? ` (${visibleTables.length})` : ""}
        </button>
        <button
          type="button"
          className={"tt-tab" + (tab === "nodes" ? " active" : "")}
          data-testid="tools-tables-tab-nodes"
          onClick={() => setTab("nodes")}
        >
          Nodes
        </button>
      </div>

      {tab === "tables" ? (
        <div className="tt-body">
          <div className="tt-toolbar">
            <input
              className="tt-search"
              placeholder="Filter tables…"
              value={tableQ}
              onChange={(e) => setTableQ(e.target.value)}
              data-testid="tools-tables-search"
            />
            <button
              type="button"
              className="btn sm ghost"
              title="Refresh tables"
              onClick={() => onRefreshTables?.()}
            >
              <Icon.RotateCw size={13} />
            </button>
            <button
              type="button"
              className="btn sm"
              title="Load data"
              onClick={() => onOpenLoad?.()}
            >
              Load…
            </button>
          </div>
          <div className="tt-table-list">
            {visibleTables.length === 0 ? (
              <div className="tt-empty">
                No loaded tables. Use Load… to bring data in.
              </div>
            ) : (
              visibleTables.map((t) => {
                const key = `${t.engine}:${t.name}`;
                const openRow = !!expanded[key];
                const cols = t.columns || [];
                const colN =
                  typeof t.col_count === "number"
                    ? t.col_count
                    : cols.length;
                return (
                  <div key={key} className="tt-table-row">
                    <button
                      type="button"
                      className="tt-table-head"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [key]: !p[key] }))
                      }
                    >
                      <span className="tt-caret">{openRow ? "▾" : "▸"}</span>
                      <span className={"tt-engine " + engineBadge(t.engine)}>
                        {engineBadge(t.engine)}
                      </span>
                      <span className="tt-table-name" title={t.name}>
                        {t.name}
                      </span>
                      <span className="tt-meta">
                        {t.row_count != null
                          ? `${formatCount(t.row_count)} rows`
                          : "—"}
                        {colN ? ` · ${colN} cols` : ""}
                      </span>
                    </button>
                    {openRow && cols.length > 0 && (
                      <div className="tt-cols">
                        {cols.map((c) => (
                          <div key={c.name} className="tt-col">
                            <span className="tt-col-name">{c.name}</span>
                            <span className="tt-col-type">
                              {(c.type || "").slice(0, 28)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {openRow && cols.length === 0 && (
                      <div className="tt-cols dim">
                        {t.remote
                          ? "Remote catalog — expand in the sidebar for columns."
                          : "No columns listed."}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="tt-body tt-nodes-body">
          <div className="tt-node-sections" role="tablist">
            {sectionButtons.map((s) => {
              const SecIcon = Icon[s.icon] as React.FC<{ size?: number }>;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={nodeSection === s.id}
                  className={
                    "tt-node-section" +
                    (nodeSection === s.id ? " active" : "")
                  }
                  data-testid={`tools-tables-section-${s.id}`}
                  onClick={() => setNodeSection(s.id)}
                  title={s.label}
                >
                  <SecIcon size={12} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
          <div
            className={
              "tt-node-grid" +
              (nodeSection === "favorites" ? " tt-fav-drop" : "")
            }
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes(NB_NODE_MIME) ||
                event.dataTransfer.types.includes(NB_CREATED_NODE_MIME)
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                if (nodeSection === "favorites") setFavDrop(true);
              }
            }}
            onDragLeave={() => setFavDrop(false)}
            onDrop={(event) => {
              setFavDrop(false);
              const created = event.dataTransfer.getData(NB_CREATED_NODE_MIME);
              if (created) {
                event.preventDefault();
                palette.addFavorite(createdFavoriteKey(created));
                setNodeSection("favorites");
                return;
              }
              const type = event.dataTransfer.getData(NB_NODE_MIME);
              if (type) {
                event.preventDefault();
                palette.addFavorite(type);
                setNodeSection("favorites");
              }
            }}
          >
            {renderNodeButtons()}
          </div>
          <div className="tt-hint">
            Drag a node onto the canvas. Drop onto Favorites (section or
            toolbar) to pin it.
          </div>
        </div>
      )}
    </div>
  );
};
