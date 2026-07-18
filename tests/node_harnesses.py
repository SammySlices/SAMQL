# Generated from the monolithic runner; kept as data-only test fixtures.

_RECON_MAPPING_HARNESS = r"""
import {
  resolveReconFields, colmapsFor, mappingTemplateCsv, parseMappingCsv,
} from "./reconMapping.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// 1. No mapping, identical names: all common, bare labels, identity colmaps.
let f = resolveReconFields(["id", "name", "amt"], ["id", "name", "amt"], null);
eq(f.map((x) => x.value), ["id", "name", "amt"], "identical values");
eq(f.map((x) => x.label), ["id", "name", "amt"], "bare labels when unchanged");
let cm = colmapsFor(f);
eq(cm.colmapA, { id: "id", name: "name", amt: "amt" }, "identity colmapA");
eq(cm.colmapB, { id: "id", name: "name", amt: "amt" }, "identity colmapB");

// 2. Case/whitespace-insensitive lining-up with no file; A name is canonical.
f = resolveReconFields(["Acct", "FeedCode "], ["acct", " feedcode"], null);
eq(f.map((x) => x.value), ["Acct", "FeedCode "], "A canonical preserved");
assert(f[0].label.includes("Acct") && f[0].label.includes("acct"),
  "label shows both originals when they differ only by case");
eq(f[0].aCol, "Acct", "aCol is A real column");
eq(f[0].bCol, "acct", "bCol is B real column");

// 3. Mapping renames both sides onto one canonical name.
let m = parseMappingCsv(
  "Table A field,Table A rename,Table B field,Table B rename\na1,k,b1,k\n",
  "m.csv");
eq(m.renameA, { a1: "k" }, "renameA parsed");
eq(m.renameB, { b1: "k" }, "renameB parsed");
f = resolveReconFields(["a1", "x"], ["b1", "y"], m);
eq(f.map((x) => x.value), ["k"], "only the mapped field lines up");
eq(f[0].label, "k (A: a1 / B: b1)", "composite label");
eq(f[0].aCol, "a1", "mapped aCol");
eq(f[0].bCol, "b1", "mapped bCol");
cm = colmapsFor(f);
eq(cm.colmapA, { k: "a1" }, "mapped colmapA");
eq(cm.colmapB, { k: "b1" }, "mapped colmapB");

// 4. Asymmetric: only B is renamed; A already carries the canonical name.
let m2 = parseMappingCsv(
  "Table A field,Table A rename,Table B field,Table B rename\n,,b1,k\n",
  "m2.csv");
eq(m2.renameA, {}, "asymmetric: A has no renames");
f = resolveReconFields(["k"], ["b1"], m2);
eq(f.map((x) => x.value), ["k"], "asymmetric still lines up");
eq(f[0].label, "k (A: k / B: b1)", "asymmetric label");

// 5. Not 1:1: an A-only column with no B match is dropped from the compare.
f = resolveReconFields(["id", "onlyA"], ["id"], null);
eq(f.map((x) => x.value), ["id"], "unmatched A column dropped");

// 6. Template CSV: BOM, header, one row per max(len), A/B aligned by index.
let csv = mappingTemplateCsv(["a", "b", "c"], ["x"]);
assert(csv.charCodeAt(0) === 0xFEFF, "template has a BOM");
assert(csv.includes(
  "Table A field,Table A rename,Table B field,Table B rename"),
  "template header");
let lines = csv.replace(/^\uFEFF/, "").trim().split(/\r\n/);
eq(lines.length, 4, "header + 3 rows");
assert(lines[1].startsWith("a,,x,"), "row 0 aligns A0/B0 with empty renames");
assert(lines[3].startsWith("c,,,"), "row 2 has an empty B side");

// 7. Parse skips the header and handles quoted cells with embedded commas.
let m3 = parseMappingCsv(
  "Table A field,Table A rename,Table B field,Table B rename\n" +
  '"a,1","k 1",b1,k1\n', "q.csv");
eq(m3.renameA, { "a,1": "k 1" }, "quoted field + rename with comma/space");
eq(m3.renameB, { b1: "k1" }, "B rename parsed alongside quoted A");

// 8. A column present on only one side (no mapping) is not comparable.
let g = resolveReconFields(["id", "extra"], ["id", "other"], null);
eq(g.map((x) => x.value), ["id"], "only the common column lines up");
let gcm = colmapsFor(g);
eq(gcm.colmapA, { id: "id" }, "colmapA has only the common field");
eq(gcm.colmapB, { id: "id" }, "colmapB has only the common field");

// 9. Disjoint columns with no mapping -> nothing to reconcile.
eq(resolveReconFields(["a", "b"], ["c", "d"], null).length, 0,
  "disjoint columns -> no comparable fields");

// 10. Mapping that lines up A1<->B but A already has a same-named column:
//     first (canonical) wins, no duplicate field.
let m4 = parseMappingCsv(
  "Table A field,Table A rename,Table B field,Table B rename\namount,bal,balance,bal\n",
  "m4.csv");
let h = resolveReconFields(["amount"], ["balance"], m4);
eq(h.map((x) => x.value), ["bal"], "mapped pair lines up under canonical name");
eq(h[0].aCol, "amount", "mapped aCol");
eq(h[0].bCol, "balance", "mapped bCol");

console.log("OK");
"""

