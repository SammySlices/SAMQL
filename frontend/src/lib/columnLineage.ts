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
  /** Short op label (formula, sum, filter, cast, …). */
  op?: string | null;
  /** Compact ``inputs → op → output`` transform line. */
  transform?: string | null;
  type_from?: string | null;
  type_to?: string | null;
  group_by?: string[] | null;
  join_how?: string | null;
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

/** Prefer backend ``transform``; otherwise build ``inputs → op → output``. */
export function formatTransformSummary(
  change: ColumnLineageChange | null | undefined,
  fallbackColumn?: string,
): string {
  if (!change) return "—";
  const ready = (change.transform || "").trim();
  if (ready) return ready;
  const inputs =
    change.inputs && change.inputs.length
      ? change.inputs.join(", ")
      : "—";
  const op =
    (change.expression || "").trim() ||
    (change.op || "").trim() ||
    (change.summary || "").trim() ||
    "op";
  const output = (change.output || fallbackColumn || "—").trim() || "—";
  return `${inputs} → ${op} → ${output}`;
}

/** Type change chip text when known from select cast / rename+cast. */
export function formatTypeChange(
  change: ColumnLineageChange | null | undefined,
): string | null {
  if (!change) return null;
  const from = (change.type_from || "").trim();
  const to = (change.type_to || "").trim();
  if (from && to) return `${from} → ${to}`;
  if (to) return `→ ${to}`;
  if (from) return `${from} →`;
  return null;
}
