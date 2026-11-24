import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChartOption, chartAnimationMs } from "./chartOption";
import type { ChartData } from "./types";

const sample: ChartData = {
  chart_type: "bar",
  x: "x",
  y: "y",
  labels: ["a", "b"],
  series: [{ name: "y", values: [1, 2] }],
};

afterEach(() => {
  document.body.classList.remove("motion-reduced");
  vi.unstubAllGlobals();
});

describe("chartOption animation", () => {
  it("uses snappy 240ms entrance aligned with UI chrome", () => {
    expect(chartAnimationMs()).toBe(240);
    const opt = buildChartOption(sample);
    expect(opt.animation).toBe(true);
    expect(opt.animationDuration).toBe(240);
    expect(opt.animationDurationUpdate).toBe(204);
  });

  it("disables chart animation when body.motion-reduced is set", () => {
    document.body.classList.add("motion-reduced");
    expect(chartAnimationMs()).toBe(0);
    const opt = buildChartOption(sample);
    expect(opt.animation).toBe(false);
    expect(opt.animationDuration).toBe(0);
    expect(opt.animationDurationUpdate).toBe(0);
  });

  it("disables chart animation when prefers-reduced-motion matches", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    expect(chartAnimationMs()).toBe(0);
    const opt = buildChartOption(sample);
    expect(opt.animationDuration).toBe(0);
  });
});

describe("Y axis scaling", () => {
  it("pins explicit yMin/yMax on the value axis", () => {
    const opt = buildChartOption({
      ...sample,
      style: { yMin: 39000, yMax: 40000 },
    });
    expect((opt.yAxis as any).min).toBe(39000);
    expect((opt.yAxis as any).max).toBe(40000);
  });

  it("yScale fits the axis to the data range instead of forcing zero", () => {
    const opt = buildChartOption({ ...sample, style: { yScale: true } });
    expect((opt.yAxis as any).scale).toBe(true);
    // and unset by default (zero-pinned bar axis)
    const dflt = buildChartOption(sample);
    expect((dflt.yAxis as any).scale).toBeUndefined();
  });

  it("applies scaling to the scatter y axis too", () => {
    const opt = buildChartOption({
      chart_type: "scatter",
      series: [{ name: "s", points: [{ x: 1, y: 2 }] }],
      style: { yMin: 0, yMax: 10, yScale: true },
    } as any);
    expect((opt.yAxis as any).min).toBe(0);
    expect((opt.yAxis as any).max).toBe(10);
    expect((opt.yAxis as any).scale).toBe(true);
  });
});

describe("chartOption tooltip escaping (H-1)", () => {
  it("escapes HTML in waterfall category labels before ECharts writes innerHTML", () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const opt = buildChartOption({
      chart_type: "waterfall",
      x: "x",
      y: "y",
      labels: [hostile, "b&c"],
      series: [{ name: "y", values: [10, 4] }],
    });
    const html = opt.tooltip.formatter([{ dataIndex: 0 }]) as string;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<br/>Change:");
    const second = opt.tooltip.formatter([{ dataIndex: 1 }]) as string;
    expect(second.startsWith("b&amp;c<br/>")).toBe(true);
  });

  it("uses no HTML-string tooltip formatter that interpolates raw data elsewhere", () => {
    // Every chart type is built; any function formatter must escape its
    // category text the same way.
    const hostile = '"><svg onload=alert(1)>';
    for (const chart_type of ["bar", "line", "area", "pie", "donut", "scatter", "waterfall", "change"]) {
      const opt = buildChartOption({
        chart_type: chart_type as ChartData["chart_type"],
        x: "x",
        y: "y",
        labels: [hostile],
        series: [{ name: hostile, values: [1] }],
      });
      const f = opt.tooltip?.formatter;
      if (typeof f === "function") {
        const out = String(f([{ dataIndex: 0, name: hostile, seriesName: hostile, value: 1 }]));
        expect(out).not.toContain("<svg");
      }
    }
  });
});
