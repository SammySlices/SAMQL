/** Types + helpers for the results-grid column lineage modal. */

export type ColumnLineageChange = {
  summary: string;
  detail?: string;
  inputs?: string[];
  output?: string;
  expression?: string | null;
  mapping?: { from: string; to: string } | null;
  predicate?: string | null;
  unchanged?: boolean;
};

export type ColumnLineageValueInput = {
  column: string;
  value: unknown;
  available: boolean;
};

export type ColumnLineageStageValue = {
  available: boolean;
  value: unknown;
  inputs?: ColumnLineageValueInput[];
  reason?: string | null;
  expression?: string | null;
};

export type ColumnLineageStage = {
  id: string;
  kind: string;
  column: string;
  node_id: string;
  node_type: string;
  node_label: string;
  step: string;
  change: ColumnLineageChange;
  value?: ColumnLineageStageValue | null;
};

export type ColumnLineageResult = {
  ok?: boolean;
  available: boolean;
  column: string;
  terminal_node?: string;
  terminal_port?: string;
  sql_flagged?: boolean;
  reason?: string | null;
  stages: ColumnLineageStage[];
  row_index?: number | null;
};

export type ColumnLineageOpenArgs = {
  column: string;
  /** When set, fetch lineage for this NodeFlow graph. */
  graph?: unknown | null;
  nodeId?: string | null;
  port?: string | null;
  /** Absolute row index from the results grid (cell right-click). */
  rowIndex?: number | null;
  /** Displayed cell value for the clicked result cell. */
  cellValue?: unknown;
};

export function kindLabel(kind: string): string {
  switch ((kind || "").toLowerCase()) {
    case "source":
      return "Source";
    case "passthrough":
      return "Passthrough";
    case "derived":
      return "Derived";
    case "sql":
      return "SQL";
    default:
      return kind || "Step";
  }
}

export function formatLineageValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