_CHART_OPTION_HARNESS = r"""
import { buildChartOption, paletteColors } from "./chartOption.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }

const cat = (extra) => ({ chart_type: "bar", x: "r", labels: ["a", "b"],
  series: [{ name: "v", values: [1, 2] }], ...extra });

// 1. Default-safe: no style reproduces the original bar option.
let o = buildChartOption(cat({}));
assert(JSON.stringify(o.color) === JSON.stringify(paletteColors("samql")), "default palette = samql");
assert(o.series[0].type === "bar", "bar -> bar series");
assert(o.series[0].smooth === false, "bar not smoothed");
assert(o.xAxis.type === "category" && o.yAxis.type === "value", "bar axes");
assert(o.legend === undefined, "single-series bar has no legend by default");
assert(o.title === undefined, "no title by default");
assert(o.backgroundColor === "transparent", "dark theme bg transparent");

// 2. Line defaults to smooth.
o = buildChartOption({ ...cat({}), chart_type: "line" });
assert(o.series[0].type === "line" && o.series[0].smooth === true, "line smoothed by default");

// 3. Area = line + areaStyle.
o = buildChartOption({ ...cat({}), chart_type: "area" });
assert(o.series[0].type === "line" && !!o.series[0].areaStyle, "area has areaStyle");

// 4. Pie vs donut radius.
const pieData = { chart_type: "pie", x: "r", labels: ["a", "b"], series: [{ name: "v", values: [1, 2] }] };
o = buildChartOption(pieData);
assert(o.series[0].type === "pie" && o.series[0].radius[0] === "0%", "pie solid");
o = buildChartOption({ ...pieData, chart_type: "donut" });
assert(o.series[0].type === "pie" && o.series[0].radius[0] !== "0%", "donut has inner radius");

// 5. Horizontal bar swaps axis types.
o = buildChartOption(cat({ style: { horizontal: true } }));
assert(o.xAxis.type === "value" && o.yAxis.type === "category", "horizontal swaps axes");

// 6. Stacked multi-series.
o = buildChartOption({ chart_type: "bar", x: "r", labels: ["a", "b"],
  series: [{ name: "s1", values: [1, 2] }, { name: "s2", values: [3, 4] }],
  style: { stacked: true } });
assert(o.series[0].stack === "total" && o.series[1].stack === "total", "both series stacked");
assert(o.legend !== undefined, "multi-series shows legend by default");

// 7. Smooth toggle off on a line.
o = buildChartOption({ ...cat({}), chart_type: "line", style: { smooth: false } });
assert(o.series[0].smooth === false, "smooth=false honoured");

// 8. Palette + theme.
o = buildChartOption(cat({ style: { palette: "vivid", theme: "light" } }));
assert(o.color[0] === paletteColors("vivid")[0], "vivid palette applied");
assert(o.backgroundColor === "#ffffff", "light theme bg white");

// 9. Legend + grid toggles.
o = buildChartOption(cat({ style: { showLegend: true } }));
assert(o.legend !== undefined, "legend forced on");
o = buildChartOption(cat({ style: { showGrid: false } }));
assert(o.yAxis.splitLine.show === false, "gridlines hidden");

// 10. Axis labels become axis names.
o = buildChartOption(cat({ style: { xLabel: "Region", yLabel: "Total" } }));
assert(o.xAxis.name === "Region" && o.yAxis.name === "Total", "axis labels applied");

// 11. Title.
o = buildChartOption(cat({ style: { title: "My Chart" } }));
assert(o.title && o.title.text === "My Chart", "title applied");

// 12. Per-series colour override (bar) + per-slice override (pie).
o = buildChartOption(cat({ style: { seriesColors: { v: "#123456" } } }));
assert(o.series[0].itemStyle.color === "#123456", "series colour override");
o = buildChartOption({ ...pieData, style: { seriesColors: { a: "#abcdef" } } });
assert(o.series[0].data[0].itemStyle && o.series[0].data[0].itemStyle.color === "#abcdef", "pie slice colour override");

// 13. Pie with a pad angle gets padAngle + a slice border to read the gap.
o = buildChartOption({ ...pieData, style: { padAngle: 4 } });
assert(o.series[0].padAngle === 4, "pie padAngle applied");
assert(o.series[0].itemStyle && o.series[0].itemStyle.borderWidth >= 1, "pad angle adds a slice border");
assert(buildChartOption(pieData).series[0].padAngle === undefined, "no padAngle by default");

// 14. Customized (rose / nightingale) pie.
o = buildChartOption({ ...pieData, style: { roseType: true } });
assert(o.series[0].roseType === "radius", "rose pie sets roseType=radius");
assert(o.series[0].label && /\{d\}/.test(o.series[0].label.formatter || ""), "rose pie shows a percent label");

// 15. Treemap from labels+values; gradient adds a value visualMap.
const tmData = { chart_type: "treemap", x: "r", labels: ["a", "b", "c"], series: [{ name: "v", values: [3, 1, 2] }] };
o = buildChartOption(tmData);
assert(o.series[0].type === "treemap", "treemap series");
assert(o.series[0].data.length === 3 && o.series[0].data[0].value === 3, "treemap leaves carry values");
assert(o.visualMap === undefined, "no visualMap without gradient");
o = buildChartOption({ ...tmData, style: { gradient: true } });
assert(o.visualMap && o.visualMap.max === 3 && o.visualMap.min === 1, "gradient sets value visualMap range");

// 16. Candlestick: OHLC series + auto / explicit zoom.
const ohlc = []; for (let i = 0; i < 5; i++) ohlc.push([10, 12, 9, 14]);
const ckData = { chart_type: "candlestick", x: "d", labels: ["a","b","c","d","e"], series: [{ name: "px", ohlc }] };
o = buildChartOption(ckData);
assert(o.series[0].type === "candlestick", "candlestick series");
assert(o.series[0].data === ohlc, "candlestick uses the ohlc tuples");
assert(o.xAxis.type === "category" && o.yAxis.scale === true, "candlestick value axis scales");
assert(o.dataZoom === undefined, "no zoom for a small candlestick");
o = buildChartOption({ ...ckData, style: { dataZoom: true } });
assert(Array.isArray(o.dataZoom) && o.dataZoom.length === 2, "explicit dataZoom adds inside+slider");
// large-scale candlestick auto-enables zoom
const big = []; for (let i = 0; i < 250; i++) big.push([1, 2, 0, 3]);
o = buildChartOption({ chart_type: "candlestick", x: "d", labels: big.map((_, i) => String(i)), series: [{ name: "p", ohlc: big }] });
assert(Array.isArray(o.dataZoom), ">200 bars auto-enables a zoom slider");

// 17. Stacked line / area + a category dataZoom for large series.
o = buildChartOption({ chart_type: "line", x: "r", labels: ["a", "b"],
  series: [{ name: "s1", values: [1, 2] }, { name: "s2", values: [3, 4] }],
  style: { stacked: true } });
assert(o.series[0].type === "line" && o.series[0].stack === "total", "stacked line stacks");
o = buildChartOption({ chart_type: "area", x: "r", labels: ["a", "b"],
  series: [{ name: "s1", values: [1, 2] }, { name: "s2", values: [3, 4] }],
  style: { stacked: true } });
assert(o.series[0].type === "line" && !!o.series[0].areaStyle && o.series[0].stack === "total", "stacked area stacks + fills");
o = buildChartOption(cat({ style: { dataZoom: true } }));
assert(Array.isArray(o.dataZoom) && o.dataZoom.length === 2, "category chart honours dataZoom");

// 18. Multiple x axes: two category x-axes (bottom + top), each series bound.
const mx = { chart_type: "multix", x: "d", labels: ["a", "b"], labels2: ["p", "q", "r"],
  series: [{ name: "s1", values: [1, 2], xAxisIndex: 0 }, { name: "s2", values: [3, 4, 5], xAxisIndex: 1 }] };
o = buildChartOption(mx);
assert(Array.isArray(o.xAxis) && o.xAxis.length === 2, "multix has two x-axes");
assert(o.xAxis[0].position === "bottom" && o.xAxis[1].position === "top", "axes on bottom + top");
assert(JSON.stringify(o.xAxis[1].data) === JSON.stringify(["p", "q", "r"]), "second axis uses labels2");
assert(o.series[0].xAxisIndex === 0 && o.series[1].xAxisIndex === 1, "series bound to their axes");
assert(o.series.every((s) => s.type === "line"), "multix series render as lines");
assert(o.series[0].itemStyle.color !== o.series[1].itemStyle.color, "two series get distinct colours");

// 19. Multiple y axes: shared category x, two y-axes (left + right),
// metric 1 = bars, metric 2 = line, each bound to its own axis.
const my = { chart_type: "multiy", x: "r", labels: ["a", "b"],
  series: [{ name: "sales", values: [3, 4], yAxisIndex: 0 },
           { name: "units", values: [1, 2], yAxisIndex: 1 }] };
o = buildChartOption(my);
assert(Array.isArray(o.yAxis) && o.yAxis.length === 2, "multiy has two y-axes");
assert(o.yAxis[0].position === "left" && o.yAxis[1].position === "right", "y-axes left + right");
assert(o.xAxis.type === "category", "multiy shares one category x-axis");
assert(o.series[0].type === "bar" && o.series[1].type === "line", "multiy: bars + line");
assert(o.series[0].yAxisIndex === 0 && o.series[1].yAxisIndex === 1, "series bound to their y-axes");
assert(o.series[0].itemStyle.color !== o.series[1].itemStyle.color, "multiy series distinct colours");

// 20. Tree: hierarchy from a series split (root -> series -> leaves) with a
// value gradient on nodes; single-series collapses to root -> leaves.
const tr = buildChartOption({ chart_type: "tree", x: "p", labels: ["a", "b"],
  series: [{ name: "N", values: [10, 20] }, { name: "S", values: [7, 30] }],
  style: { gradient: true } });
assert(tr.series[0].type === "tree", "tree series type");
const troot = tr.series[0].data[0];
assert(troot.children.length === 2, "tree root has one branch per series");
assert(troot.children[0].children.length === 2, "each branch has one leaf per label");
assert(!!troot.children[0].children[0].itemStyle.color, "tree leaf coloured on gradient");
assert(troot.children[0].value === 30, "tree branch value = sum of its leaves");
const trNoGrad = buildChartOption({ chart_type: "tree", x: "p", labels: ["a"],
  series: [{ name: "v", values: [5] }], style: { gradient: false } });
assert(!trNoGrad.series[0].data[0].children[0].itemStyle, "no node colour when gradient off");
assert(trNoGrad.series[0].data[0].children.length === 1, "single-series tree: root -> leaves");

// 21. Rounded bars: a single/grouped bar rounds its top; in a stack only the
// top (last) series is rounded so the column reads as one rounded bar.
o = buildChartOption(cat({ style: { rounded: true } }));
assert(JSON.stringify(o.series[0].itemStyle.borderRadius) === JSON.stringify([6, 6, 0, 0]), "single bar rounds the top");
o = buildChartOption({ chart_type: "bar", x: "r", labels: ["a", "b"],
  series: [{ name: "s1", values: [1, 2] }, { name: "s2", values: [3, 4] }],
  style: { stacked: true, rounded: true } });
assert(o.series[0].itemStyle.borderRadius === undefined, "stacked: lower segment not rounded");
assert(JSON.stringify(o.series[1].itemStyle.borderRadius) === JSON.stringify([6, 6, 0, 0]), "stacked: only the top segment is rounded");
o = buildChartOption(cat({ style: { rounded: true, horizontal: true } }));
assert(JSON.stringify(o.series[0].itemStyle.borderRadius) === JSON.stringify([0, 6, 6, 0]), "horizontal bar rounds its right end");

// 22. Large-scale line / area: LTTB downsampling for very long series.
o = buildChartOption({ ...cat({}), chart_type: "line", style: { large: true } });
assert(o.series[0].sampling === "lttb", "large line downsamples (lttb)");
o = buildChartOption({ ...cat({}), chart_type: "area", style: { large: true } });
assert(o.series[0].sampling === "lttb" && !!o.series[0].areaStyle, "large area downsamples + fills");
assert(buildChartOption({ ...cat({}), chart_type: "line" }).series[0].sampling === undefined, "no sampling unless large");

// 23. Scatter: points become [x,y] tuples on two value axes.
o = buildChartOption({ chart_type: "scatter", x: "a", y: "b",
  series: [{ name: "b vs a", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] });
assert(o.series[0].type === "scatter", "scatter series type");
assert(JSON.stringify(o.series[0].data) === JSON.stringify([[1, 2], [3, 4]]), "scatter points -> [x,y] tuples");
assert(o.xAxis.type === "value" && o.yAxis.type === "value", "scatter has two value axes");
o = buildChartOption({ chart_type: "scatter", x: "a", y: "b",
  series: [{ name: "b vs a", points: [{ x: 1, y: 2 }] }],
  style: { xLabel: "A", yLabel: "B" } });
assert(o.xAxis.name === "A" && o.yAxis.name === "B", "scatter axis labels applied");

// 24. Histogram: bins are a category x-axis with bar counts (no dedicated
// branch -- it intentionally renders through the bar path).
o = buildChartOption({ chart_type: "histogram", x: "a",
  labels: ["0-1", "1-2", "2-3"], series: [{ name: "a", values: [3, 5, 2] }] });
assert(o.series[0].type === "bar", "histogram renders as bars");
assert(o.xAxis.type === "category" && o.yAxis.type === "value", "histogram: category bins, value counts");
assert(JSON.stringify(o.series[0].data) === JSON.stringify([3, 5, 2]), "histogram bar heights = bin counts");

// 25. Delta: consecutive absolute and percentage changes, including sign.
o = buildChartOption({ chart_type: "delta", x: "day", labels: ["d1", "d2", "d3"],
  series: [{ name: "value", values: [10, 15, 12] }] });
assert(o.series[0].type === "bar", "delta renders as signed bars");
assert(JSON.stringify(o.series[0].data.map((d) => d.value)) === JSON.stringify([0, 5, -3]), "delta computes consecutive changes");
assert(o.series[0].data[1].itemStyle.color !== o.series[0].data[2].itemStyle.color, "delta signs use distinct colours");
o = buildChartOption({ chart_type: "delta", x: "day", labels: ["d1", "d2", "d3"],
  series: [{ name: "value", values: [10, 15, 12] }], style: { deltaMode: "percent" } });
assert(JSON.stringify(o.series[0].data.map((d) => d.value)) === JSON.stringify([0, 50, -20]), "delta percent mode correct");

// 26. Waterfall: transparent bases plus signed movements reconstruct levels.
o = buildChartOption({ chart_type: "waterfall", x: "day", labels: ["d1", "d2", "d3"],
  series: [{ name: "value", values: [10, 15, 12] }] });
assert(o.series.length === 2 && o.series[0].stack === "waterfall", "waterfall uses base + movement stack");
assert(JSON.stringify(o.series[0].data) === JSON.stringify([0, 10, 12]), "waterfall bases position movements");
assert(JSON.stringify(o.series[1].data.map((d) => d.value)) === JSON.stringify([10, 5, 3]), "waterfall movement magnitudes correct");

console.log("OK");
"""

_RECON_EXPORT_HARNESS = r"""
import { reconReportCsv, reconCsvFilename } from "./reconExport.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }

const withBal = {
  keys: ["acct"], engine: "sqlite", balance_field: "bal",
  totals: { a_only: 2, b_only: 1, matching: 5, non_matching: 3, total: 11 },
  fields: [
    { field: "status", label: "Status, x", a_only: 2, b_only: 1, non_matching: 3, matching: 5, sum_matching_balance: 1234.5, sum_non_matching_balance: -10 },
    { field: "ccy", a_only: 0, b_only: 0, non_matching: 1, matching: 7, sum_matching_balance: null, sum_non_matching_balance: null },
  ],
};
const csv = reconReportCsv(withBal, { left: "Loans A", right: "Loans/B" });
const lines = csv.split("\n");
assert(lines[0] === "Reconcile report", "title line");
assert(lines.includes("Left,Loans A"), "left metadata");
assert(lines.includes("Right,Loans/B"), "right metadata");
assert(lines.includes("Keys,acct"), "keys metadata");
assert(lines.includes("Engine,sqlite"), "engine metadata");
assert(lines.includes("Balance field,bal"), "balance metadata");
const head = lines.find(l => l.startsWith("Field,"));
assert(head === "Field,A only,B only,Not matching,Matching,Sum matching balance,Sum non-matching balance", "header with balance cols: " + head);
assert(lines.includes('"Status, x",2,1,3,5,1234.5,-10'), "field row: comma-label quoted, balances kept");
assert(lines.includes("ccy,0,0,1,7,,"), "null balances render blank");
assert(lines.includes("Total,2,1,3,5,,"), "total row uses report totals");

// without a balance field there are no balance columns anywhere
const noBal = {
  keys: ["id"], totals: { a_only: 1, b_only: 0, matching: 4, non_matching: 0, total: 5 },
  fields: [{ field: "name", a_only: 1, b_only: 0, non_matching: 0, matching: 4, sum_matching_balance: null, sum_non_matching_balance: null }],
};
const csv2 = reconReportCsv(noBal, { left: "A", right: "B" });
assert(csv2.indexOf("balance") === -1, "no balance column without a balance field");
assert(csv2.split("\n").find(l => l.startsWith("Field,")) === "Field,A only,B only,Not matching,Matching", "header omits balance cols");
assert(csv2.indexOf("Engine") === -1, "engine omitted when absent");

assert(reconCsvFilename({ left: "Loans A", right: "Loans/B" }) === "recon_Loans_A_vs_Loans_B.csv", "filename sanitised");

console.log("OK");
"""

