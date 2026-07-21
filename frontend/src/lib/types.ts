// Types mirroring the SamQL backend JSON API. Kept deliberately close to
// the Python `Session` return shapes so the two stay in lock-step.

export type EngineKind = "sqlite" | "duckdb" | "remote";

export type FilterOp =
  | "contains"
  | "equals"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "starts"
  | "ends"
  | "is_null"
  | "not_null";

export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  hint?: string; // how to query a nested column (struct/list/json/map)
}

export interface TableInfo {
  engine: EngineKind;
  name: string;
  source: string;
  row_count: number | null;
  columns: ColumnInfo[];
  remote?: boolean; // SQL Server catalog table: schema only, no data loaded
  qualified?: string; // its fully-qualified [db].[schema].[table] name
  conn?: string; // the SQL Server connection it came from
  database?: string; // the SQL Server database it lives in
  schema?: string; // the SQL Server schema it lives in
  group?: string; // grouping label for the sidebar (usually the database)
  col_count?: number; // number of columns (remote tables list this; columns are lazy)
  parent?: string | null; // .501: flatten parentage (family tree; path-only child names)
  /** Source file on disk changed after this table was loaded (debounced watcher). */
  source_changed?: boolean;
  /** Last in-place auto-reload failure for this table (surfaced on the badge). */
  source_reload_error?: string;
}

export interface Features {
  duckdb: boolean;
  pyarrow: boolean;
  sqlglot: boolean;
  pandas: boolean;
  pyodbc: boolean;
  openpyxl: boolean;
  secrets: boolean;
}

/** SQL assistant status (local llama.cpp pack and/or OpenAI-compatible API). */
export interface AssistantStatus {
  enabled?: boolean;
  mode?: "local" | "api";
  available?: boolean;
  pack_ok?: boolean;
  reason?: string | null;
  hint?: string | null;
  root?: string | null;
  model?: string | null;
  model_name?: string;
  quant?: string | null;
  using_default?: boolean;
  preferred_model?: string | null;
  preferred_missing?: boolean;
  default_model?: string | null;
  duckdb_busy?: boolean;
  /** When duckdb_busy, best-effort description of the blocking Activity op. */
  duckdb_busy_op?: {
    kind?: string;
    target?: string | null;
    label?: string | null;
    summary?: string;
  } | null;
  generating?: boolean;
  server_url?: string | null;
  refuse_low_memory?: boolean;
  memory?: {
    memory_total_mb?: number;
    memory_available_mb?: number;
    model_need_mb?: number;
    effective_mb?: number;
    duckdb_mb?: number;
    duckdb_target_mb?: number | null;
  };
  memory_plan?: Record<string, unknown> | null;
  api?: {
    base_url?: string | null;
    model?: string | null;
    has_api_key?: boolean;
    configured?: boolean;
  };
}

export interface AssistantChatResult {
  ok: boolean;
  reply?: string;
  sql?: string;
  dialect?: string;
  error?: string;
  cancelled?: boolean;
  queued_reason?: string;
  status?: AssistantStatus;
}

export interface Health {
  ok: boolean;
  app: string;
  version: string;
  build?: string;
  features: Features;
  concurrent_reads?: boolean; // DuckDB light-read concurrency (async reads)
  flatten_json?: boolean; // when true, JSON loads shred into relational tables (default off)
  /** When true, loads skip persistent file→Parquet filecache (Fresh load). */
  fresh_load?: boolean;
  frontend_built: boolean;
  warming?: boolean; // HTTP up, Session() still constructing (launcher-ready)
  restoring?: boolean; // session restore is replaying the load manifest
  restored?: number; // tables rebuilt by the last restore
  /** Exit → keep server: AppWindow launcher should not stop this backend. */
  keep_on_close?: boolean;
}

export type Cell = string | number | boolean | null;

// A query result page (also the initial run_query payload).
export interface StatementEntry {
  index: number;
  sql_preview: string;
  ms?: number;
  result_id?: string | null;
  total_rows?: number;
  columns?: string[];
  note?: string;
  error?: string;
}

export interface ResultPage {
  columns: string[];
  rows: Cell[][];
  offset?: number;
  total_rows: number;
  sql?: string;
  engine?: EngineKind;
  // present on the initial run:
  result_id?: string | null;
  elapsed_ms?: number;
  target?: string;
  truncated?: boolean;
  // Session data_epoch when this snapshot was produced (latest-data stamp).
  data_epoch?: number;
  // a runaway result stopped at the safety ceiling (SAMQL_MAX_RESULT_ROWS)
  result_capped?: boolean;
  result_cap?: number | null;
  statement?: string;
  filtered?: boolean;
  cancelled?: boolean;
  // Deep sorted/filtered page while Parquet snap still builds — retry soon.
  pending?: boolean;
  retry_after_ms?: number;
  // bounded exploratory execution; full runs leave these absent
  preview?: boolean;
  preview_limit?: number;
  preview_limited?: boolean;
  // .458 per-statement run ledger (Run-all):
  statements?: StatementEntry[];
  failed_statement?: number;
  // error channel:
  error?: string;
  detail?: any;
}

