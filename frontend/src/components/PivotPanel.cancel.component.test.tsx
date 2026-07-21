import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const pivotMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const saveToDownloadsMock = vi.hoisted(() =>
  vi.fn(async (filename: string) => ({ path: "C:/Downloads/" + filename, filename })),
);

vi.mock("../lib/api", () => ({
  api: {
    pivot: pivotMock,
    cancelQuery: cancelQueryMock,
  },
  saveToDownloads: saveToDownloadsMock,
}));

import { PivotPanel } from "./PivotPanel";

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

describe("PivotPanel Stop", () => {
  beforeEach(() => {
    pivotMock.mockReset();
    cancelQueryMock.mockReset();
    cancelQueryMock.mockResolvedValue({ ok: true });
    pivotMock.mockImplementation(
      () =>
        new Promise(() => {
          /* hang */
        }),
    );
  });

  it("cancels during the debounce window before a request starts", async () => {
    render(
      <PivotPanel
        tables={[
          {
            name: "t",
            engine: "sqlite",
            columns: [{ name: "g" }, { name: "bal" }],
          } as any,
        ]}
        result={null}
        onToast={vi.fn()}
      />,
    );

    dropFieldOnRows("g");

    const stop = await screen.findByTestId("pivot-stop");
    fireEvent.click(stop);

    await waitFor(() => {
      expect(screen.queryByTestId("pivot-stop")).toBeNull();
    });
    // Wait past the 300ms debounce so a buggy Stop would still fire api.pivot.
    await new Promise((r) => setTimeout(r, 400));
    expect(pivotMock).not.toHaveBeenCalled();
  });

  it("aborts an active pivot request and interrupts that exact backend run", async () => {
    render(
      <PivotPanel
        tables={[
          {
            name: "t",
            engine: "sqlite",
            columns: [{ name: "g" }, { name: "bal" }],
          } as any,
        ]}
        result={null}
        onToast={vi.fn()}
      />,
    );

    dropFieldOnRows("g");
    await waitFor(() => expect(pivotMock).toHaveBeenCalledTimes(1));
    const [spec, signal] = pivotMock.mock.calls[0];
    expect(spec.query_id).toMatch(/^pivot-/);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    fireEvent.click(screen.getByTestId("pivot-stop"));

    await waitFor(() =>
      expect(cancelQueryMock).toHaveBeenCalledWith(spec.query_id),
    );
    expect(signal.aborted).toBe(true);
  });

  it("treats interrupt responses as soft cancel and keeps the prior grid", async () => {
    pivotMock
      .mockImplementationOnce(async () => ({
        columns: ["g", "sum(bal)"],
        rows: [["a", 1]],
        row_count: 1,
      }))
      .mockImplementationOnce(async () => ({
        error: "interrupted",
        cancelled: true,
      }));

    const onToast = vi.fn();
    render(
      <PivotPanel
        tables={[
          {
            name: "t",
            engine: "sqlite",
            columns: [{ name: "g" }, { name: "bal" }],
          } as any,
        ]}
        result={null}
        onToast={onToast}
      />,
    );

    dropFieldOnRows("g");
    await waitFor(() => expect(pivotMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("sum(bal)")).toBeTruthy());

    // Change summarize to force a new spec / second run.
    const valuesTile = document.querySelector(".pv-tile.pv-values");
    fireEvent.drop(valuesTile!, {
      dataTransfer: {
        getData: () => JSON.stringify({ field: "bal", from: "fields" }),
      },
    });
    await waitFor(() => expect(pivotMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        "warn",
        "Pivot cancelled",
        expect.any(String),
      );
    });
    expect(screen.getByText("sum(bal)")).toBeTruthy();
  });
});
