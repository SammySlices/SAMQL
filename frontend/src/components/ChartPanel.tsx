import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
  wasCancelled,
} from "../lib/runController";
import {
  inferColumnTypes,
  pickDefaultChartAxes,
} from "../lib/fieldRoles";
import type {
  Cell,
  ChartData,
  ChartType,
  Aggregation,
  ChartStyle,
  ChartPalette,
} from "../lib/types";
import { Icon } from "./Icon";
import { ChartView } from "./ChartView";
import { paletteColors } from "../lib/chartOption";
import { ColumnOptGroups } from "./ColumnOptGroups";

interface Props {
  resultId: string | null;
  columns: string[];
  /** Optional SQL / inferred types keyed by column name. */
  columnTypes?: Record<string, string> | null;
  /** Sample rows used to infer types when columnTypes is absent. */
  sampleRows?: Cell[][] | null;
  onExpired?: () => void;
  onPopOut?: () => void;
}

const PALETTE = [
  "#54b949",
  "#4f9cf9",
  "#f4c542",
  "#e5614b",
  "#a06cf6",
  "#3ec6c0",
  "#d96bb0",
  "#9bbf3c",
];

const PALETTE_NAMES: ChartPalette[] = [
  "samql",
  "vivid",
  "cool",
  "warm",
  "mono",
  "pastel",
  "earth",
];

const CHART_TYPES: { v: ChartType; label: string }[] = [
  { v: "bar", label: "Bar" },
  { v: "line", label: "Line" },
  { v: "area", label: "Area" },
  { v: "pie", label: "Pie" },
  { v: "donut", label: "Donut" },
  { v: "scatter", label: "Scatter" },
  { v: "histogram", label: "Histogram" },
  { v: "treemap", label: "Treemap" },
  { v: "tree", label: "Tree (gradient)" },
  { v: "candlestick", label: "Candlestick (OHLC)" },
  { v: "multix", label: "Multiple X axes" },
  { v: "multiy", label: "Multiple Y axes" },
  { v: "delta", label: "Period change (Δ)" },
  { v: "waterfall", label: "Waterfall" },
];
const AGGS: Aggregation[] = ["sum", "avg", "count", "min", "max"];

