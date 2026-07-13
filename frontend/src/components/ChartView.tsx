import React, { useEffect, useRef } from "react";
import type { ChartData } from "../lib/types";
import { echarts, buildOption } from "../lib/echart";

// Primary chart renderer (ECharts, canvas). Wrapped in an error boundary that
// falls back to the native SVG renderer (`fallback`) if ECharts throws, so a
// hiccup degrades gracefully instead of blanking the panel. ECharts is a real
// dependency: run `npm install echarts` (the native renderer stays the safety
// net). The fill element is absolutely positioned, so every container that
// hosts a chart must be position:relative with a real height.
const EChart: React.FC<{ data: ChartData; chartType?: string; style?: any }> = ({
  data,
  chartType,
  style,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const inst = useRef<any>(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, null, { renderer: "canvas" });
    const ro = new ResizeObserver(() => {
      if (inst.current) inst.current.resize();
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      if (inst.current) {
        inst.current.dispose();
        inst.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (inst.current)
      inst.current.setOption(
        buildOption({
          ...data,
          chart_type: (chartType as any) || data.chart_type,
          style: style !== undefined ? style : data.style,
        }),
        true,
      );
  }, [data, chartType, style]);

  return <div className="nb2-echart" ref={ref} />;
};

class ChartErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* swallow: the native SVG fallback renders instead */
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// `chartType` / `style` are passed separately from the cached `data` so that
// tweaking a chart's appearance re-renders instantly from the already-fetched
// data -- no rerun, no backend round-trip. React.memo then only re-renders when
// the data, the type, or the style object actually change identity (style edits
// patch a fresh style object; unrelated canvas renders reuse the same one).
export const ChartView: React.FC<{
  data: ChartData;
  fallback: React.ReactNode;
  chartType?: string;
  style?: any;
}> = React.memo(({ data, fallback, chartType, style }) => (
  <ChartErrorBoundary fallback={fallback}>
    <EChart data={data} chartType={chartType} style={style} />
  </ChartErrorBoundary>
));
