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

describe("ChartPanel typed column pickers", () => {
  beforeEach(() => {
    chartMock.mockReset();
    chartMock.mockResolvedValue({
      chart_type: "bar",
      x: "region",
      y: "amount",
      labels: ["east"],
      series: [{ name: "amount", values: [10] }],
    });
  });

  it("groups select options by dimension vs measure", async () => {
    const { container } = render(
      <ChartPanel
        resultId="r1"
        columns={["region", "amount"]}
        columnTypes={{ region: "VARCHAR", amount: "DOUBLE" }}
      />,
    );

    await waitFor(() => expect(chartMock).toHaveBeenCalled());
    const groups = container.querySelectorAll("optgroup");
    const labels = [...groups].map((g) => g.getAttribute("label"));
    expect(labels).toContain("Dimensions");
    expect(labels).toContain("Measures");
    const dim = [...groups].find((g) => g.getAttribute("label") === "Dimensions");
    const meas = [...groups].find((g) => g.getAttribute("label") === "Measures");
    expect(dim?.textContent).toMatch(/region/);
    expect(meas?.textContent).toMatch(/amount/);
  });

  it("defaults X to a dimension and Y to a measure", async () => {
    render(
      <ChartPanel
        resultId="r1"
        columns={["amount", "region"]}
        columnTypes={{ amount: "INTEGER", region: "VARCHAR" }}
      />,
    );

    await waitFor(() => expect(chartMock).toHaveBeenCalled());
    const spec = chartMock.mock.calls[0][0];
    expect(spec.x).toBe("region");
    expect(spec.y).toBe("amount");
  });

  it("infers types from sample rows when columnTypes is omitted", async () => {
    const { container } = render(
      <ChartPanel
        resultId="r1"
        columns={["cat", "qty"]}
        sampleRows={[
          ["a", 1],
          ["b", 2],
        ]}
      />,
    );

    await waitFor(() => expect(chartMock).toHaveBeenCalled());
    expect(container.querySelectorAll("optgroup").length).toBeGreaterThan(0);
    const labels = [...container.querySelectorAll("optgroup")].map((g) =>
      g.getAttribute("label"),
    );
    expect(labels).toContain("Dimensions");
  });
});
