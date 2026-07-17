import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeFlowPalette, useNodeFlowPalette } from "./NodeFlowPalette";
import { NodeFlowTabBar } from "./NodeFlowTabBar";

function PaletteHarness() {
  const model = useNodeFlowPalette(true);
  return (
    <NodeFlowPalette
      zoom={1}
      zoomBy={() => {}}
      resetZoom={() => {}}
      model={model}
    />
  );
}

describe("NodeFlow chrome controls", () => {
  it("does not render a toolbar Snap button", () => {
    render(<PaletteHarness />);
    expect(screen.queryByRole("button", { name: /^Snap$/ })).toBeNull();
    expect(screen.queryByTitle("Snap nodes to a grid while dragging")).toBeNull();
    expect(screen.getByTitle("Zoom out")).toBeTruthy();
  });

  it("does not render an in-canvas hide-toolbar button", () => {
    render(
      <NodeFlowTabBar
        tabs={[{ id: "t1", name: "Tab" }]}
        activeTabId="t1"
        editingTab={null}
        editingName=""
        setEditingName={() => {}}
        onSwitchTab={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onCloseTab={() => {}}
        onAddTab={() => {}}
        running={false}
        onCancelRun={() => {}}
        onRunAll={() => {}}
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
      />,
    );
    expect(screen.queryByTitle("Hide the node toolbar")).toBeNull();
    expect(screen.queryByTitle("Show the node toolbar")).toBeNull();
    expect(screen.getByTestId("nodeflow-run")).toBeTruthy();
  });
});
