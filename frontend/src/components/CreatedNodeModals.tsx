import React, { useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { saveToDownloads } from "../lib/api";
import {
  CREATED_NODE_ICON_CHOICES,
  analyzeCreatedNodePorts,
  buildCreatedNodeDefinition,
  getActiveNodeFlowGraph,
  loadCreatedNodes,
  parseCreatedNodeFile,
  removeCreatedNode,
  renameCreatedNode,
  serializeCreatedNodeFile,
  upsertCreatedNode,
  type CreatedNodeDefinition,
  type CreatedNodeIcon,
} from "../lib/createdNodes";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

export const CreateCreatedNodeModal: React.FC<{
  onClose: () => void;
  onToast: ToastFn;
}> = ({ onClose, onToast }) => {
  const graph = useMemo(() => getActiveNodeFlowGraph(), []);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<CreatedNodeIcon>("Sparkle");

  const preview = useMemo(() => {
    if (!graph) {
      return { error: "Open a NodeFlow tab first.", inputs: 0, outputs: 0 };
    }
    const ports = analyzeCreatedNodePorts(graph.nodes, graph.edges);
    if (ports.error) {
      return { error: ports.error, inputs: 0, outputs: 0 };
    }
    return {
      error: null as string | null,
      inputs: ports.inputs.length,
      outputs: ports.outputs.length,
    };
  }, [graph]);

  const save = () => {
    if (!graph) {
      onToast("error", "Create a node", "Open a NodeFlow tab first.");
      return;
    }
    const built = buildCreatedNodeDefinition(name, icon, graph.nodes, graph.edges);
    if (!built.ok) {
      onToast("error", "Create a node", built.error);
      return;
    }
    upsertCreatedNode(built.definition);
    onToast(
      "ok",
      "Node created",
      `"${built.definition.name}" is in Created Nodes (${built.definition.inputs.length} in · ${built.definition.outputs.length} out).`,
    );
    onClose();
  };

  return (
    <Modal
      title="Create a node"
      onClose={onClose}
      testId="create-created-node-modal"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={!!preview.error || !name.trim()}
          >
            Create
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Saves the <strong>entire active NodeFlow tab</strong> as a reusable
        node. Dynamic Input / Output nodes become its ports.
      </p>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My transform"
          autoFocus
        />
      </label>
      <label className="field">
        <span>Icon</span>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 6,
          }}
        >
          {CREATED_NODE_ICON_CHOICES.map((choice) => {
            const Ico = Icon[choice] as React.FC<{ size?: number }>;
            return (
              <button
                key={choice}
                type="button"
                className={"btn sm icon" + (icon === choice ? " primary" : " ghost")}
                title={choice}
                onClick={() => setIcon(choice)}
              >
                <Ico size={14} />
              </button>
            );
          })}
        </div>
      </label>
      {preview.error ? (
        <p className="muted" style={{ color: "var(--danger, #b33)" }}>
          {preview.error}
        </p>
      ) : (
        <p className="muted">
          Ports: {preview.inputs} input{preview.inputs === 1 ? "" : "s"} ·{" "}
          {preview.outputs} output{preview.outputs === 1 ? "" : "s"}
        </p>
      )}
    </Modal>
  );
};

export const ExportCreatedNodeModal: React.FC<{
  onClose: () => void;
  onToast: ToastFn;
}> = ({ onClose, onToast }) => {
  const [defs] = useState(() => loadCreatedNodes());
  const [selected, setSelected] = useState(defs[0]?.id || "");

  const exportOne = async () => {
    const def = defs.find((d) => d.id === selected);
    if (!def) {
      onToast("error", "Export", "Pick a created node to export.");
      return;
    }
    const safe = def.name.replace(/[^\w\-]+/g, "_") || "created-node";
    const filename = `${safe}.samql-node.json`;
    try {
      const saved = await saveToDownloads(filename, {
        text: JSON.stringify(serializeCreatedNodeFile(def), null, 2),
      });
      onToast(
        "ok",
        "Exported",
        `"${def.name}" saved to Downloads: ${saved.path}`,
      );
      onClose();
    } catch (e: unknown) {
      onToast(
        "error",
        "Export failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  return (
    <Modal
      title="Export created node"
      onClose={onClose}
      testId="export-created-node-modal"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={exportOne}
            disabled={!defs.length}
          >
            Export…
          </button>
        </>
      }
    >
      {defs.length === 0 ? (
        <p className="muted">No created nodes to export yet.</p>
      ) : (
        <label className="field">
          <span>Node</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.inputs.length} in · {d.outputs.length} out)
              </option>
            ))}
          </select>
        </label>
      )}
    </Modal>
  );
};