_PROFILE_EXPORT_HARNESS = r"""
import { profileCsv, profileCsvFilename } from "./profileExport.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }

const prof = {
  table: "Loans/2026 Q1",
  total_rows: 1000,
  columns: [
    { column: "acct", type: "string", raw_type: "VARCHAR", date_fmt: null,
      nulls: 0, null_pct: 0, distinct: 1000, distinct_pct: 100,
      min: "A0001", max: "Z9999", mean: null, std: null, outliers: null,
      top_values: null },
    { column: "bal, usd", type: "number", raw_type: "DOUBLE", date_fmt: null,
      nulls: 3, null_pct: 0.3, distinct: 950, distinct_pct: 95,
      min: -10.5, max: 1234.5, mean: 500.25, std: 12.5, outliers: 4,
      top_values: [{ value: 0, count: 3, pct: 0.3 }] },
  ],
};
const csv = profileCsv(prof);
const lines = csv.split("\n");
assert(lines[0] === "Profile report", "title line");
assert(lines.includes("Table,Loans/2026 Q1"), "table metadata: " + lines[1]);
assert(lines.includes("Total rows,1000"), "row-count metadata");
const head = lines.find(l => l.startsWith("Column,"));
assert(head === "Column,Type,Raw type,Date format,Nulls,Null %,Distinct,Distinct %,Min,Max,Mean,Std,Outliers", "header: " + head);
assert(lines.includes("acct,string,VARCHAR,,0,0,1000,100,A0001,Z9999,,,"), "string col: null stats blank");
assert(lines.includes('"bal, usd",number,DOUBLE,,3,0.3,950,95,-10.5,1234.5,500.25,12.5,4'), "number col: comma-name quoted, stats kept");

assert(profileCsvFilename("Loans/2026 Q1") === "profile_Loans_2026_Q1.csv", "filename sanitise: " + profileCsvFilename("Loans/2026 Q1"));
assert(profileCsvFilename("") === "profile_profile.csv", "empty name -> default: " + profileCsvFilename(""));

console.log("OK");
"""

_SELECT_FIELDS_HARNESS = r"""
import { reconcileSelectFields, fieldsDiffer, filterSelectFields, sortSelectFields, setFieldsKept, listWiredSelectUpstreams, applySelectColumnsReconcile, collectSelectFieldPatches } from "./selectFields.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// 1. Empty field list seeds from upstream, all kept.
eq(reconcileSelectFields(["a", "b"], []),
   [{ name: "a", keep: true }, { name: "b", keep: true }],
   "seed from upstream");

// 2. Upstream rename (foo -> bar) propagates: foo dropped, bar added kept,
//    baz preserved. THIS is the reported bug. (bar appends at the end now that
//    surviving columns keep their order.)
eq(reconcileSelectFields(["bar", "baz"],
     [{ name: "foo", keep: true }, { name: "baz", keep: true }]),
   [{ name: "baz", keep: true }, { name: "bar", keep: true }],
   "renamed upstream column propagates downstream");

// 3. Per-field settings (keep / rename / type) survive for columns that remain.
eq(reconcileSelectFields(["a", "b"],
     [{ name: "a", keep: false, rename: "x", type: "integer" }, { name: "b", keep: true }]),
   [{ name: "a", keep: false, rename: "x", type: "integer" }, { name: "b", keep: true }],
   "settings preserved for surviving columns");

// 4. A new upstream column (e.g. a formula's new column) is added at the end, kept.
eq(reconcileSelectFields(["a", "b", "x"],
     [{ name: "a", keep: true }, { name: "b", keep: false }]),
   [{ name: "a", keep: true }, { name: "b", keep: false }, { name: "x", keep: true }],
   "new formula column appears downstream");

// 5. A column that no longer exists upstream is dropped.
eq(reconcileSelectFields(["a"],
     [{ name: "a", keep: true }, { name: "gone", keep: true }]),
   [{ name: "a", keep: true }],
   "removed upstream column drops out");

// 6. Order follows the user's field list, NOT upstream -- so a drag-reorder
//    survives a column refresh.
eq(reconcileSelectFields(["b", "a"], [{ name: "a", keep: true }, { name: "b", keep: true }]).map(f => f.name),
   ["a", "b"], "surviving columns keep the user's order");

// 6b. A new column appends at the end even when upstream lists it first, so the
//     reorder is never disturbed by an arriving column.
eq(reconcileSelectFields(["x", "b", "a"],
     [{ name: "a", keep: true }, { name: "b", keep: true }]).map(f => f.name),
   ["a", "b", "x"], "new column appends last, user order intact");

// 7. fieldsDiffer guard.
assert(fieldsDiffer([{ name: "a" }], [{ name: "a" }]) === false, "same -> no diff");
assert(fieldsDiffer([{ name: "a" }], [{ name: "b" }]) === true, "rename -> diff");
assert(fieldsDiffer([{ name: "a" }], [{ name: "a" }, { name: "b" }]) === true, "length -> diff");
assert(fieldsDiffer([{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "a" }]) === true, "reorder -> diff");

// 8. Inspector search filters by name and rename.
const sample = [
  { name: "amount", keep: true },
  { name: "region", keep: true, rename: "geo_area" },
  { name: "id", keep: false },
];
eq(filterSelectFields(sample, "").map(f => f.name), ["amount", "region", "id"],
  "empty search keeps all");
eq(filterSelectFields(sample, "am").map(f => f.name), ["amount"],
  "substring match on name");
eq(filterSelectFields(sample, "GEO").map(f => f.name), ["region"],
  "case-insensitive match on rename");
eq(filterSelectFields(sample, "zzz").map(f => f.name), [],
  "no match -> empty");

// 9. Sort A-Z / Z-A by field name; settings travel with the field.
eq(sortSelectFields(sample, "asc").map(f => f.name), ["amount", "id", "region"],
  "sort asc");
eq(sortSelectFields(sample, "desc").map(f => f.name), ["region", "id", "amount"],
  "sort desc");
eq(sortSelectFields(sample, "asc")[2].rename, "geo_area",
  "sort preserves rename/keep");

// 10. All/None while filtered only touches the visible names.
eq(setFieldsKept(sample, false, ["amount", "id"]).map(f => f.keep),
  [false, true, false], "filtered None leaves region alone");
eq(setFieldsKept(sample, true).map(f => f.keep),
  [true, true, true], "unfiltered All keeps every field");

// 11. Changing an Input table must refresh wired Select fields even when the
//     Select is not selected (graph-wide reconcile helpers).
eq(listWiredSelectUpstreams(
     [{ id: "in1", type: "input" }, { id: "sel", type: "select" },
      { id: "orphan", type: "select" }],
     [{ to: { node: "sel", port: "in" }, from: { node: "in1", port: "out" } }]),
   [{ selectId: "sel", kind: "canvas", upstreamNode: "in1", upstreamPort: "out" }],
   "only wired Selects are listed");

const stale = [{
  id: "sel", type: "select",
  config: { fields: [{ name: "order_id", keep: true }, { name: "amount", keep: false }] },
}];
const refreshed = applySelectColumnsReconcile(stale, {
  sel: ["customer_id", "name"],
});
eq(refreshed[0].config.fields,
   [{ name: "amount", keep: false },
    { name: "customer_id", keep: true }, { name: "name", keep: true }],
   "Input table change retains unchecked tombstones while refreshing Select fields");
assert(applySelectColumnsReconcile(refreshed, {
  sel: ["customer_id", "name"],
}) === refreshed, "no-op when fields already match");

// 12. Nested Selects inside a group (bound first step + step-above).
eq(listWiredSelectUpstreams(
     [{ id: "in1", type: "input" },
      { id: "g", type: "group", config: {
          children: [
            { id: "sel1", type: "select", config: { fields: [] } },
            { id: "sel2", type: "select", config: { fields: [] } },
          ],
          bindings: {},
        }}],
     [{ to: { node: "g", port: "in" }, from: { node: "in1", port: "out" } }]),
   [{ selectId: "sel1", kind: "group-input", upstreamNode: "in1",
      upstreamPort: "out", groupId: "g", groupPort: "in" },
    { selectId: "sel2", kind: "step-above", groupId: "g", childIndex: 1 }],
   "group Selects are discovered for graph-wide sync");

const nestedBefore = [{
  id: "g", type: "group",
  config: { children: [{
    id: "nested", type: "select",
    config: { fields: [{ name: "old", keep: true }] },
  }] },
}];
const nestedAfter = applySelectColumnsReconcile(nestedBefore, {
  nested: ["a", "b"],
});
eq(nestedAfter[0].config.children[0].config.fields,
   [{ name: "a", keep: true }, { name: "b", keep: true }],
   "nested Select fields reconcile inside group.children");
eq(collectSelectFieldPatches(nestedBefore, nestedAfter),
   [{ id: "nested", fields: [
      { name: "a", keep: true }, { name: "b", keep: true }] }],
   "collectSelectFieldPatches surfaces nested Select ids for patch()");

console.log("OK");
"""

_COMMENT_HARNESS = r"""
import { toggleLineComment } from "./sql.mjs";
function eq(a, b, m) { if (a !== b) { console.error(m + ": " + JSON.stringify(a)); process.exit(1); } }
// comment two lines
let r = toggleLineComment("select 1\nfrom t", 0, 15);
eq(r.text, "-- select 1\n-- from t", "comment");
// toggle straight back
let r2 = toggleLineComment(r.text, r.selStart, r.selEnd);
eq(r2.text, "select 1\nfrom t", "uncomment");
// mixed block -> everything gains a marker
eq(toggleLineComment("-- a\nb", 0, 6).text, "-- -- a\n-- b", "mixed");
// blank lines skipped and never block an uncomment
eq(toggleLineComment("-- a\n\n-- b", 0, 11).text, "a\n\nb", "blanks");
// a bare caret toggles just its line, indentation kept
eq(toggleLineComment("  x = 1", 3, 3).text, "  -- x = 1", "caret");
// selection ending at column 0 excludes that line
eq(toggleLineComment("a\nb\n", 0, 2).text, "-- a\nb\n", "col0-end");
console.log("OK");
"""