export interface LoadedTable {
  name: string;
  rows: number;
  columns: string[];
  /** Rows reshaped to fit the header (short padded, long truncated), not dropped. */
  reshaped?: number;
  engine?: EngineKind;
}

export interface LoadResult {
  loaded: { file: string; tables?: LoadedTable[]; error?: string }[];
  tables: TableInfo[];
}

export interface ColumnProfile {
  column: string;
  type: string;
  raw_type: string;
  date_fmt: string | null;
  nulls: number;
  null_pct: number;
  distinct: number;
  distinct_pct: number;
  min: Cell;
  max: Cell;
  mean: number | null;
  std: number | null;
  outliers: number | null;
  top_values: { value: Cell; count: number; pct: number }[] | null;
}

export interface TableProfile {
  table: string;
  total_rows: number;
  columns: ColumnProfile[];
  error?: string;
}

export interface HistoryEntry {
  sql: string;
  target?: string;
  row_count?: number | null;
  elapsed_sec?: number;
  ts?: string;
  [k: string]: any;
}

export type WorkflowKind = "ide" | "journal" | "node" | "dashboard";

export interface WorkflowSummary {
  name: string;
  kind: WorkflowKind;
  created_at?: string;
  last_used?: string;
  nodes?: number;
  edges?: number;
  cells?: number;
  preview?: string;
}

export interface ErrorLogEntry {
  id: number;
  ts: string;
  epoch: number;
  method: string;
  path: string;
  status: number;
  kind: string; // "ServerError" | "ApiError"
  error: string;
  traceback: string;
  detail: string;
}

export interface SavedQuery {
  name: string;
  sql: string;
  tags?: string[];
  created_at?: string;
  last_used?: string;
  [k: string]: any;
}

export type ChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "scatter"
  | "histogram"
  | "treemap"
  | "tree"
  | "candlestick"
  | "multix"
  | "multiy"
  | "delta"
  | "waterfall";
export type Aggregation = "sum" | "avg" | "count" | "min" | "max";

// Named colour palettes the chart inspector offers; resolved to colour arrays
// in lib/chartOption. "custom" means fall back to per-series overrides only.
export type ChartPalette =
  | "samql"
  | "vivid"
  | "cool"
  | "warm"
  | "mono"
  | "pastel"
  | "earth";

// Purely-presentational chart styling, stored on the chart node's config and
// attached to ChartData before rendering. Everything is optional so an older
// chart (no style) keeps rendering exactly as before.
export interface ChartStyle {
  palette?: ChartPalette;
  theme?: "dark" | "light"; // chart background / axis / grid / text theme
  title?: string;
  showLegend?: boolean;
  showGrid?: boolean;
  xLabel?: string;
  yLabel?: string;
  horizontal?: boolean; // bar / area: category axis runs vertically
  stacked?: boolean; // bar / area with a series split: stack the series
  rounded?: boolean; // bar: round the bar corners (top of a stack)
  large?: boolean; // line / area: downsample (LTTB) for large-scale data
  smooth?: boolean; // line / area: smooth the curve
  seriesColors?: Record<string, string>; // per-series colour overrides
  padAngle?: number; // pie: gap (deg) between slices
  roseType?: boolean; // pie: nightingale / "rose" layout (radius by value)
  gradient?: boolean; // treemap / tree: colour leaves by value on a gradient
  dataZoom?: boolean; // candlestick / category: add a zoom+pan slider
  deltaMode?: "absolute" | "percent"; // delta chart: raw or period % change
}

export interface ChartSpec {
  result_id?: string;
  table?: string;
  engine?: EngineKind;
  chart_type: ChartType;
  x: string;
  y?: string;
  series?: string; // optional split dimension -> one series per value
  agg?: Aggregation;
  bins?: number;
  limit?: number;
  // candlestick: the four price columns (one row per x / date)
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  // multiple-x: a second independent (x2, y2) series on its own top axis
  x2?: string;
  y2?: string;
  /** Names the run for dashboard registration + precise cancel. */
  query_id?: string;
}

export interface ChartSeries {
  name: string;
  values?: number[];
  points?: { x: number; y: number }[];
  ohlc?: number[][]; // candlestick: one [open, close, low, high] per label
  xAxisIndex?: number; // multiple-x: which x-axis this series binds to
  yAxisIndex?: number; // multiple-y: which y-axis this series binds to
}

export interface ChartData {
  chart_type: ChartType;
  x: string;
  y?: string;
  labels?: string[];
  labels2?: string[]; // multiple-x: categories for the second (top) x-axis
  series: ChartSeries[];
  style?: ChartStyle; // attached client-side for rendering
  error?: string;
}

export type PivotAgg =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_distinct";

export interface PivotValue {
  field: string | null;
  agg: PivotAgg;
}

export interface PivotFilter {
  field: string;
  op: string;
  value?: string;
  value2?: string;
  values?: string[];
}

export interface PivotResult {
  columns: string[];
  rows: Cell[][];
  row_count: number;
  truncated?: boolean;
  note?: string;
  error?: string;
}

