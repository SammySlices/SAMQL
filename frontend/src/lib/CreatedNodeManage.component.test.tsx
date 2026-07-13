import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreatedNodesSettings } from "../components/CreatedNodesSettings";
import {
  buildCreatedNodeDefinition,
  loadCreatedNodes,
  removeCreatedNode,
  renameCreatedNode,
  stripCreatedNodeFromGraph,
  upsertCreatedNode,
  usernodeConfigFromDefinition,
} from "./createdNodes";
import type { NbEdge, NbNode } from "./nodeFlowModel";

const toast = vi.fn();

function simpleGraph(): { nodes: NbNode[]; edges: NbEdge[] } {
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

function SettingsHost() {
  const ui = useCreatedNodesSettings(toast);
  return (
    <div>
      {ui.menu(() => {})}
      {ui.modals}
    </div>
  );
}

describe("Created Nodes — manage / rename / delete", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
  });

  it("renames a catalog entry and dispatches the updated event", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Old", "Star", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const seen: string[] = [];
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      seen.push(String(detail?.definition?.name || ""));
    };
    window.addEventListener("samql-created-node-updated", handler);
    try {
      const renamed = renameCreatedNode(built.definition.id, "  New Name  ");
      expect(renamed.ok).toBe(true);
      if (!renamed.ok) return;
      expect(renamed.definition.name).toBe("New Name");
      expect(loadCreatedNodes()[0].name).toBe("New Name");
      expect(seen).toContain("New Name");
    } finally {
      window.removeEventListener("samql-created-node-updated", handler);
    }
  });

  it("rejects an empty rename", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Keep", "Cloud", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);
    const result = renameCreatedNode(built.definition.id, "   ");
    expect(result.ok).toBe(false);
    expect(loadCreatedNodes()[0].name).toBe("Keep");
  });

  it("strips usernode instances and touching edges from a graph", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Gone", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 10,
      y: 10,
      config: usernodeConfigFromDefinition(built.definition),
    };
    const other: NbNode = {
      id: "keep",
      type: "select",
      x: 0,
      y: 0,
      config: { label: "keep" },
    };
    const graphEdges: NbEdge[] = [
      {
        id: "wire",
        from: { node: "keep", port: "out" },
        to: { node: "u1", port: "in1" },
      },
    ];
    const stripped = stripCreatedNodeFromGraph(
      [instance, other],
      graphEdges,
      built.definition.id,
    );
    expect(stripped.changed).toBe(true);
    expect(stripped.nodes.map((n) => n.id)).toEqual(["keep"]);
    expect(stripped.edges).toEqual([]);
    expect(stripped.removedIds).toEqual(["u1"]);
  });

  it("delete dispatches samql-created-node-deleted and clears the catalog", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Temp", "Grid", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    let deletedId = "";
    const handler = (event: Event) => {
      deletedId = String((event as CustomEvent).detail?.definitionId || "");
    };
    window.addEventListener("samql-created-node-deleted", handler);
    try {
      removeCreatedNode(built.definition.id);
      expect(deletedId).toBe(built.definition.id);
      expect(loadCreatedNodes()).toHaveLength(0);
    } finally {
      window.removeEventListener("samql-created-node-deleted", handler);
    }
  });

  it("Settings → Created Nodes opens the manage modal for rename/delete", async () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("ManageMe", "Sparkle", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    render(<SettingsHost />);
    fireEvent.click(screen.getByTestId("manage-created-nodes-menu"));
    expect(screen.getByTestId("manage-created-nodes-modal")).toBeTruthy();
    expect(screen.getByText(/ManageMe/)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`rename-created-node-${built.definition.id}`));
    const input = screen.getByTestId(
      `rename-created-node-input-${built.definition.id}`,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "RenamedMe" } });
    fireEvent.click(
      screen.getByTestId(`rename-created-node-save-${built.definition.id}`),
    );
    await waitFor(() =>
      expect(loadCreatedNodes()[0].name).toBe("RenamedMe"),
    );

    fireEvent.click(screen.getByTestId(`delete-created-node-${built.definition.id}`));
    fireEvent.click(
      screen.getByTestId(`delete-created-node-confirm-${built.definition.id}`),
    );
    await waitFor(() => expect(loadCreatedNodes()).toHaveLength(0));
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Deleted",
      expect.stringContaining("RenamedMe"),
    );
  });
});
