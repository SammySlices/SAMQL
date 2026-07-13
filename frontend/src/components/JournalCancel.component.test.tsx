import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chartMock = vi.hoisted(() => vi.fn());
const pivotMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../lib/api", () => ({
  api: {
    chart: chartMock,
    pivot: pivotMock,
    cancelQuery: cancelQueryMock,
  },
  saveToDownloads: vi.fn(),
}));

vi.mock("./ChartView", () => ({
  ChartView: () => <div data-testid="chart-view" />,
}));

import { VisualizationNotebookCell } from "./notebook/VisualizationNotebookCell";
import { ReconcileNotebookCell } from "./notebook/ReconcileNotebookCell";
import { SqlNotebookCell } from "./notebook/SqlNotebookCell";
import type { NotebookCellProps, RunCell } from "./notebook/NotebookCellTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function vizProps(
  cell: RunCell,
  extra: Partial<NotebookCellProps> = {},
): NotebookCellProps {
  return {
    cell,
    index: 0,
    tables: [],
    canMoveUp: false,
    canMoveDown: false,
    onChangeCode: vi.fn(),
    onChangeText: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onReorderStart: vi.fn(),
    onRunUpstream: vi.fn(),
    onRunDownstream: vi.fn(),
    onRunBranch: vi.fn(),
    onAddBelow: vi.fn(),
    onToggleCollapse: vi.fn(),
    onResize: vi.fn(),
    onSetOutView: vi.fn(),
    onSort: vi.fn(),
    onLoadMore: vi.fn(),
    onExport: vi.fn(),
    onToast: vi.fn(),
    sources: [{ name: "Cell1", resultId: "r1", columns: ["a", "b"] }],
    onSetSource: vi.fn(),
    ...extra,
  };
}

function dropFieldOnRows(fieldLabel: string) {
  const field = screen.getByText(fieldLabel);
  fireEvent.dragStart(field, {
    dataTransfer: {
      setData: () => {},
      effectAllowed: "move",
    },
  });
  const rowsTile = document.querySelector(".pv-tile.pv-rows");
  expect(rowsTile).toBeTruthy();
  fireEvent.drop(rowsTile!, {
    dataTransfer: {
      getData: () => JSON.stringify({ field: fieldLabel, from: "fields" }),
    },
  });
}

describe("Journal chart / pivot / reconcile cancel", () => {
  beforeEach(() => {
    chartMock.mockReset();
    pivotMock.mockReset();
    cancelQueryMock.mockReset();
  });

  it("chart viz cell Stop cancels the in-flight chart and calls cancelQuery", async () => {
    const pending = deferred<any>();
    chartMock.mockImplementationOnce((_spec: unknown, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return pending.promise;
    });

    render(
      <VisualizationNotebookCell
        {...vizProps({
          id: "c1",
          type: "chart",
          code: "",
          text: "",
          sourceName: "Cell1",
          boxW: 480,
          boxH: 320,
        })}
      />,
    );

    const stop = await screen.findByTestId("chart-stop");
    fireEvent.click(stop);
    await waitFor(() => expect(cancelQueryMock).toHaveBeenCalled());
    expect(screen.queryByTestId("chart-stop")).toBeNull();
    act(() => {
      pending.reject(new DOMException("Aborted", "AbortError"));
    });
  });

  it("SQL cell chart out-view also exposes chart Stop", async () => {
    const pending = deferred<any>();
    chartMock.mockImplementationOnce(() => pending.promise);

    render(
      <SqlNotebookCell
        {...vizProps({
          id: "s1",
          type: "sql",
          name: "Cell1",
          code: "SELECT 1",
          text: "",
          ranOnce: true,
          resultId: "r1",
          page: {
            columns: ["a", "b"],
            rows: [[1, 2]],
            offset: 0,
            total_rows: 1,
          },
          outView: "chart",
          boxW: 480,
          boxH: 320,
        })}
      />,
    );

    expect(await screen.findByTestId("chart-stop")).toBeTruthy();
    act(() => {
      pending.resolve({
        chart_type: "bar",
        labels: ["x"],
        series: [{ name: "b", values: [1] }],
      });
    });
  });

  it("pivot viz cell Stop cancels during the debounce window", async () => {
    pivotMock.mockImplementation(
      () =>
        new Promise(() => {
          /* hang */
        }),
    );

    render(
      <VisualizationNotebookCell
        {...vizProps({
          id: "p1",
          type: "pivot",
          code: "",
          text: "",
          sourceName: "Cell1",
          boxW: 480,
          boxH: 320,
        })}
      />,
    );

    dropFieldOnRows("a");
    const stop = await screen.findByTestId("pivot-stop");
    fireEvent.click(stop);
    await waitFor(() => {
      expect(screen.queryByTestId("pivot-stop")).toBeNull();
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(pivotMock).not.toHaveBeenCalled();
  });

  it("reconcile cell Stop calls onCancel while running", () => {
    const onCancel = vi.fn();
    render(
      <ReconcileNotebookCell
        {...vizProps(
          {
            id: "r1",
            type: "reconcile",
            code: "",
            text: "",
            leftSource: "A",
            rightSource: "B",
            recon: { keys: ["id"], compare: ["v"], balance: undefined },
            reconRunning: true,
            boxW: 480,
            boxH: 320,
          },
          {
            onCancel,
            reconSources: [
              { name: "A", columns: ["id", "v"] },
              { name: "B", columns: ["id", "v"] },
            ],
            onSetReconSource: vi.fn(),
            onSetReconSpec: vi.fn(),
            onRunReconcile: vi.fn(),
          },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "■ Stop" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
