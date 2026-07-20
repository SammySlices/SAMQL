import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  setNodeFlowSphereMode,
  type NbNode,
} from "../../lib/nodeFlowModel";
import { NodeFlowCanvasCard } from "./NodeFlowCanvasCard";
import type { NodeFlowCanvasCardActions } from "./NodeFlowCanvasCard";

function makeActions(): NodeFlowCanvasCardActions {
  return {
    startNodeDrag: vi.fn(),
    startNodeResize: vi.fn(),
    startWire: vi.fn(),
    patchNode: vi.fn(),
    ensureChartFor: vi.fn(async () => {}),
    upstreamChartNode: vi.fn(() => null),
    setDashboardPane: vi.fn(),
    groupReorder: vi.fn(),
    groupAddChild: vi.fn(),
    extractChildToCanvas: vi.fn(),
    setHoveredInput: vi.fn(),
    setSelectedId: vi.fn(),
    setSelectedIds: vi.fn(),
    setNodeMenu: vi.fn(),
  };
}

function renderInputCard(node: NbNode, sphereMode: boolean) {
  return render(
    <NodeFlowCanvasCard
      node={node}
      index={0}
      selected={false}
      dropHover={false}
      error={undefined}
      warning={undefined}
      ripple={false}
      snapped={false}
      dying={false}
      born={false}
      lineageFlash={false}
      denseMode={false}
      sphereMode={sphereMode}
      renderVersion="g1"
      chartVersion={0}
      childSelection={null}
      visibleInputCount={0}
      incomingCount={0}
      incomingEdges={[]}
      actions={makeActions()}
      groupDnd={{ current: null }}
      chartDataRef={{ current: {} }}
      selectedIdsRef={{ current: [] }}
    />,
  );
}

describe("NodeFlowCanvasCard Input table caption", () => {
  afterEach(() => {
    setNodeFlowSphereMode(false);
  });

  it("shows the selected table under a sphere Input node", () => {
    setNodeFlowSphereMode(true);
    renderInputCard(
      {
        id: "in-1",
        type: "input",
        x: 0,
        y: 0,
        config: { table: "orders", label: "input" },
      },
      true,
    );
    const caption = screen.getByTestId("nodeflow-input-table");
    expect(caption.textContent).toBe("orders");
    expect(screen.getByTestId("nodeflow-sphere-face").getAttribute("title")).toBe(
      "input: orders",
    );
  });

  it("shows a pick-a-table placeholder when no table is selected", () => {
    setNodeFlowSphereMode(true);
    renderInputCard(
      {
        id: "in-2",
        type: "input",
        x: 0,
        y: 0,
        config: { table: "", label: "input" },
      },
      true,
    );
    expect(screen.getByTestId("nodeflow-input-table").textContent).toBe(
      "(pick a table)",
    );
  });

  it("keeps classic card .nb2-node-sub and does not mount the sphere caption", () => {
    renderInputCard(
      {
        id: "in-3",
        type: "input",
        x: 0,
        y: 0,
        config: { table: "customers", label: "input" },
      },
      false,
    );
    expect(screen.queryByTestId("nodeflow-input-table")).toBeNull();
    expect(screen.getByText("customers")).toBeTruthy();
  });

  it("does not caption non-input sphere leaves", () => {
    setNodeFlowSphereMode(true);
    renderInputCard(
      {
        id: "f-1",
        type: "filter",
        x: 0,
        y: 0,
        config: { condition: "x > 1", label: "filter" },
      },
      true,
    );
    expect(screen.queryByTestId("nodeflow-input-table")).toBeNull();
  });

  it("exposes Filter true/false output ports for branch arrow styling", () => {
    const { container } = renderInputCard(
      {
        id: "f-2",
        type: "filter",
        x: 0,
        y: 0,
        config: { condition: "x > 1", label: "filter" },
      },
      false,
    );
    const truePort = container.querySelector(".nb2-port.out.true");
    const falsePort = container.querySelector(".nb2-port.out.false");
    expect(truePort).not.toBeNull();
    expect(falsePort).not.toBeNull();
    expect(truePort!.querySelector(".nb2-dot")).not.toBeNull();
    expect(falsePort!.querySelector(".nb2-dot")).not.toBeNull();
    expect(truePort!.textContent).toContain("True");
    expect(falsePort!.textContent).toContain("False");
  });
});
