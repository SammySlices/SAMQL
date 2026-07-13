import React, { useState } from "react";
import { Icon } from "./Icon";
import {
  CreateCreatedNodeModal,
  ExportCreatedNodeModal,
  LoadCreatedNodeModal,
  ManageCreatedNodesModal,
} from "./CreatedNodeModals";
import {
  getActiveEditingDefinition,
  getActiveNodeFlowGraph,
  updateCreatedNodeDefinition,
} from "../lib/createdNodes";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

/** Settings menu entries + modal host for Created Nodes (keeps App.tsx lean). */
export function useCreatedNodesSettings(onToast: ToastFn) {
  const [createOpen, setCreateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const saveActiveCreatedNode = () => {
    const editing = getActiveEditingDefinition();
    if (!editing) {
      onToast(
        "warn",
        "Save node",
        "Open a created node first (right-click → Open Node), or use Create a node for a new one.",
      );
      return;
    }
    const graph = getActiveNodeFlowGraph();
    if (!graph) {
      onToast("error", "Save node", "Open a NodeFlow tab first.");
      return;
    }
    const result = updateCreatedNodeDefinition(
      editing.id,
      graph.nodes,
      graph.edges,
      { name: editing.name, icon: editing.icon },
    );
    if (!result.ok) {
      onToast("error", "Save node", result.error);
      return;
    }
    onToast(
      "ok",
      "Node saved",
      `"${result.definition.name}" updated (${result.definition.inputs.length} in · ${result.definition.outputs.length} out).`,
    );
  };

  const menu = (closeSettings: () => void) => (
    <>
      <div className="sep" />
      <div className="label">Created nodes</div>
      <button
        data-testid="manage-created-nodes-menu"
        onClick={() => {
          closeSettings();
          setManageOpen(true);
        }}
        title="Rename or delete saved Created Nodes"
      >
        <Icon.Layers size={13} /> Created Nodes…
      </button>
      <button
        data-testid="create-node-menu"
        onClick={() => {
          closeSettings();
          setCreateOpen(true);
        }}
        title="Save the entire active NodeFlow tab as a reusable Created Node"
      >
        <Icon.Sparkle size={13} /> Create a node…
      </button>
      <button
        data-testid="save-node-menu"
        onClick={() => {
          closeSettings();
          saveActiveCreatedNode();
        }}
        title="Update the Created Node opened with Open Node using this tab’s graph"
      >
        <Icon.Edit size={13} /> Save node
      </button>
      <button
        onClick={() => {
          closeSettings();
          setExportOpen(true);
        }}
      >
        <Icon.Download size={13} /> Export created node…
      </button>
      <button
        onClick={() => {
          closeSettings();
          setLoadOpen(true);
        }}
      >
        <Icon.Upload size={13} /> Load created node…
      </button>
    </>
  );

  const modals = (
    <>
      {manageOpen && (
        <ManageCreatedNodesModal
          onClose={() => setManageOpen(false)}
          onToast={onToast}
        />
      )}
      {createOpen && (
        <CreateCreatedNodeModal
          onClose={() => setCreateOpen(false)}
          onToast={onToast}
        />
      )}
      {exportOpen && (
        <ExportCreatedNodeModal
          onClose={() => setExportOpen(false)}
          onToast={onToast}
        />
      )}
      {loadOpen && (
        <LoadCreatedNodeModal
          onClose={() => setLoadOpen(false)}
          onToast={onToast}
        />
      )}
    </>
  );

  return { menu, modals };
}
