import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFlowPreviewDrawer } from "./NodeFlowPreviewDrawer";

const columnLineage = vi.fn();

vi.mock("../../lib/api", () => ({
  api: {
    columnLineage: (...args: unknown[]) => columnLineage(...args),
  },
}));

vi.mock("../../lib/prettyStruct", async () => {
  const actual = await vi.importActual<typeof import("../../lib/prettyStruct")>(
    "../../lib/prettyStruct",
  );
  return {
    ...actual,
    runAfterPaint: (task: () => void) => {
      task();
      return () => {};
    },
  };
});

vi.mock("../ChartView", () => ({
  ChartView: () => <div data-testid="chart-view" />,
}));

describe("NodeFlowPreviewDrawer column lineage", () => {
  beforeEach(() => {
    columnLineage.mockReset();
  });

  it("does not expose Show lineage on column-header context menu", () => {
    const graph = {
      nodes: [{ id: "n1", type: "source", config: { label: "Src" } }],
      edges: [],
    };

    render(
      <NodeFlowPreviewDrawer
        preview={{
          kind: "table",
          title: "Join · out",
          columns: ["amount", "id"],
          rows: [[10, 1]],
          total: 1,
          sourceNodeId: "join-1",
          sourcePort: "out",
        }}
        height={240}
        setHeight={vi.fn()}
        onClose={vi.fn()}
        getLineageGraph={() => graph}
      />,
    );

    const header = document.querySelector(
      '.gh-cell[data-column="amount"]',
    ) as HTMLElement;
    expect(header).toBeTruthy();
    fireEvent.contextMenu(header, { clientX: 120, clientY: 80 });

    expect(screen.queryByTestId("nodeflow-preview-col-menu")).toBeNull();
    expect(screen.queryByTestId("show-column-lineage")).toBeNull();
  });

  it("does not render a column menu for non-table previews", () => {
    render(
      <NodeFlowPreviewDrawer
        preview={{
          kind: "chart",
          title: "Chart",
          data: { chart_type: "bar", x: "x", series: [] },
        }}
        height={240}
        setHeight={vi.fn()}
        onClose={vi.fn()}
        getLineageGraph={() => ({ nodes: [], edges: [] })}
      />,
    );

    expect(screen.queryByTestId("nodeflow-preview-col-menu")).toBeNull();
    expect(document.querySelector(".gh-cell")).toBeNull();
  });

  it("exposes Show lineage on cell right-click via onShowLineage", async () => {
    const graph = {
      nodes: [{ id: "n1", type: "source", config: { label: "Src" } }],
      edges: [],
    };
    const getLineageGraph = vi.fn(() => graph);
    columnLineage.mockResolvedValue({
      ok: true,
      available: false,
      column: "amount",
      stages: [],
      reason: "no path",
    });

    render(
      <NodeFlowPreviewDrawer
        preview={{
          kind: "table",
          title: "Join · out",
          columns: ["amount", "id"],
          rows: [[10, 1]],
          total: 1,
          sourceNodeId: "join-1",
          sourcePort: "out",
        }}
        height={240}
        setHeight={vi.fn()}
        onClose={vi.fn()}
        getLineageGraph={getLineageGraph}
      />,
    );

    const cell = screen.getByTestId("result-grid").querySelector(
      '[data-column="amount"][data-row-index="0"]',
    ) as HTMLElement;
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByTestId("show-column-lineage"));
    expect(getLineageGraph).toHaveBeenCalled();
    expect(screen.getByTestId("column-lineage-modal")).toBeInTheDocument();

    await waitFor(() => {
      expect(columnLineage).toHaveBeenCalledWith(
        graph,
        "amount",
        expect.objectContaining({
          node: "join-1",
          port: "out",
          rowIndex: 0,
          cellValue: 10,
        }),
      );
    });
  });
});
