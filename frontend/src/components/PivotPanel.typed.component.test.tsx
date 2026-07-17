import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const pivotMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../lib/api", () => ({
  api: {
    pivot: pivotMock,
    cancelQuery: cancelQueryMock,
  },
}));

import { PivotPanel } from "./PivotPanel";

function dropField(field: string, tileSelector: string, from = "drawer") {
  const tile = document.querySelector(tileSelector);
  expect(tile).toBeTruthy();
  fireEvent.drop(tile!, {
    dataTransfer: {
      getData: () => JSON.stringify({ field, from }),
    },
  });
}

describe("PivotPanel typed field drawer", () => {
  beforeEach(() => {
    pivotMock.mockReset();
    cancelQueryMock.mockReset();
    pivotMock.mockResolvedValue({
      columns: ["region", "sum(amount)"],
      rows: [["east", 1]],
      row_count: 1,
    });
  });

  it("groups drawer fields and shows type chips from table ColumnInfo", () => {
    render(
      <PivotPanel
        tables={[
          {
            engine: "duckdb",
            name: "sales",
            source: "sales",
            row_count: 2,
            columns: [
              { name: "region", type: "VARCHAR" },
              { name: "amount", type: "DOUBLE" },
            ],
          },
        ]}
        onToast={vi.fn()}
      />,
    );

    expect(screen.getByText("Dimensions")).toBeTruthy();
    expect(screen.getByText("Measures")).toBeTruthy();
    expect(screen.getByText("text")).toBeTruthy();
    expect(screen.getByText("num")).toBeTruthy();
    expect(screen.getByText("Dim")).toBeTruthy();
    expect(screen.getByText("Num")).toBeTruthy();
  });

  it("defaults measure drops to sum and dimension drops to count", async () => {
    render(
      <PivotPanel
        tables={[]}
        result={{
          id: "r1",
          columns: ["region", "amount"],
          columnTypes: { region: "VARCHAR", amount: "DOUBLE" },
        }}
        onToast={vi.fn()}
      />,
    );

    dropField("region", ".pv-tile.pv-rows");
    dropField("amount", ".pv-tile.pv-values");
    dropField("region", ".pv-tile.pv-values");

    await waitFor(() => expect(pivotMock.mock.calls.length).toBeGreaterThan(0));
    const last = pivotMock.mock.calls[pivotMock.mock.calls.length - 1][0];
    const vals = last.values || [];
    expect(vals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "amount", agg: "sum" }),
        expect.objectContaining({ field: "region", agg: "count" }),
      ]),
    );
  });

  it("role filter still lists every matching field (does not hard-hide)", () => {
    render(
      <PivotPanel
        tables={[
          {
            engine: "duckdb",
            name: "t",
            source: "t",
            row_count: 1,
            columns: [
              { name: "a", type: "VARCHAR" },
              { name: "b", type: "INTEGER" },
            ],
          },
        ]}
        onToast={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle(/Show measures/i));
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.queryByText("a")).toBeNull();
    fireEvent.click(screen.getByTitle(/Show every field/i));
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
  });
});
