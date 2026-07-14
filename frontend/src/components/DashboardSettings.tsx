import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import {
  buildDashboardExportBundle,
  importDashboardBundle,
} from "./Dashboard";
import {
  deleteDashboardInWorkspace,
  emptyDashboardDoc,
  loadDashboardWorkspace,
  moveDashboardInWorkspace,
  renameDashboardInWorkspace,
  saveDashboardWorkspace,
  type DashboardWorkspace,
} from "../lib/dashboardModel";
import { saveToDownloads } from "../lib/api";
import { useConfirmPop } from "./ConfirmPop";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

/** Settings menu entries for Dashboard export / load / manager. */
export function useDashboardSettings(
  onToast: ToastFn,
  onLoaded?: () => void,
) {
  const [exportOpen, setExportOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [draft, setDraft] = useState<DashboardWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { ui: confirmUi, ask: askConfirm } = useConfirmPop();

  useEffect(() => {
    if (!managerOpen) {
      setDraft(null);
      setSelectedId(null);
      return;
    }
    const ws = loadDashboardWorkspace();
    setDraft(ws);
    setSelectedId(ws.activeId || ws.dashboards[0]?.id || null);
  }, [managerOpen]);

  const persistDraft = (next: DashboardWorkspace, toastMsg?: string) => {
    saveDashboardWorkspace(next);
    setDraft(next);
    onLoaded?.();
    if (toastMsg) onToast("ok", "Dashboards", toastMsg);
  };

  const menu = (closeSettings: () => void) => (
    <>
      <div className="sep" />
      <div className="label">Dashboard</div>
      <button
        type="button"
        data-testid="settings-dashboard-manager"
        onClick={() => {
          closeSettings();
          setManagerOpen(true);
        }}
      >
        <Icon.LayoutGrid size={13} /> Dashboard Manager…
      </button>
      <button
        onClick={() => {
          closeSettings();
          setExportOpen(true);
        }}
      >
        <Icon.Download size={13} /> Export dashboard…
      </button>
      <button
        onClick={() => {
          closeSettings();
          setLoadOpen(true);
        }}
      >
        <Icon.Upload size={13} /> Load dashboard…
      </button>
    </>
  );

  const modals = (
    <>
      {confirmUi}
      {managerOpen && draft && (
        <Modal
          title="Dashboard Manager"
          onClose={() => setManagerOpen(false)}
          wide
        >
          <p className="nb2-note">
            Reorder boards in the dashboard dropdown, rename them, or delete
            ones you no longer need. Changes apply immediately.
          </p>
          <div className="dash-mgr" data-testid="dashboard-manager">
            <div className="dash-mgr-list">
              {draft.dashboards.map((d, i) => {
                const selected = d.id === selectedId;
                return (
                  <div
                    key={d.id}
                    className={
                      "dash-mgr-row" + (selected ? " selected" : "")
                    }
                    data-testid={`dashboard-manager-row-${d.id}`}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <span className="dash-mgr-index">{i + 1}</span>
                    <input
                      className="dash-mgr-name"
                      data-testid={`dashboard-manager-name-${d.id}`}
                      value={d.name}
                      title="Rename dashboard"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft({
                          ...draft,
                          dashboards: draft.dashboards.map((board) =>
                            board.id === d.id
                              ? { ...board, name: value }
                              : board,
                          ),
                        });
                      }}
                      onBlur={(e) => {
                        const trimmed = e.target.value.trim() || "Dashboard";
                        const next = renameDashboardInWorkspace(
                          draft,
                          d.id,
                          trimmed,
                        );
                        persistDraft(next);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                    <div className="dash-mgr-actions">
                      <button
                        type="button"
                        className="btn sm ghost"
                        data-testid={`dashboard-manager-up-${d.id}`}
                        title="Move up"
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = moveDashboardInWorkspace(
                            draft,
                            d.id,
                            -1,
                          );
                          persistDraft(next);
                        }}
                      >
                        <Icon.ChevronsUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        data-testid={`dashboard-manager-down-${d.id}`}
                        title="Move down"
                        disabled={i >= draft.dashboards.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = moveDashboardInWorkspace(
                            draft,
                            d.id,
                            1,
                          );
                          persistDraft(next);
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            transform: "rotate(180deg)",
                          }}
                        >
                          <Icon.ChevronsUp size={14} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        data-testid={`dashboard-manager-delete-${d.id}`}
                        title={
                          draft.dashboards.length <= 1
                            ? "Keep at least one dashboard"
                            : "Delete dashboard"
                        }
                        disabled={draft.dashboards.length <= 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          const btn = e.currentTarget;
                          askConfirm(
                            btn,
                            `Delete dashboard "${d.name}"? Widgets on this board will be removed.`,
                            () => {
                              const result = deleteDashboardInWorkspace(
                                draft,
                                d.id,
                              );
                              if (!result.ok) {
                                onToast("warn", "Cannot delete", result.error);
                                return;
                              }
                              setSelectedId(result.workspace.activeId);
                              persistDraft(
                                result.workspace,
                                `"${d.name}" removed.`,
                              );
                            },
                            "Delete",
                          );
                        }}
                      >
                        <Icon.Trash size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="nb2-prev-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn ghost"
                data-testid="dashboard-manager-add"
                onClick={() => {
                  const name = (
                    window.prompt("New dashboard name:", "Dashboard") || ""
                  ).trim();
                  if (!name) return;
                  const nextDoc = emptyDashboardDoc(name);
                  const next: DashboardWorkspace = {
                    ...draft,
                    dashboards: [...draft.dashboards, nextDoc],
                    activeId: nextDoc.id,
                  };
                  setSelectedId(nextDoc.id);
                  persistDraft(next, `"${name}" added.`);
                }}
              >
                <Icon.Plus size={13} /> Add dashboard
              </button>
              <button
                type="button"
                className="btn primary"
                data-testid="dashboard-manager-done"
                onClick={() => setManagerOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
      {exportOpen && (
        <Modal
          title="Export dashboard"
          onClose={() => setExportOpen(false)}
        >
          <p className="nb2-note">
            Writes a JSON bundle of every board in the dropdown plus the
            underlying NodeFlow workflows into your Downloads folder.
          </p>
          <div className="nb2-prev-row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const ws = loadDashboardWorkspace();
                  const bundle = await buildDashboardExportBundle(ws);
                  const base =
                    ws.savedName ||
                    ws.dashboards[0]?.name ||
                    "dashboard";
                  const safe =
                    base.replace(/[^\w.\- ]+/g, "_").trim() || "dashboard";
                  const r = await saveToDownloads(
                    `${safe}.samql-dashboard.json`,
                    { text: JSON.stringify(bundle, null, 2) },
                  );
                  onToast("ok", "Exported", r.path || "Saved to Downloads.");
                  setExportOpen(false);
                } catch (e: any) {
                  onToast("error", "Export failed", e?.message || String(e));
                }
              }}
            >
              <Icon.Download size={13} /> Export to Downloads
            </button>
            <button className="btn ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {loadOpen && (
        <Modal
          title="Load dashboard"
          onClose={() => setLoadOpen(false)}
        >
          <p className="nb2-note">
            Choose a previously exported{" "}
            <code>.samql-dashboard.json</code> bundle. Boards and their NodeFlow
            workflows are restored together.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.samql-dashboard.json,application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const imported = await importDashboardBundle(parsed);
                if (!imported.ok) {
                  onToast("error", "Load failed", imported.error);
                  return;
                }
                saveDashboardWorkspace(imported.workspace);
                onToast("ok", "Dashboard loaded", file.name);
                setLoadOpen(false);
                onLoaded?.();
              } catch (err: any) {
                onToast(
                  "error",
                  "Load failed",
                  err?.message || String(err),
                );
              }
            }}
          />
          <div className="nb2-prev-row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              onClick={() => fileRef.current?.click()}
            >
              <Icon.Upload size={13} /> Choose file…
            </button>
            <button className="btn ghost" onClick={() => setLoadOpen(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </>
  );

  return { menu, modals };
}
