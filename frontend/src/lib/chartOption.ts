// Pure builder that turns the backend's ChartData (+ the chart node's optional
// ChartStyle) into an ECharts `option`. Deliberately imports nothing from
// echarts, so it can be unit-tested under Node and so all the styling logic
// lives in one inspectable place. echart.ts wraps this and hands the result to
// a real ECharts instance.
//
// Default-safe: when `data.style` is absent the option is identical to the
// original hard-coded one, so existing charts render exactly as before.
import type { ChartData, ChartStyle, ChartPalette } from "./types";

export const PALETTES: Record<ChartPalette, string[]> = {
  samql: ["#54b949", "#4f9cf9", "#f4c542", "#e5614b", "#a06cf6", "#3ec6c0", "#d96bb0", "#9bbf3c"],
  vivid: ["#ff5d5d", "#ffa600", "#ffe14d", "#5ad469", "#2ec4ff", "#7a5cff", "#ff5cc8", "#00d6b4"],
  cool:  ["#4f9cf9", "#3ec6c0", "#7a5cff", "#54b949", "#2ec4ff", "#5a8dee", "#9b8cff", "#3cc7a0"],
  warm:  ["#e5614b", "#f4c542", "#ff8c42", "#d96bb0", "#ff5d5d", "#ffa600", "#c0594b", "#e08b3c"],
  mono:  ["#9fc1ef", "#6fa0e6", "#4f81d6", "#3a63b0", "#2b4a86", "#7b93b8", "#aab8d0", "#5a6f93"],
  pastel:["#a8d5a2", "#a6c8f0", "#f7d98c", "#f0a8a0", "#c9b3f0", "#9fe0db", "#f0b8dd", "#d3e0a0"],
  earth: ["#8a9a5b", "#c19a6b", "#b07d4f", "#6b8e8a", "#a0522d", "#7d9b76", "#c2a878", "#5f7355"],
};

type ThemeColors = {
  axis: string;
  grid: string;
  bg: string;
  text: string;
  border: string;
};

const THEMES: Record<"dark" | "light", ThemeColors> = {
  dark:  { axis: "#9aa3b2", grid: "#2b2f37", bg: "#1b1e23", text: "#e6e9ef", border: "#3a404b" },
  // light axis text: #5b6470 only reached 4.21:1 on the #d8d8d8 canvas —
  // #4a5260 clears 4.5:1 for the small axis/tick labels.
  light: { axis: "#4a5260", grid: "#b8b8b8", bg: "#d8d8d8", text: "#1b1e23", border: "#9a9a9a" },
};

/** Chart chrome colors per theme (axis/grid/bg/text/border). */
export { THEMES };

export function paletteColors(p?: ChartPalette): string[] {
  return PALETTES[(p as ChartPalette) || "samql"] || PALETTES.samql;
}

// Linear-interpolate two #rrggbb colours (t in [0,1]) -- used to colour tree
// nodes on a value gradient without depending on visualMap supporting trees.
function hexLerp(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace("#", ""), 16);
  const pb = parseInt(b.replace("#", ""), 16);
  const cl = Math.max(0, Math.min(1, t));
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * cl);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * cl);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * cl);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

/** Background colour an exported image should be flattened onto. */
export function exportBackground(style?: ChartStyle): string {
  return style?.theme === "light" ? THEMES.light.bg : THEMES.dark.bg;
}

/** Align chart entrance with `--dur-modal` (240ms); honor OS / app reduce-motion. */
export function chartAnimationMs(): number {
  if (typeof window === "undefined") return 240;
  try {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return 0;
    }
  } catch {
    /* ignore matchMedia failures in odd hosts */
  }
  if (
    typeof document !== "undefined" &&
    document.body?.classList.contains("motion-reduced")
  ) {
    return 0;
  }
  return 240;
}

