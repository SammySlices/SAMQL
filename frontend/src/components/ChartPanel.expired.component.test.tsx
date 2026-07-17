import React from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chartMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({
  api: {
    chart: chartMock,
    cancelQuery: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock("./ChartView", () => ({
  ChartView: () => <div data-testid="chart-view" />,
}));

import { ChartPanel } from "./ChartPanel";

describe("ChartPanel expired handling", () => {
  beforeEach(() => {
    chartMock.mockReset();
    chartMock.mockResolvedValue({ error: "result expired" });
  });

  it("calls onExpired when the chart result expired (host-wired toast)", async () => {
    const onExpired = vi.fn();
    render(
      <ChartPanel
        resultId="r1"
        columns={["category", "amount"]}
        onExpired={onExpired}
      />,
    );

    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
  });
});
