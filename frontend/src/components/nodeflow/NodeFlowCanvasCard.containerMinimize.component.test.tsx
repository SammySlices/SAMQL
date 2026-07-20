import React from "react";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  setNodeFlowSphereMode,
  type NbNode,
} from "../../lib/nodeFlowModel";
import { NodeFlowCanvasCard } from "./NodeFlowCanvasCard";
import type { NodeFlowCanvasCardActions } from "./NodeFlowCanvasCard";

const STYLES_CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../styles.css"),
  "utf8",
);

function makeActions(
  patchNode: (id: string, config: Record<string, unknown>) => void,
): NodeFlowCanvasCardActions {
  return {
    startNodeDrag: vi.fn(),
    startNodeResize: vi.fn(),
    startWire: vi.fn(),
    patchNode,
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

function renderContainerCard(node: NbNode, patchNode = vi.fn()) {
  const groupDnd = { current: null };
  const chartDataRef = { current: {} };
  const selectedIdsRef = { current: [] as string[] };
  return {
    patchNode,
    ...render(
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
        sphereMode
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        visibleInputCount={1}
        incomingCount={0}
        incomingEdges={[]}
        actions={makeActions(patchNode)}
        groupDnd={groupDnd}
        chartDataRef={chartDataRef}
        selectedIdsRef={selectedIdsRef}
      />,
    ),
  };
}

describe("NodeFlowCanvasCard group/iterator minimize", () => {
  afterEach(() => {
    setNodeFlowSphereMode(false);
  });

  it("keeps toggle pill when under-window is open and minimizes from it", () => {
    setNodeFlowSphereMode(true);
    const node: NbNode = {
      id: "g1",
      type: "group",
      x: 0,
      y: 0,
      config: {
        label: "pipe",
        children: [{ id: "c1", type: "select", config: { label: "cols" } }],
      },
    };
    const { patchNode } = renderContainerCard(node);
    expect(screen.getByTestId("nodeflow-sphere-face")).toBeTruthy();
    expect(screen.getByTestId("nodeflow-sphere-under")).toBeTruthy();
    const pill = screen.getByTestId("nodeflow-container-minimize");
    expect(pill.className).toContain("nb2-sphere-container-toggle");
    expect(pill.textContent).toContain("▾");
    expect(screen.queryByTestId("nodeflow-container-expand")).toBeNull();

    fireEvent.click(pill);
    expect(patchNode).toHaveBeenCalledWith("g1", { collapsed: true });
  });

  it("shows compact expand pill when group is minimized", () => {
    setNodeFlowSphereMode(true);
    const node: NbNode = {
      id: "g2",
      type: "group",
      x: 0,
      y: 0,
      config: {
        collapsed: true,
        children: [
          { id: "c1", type: "select", config: {} },
          { id: "c2", type: "filter", config: {} },
        ],
      },
    };
    const { patchNode } = renderContainerCard(node);
    expect(screen.getByTestId("nodeflow-sphere-face")).toBeTruthy();
    expect(screen.queryByTestId("nodeflow-sphere-under")).toBeNull();
    const expand = screen.getByTestId("nodeflow-container-expand");
    expect(expand.className).toContain("nb2-sphere-container-toggle");
    expect(expand.textContent).toContain("2");
    expect(expand.textContent).toContain("▸");
    fireEvent.click(expand);
    expect(patchNode).toHaveBeenCalledWith("g2", { collapsed: false });
  });

  it("minimizes and expands iterator from the same sphere pill", () => {
    setNodeFlowSphereMode(true);
    const open: NbNode = {
      id: "it1",
      type: "iterator",
      x: 0,
      y: 0,
      config: {
        children: [{ id: "c1", type: "select", config: {} }],
      },
    };
    const { patchNode, rerender } = renderContainerCard(open);
    const openPill = screen.getByTestId("nodeflow-container-minimize");
    expect(openPill.textContent).toContain("▾");
    fireEvent.click(openPill);
    expect(patchNode).toHaveBeenCalledWith("it1", { collapsed: true });

    const closed: NbNode = {
      ...open,
      config: { ...open.config, collapsed: true },
    };
    const patch2 = vi.fn();
    rerender(
      <NodeFlowCanvasCard
        node={closed}
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
        sphereMode
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        visibleInputCount={2}
        incomingCount={0}
        incomingEdges={[]}
        actions={makeActions(patch2)}
        groupDnd={{ current: null }}
        chartDataRef={{ current: {} }}
        selectedIdsRef={{ current: [] }}
      />,
    );
    expect(screen.queryByTestId("nodeflow-sphere-under")).toBeNull();
    const closedPill = screen.getByTestId("nodeflow-container-expand");
    expect(closedPill.textContent).toContain("▸");
    fireEvent.click(closedPill);
    expect(patch2).toHaveBeenCalledWith("it1", { collapsed: false });
  });

  it("keeps identical pill left/width across open and minimized states", () => {
    // CSS contract: fixed 64px box, half-width margin center (not translateX).
    const block = STYLES_CSS.slice(
      STYLES_CSS.indexOf(".nb2-sphere-container-toggle {"),
      STYLES_CSS.indexOf(".nb2-sphere-container-toggle:hover"),
    );
    expect(block).toContain("width: 64px");
    expect(block).toContain("margin: 0 0 0 -32px");
    expect(block).toContain("left: 50%");
    expect(block).toContain("display: grid");
    expect(block).toContain("grid-template-columns: minmax(1.5em, 1fr) 1em");
    expect(block).toContain("transform: none");
    expect(block).not.toMatch(/transform:\s*translateX/);
    expect(STYLES_CSS).toContain(
      "button.nb2-sphere-container-toggle:not(:disabled):active",
    );

    setNodeFlowSphereMode(true);
    const style = document.createElement("style");
    style.textContent = `
      .nb2-sphere-container-toggle {
        position: absolute; left: 50%; width: 64px; margin: 0 0 0 -32px;
        display: grid; grid-template-columns: minmax(1.5em, 1fr) 1em;
        transform: none;
      }
    `;
    document.head.appendChild(style);

    const open: NbNode = {
      id: "g-geom",
      type: "group",
      x: 0,
      y: 0,
      config: {
        children: [
          { id: "c1", type: "select", config: {} },
          { id: "c2", type: "filter", config: {} },
        ],
      },
    };
    const { rerender } = renderContainerCard(open);
    const openPill = screen.getByTestId("nodeflow-container-minimize");
    const openCs = getComputedStyle(openPill);
    expect(openCs.width).toBe("64px");
    expect(openCs.marginLeft).toBe("-32px");
    expect(openCs.left).toBe("50%");

    const closed: NbNode = {
      ...open,
      config: { ...open.config, collapsed: true },
    };
    rerender(
      <NodeFlowCanvasCard
        node={closed}
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
        sphereMode
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        visibleInputCount={2}
        incomingCount={0}
        incomingEdges={[]}
        actions={makeActions(vi.fn())}
        groupDnd={{ current: null }}
        chartDataRef={{ current: {} }}
        selectedIdsRef={{ current: [] }}
      />,
    );
    const closedPill = screen.getByTestId("nodeflow-container-expand");
    const closedCs = getComputedStyle(closedPill);
    expect(closedCs.left).toBe(openCs.left);
    expect(closedCs.marginLeft).toBe(openCs.marginLeft);
    expect(closedCs.width).toBe(openCs.width);
    style.remove();
  });
});