export interface ReconcileFieldRow {
  field: string;
  label?: string;
  a_only: number;
  b_only: number;
  non_matching: number;
  matching: number;
  sum_matching_balance: number | null;
  sum_non_matching_balance: number | null;
}

export interface ReconcileTotals {
  a_only: number;
  b_only: number;
  matching: number;
  non_matching: number;
  total: number;
}

export interface ReconcileResult {
  keys: string[];
  engine?: string;
  balance_field?: string | null;
  totals: ReconcileTotals;
  fields: ReconcileFieldRow[];
  error?: string;
  cancelled?: boolean;
}

export type ReconBucket = "a_only" | "b_only" | "matching" | "non_matching";

export interface ReconcileDrill {
  result_id: string | null;
  columns: string[];
  count: number;
  error?: string;
  cancelled?: boolean;
}

export interface FormatResult {
  ok: boolean;
  result: string;
}

export interface StatementSpan {
  start: number;
  end: number;
  sql: string;
}

export interface MemInfo {
  rss_mb: number | null;
  total_mb: number | null;
  percent: number | null;
  duckdb_mb?: number | null;
  cached_results?: number;
  freed_mb?: number;
  kept_results?: number;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  ext: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  sep: string;
  drives: string[];
  entries: FsEntry[];
  home?: string;
  shortcuts?: { label: string; path: string }[];
  error?: string;
}

export interface LoadProgress {
  id: string;
  state:
    | "starting"
    | "running"
    | "reading"
    | "finalizing"
    | "done"
    | "error"
    | "cancelled";
  bytes_done: number;
  bytes_total: number;
  rows: number | null;
  name: string;
  error: string | null;
  engine: string;
  elapsed_ms: number;
  loaded?: LoadedTable[] | { tables?: LoadedTable[] }[];
  tables?: TableInfo[];
}

export interface JobSummary {
  id: string;
  state: "starting" | "reading" | "finalizing" | "done" | "error";
  bytes_done: number;
  bytes_total: number;
  rows: number | null;
  name: string;
  error: string | null;
  engine: string;
}

// One background task as the activity tray shows it. GET /api/tasks normalizes
// every rail (load / folder / hdfs / convert / flatten / api / iterator) into
// this shape, with a coarse state and an honest progress mode -- bytes when a
// size is known, a step count for iterator passes, otherwise an indeterminate
// spinner. A card's X cancels via /api/load/cancel/{id}; finished cards are
// dismissed client-side.
export type TaskProgressMode = "bytes" | "steps" | "spinner";
export interface TaskCard {
  id: string;
  kind: string; // load | folder | hdfs | convert | flatten | api | iterator
  title: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  phase: string | null;
  progress: { mode: TaskProgressMode; done: number; total: number };
  rows: number | null;
  /** .466: short outcome line from the backend (flatten results, cancel
      reasons) -- server.py has emitted this since the flatten work; the
      interface finally admits it. Optional: older payloads omit it.
      Windows tsc caught the drift; esbuild alone never type-checks. */
  note?: string;
  error: string | null;
  engine: string | null;
  cancellable: boolean;
  started: number | null;
}

// Live activity dashboard. GET /api/status returns the in-flight operations
// with their progress, per-engine lock-held state, thread count, restore flag,
// and the most recent stall the watchdog recorded.
export interface StatusOp {
  id: string;
  kind: string;
  target: string | null;
  engine: string | null;
  rows: number;
  // Determinate progress, present only for ops whose size is known up front
  // (iterators, while-loops, folder loads). percent is null for a single
  // opaque query -> the UI shows an indeterminate bar instead of a false %.
  done?: number | null;
  total?: number | null;
  unit?: string | null;
  percent?: number | null;
  elapsed_s: number;
  surface?: "ide" | "journal" | "node" | string | null;
  label?: string | null;
  idle_s: number;
  // True iff this op runs under a real run id and can be cancelled via
  // cancel_query (foreground runs + bg ops). Loads cancel via their tray job;
  // restore is uncancellable by design -> false for both.
  cancellable?: boolean;
}

export interface EngineStatus {
  active: boolean;
  busy: boolean;
}

export interface ActivityStatus {
  operations: StatusOp[];
  engines: { sqlite: EngineStatus; duckdb: EngineStatus };
  threads: number;
  restoring: boolean;
  last_stall: (StatusOp & { at: number }) | null;
  stall_log: string | null;
  last_error?: {
    ts: string;
    error: string;
    kind: string;
    status: number;
    route: string;
    age_s: number;
  } | null;
}

export interface EngineResetResult {
  ok: boolean;
  reset: string[];
  rebuilding: boolean;
}

// --- diagnostics (Error log -> Diagnostics tab) ---
export interface DiagnosticParam {
  name: string;
  label: string;
  type: "text" | "int" | "table" | "bool";
  default?: unknown;
}
export interface DiagnosticMeta {
  name: string;
  label: string;
  description: string;
  params: DiagnosticParam[];
}
export interface DiagnosticsList {
  diagnostics: DiagnosticMeta[];
  environment: Record<string, unknown>;
}
export interface DiagnosticRun {
  ok: boolean;
  name: string;
  result?: Record<string, unknown>;
  error?: string;
  traceback?: string;
}