const ChartPanelImpl: React.FC<Props> = ({
  resultId,
  columns,
  columnTypes,
  sampleRows,
  onExpired,
  onPopOut,
}) => {
  const [type, setType] = useState<ChartType>("bar");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [agg, setAgg] = useState<Aggregation>("sum");
  const [bins, setBins] = useState(20);
  // candlestick price columns + multiple-x second series
  const [cOpen, setCOpen] = useState("");
  const [cHigh, setCHigh] = useState("");
  const [cLow, setCLow] = useState("");
  const [cClose, setCClose] = useState("");
  const [x2, setX2] = useState("");
  const [y2, setY2] = useState("");
  // presentational styling (colours / palette / labels) -- not persisted
  const [style, setStyle] = useState<ChartStyle>({});
  const [showStyle, setShowStyle] = useState(false);
  const [data, setData] = useState<ChartData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<{ qid: string; ctrl: AbortController } | null>(null);
  const cancelInflight = useCallback(() => {
    const cur = inflight.current;
    if (!cur) return;
    inflight.current = null;
    cancelOne(cur.qid, cur.ctrl);
  }, []);
  const stopChart = useCallback(() => {
    cancelInflight();
    setLoading(false);
  }, [cancelInflight]);

  const resolvedTypes = useMemo(() => {
    if (columnTypes && Object.keys(columnTypes).length) return columnTypes;
    return inferColumnTypes(columns, sampleRows);
  }, [columnTypes, columns, sampleRows]);

  // initialise the pickers when columns / types change
  useEffect(() => {
    if (!columns.length) return;
    setX((prev) => pickDefaultChartAxes(columns, resolvedTypes, { x: prev }).x);
    setY((prev) => pickDefaultChartAxes(columns, resolvedTypes, { y: prev }).y);
    // Prefer measure columns for OHLC / secondary series when types exist.
    const meas = columns.filter((c) =>
      /INT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC/i.test(resolvedTypes[c] || ""),
    );
    const at = (i: number) =>
      meas[i] ?? columns[i] ?? columns[columns.length - 1] ?? "";
    setCOpen((p) => (columns.includes(p) ? p : at(0)));
    setCHigh((p) => (columns.includes(p) ? p : at(1)));
    setCLow((p) => (columns.includes(p) ? p : at(2)));
    setCClose((p) => (columns.includes(p) ? p : at(3)));
    setX2((p) => (columns.includes(p) ? p : columns[0]));
    setY2((p) => (columns.includes(p) ? p : at(1)));
  }, [columns, resolvedTypes]);

  useEffect(() => {
    if (!resultId || !x) {
      setData(null);
      return;
    }
    cancelInflight();
    const ctrl = new AbortController();
    const qid = "chart-" + Math.random().toString(36).slice(2, 12);
    inflight.current = { qid, ctrl };
    registerRun(qid, ctrl);
    setLoading(true);
    setErr(null);
    const isCandle = type === "candlestick";
    const isMultiX = type === "multix";
    const isMultiY = type === "multiy";
    api
      .chart(
        {
          result_id: resultId,
          chart_type: type,
          x,
          y: type === "histogram" || isCandle ? undefined : y,
          agg,
          bins,
          open: isCandle ? cOpen : undefined,
          high: isCandle ? cHigh : undefined,
          low: isCandle ? cLow : undefined,
          close: isCandle ? cClose : undefined,
          x2: isMultiX ? x2 : undefined,
          y2: isMultiX || isMultiY ? y2 : undefined,
          query_id: qid,
        },
        ctrl.signal,
      )
      .then((d) => {
        if (ctrl.signal.aborted || wasCancelled(qid)) return;
        if (d.error) {
          if (/interrupt|cancel/i.test(d.error) || wasCancelled(qid)) {
            // Soft cancel: keep the previous chart (matches pivot / reconcile).
            return;
          }
          setErr(d.error);
          setData(null);
          if (d.error === "result expired") onExpired?.();
        } else setData(d);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || isCancelledError(e, qid) || wasCancelled(qid))
          return;
        setErr(String(e.message || e));
      })
      .finally(() => {
        unregisterRun(qid, ctrl);
        if (inflight.current && inflight.current.qid === qid)
          inflight.current = null;
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      cancelInflight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultId, type, x, y, agg, bins, cOpen, cHigh, cLow, cClose, x2, y2, onExpired]);

  const needsY = type !== "histogram" && type !== "candlestick";
  const isCandle = type === "candlestick";
  const isMultiX = type === "multix";
  const isMultiY = type === "multiy";
  const isPieish = type === "pie" || type === "donut";
  const isDelta = type === "delta";
  const isWaterfall = type === "waterfall";
  const isTree = type === "treemap";
  const isTreeNode = type === "tree";
  const isCat = type === "bar" || type === "line" || type === "area";
  // names the per-element colour pickers target: slices/leaves for pie+treemap,
  // otherwise the series names the backend returned.
  const colorTargets: string[] = (isDelta || isWaterfall
    ? ["Increase", "Decrease"]
    : isPieish || isTree
      ? data?.labels || []
      : (data?.series || []).map((s) => s.name).filter(Boolean)) as string[];
  const pal = paletteColors(style.palette);

  const patchStyle = (k: keyof ChartStyle, v: any) =>
    setStyle((s) => {
      const n = { ...s };
      if (v === undefined || v === "") delete (n as any)[k];
      else (n as any)[k] = v;
      return n;
    });
  const patchColor = (name: string, color: string | null) =>
    setStyle((s) => {
      const sc = { ...(s.seriesColors || {}) };
      if (color) sc[name] = color;
      else delete sc[name];
      return { ...s, seriesColors: Object.keys(sc).length ? sc : undefined };
    });
  const styledData: ChartData | null = data
    ? { ...data, style: Object.keys(style).length ? style : undefined }
    : null;

  return (
    <div className="chart-panel">
      <div className="chart-controls">
        <div className="field">
          <label>Chart type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ChartType)}
          >
            {CHART_TYPES.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            {type === "scatter" ? "X axis"
              : isCandle ? "Date / category (X)"
              : isMultiX ? "First X (bottom)"
              : "Category (X)"}
          </label>
          <select value={x} onChange={(e) => setX(e.target.value)}>
            <ColumnOptGroups columns={columns} types={resolvedTypes} />
          </select>
        </div>
        {needsY && (
          <div className="field">
            <label>{type === "scatter" ? "Y axis" : isMultiX || isMultiY ? "First Y" : "Value (Y)"}</label>
            <select value={y} onChange={(e) => setY(e.target.value)}>
              <ColumnOptGroups columns={columns} types={resolvedTypes} />
            </select>
          </div>
        )}
        {isMultiY && (
          <div className="field">
            <label>Second Y (right axis)</label>
            <select value={y2} onChange={(e) => setY2(e.target.value)}>
              <ColumnOptGroups columns={columns} types={resolvedTypes} />
            </select>
          </div>
        )}
        {isCandle &&
          ([
            ["Open", cOpen, setCOpen],
            ["High", cHigh, setCHigh],
            ["Low", cLow, setCLow],
            ["Close", cClose, setCClose],
          ] as [string, string, (v: string) => void][]).map(([lbl, val, set]) => (
            <div className="field" key={lbl}>
              <label>{lbl}</label>
              <select value={val} onChange={(e) => set(e.target.value)}>
                <ColumnOptGroups columns={columns} types={resolvedTypes} />
              </select>
            </div>
          ))}
        {isMultiX && (
          <>
            <div className="field">
              <label>Second X (top)</label>
              <select value={x2} onChange={(e) => setX2(e.target.value)}>
                <ColumnOptGroups columns={columns} types={resolvedTypes} />
              </select>
            </div>
            <div className="field">
              <label>Second Y</label>
              <select value={y2} onChange={(e) => setY2(e.target.value)}>
                <ColumnOptGroups columns={columns} types={resolvedTypes} />
              </select>
            </div>
          </>
        )}
        {type !== "scatter" && type !== "histogram" && !isCandle && (
          <div className="field">
            <label>Aggregation</label>
            <select
              value={agg}
              onChange={(e) => setAgg(e.target.value as Aggregation)}
            >
              {AGGS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </div>
        )}
        {type === "histogram" && (
          <div className="field">
            <label>Bins</label>
            <input
              type="number"
              min={2}
              max={100}
              value={bins}
              onChange={(e) => setBins(Number(e.target.value) || 20)}
            />
          </div>
        )}
        <div className="hint">
          Aggregation runs server-side over the full result, then the chart
          renders here.
        </div>
        <button
          className="btn ghost sm"
          title="Colours & style"
          onClick={() => setShowStyle((v) => !v)}
        >
          {showStyle ? "Hide style" : "Style"}
        </button>
        {loading && (
          <button
            className="btn ghost sm"
            data-testid="chart-stop"
            title="Cancel this chart (interrupts the backend aggregate)"
            onClick={stopChart}
          >
            ■ Stop
          </button>
        )}
        {onPopOut && (
          <button
            className="btn ghost sm chart-popout"
            title="Open the chart in a floating window"
            onClick={onPopOut}
          >
            <Icon.PopOut size={14} />
          </button>
        )}
        {showStyle && (
          <div className="chart-style">
            <div className="field">
              <label>Palette</label>
              <select
                value={style.palette || "samql"}
                onChange={(e) => patchStyle("palette", e.target.value as ChartPalette)}
              >
                {PALETTE_NAMES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Theme</label>
              <select
                value={style.theme || "dark"}
                onChange={(e) => patchStyle("theme", e.target.value)}
              >
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </div>
            {isDelta && (
              <div className="field">
                <label>Change measure</label>
                <select
                  value={style.deltaMode || "absolute"}
                  onChange={(e) => patchStyle("deltaMode", e.target.value)}
                >
                  <option value="absolute">Absolute change</option>
                  <option value="percent">Percent change</option>
                </select>
              </div>
            )}
            <label className="chart-style-check">
              <input
                type="checkbox"
                checked={style.showLegend !== undefined ? !!style.showLegend : isPieish || isMultiX}
                onChange={(e) => patchStyle("showLegend", e.target.checked)}
              />{" "}
              Legend
            </label>
            {isPieish && (
              <label className="chart-style-check">
                <input
                  type="checkbox"
                  checked={!!style.roseType}
                  onChange={(e) => patchStyle("roseType", e.target.checked)}
                />{" "}
                Rose / nightingale
              </label>
            )}
            {(isTree || isTreeNode) && (
              <label className="chart-style-check">
                <input
                  type="checkbox"
                  checked={isTreeNode ? style.gradient !== false : !!style.gradient}
                  onChange={(e) => patchStyle("gradient", e.target.checked)}
                />{" "}
                Gradient by value
              </label>
            )}
            {type === "bar" && (
              <label className="chart-style-check">
                <input
                  type="checkbox"
                  checked={!!style.rounded}
                  onChange={(e) => patchStyle("rounded", e.target.checked)}
                />{" "}
                Rounded bars
              </label>
            )}
            {(type === "line" || type === "area") && (
              <label className="chart-style-check">
                <input
                  type="checkbox"
                  checked={!!style.large}
                  onChange={(e) => patchStyle("large", e.target.checked)}
                />{" "}
                Large-scale (downsample)
              </label>
            )}
            {(isCat || isCandle) && (
              <label className="chart-style-check">
                <input
                  type="checkbox"
                  checked={!!style.dataZoom}
                  onChange={(e) => patchStyle("dataZoom", e.target.checked)}
                />{" "}
                Zoom slider
              </label>
            )}
            <div className="chart-style-colors">
              <label>{isPieish || isTree ? "Slice colours" : "Series colours"}</label>
              {colorTargets.length === 0 ? (
                <span className="faint">Render the chart to tune individual colours.</span>
              ) : (
                colorTargets.map((name, i) => {
                  const cur = (style.seriesColors && style.seriesColors[name]) || pal[i % pal.length];
                  const overridden = !!(style.seriesColors && style.seriesColors[name]);
                  return (
                    <span className="chart-color-chip" key={name} title={name}>
                      <input
                        type="color"
                        value={cur}
                        onChange={(e) => patchColor(name, e.target.value)}
                      />
                      <span className="chart-color-name">{name}</span>
                      {overridden && (
                        <button className="btn ghost xs" title="Reset" onClick={() => patchColor(name, null)}>
                          ×
                        </button>
                      )}
                    </span>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
      <div className="chart-canvas">
        {!resultId ? (
          <div className="faint">Run a query to chart its results.</div>
        ) : loading ? (
          <div className="faint">
            <span className="spin" /> building chart…
          </div>
        ) : err ? (
          <div className="error-box" style={{ margin: 0 }}>
            {err}
          </div>
        ) : styledData ? (
          <ChartView
            key={
              styledData.chart_type +
              ":" +
              (styledData.labels?.length ?? 0) +
              ":" +
              styledData.series.length
            }
            data={styledData}
            fallback={<ChartSvg data={styledData} />}
          />
        ) : (
          <div className="faint">No data.</div>
        )}
      </div>
    </div>
  );
};

const W = 720;
const H = 440;
const PAD = { l: 64, r: 24, t: 24, b: 90 };

const ChartSvg: React.FC<{ data: ChartData }> = ({ data }) => {
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  if (data.chart_type === "scatter") {
    const pts = data.series[0]?.points || [];
    if (!pts.length) return <div className="faint">No numeric points.</div>;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const xmin = Math.min(...xs),
      xmax = Math.max(...xs);
    const ymin = Math.min(...ys),
      ymax = Math.max(...ys);
    const sx = (v: number) =>
      PAD.l + ((v - xmin) / (xmax - xmin || 1)) * plotW;
    const sy = (v: number) =>
      PAD.t + plotH - ((v - ymin) / (ymax - ymin || 1)) * plotH;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
        <Axes
          xmin={xmin}
          xmax={xmax}
          ymin={ymin}
          ymax={ymax}
          plotW={plotW}
          plotH={plotH}
          xlabel={data.x}
          ylabel={data.y || ""}
        />
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill="#54b949" opacity={0.7} />
        ))}
      </svg>
    );
  }

  const labels = data.labels || [];
  const values = data.series[0]?.values || [];
  if (!values.length) return <div className="faint">No data to plot.</div>;
  const vmax = Math.max(...values, 0);
  const vmin = Math.min(...values, 0);

  if (data.chart_type === "pie") {
    const totalV = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let angle = -Math.PI / 2;
    const cx = W / 2,
      cy = H / 2 - 10,
      rad = Math.min(plotH, plotW) / 2.4;
    const slices = values.map((v, i) => {
      const frac = Math.max(0, v) / totalV;
      const a0 = angle;
      const a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + rad * Math.cos(a0);
      const y0 = cy + rad * Math.sin(a0);
      const x1 = cx + rad * Math.cos(a1);
      const y1 = cy + rad * Math.sin(a1);
      return {
        d: `M${cx},${cy} L${x0},${y0} A${rad},${rad} 0 ${large} 1 ${x1},${y1} Z`,
        color: PALETTE[i % PALETTE.length],
        label: labels[i],
        pct: frac * 100,
      };
    });
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
        {slices.map((s, i) => (
          <path key={i} d={s.d} fill={s.color} stroke="#15171b" strokeWidth={1.5} />
        ))}
        {slices.slice(0, 12).map((s, i) => (
          <g key={i} transform={`translate(${W - 150},${30 + i * 18})`}>
            <rect width={11} height={11} fill={s.color} rx={2} />
            <text x={16} y={10} fontSize={11} fill="#9aa3b2">
              {String(s.label).slice(0, 16)} {s.pct.toFixed(0)}%
            </text>
          </g>
        ))}
      </svg>
    );
  }

  // bar / line / histogram
  const sy = (v: number) =>
    PAD.t + plotH - ((v - Math.min(0, vmin)) / ((vmax - Math.min(0, vmin)) || 1)) * plotH;
  const band = plotW / labels.length;
  const isLine = data.chart_type === "line";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
      <Axes
        xmin={0}
        xmax={1}
        ymin={Math.min(0, vmin)}
        ymax={vmax}
        plotW={plotW}
        plotH={plotH}
        ylabel={data.series[0]?.name || ""}
        xlabel={data.x}
        hideXTicks
      />
      {/* baseline */}
      <line
        x1={PAD.l}
        x2={PAD.l + plotW}
        y1={sy(0)}
        y2={sy(0)}
        stroke="#3a404b"
      />
      {isLine ? (
        <polyline
          fill="none"
          stroke="#54b949"
          strokeWidth={2}
          points={values
            .map((v, i) => `${PAD.l + band * (i + 0.5)},${sy(v)}`)
            .join(" ")}
        />
      ) : (
        values.map((v, i) => {
          const bh = Math.abs(sy(v) - sy(0));
          const by = v >= 0 ? sy(v) : sy(0);
          return (
            <rect
              key={i}
              x={PAD.l + band * i + band * 0.12}
              y={by}
              width={band * 0.76}
              height={Math.max(1, bh)}
              fill="#54b949"
              opacity={0.92}
            >
              <title>
                {labels[i]}: {v}
              </title>
            </rect>
          );
        })
      )}
      {isLine &&
        values.map((v, i) => (
          <circle
            key={i}
            cx={PAD.l + band * (i + 0.5)}
            cy={sy(v)}
            r={3}
            fill="#6ed061"
          />
        ))}
      {/* x labels (thinned to avoid overlap) */}
      {labels.map((lb, i) => {
        const step = Math.ceil(labels.length / 18);
        if (i % step !== 0) return null;
        const cx = PAD.l + band * (i + 0.5);
        return (
          <text
            key={i}
            x={cx}
            y={PAD.t + plotH + 16}
            fontSize={10}
            fill="#9aa3b2"
            textAnchor="end"
            transform={`rotate(-40 ${cx} ${PAD.t + plotH + 16})`}
          >
            {String(lb).slice(0, 18)}
          </text>
        );
      })}
    </svg>
  );
};

const Axes: React.FC<{
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  plotW: number;
  plotH: number;
  xlabel: string;
  ylabel: string;
  hideXTicks?: boolean;
}> = ({ ymin, ymax, plotH, plotW, xlabel, ylabel, hideXTicks, xmin, xmax }) => {
  const ticks = 5;
  const yvals = Array.from(
    { length: ticks + 1 },
    (_, i) => ymin + ((ymax - ymin) * i) / ticks,
  );
  return (
    <g>
      {yvals.map((v, i) => {
        const yy = PAD.t + plotH - (plotH * i) / ticks;
        return (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={PAD.l + plotW}
              y1={yy}
              y2={yy}
              stroke="#23272f"
            />
            <text
              x={PAD.l - 8}
              y={yy + 3}
              fontSize={10}
              fill="#6b7480"
              textAnchor="end"
            >
              {Math.abs(v) >= 1000
                ? v.toExponential(1)
                : Number(v.toFixed(2)).toString()}
            </text>
          </g>
        );
      })}
      <text
        x={PAD.l - 46}
        y={PAD.t + plotH / 2}
        fontSize={11}
        fill="#9aa3b2"
        textAnchor="middle"
        transform={`rotate(-90 ${PAD.l - 46} ${PAD.t + plotH / 2})`}
      >
        {ylabel}
      </text>
      <text
        x={PAD.l + plotW / 2}
        y={H - 10}
        fontSize={11}
        fill="#9aa3b2"
        textAnchor="middle"
      >
        {xlabel}
      </text>
      {!hideXTicks && (
        <>
          <text x={PAD.l} y={PAD.t + plotH + 16} fontSize={10} fill="#6b7480">
            {Number(xmin.toFixed(2))}
          </text>
          <text
            x={PAD.l + plotW}
            y={PAD.t + plotH + 16}
            fontSize={10}
            fill="#6b7480"
            textAnchor="end"
          >
            {Number(xmax.toFixed(2))}
          </text>
        </>
      )}
    </g>
  );
};

// Re-render only when the result or its columns/types actually change; the parent
// recreates the columns array and the onExpired callback each render, so we
// compare columns by value and ignore the callback identity.
function sameStrArr(a: string[] = [], b: string[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sameTypeMap(
  a?: Record<string, string> | null,
  b?: Record<string, string> | null,
): boolean {
  if (a === b) return true;
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) if ((a as any)[k] !== (b as any)[k]) return false;
  return true;
}
export const ChartPanel = React.memo(
  ChartPanelImpl,
  (a, b) =>
    a.resultId === b.resultId &&
    sameStrArr(a.columns, b.columns) &&
    sameTypeMap(a.columnTypes, b.columnTypes) &&
    a.sampleRows === b.sampleRows,
);
