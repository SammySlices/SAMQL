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
