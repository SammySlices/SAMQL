// Centralised ECharts setup. ECharts replaces Recharts as the chart renderer:
// it renders to canvas (fast on large data) and, crucially, exposes
// getDataURL() so the Output node can save a chart/dashboard as an image with
// no fragile SVG-to-canvas plumbing. Tree-shaken imports keep the bundle小:
// only the charts/components actually used are registered. Run `npm install
// echarts` (recharts has been removed).
import * as echarts from "echarts/core";
import {
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  TreemapChart,
  TreeChart,
  CandlestickChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import type { ChartData } from "./types";
import { buildChartOption, exportBackground } from "./chartOption";

// Every series type the option builder (chartOption.ts) can emit must have its
// chart module registered here, or ECharts silently renders a blank canvas
// (it does NOT throw, so the SVG error-boundary fallback never kicks in). Tree,
// treemap and candlestick were emitted by chartOption but not registered, so
// those three chart types came up empty. DataZoom backs the zoom slider on
// large bar/line series and on big candlesticks; VisualMap backs the treemap
// value gradient.
echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  TreemapChart,
  TreeChart,
  CandlestickChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  VisualMapComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export { echarts };

export const CHART_BG = "#1b1e23";

// Build an ECharts `option` from the backend's ChartData. The actual logic
// (palettes, themes, per-series colours, chart-type variants) lives in the
// dependency-free chartOption module so it can be unit-tested; this is just the
// seam ChartView / the image exporter call. Bar, line, area, pie, donut,
// scatter, histogram, multi-x/-y, treemap, tree and candlestick are all covered
// by the registered chart modules (area = line + areaStyle, donut = pie + inner
// radius, multi-x/-y = bar/line on extra axes).
export function buildOption(data: ChartData): Record<string, unknown> {
  return buildChartOption(data);
}

// Render a single chart off-screen and return its data URL (png/jpeg via the
// canvas renderer, svg via the SVG renderer).
export async function renderToDataURL(
  data: ChartData,
  opts: { type?: "png" | "jpeg" | "svg"; width?: number; height?: number } = {},
): Promise<string> {
  const type = opts.type || "png";
  const width = opts.width || 900;
  const height = opts.height || 540;
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(div);
  let inst: any = null;
  try {
    inst = echarts.init(div, null, {
      renderer: type === "svg" ? "svg" : "canvas",
      width,
      height,
    });
    inst.setOption(buildOption(data));
    return inst.getDataURL({
      type: type === "svg" ? "svg" : type,
      pixelRatio: 2,
      backgroundColor: exportBackground(data.style),
    });
  } finally {
    if (inst) inst.dispose();
    div.remove();
  }
}

// Composite up to four chart images into a 2x2 board (png/jpeg only).
export async function compositeImages(
  urls: (string | null)[],
  opts: { type?: "png" | "jpeg"; cellW?: number; cellH?: number; gap?: number } = {},
): Promise<string> {
  const type = opts.type || "png";
  const cellW = opts.cellW || 620;
  const cellH = opts.cellH || 400;
  const gap = opts.gap || 12;
  const cols = 2;
  const rows = 2;
  const W = cols * cellW + gap * (cols + 1);
  const H = rows * cellH + gap * (rows + 1);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = CHART_BG;
  ctx.fillRect(0, 0, W, H);
  await Promise.all(
    urls.slice(0, 4).map(
      (u, i) =>
        new Promise<void>((resolve) => {
          if (!u) return resolve();
          const img = new Image();
          img.onload = () => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const x = gap + c * (cellW + gap);
            const y = gap + r * (cellH + gap);
            ctx.drawImage(img, x, y, cellW, cellH);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = u;
        }),
    ),
  );
  return canvas.toDataURL(type === "jpeg" ? "image/jpeg" : "image/png");
}
