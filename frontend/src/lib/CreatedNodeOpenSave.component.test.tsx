import React, { useLayoutEffect, useRef, useState } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreatedNodesSettings } from "../components/CreatedNodesSettings";
import { NodeFlowMenus } from "../components/nodeflow/NodeFlowMenus";
import { useNodeFlowDocumentController } from "../components/nodeflow/useNodeFlowDocumentController";
import {
  applyCreatedNodeToGraph,
  buildCreatedNodeDefinition,
  loadCreatedNodes,
  registerActiveEditingDefinitionGetter,
  registerActiveNodeFlowGraphGetter,
  updateCreatedNodeDefinition,
  upsertCreatedNode,
  usernodeConfigFromDefinition,
} from "./createdNodes";
import {
  parseNodeFlowGraph,
  parseNodeFlowTabs,
  serializeNodeFlowGraph,
  serializeNodeFlowTabs,
  TAB_KEY,
  TABS_KEY,
  type NbEdge,
  type NbNode,
} from "./nodeFlowModel";

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

function multiPortGraph(): { nodes: NbNode[]; edges: NbEdge[] } {
  return {
    nodes: [
      { id: "di1", type: "dyn_input", x: 0, y: 10, config: { label: "left" } },
      { id: "di2", type: "dyn_input", x: 0, y: 80, config: { label: "right" } },
      {
        id: "jn",
        type: "join",
        x: 140,
        y: 40,
        config: { keys: [{ left: "id", right: "id" }], label: "join" },
      },
      {
        id: "do1",
        type: "dyn_output",
        x: 300,
        y: 10,
        config: { label: "matched" },
      },
      {
        id: "do2",
        type: "dyn_output",
        x: 300,
        y: 80,
        config: { label: "copy" },
      },
    ],
    edges: [
      {
        id: "e1",
        from: { node: "di1", port: "out" },
        to: { node: "jn", port: "left" },
      },
      {
        id: "e2",
        from: { node: "di2", port: "out" },
        to: { node: "jn", port: "right" },
      },
      {
        id: "e3",
        from: { node: "jn", port: "inner" },
        to: { node: "do1", port: "in" },
      },
      {
        id: "e4",
        from: { node: "di1", port: "out" },
        to: { node: "do2", port: "in" },
      },
    ],
  };
}

function SettingsMenuHost() {
  const ui = useCreatedNodesSettings(toast);
  return <div>{ui.menu(() => {})}</div>;
}

