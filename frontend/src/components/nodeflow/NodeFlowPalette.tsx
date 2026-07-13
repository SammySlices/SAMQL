import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import {
  loadCreatedNodes,
  type CreatedNodeDefinition,
  type CreatedNodeIcon,
} from "../../lib/createdNodes";
import {
  FAVORITES_KEY,
  LEGACY_FAVORITES_KEY,
  NB_CREATED_NODE_MIME,
  NB_NODE_MIME,
  createdFavoriteKey,
  createdIdFromFavorite,
  isCreatedFavoriteKey,
  type NodeType,
} from "../../lib/nodeFlowModel";
import {
  NODE_BY_TYPE,
  NODE_GROUPS,
  NODE_PALETTE,
  isPaletteNodeType,
} from "./nodeDefinitions";

function loadFavoriteKeys(
  created: CreatedNodeDefinition[],
): string[] {
  try {
    const raw =
      localStorage.getItem(FAVORITES_KEY) ||
      localStorage.getItem(LEGACY_FAVORITES_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    const createdIds = new Set(created.map((d) => d.id));
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      if (isCreatedFavoriteKey(item)) {
        const id = createdIdFromFavorite(item);
        if (id && createdIds.has(id)) out.push(createdFavoriteKey(id));
        continue;
      }
      if (isPaletteNodeType(item)) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

function isFavoriteDrag(types: readonly string[]): boolean {
  return (
    types.includes(NB_NODE_MIME) || types.includes(NB_CREATED_NODE_MIME)
  );
}

export function useNodeFlowPalette(showNodeSearch?: boolean) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [palSearch, setPalSearch] = useState("");
  const [favDrop, setFavDrop] = useState(false);
  const palRef = useRef<HTMLDivElement | null>(null);
  const [createdNodes, setCreatedNodes] = useState<CreatedNodeDefinition[]>(
    () => loadCreatedNodes(),
  );
  const [favorites, setFavorites] = useState<string[]>(() =>
    loadFavoriteKeys(loadCreatedNodes()),
  );

  useEffect(() => {
    if (showNodeSearch === false && palSearch) setPalSearch("");
  }, [palSearch, showNodeSearch]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      // Favorites remain available for the current session.
    }
  }, [favorites]);

  useEffect(() => {
    const refreshCreated = () => {
      const next = loadCreatedNodes();
      setCreatedNodes(next);
      // Drop favorites that point at deleted created nodes; renamed nodes keep
      // the same id so the Favorites label updates via createdNodes.
      const ids = new Set(next.map((d) => d.id));
      setFavorites((current) =>
        current.filter(
          (key) =>
            !isCreatedFavoriteKey(key) ||
            ids.has(createdIdFromFavorite(key)),
        ),
      );
    };
    const onDeleted = (event: Event) => {
      const id = String(
        (event as CustomEvent).detail?.definitionId || "",
      ).trim();
      if (!id) {
        refreshCreated();
        return;
      }
      setCreatedNodes(loadCreatedNodes());
      setFavorites((current) =>
        current.filter((key) => key !== createdFavoriteKey(id)),
      );
    };
    window.addEventListener("samql-created-nodes-changed", refreshCreated);
    window.addEventListener("samql-created-node-updated", refreshCreated);
    window.addEventListener("samql-created-node-deleted", onDeleted);
    window.addEventListener("storage", refreshCreated);
    return () => {
      window.removeEventListener("samql-created-nodes-changed", refreshCreated);
      window.removeEventListener("samql-created-node-updated", refreshCreated);
      window.removeEventListener("samql-created-node-deleted", onDeleted);
      window.removeEventListener("storage", refreshCreated);
    };
  }, []);

  const addFavorite = (key: string) =>
    setFavorites((current) => {
      if (!key || current.includes(key)) return current;
      if (isCreatedFavoriteKey(key)) {
        const id = createdIdFromFavorite(key);
        if (!id || !createdNodes.some((d) => d.id === id)) return current;
        return [...current, createdFavoriteKey(id)];
      }
      if (!isPaletteNodeType(key) || !NODE_BY_TYPE[key]) return current;
      return [...current, key];
    });
  const removeFavorite = (key: string) =>
    setFavorites((current) => current.filter((item) => item !== key));
  const onPaletteWheel = (event: React.WheelEvent) => {
    const element = palRef.current;
    if (!element) return;
    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
    if (delta) element.scrollLeft += delta;
  };

  const acceptFavoriteDrop = (event: React.DragEvent) => {
    setFavDrop(false);
    const createdId = event.dataTransfer.getData(NB_CREATED_NODE_MIME);
    if (createdId) {
      event.preventDefault();
      addFavorite(createdFavoriteKey(createdId));
      setOpenCat("favorites");
      return true;
    }
    const type = event.dataTransfer.getData(NB_NODE_MIME) as NodeType;
    if (type && NODE_BY_TYPE[type]) {
      event.preventDefault();
      addFavorite(type);
      setOpenCat("favorites");
      return true;
    }
    return false;
  };

  return {
    openCat,
    setOpenCat,
    palSearch,
    setPalSearch,
    favDrop,
    setFavDrop,
    favorites,
    addFavorite,
    removeFavorite,
    acceptFavoriteDrop,
    createdNodes,
    palRef,
    onPaletteWheel,
  };
}

