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
  type NodeType,
} from "../../lib/nodeFlowModel";
import {
  NODE_BY_TYPE,
  NODE_GROUPS,
  NODE_PALETTE,
  isPaletteNodeType,
} from "./nodeDefinitions";

export function useNodeFlowPalette(showNodeSearch?: boolean) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [palSearch, setPalSearch] = useState("");
  const [favDrop, setFavDrop] = useState(false);
  const palRef = useRef<HTMLDivElement | null>(null);
  const [favorites, setFavorites] = useState<NodeType[]>(() => {
    try {
      const raw =
        localStorage.getItem(FAVORITES_KEY) ||
        localStorage.getItem(LEGACY_FAVORITES_KEY);
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value.filter(isPaletteNodeType) : [];
    } catch {
      return [];
    }
  });
  const [createdNodes, setCreatedNodes] = useState<CreatedNodeDefinition[]>(
    () => loadCreatedNodes(),
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
    const refresh = () => setCreatedNodes(loadCreatedNodes());
    window.addEventListener("samql-created-nodes-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("samql-created-nodes-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const addFavorite = (type: NodeType) =>
    setFavorites((current) =>
      current.includes(type) || !NODE_BY_TYPE[type]
        ? current
        : [...current, type],
    );
  const removeFavorite = (type: NodeType) =>
    setFavorites((current) => current.filter((item) => item !== type));
  const onPaletteWheel = (event: React.WheelEvent) => {
    const element = palRef.current;
    if (!element) return;
    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
    if (delta) element.scrollLeft += delta;
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
    addFavorite,
    removeFavorite,
    createdNodes,
    palRef,
    onPaletteWheel,
  } = model;

  return (
    <div className={"nb2-toolbar" + (paletteHidden ? " nb2-hidden" : "")}>
      <div className="nb2-cat-row">
        <span className="nb2-title">NodeFlow</span>
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
              if (event.dataTransfer.types.includes("application/x-nb-node")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFavDrop(true);
              }
            }}
            onDragLeave={() => setFavDrop(false)}
            onDrop={(event) => {
              setFavDrop(false);
              const type = event.dataTransfer.getData(
                "application/x-nb-node",
              ) as NodeType;
              if (type && NODE_BY_TYPE[type]) {
                event.preventDefault();
                addFavorite(type);
                setOpenCat("favorites");
              }
            }}
            title="Favorites — drag any node here to add a shortcut"
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
                          "application/x-nb-node",
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
            if (event.dataTransfer.types.includes("application/x-nb-node")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setFavDrop(true);
            }
          }}
          onDragLeave={() => setFavDrop(false)}
          onDrop={(event) => {
            setFavDrop(false);
            const type = event.dataTransfer.getData(
              "application/x-nb-node",
            ) as NodeType;
            if (type && NODE_BY_TYPE[type]) {
              event.preventDefault();
              addFavorite(type);
            }
          }}
        >
          {favorites.length === 0 ? (
            <span className="nb2-fav-empty">
              Drag any node here to add a shortcut. Drag a favourite out (or use
              ×) to remove it — it stays in its normal group.
            </span>
          ) : (
            favorites.map((type) => {
              const item = NODE_BY_TYPE[type];
              if (!item) return null;
              const NodeIcon = Icon[item.icon] as React.FC<{ size?: number }>;
              return (
                <span key={type} className="nb2-pal-item nb2-fav-item">
                  <button
                    className="btn sm nb2-fav-btn"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-nb-node", type);
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
                      "application/x-nb-created-node",
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
                      event.dataTransfer.setData("application/x-nb-node", type);
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
                          event.dataTransfer.setData(
                            "application/x-nb-node",
                            item.type,
                          );
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
                            "application/x-nb-created-node",
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
