import React from "react";
import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { useNodeFlowClipboard } from "./useNodeFlowClipboard";
import { useNodeFlowKeyboardShortcuts } from "./useNodeFlowKeyboardShortcuts";

const node = (
  id: string,
  type: NbNode["type"],
  x: number,
  config: Record<string, unknown> = {},
): NbNode => ({ id, type, x, y: 10, config });

describe("NodeFlow controller hooks", () => {
  it("copies an internal subgraph and pastes fresh node, edge, and child ids", () => {
    let nodeState: NbNode[] = [
      node("group-a", "group", 10, {
        children: [{ id: "nested-a", type: "filter", config: { condition: "a" } }],
      }),
      node("output-a", "output", 250),
    ];
    let edgeState: NbEdge[] = [
      {
        id: "edge-a",
        from: { node: "group-a", port: "out" },
        to: { node: "output-a", port: "in" },
      },
    ];
    const nodesRef: React.MutableRefObject<NbNode[]> = { current: nodeState };
    const edgesRef: React.MutableRefObject<NbEdge[]> = { current: edgeState };
    const selectedIdsRef: React.MutableRefObject<string[]> = {
      current: ["group-a", "output-a"],
    };
    const selected: string[][] = [];

    const setNodes: React.Dispatch<React.SetStateAction<NbNode[]>> = (update) => {
      nodeState = typeof update === "function" ? update(nodeState) : update;
      nodesRef.current = nodeState;
    };
    const setEdges: React.Dispatch<React.SetStateAction<NbEdge[]>> = (update) => {
      edgeState = typeof update === "function" ? update(edgeState) : update;
      edgesRef.current = edgeState;
    };

    const { result } = renderHook(() =>
      useNodeFlowClipboard({
        nodesRef,
        edgesRef,
        selectedId: null,
        selectedIdsRef,
        setNodes,
        setEdges,
        setSelectedId: vi.fn(),
        setSelectedIds: (ids) => {
          const value = typeof ids === "function" ? ids([]) : ids;
          selected.push(value);
        },
      }),
    );

    act(() => expect(result.current.copySelection()).toBe(true));
    let pastedIds: string[] = [];
    act(() => {
      pastedIds = result.current.pasteClipboard({ x: 500, y: 100 });
    });

    expect(pastedIds).toHaveLength(2);
    expect(new Set(pastedIds).size).toBe(2);
    expect(pastedIds).not.toContain("group-a");
    expect(selected[selected.length - 1]).toEqual(pastedIds);

    const pastedGroup = nodeState.find((item) => item.id === pastedIds[0]);
    const pastedOutput = nodeState.find((item) => item.id === pastedIds[1]);
    expect(pastedGroup?.x).toBe(500);
    expect(pastedOutput?.x).toBe(740);
    expect(pastedGroup?.config.children[0].id).not.toBe("nested-a");

    const pastedEdge = edgeState.find((item) => item.id !== "edge-a");
    expect(pastedEdge).toMatchObject({
      from: { node: pastedGroup?.id, port: "out" },
      to: { node: pastedOutput?.id, port: "in" },
    });
  });

  it("routes editor shortcuts and ignores destructive keys while typing", () => {
    const actions = {
      selectedId: "node-a",
      selectedEdgeRef: { current: null } as React.MutableRefObject<string | null>,
      selectedIdsRef: { current: [] } as React.MutableRefObject<string[]>,
      undo: vi.fn(),
      redo: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      deleteEdge: vi.fn(),
      deleteMany: vi.fn(),
      deleteNode: vi.fn(),
    };
    const { unmount, rerender } = renderHook(
      (props: { enabled?: boolean }) =>
        useNodeFlowKeyboardShortcuts({ ...actions, enabled: props.enabled }),
      { initialProps: { enabled: true as boolean | undefined } },
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Delete" });

    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.redo).toHaveBeenCalledTimes(1);
    expect(actions.copy).toHaveBeenCalledTimes(1);
    expect(actions.paste).toHaveBeenCalledTimes(1);
    expect(actions.deleteNode).toHaveBeenCalledWith("node-a");

    rerender({ enabled: false });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.deleteNode).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(actions.deleteNode).toHaveBeenCalledTimes(1);
    expect(actions.undo).toHaveBeenCalledTimes(1);
    input.remove();

    actions.selectedEdgeRef.current = "edge-a";
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(actions.deleteEdge).toHaveBeenCalledWith("edge-a");

    actions.selectedEdgeRef.current = null;
    actions.selectedIdsRef.current = ["node-a", "node-b"];
    fireEvent.keyDown(window, { key: "Delete" });
    expect(actions.deleteMany).toHaveBeenCalledWith(["node-a", "node-b"]);
    unmount();
  });
});
