import type {
  Cell,
  ResultPage,
  TableInfo,
  ReconcileResult,
  ReconBucket,
  TableProfile,
} from "../../lib/types";
import type { NbReconSpec } from "../../lib/notebook";
import type { ReconSpec } from "../ReconcileModal";

export interface RunCell {
  queryId?: string;
  id: string;
  type: "sql" | "note" | "chart" | "pivot" | "reconcile";
  name?: string;
  group?: string;
  code: string;
  text: string;
  sourceName?: string;
  leftSource?: string;
  rightSource?: string;
  recon?: NbReconSpec;
  reconReport?: ReconcileResult | null;
  reconRunning?: boolean;
  reconError?: string | null;
  reconRanSpec?: ReconSpec | null;
  reconRanSig?: string;
  reconDetail?: {
    kind: "drill" | "profile";
    title: string;
    page?: ResultPage | null;
    profile?: TableProfile | null;
    loading?: boolean;
  } | null;
  page?: ResultPage | null;
  resultId?: string | null;
  running?: boolean;
  error?: string | null;
  ranOnce?: boolean;
  ranCompiledSql?: string;
  elapsedMs?: number | null;
  collapsed?: boolean;
  boxW?: number;
  boxH?: number;
  outView?: "grid" | "chart" | "pivot";
  sortCol?: string | null;
  descending?: boolean;
  loadingMore?: boolean;
}

export interface NotebookCellProps {
  cell: RunCell;
  index: number;
  tables: TableInfo[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChangeCode: (value: string) => void;
  onChangeText: (value: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onReorderStart: (event: React.PointerEvent) => void;
  dropEdge?: "top" | "bottom" | null;
  dragging?: boolean;
  stale?: boolean;
  deps?: string[];
  dependents?: string[];
  onRunUpstream: () => void;
  onRunDownstream: () => void;
  onRunBranch: () => void;
  onAddBelow: (type: RunCell["type"]) => void;
  onToggleCollapse: () => void;
  onResize: (boxW: number, boxH: number) => void;
  onSetOutView: (view: "grid" | "chart" | "pivot") => void;
  onSort: (column: string) => void;
  onLoadMore: () => void;
  onExport: (format: string) => void;
  features?: { pyarrow?: boolean; openpyxl?: boolean } | null;
  onToast: (
    kind: "ok" | "error" | "warn",
    title: string,
    message?: string,
  ) => void;
  sources?: {
    name: string;
    resultId?: string | null;
    columns: string[];
    sampleRows?: Cell[][] | null;
  }[];
  onSetSource?: (name: string) => void;
  onRename?: (name: string) => void;
  onSourceExpired?: () => void;
  reconSources?: { name: string; columns: string[] }[];
  onSetReconSource?: (which: "left" | "right", name: string) => void;
  onSetReconSpec?: (spec: NbReconSpec) => void;
  onRunReconcile?: () => void;
  onReconDrill?: (bucket: ReconBucket, field: string | null) => void;
  onReconProfile?: (bucket: ReconBucket, field: string | null) => void;
  onReconDetailClose?: () => void;
  reconNeedsManualRefresh?: boolean;
}
