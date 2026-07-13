import React, { useState } from "react";
import { Icon } from "./Icon";
import {
  CreateCreatedNodeModal,
  ExportCreatedNodeModal,
  LoadCreatedNodeModal,
} from "./CreatedNodeModals";

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

  const menu = (closeSettings: () => void) => (
    <>
      <div className="sep" />
      <div className="label">Created nodes</div>
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