_NOTEBOOK_HARNESS = r"""
import { composeChainedSql, referencedNames, nextCellName, serializeNotebook, parseNotebookFile, upsertMeta, removeMeta, uniqueNbName, sanitizeRecon, sanitizeCellName, uniqueCellName, renameInSql, cellIsFresh, reorderByGroups, lastSqlCellByGroup, planChainReuse, buildJournalDependencyGraph, planJournalRunAll, journalGraphCsv, groupRelationalFamilies, familyJoinKeys, familyJoinSql } from "./notebook.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// 1. No earlier cells -> unchanged.
eq(composeChainedSql("SELECT 1;", []), "SELECT 1;", "no earlier cells");

// 2. Simple chain wraps the referenced cell as a CTE.
let out = composeChainedSql("SELECT * FROM cell1 WHERE n > 0", [
  { name: "cell1", sql: "SELECT a, COUNT(*) AS n FROM t GROUP BY a" },
]);
assert(out.startsWith("WITH cell1 AS ("), "simple chain WITH prefix");
assert(out.includes("SELECT a, COUNT(*) AS n FROM t GROUP BY a"), "cell1 body inlined");
assert(out.includes("SELECT * FROM cell1 WHERE n > 0"), "target preserved");

// 3. Transitive deps emitted in dependency order (cell1 before cell2).
out = composeChainedSql("SELECT * FROM cell2", [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT a FROM cell1" },
]);
assert(out.indexOf("cell1 AS (") < out.indexOf("cell2 AS ("), "deps ordered (post-order)");

// 4. Only referenced cells are included.
out = composeChainedSql("SELECT * FROM cell1", [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT 2 AS b" },
]);
assert(out.includes("cell1 AS ("), "referenced cell included");
assert(!out.includes("cell2 AS ("), "unreferenced cell excluded");

// 5. References inside comments / strings don't count.
eq(
  referencedNames("-- cell1\nSELECT 'cell2' AS x FROM cell3", ["cell1", "cell2", "cell3"]),
  ["cell3"],
  "ignore comment + string refs",
);

// 6. Qualified columns and substrings don't count as references.
eq(referencedNames("SELECT t.cell1 FROM t", ["cell1"]), [], "qualified col not a ref");
eq(referencedNames("SELECT mycell1, cell10 FROM cell1", ["cell1"]), ["cell1"], "substring not a ref");

// 7. A leading WITH on the target is merged, not duplicated.
out = composeChainedSql(
  "WITH x AS (SELECT 1) SELECT * FROM x JOIN cell1 USING (a)",
  [{ name: "cell1", sql: "SELECT a FROM t" }],
);
assert(out.startsWith("WITH cell1 AS ("), "merged WITH keeps single WITH");
assert(out.includes("x AS (SELECT 1)"), "user CTE preserved");
assert(!out.includes("WITH x AS"), "user WITH keyword removed");

// 7b. A quoted, spaced name (a group-output alias) is detected and inlined as a
// quoted CTE, so a later group can pull an earlier group's output by name.
eq(
  referencedNames('SELECT * FROM "Group 1"', ["Group 1"]),
  ["Group 1"],
  "quoted spaced name detected as a reference",
);
out = composeChainedSql('SELECT * FROM "Group 1" WHERE a > 0', [
  { name: "Group 1", sql: "SELECT 1 AS a" },
]);
assert(
  out.startsWith('WITH "Group 1" AS ('),
  "spaced group aliased as a quoted CTE",
);
assert(out.includes("SELECT 1 AS a"), "group output body inlined");
// a plain 'group 1' (unquoted, no double quotes) is NOT a spurious match
eq(
  referencedNames("SELECT groupby FROM t", ["Group 1"]),
  [],
  "unrelated text isn't a group reference",
);

// 7c. A materialized (already-computed) upstream is NOT inlined, and its own
// dependencies are not pulled in either -- its result already embodies them.
out = composeChainedSql("SELECT * FROM cell2", [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT a FROM cell1" },
], new Set(["cell2"]));
eq(out, "SELECT * FROM cell2", "materialized ref: no CTE, no transitive deps");
out = composeChainedSql("SELECT * FROM cell2", [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT a FROM cell1" },
], new Set(["cell1"]));
assert(out.includes("cell2 AS ("), "stale ref still inlined");
assert(!out.includes("cell1 AS ("), "its FRESH dep is left to the view");

// 7d. cellIsFresh: the reuse-eligibility predicate (audit phase 1 -- real
// inputs instead of grepping the component).
const freshCell = { type: "sql", ranOnce: true, resultId: "r1", ranCompiledSql: "C" };
assert(cellIsFresh(freshCell, "C", false) === true, "ran + unchanged + uncapped -> fresh");
assert(cellIsFresh(freshCell, "C2", false) === false, "compiled drifted -> stale");
assert(cellIsFresh(freshCell, "C", true) === false, "a CAPPED result is never fresh");
assert(cellIsFresh({ ...freshCell, ranOnce: false }, "C", false) === false, "never ran -> not fresh");
assert(cellIsFresh({ ...freshCell, resultId: null }, "C", false) === false, "no result id -> not fresh");
assert(cellIsFresh({ ...freshCell, type: "note" }, "C", false) === false, "only sql cells qualify");
assert(cellIsFresh(freshCell, undefined, false) === false, "unknown compiled -> not fresh");

// 7e. reorderByGroups: stable within a group, groups in declared order,
// unknown group ids fall into the first group.
const gAB = [{ id: "gA" }, { id: "gB" }];
const cellsList = [
  { id: "1", group: "gB" }, { id: "2", group: "gA" },
  { id: "3", group: "gB" }, { id: "4" }, { id: "5", group: "ghost" },
];
eq(reorderByGroups(cellsList, gAB).map((c) => c.id), ["2", "4", "5", "1", "3"],
   "group order first, original order within; unknown/missing -> first group");
eq(reorderByGroups(cellsList, [{ id: "gB" }, { id: "gA" }]).map((c) => c.id),
   ["1", "3", "4", "5", "2"],
   "reordering the groups reorders the cells (unknowns follow the FIRST group)");

// 7f. lastSqlCellByGroup: last NON-EMPTY sql cell per group; uptoId cuts the
// walk; non-sql cells never count.
const gl = [
  { id: "a", type: "sql", code: "S1", group: "gA" },
  { id: "b", type: "note", code: "ignored", group: "gA" },
  { id: "c", type: "sql", code: "S2", group: "gA" },
  { id: "d", type: "sql", code: "  ", group: "gB" },
  { id: "e", type: "sql", code: "S3", group: "gB" },
];
let lb = lastSqlCellByGroup(gl, null, gAB);
eq([lb.get("gA").id, lb.get("gB").id], ["c", "e"], "last sql cell per group");
lb = lastSqlCellByGroup(gl, "c", gAB);
eq([lb.get("gA").id, lb.has("gB")], ["a", false], "uptoId stops before the target");

// 7g. planChainReuse: fresh refs materialize (deps not walked); stale refs
// inline and THEIR fresh deps materialize; diamonds dedupe; group aliases are
// just names.
const earlier3 = [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT a FROM cell1" },
  { name: "cell3", sql: "SELECT * FROM cell1 JOIN cell2 USING(a)" },
];
let plan = planChainReuse("SELECT * FROM cell2", earlier3,
  new Map([["cell2", "R2"]]));
eq(plan.reuse, { cell2: "R2" }, "direct fresh ref -> reuse map");
eq([...plan.materialized], ["cell2"], "fresh ref materialized, cell1 untouched");
plan = planChainReuse("SELECT * FROM cell2", earlier3,
  new Map([["cell1", "R1"]]));
eq(plan.reuse, { cell1: "R1" }, "stale target walks INTO its deps");
plan = planChainReuse("SELECT * FROM cell3", earlier3,
  new Map([["cell1", "R1"], ["cell2", "R2"]]));
eq(Object.keys(plan.reuse).sort(), ["cell1", "cell2"],
   "diamond: both fresh legs reused once");
plan = planChainReuse("SELECT * FROM cell2", earlier3, new Map());
eq(plan.reuse, {}, "nothing fresh -> empty plan");
assert(plan.materialized.size === 0, "no materialization when nothing fresh");
plan = planChainReuse('SELECT * FROM "Group 1"',
  [{ name: "Group 1", sql: "SELECT 1" }], new Map([["group 1", "RG"]]));
eq(plan.reuse, { "Group 1": "RG" }, "a group alias reuses under its NAME");

// 7h. optimized Run-all: unchanged complete results are skipped, stale
// independent branches share a wave, and group aliases point to the earlier
// group's last SQL cell.
const runCells = [
  { id: "a", type: "sql", name: "left", code: "SELECT 1",
    ranOnce: true, resultId: "RA", ranCompiledSql: "A" },
  { id: "b", type: "sql", name: "right", code: "SELECT 2" },
  { id: "c", type: "sql", name: "both",
    code: "SELECT * FROM left UNION ALL SELECT * FROM right" },
];
let runPlan = planJournalRunAll(runCells, [], { a: "A", b: "B", c: "C" });
eq(runPlan.reusedIds, ["a"], "fresh journal cell is reused");
eq(runPlan.waves, [["b"], ["c"]],
   "stale dependent waits while fresh dependency needs no run");
runPlan = planJournalRunAll([
  { id: "a", type: "sql", name: "left", code: "SELECT 1" },
  { id: "b", type: "sql", name: "right", code: "SELECT 2" },
  { id: "c", type: "sql", name: "both",
    code: "SELECT * FROM left UNION ALL SELECT * FROM right" },
], [], { a: "A", b: "B", c: "C" });
eq(runPlan.waves, [["a", "b"], ["c"]],
   "independent stale cells run in parallel waves");
const groupRunCells = [
  { id: "a", type: "sql", name: "raw", code: "SELECT 1", group: "g1" },
  { id: "b", type: "sql", name: "clean", code: "SELECT * FROM raw", group: "g1" },
  { id: "c", type: "sql", name: "report", code: 'SELECT * FROM "Load"', group: "g2" },
];
const groupGraph = buildJournalDependencyGraph(groupRunCells,
  [{ id: "g1", name: "Load" }, { id: "g2", name: "Report" }]);
eq(groupGraph.depIds.c, ["b"],
   "group alias depends on the earlier group's last SQL cell");
const cappedPlan = planJournalRunAll([
  { id: "x", type: "sql", name: "x", code: "SELECT 1",
    ranOnce: true, resultId: "RX", ranCompiledSql: "X" },
], [], { x: "X" }, { x: true });
eq(cappedPlan.runIds, ["x"], "capped result is never reused");

// 7i. journalGraphCsv: BOM + CRLF + RFC quoting + de-duped edge lists.
const csv = journalGraphCsv([
  { label: "cell1", sql: 'SELECT "x",1\nFROM t', uses: [], feeds: ["cell2", "cell2"] },
  { label: "Note", sql: "", uses: ["cell1"], feeds: [] },
]);
assert(csv.charCodeAt(0) === 0xfeff, "BOM for Excel");
const rows = csv.slice(1).split("\r\n");
eq(rows[0], "Cell,Group,SQL,uses,feeds", "header row");
assert(rows[1].startsWith('cell1,,"SELECT ""x"",1'), "quotes + newlines RFC-escaped: " + rows[1]);
assert(rows[1].endsWith(",cell2"), "feeds de-duplicated: " + rows[1]);
eq(rows[2], "Note,,,cell1,", "non-sql row shape");

// 8. nextCellName picks the next free cellN.
eq(nextCellName(["cell1", "cell3", "note"]), "cell4", "next after max");
eq(nextCellName([]), "cell1", "first cell name");

// 9. Save-to-file round-trips through parse (ids are ephemeral, ignore them).
const defs = [
  { id: "a", type: "note", text: "# Title\nbody", code: undefined },
  { id: "b", type: "sql", name: "cell1", code: "SELECT 1", text: undefined },
  { id: "c", type: "sql", name: "cell2", code: "SELECT * FROM cell1", text: undefined },
];
const strip = (cs) => cs.map((c) => ({ type: c.type, name: c.name, code: c.code, text: c.text }));
const file = serializeNotebook(defs);
const parsedObj = JSON.parse(file);
assert(parsedObj.format === "samql-notebook", "file has format tag");
assert(Array.isArray(parsedObj.cells), "file has cells array");
eq(strip(parseNotebookFile(file)), strip(defs), "round-trip preserves cells");

// 10. Accepts a bare array of cells too.
eq(
  parseNotebookFile('[{"type":"sql","name":"cell1","code":"SELECT 1"}]').length,
  1,
  "bare array accepted",
);

// 11. Unnamed SQL cells get a fresh handle on open.
const named = parseNotebookFile('[{"type":"sql","code":"SELECT 1"},{"type":"sql","code":"SELECT 2"}]');
eq([named[0].name, named[1].name], ["cell1", "cell2"], "unnamed sql cells get handles");

// 12. Invalid input is rejected with an error (not silently empty).
let threw = false;
try { parseNotebookFile("not json"); } catch (e) { threw = true; }
assert(threw, "invalid JSON throws");
threw = false;
try { parseNotebookFile('{"foo":1}'); } catch (e) { threw = true; }
assert(threw, "non-notebook object throws");

// 13. Chart / pivot cells round-trip with their source reference.
const vizDefs = [
  { id: "s", type: "sql", name: "cell1", code: "SELECT region, amt FROM sales" },
  { id: "ch", type: "chart", sourceName: "cell1" },
  { id: "pv", type: "pivot", sourceName: "cell1" },
];
const vizParsed = parseNotebookFile(serializeNotebook(vizDefs));
eq(
  vizParsed.map((c) => [c.type, c.sourceName ?? null]),
  [["sql", null], ["chart", "cell1"], ["pivot", "cell1"]],
  "viz cells keep type + sourceName",
);
assert(vizParsed[1].name === undefined, "chart cells carry no chaining handle");

// 14. Reconcile cells round-trip with their two sources + key/compare spec,
//     and (like viz cells) carry no chaining handle.
const recDefs = [
  { id: "s", type: "sql", name: "cell1", code: "SELECT k, v FROM a" },
  { id: "t", type: "sql", name: "cell2", code: "SELECT k, v FROM b" },
  { id: "rc", type: "reconcile", leftSource: "cell1", rightSource: "cell2",
    recon: { keys: ["k"], compare: ["v"], balance: "v" } },
];
const recParsed = parseNotebookFile(serializeNotebook(recDefs));
const rc = recParsed[2];
eq([rc.type, rc.leftSource, rc.rightSource], ["reconcile", "cell1", "cell2"], "reconcile cell keeps type + sources");
eq([rc.recon.keys, rc.recon.compare, rc.recon.balance], [["k"], ["v"], "v"], "reconcile cell keeps key/compare/balance");
assert(rc.name === undefined, "reconcile cells carry no chaining handle");

// 15. sanitizeRecon drops malformed entries (non-string keys, non-string balance).
const clean = sanitizeRecon({ keys: ["k", 3, null], compare: ["v"], balance: 5 });
eq([clean.keys, clean.compare, clean.balance ?? null], [["k"], ["v"], null], "sanitizeRecon filters non-strings");
assert(sanitizeRecon(null) === undefined, "sanitizeRecon(null) is undefined");

// 14. Notebook library: index upsert/remove + unique naming (pure helpers).
let lib = [];
lib = upsertMeta(lib, { id: "a", name: "First", createdAt: 1, updatedAt: 1 });
lib = upsertMeta(lib, { id: "b", name: "Second", createdAt: 2, updatedAt: 2 });
eq(lib.map((m) => m.id), ["b", "a"], "index sorts newest-updated first");
lib = upsertMeta(lib, { id: "a", name: "First", createdAt: 1, updatedAt: 3 });
eq(lib.map((m) => m.id), ["a", "b"], "re-upsert bumps order, no duplicate");
eq(lib.length, 2, "upsert replaces same id");
lib = removeMeta(lib, "a");
eq(lib.map((m) => m.id), ["b"], "removeMeta drops by id");
eq(uniqueNbName(lib, "Second"), "Second 2", "collision gets a numeric suffix");
eq(uniqueNbName(lib, "Fresh"), "Fresh", "free name kept as-is");
eq(uniqueNbName([], ""), "Untitled", "empty base falls back to Untitled");

// 16. composeChainedSql must not hang on self / mutually cyclic cell refs.
out = composeChainedSql("SELECT * FROM cell1", [
  { name: "cell1", sql: "SELECT * FROM cell1" },
]);
assert(typeof out === "string" && out.includes("cell1"),
  "self-reference composes without hanging");
out = composeChainedSql("SELECT * FROM cell1", [
  { name: "cell1", sql: "SELECT x FROM cell2" },
  { name: "cell2", sql: "SELECT x FROM cell1" },
]);
assert(typeof out === "string", "mutual cycle composes without hanging");

// 17. referencedNames matches identifiers case-insensitively.
eq(referencedNames("SELECT * FROM CELL1 JOIN Cell2 USING (k)",
  ["cell1", "cell2"]), ["cell1", "cell2"], "case-insensitive identifier match");

// 18. sanitizeRecon: non-array keys -> [], a valid balance is kept, and a
//     non-object spec yields undefined.
let s2 = sanitizeRecon({ keys: "notarray", compare: ["v", 9], balance: "bal" });
eq([s2.keys, s2.compare, s2.balance], [[], ["v"], "bal"],
  "non-array keys -> [], non-string compare dropped, valid balance kept");
assert(sanitizeRecon("nope") === undefined && sanitizeRecon(42) === undefined,
  "non-object recon -> undefined");

// 19. A reconcile cell whose recon is malformed still round-trips as a
//     reconcile cell (recon is coerced when used).
const badRec = parseNotebookFile(serializeNotebook([
  { id: "x", type: "reconcile", leftSource: "cell1", rightSource: "cell2",
    recon: { keys: "oops", compare: ["v"] } },
]));
assert(badRec.length === 1 && badRec[0].type === "reconcile"
  && badRec[0].leftSource === "cell1",
  "malformed-recon reconcile cell still round-trips with its sources");

// 20. Cell-rename helpers: sanitize to a safe handle, dedupe, and rewrite
//     references so later cells keep working after a rename.
eq(sanitizeCellName("  My Sales 2024 "), "My_Sales_2024", "sanitize spaces/symbols");
eq(sanitizeCellName("2nd"), "_2nd", "sanitize leading digit");
eq(sanitizeCellName("***"), "", "sanitize all-symbols -> empty");
eq(uniqueCellName("sales", ["Sales", "other"]), "sales_2", "dedupe case-insensitive");
eq(uniqueCellName("sales", ["x"]), "sales", "unique name kept");
// rename rewrites whole-identifier refs only (not t.cell1, not cell10, not strings)
eq(renameInSql("SELECT * FROM cell1 JOIN cell10 ON t.cell1 = x WHERE c = 'cell1'", "cell1", "sales"),
   "SELECT * FROM sales JOIN cell10 ON t.cell1 = x WHERE c = 'cell1'",
   "renameInSql rewrites references, leaves substrings/qualified/strings");
eq(renameInSql("SELECT 1", "cell1", "cell1"), "SELECT 1", "rename no-op when unchanged");
// a renamed cell remains chainable under its new name
out = composeChainedSql("SELECT * FROM sales", [
  { name: "sales", sql: "SELECT a FROM t" },
]);
assert(out.startsWith("WITH sales AS ("), "renamed cell chains under new name");

// 21. Minimized (collapsed) state persists through save -> parse.
const collapsedRT = parseNotebookFile(serializeNotebook([
  { id: "v", type: "chart", sourceName: "cell1", collapsed: true },
  { id: "s", type: "sql", name: "cell1", code: "SELECT 1", collapsed: false },
]));
assert(collapsedRT.find((c) => c.id === "v") && collapsedRT.find((c) => c.id === "v").collapsed === true,
  "collapsed chart cell persists as collapsed");
assert(!collapsedRT.find((c) => c.id === "s").collapsed,
  "an uncollapsed cell does not gain a collapsed flag");

// 22. A leading WITH RECURSIVE on the target keeps RECURSIVE when chaining.
out = composeChainedSql(
  "WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r JOIN cell1 USING (a)",
  [{ name: "cell1", sql: "SELECT a FROM t" }],
);
assert(out.startsWith("WITH RECURSIVE cell1 AS ("),
  "merged WITH keeps the RECURSIVE keyword");
assert(out.includes("r AS (SELECT 1)"), "user recursive CTE preserved");

// 23. Three-level transitive chain emits all deps in dependency order, once.
out = composeChainedSql("SELECT * FROM cell3", [
  { name: "cell1", sql: "SELECT 1 AS a" },
  { name: "cell2", sql: "SELECT a FROM cell1" },
  { name: "cell3", sql: "SELECT a FROM cell2 JOIN cell1 USING (a)" },
]);
assert(out.indexOf("cell1 AS (") < out.indexOf("cell2 AS (")
  && out.indexOf("cell2 AS (") < out.indexOf("cell3 AS ("),
  "3-level deps ordered cell1 < cell2 < cell3");
eq((out.match(/cell1 AS \(/g) || []).length, 1, "shared dep emitted only once");

// 24. A trailing semicolon on a referenced cell is stripped inside its CTE.
out = composeChainedSql("SELECT * FROM cell1", [
  { name: "cell1", sql: "SELECT 1 AS a;" },
]);
assert(!/;\s*\)/.test(out), "trailing ; removed from CTE body");


// 7i. relational families: grouping (deepest prefix, engine-scoped, chains
// collapse to ONE root), join keys (shared _rid/_ord only) and join SQL.
const T = (name, cols, engine = "duckdb") => ({
  name, engine, columns: cols.map((c) => ({ name: c })),
});
const fams = groupRelationalFamilies([
  T("trades", ["_rid", "trades_ord", "code"]),
  T("trades_legs", ["_rid", "trades_ord", "legs_ord", "rate"]),
  T("trades_legs_cash", ["_rid", "trades_ord", "legs_ord", "cash_ord", "amt"]),
  T("trades_notes", ["note"]),                 // no _rid -> NOT family
  T("other", ["x"]),
  T("trades_legs2", ["_rid", "z"], "sqlite"),  // other engine -> NOT family
]);
const roots = fams.map((f) => f.table.name);
assert(JSON.stringify(roots) ===
  JSON.stringify(["trades", "trades_notes", "other", "trades_legs2"]),
  "children fold away; non-family tables stay top-level: " + roots);
const tr = fams.find((f) => f.table.name === "trades");
assert(JSON.stringify(tr.children.map((c) => c.name)) ===
  JSON.stringify(["trades_legs", "trades_legs_cash"]),
  "the whole chain groups under the TOP root, sorted");
const keys = familyJoinKeys(
  T("trades_legs", ["_rid", "trades_ord", "legs_ord", "rate"]),
  T("trades_legs_cash",
    ["_rid", "trades_ord", "legs_ord", "cash_ord", "amt"]));
assert(JSON.stringify(keys) ===
  JSON.stringify(["_rid", "trades_ord", "legs_ord"]),
  "join keys are the SHARED _rid/_ord set: " + keys);
const jsql = familyJoinSql(T("trades", ["_rid", "trades_ord"]),
  T("trades_legs", ["_rid", "trades_ord", "legs_ord"]));
assert(jsql.includes('JOIN "trades_legs" USING ("_rid", "trades_ord")')
  && jsql.includes('FROM "trades"'), "join SQL uses USING: " + jsql);
const nok = familyJoinSql(T("a", ["x"]), T("a_b", ["_rid"]));
assert(nok.includes("no shared keys"), "no shared keys degrades honestly");

console.log("OK");
"""

