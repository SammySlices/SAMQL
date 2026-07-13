import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useNodeFlowPalette } from "../components/nodeflow/NodeFlowPalette";
import {
  buildCreatedNodeDefinition,
  removeCreatedNode,
  renameCreatedNode,
  upsertCreatedNode,
} from "./createdNodes";
import {
  FAVORITES_KEY,
  createdFavoriteKey,
  createdIdFromFavorite,
  inputPortMark,
  isCreatedFavoriteKey,
  sidePortLabel,
  type NbEdge,
  type NbNode,
} from "./nodeFlowModel";

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

describe("side port labels", () => {
  it("hides plain and numbered in/out captions", () => {
    expect(sidePortLabel("in")).toBeNull();
    expect(sidePortLabel("out")).toBeNull();
    expect(sidePortLabel("in1")).toBeNull();
    expect(sidePortLabel("out3")).toBeNull();
  });

  it("hides left/right captions in favor of arrow marks", () => {
    expect(sidePortLabel("left")).toBeNull();
    expect(sidePortLabel("right")).toBeNull();
    expect(inputPortMark("left")).toBe("L");
    expect(inputPortMark("right")).toBe("R");
    expect(inputPortMark("in")).toBeNull();
  });

  it("keeps semantic captions", () => {
    expect(sidePortLabel("true")).toBe("True");
    expect(sidePortLabel("false")).toBe("False");
    expect(sidePortLabel("left_only")).toBe("only L");
    expect(sidePortLabel("inner")).toBe("inner");
    expect(sidePortLabel("right_only")).toBe("only R");
    expect(sidePortLabel("err")).toBe("errors");
  });
});

describe("created-node favorites", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores created favorites by definition id", () => {
    expect(createdFavoriteKey("abc")).toBe("created:abc");
    expect(isCreatedFavoriteKey("created:abc")).toBe(true);
    expect(createdIdFromFavorite("created:abc")).toBe("abc");
    expect(isCreatedFavoriteKey("filter")).toBe(false);
  });

  it("adds a created node, renames the Favorites label, and drops on delete", async () => {
    const { nodes, edges } = simpleGraph();
    const built = buildCreatedNodeDefinition("Alpha", "Star", nodes, edges);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    upsertCreatedNode(built.definition);
    const key = createdFavoriteKey(built.definition.id);

    const { result } = renderHook(() => useNodeFlowPalette());
    await waitFor(() =>
      expect(result.current.createdNodes.some((d) => d.id === built.definition.id)).toBe(
        true,
      ),
    );

    act(() => {
      result.current.addFavorite(key);
    });
    expect(result.current.favorites).toContain(key);
    expect(localStorage.getItem(FAVORITES_KEY)).toContain(key);

    const renamed = renameCreatedNode(built.definition.id, "Beta");
    expect(renamed.ok).toBe(true);
    await waitFor(() => {
      const def = result.current.createdNodes.find(
        (d) => d.id === built.definition.id,
      );
      expect(def?.name).toBe("Beta");
      expect(result.current.favorites).toContain(key);
    });

    removeCreatedNode(built.definition.id);
    await waitFor(() => {
      expect(result.current.favorites).not.toContain(key);
      expect(
        result.current.createdNodes.some((d) => d.id === built.definition.id),
      ).toBe(false);
    });
  });
});
