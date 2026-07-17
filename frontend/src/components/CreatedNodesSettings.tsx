import React, { useState } from "react";
import { Icon } from "./Icon";
import {
  CreateCreatedNodeModal,
  ManageCreatedNodesModal,
} from "./CreatedNodeModals";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

/** Settings menu entries + modal host for Created Nodes (keeps App.tsx lean). */
export function useCreatedNodesSettings(onToast: ToastFn) {
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

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
        title="Rename, delete, export, or load Created Nodes"
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
    </>
  );

  return { menu, modals };
}