_SQL_HARNESS = r"""
import { statementSpans, statementAt, tokenize, quoteSqlIdent, needsSqlQuote } from "./sql.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}
const stmt = (t, p) => {
  const s = statementAt(t, p);
  return s ? t.slice(s.start, s.end).trim() : null;
};
const kinds = (sql) => tokenize(sql).filter(t => t.kind !== "ws").map(t => t.kind);
const kindOf = (sql, text) => {
  const t = tokenize(sql).find(x => x.text === text);
  return t ? t.kind : null;
};

// ===== statement splitting =================================================
// 1. Two statements split on the top-level semicolon.
let t = "SELECT 1; SELECT 2";
let sp = statementSpans(t);
eq(sp.length, 2, "two statements");
eq(t.slice(sp[0].start, sp[0].end).trim(), "SELECT 1;", "first span");
eq(t.slice(sp[1].start, sp[1].end).trim(), "SELECT 2", "second span");

// 2. Semicolons inside strings / comments / brackets are NOT split points.
t = "SELECT ';' AS a; -- x; y\nSELECT \"c;d\", [e;f] FROM t /* g;h */";
eq(statementSpans(t).length, 2,
  "semicolons in strings/comments/brackets are ignored");

// 2b. Escaped '' inside a string keeps the string open across a semicolon.
eq(statementSpans("SELECT 'a''b;c' AS x").length, 1,
  "doubled quote escape keeps one statement");

// 2c. Backtick-quoted identifier hides a semicolon.
eq(statementSpans("SELECT `a;b` FROM t").length, 1,
  "backtick identifier hides semicolon");

// 3. statementAt returns the statement under the cursor (incl. at the end).
t = "SELECT 1;\nSELECT 2;\nSELECT 3";
assert(stmt(t, 0).startsWith("SELECT 1"), "cursor in first statement");
assert(stmt(t, t.indexOf("SELECT 2") + 2).startsWith("SELECT 2"),
  "cursor in second statement");
assert(stmt(t, t.length).startsWith("SELECT 3"),
  "cursor at end resolves to the last statement");
// 3b. cursor exactly on a boundary semicolon resolves to the statement it ends
assert(stmt(t, t.indexOf(";")).startsWith("SELECT 1"),
  "cursor on the ; belongs to the statement it closes");

// 4. A trailing whitespace-only segment is not its own statement.
eq(statementSpans("SELECT 1;   \n  ").length, 1,
  "trailing whitespace is not a statement");
// 4b. among bare semicolons there is exactly one real (non-empty) statement
const bare = ";;SELECT 1;;";
const real = statementSpans(bare).filter(
  (s) => bare.slice(s.start, s.end).replace(/[;\s]/g, "").length > 0);
eq(real.length, 1, "only one real statement among bare semicolons");
// 4c. empty / whitespace input -> no spans, statementAt null
eq(statementSpans("   \n  ").length, 0, "blank input has no statements");
assert(statementAt("", 0) === null, "statementAt on empty text is null");
// 4d. a single statement with no semicolon is one span covering it
sp = statementSpans("SELECT * FROM t");
eq(sp.length, 1, "no semicolon -> single statement");
eq(sp[0].start, 0, "single statement starts at 0");

// 5. unterminated block comment runs to end (no crash, no split)
eq(statementSpans("SELECT 1 /* unterminated ; still comment").length, 1,
  "unterminated block comment swallows the rest");

// ===== tokenizer ===========================================================
// keywords vs identifiers
eq(kindOf("SELECT a FROM t", "SELECT"), "keyword", "SELECT is a keyword");
eq(kindOf("SELECT a FROM t", "a"), "ident", "bare word is an identifier");
// a word directly before "(" is a function call, even across whitespace
eq(kindOf("myFunc(x)", "myFunc"), "function", "word before ( is a function");
eq(kindOf("myFunc  (x)", "myFunc"), "function", "whitespace before ( still a call");
// a known function name is a function even without parens
eq(kindOf("SELECT COUNT", "COUNT"), "function", "known function name");
// strings, including the '' escape, are one token
eq(kindOf("SELECT 'a''b' AS x", "'a''b'"), "string", "escaped string is one token");
// quoted identifiers
eq(kindOf('SELECT "col x" FROM t', '"col x"'), "ident", "double-quoted ident");
eq(kindOf("SELECT [col x] FROM t", "[col x]"), "ident", "bracket ident");
// comments
eq(kindOf("SELECT 1 -- note\nFROM t", "-- note"), "comment", "line comment");
assert(tokenize("/* a */ SELECT 1").some(x => x.kind === "comment" && x.text === "/* a */"),
  "block comment token");
// numbers: decimals + exponents are a single number token
eq(kindOf("SELECT 3.14", "3.14"), "number", "decimal number");
eq(kindOf("SELECT 1e10", "1e10"), "number", "exponent number");
eq(kindOf("SELECT .5", ".5"), "number", "leading-dot number");
// a trailing minus that is not an exponent is its own punctuation
assert(tokenize("1-2").filter(x => x.kind === "number").length === 2,
  "1-2 is two numbers (minus not consumed)");
// punctuation
eq(kindOf("a , b", ","), "punct", "comma is punctuation");
// the whole stream round-trips back to the original text
const orig = "SELECT a, COUNT(*) /* c */ FROM t -- x\nWHERE a = 'z;'";
eq(tokenize(orig).map(x => x.text).join(""), orig, "tokens reconstruct the input");

// ===== IDE / Journal identifier quoting ====================================
// Sanitized load names stay bare; weird legacy / column names get quotes.
eq(quoteSqlIdent("test_sam"), "test_sam", "safe table stays bare");
eq(quoteSqlIdent("Usinvestments_Monthly_1"), "Usinvestments_Monthly_1",
  "sanitized (1) name stays bare");
eq(quoteSqlIdent("test.sam"), '"test.sam"', "embedded dot is quoted");
eq(quoteSqlIdent("Usinvestments_Monthly (1) "),
  '"Usinvestments_Monthly (1) "', "parens + trailing space are quoted");
eq(quoteSqlIdent('a"b'), '"a""b"', "embedded quote is doubled");
eq(quoteSqlIdent("123data"), '"123data"', "leading digit is quoted");
assert(needsSqlQuote("my file") === true, "space needs quote");
assert(needsSqlQuote("ok_name") === false, "safe name needs no quote");

console.log("OK");
"""

