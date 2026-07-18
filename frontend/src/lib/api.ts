import type {
  Health, TableInfo, ResultPage, LoadResult, TableProfile,
  HistoryEntry, SavedQuery, ChartSpec, ChartData, PivotResult, ErrorLogEntry,
  ReconcileResult, FormatResult, StatementSpan, Cell, MemInfo,
  LoadedTable, FsListing, LoadProgress, JobSummary, ColumnFilter,
  ReconcileDrill, ActivityStatus, EngineResetResult,
  TaskCard, DiagnosticsList, DiagnosticRun,
  AssistantStatus, AssistantChatResult,
} from "./types";
import { buildLoadForm } from "./loadForm";
import type { ReconcileDetailRequest } from "./reconcileRequest";

/** Stamp IDE/Journal ranDataEpoch from the result snapshot, not the catalog poll. */
export function stampResultEpoch(
  res: { data_epoch?: number | null } | null | undefined,
  fallback: number,
): number {
  const n = Number(res?.data_epoch);
  return Number.isFinite(n) ? n : fallback;
}

// All requests are same-origin: in production the Python server serves
// both the static app and /api; in dev Vite proxies /api to the backend.
const BASE = "";

let _apiToken: string | null | undefined;
let _warnedMissingDevToken = false;
export function getApiToken(): string {
  if (_apiToken !== undefined) return _apiToken || "";
  // Dev/Vite can inject a token. Production delivers the capability via an
  // HttpOnly cookie (credentials: same-origin); the HTML shell no longer
  // embeds the secret in a scrapeable meta tag. Under Vite the proxy also
  // injects X-SamQL-Token when SAMQL_API_TOKEN / VITE_SAMQL_API_TOKEN is set.
  const fromDev =
    ((import.meta as any).env?.VITE_SAMQL_API_TOKEN as string | undefined)?.trim() ||
    "";
  if (
    !fromDev &&
    typeof import.meta !== "undefined" &&
    (import.meta as any).env?.DEV &&
    !_warnedMissingDevToken
  ) {
    _warnedMissingDevToken = true;
    try {
      console.warn(
        "[SamQL] VITE_SAMQL_API_TOKEN is unset. In Vite, API calls need " +
          "SAMQL_API_TOKEN and VITE_SAMQL_API_TOKEN set to the same value " +
          "(or rely on the Vite proxy injecting SAMQL_API_TOKEN).",
      );
    } catch {
      // Non-browser.
    }
  }
  _apiToken = fromDev || null;
  return _apiToken || "";
}

// Track in-flight requests that own their AbortController, so a recovery action
// (engine reset) can free the browser's small per-host connection pool. Under
// heavy load, requests blocked on a busy engine can occupy every slot, and the
// reset request itself then can't get through -- the symptom being a reset that
// stalls until a full page reload. abortInflight() mirrors what a reload does
// (abort everything) without losing app state. Requests that pass their own
// signal (long query/load, cancelled via Stop) are left alone.
const _inflight = new Set<AbortController>();

export function abortInflight(): number {
  const ctrls = Array.from(_inflight);
  _inflight.clear();
  for (const c of ctrls) {
    try {
      c.abort();
    } catch {
      /* ignore */
    }
  }
  return ctrls.length;
}

