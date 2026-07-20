import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PORTS,
  portsOf,
  setNodeFlowSphereMode,
  type NbNode,
  type NodeType,
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

function renderCard(
  node: NbNode,
  sphereMode: boolean,
  visibleInputCount = 0,
) {
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
      visibleInputCount={visibleInputCount}
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
    renderCard(
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
    expect(caption.getAttribute("title")).toBe("orders");
    expect(screen.getByTestId("nodeflow-sphere-face").getAttribute("title")).toBe(
      "input: orders",
    );
  });

  it("shows a pick-a-table placeholder when no table is selected", () => {
    setNodeFlowSphereMode(true);
    renderCard(
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
    renderCard(
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
});

describe("NodeFlowCanvasCard Filter / Formula captions", () => {
  afterEach(() => {
    setNodeFlowSphereMode(false);
  });

  it("shows the filter condition under a sphere Filter node", () => {
    setNodeFlowSphereMode(true);
    renderCard(
      {
        id: "f-1",
        type: "filter",
        x: 0,
        y: 0,
        config: { condition: "score > 50", label: "filter" },
      },
      true,
    );
    const caption = screen.getByTestId("nodeflow-filter-condition");
    expect(caption.textContent).toBe("score > 50");
    expect(caption.getAttribute("title")).toBe("score > 50");
    expect(caption.classList.contains("nb2-sphere-caption")).toBe(true);
    expect(screen.getByTestId("nodeflow-sphere-face").getAttribute("title")).toBe(
      "filter: score > 50",
    );
  });

  it("shows a set-condition placeholder when Filter has no condition", () => {
    setNodeFlowSphereMode(true);
    renderCard(
      {
        id: "f-2",
        type: "filter",
        x: 0,
        y: 0,
        config: { condition: "", label: "filter" },
      },
      true,
    );
    expect(screen.getByTestId("nodeflow-filter-condition").textContent).toBe(
      "(set a condition)",
    );
  });

  it("keeps classic Filter .nb2-node-sub and does not mount the sphere caption", () => {
    const { container } = renderCard(
      {
        id: "f-3",
        type: "filter",
        x: 0,
        y: 0,
        config: { condition: "id > 0", label: "filter" },
      },
      false,
    );
    expect(screen.queryByTestId("nodeflow-filter-condition")).toBeNull();
    const sub = container.querySelector(".nb2-node-sub");
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toBe("id > 0");
  });

  it("shows formula expression under a sphere Formula node", () => {
    setNodeFlowSphereMode(true);
    renderCard(
      {
        id: "fx-1",
        type: "formula",
        x: 0,
        y: 0,
        config: {
          label: "formula",
          formulas: [{ name: "total", expr: "[price] * [qty]", mode: "new" }],
        },
      },
      true,
    );
    const caption = screen.getByTestId("nodeflow-formula-expression");
    expect(caption.textContent).toBe("total = [price] * [qty]");
    expect(caption.getAttribute("title")).toBe("total = [price] * [qty]");
    expect(caption.classList.contains("nb2-sphere-caption")).toBe(true);
    expect(screen.getByTestId("nodeflow-sphere-face").getAttribute("title")).toBe(
      "formula: total = [price] * [qty]",
    );
  });

  it("shows a set-expression placeholder when Formula is empty", () => {
    setNodeFlowSphereMode(true);
    renderCard(
      {
        id: "fx-2",
        type: "formula",
        x: 0,
        y: 0,
        config: {
          label: "formula",
          formulas: [{ name: "", expr: "", mode: "new" }],
        },
      },
      true,
    );
    expect(screen.getByTestId("nodeflow-formula-expression").textContent).toBe(
      "(set expression)",
    );
  });

  it("keeps classic Formula .nb2-node-sub and does not mount the sphere caption", () => {
    const { container } = renderCard(
      {
        id: "fx-3",
        type: "formula",
        x: 0,
        y: 0,
        config: {
          label: "formula",
          formulas: [{ name: "x", expr: "[a] + 1", mode: "new" }],
        },
      },
      false,
    );
    expect(screen.queryByTestId("nodeflow-formula-expression")).toBeNull();
    const sub = container.querySelector(".nb2-node-sub");
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toBe("x = [a] + 1");
  });

  it("does not caption unrelated sphere leaves", () => {
    setNodeFlowSphereMode(true);
    renderCard(
      {
        id: "s-1",
        type: "sample",
        x: 0,
        y: 0,
        config: { mode: "head", n: 100, label: "sample" },
      },
      true,
    );
    expect(screen.queryByTestId("nodeflow-input-table")).toBeNull();
    expect(screen.queryByTestId("nodeflow-filter-condition")).toBeNull();
    expect(screen.queryByTestId("nodeflow-formula-expression")).toBeNull();
  });

  it("exposes Filter true/false output ports with T/F marks", () => {
    const { container } = renderCard(
      {
        id: "f-ports",
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
    expect(truePort!.querySelector(".nb2-dot-mark")?.textContent).toBe("T");
    expect(falsePort!.querySelector(".nb2-dot-mark")?.textContent).toBe("F");
  });

  it("marks Join only-L / only-R output arrows with L / R", () => {
    const { container } = renderCard(
      {
        id: "j-ports",
        type: "join",
        x: 0,
        y: 0,
        config: { label: "join" },
      },
      false,
      2,
    );
    const leftOnly = container.querySelector(".nb2-port.out.left_only");
    const rightOnly = container.querySelector(".nb2-port.out.right_only");
    const inner = container.querySelector(".nb2-port.out.inner");
    expect(leftOnly?.querySelector(".nb2-dot-mark")?.textContent).toBe("L");
    expect(rightOnly?.querySelector(".nb2-dot-mark")?.textContent).toBe("R");
    expect(leftOnly?.getAttribute("data-out-tone")).toBe("accent");
    expect(rightOnly?.getAttribute("data-out-tone")).toBe("accent");
    expect(inner?.getAttribute("data-out-tone")).toBe("accent");
    expect(inner?.classList.contains("out-std")).toBe(true);
    expect(container.querySelector(".nb2-port.in.port-left .nb2-dot-mark")
      ?.textContent).toBe("L");
    expect(container.querySelector(".nb2-port.in.port-right .nb2-dot-mark")
      ?.textContent).toBe("R");
  });

  it("Cross Join: L/R inputs, green single out (never red)", () => {
    const { container } = renderCard(
      {
        id: "xj",
        type: "crossjoin",
        x: 0,
        y: 0,
        config: { label: "cross join" },
      },
      false,
      2,
    );
    expect(container.querySelector(".nb2-port.in.port-left .nb2-dot-mark")
      ?.textContent).toBe("L");
    expect(container.querySelector(".nb2-port.in.port-right .nb2-dot-mark")
      ?.textContent).toBe("R");
    const out = container.querySelector(".nb2-port.out.out");
    expect(out).not.toBeNull();
    expect(out?.classList.contains("out-std")).toBe(true);
    expect(out?.classList.contains("false")).toBe(false);
    expect(out?.getAttribute("data-out-tone")).toBe("accent");
    expect(out?.querySelector(".nb2-dot-shape")).not.toBeNull();
  });

  it("audits every node type: only Filter false is error-tone; all other outs green", () => {
    const sampleTypes = Object.keys(PORTS) as NodeType[];
    for (const type of sampleTypes) {
      if (PORTS[type].outputs.length === 0) continue;
      const node: NbNode = {
        id: `audit-${type}`,
        type,
        x: 0,
        y: 0,
        config:
          type === "usernode"
            ? { label: type, inputCount: 2, outputCount: 3 }
            : { label: type },
      };
      const outs = portsOf(node).outputs;
      if (outs.length === 0) continue;
      const { container, unmount } = renderCard(
        node,
        false,
        Math.max(portsOf(node).inputs.length, 1),
      );
      for (const port of outs) {
        const el = container.querySelector(`.nb2-port.out.${CSS.escape(port)}`);
        expect(el, `${type}.${port} missing`).not.toBeNull();
        if (port === "false") {
          expect(el!.getAttribute("data-out-tone"), `${type}.false`).toBe(
            "error",
          );
          expect(el!.classList.contains("out-std")).toBe(false);
        } else {
          expect(el!.getAttribute("data-out-tone"), `${type}.${port}`).toBe(
            "accent",
          );
          expect(el!.classList.contains("out-std"), `${type}.${port}`).toBe(
            true,
          );
        }
      }
      unmount();
    }
  });
});
