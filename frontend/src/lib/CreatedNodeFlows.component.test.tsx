import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CreateCreatedNodeModal,
  ExportCreatedNodeModal,
  LoadCreatedNodeModal,
} from "../components/CreatedNodeModals";
import {
  CREATED_NODES_KEY,
  buildCreatedNodeDefinition,
  loadCreatedNodes,
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

describe("Created Node modals — save / export / load", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
    registerActiveNodeFlowGraphGetter(() => sampleGraph());
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

  it("exports a saved created node as JSON download payload", () => {
    const { nodes, edges } = sampleGraph();
    const built = buildCreatedNodeDefinition("Pack", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const clicks: { download?: string }[] = [];
    const createObjectURL = vi.fn(() => "blob:mock");
    const revoke = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL: revoke,
    });
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") {
        const anchor = el as HTMLAnchorElement;
        anchor.click = () => {
          clicks.push({ download: anchor.download });
        };
      }
      return el;
    });

    render(
      <ExportCreatedNodeModal onClose={vi.fn()} onToast={toast} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));

    expect(createObjectURL).toHaveBeenCalled();
    expect(clicks[0]?.download).toMatch(/Pack\.samql-node\.json/);
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Exported",
      expect.stringContaining("Pack"),
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
});
