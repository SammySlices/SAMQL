import React from "react";
import { Icon } from "../Icon";

export interface NodeFlowTab {
  id: string;
  name: string;
  /** When set, this tab is editing that Created Node definition. */
  editingDefinitionId?: string;
}

interface NodeFlowTabBarProps {
  tabs: NodeFlowTab[];
  activeTabId: string;
  editingTab: string | null;
  editingName: string;
  setEditingName: (value: string) => void;
  onSwitchTab: (id: string) => void;
  onStartRename: (id: string, name: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  running: boolean;
  onCancelRun: () => void;
  onRunAll: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  paletteHidden?: boolean;
  onTogglePalette?: () => void;
}

export const NodeFlowTabBar = React.memo(function NodeFlowTabBar({
  tabs,
  activeTabId,
  editingTab,
  editingName,
  setEditingName,
  onSwitchTab,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCloseTab,
  onAddTab,
  running,
  onCancelRun,
  onRunAll,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  paletteHidden,
  onTogglePalette,
}: NodeFlowTabBarProps) {
  return (
    <div className="nb2-tabbar" role="tablist">
      <div className="nb2-tabbar-scroll">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={"nb2-tab" + (active ? " active" : "")}
              role="tab"
              aria-selected={active}
              onClick={() => onSwitchTab(tab.id)}
              onDoubleClick={() => onStartRename(tab.id, tab.name)}
              title="Click to switch · double-click to rename"
            >
              {editingTab === tab.id ? (
                <input
                  className="nb2-tab-edit"
                  autoFocus
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={onCommitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onCommitRename();
                    if (event.key === "Escape") onCancelRename();
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <>
                  <span className="nb2-tab-name">{tab.name}</span>
                  {tabs.length > 1 && (
                    <button
                      className="nb2-tab-x xbtn"
                      title="Close canvas"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
        <button className="nb2-tab-add" onClick={onAddTab} title="New canvas">
          <Icon.Plus size={12} />
        </button>
      </div>
      <div className="nb2-tabbar-actions">
        {running ? (
          <button
            className="btn sm danger"
            data-testid="nodeflow-stop"
            onClick={onCancelRun}
            title="Stop the running workflow"
          >
            <Icon.Square size={12} /> Stop
          </button>
        ) : (
          <button
            className="btn sm primary"
            data-testid="nodeflow-run"
            onClick={onRunAll}
            title="Run every Output and Write-to-table node"
          >
            <Icon.Play size={12} /> Run
          </button>
        )}
        <span className="nb2-wf-sep" />
        <button
          className="btn sm icon"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          ↺
        </button>
        <button
          className="btn sm icon"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          ↻
        </button>
        <span className="nb2-wf-sep" />
        <button
          className={"btn sm icon" + (paletteHidden ? "" : " active")}
          onClick={onTogglePalette}
          title={paletteHidden ? "Show the node toolbar" : "Hide the node toolbar"}
        >
          <Icon.Grid size={13} />
        </button>
      </div>
    </div>
  );
});
