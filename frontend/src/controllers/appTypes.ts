import type { ReconSpec } from "../components/ReconcileModal";
import type {
  ColumnFilter,
  EngineKind,
  ReconcileResult,
  ResultPage,
  StatementEntry,
  TableProfile,
} from "../lib/types";

/** Shared IDE tab state. Kept outside App so Phase 5 controllers can adopt it. */
export interface EdTab {
  id: string;
  title: string;
  sql: string;
  /** Saved Workflows identity, independent of the editable tab title. */
  savedWorkflowName?: string;
  /** File identity established by Save As / Open. */
  savedFilePath?: string;
  liveResId?: string;
}

/**
 * Result-workspace state shared by the current App shell and the upcoming
 * Phase 5 result controller extraction.
 */
export interface ResultTab {
  queryId?: string;
  id: string;
  kind: "result" | "profile" | "recon";
  title: string;
  resultId?: string | null;
  /** Session data_epoch when this result was produced (latest-data guard). */
  ranDataEpoch?: number | null;
  /** True when catalog data moved past ranDataEpoch — re-run required. */
  dataStale?: boolean;
  originTabId?: string;
  pinned?: boolean;
  page?: ResultPage | null;
  sortCol?: string | null;
  descending?: boolean;
  filters?: ColumnFilter[];
  /** Full column set from the unprojected result (for hide/show). */
  allColumns?: string[];
  /** When set, page fetches request only these columns from the API. */
  visibleColumns?: string[] | null;
  released?: boolean;
  loadingMore?: boolean;
  view?: "grid" | "chart" | "pivot";
  /** The editor text this tab was run from (display / history only). */
  sql?: string;
  /** Q-C1: the single statement that produced the grid (backend's own
   * record, post-dialect), the engine target it resolved to, and the
   * preview cap. An expired result re-runs ONLY this, read-only. */
  rerunSql?: string;
  rerunTarget?: string;
  rerunPreviewLimit?: number;
  statements?: StatementEntry[];
  activeStmt?: number;
  /** Optional NodeFlow graph attached when this result came from a flow run. */
  lineageGraph?: unknown | null;
  lineageNodeId?: string | null;
  lineagePort?: string | null;
  profileTable?: string;
  profileEngine?: EngineKind;
  profile?: TableProfile | null;
  profileLoading?: boolean;
  profileQueryId?: string;
  recon?: ReconcileResult;
  reconSpec?: ReconSpec;
}

export type ToastKind = "ok" | "error" | "warn";
export type ToastFn = (kind: ToastKind, title: string, msg?: string) => void;
export type AppView = "ide" | "notebook" | "nodeflow" | "dashboard";