export const LoadCreatedNodeModal: React.FC<{
  onClose: () => void;
  onToast: ToastFn;
}> = ({ onClose, onToast }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseCreatedNodeFile(JSON.parse(text));
      if (!parsed.ok) {
        onToast("error", "Load created node", parsed.error);
        return;
      }
      let definition: CreatedNodeDefinition = parsed.definition;
      const existing = loadCreatedNodes().find(
        (d) => d.id === parsed.definition.id,
      );
      if (existing) {
        definition = { ...parsed.definition, createdAt: existing.createdAt };
      }
      upsertCreatedNode(definition);
      onToast(
        "ok",
        "Created node loaded",
        `"${definition.name}" is in Created Nodes.`,
      );
      onClose();
    } catch (e: any) {
      onToast("error", "Load created node", e?.message || "Invalid JSON file.");
    }
  };

  return (
    <Modal
      title="Load created node"
      onClose={onClose}
      testId="load-created-node-modal"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => inputRef.current?.click()}
          >
            Choose file…
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Import a <code>.samql-node.json</code> file shared from another SamQL.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = "";
        }}
      />
    </Modal>
  );
};

export const ManageCreatedNodesModal: React.FC<{
  onClose: () => void;
  onToast: ToastFn;
}> = ({ onClose, onToast }) => {
  const [defs, setDefs] = useState(() => loadCreatedNodes());
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);

  const refresh = () => setDefs(loadCreatedNodes());

  const startRename = (def: CreatedNodeDefinition) => {
    setConfirmDeleteId(null);
    setRenameId(def.id);
    setRenameValue(def.name);
  };

  const commitRename = () => {
    if (!renameId) return;
    const result = renameCreatedNode(renameId, renameValue);
    if (!result.ok) {
      onToast("error", "Rename", result.error);
      return;
    }
    onToast("ok", "Renamed", `"${result.definition.name}" updated.`);
    setRenameId(null);
    setRenameValue("");
    refresh();
  };

  const commitDelete = (id: string) => {
    const target = defs.find((d) => d.id === id);
    removeCreatedNode(id);
    onToast(
      "ok",
      "Deleted",
      target
        ? `"${target.name}" removed from Created Nodes and the canvas.`
        : "Created node removed.",
    );
    setConfirmDeleteId(null);
    if (renameId === id) {
      setRenameId(null);
      setRenameValue("");
    }
    refresh();
  };

  return (
    <>
      <Modal
        title="Created Nodes"
        onClose={onClose}
        testId="manage-created-nodes-modal"
        footer={
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        }
      >
        <div
          data-testid="manage-created-nodes-toolbar"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <button
            className="btn sm ghost"
            data-testid="manage-created-nodes-export"
            onClick={() => setExportOpen(true)}
            title="Export a created node as a shareable JSON file"
          >
            <Icon.Download size={13} /> Export…
          </button>
          <button
            className="btn sm ghost"
            data-testid="manage-created-nodes-load"
            onClick={() => setLoadOpen(true)}
            title="Import a created node from a .samql-node.json file"
          >
            <Icon.Upload size={13} /> Load…
          </button>
        </div>
        {defs.length === 0 ? (
          <p className="muted" data-testid="manage-created-nodes-empty">
            No created nodes yet. Use Create a node… or Load… to add one.
          </p>
        ) : (
          <ul
            className="created-nodes-manage-list"
            data-testid="manage-created-nodes-list"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {defs.map((def) => {
              const Ico = (Icon[def.icon] || Icon.Sparkle) as React.FC<{
                size?: number;
              }>;
              const renaming = renameId === def.id;
              const confirming = confirmDeleteId === def.id;
              return (
                <li
                  key={def.id}
                  data-testid={`manage-created-node-${def.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--border, #ddd)",
                  }}
                >
                  <Ico size={14} />
                  {renaming ? (
                    <input
                      data-testid={`rename-created-node-input-${def.id}`}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") {
                          setRenameId(null);
                          setRenameValue("");
                        }
                      }}
                      autoFocus
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <span style={{ flex: 1 }}>
                      {def.name}{" "}
                      <span className="muted">
                        ({def.inputs.length} in · {def.outputs.length} out)
                      </span>
                    </span>
                  )}
                  {renaming ? (
                    <>
                      <button
                        className="btn sm primary"
                        data-testid={`rename-created-node-save-${def.id}`}
                        onClick={commitRename}
                      >
                        Save
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() => {
                          setRenameId(null);
                          setRenameValue("");
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : confirming ? (
                    <>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Delete permanently?
                      </span>
                      <button
                        className="btn sm danger"
                        data-testid={`delete-created-node-confirm-${def.id}`}
                        onClick={() => commitDelete(def.id)}
                      >
                        Delete
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn sm ghost"
                        data-testid={`rename-created-node-${def.id}`}
                        onClick={() => startRename(def)}
                        title="Rename"
                      >
                        <Icon.Edit size={13} /> Rename
                      </button>
                      <button
                        className="btn sm ghost"
                        data-testid={`delete-created-node-${def.id}`}
                        onClick={() => {
                          setRenameId(null);
                          setConfirmDeleteId(def.id);
                        }}
                        title="Delete"
                      >
                        × Delete
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
      {exportOpen && (
        <ExportCreatedNodeModal
          onClose={() => setExportOpen(false)}
          onToast={onToast}
        />
      )}
      {loadOpen && (
        <LoadCreatedNodeModal
          onClose={() => {
            setLoadOpen(false);
            refresh();
          }}
          onToast={onToast}
        />
      )}
    </>
  );
};
