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
  sql?: string;
  statements?: StatementEntry[];
  activeStmt?: number;
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
