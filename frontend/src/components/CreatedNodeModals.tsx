import React, { useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import {
  CREATED_NODE_ICON_CHOICES,
  analyzeCreatedNodePorts,
  buildCreatedNodeDefinition,
  getActiveNodeFlowGraph,
  loadCreatedNodes,
  parseCreatedNodeFile,
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

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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

  const exportOne = () => {
    const def = defs.find((d) => d.id === selected);
    if (!def) {
      onToast("error", "Export", "Pick a created node to export.");
      return;
    }
    const safe = def.name.replace(/[^\w\-]+/g, "_") || "created-node";
    downloadJson(`${safe}.samql-node.json`, serializeCreatedNodeFile(def));
    onToast("ok", "Exported", `"${def.name}" saved as a shareable JSON file.`);
    onClose();
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