_DOCKING_HARNESS = r"""
import {
  floatKey, hasFloat, addFloat, removeFloat, removeFloatsForResult,
  bringToFront, maxZ, moveFloat, resizeFloat, overlapFraction, shouldDock,
  applyCompareDrop, pruneCompare, clamp, clampToViewport,
} from "./docking.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}
const VP = { width: 1200, height: 800 };

eq(floatKey("r1", "grid"), "r1::grid", "floatKey");

// add / dedup / multiple views
let fs = addFloat([], "r1", "grid", VP, 0);
eq(fs.length, 1, "addFloat creates one");
eq(fs[0].id, "r1::grid", "float id");
assert(fs[0].z === 1, "z is topZ+1");
let fs2 = addFloat(fs, "r1", "grid", VP, maxZ(fs)); // same view -> dedup + raise
eq(fs2.length, 1, "dedup same view");
assert(fs2[0].z >= fs[0].z, "raised z on re-open");
let fs3 = addFloat(fs2, "r1", "pivot", VP, maxZ(fs2));
eq(fs3.length, 2, "different view adds a panel");
assert(hasFloat(fs3, "r1", "pivot") && hasFloat(fs3, "r1", "grid"), "hasFloat both");
assert(!hasFloat(fs3, "r2", "grid"), "hasFloat false for other result");

// remove
eq(removeFloat(fs3, "r1::grid").length, 1, "removeFloat by id");
let fsR = addFloat(fs3, "r2", "grid", VP, maxZ(fs3));
eq(removeFloatsForResult(fsR, "r1").length, 1, "removeFloatsForResult drops all of a result");

// move / resize clamps
let g = moveFloat(fs3, "r1::grid", 50, 60).find((f) => f.id === "r1::grid");
eq([g.x, g.y], [50, 60], "moveFloat sets position");
let g2 = resizeFloat(fs3, "r1::grid", 10, 10).find((f) => f.id === "r1::grid");
assert(g2.width === 220 && g2.height === 140, "resize clamps to minimums");

// overlap geometry
const panel = { left: 0, top: 0, width: 100, height: 100 };
eq(overlapFraction(panel, { left: -10, top: -10, width: 200, height: 200 }), 1, "fully inside -> 1");
eq(overlapFraction(panel, { left: 500, top: 500, width: 50, height: 50 }), 0, "disjoint -> 0");
const zoneHalf = { left: 50, top: 0, width: 100, height: 100 };
assert(Math.abs(overlapFraction(panel, zoneHalf) - 0.5) < 1e-9, "half overlap -> 0.5");

// shouldDock: overlap threshold OR pointer-in-zone
assert(shouldDock(panel, zoneHalf) === true, "half overlap meets default threshold");
const zoneLow = { left: 90, top: 0, width: 100, height: 100 }; // ~10% overlap
assert(shouldDock(panel, zoneLow) === false, "low overlap + no pointer -> false");
assert(shouldDock(panel, zoneLow, { x: 95, y: 5 }) === true, "pointer inside zone -> true");
assert(shouldDock(panel, null) === false, "null zone -> false");

// compare drop / un-split
eq(applyCompareDrop(null, "a", "b"), { left: "a", right: "b" }, "start compare");
eq(applyCompareDrop(null, "a", "a"), null, "dropping the active tab on itself -> none");
eq(applyCompareDrop(null, null, "b"), null, "no active -> none");
eq(applyCompareDrop({ left: "a", right: "b" }, "a", "c"), { left: "a", right: "c" }, "retarget right side");
eq(applyCompareDrop({ left: "a", right: "b" }, "x", "a"), null, "drop a compared tab back -> un-split");
eq(applyCompareDrop({ left: "a", right: "b" }, "x", "b"), null, "drop the other compared tab back -> un-split");

// prune when a result disappears
eq(pruneCompare({ left: "a", right: "b" }, ["a", "b"]), { left: "a", right: "b" }, "prune keeps live");
eq(pruneCompare({ left: "a", right: "b" }, ["a"]), null, "prune drops dead compare");

// ---- extra: cascade/dedup, resize floors, viewport clamp ------------------
const vp = { width: 1200, height: 800 };
// opening the same result+view again raises it, never duplicates
let fl = addFloat([], "r1", "chart", vp, 0);
eq(fl.length, 1, "first open adds one panel");
const z0 = fl[0].z;
fl = addFloat(fl, "r1", "chart", vp, maxZ(fl));
eq(fl.length, 1, "re-opening same panel does not duplicate");
assert(fl[0].z > z0, "re-opening raises z");
// a different view of the same result is a separate panel, cascaded
fl = addFloat(fl, "r1", "pivot", vp, maxZ(fl));
eq(fl.length, 2, "different view is its own panel");
assert(fl[0].x !== fl[1].x || fl[0].y !== fl[1].y, "panels are cascaded, not stacked");
// closing every panel for a result clears them
eq(removeFloatsForResult(fl, "r1").length, 0, "removeFloatsForResult clears the result's panels");
// resize floors (min 220 x 140)
const rsz = resizeFloat([{ id: "k", resId: "r", view: "grid", x: 0, y: 0, width: 500, height: 500, z: 1 }], "k", 10, 10)[0];
eq([rsz.width, rsz.height], [220, 140], "resize clamps to minimum panel size");
// clamp helper: inverted bounds fall back to lo
eq(clamp(5, 10, 0), 10, "clamp with hi<lo returns lo");
eq(clamp(50, 0, 10), 10, "clamp above hi");
eq(clamp(-5, 0, 10), 0, "clamp below lo");
// panel viewport clamp keeps the title bar reachable (never fully off-screen)
const cv = clampToViewport(-999, -999, 400, 300, 1200, 800);
assert(cv.x >= 8 - 400 + 80 - 0.001 && cv.y >= 8 - 0.001, "panel stays reachable top-left");
const cv2 = clampToViewport(99999, 99999, 400, 300, 1200, 800);
assert(cv2.x <= 1200 - 80 && cv2.y <= 800 - 40, "panel stays reachable bottom-right");

console.log("OK");
"""

