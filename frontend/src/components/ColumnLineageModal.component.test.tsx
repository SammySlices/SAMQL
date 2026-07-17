import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ColumnLineageModal } from "./ColumnLineageModal";

const columnLineage = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    columnLineage: (...args: unknown[]) => columnLineage(...args),
  },
}));

vi.mock("../lib/prettyStruct", async () => {
  const actual = await vi.importActual<typeof import("../lib/prettyStruct")>(
    "../lib/prettyStruct",
  );
  return {
    ...actual,
    runAfterPaint: (task: () => void) => {
      task();
      return () => {};
    },
  };
});

describe("ColumnLineageModal", () => {
  beforeEach(() => {
    columnLineage.mockReset();
  });

  it("shows unavailable empty state when no graph is provided", async () => {
    render(
      <ColumnLineageModal
        open={{ column: "Amount" }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("column-lineage-modal")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("column-lineage-unavailable")).toBeInTheDocument();
    });
    expect(columnLineage).not.toHaveBeenCalled();
  });

  it("renders diagram stages and calls highlight handler on click", async () => {
    columnLineage.mockResolvedValue({
      ok: true,
      available: true,
      column: "MaturityDate",
      sql_flagged: false,
      stages: [
        {
          id: "src:out:UniqueID",
          kind: "source",
          column: "UniqueID",
          node_id: "src",
          node_type: "createtable",
          node_label: "Input",
          step: "createtable",
          change: {
            summary: "Loaded from Input",
            inputs: [],
            output: "UniqueID",
            unchanged: false,
          },
        },
        {
          id: "f4:out:MaturityDate",
          kind: "derived",
          column: "MaturityDate",
          node_id: "f4",
          node_type: "formula",
          node_label: "Maturity calc",
          step: "formula — Maturity calc",
          change: {
            summary: "MaturityDate = [UniqueID]",
            expression: "[UniqueID]",
            inputs: ["UniqueID"],
            output: "MaturityDate",
            op: "formula",
            transform: "UniqueID → [UniqueID] → MaturityDate",
            unchanged: false,
          },
        },
      ],
    });

    const onHighlight = vi.fn();
    render(
      <ColumnLineageModal
        open={{
          column: "MaturityDate",
          graph: { nodes: [{ id: "f4" }], edges: [] },
          nodeId: "f4",
        }}
        onClose={vi.fn()}
        onHighlightNode={onHighlight}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("column-lineage-diagram")).toBeInTheDocument();
    });
    expect(columnLineage).toHaveBeenCalled();

    const diagram = screen.getByTestId("column-lineage-diagram");
    const svg = diagram.querySelector("svg.col-lineage-svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("height")).toBeTruthy();
    expect(Number(svg?.getAttribute("height"))).toBeGreaterThan(100);

    const stages = screen.getAllByTestId("column-lineage-stage");
    expect(stages.length).toBe(2);
    expect(stages[0]).toHaveAttribute("data-stage-kind", "source");
    expect(stages[1]).toHaveAttribute("data-stage-kind", "derived");
    expect(stages[0].textContent).toMatch(/UniqueID/);
    expect(stages[1].textContent).toMatch(/MaturityDate/);
    expect(screen.getAllByTestId("column-lineage-transform-mini")[1].textContent)
      .toMatch(/UniqueID → \[UniqueID\] → MaturityDate/);

    await act(async () => {
      fireEvent.click(stages[1]);
    });
    expect(onHighlight).toHaveBeenCalledWith("f4");
    expect(screen.getByTestId("column-lineage-transform")).toBeInTheDocument();
    expect(screen.getByTestId("column-lineage-transform-line").textContent).toMatch(
      /UniqueID → \[UniqueID\] → MaturityDate/,
    );
    expect(screen.getByTestId("column-lineage-op").textContent).toMatch(
      /\[UniqueID\]/,
    );
  });

  it("shows type / group-by / join specifics in the detail panel", async () => {
    columnLineage.mockResolvedValue({
      ok: true,
      available: true,
      column: "sum_amount",
      stages: [
        {
          id: "src:out:amount",
          kind: "source",
          column: "amount",
          node_id: "src",
          node_type: "createtable",
          node_label: "Orders",
          step: "createtable",
          change: {
            summary: "Loaded from Orders",
            inputs: [],
            output: "amount",
            op: "load",
            transform: "Orders → load → amount",
          },
        },
        {
          id: "agg:out:sum_amount",
          kind: "derived",
          column: "sum_amount",
          node_id: "agg",
          node_type: "summarize",
          node_label: "Totals",
          step: "summarize",
          change: {
            summary: "sum(amount) → sum_amount",
            expression: "sum(amount)",
            inputs: ["amount"],
            output: "sum_amount",
            op: "sum",
            transform: "amount → sum(amount) → sum_amount",
            group_by: ["region"],
            unchanged: false,
          },
        },
      ],
    });

    render(
      <ColumnLineageModal
        open={{
          column: "sum_amount",
          graph: { nodes: [], edges: [] },
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("column-lineage-group-by")).toBeInTheDocument();
    });
    expect(screen.getByTestId("column-lineage-group-by").textContent).toMatch(
      /region/,
    );
  });

  it("renders value-history when cell context is provided", async () => {
    columnLineage.mockResolvedValue({
      ok: true,
      available: true,
      column: "total",
      row_index: 0,
      stages: [
        {
          id: "src:out:amount",
          kind: "source",
          column: "amount",
          node_id: "src",
          node_type: "createtable",
          node_label: "Orders",
          step: "createtable",
          change: { summary: "Loaded", inputs: [], output: "amount" },
          value: {
            available: true,
            value: 50,
            inputs: [],
          },
        },
        {
          id: "fx:out:total",
          kind: "derived",
          column: "total",
          node_id: "fx",
          node_type: "formula",
          node_label: "Multiply",
          step: "formula",
          change: {
            summary: "total = [amount] * [qty]",
            expression: "[amount] * [qty]",
            inputs: ["amount", "qty"],
            output: "total",
          },
          value: {
            available: true,
            value: 100,
            expression: "[amount] * [qty]",
            inputs: [
              { column: "amount", value: 50, available: true },
              { column: "qty", value: 2, available: true },
            ],
          },
        },
      ],
    });

    render(
      <ColumnLineageModal
        open={{
          column: "total",
          graph: { nodes: [], edges: [] },
          rowIndex: 0,
          cellValue: 100,
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("column-lineage-values")).toBeInTheDocument();
    });
    expect(columnLineage).toHaveBeenCalledWith(
      expect.anything(),
      "total",
      expect.objectContaining({
        rowIndex: 0,
        cellValue: 100,
      }),
    );

    const chips = screen.getAllByTestId("column-lineage-value-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["50", "100"]);

    await act(async () => {
      fireEvent.click(chips[1]);
    });
    const prior = screen.getByTestId("column-lineage-value-prior");
    expect(prior.textContent).toMatch(/amount/);
    expect(prior.textContent).toMatch(/50/);
    expect(prior.textContent).toMatch(/qty/);
    expect(prior.textContent).toMatch(/2/);
  });
});
