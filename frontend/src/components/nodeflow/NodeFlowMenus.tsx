import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { POP_EXIT_MS } from "../ConfirmPop";
import { getNodeHelp } from "../../lib/nodeHelp";
import type { NodeType } from "../../lib/nodeFlowModel";
import { NODE_BY_TYPE, NODE_GROUPS } from "./nodeDefinitions";

export interface NodeMenuState {
  x: number;
  y: number;
  id: string;
}

export interface DeleteConfirmState {
  id?: string;
  left: number;
  top: number;
  side: "left" | "right";
  msg?: string;
  label?: string;
  onOk?: () => void;
}

export interface CanvasMenuState {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface NodeFlowMenusProps {
  nodeMenu: NodeMenuState | null;
  setNodeMenu: (value: NodeMenuState | null) => void;
  selectedIds: string[];
  canPaste: boolean;
  copySelection: () => void;
  pasteClipboard: (at?: { x: number; y: number }) => void;
  deleteMany: (ids: string[]) => void;
  removeNode: (id: string) => void;
  /** Batch-pin/unpin outputs (skip recompute on later runs). */
  setFrozenMany?: (ids: string[], frozen: boolean) => void;
  /** How many of the menu's target nodes are currently frozen. */
  frozenSelectedCount?: number;
  /** At least one target node produces output (can be frozen). */
  canFreeze?: boolean;
  canOpenCreatedNode?: boolean;
  onOpenCreatedNode?: () => void;
  deleteConfirm: DeleteConfirmState | null;
  setDeleteConfirm: (value: DeleteConfirmState | null) => void;
  doRemoveNode: (id: string) => void;
  helpFor: string | null;
  setHelpFor: (value: string | null) => void;
  canvasMenu: CanvasMenuState | null;
  setCanvasMenu: (value: CanvasMenuState | null) => void;
  running: boolean;
  nodeCount: number;
  cancelRun: () => void;
  runAll: () => void;
  addTypeAt: (type: NodeType, point: { x: number; y: number }) => void;
}

export const NodeFlowMenus = React.memo(function NodeFlowMenus({
  nodeMenu,
  setNodeMenu,
  selectedIds,
  canPaste,
  copySelection,
  pasteClipboard,
  deleteMany,
  removeNode,
  setFrozenMany,
  frozenSelectedCount,
  canFreeze,
  canOpenCreatedNode,
  onOpenCreatedNode,
  deleteConfirm,
  setDeleteConfirm,
  doRemoveNode,
  helpFor,
  setHelpFor,
  canvasMenu,
  setCanvasMenu,
  running,
  nodeCount,
  cancelRun,
  runAll,
  addTypeAt,
}: NodeFlowMenusProps) {
  const [nodesOpen, setNodesOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState<string | null>(null);
  const [delClosing, setDelClosing] = useState(false);
  const delTimer = useRef<number | null>(null);

  useEffect(() => {
    setNodesOpen(false);
    setCategoryOpen(null);
  }, [canvasMenu]);

  useEffect(() => {
    // New confirm (or clear) resets any in-flight exit pop.
    setDelClosing(false);
    if (delTimer.current != null) {
      window.clearTimeout(delTimer.current);
      delTimer.current = null;
    }
  }, [deleteConfirm]);

  useEffect(
    () => () => {
      if (delTimer.current != null) window.clearTimeout(delTimer.current);
    },
    [],
  );

  const dismissDelete = useCallback(
    (after?: () => void) => {
      if (delClosing || delTimer.current != null) return;
      if (document.body.classList.contains("motion-reduced")) {
        setDeleteConfirm(null);
        after?.();
        return;
      }
      setDelClosing(true);
      delTimer.current = window.setTimeout(() => {
        delTimer.current = null;
        setDelClosing(false);
        setDeleteConfirm(null);
        after?.();
      }, POP_EXIT_MS);
    },
    [delClosing, setDeleteConfirm],
  );

  return (
    <>
      {nodeMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 200 }}
            onClick={() => setNodeMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setNodeMenu(null);
            }}
          />
          <div
            className="nb2-node-menu"
            style={{
              position: "fixed",
              left: Math.min(nodeMenu.x, window.innerWidth - 180),
              top: Math.min(nodeMenu.y, window.innerHeight - 140),
              zIndex: 201,
            }}
          >
            {(() => {
              const multi =
                selectedIds.length > 1 && selectedIds.includes(nodeMenu.id);
              const count = multi ? selectedIds.length : 1;
              return (
                <>
                  {canOpenCreatedNode && onOpenCreatedNode && !multi && (
                    <>
                      <button
                        data-testid="open-created-node"
                        onClick={() => {
                          onOpenCreatedNode();
                          setNodeMenu(null);
                        }}
                      >
                        <Icon.FolderOpen size={13} /> Open Node
                      </button>
                      <div className="sep" />
                    </>
                  )}
                  <button
                    onClick={() => {
                      copySelection();
                      setNodeMenu(null);
                    }}
                  >
                    <Icon.Copy size={13} /> Copy
                    {multi ? ` ${count} nodes` : ""}
                  </button>
                  <button
                    disabled={!canPaste}
                    onClick={() => {
                      pasteClipboard();
                      setNodeMenu(null);
                    }}
                  >
                    <Icon.Plus size={13} /> Paste
                  </button>
                  <div className="sep" />
                  {canFreeze && setFrozenMany && (
                    <button
                      data-testid="node-menu-freeze"
                      title={
                        (frozenSelectedCount || 0) >= count
                          ? "Unfreeze — recompute on the next run"
                          : "Freeze — pin this output; later runs reuse it until config changes"
                      }
                      onClick={() => {
                        const unfreeze =
                          (frozenSelectedCount || 0) >= count;
                        setFrozenMany(
                          multi ? selectedIds.slice() : [nodeMenu.id],
                          !unfreeze,
                        );
                        setNodeMenu(null);
                      }}
                    >
                      ❄{" "}
                      {(frozenSelectedCount || 0) >= count
                        ? multi
                          ? `Unfreeze ${count} nodes`
                          : "Unfreeze node"
                        : multi
                          ? `Freeze ${count} nodes`
                          : "Freeze node"}
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => {
                      if (multi) deleteMany(selectedIds.slice());
                      else removeNode(nodeMenu.id);
                      setNodeMenu(null);
                    }}
                  >
                    ×{" "}
                    {multi ? `Delete ${count} nodes` : "Delete node"}
                  </button>
                </>
              );
            })()}
          </div>
        </>
      )}

      {deleteConfirm && (
        <>
          <div
            className={
              "nb2-delconfirm-backdrop" + (delClosing ? " closing" : "")
            }
            onClick={() => dismissDelete()}
            onContextMenu={(event) => {
              event.preventDefault();
              dismissDelete();
            }}
          />
          <div
            className={
              "nb2-delconfirm side-" +
              deleteConfirm.side +
              (delClosing ? " closing" : "")
            }
            style={{ left: deleteConfirm.left, top: deleteConfirm.top }}
            role="dialog"
          >
            <div className="nb2-delconfirm-msg">
              ×{" "}
              {deleteConfirm.msg || "Delete this node?"}
            </div>
            <div className="nb2-delconfirm-row">
              <button
                className="btn sm ghost"
                onClick={() => dismissDelete()}
              >
                Cancel
              </button>
              <button
                className="btn sm danger"
                autoFocus
                onClick={() => {
                  const { id, onOk } = deleteConfirm;
                  dismissDelete(() => {
                    if (onOk) onOk();
                    else if (id) doRemoveNode(id);
                  });
                }}
              >
                {deleteConfirm.label || "Delete"}
              </button>
            </div>
          </div>
        </>
      )}

      {helpFor &&
        (() => {
          const help = getNodeHelp(helpFor);
          return (
            <>
              <div
                className="nb2-help-backdrop"
                onClick={() => setHelpFor(null)}
              />
              <div className="nb2-help" role="dialog">
                <div className="nb2-help-head">
                  <span className="nb2-help-title">{help.title}</span>
                  <button
                    className="btn ghost icon"
                    onClick={() => setHelpFor(null)}
                    title="Close"
                  >
                    ×
                  </button>
                </div>
                <div className="nb2-help-body">
                  <p className="nb2-help-what">{help.what}</p>
                  <p className="nb2-help-use">{help.use}</p>
                  {help.funcs && (
                    <div className="nb2-help-funcs">
                      <div className="nb2-help-funcs-lbl">{help.funcs.label}</div>
                      <ul>
                        {help.funcs.items.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}

      {canvasMenu &&
        (() => {
          const flyRight = canvasMenu.x < window.innerWidth * 0.55;
          const subClass =
            "nb2-node-menu nb2-cm-sub " + (flyRight ? "right" : "left");
          const addType = (type: NodeType) => {
            addTypeAt(type, { x: canvasMenu.cx, y: canvasMenu.cy });
            setCanvasMenu(null);
          };
          return (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 200 }}
                onClick={() => setCanvasMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setCanvasMenu(null);
                }}
              />
              <div
                className="nb2-node-menu"
                style={{
                  position: "fixed",
                  left: Math.min(canvasMenu.x, window.innerWidth - 200),
                  top: Math.min(canvasMenu.y, window.innerHeight - 80),
                  zIndex: 201,
                }}
                onMouseLeave={() => {
                  setNodesOpen(false);
                  setCategoryOpen(null);
                }}
              >
                <button
                  className={running ? "nb2-cm-stop" : ""}
                  disabled={!running && !nodeCount}
                  onMouseEnter={() => {
                    setNodesOpen(false);
                    setCategoryOpen(null);
                  }}
                  onClick={() => {
                    if (running) cancelRun();
                    else runAll();
                    setCanvasMenu(null);
                  }}
                >
                  {running ? (
                    <>
                      <Icon.Square size={13} /> Stop Workflow
                    </>
                  ) : (
                    <>
                      <Icon.Play size={13} /> Run Workflow
                    </>
                  )}
                </button>
                <button
                  disabled={!canPaste}
                  onMouseEnter={() => {
                    setNodesOpen(false);
                    setCategoryOpen(null);
                  }}
                  onClick={() => {
                    pasteClipboard({ x: canvasMenu.cx, y: canvasMenu.cy });
                    setCanvasMenu(null);
                  }}
                >
                  <Icon.Plus size={13} /> Paste here
                </button>
                <div
                  className="nb2-cm-row"
                  onMouseEnter={() => {
                    setNodesOpen(true);
                    setCategoryOpen(null);
                  }}
                >
                  <button className={nodesOpen ? "active" : ""}>
                    <Icon.Grid size={13} /> Nodes
                    <span className="nb2-cm-caret">▸</span>
                  </button>
                  {nodesOpen && (
                    <div className={subClass}>
                      {NODE_GROUPS.map((group) => {
                        const GroupIcon = Icon[group.icon] as React.FC<{
                          size?: number;
                        }>;
                        return (
                          <div
                            className="nb2-cm-row"
                            key={group.id}
                            onMouseEnter={() => setCategoryOpen(group.id)}
                          >
                            <button
                              className={
                                categoryOpen === group.id ? "active" : ""
                              }
                            >
                              <GroupIcon size={13} /> {group.label}
                              <span className="nb2-cm-caret">▸</span>
                            </button>
                            {categoryOpen === group.id && (
                              <div className={subClass + " nb2-cm-leaf"}>
                                {group.types.map((type) => {
                                  const item = NODE_BY_TYPE[type];
                                  if (!item) return null;
                                  const NodeIcon = Icon[item.icon] as React.FC<{
                                    size?: number;
                                  }>;
                                  return (
                                    <button
                                      key={type}
                                      onClick={() => addType(type)}
                                    >
                                      <NodeIcon size={13} /> {item.label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}
    </>
  );
});