_SQLPROFILES_HARNESS = r"""
import {
  bestOdbcDriver, parseSqlProfiles, dumpSqlProfiles, lastProfileName,
  sanitizeProfileName,
} from "./sqlprofiles.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// 1. Driver auto-pick: the newest SQL Server ODBC driver wins (18>17>13>11).
eq(bestOdbcDriver(["ODBC Driver 11 for SQL Server", "ODBC Driver 17 for SQL Server"]),
   "ODBC Driver 17 for SQL Server", "pick 17 over 11");
eq(bestOdbcDriver(["SQL Server Native Client 11.0", "Some Other Driver"]),
   "SQL Server Native Client 11.0", "prefer a SQL Server driver");
eq(bestOdbcDriver([]), "", "empty driver list -> empty");

// 2. Profile round-trips, and a password is never part of the saved shape.
const profs = { Prod: { driver: "ODBC Driver 18 for SQL Server", server: "h",
  port: "1433", auth: "windows_alt", user: "d\\u", encrypt: true, trust: true,
  multiSubnet: false, loginTimeout: "15", stmtTimeout: "0", readOnly: true } };
const blob = dumpSqlProfiles(profs, "Prod");
const back = parseSqlProfiles(blob);
eq(Object.keys(back), ["Prod"], "profile name kept");
eq(back.Prod.auth, "windows_alt", "alt-account auth persisted");
assert(!("pwd" in back.Prod) && !("password" in back.Prod),
  "no password ever persisted in a profile");
eq(lastProfileName(blob), "Prod", "last profile remembered");

// 3. A malformed / older store can't crash the UI: garbage -> {}.
eq(parseSqlProfiles("not json"), {}, "garbage -> {}");
eq(parseSqlProfiles(null), {}, "null -> {}");
const co = parseSqlProfiles(JSON.stringify({ profiles: { X: { auth: "nope", server: "s" } } }));
eq(co.X.auth, "windows", "unknown auth coerced to windows");
eq([co.X.encrypt, co.X.readOnly], [true, true], "missing flags default safely");
eq(co.X.savePassword, false, "savePassword defaults to false");

// 4. Profile-name sanitiser trims.
eq(sanitizeProfileName("  My Conn  "), "My Conn", "trim profile name");

// 5. ODBC driver pick prefers the highest available version, else SQL Server.
eq(bestOdbcDriver(["ODBC Driver 13 for SQL Server", "ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server"]),
   "ODBC Driver 18 for SQL Server", "pick newest (18 > 17 > 13)");
eq(bestOdbcDriver(["SQL Server", "Some Other Driver"]), "SQL Server",
   "fall back to a generic SQL Server driver");
eq(bestOdbcDriver([]), "", "no drivers -> empty string");
eq(bestOdbcDriver(["ODBC Driver 11 for SQL Server", "ODBC Driver 17 for SQL Server"]),
   "ODBC Driver 17 for SQL Server", "17 beats 11");

// 6. parse/dump round-trip carries profiles + lastProfile, malformed dropped.
const spBlob = dumpSqlProfiles(
  { Prod: { driver: "ODBC Driver 18 for SQL Server", server: "db", port: "1433",
            auth: "sql", user: "sa", encrypt: true, trust: true, multiSubnet: false,
            loginTimeout: "15", stmtTimeout: "0", readOnly: true } },
  "Prod");
const spBack = parseSqlProfiles(spBlob);
eq(Object.keys(spBack), ["Prod"], "round-trip keeps the profile");
eq(spBack.Prod.server, "db", "round-trip keeps fields");
eq(lastProfileName(spBlob), "Prod", "lastProfileName reads the marker");
// malformed store -> empty map, no throw
eq(parseSqlProfiles("not json"), {}, "garbage -> empty map");
eq(parseSqlProfiles(null), {}, "null -> empty map");
eq(lastProfileName("not json"), "", "lastProfileName on garbage -> empty");
// a blank profile key is dropped
assert(!("" in parseSqlProfiles(JSON.stringify({ profiles: { "": { server: "x" } } }))),
  "blank profile name is dropped");

console.log("OK");
"""

_APIPROFILES_HARNESS = r"""
import {
  buildApiUrl, parseApiProfiles, dumpApiProfiles, lastApiProfileName,
} from "./apiProfiles.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// 1. Query params are appended + percent-encoded; empty keys skipped.
eq(buildApiUrl("https://h/p", [{ key: "a", value: "1" }, { key: "", value: "x" },
   { key: "q", value: "a b" }]), "https://h/p?a=1&q=a%20b",
   "params appended + encoded, blank key dropped");
// 2. An existing query string means pairs join with &.
eq(buildApiUrl("https://h/p?z=0", [{ key: "a", value: "1" }]),
   "https://h/p?z=0&a=1", "joins existing query with &");
// 3. No params -> URL unchanged (trimmed).
eq(buildApiUrl("  https://h/p  ", []), "https://h/p", "no params -> base url");

// 4. Profile round-trips, and a password is never part of the saved shape.
const profs = { Prod: { url: "https://h", params: [{ key: "k", value: "v" }],
  user: "me", jsonPath: "data.items", tableName: "t", destination: "duckdb" } };
const blob = dumpApiProfiles(profs, "Prod");
const back = parseApiProfiles(blob);
eq(Object.keys(back), ["Prod"], "profile name kept");
eq(back.Prod.params, [{ key: "k", value: "v" }], "params persisted");
assert(!("pass" in back.Prod) && !("password" in back.Prod) &&
       !("auth_pass" in back.Prod), "no secret ever persisted in a profile");
eq(lastApiProfileName(blob), "Prod", "last profile remembered");

// 5. Malformed / older store can't crash the UI.
eq(parseApiProfiles("not json"), {}, "garbage -> {}");
eq(parseApiProfiles(null), {}, "null -> {}");
const co = parseApiProfiles(JSON.stringify({ profiles: { X: { url: "u" } } }));
eq(co.X.tableName, "api_data", "missing table name defaults safely");
eq(co.X.destination, "auto", "missing destination defaults to auto");
eq(co.X.savePassword, false, "savePassword defaults to false");

console.log("OK");
"""

