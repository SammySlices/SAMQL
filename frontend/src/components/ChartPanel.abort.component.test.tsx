import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chartMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../lib/api", () => ({
  api: {
    chart: chartMock,
    cancelQuery: cancelQueryMock,
  },
}));

vi.mock("./ChartView", () => ({
  ChartView: () => <div data-testid="chart-view" />,
}));

import { ChartPanel } from "./ChartPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ChartPanel soft cancel", () => {
  beforeEach(() => {
    chartMock.mockReset();
    cancelQueryMock.mockReset();
  });

  it("aborts the in-flight chart request when props change", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    chartMock
      .mockImplementationOnce((_spec: unknown, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return first.promise;
      })
      .mockImplementationOnce((_spec: unknown, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return second.promise;
      });

    const { rerender, unmount } = render(
      <ChartPanel resultId="r1" columns={["a", "b"]} />,
    );

    await waitFor(() => expect(chartMock).toHaveBeenCalledTimes(1));
    const firstSignal = chartMock.mock.calls[0][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    expect((chartMock.mock.calls[0][0] as any).query_id).toMatch(/^chart-/);

    rerender(<ChartPanel resultId="r2" columns={["a", "b"]} />);
    await waitFor(() => expect(chartMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    act(() => {
      first.resolve({ error: "stale" });
      second.resolve({
        chart_type: "bar",
        labels: ["x"],
        series: [{ name: "b", values: [1] }],
      });
    });
    await second.promise;
    unmount();
  });

  it("Stop cancels the in-flight chart and keeps the prior render", async () => {
    chartMock
      .mockImplementationOnce(async () => ({
        chart_type: "bar",
        labels: ["x"],
        series: [{ name: "b", values: [1] }],
      }))
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            /* hang until Stop */
          }),
      );

    render(<ChartPanel resultId="r1" columns={["a", "b"]} />);
    await waitFor(() => expect(chartMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("chart-view")).toBeTruthy());

    // Change aggregation to force a second fetch, then Stop.
    const agg = screen.getByDisplayValue("sum");
    fireEvent.change(agg, { target: { value: "avg" } });
    await waitFor(() => expect(chartMock).toHaveBeenCalledTimes(2));
    const stop = await screen.findByTestId("chart-stop");
    fireEvent.click(stop);
    await waitFor(() => {
      expect(screen.queryByTestId("chart-stop")).toBeNull();
    });
    expect(cancelQueryMock).toHaveBeenCalled();
    expect(screen.getByTestId("chart-view")).toBeTruthy();
  });
});
