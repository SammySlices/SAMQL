import type { Icon } from "../Icon";
import type { NbEdge, NbNode, NodeType } from "../../lib/nodeFlowModel";
import { PORTS } from "../../lib/nodeFlowModel";

export type NodeIconName = keyof typeof Icon;
export type NodeGroupId =
  | "input"
  | "transform"
  | "aggregate"
  | "combine"
  | "create"
  | "output";

export type NodeInspectorType = NodeType;

export interface NodeDefinition {
  type: NodeType;
  label: string;
  icon?: NodeIconName;
  inspector: NodeInspectorType;
  createConfig: () => Record<string, any>;
  inspectorResizable?: boolean;
  cardSummary: (node: NbNode, edges: NbEdge[]) => string;
}

const countConfigured = (items: any[], predicate: (item: any) => boolean) =>
  (items || []).filter(predicate).length;

const summaryFor = (node: NbNode, edges: NbEdge[]): string => {
  const cfg = node.config || {};
  switch (node.type) {
    case "input":
      return cfg.table || "(pick a table)";
    case "shred":
      return cfg.table || cfg.base || "(pick a nested table)";
    case "select":
      return `${countConfigured(cfg.fields, (field) => field.keep !== false)} field(s)`;
    case "filter":
      return cfg.condition || "(set a condition)";
    case "formula":
      return `+${countConfigured(cfg.formulas, (formula) => formula.name && formula.expr)} column(s)`;
    case "summarize":
      return `${countConfigured(cfg.aggs, (agg) => agg.col)} agg · ${(cfg.group_by || []).length} group`;
    case "sort": {
      const sorts = (cfg.sorts || []).filter((sort: any) => sort.col);
      return sorts.length ? `by ${sorts.map((sort: any) => sort.col).join(", ")}` : "(pick fields)";
    }
    case "sample":
      return `${cfg.mode === "random" ? "random" : "first"} ${cfg.n ?? 100}`;
    case "unique":
      return (cfg.by || []).length ? `by ${(cfg.by || []).join(", ")}` : "distinct rows";
    case "unpivot":
      return `${(cfg.unpivot || []).length} col(s) → rows`;
    case "window":
      return `${countConfigured(cfg.windows, (win) => win.name)} calc(s)`;
    case "perioddelta":
      return cfg.value && cfg.order
        ? `${cfg.value} by ${cfg.order} · ${cfg.mode || "absolute"}`
        : "(pick value + period)";
    case "bin":
      return cfg.col ? `${cfg.col} → ${(cfg.cuts || []).length} bins` : "(pick a column)";
    case "rank":
      return cfg.order
        ? `by ${cfg.order}${cfg.top_n ? ` · top ${cfg.top_n}` : ""}`
        : "(pick a field)";
    case "fill":
      return `${countConfigured(cfg.fills, (fill) => fill.col)} column(s)`;
    case "dedupe":
      return (cfg.keys || []).length ? `by ${(cfg.keys || []).join(", ")}` : "(pick keys)";
    case "split":
      return cfg.col ? `${cfg.col} → ${(cfg.names || []).length}` : "(pick a column)";
    case "validate":
      return `${(cfg.checks || []).length} check(s)`;
    case "jsonextract":
      return cfg.col
        ? `${cfg.col} → ${countConfigured(cfg.extracts, (extract) => extract.path && extract.name)}`
        : "(pick a column)";
    case "explode":
      return cfg.col
        ? `${cfg.col} → rows (${cfg.mode === "delim" ? "split" : "json"})`
        : "(pick a column)";
    case "textclean":
      return (cfg.cols || []).length
        ? `${(cfg.cols || []).length} col(s) · ${(cfg.ops || []).length} step(s)`
        : "(pick columns)";
    case "antijoin":
      return `${cfg.mode === "semi" ? "semi" : "anti"} · ${countConfigured(
        cfg.keys,
        (key) => key.left && key.right,
      )} key(s)`;
    case "groupconcat":
      return cfg.col
        ? `${cfg.col} → list${(cfg.group || []).length ? ` by ${(cfg.group || []).length}` : ""}`
        : "(pick a column)";
    case "date":
      return cfg.col ? `${cfg.col} · ${cfg.op || "part"}` : "(pick a column)";
    case "maprecode":
      return cfg.col
        ? `${cfg.col} · ${countConfigured(cfg.mappings, (mapping) => mapping.from !== "")} rule(s)`
        : "(pick a column)";
    case "parse":
      return (cfg.cols || []).length
        ? `${(cfg.cols || []).length} col(s) → ${cfg.to || "number"}`
        : "(pick columns)";
    case "topn":
      return cfg.sort
        ? `top ${cfg.n || 10}${(cfg.group || []).length ? ` per ${(cfg.group || []).length}` : ""}`
        : "(pick sort)";
    case "crossjoin":
      return "every L × every R";
    case "coalesce":
      return (cfg.cols || []).length ? `first of ${(cfg.cols || []).length} col(s)` : "(pick columns)";
    case "renamecols": {
      const mappingCount = countConfigured(cfg.mappings, (mapping) => mapping.from && mapping.to);
      return [
        cfg.case && cfg.case,
        cfg.prefix && "prefix",
        cfg.suffix && "suffix",
        cfg.find && "replace",
        mappingCount && `${mappingCount} mapped`,
      ]
        .filter(Boolean)
        .join(" · ") || "(set rename rules)";
    }
    case "pivot": {
      const columnCount = (cfg.cols || []).length || (cfg.col ? 1 : 0);
      if (!columnCount) return "(set a column field)";
      return `${(cfg.rows || []).length} row · ${columnCount} col${
        (cfg.values || []).length > 1 ? ` · ${cfg.values.length} measures` : ""
      }${cfg.subtotals ? " · totals" : ""}`;
    }
    case "chart":
      return `${cfg.chart_type || "bar"}${cfg.x ? ` · ${cfg.x}` : ""}`;
    case "dashboard":
      return `${edges.filter((edge) => edge.to.node === node.id).length}/4 charts`;
    case "browse":
      return "view data";
    case "profile":
      return "profile columns";
    case "reconcile": {
      const inputs = edges.filter((edge) => edge.to.node === node.id).map((edge) => edge.to.port);
      return inputs.includes("left") && inputs.includes("right")
        ? `${(cfg.keys || []).length} key(s)`
        : "(connect 2 inputs)";
    }
    case "join": {
      const keys = (cfg.keys || []).filter((key: any) => key.left && key.right);
      return keys.length ? `on ${keys.map((key: any) => key.left).join(", ")}` : "(set keys)";
    }
    case "multijoin": {
      const connected = PORTS.multijoin.inputs.filter((port) =>
        edges.some((edge) => edge.to.node === node.id && edge.to.port === port),
      ).length;
      return connected < 2 ? "(connect inputs)" : `${connected} inputs · ${(cfg.joins || []).length} join(s)`;
    }
    case "union": {
      const connected = edges.filter((edge) => edge.to.node === node.id).length;
      return connected ? `${connected} input${connected === 1 ? "" : "s"} stacked` : "stack inputs";
    }
    case "createtable":
      return `${(cfg.columns || []).length} col · ${(cfg.rows || []).length} row`;
    case "directory":
      return cfg.file || "(pick a file)";
    case "appendfolder":
      return cfg.files ? `${cfg.files} file(s) stacked` : "(pick a folder)";
    case "filebrowser":
      return cfg.pattern || "(path / glob)";
    case "apinode":
      return cfg.url ? String(cfg.url).replace(/^https?:\/\//, "").slice(0, 30) : "(set a URL)";
    case "iterator":
      return cfg.table ? `iterate → ${cfg.table}` : "(configure loop)";
    case "while":
      return cfg.table ? `repeat → ${cfg.table}` : "(configure loop)";
    case "write":
      return `→ ${cfg.name || "table"}`;
    case "output":
      return cfg.format ? `→ ${String(cfg.format).toUpperCase()}` : "";
    case "sql":
    case "text":
    case "variable":
    case "group":
      return "";
  }
};

const define = (
  type: NodeType,
  label: string,
  icon: NodeIconName | undefined,
  createConfig: () => Record<string, any>,
  inspectorResizable = false,
): NodeDefinition => ({
  type,
  label,
  icon,
  inspector: type,
  createConfig,
  inspectorResizable,
  cardSummary: summaryFor,
});

export const NODE_DEFINITIONS = {
  input: define("input", "Input", "Database", () => ({ table: "", label: "input" })),
  shred: define("shred", "Shred", "Grid", () => ({ table: "", base: "", output: "", refresh: false, label: "shred" })),
  select: define("select", "Select", "Columns", () => ({ fields: [], label: "select" })),
  filter: define("filter", "Filter", "Filter", () => ({ condition: "", label: "filter" })),
  formula: define("formula", "Formula", "Beaker", () => ({ formulas: [{ name: "", expr: "", mode: "new" }], label: "formula" }), true),
  summarize: define("summarize", "Summarize", "Sigma", () => ({ group_by: [], aggs: [{ col: "", func: "sum" }], label: "summarize" })),
  sort: define("sort", "Sort", "SortArrows", () => ({ sorts: [{ col: "", dir: "asc" }], label: "sort" })),
  sample: define("sample", "Sample", "Dice", () => ({ mode: "head", n: 100, label: "sample" })),
  unique: define("unique", "Unique", "Sparkle", () => ({ by: [], label: "unique" })),
  unpivot: define("unpivot", "Unpivot", "Rows", () => ({ keep: [], unpivot: [], name_field: "field", value_field: "value", label: "unpivot" })),
  window: define("window", "Window", "Window", () => ({ windows: [{ func: "running_sum", col: "", name: "", partition_by: [], order_by: [{ col: "", dir: "asc" }] }], label: "window" })),
  perioddelta: define("perioddelta", "Period change", "Compare", () => ({ value: "", order: "", partition: [], offset: 1, dir: "asc", mode: "absolute", out: "period_change", label: "period change" })),
  bin: define("bin", "Bin", "Ruler", () => ({ col: "", cuts: [{ le: "", label: "" }], else_label: "other", out: "bucket", label: "bin" })),
  rank: define("rank", "Rank", "ListOrdered", () => ({ partition: [], order: "", dir: "desc", method: "row_number", top_n: "", out: "rank", label: "rank" })),
  fill: define("fill", "Fill", undefined, () => ({ fills: [], label: "fill" })),
  dedupe: define("dedupe", "Dedupe", "CopyMinus", () => ({ keys: [], sort: "", keep: "first", label: "dedupe" })),
  split: define("split", "Split column", "Split", () => ({ col: "", delim: ",", names: ["part_1", "part_2"], label: "split" })),
  jsonextract: define("jsonextract", "JSON extract", "Braces", () => ({ col: "", extracts: [{ path: "", name: "" }], label: "json" })),
  explode: define("explode", "Explode", "ListTree", () => ({ col: "", mode: "json", delim: ",", name: "", label: "explode" })),
  textclean: define("textclean", "Text clean", "Eraser", () => ({ cols: [], ops: [], label: "clean" })),
  antijoin: define("antijoin", "Anti join", undefined, () => ({ keys: [{ left: "", right: "" }], mode: "anti", label: "anti-join" })),
  groupconcat: define("groupconcat", "Group concat", "Merge", () => ({ group: [], col: "", name: "", delim: ", ", distinct: false, label: "group concat" })),
  date: define("date", "Date / time", "Calendar", () => ({ col: "", op: "part", part: "year", unit: "month", other: "", name: "", label: "date" })),
  maprecode: define("maprecode", "Map / recode", "Shuffle", () => ({ col: "", mappings: [{ from: "", to: "" }], default: "passthrough", default_value: "", name: "", label: "recode" })),
  parse: define("parse", "Parse / cast", "Binary", () => ({ cols: [], to: "number", format: "", group: ",", label: "parse" })),
  topn: define("topn", "Top N per group", "ChevronsUp", () => ({ group: [], sort: "", desc: true, n: 10, label: "top N" })),
  crossjoin: define("crossjoin", "Cross join", "Grid3", () => ({ label: "cross join" })),
  coalesce: define("coalesce", "Coalesce columns", "FoldHorizontal", () => ({ cols: [], name: "coalesced", label: "coalesce" })),
  renamecols: define("renamecols", "Rename columns", "SquarePen", () => ({ prefix: "", suffix: "", case: "", find: "", replace: "", mappings: [], label: "rename" })),
  validate: define("validate", "Validate", "ShieldCheck", () => ({ checks: [], label: "validate" })),
  pivot: define("pivot", "Pivot", "LayoutGrid", () => ({ rows: [], cols: [], values: [{ field: "", agg: "sum" }], subtotals: false, label: "pivot" })),
  join: define("join", "Join", "GitMerge", () => ({ keys: [{ left: "", right: "" }], label: "join" })),
  multijoin: define("multijoin", "Multi-join", "Workflow", () => ({ base: "in1", joins: [], label: "multijoin" })),
  union: define("union", "Union", "Layers", () => ({ label: "union" })),
  chart: define("chart", "Chart", "Chart", () => ({ chart_type: "bar", x: "", y: "", agg: "sum", collapsed: true, label: "chart" })),
  dashboard: define("dashboard", "Dashboard", "Dashboard", () => ({ panes: ["in1", "in2", "in3", "in4"], collapsed: false, label: "dashboard" })),
  browse: define("browse", "Browse", "Eye", () => ({ label: "browse" })),
  profile: define("profile", "Profile", "ScanSearch", () => ({ label: "profile" })),
  reconcile: define("reconcile", "Reconcile", "Scale", () => ({ keys: [], compare: [], balance: "", label: "reconcile" })),
  createtable: define("createtable", "Create table", "SquarePlus", () => ({ columns: ["col1", "col2"], rows: [["", ""], ["", ""]], dest: "duckdb", label: "new_table" }), true),
  text: define("text", "Text note", "StickyNote", () => ({ text: "", label: "note" }), true),
  variable: define("variable", "Variable", "Variable", () => ({ vars: [{ name: "", value: "" }], label: "variables" })),
  directory: define("directory", "Directory", "FolderOpen", () => ({ folder: "", file: "", path: "", table: "", label: "directory" })),
  appendfolder: define("appendfolder", "Append folder", "Files", () => ({ folder: "", table: "", columns: [], files: 0, label: "folder" })),
  filebrowser: define("filebrowser", "File browser", "FolderSearch", () => ({ pattern: "", source_column: "", label: "file browser" })),
  apinode: define("apinode", "API", "Cloud", () => ({ url: "", params: [], json_path: "", auth_user: "", retry: { retries: 0 }, continue_on_error: false, label: "api" })),
  iterator: define("iterator", "Iterator", "Repeat", () => ({ children: [], table: "", accumulate: "append", label: "iterator" })),
  while: define("while", "Repeat until", "RotateCw", () => ({ table: "", var: "", reset_first: true, replace_keys: [], accumulate: "append", max_iters: 100, label: "repeat until" })),
  sql: define("sql", "SQL", "Code", () => ({ sql: "SELECT *\nFROM input", label: "sql" }), true),
  group: define("group", "Group", "Group", () => ({ children: [], label: "group", note: "" }), true),
  write: define("write", "Write to table", "ArrowDownToLine", () => ({ name: "flow_result", label: "write" })),
  output: define("output", "Output", "FileDown", () => ({ folder: "", format: "csv", base_name: "output", label: "output" })),
} satisfies Record<NodeType, NodeDefinition>;

export const NODE_PALETTE_ORDER: NodeType[] = [
  "input", "shred", "select", "filter", "formula", "summarize", "sort", "sample",
  "unique", "unpivot", "window", "perioddelta", "bin", "rank", "dedupe", "split",
  "jsonextract", "explode", "textclean", "date", "groupconcat", "maprecode", "parse",
  "topn", "coalesce", "renamecols", "validate", "pivot", "join", "multijoin",
  "crossjoin", "union", "chart", "dashboard", "browse", "profile", "reconcile", "group",
  "createtable", "directory", "appendfolder", "filebrowser", "apinode", "text", "variable",
  "sql", "write", "output", "iterator", "while",
];

export const NODE_PALETTE = NODE_PALETTE_ORDER.map((type) => {
  const definition = NODE_DEFINITIONS[type];
  if (!definition.icon) throw new Error(`Palette node ${type} has no icon.`);
  return { type, label: definition.label, icon: definition.icon };
});

export const NODE_BY_TYPE = Object.fromEntries(
  NODE_PALETTE.map((item) => [item.type, item]),
) as Partial<Record<NodeType, (typeof NODE_PALETTE)[number]>>;

export const isPaletteNodeType = (value: unknown): value is NodeType =>
  typeof value === "string" && value in NODE_BY_TYPE;

export const NODE_GROUPS: {
  id: NodeGroupId;
  label: string;
  icon: NodeIconName;
  types: NodeType[];
}[] = [
  { id: "input", label: "Input", icon: "Database", types: ["input", "shred", "directory", "appendfolder", "filebrowser", "apinode", "createtable"] },
  { id: "transform", label: "Transform", icon: "Filter", types: ["select", "filter", "formula", "sort", "sample", "unique", "bin", "dedupe", "split", "jsonextract", "explode", "textclean", "date", "maprecode", "parse", "coalesce", "renamecols", "validate", "profile"] },
  { id: "aggregate", label: "Aggregate", icon: "Step", types: ["summarize", "pivot", "unpivot", "window", "perioddelta", "rank", "groupconcat", "topn"] },
  { id: "combine", label: "Combine", icon: "Swap", types: ["join", "multijoin", "crossjoin", "union", "reconcile", "group"] },
  { id: "create", label: "Create", icon: "Table", types: ["chart", "dashboard", "sql", "text", "variable"] },
  { id: "output", label: "Output", icon: "Download", types: ["browse", "write", "output", "iterator", "while"] },
];


export const getNodeDefinition = (type: NodeType): NodeDefinition =>
  NODE_DEFINITIONS[type];

export const getNodeInspectorType = (type: NodeType): NodeInspectorType =>
  getNodeDefinition(type).inspector;

export const createDefaultNodeConfig = (type: NodeType): Record<string, any> =>
  getNodeDefinition(type).createConfig();

export const getNodeCardSummary = (node: NbNode, edges: NbEdge[]): string =>
  getNodeDefinition(node.type).cardSummary(node, edges);

export const nodeInspectorIsResizable = (type: NodeType): boolean =>
  !!getNodeDefinition(type).inspectorResizable;