_NODEGRAPH_HARNESS = r"""
import {
  wirePath, marqueeHits, nearestPort, clampPointToBox, serializeGraph,
  stripCosmeticNodeConfig, serializeGraphForExecution, executionGraphSignature,
} from "./nodegraph.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// ---- wirePath: a cubic bezier with 46px horizontal handles ----------------
eq(wirePath(0, 0, 100, 50), "M 0 0 C 46 0, 54 50, 100 50", "wirePath curve");
assert(wirePath(10, 20, 10, 20).startsWith("M 10 20 C "), "wirePath degenerate ok");

// ---- marqueeHits: intersection test, corner-order independent -------------
const boxes = [
  { id: "a", x: 0, y: 0, w: 50, h: 30 },
  { id: "b", x: 200, y: 200, w: 40, h: 40 },
  { id: "c", x: 100, y: 10, w: 20, h: 20 },
];
// rect fully containing a + c
eq(marqueeHits(boxes, { x0: -5, y0: -5, x1: 130, y1: 60 }), ["a", "c"],
  "contains a and c, not b");
// reversed corners (drag up-left) selects the same set
eq(marqueeHits(boxes, { x0: 130, y0: 60, x1: -5, y1: -5 }), ["a", "c"],
  "corner order does not matter");
// partial overlap still counts
eq(marqueeHits(boxes, { x0: 40, y0: 20, x1: 45, y1: 25 }), ["a"],
  "partial overlap of a");
// edge-touch counts as a hit (a's right edge is x=50)
eq(marqueeHits(boxes, { x0: 50, y0: 0, x1: 60, y1: 10 }), ["a"],
  "touching the edge counts");
// empty rect far away -> nothing
eq(marqueeHits(boxes, { x0: 500, y0: 500, x1: 510, y1: 510 }), [],
  "no boxes far away");
eq(marqueeHits([], { x0: 0, y0: 0, x1: 10, y1: 10 }), [], "no boxes -> empty");

// ---- nearestPort: closest input within tolerance --------------------------
const ports = [
  { node: "n1", port: "in", x: 0, y: 0 },
  { node: "n2", port: "in", x: 30, y: 0 },
  { node: "n3", port: "left", x: 100, y: 100 },
];
eq(nearestPort(ports, 5, 0, 38), { node: "n1", port: "in" },
  "snaps to the closest input");
eq(nearestPort(ports, 28, 1, 38), { node: "n2", port: "in" },
  "closest flips to n2 when nearer");
assert(nearestPort(ports, 5, 0, 3) === null,
  "nothing within a tight tolerance");
assert(nearestPort([], 0, 0, 100) === null, "no ports -> null");
// exactly at maxDist is NOT inside (strict <)
assert(nearestPort([{ node: "x", port: "in", x: 10, y: 0 }], 0, 0, 10) === null,
  "distance == maxDist is excluded");

// ---- clampPointToBox: keep a point inside the viewport --------------------
const b = { left: 0, top: 0, right: 100, bottom: 80 };
eq(clampPointToBox(50, 40, b), { x: 50, y: 40 }, "inside is unchanged");
eq(clampPointToBox(-10, 40, b), { x: 0, y: 40 }, "clamp left");
eq(clampPointToBox(999, 40, b), { x: 100, y: 40 }, "clamp right");
eq(clampPointToBox(50, -5, b), { x: 50, y: 0 }, "clamp top");
eq(clampPointToBox(50, 999, b), { x: 50, y: 80 }, "clamp bottom");
eq(clampPointToBox(-10, 999, b), { x: 0, y: 80 }, "clamp corner");

// ---- serializeGraph: strip UI-only fields, keep id/type/config + from/to --
const g = serializeGraph(
  [
    { id: "n1", type: "input", config: { table: "t" }, x: 10, y: 20, label: "X" },
    { id: "n2", type: "select", config: {}, x: 99, y: 1 },
  ],
  [{ from: { node: "n1", port: "out" }, to: { node: "n2", port: "in" }, ui: 1 }],
);
eq(g.nodes, [
  { id: "n1", type: "input", config: { table: "t" } },
  { id: "n2", type: "select", config: {} },
], "node positions + extra fields stripped");
eq(g.edges, [{ from: { node: "n1", port: "out" }, to: { node: "n2", port: "in" } }],
  "edges keep only from/to");

// ---- executionGraphSignature: cosmetics ignored; fields/renames matter ----
eq(stripCosmeticNodeConfig({
  table: "t", fields: [{ name: "a", keep: true, rename: "A" }],
  bodyW: 220, bodyH: 160, label: "Select", style: { theme: "dark" },
  collapsed: false,
}), {
  table: "t", fields: [{ name: "a", keep: true, rename: "A" }],
}, "stripCosmetic drops bodyW/label/style/collapsed only");

const edgesExec = [
  { from: { node: "sel", port: "out" }, to: { node: "out", port: "in" } },
];
const baseCfg = {
  table: "t",
  fields: [{ name: "a", keep: true, rename: "A" }],
  bodyW: 220, bodyH: 160, label: "Select", style: { theme: "dark" },
  collapsed: false,
};
const nodesCosmeticA = [
  { id: "sel", type: "select", config: baseCfg },
  { id: "out", type: "output", config: { table: "x" } },
];
const nodesCosmeticB = [
  { id: "sel", type: "select", config: {
    ...baseCfg, bodyW: 400, bodyH: 300, label: "UI", style: { theme: "light" },
    collapsed: true,
  } },
  nodesCosmeticA[1],
];
eq(executionGraphSignature(nodesCosmeticA, edgesExec),
   executionGraphSignature(nodesCosmeticB, edgesExec),
   "cosmetic-only config must not change execution signature");
assert(
  executionGraphSignature(nodesCosmeticA, edgesExec) !==
  executionGraphSignature([
    { id: "sel", type: "select", config: {
      ...baseCfg, fields: [{ name: "a", keep: true, rename: "Alpha" }],
    } },
    nodesCosmeticA[1],
  ], edgesExec),
  "field rename must change execution signature (missing-fields / reconcile)");
assert(
  executionGraphSignature(nodesCosmeticA, edgesExec) !==
  executionGraphSignature([
    { id: "sel", type: "select", config: {
      ...baseCfg, fields: [{ name: "a", keep: false, rename: "A" }],
    } },
    nodesCosmeticA[1],
  ], edgesExec),
  "Select keep=false must change execution signature");
const execGraph = serializeGraphForExecution(nodesCosmeticA, edgesExec);
assert(!("bodyW" in execGraph.nodes[0].config)
  && !("label" in execGraph.nodes[0].config)
  && execGraph.nodes[0].config.fields[0].rename === "A",
  "serializeGraphForExecution keeps fields, drops cosmetics");

console.log("OK");
"""

_TABLECAPS_HARNESS = r"""
import { canFlattenTable, isNestedColumnType } from "./tableCaps.mjs";
function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }

// nested-type detection over DuckDB type strings
assert(isNestedColumnType("STRUCT(a INTEGER, b VARCHAR)"), "STRUCT is nested");
assert(isNestedColumnType("BIGINT[]"), "array is nested");
assert(isNestedColumnType("MAP(VARCHAR, INTEGER)"), "MAP is nested");
assert(isNestedColumnType("JSON"), "JSON is nested");
assert(isNestedColumnType(" struct(x int) "), "case/space tolerant");
assert(!isNestedColumnType("VARCHAR"), "VARCHAR is flat");
assert(!isNestedColumnType("DECIMAL(18,2)"), "DECIMAL is flat");

const T = (o) => Object.assign(
  { engine: "duckdb", name: "t", source: "", row_count: null, columns: [] }, o);

// came from a JSON file -> offered
assert(canFlattenTable(T({ source: "/data/x.json" })), "json source -> flatten");
assert(canFlattenTable(T({ source: "/data/x.NDJSON" })),
       "ndjson source -> flatten");
// non-JSON source but a nested column -> still offered (the reported case)
assert(canFlattenTable(T({ source: "/data/x.txt",
  columns: [{ name: "legs", type: "STRUCT(k VARCHAR)" }] })),
  "nested column -> flatten even from a .txt bundle");
assert(canFlattenTable(T({ source: "/cache/x.parquet",
  columns: [{ name: "a", type: "VARCHAR[]" }] })),
  "nested column -> flatten from a Parquet cache");
// non-JSON source, all flat columns -> not offered
assert(!canFlattenTable(T({ source: "/data/x.csv",
  columns: [{ name: "a", type: "VARCHAR" }, { name: "b", type: "BIGINT" }] })),
  "flat CSV table -> no flatten");
// non-duckdb -> never
assert(!canFlattenTable(T({ engine: "sqlite", source: "/data/x.json" })),
       "sqlite -> no flatten");

console.log("OK");
"""

_NODEBOOK_MODEL_HARNESS = r"""
import {
  PORTS, nodeWidth, nodeHeight, visibleInputCount, portXY,
  sameCanvasNodeMemoState, parseNodeFlowGraph, serializeNodeFlowGraph,
  parseNodeFlowTabs, serializeNodeFlowTabs, NODEFLOW_FILE_VERSION,
  NODEFLOW_TABS_VERSION,
} from "./nodeFlowModel.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function state(node, extra = {}) {
  return {
    node, index: 0, selected: false, dropHover: false,
    ripple: false, snapped: false, dying: false, born: false,
    denseMode: false,
    renderVersion: "g1", chartVersion: null, childSelection: null,
    ...extra,
  };
}

const input = { id: "a", type: "input", x: 10, y: 20, config: {} };
const output = { id: "b", type: "output", x: 250, y: 20, config: {} };
assert(PORTS.iterator.inputs.join(",") === "vars,in", "iterator ports retained");
assert(nodeWidth(input) > 0 && nodeHeight(input) > 0, "node geometry is usable");
assert(visibleInputCount({ id: "u", type: "union", x: 0, y: 0, config: {} }, []) === 1,
  "union presents one stacked input");
const out = portXY(input, "out", 0);
const inn = portXY(output, "in", 0);
assert(out.x > input.x && inn.x === output.x, "port anchors follow node geometry");

const base = state(input);
assert(sameCanvasNodeMemoState(base, state(input)),
  "stationary node with unchanged external versions is memo-equal");
assert(!sameCanvasNodeMemoState(base, state({ ...input, x: 11 })),
  "moved node object rerenders");
assert(!sameCanvasNodeMemoState(base, state(input, { selected: true })),
  "selection rerenders");
assert(!sameCanvasNodeMemoState(base, state(input, { renderVersion: "g2" })),
  "config/wiring version rerenders");
assert(!sameCanvasNodeMemoState(base, state(input, { denseMode: true })),
  "dense layout mode rerenders");
const chart = {};
assert(!sameCanvasNodeMemoState(state(input, { chartVersion: null }),
                                state(input, { chartVersion: chart })),
  "chart-data version rerenders");

const legacyGraph = { nodes: [input, output], edges: [{ from: { node: "a", port: "out" }, to: { node: "b", port: "in" } }] };
const migratedGraph = parseNodeFlowGraph(legacyGraph);
assert(migratedGraph.version === NODEFLOW_FILE_VERSION, "legacy graph migrates to current version");
assert(migratedGraph.edges[0].id, "graph migration supplies stable edge ids");
const graphRoundTrip = parseNodeFlowGraph(serializeNodeFlowGraph(migratedGraph.nodes, migratedGraph.edges));
assert(graphRoundTrip.nodes.length === 2 && graphRoundTrip.edges.length === 1, "versioned graph round-trips");
let futureGraphRejected = false;
try { parseNodeFlowGraph({ ...migratedGraph, version: NODEFLOW_FILE_VERSION + 1 }); } catch { futureGraphRejected = true; }
assert(futureGraphRejected, "future graph versions are rejected");
const tabs = parseNodeFlowTabs({ tabs: [{ id: "t1", name: "Flow" }], activeTabId: "t1" });
assert(tabs.version === NODEFLOW_TABS_VERSION && tabs.tabs.length === 1, "legacy tabs migrate");
assert(serializeNodeFlowTabs(tabs.tabs, "t1").version === NODEFLOW_TABS_VERSION, "tabs serialize with version");
console.log("OK");
"""

_SQLFUNCS_HARNESS = r"""
import { SQL_FUNCTION_GROUPS, applySnippet } from "./sqlFunctions.mjs";

function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }
function eq(a, b, m) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  assert(x === y, m + " -> expected " + y + ", got " + x);
}

// applySnippet: $0 marks the caret; it is stripped; selection is replaced.
let r = applySnippet("SELECT  FROM t", 7, 7, "lag($0) OVER ()");
eq(r.text, "SELECT lag() OVER () FROM t", "snippet inserted at caret");
eq(r.caret, 11, "caret lands at the $0 marker");

r = applySnippet("a b", 0, 1, "X$0Y");        // replace selection "a"
eq(r.text, "XY b", "selection replaced by snippet");
eq(r.caret, 1, "caret between X and Y");

r = applySnippet("", 0, 0, "count(*)");        // no marker -> caret at end
eq(r.text, "count(*)", "no-marker snippet inserted");
eq(r.caret, "count(*)".length, "no marker -> caret at end");

// Catalog: non-empty groups, every snippet present, at most one $0 each.
assert(SQL_FUNCTION_GROUPS.length >= 5, "several function groups");
const all = SQL_FUNCTION_GROUPS.flatMap((g) => g.items);
assert(all.length >= 40, "a useful number of functions: " + all.length);
for (const fn of all) {
  assert(fn.label && fn.snippet, "every function has a label + snippet");
  const n = fn.snippet.split("$0").length - 1;
  assert(n <= 1, "at most one caret marker in: " + fn.snippet);
}
const joined = all.map((f) => f.snippet).join("\n");
for (const needle of [
  "UNNEST(", "recursive := true", "json_extract", "$0.*",   // json / nested
  "CASE WHEN", "substring(", "regexp_replace(", "regexp_matches(",
  "lag(", "lead(", "row_number(",                           // window
]) {
  assert(joined.includes(needle), "catalog is missing: " + needle);
}
// the requested function families are each represented by a menu label
const labels = all.map((f) => f.label.toLowerCase()).join(" | ");
for (const fam of ["case", "substring", "regex", "lag", "lead"]) {
  assert(labels.includes(fam), "no menu entry for: " + fam);
}

console.log("OK");
"""