describe("Open Node / Save Node flows", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
    registerActiveNodeFlowGraphGetter(null);
    registerActiveEditingDefinitionGetter(null);
  });

  it("Save node warns when no created node is open for editing", () => {
    registerActiveEditingDefinitionGetter(null);
    registerActiveNodeFlowGraphGetter(() => simpleGraph());
    render(<SettingsMenuHost />);
    fireEvent.click(screen.getByTestId("save-node-menu"));
    expect(toast).toHaveBeenCalledWith(
      "warn",
      "Save node",
      expect.stringContaining("Open Node"),
    );
    expect(loadCreatedNodes()).toHaveLength(0);
  });

  it("Save node surfaces validation errors for an invalid editing graph", () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Broken", "Star", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    registerActiveEditingDefinitionGetter(() => ({
      id: built.definition.id,
      name: built.definition.name,
      icon: built.definition.icon,
    }));
    registerActiveNodeFlowGraphGetter(() => ({
      nodes: [{ id: "only", type: "select", x: 0, y: 0, config: {} }],
      edges: [],
    }));

    render(<SettingsMenuHost />);
    fireEvent.click(screen.getByTestId("save-node-menu"));
    expect(toast).toHaveBeenCalledWith(
      "error",
      "Save node",
      expect.stringMatching(/Dynamic Input/),
    );
    expect(loadCreatedNodes()[0].inputs).toHaveLength(1);
  });

  it("shows Open Node only for created-node instances", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <NodeFlowMenus
        nodeMenu={{ x: 20, y: 20, id: "u1" }}
        setNodeMenu={vi.fn()}
        selectedIds={["u1"]}
        canPaste={false}
        copySelection={vi.fn()}
        pasteClipboard={vi.fn()}
        deleteMany={vi.fn()}
        removeNode={vi.fn()}
        canOpenCreatedNode
        onOpenCreatedNode={onOpen}
        deleteConfirm={null}
        setDeleteConfirm={vi.fn()}
        doRemoveNode={vi.fn()}
        helpFor={null}
        setHelpFor={vi.fn()}
        canvasMenu={null}
        setCanvasMenu={vi.fn()}
        running={false}
        nodeCount={1}
        cancelRun={vi.fn()}
        runAll={vi.fn()}
        addTypeAt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("open-created-node"));
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(
      <NodeFlowMenus
        nodeMenu={{ x: 20, y: 20, id: "sel" }}
        setNodeMenu={vi.fn()}
        selectedIds={["sel"]}
        canPaste={false}
        copySelection={vi.fn()}
        pasteClipboard={vi.fn()}
        deleteMany={vi.fn()}
        removeNode={vi.fn()}
        canOpenCreatedNode={false}
        onOpenCreatedNode={onOpen}
        deleteConfirm={null}
        setDeleteConfirm={vi.fn()}
        doRemoveNode={vi.fn()}
        helpFor={null}
        setHelpFor={vi.fn()}
        canvasMenu={null}
        setCanvasMenu={vi.fn()}
        running={false}
        nodeCount={1}
        cancelRun={vi.fn()}
        runAll={vi.fn()}
        addTypeAt={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("open-created-node")).toBeNull();
  });

  it("persists editingDefinitionId on NodeFlow tabs", () => {
    const file = serializeNodeFlowTabs(
      [
        { id: "t1", name: "Flow" },
        { id: "t2", name: "MyNode", editingDefinitionId: "def-1" },
      ],
      "t2",
    );
    const parsed = parseNodeFlowTabs(file);
    expect(parsed.tabs[1]).toMatchObject({
      id: "t2",
      name: "MyNode",
      editingDefinitionId: "def-1",
    });
  });

  it("Open Node opens an editing tab and reuses it on a second open", async () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Opened", "Layers", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const { result } = renderHook(() => {
      const [graphNodes, setNodes] = useState<NbNode[]>([]);
      const [graphEdges, setEdges] = useState<NbEdge[]>([]);
      const nodesRef = useRef(graphNodes);
      const edgesRef = useRef(graphEdges);
      useLayoutEffect(() => {
        nodesRef.current = graphNodes;
        edgesRef.current = graphEdges;
      }, [graphEdges, graphNodes]);
      return useNodeFlowDocumentController({
        nodes: graphNodes,
        edges: graphEdges,
        nodesRef,
        edgesRef,
        setNodes,
        setEdges,
        setSelectedId: vi.fn(),
        setSelectedIds: vi.fn(),
        setNodeErrors: vi.fn(),
        setNodeWarnings: vi.fn(),
        setNodeMenu: vi.fn(),
        setDeleteConfirm: vi.fn(),
        onToast: toast,
      });
    });

    await waitFor(() => expect(result.current.tabs.length).toBeGreaterThan(0));

    let firstTabId = "";
    act(() => {
      firstTabId = result.current.openGraphInNewTab(
        built.definition.graph,
        built.definition.name,
        { editingDefinitionId: built.definition.id },
      ) as string;
    });

    await waitFor(() =>
      expect(
        result.current.tabs.some(
          (tab) => tab.editingDefinitionId === built.definition.id,
        ),
      ).toBe(true),
    );
    expect(result.current.activeEditingDefinitionId()).toBe(built.definition.id);
    expect(result.current.activeTabId).toBe(firstTabId);

    act(() => {
      result.current.openGraphInNewTab(built.definition.graph, "Other name", {
        editingDefinitionId: built.definition.id,
      });
    });
    expect(
      result.current.tabs.filter(
        (tab) => tab.editingDefinitionId === built.definition.id,
      ),
    ).toHaveLength(1);
    expect(result.current.activeTabId).toBe(firstTabId);
  });

  it("refreshes canvas instances after Save node updates the definition", async () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Refresh", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const instance: NbNode = {
      id: "u1",
      type: "usernode",
      x: 40,
      y: 40,
      config: usernodeConfigFromDefinition(built.definition),
    };

    const { result } = renderHook(() => {
      const [graphNodes, setNodes] = useState<NbNode[]>([]);
      const [graphEdges, setEdges] = useState<NbEdge[]>([]);
      const nodesRef = useRef(graphNodes);
      const edgesRef = useRef(graphEdges);
      useLayoutEffect(() => {
        nodesRef.current = graphNodes;
        edgesRef.current = graphEdges;
      }, [graphEdges, graphNodes]);
      return {
        nodes: graphNodes,
        controller: useNodeFlowDocumentController({
          nodes: graphNodes,
          edges: graphEdges,
          nodesRef,
          edgesRef,
          setNodes,
          setEdges,
          setSelectedId: vi.fn(),
          setSelectedIds: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          setNodeMenu: vi.fn(),
          setDeleteConfirm: vi.fn(),
          onToast: toast,
        }),
      };
    });

    await waitFor(() =>
      expect(result.current.controller.tabs.length).toBeGreaterThan(0),
    );

    act(() => {
      result.current.controller.openGraphInNewTab(
        { nodes: [instance], edges: [] },
        "Host",
      );
    });
    await waitFor(() =>
      expect(result.current.nodes.some((n) => n.id === "u1")).toBe(true),
    );
    expect(result.current.nodes.find((n) => n.id === "u1")?.config.inputCount).toBe(
      1,
    );

    const multi = multiPortGraph();
    const updated = updateCreatedNodeDefinition(
      built.definition.id,
      multi.nodes,
      multi.edges,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    act(() => {
      result.current.controller.refreshUsernodesFromDefinition(updated.definition);
    });

    await waitFor(() => {
      const live = result.current.nodes.find((n) => n.id === "u1");
      expect(live?.config.inputCount).toBe(2);
      expect(live?.config.outputCount).toBe(2);
    });

    const applied = applyCreatedNodeToGraph(
      result.current.nodes,
      [],
      updated.definition,
    );
    expect(applied.changed).toBe(false);
  });

  it("refreshes Created Node instances on never-opened tabs from storage", async () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Dormant", "Beaker", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);

    const instance: NbNode = {
      id: "u-dormant",
      type: "usernode",
      x: 10,
      y: 10,
      config: usernodeConfigFromDefinition(built.definition),
    };
    expect(instance.config.inputCount).toBe(1);

    const activeId = "tab-active";
    const dormantId = "tab-dormant";
    window.localStorage.setItem(
      TABS_KEY,
      JSON.stringify(
        serializeNodeFlowTabs(
          [
            { id: activeId, name: "Active" },
            { id: dormantId, name: "Dormant" },
          ],
          activeId,
        ),
      ),
    );
    window.localStorage.setItem(
      TAB_KEY(activeId),
      JSON.stringify(serializeNodeFlowGraph([], [])),
    );
    window.localStorage.setItem(
      TAB_KEY(dormantId),
      JSON.stringify(serializeNodeFlowGraph([instance], [])),
    );

    const { result } = renderHook(() => {
      const [graphNodes, setNodes] = useState<NbNode[]>([]);
      const [graphEdges, setEdges] = useState<NbEdge[]>([]);
      const nodesRef = useRef(graphNodes);
      const edgesRef = useRef(graphEdges);
      useLayoutEffect(() => {
        nodesRef.current = graphNodes;
        edgesRef.current = graphEdges;
      }, [graphEdges, graphNodes]);
      return {
        nodes: graphNodes,
        controller: useNodeFlowDocumentController({
          nodes: graphNodes,
          edges: graphEdges,
          nodesRef,
          edgesRef,
          setNodes,
          setEdges,
          setSelectedId: vi.fn(),
          setSelectedIds: vi.fn(),
          setNodeErrors: vi.fn(),
          setNodeWarnings: vi.fn(),
          setNodeMenu: vi.fn(),
          setDeleteConfirm: vi.fn(),
          onToast: toast,
        }),
      };
    });

    await waitFor(() =>
      expect(result.current.controller.tabs.map((t) => t.id)).toEqual([
        activeId,
        dormantId,
      ]),
    );
    expect(result.current.controller.activeTabId).toBe(activeId);
    expect(result.current.nodes.some((n) => n.id === "u-dormant")).toBe(false);

    const multi = multiPortGraph();
    const updated = updateCreatedNodeDefinition(
      built.definition.id,
      multi.nodes,
      multi.edges,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    act(() => {
      result.current.controller.refreshUsernodesFromDefinition(
        updated.definition,
      );
    });

    const stored = parseNodeFlowGraph(
      JSON.parse(window.localStorage.getItem(TAB_KEY(dormantId)) || "{}"),
    );
    const refreshed = stored.nodes.find((n) => n.id === "u-dormant");
    expect(refreshed?.config.inputCount).toBe(2);
    expect(refreshed?.config.outputCount).toBe(2);

    act(() => {
      result.current.controller.switchTab(dormantId);
    });
    await waitFor(() => {
      const live = result.current.nodes.find((n) => n.id === "u-dormant");
      expect(live?.config.inputCount).toBe(2);
      expect(live?.config.outputCount).toBe(2);
    });
  });
});