interface NodeFlowPaletteProps {
  paletteHidden?: boolean;
  showNodeSearch?: boolean;
  snap: boolean;
  setSnap: React.Dispatch<React.SetStateAction<boolean>>;
  zoom: number;
  zoomBy: (multiplier: number) => void;
  resetZoom: () => void;
  model: ReturnType<typeof useNodeFlowPalette>;
}

export const NodeFlowPalette = React.memo(function NodeFlowPalette({
  paletteHidden,
  showNodeSearch,
  snap,
  setSnap,
  zoom,
  zoomBy,
  resetZoom,
  model,
}: NodeFlowPaletteProps) {
  const {
    openCat,
    setOpenCat,
    palSearch,
    setPalSearch,
    favDrop,
    setFavDrop,
    favorites,
    removeFavorite,
    acceptFavoriteDrop,
    createdNodes,
    palRef,
    onPaletteWheel,
  } = model;

  return (
    <div className={"nb2-toolbar" + (paletteHidden ? " nb2-hidden" : "")}>
      <div className="nb2-cat-row">
        <div className="nb2-cats" ref={palRef} onWheel={onPaletteWheel}>
          <button
            className={
              "btn sm nb2-cat nb2-cat-fav" +
              (openCat === "favorites" ? " active" : "") +
              (favDrop ? " dropping" : "")
            }
            onClick={() =>
              setOpenCat(openCat === "favorites" ? null : "favorites")
            }
            onDragOver={(event) => {
              if (isFavoriteDrag(event.dataTransfer.types)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFavDrop(true);
              }
            }}
            onDragLeave={() => setFavDrop(false)}
            onDrop={(event) => {
              acceptFavoriteDrop(event);
            }}
            title="Favorites — drag any node (including Created Nodes) here"
          >
            <Icon.Star size={13} /> Favorites
            <span className="nb2-cat-caret">
              {openCat === "favorites" ? "▾" : "▸"}
            </span>
          </button>
          {NODE_GROUPS.map((group) => {
            const GroupIcon = Icon[group.icon] as React.FC<{ size?: number }>;
            const single = group.types.length === 1;
            const active = openCat === group.id;
            return (
              <button
                key={group.id}
                className={"btn sm nb2-cat" + (active ? " active" : "")}
                draggable={single}
                onDragStart={
                  single
                    ? (event) => {
                        event.dataTransfer.setData(
                          NB_NODE_MIME,
                          group.types[0],
                        );
                        event.dataTransfer.effectAllowed = "copy";
                      }
                    : undefined
                }
                onClick={() => {
                  if (!single) setOpenCat(active ? null : group.id);
                }}
                title={
                  single
                    ? `Drag ${group.label} onto the canvas`
                    : `${group.label} nodes`
                }
              >
                <GroupIcon size={13} /> {group.label}
                {!single && (
                  <span className="nb2-cat-caret">{active ? "▾" : "▸"}</span>
                )}
              </button>
            );
          })}
          <button
            className={
              "btn sm nb2-cat" + (openCat === "created" ? " active" : "")
            }
            onClick={() =>
              setOpenCat(openCat === "created" ? null : "created")
            }
            title="Nodes you created from a tab graph"
          >
            <Icon.Sparkle size={13} /> Created Nodes
            <span className="nb2-cat-caret">
              {openCat === "created" ? "▾" : "▸"}
            </span>
          </button>
        </div>
        {showNodeSearch !== false && (
          <div className="nb2-pal-search">
            <Icon.Filter size={12} />
            <input
              className="nb2-pal-search-in"
              placeholder="Search nodes…"
              value={palSearch}
              onChange={(event) => {
                setPalSearch(event.target.value);
                if (event.target.value) setOpenCat(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPalSearch("");
              }}
            />
            {palSearch && (
              <button
                className="btn ghost icon nb2-pal-search-x xbtn"
                onClick={() => setPalSearch("")}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="nb2-zoom">
          <button
            className={"btn sm" + (snap ? " primary" : " ghost")}
            onClick={() => setSnap((value) => !value)}
            title="Snap nodes to a grid while dragging"
          >
            Snap
          </button>
          <button
            className="btn sm icon"
            onClick={() => zoomBy(1 / 1.2)}
            title="Zoom out"
          >
            −
          </button>
          <button
            className="btn sm nb2-zoom-pct"
            onClick={resetZoom}
            title="Reset zoom to 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="btn sm icon"
            onClick={() => zoomBy(1.2)}
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>
      {openCat === "favorites" && (
        <div
          className={"nb2-cat-sub nb2-fav-sub" + (favDrop ? " dropping" : "")}
          onDragOver={(event) => {
            if (isFavoriteDrag(event.dataTransfer.types)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setFavDrop(true);
            }
          }}
          onDragLeave={() => setFavDrop(false)}
          onDrop={(event) => {
            acceptFavoriteDrop(event);
          }}
        >
          {favorites.length === 0 ? (
            <span className="nb2-fav-empty">
              Drag any node here (including Created Nodes) to add a shortcut.
              Drag a favourite out (or use ×) to remove it — it stays in its
              normal group.
            </span>
          ) : (
            favorites.map((key) => {
              if (isCreatedFavoriteKey(key)) {
                const id = createdIdFromFavorite(key);
                const definition = createdNodes.find((d) => d.id === id);
                if (!definition) return null;
                const iconName = (definition.icon ||
                  "Sparkle") as CreatedNodeIcon;
                const NodeIcon = (Icon[iconName] || Icon.Sparkle) as React.FC<{
                  size?: number;
                }>;
                return (
                  <span key={key} className="nb2-pal-item nb2-fav-item">
                    <button
                      className="btn sm nb2-fav-btn"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(NB_CREATED_NODE_MIME, id);
                        event.dataTransfer.effectAllowed = "copyMove";
                      }}
                      onDragEnd={(event) => {
                        if (event.dataTransfer.dropEffect === "none") {
                          removeFavorite(key);
                        }
                      }}
                      title={`Drag ${definition.name} onto the canvas, or out of Favorites to remove`}
                    >
                      <NodeIcon size={13} /> {definition.name}
                    </button>
                    <button
                      className="btn ghost icon nb2-fav-x xbtn"
                      onClick={() => removeFavorite(key)}
                      title="Remove from Favorites"
                    >
                      ×
                    </button>
                  </span>
                );
              }
              const type = key as NodeType;
              const item = NODE_BY_TYPE[type];
              if (!item) return null;
              const NodeIcon = Icon[item.icon] as React.FC<{ size?: number }>;
              return (
                <span key={type} className="nb2-pal-item nb2-fav-item">
                  <button
                    className="btn sm nb2-fav-btn"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(NB_NODE_MIME, type);
                      event.dataTransfer.effectAllowed = "copyMove";
                    }}
                    onDragEnd={(event) => {
                      if (event.dataTransfer.dropEffect === "none") {
                        removeFavorite(type);
                      }
                    }}
                    title={`Drag ${item.label} onto the canvas, or out of Favorites to remove`}
                  >
                    <NodeIcon size={13} /> {item.label}
                  </button>
                  <button
                    className="btn ghost icon nb2-fav-x xbtn"
                    onClick={() => removeFavorite(type)}
                    title="Remove from Favorites"
                  >
                    ×
                  </button>
                </span>
              );
            })
          )}
        </div>
      )}
      {openCat === "created" && (
        <div className="nb2-cat-sub">
          {createdNodes.length === 0 ? (
            <span className="nb2-fav-empty">
              No created nodes yet. Build a tab with Dynamic Input / Output,
              then Settings → Create a node.
            </span>
          ) : (
            createdNodes.map((definition) => {
              const iconName = (definition.icon || "Sparkle") as CreatedNodeIcon;
              const NodeIcon = (Icon[iconName] || Icon.Sparkle) as React.FC<{
                size?: number;
              }>;
              return (
                <button
                  key={definition.id}
                  className="btn sm nb2-pal-item"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      NB_CREATED_NODE_MIME,
                      definition.id,
                    );
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  title={`Drag ${definition.name} onto the canvas (${definition.inputs.length} in · ${definition.outputs.length} out)`}
                >
                  <NodeIcon size={13} /> {definition.name}
                </button>
              );
            })
          )}
        </div>
      )}
      {openCat &&
        openCat !== "created" &&
        (() => {
          const group = NODE_GROUPS.find((item) => item.id === openCat);
          if (!group || group.types.length <= 1) return null;
          return (
            <div className="nb2-cat-sub">
              {group.types.map((type) => {
                const item = NODE_BY_TYPE[type];
                if (!item) return null;
                const NodeIcon = Icon[item.icon] as React.FC<{ size?: number }>;
                return (
                  <button
                    key={type}
                    className="btn sm nb2-pal-item"
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
              })}
            </div>
          );
        })()}
      {palSearch.trim() &&
        (() => {
          const query = palSearch.trim().toLowerCase();
          const hits = NODE_PALETTE.filter(
            (item) =>
              item.label.toLowerCase().includes(query) ||
              item.type.toLowerCase().includes(query),
          );
          const createdHits = createdNodes.filter((item) =>
            item.name.toLowerCase().includes(query),
          );
          return (
            <div className="nb2-cat-sub nb2-search-sub">
              {hits.length === 0 && createdHits.length === 0 ? (
                <span className="nb2-search-empty">
                  No nodes match “{palSearch.trim()}”.
                </span>
              ) : (
                <>
                  {hits.map((item) => {
                    const NodeIcon = Icon[item.icon] as React.FC<{
                      size?: number;
                    }>;
                    return (
                      <button
                        key={item.type}
                        className="btn sm nb2-pal-item"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(NB_NODE_MIME, item.type);
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                        title={`Drag ${item.label} onto the canvas`}
                      >
                        <NodeIcon size={13} /> {item.label}
                      </button>
                    );
                  })}
                  {createdHits.map((definition) => {
                    const iconName = (definition.icon ||
                      "Sparkle") as CreatedNodeIcon;
                    const NodeIcon = (Icon[iconName] ||
                      Icon.Sparkle) as React.FC<{ size?: number }>;
                    return (
                      <button
                        key={definition.id}
                        className="btn sm nb2-pal-item"
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
                  })}
                </>
              )}
            </div>
          );
        })()}
    </div>
  );
});