export function buildChartOption(data: ChartData): Record<string, any> {
  const style: ChartStyle = data.style || {};
  const theme = THEMES[style.theme === "light" ? "light" : "dark"];
  const palette = paletteColors(style.palette);
  const ct = data.chart_type;
  const isLight = style.theme === "light";
  const animMs = chartAnimationMs();

  const tooltip = {
    backgroundColor: theme.bg,
    borderColor: theme.border,
    textStyle: { color: theme.text, fontSize: 12 },
  };
  const titleOpt = style.title
    ? { text: style.title, left: "center", textStyle: { color: theme.text, fontSize: 14 } }
    : undefined;
  const base: Record<string, any> = {
    // Charts draw in and tween on re-query; duration matches UI chrome (--dur-modal).
    animation: animMs > 0,
    animationDuration: animMs,
    animationEasing: "cubicOut",
    animationDurationUpdate: animMs > 0 ? Math.round(animMs * 0.85) : 0,
    animationEasingUpdate: "cubicInOut",
    backgroundColor: isLight ? theme.bg : "transparent",
    color: palette,
    textStyle: { color: theme.axis, fontSize: 11 },
    title: titleOpt,
  };

  const colorFor = (name: string, i: number): string =>
    (style.seriesColors && style.seriesColors[name]) || palette[i % palette.length];
  const showGrid = style.showGrid !== false; // default on

  // ---- pie / donut -------------------------------------------------------
  if (ct === "pie" || ct === "donut") {
    const labels = data.labels || [];
    const values = data.series[0]?.values || [];
    const pieData = values.map((v, i) => {
      const nm = labels[i] ?? String(i);
      const override = style.seriesColors && style.seriesColors[nm];
      return override
        ? { name: nm, value: v, itemStyle: { color: override } }
        : { name: nm, value: v };
    });
    const legendShown = style.showLegend !== undefined ? !!style.showLegend : true;
    const pad = Math.max(0, Math.min(30, Number(style.padAngle) || 0));
    const series: Record<string, any> = {
      type: "pie",
      radius: ct === "donut" ? ["42%", "68%"] : ["0%", "62%"],
      data: pieData,
      label: { color: theme.axis },
    };
    if (pad > 0) {
      series.padAngle = pad;
      // a pad angle reads best with a slight slice border + rounded corners
      series.itemStyle = { borderColor: theme.bg, borderWidth: 1, borderRadius: 4 };
    }
    if (style.roseType) {
      // nightingale / "rose": slice radius encodes value (a customized pie)
      series.roseType = "radius";
      if (ct !== "donut") series.radius = ["18%", "70%"];
      series.label = { color: theme.axis, formatter: "{b}: {d}%" };
    }
    return {
      ...base,
      tooltip: { trigger: "item", ...tooltip },
      legend: legendShown
        ? { type: "scroll", bottom: 0, textStyle: { color: theme.axis } }
        : undefined,
      series: [series],
    };
  }

  // ---- treemap (flat name -> value, optional value gradient) --------------
  if (ct === "treemap") {
    const labels = data.labels || [];
    const values = data.series[0]?.values || [];
    const nodes = values.map((v, i) => {
      const nm = labels[i] ?? String(i);
      const override = style.seriesColors && style.seriesColors[nm];
      return override
        ? { name: nm, value: v, itemStyle: { color: override } }
        : { name: nm, value: v };
    });
    const nums = values.filter((v) => typeof v === "number");
    const vmax = nums.length ? Math.max(...nums) : 1;
    const vmin = nums.length ? Math.min(...nums) : 0;
    const grad = !!style.gradient;
    return {
      ...base,
      tooltip: { trigger: "item", ...tooltip },
      visualMap: grad
        ? {
            show: false,
            min: vmin,
            max: vmax <= vmin ? vmin + 1 : vmax,
            inRange: { color: [palette[1] || "#4f9cf9", palette[0] || "#54b949"] },
          }
        : undefined,
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          label: { show: true, color: "#fff" },
          data: nodes,
        },
      ],
    };
  }

  // ---- tree (node-link hierarchy + value gradient) -----------------------
  // Built from the tabular data: with a series split it's
  // root -> series -> label leaves; otherwise root -> label leaves. Leaves
  // (and their parent branches) are coloured on a value gradient.
  if (ct === "tree") {
    const labels = data.labels || [];
    const multiSeries = data.series.length > 1;
    const allVals: number[] = [];
    type TNode = { name: string; value?: number; children?: TNode[];
      itemStyle?: Record<string, any>; lineStyle?: Record<string, any> };
    let rootChildren: TNode[];
    if (multiSeries) {
      rootChildren = data.series.map((s) => {
        const vals = s.values || [];
        const children = labels.map((lb, i) => {
          const v = typeof vals[i] === "number" ? vals[i] : 0;
          allVals.push(v);
          return { name: String(lb), value: v } as TNode;
        });
        return { name: s.name || "series", children } as TNode;
      });
    } else {
      const vals = data.series[0]?.values || [];
      rootChildren = labels.map((lb, i) => {
        const v = typeof vals[i] === "number" ? vals[i] : 0;
        allVals.push(v);
        return { name: String(lb), value: v } as TNode;
      });
    }
    const vmax = allVals.length ? Math.max(...allVals) : 1;
    const vmin = allVals.length ? Math.min(...allVals) : 0;
    const span = vmax > vmin ? vmax - vmin : 1;
    const grad = style.gradient !== false; // gradient is the point of this chart
    const loC = palette[1] || "#4f9cf9";
    const hiC = palette[0] || "#54b949";
    const paint = (n: TNode): number => {
      let v: number;
      if (n.children && n.children.length) {
        let sum = 0;
        for (const c of n.children) sum += paint(c);
        v = sum;
        n.value = sum;
      } else {
        v = typeof n.value === "number" ? n.value : 0;
      }
      if (grad) {
        const col = hexLerp(loC, hiC, (v - vmin) / span);
        n.itemStyle = { color: col, borderColor: col };
        n.lineStyle = { color: col };
      }
      return v;
    };
    const root: TNode = { name: style.title ? "" : data.x || "root",
      children: rootChildren };
    rootChildren.forEach(paint);
    return {
      ...base,
      tooltip: { trigger: "item", triggerOn: "mousemove", ...tooltip },
      series: [
        {
          type: "tree",
          data: [root],
          top: titleOpt ? "12%" : "3%",
          bottom: "3%",
          left: "10%",
          right: "16%",
          symbolSize: 9,
          orient: "LR",
          expandAndCollapse: true,
          initialTreeDepth: multiSeries ? 2 : 1,
          label: {
            color: theme.text,
            fontSize: 11,
            position: "left",
            verticalAlign: "middle",
            align: "right",
          },
          leaves: {
            label: { position: "right", verticalAlign: "middle", align: "left" },
          },
          lineStyle: { color: theme.grid, width: 1, curveness: 0.5 },
          emphasis: { focus: "descendant" },
        },
      ],
    };
  }

  // ---- candlestick (OHLC; large-scale adds a zoom slider) ----------------
  if (ct === "candlestick") {
    const labels = data.labels || [];
    const ohlc = data.series[0]?.ohlc || [];
    const zoom = !!style.dataZoom || ohlc.length > 200;
    const up = "#e5614b";
    const down = "#54b949";
    return {
      ...base,
      tooltip: { trigger: "axis", axisPointer: { type: "cross" }, ...tooltip },
      grid: {
        left: 8,
        right: 24,
        top: titleOpt ? 40 : 24,
        bottom: zoom ? 64 : 40,
        containLabel: true,
      },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: true,
        axisLabel: { color: theme.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
      },
      dataZoom: zoom
        ? [
            { type: "inside" },
            { type: "slider", bottom: 8, height: 18 },
          ]
        : undefined,
      series: [
        {
          type: "candlestick",
          data: ohlc,
          itemStyle: {
            color: up,
            color0: down,
            borderColor: up,
            borderColor0: down,
          },
        },
      ],
    };
  }

  // ---- scatter -----------------------------------------------------------
  if (ct === "scatter") {
    const pts = (data.series[0]?.points || []).map((p) => [p.x, p.y]);
    const named = (n?: string) =>
      n ? { name: n, nameTextStyle: { color: theme.axis } } : {};
    return {
      ...base,
      tooltip: { trigger: "item", ...tooltip },
      grid: { left: 8, right: 24, top: titleOpt ? 34 : 24, bottom: 40, containLabel: true },
      xAxis: {
        type: "value",
        ...named(style.xLabel),
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        ...named(style.yLabel),
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
        ...(typeof style.yMin === "number" && isFinite(style.yMin)
          ? { min: style.yMin }
          : {}),
        ...(typeof style.yMax === "number" && isFinite(style.yMax)
          ? { max: style.yMax }
          : {}),
        ...(style.yScale ? { scale: true } : {}),
      },
      series: [
        {
          type: "scatter",
          symbolSize: 7,
          itemStyle: { color: colorFor(data.series[0]?.name || "", 0) },
          data: pts,
        },
      ],
    };
  }

  // ---- multiple x axes (two independent (x,y) series, top + bottom) ------
  if (ct === "multix") {
    const labels = data.labels || [];
    const labels2 = data.labels2 || [];
    const s0 = data.series[0];
    const s1 = data.series[1];
    const n0 = s0?.name || "Series 1";
    const n1 = s1?.name || "Series 2";
    const axis = (cats: string[], top: boolean, name?: string) => ({
      type: "category",
      data: cats,
      position: top ? "top" : "bottom",
      axisLabel: { color: theme.axis, hideOverlap: true },
      axisLine: { lineStyle: { color: theme.grid } },
      ...(name
        ? { name, nameTextStyle: { color: theme.axis }, nameLocation: "middle", nameGap: 26 }
        : {}),
    });
    return {
      ...base,
      tooltip: { trigger: "axis", ...tooltip },
      legend: (style.showLegend ?? true)
        ? { type: "scroll", bottom: 0, textStyle: { color: theme.axis } }
        : undefined,
      grid: { left: 8, right: 24, top: titleOpt ? 56 : 44, bottom: 56, containLabel: true },
      xAxis: [axis(labels, false, style.xLabel), axis(labels2, true)],
      yAxis: {
        type: "value",
        ...(style.yLabel
          ? { name: style.yLabel, nameTextStyle: { color: theme.axis }, nameLocation: "middle", nameGap: 36 }
          : {}),
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
      },
      series: [
        {
          name: n0,
          type: "line",
          smooth: style.smooth !== undefined ? !!style.smooth : true,
          showSymbol: false,
          xAxisIndex: 0,
          data: s0?.values || [],
          itemStyle: { color: colorFor(n0, 0) },
        },
        {
          name: n1,
          type: "line",
          smooth: style.smooth !== undefined ? !!style.smooth : true,
          showSymbol: false,
          xAxisIndex: 1,
          data: s1?.values || [],
          itemStyle: { color: colorFor(n1, 1) },
        },
      ],
    };
  }

  // ---- multiple y axes (shared category x; metric 1 = bars on the left
  // axis, metric 2 = line on the right axis, each with its own scale) ------
  if (ct === "multiy") {
    const labels = data.labels || [];
    const s0 = data.series[0];
    const s1 = data.series[1];
    const n0 = s0?.name || "Series 1";
    const n1 = s1?.name || "Series 2";
    const c0 = colorFor(n0, 0);
    const c1 = colorFor(n1, 1);
    const yAxis = (name: string, color: string, position: "left" | "right") => ({
      type: "value",
      position,
      ...(name
        ? { name, nameTextStyle: { color }, nameLocation: "end" }
        : {}),
      axisLine: { show: true, lineStyle: { color } },
      axisLabel: { color },
      splitLine: {
        show: position === "left" && showGrid,
        lineStyle: { color: theme.grid },
      },
    });
    return {
      ...base,
      tooltip: { trigger: "axis", ...tooltip },
      legend: (style.showLegend ?? true)
        ? { type: "scroll", bottom: 0, textStyle: { color: theme.axis } }
        : undefined,
      grid: { left: 8, right: 16, top: titleOpt ? 48 : 32, bottom: 56, containLabel: true },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { rotate: 30, color: theme.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: theme.grid } },
        ...(style.xLabel
          ? { name: style.xLabel, nameTextStyle: { color: theme.axis }, nameLocation: "middle", nameGap: 30 }
          : {}),
      },
      yAxis: [yAxis(n0, c0, "left"), yAxis(n1, c1, "right")],
      series: [
        {
          name: n0,
          type: "bar",
          yAxisIndex: 0,
          data: s0?.values || [],
          itemStyle: { color: c0 },
        },
        {
          name: n1,
          type: "line",
          yAxisIndex: 1,
          smooth: style.smooth !== undefined ? !!style.smooth : true,
          showSymbol: false,
          data: s1?.values || [],
          itemStyle: { color: c1 },
          lineStyle: { color: c1 },
        },
      ],
    };
  }

  // ---- period delta (consecutive change from a level series) -------------
  if (ct === "delta") {
    const labels = data.labels || [];
    const values = data.series[0]?.values || [];
    const percent = style.deltaMode === "percent";
    const changes = values.map((v, i) => {
      if (i === 0) return 0;
      const prev = Number(values[i - 1]);
      const cur = Number(v);
      if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
      if (percent) return prev === 0 ? null : ((cur - prev) * 100) / prev;
      return cur - prev;
    });
    const inc = colorFor("Increase", 0);
    const dec = colorFor("Decrease", 3);
    const flat = theme.axis;
    const points = changes.map((v) => ({
      value: v,
      itemStyle: { color: v == null ? flat : v > 0 ? inc : v < 0 ? dec : flat },
    }));
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        valueFormatter: (v: unknown) =>
          v == null ? "—" : `${Number(v).toLocaleString()}${percent ? "%" : ""}`,
        ...tooltip,
      },
      grid: { left: 8, right: 24, top: titleOpt ? 40 : 24, bottom: 56, containLabel: true },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { rotate: 30, color: theme.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        axisLabel: percent ? { formatter: "{value}%", color: theme.axis } : { color: theme.axis },
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
      },
      series: [{
        name: percent ? "Period change %" : "Period change",
        type: "bar",
        data: points,
        markLine: { symbol: "none", silent: true, lineStyle: { color: theme.axis }, data: [{ yAxis: 0 }] },
      }],
    };
  }

  // ---- waterfall (level series rendered as signed period movements) -------
  if (ct === "waterfall") {
    const labels = data.labels || [];
    const levels = (data.series[0]?.values || []).map((v) => Number(v));
    const inc = colorFor("Increase", 0);
    const dec = colorFor("Decrease", 3);
    const flat = theme.axis;
    const bases: number[] = [];
    const moves: Array<Record<string, any>> = [];
    const changes: number[] = [];
    levels.forEach((cur, i) => {
      const prev = i === 0 ? 0 : levels[i - 1];
      const delta = Number.isFinite(cur) && Number.isFinite(prev) ? cur - prev : 0;
      changes.push(delta);
      bases.push(delta >= 0 ? prev : cur);
      moves.push({
        value: Math.abs(delta),
        itemStyle: { color: delta > 0 ? inc : delta < 0 ? dec : flat },
      });
    });
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        formatter: (params: any[]) => {
          const idx = params?.[0]?.dataIndex ?? 0;
          const label = labels[idx] ?? String(idx);
          const change = changes[idx] ?? 0;
          const level = levels[idx] ?? 0;
          return `${label}<br/>Change: ${change.toLocaleString()}<br/>Total: ${level.toLocaleString()}`;
        },
        ...tooltip,
      },
      grid: { left: 8, right: 24, top: titleOpt ? 40 : 24, bottom: 56, containLabel: true },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { rotate: 30, color: theme.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { lineStyle: { color: theme.grid } },
        splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
      },
      series: [
        {
          name: "Base",
          type: "bar",
          stack: "waterfall",
          silent: true,
          itemStyle: { color: "transparent", borderColor: "transparent" },
          emphasis: { disabled: true },
          data: bases,
        },
        {
          name: "Change",
          type: "bar",
          stack: "waterfall",
          data: moves,
          markLine: { symbol: "none", silent: true, lineStyle: { color: theme.axis }, data: [{ yAxis: 0 }] },
        },
      ],
    };
  }

  // ---- bar / line / area (category axis, single or multiple series) ------
  const labels = data.labels || [];
  const isLine = ct === "line";
  const isArea = ct === "area";
  const lineish = isLine || isArea;
  const multi = data.series.length > 1;
  const horizontal = !!style.horizontal && ct === "bar";
  const legendShown =
    style.showLegend !== undefined ? !!style.showLegend : multi;

  const catAxis: Record<string, any> = {
    type: "category",
    data: labels,
    axisLabel: horizontal
      ? { color: theme.axis, hideOverlap: true }
      : { rotate: 30, color: theme.axis, hideOverlap: true },
    axisLine: { lineStyle: { color: theme.grid } },
  };
  const valAxis: Record<string, any> = {
    type: "value",
    axisLine: { lineStyle: { color: theme.grid } },
    splitLine: { show: showGrid, lineStyle: { color: theme.grid } },
    // Optional Y scaling: explicit bounds win; "fit to data" lets small
    // deltas read on a big-magnitude series instead of pinning zero.
    ...(typeof style.yMin === "number" && isFinite(style.yMin)
      ? { min: style.yMin }
      : {}),
    ...(typeof style.yMax === "number" && isFinite(style.yMax)
      ? { max: style.yMax }
      : {}),
    ...(style.yScale ? { scale: true } : {}),
  };
  const withName = (ax: Record<string, any>, n?: string) =>
    n
      ? { ...ax, name: n, nameTextStyle: { color: theme.axis }, nameLocation: "middle", nameGap: 30 }
      : ax;
  const catNamed = withName(catAxis, style.xLabel);
  const valNamed = withName(valAxis, style.yLabel);

  const series = data.series.map((s, si) => {
    const nm = s.name || "Series " + (si + 1);
    const o: Record<string, any> = {
      name: nm,
      type: lineish ? "line" : "bar",
      smooth: lineish ? (style.smooth !== undefined ? !!style.smooth : isLine) : false,
      showSymbol: false,
      data: s.values || [],
      itemStyle: { color: colorFor(nm, si) },
    };
    if (isArea) o.areaStyle = { opacity: 0.25 };
    // Large-scale line/area: LTTB downsampling so a very long series stays
    // responsive (pairs well with the zoom slider).
    if (lineish && style.large) {
      o.sampling = "lttb";
      o.large = true;
    }
    if (multi && style.stacked) o.stack = "total";
    // Rounded bars: round the bar's leading end. In a stack only the top
    // (last) series is rounded so the stack reads as one rounded column.
    if (!lineish && style.rounded) {
      const r = horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0];
      const stacked = multi && style.stacked;
      if (!stacked || si === data.series.length - 1) {
        o.itemStyle = { ...o.itemStyle, borderRadius: r };
      }
    }
    return o;
  });

  const catZoom = !!style.dataZoom;
  return {
    ...base,
    tooltip: { trigger: "axis", ...tooltip },
    legend: legendShown
      ? { type: "scroll", bottom: 0, textStyle: { color: theme.axis } }
      : undefined,
    grid: {
      left: 8,
      right: 24,
      top: titleOpt ? 40 : 24,
      bottom: catZoom ? (legendShown ? 78 : 64) : legendShown ? 56 : 64,
      containLabel: true,
    },
    dataZoom: catZoom
      ? [{ type: "inside" }, { type: "slider", bottom: legendShown ? 28 : 8, height: 16 }]
      : undefined,
    xAxis: horizontal ? valNamed : catNamed,
    yAxis: horizontal ? catNamed : valNamed,
    series,
  };
}
