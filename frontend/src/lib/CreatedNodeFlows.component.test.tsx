import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CreateCreatedNodeModal,
  ExportCreatedNodeModal,
  LoadCreatedNodeModal,
} from "../components/CreatedNodeModals";
import { useCreatedNodesSettings } from "../components/CreatedNodesSettings";
import {
  CREATED_NODES_KEY,
  buildCreatedNodeDefinition,
  loadCreatedNodes,
  registerActiveEditingDefinitionGetter,
  registerActiveNodeFlowGraphGetter,
  serializeCreatedNodeFile,
  upsertCreatedNode,
} from "./createdNodes";
import type { NbEdge, NbNode } from "./nodeFlowModel";

const toast = vi.fn();

function sampleGraph(): { nodes: NbNode[]; edges: NbEdge[] } {
  return {
    nodes: [
      { id: "di", type: "dyn_input", x: 0, y: 0, config: { label: "in" } },
      {
        id: "sel",
        type: "select",
        x: 80,
        y: 0,
        config: { fields: [{ name: "a", keep: true }], label: "sel" },
      },
      { id: "do", type: "dyn_output", x: 160, y: 0, config: { label: "out" } },
    ],
    edges: [
      {
        id: "e1",
        from: { node: "di", port: "out" },
        to: { node: "sel", port: "in" },
      },
      {
        id: "e2",
        from: { node: "sel", port: "out" },
        to: { node: "do", port: "in" },
      },
    ],
  };
}

function SettingsMenuHost() {
  const ui = useCreatedNodesSettings(toast);
  return <div>{ui.menu(() => {})}</div>;
}

describe("Created Node modals — save / export / load", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
    registerActiveNodeFlowGraphGetter(() => sampleGraph());
    registerActiveEditingDefinitionGetter(null);
  });

  it("saves the active tab graph as a created node", async () => {
    const onClose = vi.fn();
    render(
      <CreateCreatedNodeModal onClose={onClose} onToast={toast} />,
    );

    fireEvent.change(screen.getByPlaceholderText("My transform"), {
      target: { value: "MyScaler" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = loadCreatedNodes();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("MyScaler");
    expect(saved[0].inputs).toHaveLength(1);
    expect(saved[0].outputs).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Node created",
      expect.stringContaining("MyScaler"),
    );
  });

  it("exports a saved created node as JSON into Downloads via saveToDownloads", async () => {
    const { nodes, edges } = sampleGraph();
    const built = buildCreatedNodeDefinition("Pack", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const saveToDownloads = vi.fn(
      async (filename: string, _data: { text?: string; b64?: string }) => ({
        path: `C:\\Users\\me\\Downloads\\${filename}`,
        filename,
      }),
    );
    const api = await import("../lib/api");
    vi.spyOn(api, "saveToDownloads").mockImplementation(saveToDownloads);

    const onClose = vi.fn();
    render(
      <ExportCreatedNodeModal onClose={onClose} onToast={toast} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));

    await waitFor(() => expect(saveToDownloads).toHaveBeenCalled());
    expect(saveToDownloads.mock.calls[0]?.[0]).toMatch(/Pack\.samql-node\.json/);
    expect(saveToDownloads.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Pack") }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Exported",
      expect.stringContaining("Downloads"),
    );
  });

  it("loads an exported created-node file into the catalog", async () => {
    const { nodes, edges } = sampleGraph();
    const built = buildCreatedNodeDefinition("Imported", "Cloud", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = JSON.stringify(serializeCreatedNodeFile(built.definition));

    const onClose = vi.fn();
    render(
      <LoadCreatedNodeModal onClose={onClose} onToast={toast} />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File([payload], "Imported.samql-node.json", {
      type: "application/json",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(loadCreatedNodes().map((d) => d.name)).toContain("Imported");
    expect(localStorage.getItem(CREATED_NODES_KEY)).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Created node loaded",
      expect.stringContaining("Imported"),
    );
  });

  it("Save node updates the opened created-node definition ports", () => {
    const { nodes, edges } = sampleGraph();
    const built = buildCreatedNodeDefinition("Editable", "Layers", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const edited = {
      nodes: [
        ...nodes,
        {
          id: "di2",
          type: "dyn_input" as const,
          x: 0,
          y: 90,
          config: { label: "in2" },
        },
        {
          id: "do2",
          type: "dyn_output" as const,
          x: 160,
          y: 90,
          config: { label: "out2" },
        },
      ],
      edges: [
        ...edges,
        {
          id: "e3",
          from: { node: "di2", port: "out" },
          to: { node: "sel", port: "in" },
        },
        {
          id: "e4",
          from: { node: "sel", port: "out" },
          to: { node: "do2", port: "in" },
        },
      ],
    };
    registerActiveNodeFlowGraphGetter(() => edited);
    registerActiveEditingDefinitionGetter(() => ({
      id: built.definition.id,
      name: built.definition.name,
      icon: built.definition.icon,
    }));

    render(<SettingsMenuHost />);
    fireEvent.click(screen.getByTestId("save-node-menu"));

    const saved = loadCreatedNodes().find((d) => d.id === built.definition.id);
    expect(saved?.inputs).toHaveLength(2);
    expect(saved?.outputs).toHaveLength(2);
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Node saved",
      expect.stringContaining("Editable"),
    );
  });
});