// Background ops (profile, save-as-table, change column type, flatten) pass
// their OWN AbortController, so they're deliberately not in _inflight (a
// superseded/closed one is cancelled individually). They register a cancel
// here too, so a global reset (which aborts everything) can stop them without
// React prop-drilling across component boundaries.
const _bgCancels = new Set<() => void>();
export function registerBgCancel(fn: () => void): () => void {
  _bgCancels.add(fn);
  return () => {
    _bgCancels.delete(fn);
  };
}
export function cancelAllBgOps(): void {
  for (const fn of Array.from(_bgCancels)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

// A request that supplies no signal is bounded by a wall-clock timeout so a
// wedged backend socket can't leave the promise unsettled forever (which would
// exhaust the browser's per-host connection pool and stall the UI). Quick ops
// (metadata, mutations, status, job-starts, cancels, paging, schema inspect)
// get this backstop automatically. Data-volume ops -- whose runtime scales with
// the user's data and can legitimately run for many minutes -- opt out below;
// they stay cancellable via Stop / window-close / abortInflight instead.
const DEFAULT_TIMEOUT_MS = 180000; // 3 min backstop for "should be quick" calls
const UNBOUNDED_ENDPOINTS = new Set<string>([
  "/api/nodeflow/run",
  "/api/nodeflow/write",
  "/api/nodeflow/export",
  "/api/nodeflow/export-many",
  "/api/nodeflow/reconcile",
  "/api/nodeflow/validate",
  "/api/nodeflow/chart",
  "/api/nodeflow/browse",
  "/api/nodeflow/run-batch",
  "/api/iterator/run",
  "/api/while/run",
  "/api/node-api-fetch",
  "/api/node-source-fetch",
  "/api/sharepoint/download",
  "/api/reconcile",
  "/api/catalog/import",
  "/api/run-tests",
  "/api/chart/data",
  "/api/pivot",
  "/api/load/files",
  "/api/load/files-start",
  "/api/excel/peek",
  "/api/load/sniff",
  "/api/directory/read",
  "/api/folder/read",
  "/api/assistant/chat",
]);
function isUnboundedPath(path: string): boolean {
  const p = path.split("?")[0];
  // reconcile drill-in / profile are reconcile sub-ops (same data volume)
  return UNBOUNDED_ENDPOINTS.has(p) || p.startsWith("/api/reconcile/");
}

type ApiRequestInit = RequestInit & { timeoutMs?: number };

function mergedHeaders(base: HeadersInit | undefined, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

async function apiFetch<T>(
  path: string,
  opts: ApiRequestInit = {},
  defaultHeaders?: HeadersInit,
): Promise<T> {
  const { timeoutMs, signal: callerSignal, headers: callerHeaders, ...rest } = opts;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signal: AbortSignal | null | undefined = callerSignal;
  const effTimeout =
    callerSignal != null
      ? 0
      : timeoutMs !== undefined
        ? timeoutMs
        : isUnboundedPath(path)
          ? 0
          : DEFAULT_TIMEOUT_MS;
  if (!callerSignal) {
    ctrl = new AbortController();
    signal = ctrl.signal;
    _inflight.add(ctrl);
    if (effTimeout && effTimeout > 0) {
      timer = setTimeout(() => {
        try {
          ctrl!.abort();
        } catch {
          /* ignore */
        }
      }, effTimeout);
    }
  }
  try {
    const headers = mergedHeaders(defaultHeaders, callerHeaders);
    const token = getApiToken();
    if (token && !headers.has("X-SamQL-Token")) {
      headers.set("X-SamQL-Token", token);
    }
    const res = await fetch(BASE + path, {
      ...rest,
      headers,
      credentials: rest.credentials ?? "same-origin",
      signal,
    });
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, text.slice(0, 500));
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, (data && data.error) || res.statusText);
    }
    return data as T;
  } catch (e: any) {
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new ApiError(
        0,
        effTimeout
          ? `Request timed out after ${Math.round(effTimeout / 1000)}s`
          : "Request aborted",
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (ctrl) _inflight.delete(ctrl);
  }
}

async function jsonFetch<T>(path: string, opts: ApiRequestInit = {}): Promise<T> {
  return apiFetch<T>(path, opts, { "Content-Type": "application/json" });
}

async function formFetch<T>(
  path: string,
  form: FormData,
  opts: Omit<ApiRequestInit, "body"> = {},
): Promise<T> {
  // Do not set Content-Type: fetch supplies the multipart boundary. The shared
  // request path still provides timeout handling and abortInflight() support.
  return apiFetch<T>(path, { ...opts, method: opts.method || "POST", body: form });
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export type RootIdChoice = {
  steps: string[];
  in_list?: string[] | null;
  map?: boolean;
  map_key?: string;
  label?: string;
};
export type RootIdCand = RootIdChoice & {
  type?: string | null;
  keys?: string[];
};

export type LoadThresholdField = {
  value: number;
  source: "override" | "env" | "default" | string;
  default: number;
  env: string;
  unit: string;
  label: string;
  help: string;
  min: number;
  max: number;
  kind: "int" | "float" | string;
  zero_means?: string | null;
};

export type LoadThresholdsInfo = {
  ok?: boolean;
  thresholds: Record<string, LoadThresholdField>;
  overrides?: Record<string, number>;
};

export type AssistantModelEntry = {
  id: string;
  path: string;
  label: string;
  exists?: boolean;
};

export type AssistantApiInfo = {
  base_url?: string | null;
  model?: string | null;
  has_api_key?: boolean;
  secrets_available?: boolean;
  configured?: boolean;
};

export type AssistantApiProbe = {
  ok: boolean;
  probe?: string;
  error?: string;
  base_url?: string;
  model?: string;
  model_ids?: string[];
  status_code?: number;
  has_choices?: boolean;
};

export type AssistantModelsInfo = {
  ok?: boolean;
  mode?: "local" | "api";
  models: AssistantModelEntry[];
  selected_id: string | null;
  use_default: boolean;
  active_model?: string | null;
  active_model_name?: string | null;
  using_default?: boolean;
  preferred_missing?: boolean;
  default_model?: string | null;
  pack_ok?: boolean;
  pack_hint?: string | null;
  server_url?: string | null;
  api?: AssistantApiInfo;
  api_probe?: AssistantApiProbe;
  status?: AssistantStatus;
  retarget?: { stopped?: boolean; reason?: string };
};

export interface FlowCacheInfo {
  ok?: boolean;
  error?: string;
  enabled: boolean;
  configured_mb_max: number;
  persistent_configured_mb_max: number;
  adaptive_resources: boolean;
  parallel_nodeflows: boolean;
  parallel_workers_configured: number;
  parallel_workers_effective: number;
  resource_budget: {
    memory_total_mb: number;
    memory_available_mb: number;
    disk_free_gb: number;
    recommended_engine_mb: number;
    recommended_flow_cache_mb: number;
    recommended_persistent_cache_mb: number;
    recommended_parallel_workers: number;
    engine_memory_mb: number;
    flow_cache_mb: number;
    persistent_cache_mb: number;
    parallel_workers: number;
    pressure: string;
  };
  persistent_enabled: boolean;
  persistent: {
    path: string;
    size: number;
    bytes: number;
    mb: number;
    bytes_max: number;
    mb_max: number;
    max_age_days: number;
    hits: number;
    misses: number;
    writes: number;
    evictions: number;
    oversized: number;
    skips: number;
    pinned: number;
    errors: number;
    largest: Array<{ file: string; bytes: number; mb: number }>;
  };
  size: number;
  max: number;
  bytes: number;
  bytes_max: number;
  mb: number;
  mb_max: number;
  hits: number;
  misses: number;
  evictions: number;
  oversized: number;
  stale: number;
  hit_rate: number | null;
  cleared?: number;
  persistent_cleared?: number;
  largest: Array<{
    fingerprint: string;
    table: string;
    engine: string;
    bytes: number;
    mb: number;
  }>;
}

export const api = {
  about: aboutInfo,
  tableProperties: tablePropertiesInfo,
  health: () =>
    jsonFetch<Health>("/api/health", { timeoutMs: 3500, cache: "no-store" }),

  // Live activity dashboard + recovery. Both are bounded so the connection-
  // status window can't hang on a poll and the reset can't stick on
  // "Resetting…" forever when the engine is bottlenecked. (abortInflight is a
  // standalone export, since it makes no /api call of its own.)
  status: () => jsonFetch<ActivityStatus>("/api/status", { timeoutMs: 8000 }),
  // Optional SQL assistant (local llama.cpp pack and/or OpenAI-compatible
  // API; DuckDB-idle gated).
  assistantStatus: () =>
    jsonFetch<AssistantStatus>("/api/assistant/status", { timeoutMs: 8000 }),
  assistantChat: (
    question: string,
    dialect: string = "native",
    opts?: { signal?: AbortSignal },
  ) =>
    jsonFetch<AssistantChatResult>("/api/assistant/chat", {
      method: "POST",
      body: JSON.stringify({ question, dialect }),
      signal: opts?.signal,
    }),
  assistantCancel: () =>
    jsonFetch<{ ok: boolean }>("/api/assistant/cancel", {
      method: "POST",
      body: "{}",
      timeoutMs: 8000,
    }),
  assistantModelsInfo: () =>
    jsonFetch<AssistantModelsInfo>("/api/settings/assistant-models"),
  assistantModelsConfigure: (opts: {
    add?: { path: string; label?: string } | string;
    remove_id?: string;
    selected_id?: string | null;
    use_default?: boolean;
    clear?: boolean;
    mode?: "local" | "api";
    api?: {
      base_url?: string;
      model?: string;
      api_key?: string;
      clear_api_key?: boolean;
    };
    clear_api?: boolean;
    test_api?: boolean;
  }) =>
    jsonFetch<AssistantModelsInfo>("/api/settings/assistant-models", {
      method: "POST",
      body: JSON.stringify(opts),
    }),
  // The unified activity feed: every background task normalized into a card.
  // The tray polls this in place of the per-task progress modals.
  tasks: () => jsonFetch<{ tasks: TaskCard[] }>("/api/tasks", { timeoutMs: 8000 }),
  // Toggle DuckDB concurrent ("async") reads at runtime; POST {} reports
  // current state, POST {on} sets it. Returns the resulting state.
  setConcurrentReads: (on: boolean) =>
    jsonFetch<{ concurrent_reads: boolean }>(
      "/api/settings/concurrent-reads",
      { method: "POST", body: JSON.stringify({ on }) },
    ),
  // Toggle "flatten JSON on load"; POST {on} sets it, returns resulting state.
  // Soft recovery: swap in fresh engines and rebuild loaded tables from the
  // manifest. Does not wipe journal/NodeFlow or reload the page.
  engineReset: (which: "all" | "duckdb" | "sqlite" = "all") =>
    jsonFetch<EngineResetResult>("/api/engine/reset", {
      method: "POST",
      body: JSON.stringify({ which }),
      timeoutMs: 30000,
    }),
  // .523: the nuclear reset -- kill + wipe everything server-side; the
  // caller hard-reloads the page right after (startup state, both sides).
  nuke: () =>
    jsonFetch<{ ok: boolean }>("/api/nuke", {
      method: "POST",
      body: "{}",
      timeoutMs: 8000,
    }),

  // --- diagnostics (Error log -> Diagnostics tab) ---
  // List available diagnostics + a ready environment report.
  diagnostics: () =>
    jsonFetch<DiagnosticsList>("/api/diagnostics", { timeoutMs: 15000 }),
  // Run one diagnostic by name with params; never rejects on a diagnostic
  // failure (the failure is in the result payload).
  runDiagnostic: (name: string, params: Record<string, unknown>) =>
    jsonFetch<DiagnosticRun>("/api/diagnostics/run", {
      method: "POST",
      body: JSON.stringify({ name, params }),
      timeoutMs: 300000,
    }),

  tables: () =>
    jsonFetch<{ tables: TableInfo[]; data_epoch?: number }>("/api/tables").then(
      (d) => ({
        tables: d.tables || [],
        data_epoch: Number.isFinite(d.data_epoch) ? Number(d.data_epoch) : 0,
      }),
    ),
  /** Persist Loaded-tables drag order for the current session. */
  reorderTables: (order: { engine: string; name: string }[]) =>
    jsonFetch<{ ok: boolean; order?: string[] }>("/api/tables/reorder", {
      method: "POST",
      body: JSON.stringify({ order }),
    }),
  columnFields: (
    engine: string,
    table: string,
    column: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      type?: string;
      fields: {
        depth: number;
        name: string;
        type: string;
        kind: string;
        path?: string | null;
        note?: string | null;
        column?: string;
        access?: {
          first?: string;
          sel?: string;
          unnests?: string[];
          recursive?: string;
          note?: string;
          alt?: {
            first?: string;
            sel?: string;
            unnests?: string[];
            recursive?: string;
            note?: string;
          };
        };
      }[];
    }>("/api/column/fields", {
      method: "POST",
      body: JSON.stringify({ engine, table, column }),
      signal,
    }),

  /** Unified Field Explorer tree: one loaded table → all columns + nests.
   *  Optional ``after`` resumes after a top-level column; ``query_id`` lets
   *  modal-close cancel further nested discovery (discovery-only). */
  tableFields: (
    engine: string,
    table: string,
    signal?: AbortSignal,
    opts?: { after?: string | null; query_id?: string; budget_sec?: number },
  ) =>
    jsonFetch<{
      ok?: boolean;
      error?: string;
      table?: string;
      partial?: boolean;
      next_after?: string | null;
      cancelled?: boolean;
      fields: {
        depth: number;
        name: string;
        type: string;
        kind: string;
        path?: string | null;
        note?: string | null;
        column?: string;
        access?: {
          first?: string;
          sel?: string;
          unnests?: string[];
          recursive?: string;
          note?: string;
          alt?: {
            first?: string;
            sel?: string;
            unnests?: string[];
            recursive?: string;
            note?: string;
          };
        };
      }[];
    }>(`/api/table/${encodeURIComponent(table)}/fields`, {
      method: "POST",
      body: JSON.stringify({
        engine,
        after: opts?.after ?? undefined,
        query_id: opts?.query_id,
        budget_sec: opts?.budget_sec,
      }),
      signal,
    }),

  columnAccessPreview: (
    engine: string,
    table: string,
    column: string,
    opts?: { field_idx?: number; field_path?: string },
  ) =>
    jsonFetch<{
      ok: boolean;
      sample?: unknown;
      sql?: string;
      all_sql?: string;
      error?: string;
      style?: string;
      access?: {
        first?: string;
        sel?: string;
        unnests?: string[];
        recursive?: string;
        note?: string;
      };
      field?: {
        depth?: number;
        name?: string;
        type?: string;
        kind?: string;
        path?: string | null;
      };
      fields?: unknown[];
      type?: string;
    }>("/api/column/access-preview", {
      method: "POST",
      body: JSON.stringify({
        engine,
        table,
        column,
        field_idx: opts?.field_idx,
        field_path: opts?.field_path,
      }),
    }),

  // --- loading ---
  loadFiles: async (
    files: FileList | File[],
    destination = "auto",
    delimiter?: string,
    sheet?: string,
    headerRow?: number,
    mode = "materialize",
    exclude?: string,
  ): Promise<LoadResult> => {
    const form = buildLoadForm(files, {
      destination,
      delimiter,
      sheet,
      headerRow,
      mode,
      exclude,
    });
    return formFetch<LoadResult>("/api/load/files", form);
  },

  // upload files, then load them in the background so the load can be polled
  // and cancelled mid-flight (used by drag-and-drop)
  loadFilesStart: async (
    files: FileList | File[],
    destination = "auto",
    delimiter?: string,
    sheet?: string,
    headerRow?: number,
    mode = "materialize",
    exclude?: string,
    opts?: { flatten?: boolean; shred?: boolean; root_id?: RootIdChoice },
  ): Promise<{ job_id: string; bytes_total: number; name: string; files: number }> => {
    const form = buildLoadForm(files, {
      destination,
      delimiter,
      sheet,
      headerRow,
      mode,
      exclude,
      flatten: opts?.flatten,
      shred: opts?.shred,
      rootId: opts?.root_id,
    });
    return formFetch<{
      job_id: string;
      bytes_total: number;
      name: string;
      files: number;
    }>("/api/load/files-start", form);
  },

  // list the sheet names of an Excel workbook already on the server's disk
  excelSheets: (path: string) =>
    jsonFetch<{ sheets: string[] }>("/api/excel/sheets", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  // discover nested fields in a JSON file on disk (for the skip checkboxes)
  jsonFields: (path: string, budget?: number) =>
    jsonFetch<{
      sampled: number;
      complete: boolean;
      scan_s: number;
      fields: {
        key: string;
        kind: "array" | "object";
        depth: number;
        count: number;
        max_items: number;
      }[];
    }>("/api/json/fields", {
      method: "POST",
      body: JSON.stringify({ path, budget }),
      timeoutMs: 120000,
    }),

  // list the sheet names of an uploaded (dropped) workbook without loading it
  excelPeek: async (
    file: File,
    signal?: AbortSignal,
  ): Promise<{ sheets: string[] }> => {
    const fd = new FormData();
    fd.append("files", file, file.name);
    return formFetch<{ sheets: string[] }>("/api/excel/peek", fd, { signal });
  },

  // browse the server's local filesystem (localhost-only tool)
  fsList: (path?: string, signal?: AbortSignal) =>
    jsonFetch<FsListing>(
      "/api/fs/list" + (path ? `?path=${encodeURIComponent(path)}` : ""),
      { signal },
    ),

  // start a background load and poll its progress
  // .521: pre-load schema sniff for the root_id dropdown. Path mode for the
  // server file browser; sample mode (a small prefix Blob) for drag-drop.
  loadSniff: async (src: {
    path?: string;
    sample?: Blob;
    name?: string;
  }): Promise<{
    ok?: boolean;
    promote?: boolean;
    candidates?: RootIdCand[];
    error?: string;
  }> => {
    if (src.sample) {
      const fd = new FormData();
      fd.append("files", src.sample, src.name || "sample.json");
      return formFetch("/api/load/sniff", fd);
    }
    return jsonFetch("/api/load/sniff", {
      method: "POST",
      body: JSON.stringify({ path: src.path }),
      timeoutMs: 20000,
    });
  },

  loadStart: (
    path: string,
    destination = "auto",
    delimiter?: string,
    mode = "materialize",
    sheet?: string,
    headerRow?: number,
    exclude?: string,
    opts?: { flatten?: boolean; shred?: boolean; root_id?: RootIdChoice },
  ) =>
    jsonFetch<{ job_id: string; bytes_total: number; name: string }>(
      "/api/load/start",
      {
        method: "POST",
        body: JSON.stringify({
          path, destination, delimiter, mode, sheet, header_row: headerRow,
          exclude,
          ...(opts && opts.flatten !== undefined
            ? { flatten: opts.flatten } : {}),
          ...(opts && opts.shred ? { shred: true } : {}),
          ...(opts && opts.root_id ? { root_id: opts.root_id } : {}),
        }),
      },
    ),
  loadFolderStart: (
    path: string,
    destination = "auto",
    recursive = false,
    delimiter?: string,
  ) =>
    jsonFetch<{
      job_id: string;
      bytes_total: number;
      name: string;
      files: number;
    }>("/api/load/folder", {
      method: "POST",
      body: JSON.stringify({ path, destination, recursive, delimiter }),
    }),
  loadProgress: (jobId: string) =>
    jsonFetch<LoadProgress>(
      `/api/load/progress/${encodeURIComponent(jobId)}`,
    ),
  loadJobs: () => jsonFetch<{ jobs: JobSummary[] }>("/api/load/jobs"),
  loadCancel: (jobId: string) =>
    jsonFetch<{ ok: boolean; cancelled: boolean; state?: string }>(
      `/api/load/cancel/${encodeURIComponent(jobId)}`,
      { method: "POST" },
    ),

  // drop one finished task card from the feed for good (so a reopened modal
  // doesn't resurrect it); a running task is never dropped here
  dismissTask: (id: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/tasks/${encodeURIComponent(id)}/dismiss`,
      { method: "POST" },
    ),
  // drop every finished task card at once ("Clear all"); running tasks stay
  clearCompletedTasks: () =>
    jsonFetch<{ ok: boolean; cleared: number }>("/api/tasks/clear-completed", {
      method: "POST",
    }),

  apiFetch: (
    body: {
      url: string;
      base_name?: string;
      auth_user?: string;
      auth_pass?: string;
      json_path?: string;
      params?: Record<string, string>;
      destination?: string;
      secret_key?: string;
    },
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok: boolean;
      status?: number;
      tables?: any[];
      error?: string;
      cancelled?: boolean;
    }>("/api/api-fetch", {
      method: "POST",
      body: JSON.stringify({ ...body, query_id: queryId }),
      signal,
    }),

  apiPreview: (body: {
    url: string;
    auth_user?: string;
    auth_pass?: string;
    json_path?: string;
    params?: Record<string, string>;
    secret_key?: string;
  }) =>
    jsonFetch<{
      ok: boolean;
      status?: number;
      url?: string;
      count?: number;
      shown?: number;
      truncated?: boolean;
      sample?: string;
      error?: string;
    }>("/api/api-preview", { method: "POST", body: JSON.stringify(body) }),

  nodeApiFetch: (
    body: {
      node_id: string;
      config: unknown;
      graph?: unknown;
      query_id?: string;
    },
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      fetched?: boolean;
      cancelled?: boolean;
      table?: string;
      engine?: string;
      columns?: string[];
      rows?: number;
      err_table?: string;
      err_rows?: number;
      error_captured?: string;
      url?: string;
      status?: number;
      error?: string;
    }>("/api/node-api-fetch", {
      signal,
      method: "POST",
      body: JSON.stringify(body),
    }),

  nodeSourceFetch: (
    body: {
      type: string;
      node_id: string;
      config: unknown;
      graph?: unknown;
      query_id?: string;
    },
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      fetched?: boolean;
      cancelled?: boolean;
      table?: string;
      engine?: string;
      columns?: string[];
      rows?: number;
      err_table?: string;
      err_rows?: number;
      error_captured?: string;
      url?: string;
      status?: number;
      error?: string;
      meta?: unknown;
    }>("/api/node-source-fetch", {
      signal,
      method: "POST",
      body: JSON.stringify(body),
    }),

  sharepointDownload: (
    body: {
      config: unknown;
      query_id?: string;
    },
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      path?: string;
      filename?: string;
      bytes?: number;
      error?: string;
      cancelled?: boolean;
      meta?: unknown;
    }>("/api/sharepoint/download", {
      signal,
      method: "POST",
      body: JSON.stringify(body),
    }),

  sharepointAuthCapabilities: () =>
    jsonFetch<{
      msal?: boolean;
      windows_negotiate?: boolean;
      default_client_id?: string;
      default_tenant?: string;
      modes?: string[];
      error?: string;
    }>("/api/sharepoint/auth/capabilities", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  sharepointAuthDeviceStart: (body: { config: unknown }) =>
    jsonFetch<{
      ok?: boolean;
      flow_id?: string;
      user_code?: string;
      verification_uri?: string;
      message?: string;
      secret_key?: string;
      expires_in?: number;
      error?: string;
    }>("/api/sharepoint/auth/device/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  sharepointAuthDevicePoll: (body: { flow_id: string; block?: boolean }) =>
    jsonFetch<{
      ok?: boolean;
      pending?: boolean;
      stored?: boolean;
      secret_key?: string;
      available?: boolean;
      error?: string;
    }>("/api/sharepoint/auth/device/poll", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  sharepointAuthInteractive: (body: { config: unknown }) =>
    jsonFetch<{
      ok?: boolean;
      stored?: boolean;
      secret_key?: string;
      available?: boolean;
      error?: string;
    }>("/api/sharepoint/auth/interactive", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  iteratorRun: (body: { node_id: string; graph: unknown; query_id?: string }) =>
    jsonFetch<{
      ok?: boolean;
      passes?: number;
      attempted?: number;
      rows?: number;
      table?: string;
      engine?: string;
      errors?: { value: string; error: string }[];
      note?: string;
      error?: string;
      cancelled?: boolean;
    }>("/api/iterator/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  whileRun: (body: { node_id: string; graph: unknown; query_id?: string }) =>
    jsonFetch<{
      ok?: boolean;
      iterations?: number;
      converged?: boolean;
      rows?: number;
      table?: string;
      engine?: string;
      note?: string;
      error?: string;
      cancelled?: boolean;
    }>("/api/while/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // --- saved secrets (DPAPI-encrypted passwords) ---
  secretSet: (key: string, value: string) =>
    jsonFetch<{ ok: boolean; available: boolean }>("/api/secrets/set", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),
  secretDelete: (key: string) =>
    jsonFetch<{ ok: boolean }>("/api/secrets/delete", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  secretStatus: (keys: string[]) =>
    jsonFetch<{ available: boolean; saved: Record<string, boolean> }>(
      "/api/secrets/status",
      { method: "POST", body: JSON.stringify({ keys }) },
    ),

  // --- named connection profiles (fields + DPAPI secret by key) ---
  connectionProfilesList: () =>
    jsonFetch<{
      profiles: Array<{
        key: string;
        kind: string;
        name: string;
        fields: Record<string, unknown>;
        has_secret?: boolean;
      }>;
      secrets_available: boolean;
    }>("/api/connection-profiles/list", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  connectionProfilesUpsert: (body: {
    kind: string;
    name: string;
    fields: Record<string, unknown>;
    password?: string;
  }) =>
    jsonFetch<{
      ok: boolean;
      profile: Record<string, unknown>;
      has_secret: boolean;
      secrets_available: boolean;
    }>("/api/connection-profiles/upsert", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  connectionProfilesDelete: (key: string) =>
    jsonFetch<{ ok: boolean }>("/api/connection-profiles/delete", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  connectionProfilesGet: (key: string) =>
    jsonFetch<{
      profile: Record<string, unknown>;
      has_secret: boolean;
      secrets_available: boolean;
    }>("/api/connection-profiles/get", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  // --- query / results ---
  query: (
    sql: string,
    target = "auto",
    read_only = false,
    query_id?: string,
    signal?: AbortSignal,
    dialect?: string,
    reuse?: Record<string, string>,
    opts?: { surface?: string; label?: string;
             per_statement?: boolean; preview_limit?: number },
  ) =>
    jsonFetch<ResultPage & { reuse_stale?: string[] }>("/api/query", {
      method: "POST",
      body: JSON.stringify({
        sql,
        target,
        read_only,
        query_id,
        dialect,
        ...(reuse && Object.keys(reuse).length ? { reuse } : {}),
        ...(opts || {}),
      }),
      signal,
    }),

  cancelQuery: (queryId: string) =>
    jsonFetch<{ ok: boolean; cancelled: boolean }>(
      `/api/query/${encodeURIComponent(queryId)}/cancel`,
      { method: "POST" },
    ),

  storageReport: () =>
    jsonFetch<{
      instance: { path: string; bytes: number; results_bytes: number;
        spill_bytes: number };
      other_instances: { count: number; bytes: number; dead: number };
      filecache: { path: string; count: number; bytes: number;
        budget_gb: number };
      mei_orphans: { count: number; bytes: number };
    }>("/api/storage/report"),

  storageClean: (what: {
    orphans?: boolean;
    filecache?: boolean;
    webview_cache?: boolean;
  }) =>
    jsonFetch<{
      ok: boolean;
      freed: { orphans: number; filecache: number; webview_cache: number };
      note?: string;
    }>(
      "/api/storage/clean",
      { method: "POST", body: JSON.stringify(what) },
    ),

  shredPreflight: (engine: string, table: string) =>
    jsonFetch<{
      table: string;
      gates: { name: string; ok: boolean; detail: string }[];
      columns: { name: string; type: string; arrays: number;
        reason: string }[];
      candidates: string[];
      verdict: string;
    }>(
      `/api/shred/preflight?engine=${encodeURIComponent(engine)}` +
        `&table=${encodeURIComponent(table)}`,
    ),

  shredPlan: (engine: string, table: string, column: string, base?: string) =>
    jsonFetch<{
      error?: string;
      source?: string;
      notes?: string[];
      tables?: {
        name: string;
        path: string;
        keys: string[];
        parent: string | null;
        depth: number;
        fields: string[];
        child_arrays: string[];
      }[];
    }>("/api/shred/plan", {
      method: "POST",
      body: JSON.stringify({ engine, table, column, base }),
    }),

  shredRun: (
    engine: string,
    table: string,
    column: string,
    tables: string[],
    base?: string,
    queryId?: string,
  ) =>
    jsonFetch<{
      ok?: boolean;
      error?: string;
      cancelled?: boolean;
      created?: { name: string; keys: string[] }[];
    }>("/api/shred/run", {
      method: "POST",
      body: JSON.stringify({
        engine,
        table,
        column,
        tables,
        base,
        query_id: queryId,
      }),
      timeoutMs: 0,
    }),

  resultCell: (args: {
    result_id: string;
    row: number;
    column: string;
    sort_col?: string | null;
    descending?: boolean;
    filters?: any;
  }) =>
    jsonFetch<{
      value?: unknown;
      length?: number | null;
      clipped?: boolean;
      error?: string;
    }>("/api/result/cell", { method: "POST", body: JSON.stringify(args) }),

  engineTuning: (opts: { memory_gb?: number; threads?: number }) =>
    jsonFetch<{
      ok?: boolean;
      busy?: boolean;
      error?: string;
      memory_limit?: string | null;
      threads?: number | null;
      note?: string;
    }>("/api/engine/tuning", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  flowCacheInfo: () =>
    jsonFetch<FlowCacheInfo>("/api/settings/flow-cache"),

  flowCacheConfigure: (opts: {
    enabled?: boolean;
    max_entries?: number;
    max_mb?: number;
    adaptive_resources?: boolean;
    parallel_nodeflows?: boolean;
    parallel_workers?: number;
    persistent_enabled?: boolean;
    persistent_max_mb?: number;
    persistent_days?: number;
    clear?: boolean;
    reset_stats?: boolean;
    clear_persistent?: boolean;
  }) =>
    jsonFetch<FlowCacheInfo>("/api/settings/flow-cache", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  loadThresholdsInfo: () =>
    jsonFetch<LoadThresholdsInfo>("/api/settings/load-thresholds"),

  loadThresholdsConfigure: (opts: {
    thresholds?: Record<string, number>;
    reset?: boolean;
  }) =>
    jsonFetch<LoadThresholdsInfo>("/api/settings/load-thresholds", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  loadPreflight: (path: string) =>
    jsonFetch<{
      ok: boolean;
      path: string;
      exists: boolean;
      size: number;
      size_mb: number;
      ext: string;
      duckdb: boolean;
      disk_free_gb: number | null;
      warnings: string[];
      blockers: string[];
    }>("/api/load/preflight", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  // Global halt: stop every in-flight background task (load / convert /
  // flatten) and interrupt every engine. The NodeFlow Stop calls this so its
  // button halts background work too, not just foreground runs.
  cancelAll: () =>
    jsonFetch<{ ok: boolean }>("/api/cancel-all", { method: "POST" }),

  page: (
    resultId: string,
    opts: {
      offset?: number;
      limit?: number;
      sort_col?: string | null;
      descending?: boolean;
      filters?: ColumnFilter[];
      columns?: string[];
      query_id?: string; // .520: lets a Cancel abort this page's SEND too
    } = {},
    signal?: AbortSignal,
  ) =>
    jsonFetch<ResultPage>(`/api/result/${encodeURIComponent(resultId)}/page`, {
      method: "POST",
      body: JSON.stringify(opts),
      signal,
    }),

  discardResult: (resultId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/result/${encodeURIComponent(resultId)}`, {
      method: "DELETE",
    }),

  materializeResult: (
    resultId: string,
    name: string,
    target?: string,
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      rows?: number;
      engine?: string;
      error?: string;
      cancelled?: boolean;
    }>(`/api/result/${encodeURIComponent(resultId)}/materialize`, {
      method: "POST",
      body: JSON.stringify({ name, target: target || "auto", query_id: queryId }),
      signal,
    }),



  // .540: the FULL failed-values CSV for a reconcile -- every
  // mismatching key + field with its left/right values, written into
  // Downloads server-side. Cancellable via the Activity card's X.
  reconFailuresCsv: async (
    spec: any,
    exportId: string,
  ): Promise<{ path?: string; rows?: number; cancelled?: boolean }> => {
    const {
      registerRun,
      unregisterRun,
      isCancelledError,
      wasCancelled,
    } = await import("./runController");
    const ctrl = new AbortController();
    registerRun(exportId, ctrl);
    try {
      const data = await jsonFetch<{
        ok: boolean;
        path?: string;
        rows?: number;
        cancelled?: boolean;
      }>("/api/reconcile/failures", {
        method: "POST",
        signal: ctrl.signal,
        body: JSON.stringify({ ...spec, export_id: exportId }),
      });
      if (data.cancelled || wasCancelled(exportId)) return { cancelled: true };
      return { path: data.path, rows: data.rows };
    } catch (e: any) {
      if (isCancelledError(e, exportId) || wasCancelled(exportId))
        return { cancelled: true };
      throw e;
    } finally {
      unregisterRun(exportId, ctrl);
    }
  },
  // .539: write the lineage workbook server-side into Downloads (the
  // blob anchor is a no-op in the native window -- the .510 class).
  saveLineage: async (
    graph: any,
  ): Promise<{ path: string; filename: string }> =>
    jsonFetch<{ path: string; filename: string }>("/api/nodeflow/lineage", {
      method: "POST",
      body: JSON.stringify({ graph, save: true }),
    }),

  /** Column lineage for the results-grid modal (JSON stages + change summaries). */
  columnLineage: (
    graph: any,
    column: string,
    opts?: {
      node?: string | null;
      port?: string | null;
      rowIndex?: number | null;
      cellValue?: unknown;
      signal?: AbortSignal;
    },
  ) =>
    jsonFetch<{
      ok?: boolean;
      available: boolean;
      column: string;
      terminal_node?: string;
      terminal_port?: string;
      sql_flagged?: boolean;
      reason?: string | null;
      row_index?: number | null;
      stages: {
        id: string;
        kind: string;
        column: string;
        node_id: string;
        node_type: string;
        node_label: string;
        step: string;
        change: {
          summary: string;
          detail?: string;
          inputs?: string[];
          output?: string;
          expression?: string | null;
          mapping?: { from: string; to: string } | null;
          predicate?: string | null;
          unchanged?: boolean;
        };
        value?: {
          available: boolean;
          value: unknown;
          inputs?: { column: string; value: unknown; available: boolean }[];
          reason?: string | null;
          expression?: string | null;
        } | null;
      }[];
    }>("/api/nodeflow/column-lineage", {
      method: "POST",
      body: JSON.stringify({
        graph: graph || {},
        column,
        node: opts?.node || undefined,
        port: opts?.port || undefined,
        row_index:
          opts?.rowIndex === undefined || opts?.rowIndex === null
            ? undefined
            : opts.rowIndex,
        cell_value:
          opts?.cellValue === undefined ? undefined : opts.cellValue,
      }),
      signal: opts?.signal,
    }),

  // --- sql helpers ---
  formatSql: (sql: string) =>
    jsonFetch<FormatResult>("/api/sql/format", {
      method: "POST",
      body: JSON.stringify({ sql }),
    }),


  statementAt: (sql: string, pos: number) =>
    jsonFetch<StatementSpan>("/api/sql/statement-at", {
      method: "POST",
      body: JSON.stringify({ sql, pos }),
    }),

  // --- table ops ---
  profile: (
    name: string,
    engine = "sqlite",
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<TableProfile & { cancelled?: boolean }>(
      `/api/table/${encodeURIComponent(name)}/profile`,
      {
        method: "POST",
        body: JSON.stringify({ engine, query_id: queryId }),
        signal,
      },
    ),

  profileField: (spec: {
    result_id?: string | null;
    table?: string;
    engine?: string;
    column: string;
  }, queryId?: string, signal?: AbortSignal) =>
    jsonFetch<TableProfile & { cancelled?: boolean }>("/api/profile/field", {
      method: "POST",
      signal,
      body: JSON.stringify({ ...spec, query_id: queryId }),
    }),

  renameTable: (engine: string, oldName: string, newName: string) =>
    jsonFetch<{ ok?: boolean; name?: string; error?: string }>(
      "/api/table/rename",
      {
        method: "POST",
        body: JSON.stringify({ engine, old: oldName, new: newName }),
      },
    ),

  dropTable: (engine: string, name: string) =>
    jsonFetch<{ ok: boolean }>("/api/table/drop", {
      method: "POST",
      body: JSON.stringify({ engine, name }),
    }),

  changeType: (
    engine: string,
    table: string,
    col: string,
    new_type: string,
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{ ok: boolean; cancelled?: boolean }>("/api/table/change-type", {
      method: "POST",
      body: JSON.stringify({ engine, table, col, new_type, query_id: queryId }),
      signal,
    }),

  // Materialise a SELECT into a named table (notebook reconcile cells stage
  // their cell inputs this way; the reconcile engine compares named tables).
  materialize: (
    name: string,
    sql: string,
    target = "auto",
    queryId?: string,
    signal?: AbortSignal,
    fromResult?: string,
  ) =>
    jsonFetch<{
      name?: string;
      columns?: string[];
      engine?: string;
      error?: string;
      cancelled?: boolean;
    }>("/api/materialize", {
      method: "POST",
      body: JSON.stringify({
        name,
        sql,
        target,
        query_id: queryId,
        ...(fromResult ? { from_result: fromResult } : {}),
      }),
      signal,
    }),

  clearAll: () =>
    jsonFetch<{ ok: boolean }>("/api/clear", { method: "POST" }),

  shutdownServer: () =>
    jsonFetch<{ ok: boolean; stopping?: boolean }>("/api/shutdown", {
      method: "POST",
    }),

  // --- memory ---
  memory: () => jsonFetch<MemInfo>("/api/memory"),
  freeMemory: () =>
    jsonFetch<MemInfo>("/api/memory/free", { method: "POST" }),
  sweepTemp: () =>
    jsonFetch<{ removed: number; instance_bytes: number }>(
      "/api/maintenance/sweep-temp",
      { method: "POST" },
    ),

  runTests: () =>
    jsonFetch<{
      available: boolean;
      reason?: string;
      ok?: boolean;
      returncode?: number;
      passed?: number | null;
      failed?: number | null;
      skipped?: number | null;
      summary?: string;
    }>("/api/run-tests", { method: "POST" }),

  // --- json flatten ---
  flattenJson: (
    engine: string,
    name: string,
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok: boolean;
      tables?: LoadedTable[];
      error?: string;
      cancelled?: boolean;
    }>(
      `/api/table/${encodeURIComponent(name)}/flatten`,
      {
        method: "POST",
        body: JSON.stringify({ engine, query_id: queryId }),
        signal,
      },
    ),

  /** Background relational flatten (Field Explorer). Keeps the source table;
   * scopes to column/path when provided. Optional root_id is carried onto
   * every family table as root_id (+ Master_Keys). */
  flattenTableStart: (
    engine: string,
    name: string,
    rootId?: RootIdChoice | null,
    column?: string | null,
    path?: string | null,
  ) =>
    jsonFetch<{ job_id: string; name: string }>(
      `/api/table/${encodeURIComponent(name)}/flatten-start`,
      {
        method: "POST",
        body: JSON.stringify({
          engine,
          ...(rootId ? { root_id: rootId } : {}),
          ...(column ? { column } : {}),
          ...(path ? { path } : {}),
        }),
        timeoutMs: 25000,
      },
    ),

  tableRootIdOptions: (engine: string, name: string) =>
    jsonFetch<{
      ok?: boolean;
      error?: string;
      candidates?: RootIdCand[];
      promote?: boolean;
      promote_col?: string | null;
    }>(`/api/table/${encodeURIComponent(name)}/root-id-options`, {
      method: "POST",
      body: JSON.stringify({ engine }),
    }),

  tableRootIdStats: (engine: string, name: string, rootId: RootIdChoice) =>
    jsonFetch<{
      ok?: boolean;
      error?: string;
      label?: string;
      records?: number;
      nonnull?: number;
      distinct?: number;
      duplicated?: number;
      nulls?: number;
      unique?: boolean;
      choice?: RootIdChoice;
    }>(`/api/table/${encodeURIComponent(name)}/root-id-stats`, {
      method: "POST",
      body: JSON.stringify({ engine, root_id: rootId }),
    }),

  // start an in-place JSON flatten in the background -> a cancellable card in
  // the activity tray + stat popover (with a live row count), instead of a
  // request that blocks until the (possibly long) flatten finishes
  history: () =>
    jsonFetch<{ history: HistoryEntry[] }>("/api/history").then(
      (d) => d.history,
    ),
  clearHistory: () =>
    jsonFetch<{ ok: boolean }>("/api/history", { method: "DELETE" }),

  // --- error log (server-side failures, for debugging) ---
  docsFunctions: () =>
    jsonFetch<{
      sqlite: { name: string; args?: number | null }[];
      duckdb: { name: string; type: string }[];
      counts: { sqlite: number; duckdb: number };
      note?: string;
    }>("/api/docs/functions"),
  errors: () =>
    jsonFetch<{
      errors: ErrorLogEntry[];
      count: number;
      version: string;
      // .409 on-disk twins (the 2026-07-03 on-box TS2339 pair)
      file?: { path: string; size: number; text: string };
      launcher?: { path: string; size: number; text: string };
    }>("/api/errors"),
  clearErrors: () =>
    jsonFetch<{ ok: boolean }>("/api/errors", { method: "DELETE" }),

  saved: () =>
    jsonFetch<{ saved: SavedQuery[] }>("/api/saved").then((d) => d.saved),
  saveQuery: (name: string, sql: string, tags?: string[]) =>
    jsonFetch<SavedQuery>("/api/saved", {
      method: "POST",
      body: JSON.stringify({ name, sql, tags }),
    }),
  deleteSaved: (name: string) =>
    jsonFetch<{ ok: boolean }>("/api/saved", {
      method: "DELETE",
      body: JSON.stringify({ name }),
    }),

  // --- analytics ---
  chart: (spec: ChartSpec, signal?: AbortSignal) =>
    jsonFetch<ChartData>("/api/chart/data", {
      method: "POST",
      body: JSON.stringify(spec),
      signal,
    }),

  pivot: (spec: {
    result_id?: string;
    table?: string;
    engine?: string;
    rows: string[];
    cols: string[];
    values?: { field: string | null; agg: string }[];
    filters?: {
      field: string;
      op: string;
      value?: string;
      value2?: string;
      values?: string[];
    }[];
    value?: string;
    agg?: string;
    limit?: number;
    // .471 names the run for dashboard registration + precise cancel
    query_id?: string;
  }, signal?: AbortSignal) =>
    jsonFetch<PivotResult>("/api/pivot", {
      method: "POST",
      body: JSON.stringify(spec),
      signal,
    }),

  reconcile: (spec: {
    left: string;
    right: string;
    keys: string[];
    compare?: string[];
    balance?: string | null;
    colmap_a?: Record<string, string>;
    colmap_b?: Record<string, string>;
    // .413 names the run for dashboard registration + precise cancel
    query_id?: string;
  }, signal?: AbortSignal) =>
    jsonFetch<ReconcileResult>("/api/reconcile", {
      method: "POST",
      body: JSON.stringify(spec),
      signal,
    }),

  reconcileDrilldown: (spec: ReconcileDetailRequest, signal?: AbortSignal) =>
    jsonFetch<ReconcileDrill>("/api/reconcile/drilldown", {
      method: "POST",
      body: JSON.stringify(spec),
      signal,
    }),

  reconcileProfile: (spec: ReconcileDetailRequest, signal?: AbortSignal) =>
    jsonFetch<TableProfile>("/api/reconcile/profile", {
      method: "POST",
      body: JSON.stringify(spec),
      signal,
    }),

  // --- mssql (optional) ---
  mssqlDrivers: () =>
    jsonFetch<{ available: boolean; drivers: string[] }>(
      "/api/mssql/drivers",
    ),
  mssqlConnect: (body: Record<string, any>) =>
    jsonFetch<{
      ok: boolean;
      name: string;
      databases: string[];
      spid?: number | null;
      error?: string;
    }>("/api/mssql/connect", { method: "POST", body: JSON.stringify(body) }),
  mssqlTables: (name: string, database?: string) =>
    jsonFetch<{ tables: { schema: string; name: string }[]; error?: string }>(
      "/api/mssql/tables",
      { method: "POST", body: JSON.stringify({ name, database }) },
    ),
  mssqlCatalog: (name: string, database?: string) =>
    jsonFetch<{ ok?: boolean; count?: number; error?: string }>(
      "/api/mssql/catalog",
      { method: "POST", body: JSON.stringify({ name, database }) },
    ),
  // close a SQL Server connection and drop its catalog tables from the panel
  mssqlDisconnect: (name: string) =>
    jsonFetch<{ ok?: boolean; error?: string }>("/api/mssql/connection", {
      method: "DELETE",
      body: JSON.stringify({ name }),
    }),
  hdfsConnect: (url: string, user?: string) =>
    jsonFetch<{
      ok?: boolean;
      base?: string;
      path?: string;
      folders?: string[];
      files?: string[];
      error?: string;
    }>("/api/hdfs/connect", {
      method: "POST",
      timeoutMs: 25000,
      body: JSON.stringify({ url, user }),
    }),
  hdfsBrowse: (path: string) =>
    jsonFetch<{
      ok?: boolean;
      path?: string;
      dirs?: string[];
      files?: string[];
      error?: string;
    }>("/api/hdfs/browse", {
      method: "POST",
      timeoutMs: 25000,
      body: JSON.stringify({ path }),
    }),
  hdfsLoadFileStart: (
    path: string,
    opts?: { destination?: string; mode?: string; base_name?: string },
  ) =>
    jsonFetch<{ job_id: string; name: string; bytes_total: number }>(
      "/api/hdfs/load-file-start",
      {
        method: "POST",
        timeoutMs: 25000,
        body: JSON.stringify({ path, ...(opts || {}) }),
      },
    ),
  // Convert a file-backed DuckDB view (e.g. a downloaded HDFS CSV/JSON) into
  // columnar Parquet for fast repeat queries, on the shared load job rail --
  // the progress window's Cancel / X stop the conversion (DuckDB-only).
  optimizeTableStart: (name: string) =>
    jsonFetch<{ job_id: string; bytes_total: number; name: string }>(
      "/api/table/optimize-start",
      { method: "POST", body: JSON.stringify({ name }) },
    ),
  flattenStart: (json_path: string, out_dir: string, base_name?: string) =>
    jsonFetch<{ job_id: string; bytes_total: number; name: string }>(
      "/api/flatten/start",
      { method: "POST", body: JSON.stringify({ json_path, out_dir, base_name }) },
    ),
  flattenProgress: (jobId: string) =>
    jsonFetch<{
      id: string;
      state: "starting" | "running" | "done" | "error" | "cancelled";
      stage: "reading" | "writing" | "done" | "cancelled";
      bytes_done: number;
      bytes_total: number;
      records: number;
      tables_done: number;
      tables_total: number;
      detail: string;
      name: string;
      error?: string | null;
      elapsed_ms: number;
      result?: {
        ok?: boolean;
        dir?: string;
        table_count?: number;
        files?: { table: string; file: string; rows: number; columns: number }[];
      };
    }>(`/api/flatten/progress/${encodeURIComponent(jobId)}`, { method: "GET" }),
  flattenCancel: (jobId: string) =>
    jsonFetch<{
      ok: boolean;
      cancelled: boolean;
      state?: string;
      error?: string;
    }>(`/api/flatten/cancel/${encodeURIComponent(jobId)}`, {
      method: "POST",
      timeoutMs: 15000,
    }),
  nodeflowRun: (
    graph: unknown,
    node: string,
    port: string,
    queryId?: string,
    signal?: AbortSignal,
    preview = false,
    previewLimit?: number,
  ) =>
    jsonFetch<{
      columns?: string[];
      rows?: unknown[][];
      total_rows?: number;
      result_id?: string | null;
      error?: string;
      cancelled?: boolean;
      preview?: boolean;
      preview_limit?: number;
      preview_limited?: boolean;
    }>("/api/nodeflow/run", {
      signal,
      method: "POST",
      body: JSON.stringify({
        graph,
        node,
        port,
        query_id: queryId,
        preview,
        preview_limit: previewLimit,
      }),
    }),
  nodeflowRunBatch: (
    graph: unknown,
    requests: { node: string; port?: string }[],
    queryId?: string,
    signal?: AbortSignal,
    preview = false,
    previewLimit?: number,
  ) =>
    jsonFetch<{
      ok?: boolean;
      error?: string;
      cancelled?: boolean;
      results?: {
        node: string;
        port: string;
        columns?: string[];
        rows?: unknown[][];
        total_rows?: number;
        result_id?: string | null;
        error?: string;
        cancelled?: boolean;
        preview?: boolean;
        preview_limit?: number;
        preview_limited?: boolean;
      }[];
    }>("/api/nodeflow/run-batch", {
      signal,
      method: "POST",
      body: JSON.stringify({
        graph,
        requests,
        query_id: queryId,
        preview,
        preview_limit: previewLimit,
      }),
    }),
  nodeflowColumns: (graph: unknown, node: string, port: string) =>
    jsonFetch<{ columns?: string[]; error?: string }>(
      "/api/nodeflow/columns",
      {
        method: "POST",
        body: JSON.stringify({ graph, node, port }),
      },
    ),
  nodeflowColumnsBatch: (
    graph: unknown,
    requests: { node: string; port: string }[],
  ) =>
    jsonFetch<{
      results?: {
        node: string;
        port: string;
        columns?: string[];
        error?: string;
      }[];
    }>("/api/nodeflow/columns-batch", {
      method: "POST",
      body: JSON.stringify({ graph, requests }),
    }),
  nodeflowChart: (
    graph: unknown,
    node: string,
    spec: unknown,
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<ChartData & { error?: string; cancelled?: boolean }>(
      "/api/nodeflow/chart",
      {
        signal,
        method: "POST",
        body: JSON.stringify({ graph, node, spec, query_id: queryId }),
      },
    ),
  nodeflowBrowse: (
    graph: unknown,
    node: string,
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      total_rows?: number;
      columns?: Record<string, any>[];
      error?: string;
      cancelled?: boolean;
    }>("/api/nodeflow/browse", {
      signal,
      method: "POST",
      body: JSON.stringify({ graph, node, query_id: queryId }),
    }),
  nodeflowReconcile: (
    graph: unknown,
    node: string,
    keys: string[],
    compare: string[],
    queryId?: string,
    balance?: string | null,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      totals?: Record<string, number>;
      fields?: {
        field: string;
        label?: string;
        matching: number;
        non_matching: number;
        a_only: number;
        b_only: number;
      }[];
      error?: string;
      cancelled?: boolean;
    }>("/api/nodeflow/reconcile", {
      signal,
      method: "POST",
      body: JSON.stringify({ graph, node, keys, compare, balance, query_id: queryId }),
    }),
  nodeflowExport: (
    graph: unknown,
    node: string,
    out_dir: string,
    format: string,
    base_name?: string,
    queryId?: string,
  ) =>
    jsonFetch<{
      ok?: boolean;
      path?: string;
      file?: string;
      rows?: number;
      error?: string;
      cancelled?: boolean;
    }>("/api/nodeflow/export", {
      method: "POST",
      body: JSON.stringify({
        graph,
        node,
        out_dir,
        format,
        base_name,
        query_id: queryId,
      }),
    }),
  nodeflowExportMany: (
    graph: unknown,
    items: {
      node_id: string;
      folder: string;
      fmt?: string;
      base_name?: string;
    }[],
    queryId?: string,
  ) =>
    jsonFetch<{
      ok?: boolean;
      results?: {
        node_id: string;
        ok?: boolean;
        path?: string;
        file?: string;
        rows?: number;
        error?: string;
      }[];
      error?: string;
      cancelled?: boolean;
    }>("/api/nodeflow/export-many", {
      method: "POST",
      body: JSON.stringify({ graph, items, query_id: queryId }),
    }),
  workflowsList: () =>
    jsonFetch<{
      workflows?: {
        name: string;
        kind?: "ide" | "journal" | "node" | "dashboard";
        created_at?: string;
        last_used?: string;
        nodes?: number;
        edges?: number;
        cells?: number;
        dashboards?: number;
        widgets?: number;
        preview?: string;
      }[];
    }>("/api/workflows"),
  workflowLoad: (
    name: string,
    kind: "ide" | "journal" | "node" | "dashboard" = "node",
    signal?: AbortSignal,
  ) =>
    jsonFetch<{ name?: string; kind?: string; graph?: unknown; error?: string }>(
      "/api/workflows/load",
      { signal, method: "POST", body: JSON.stringify({ name, kind }) },
    ),
  workflowSave: (
    name: string,
    graph: unknown,
    kind: "ide" | "journal" | "node" | "dashboard" = "node",
  ) =>
    jsonFetch<{ ok?: boolean; name?: string; kind?: string; error?: string }>(
      "/api/workflows",
      { method: "POST", body: JSON.stringify({ name, graph, kind }) },
    ),
  workflowDelete: (
    name: string,
    kind: "ide" | "journal" | "node" | "dashboard" = "node",
  ) =>
    jsonFetch<{ ok?: boolean }>("/api/workflows", {
      method: "DELETE",
      body: JSON.stringify({ name, kind }),
    }),
  // read / write a workflow file anywhere on disk (Save As / Open)
  saveFile: (path: string, content: string) =>
    jsonFetch<{ ok?: boolean; path?: string; name?: string; error?: string }>(
      "/api/workspace/save-file",
      { method: "POST", body: JSON.stringify({ path, content }) },
    ),
  openFile: (path: string) =>
    jsonFetch<{
      ok?: boolean;
      path?: string;
      name?: string;
      content?: string;
      error?: string;
    }>("/api/workspace/open-file", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  mssqlImport: (
    body: {
      name: string;
      query: string;
      base_name?: string;
      destination?: string;
    },
    queryId?: string,
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      error?: string;
      cancelled?: boolean;
    }>("/api/mssql/import", {
      method: "POST",
      body: JSON.stringify({ ...body, query_id: queryId }),
      signal,
    }),
  catalogColumns: (name: string) =>
    jsonFetch<{
      columns?: { name: string; type: string }[];
      qualified?: string;
      error?: string;
    }>("/api/catalog/columns?name=" + encodeURIComponent(name)),
  catalogImport: (name: string) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      error?: string;
    }>("/api/catalog/import", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  tableCreate: (
    name: string,
    columns: string[],
    rows: string[][],
    destination = "auto",
    signal?: AbortSignal,
  ) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      error?: string;
    }>("/api/table/create", {
      signal,
      method: "POST",
      body: JSON.stringify({ name, columns, rows, destination }),
    }),
  nodeflowToTable: (
    graph: unknown,
    node: string,
    name: string,
    queryId?: string,
  ) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      rows?: number;
      cancelled?: boolean;
      error?: string;
    }>("/api/nodeflow/write", {
      method: "POST",
      body: JSON.stringify({ graph, node, name, query_id: queryId }),
    }),
  directoryRead: (path: string, query_id?: string, signal?: AbortSignal) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      columns?: string[];
      rows?: number;
      error?: string;
      cancelled?: boolean;
    }>("/api/directory/read", {
      signal,
      method: "POST",
      body: JSON.stringify({ path, query_id }),
    }),
  folderRead: (folder: string, query_id?: string, signal?: AbortSignal) =>
    jsonFetch<{
      ok?: boolean;
      table?: string;
      engine?: string;
      columns?: string[];
      rows?: number;
      files?: number;
      error?: string;
      cancelled?: boolean;
    }>("/api/folder/read", {
      signal,
      method: "POST",
      body: JSON.stringify({ folder, query_id }),
    }),
  exportImage: (
    dir: string,
    baseName: string,
    format: string,
    dataUrl: string,
  ) =>
    jsonFetch<{ ok?: boolean; file?: string; bytes?: number; error?: string }>(
      "/api/export/image",
      {
        method: "POST",
        body: JSON.stringify({
          dir,
          base_name: baseName,
          format,
          data_url: dataUrl,
        }),
      },
    ),
  nodeflowValidate: (
    graph: unknown,
    node: string,
    checks: unknown,
    signal?: AbortSignal,
    queryId?: string,
  ) =>
    jsonFetch<{
      ok?: boolean;
      total_rows?: number;
      results?: { type: string; target: string; pass: boolean; detail: string }[];
      error?: string;
      cancelled?: boolean;
    }>("/api/nodeflow/validate", {
      signal,
      method: "POST",
      body: JSON.stringify({ graph, node, checks, query_id: queryId }),
    }),
};

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy execCommand path below */
  }
  try {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    document.body.removeChild(t);
  } catch {
    /* clipboard unavailable */
  }
}

// .539: EVERY client-composed export writes through the server into the
// user's Downloads folder. The old blob-anchor downloadBlob had no
// download manager behind it in the native pywebview window, so
// "downloads" silently never reached disk (the .510 class).
export async function saveToDownloads(
  filename: string,
  data: { text?: string; b64?: string },
): Promise<{ path: string; filename: string }> {
  return jsonFetch<{ path: string; filename: string }>("/api/save/download", {
    method: "POST",
    body: JSON.stringify({ filename, ...data }),
  });
}

// Export a query result (by id) to a downloaded file in ``fmt`` (csv/json/...),
// applying the current sort. The IDE result tabs and the Journal cells export a
// query result the same way, so both go through this. Returns the filename.
// (NodeFlow export is a different operation -- a server-side write to a folder
// via api.nodeflowExport -- and is intentionally not routed here.)
export async function aboutInfo(): Promise<any> {
  return jsonFetch<any>("/api/about");
}

export async function tablePropertiesInfo(
  engine: string,
  table: string,
): Promise<any> {
  return jsonFetch<any>("/api/table/properties", {
    method: "POST",
    body: JSON.stringify({ engine, table }),
  });
}

export async function exportResultToFile(
  resultId: string,
  fmt: string,
  sort: { sortCol?: string | null; descending?: boolean } = {},
): Promise<{ path?: string; cancelled?: boolean }> {
  // Dynamic import avoids a static cycle (runController imports api).
  const {
    registerRun,
    unregisterRun,
    isCancelledError,
    wasCancelled,
  } = await import("./runController");
  const exportId =
    "exp-" +
    (typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : Math.random().toString(36).slice(2));
  const ctrl = new AbortController();
  registerRun(exportId, ctrl);
  try {
    const data = await jsonFetch<{
      ok: boolean;
      path?: string;
      cancelled?: boolean;
    }>(`/api/result/${encodeURIComponent(resultId)}/export`, {
      method: "POST",
      signal: ctrl.signal,
      body: JSON.stringify({
        fmt,
        save: true,
        sort_col: sort.sortCol ?? null,
        descending: !!sort.descending,
        export_id: exportId,
      }),
    });
    if (data.cancelled || wasCancelled(exportId)) return { cancelled: true };
    return { path: data.path };
  } catch (e: any) {
    if (isCancelledError(e, exportId) || wasCancelled(exportId))
      return { cancelled: true };
    throw e;
  } finally {
    unregisterRun(exportId, ctrl);
  }
}

