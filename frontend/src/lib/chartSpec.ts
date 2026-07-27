/**
 * The ONE chart-spec builder for every surface that asks the backend for
 * chart data from a chart node's config (NodeFlow canvas, Dashboard widgets).
 *
 * The Dashboard used to hand-roll its own subset (chart_type, x, y, agg,
 * series) -- so a "Multiple Y axes" widget lost its y2 and the backend
 * correctly refused with "needs an X column and two Y columns", multi-X lost
 * x2, candlestick lost open/high/low/close, and histogram lost its bin
 * count. Building the spec here keeps the field list in one place.
 */

/** Map a UI chart type to the data shape the backend produces. area reuses
 * the bar (category + series) shape and donut reuses the pie (category +
 * value) shape; the real UI type is re-attached client-side so the renderer
 * can draw the variant. bar / line / pie / scatter / histogram / multix /
 * multiy / candlestick pass straight through. */
export const backendChartType = (t?: string): string =>
  t === "area" || t === "tree" ? "bar" : t === "donut" ? "pie" : t || "bar";

/** The chart spec sent to the backend for a chart node's config. */
export function chartSpecForConfig(cfg: Record<string, any>) {
  return {
    chart_type: backendChartType(cfg.chart_type) as any,
    x: cfg.x,
    y: cfg.y || undefined,
    series: cfg.series || undefined,
    agg: cfg.agg || "sum",
    bins: cfg.bins || undefined,
    open: cfg.open || undefined,
    high: cfg.high || undefined,
    low: cfg.low || undefined,
    close: cfg.close || undefined,
    x2: cfg.x2 || undefined,
    y2: cfg.y2 || undefined,
  };
}
