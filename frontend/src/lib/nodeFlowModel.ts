import { runMigrations } from "./migrations";

// Shared NodeFlow model, persistence keys, ports, and canvas geometry.
//
// Keeping this pure subsystem out of the 10k-line component makes geometry
// independently testable and prevents UI refactors from duplicating the
// backend-facing graph contract. Nothing here touches React or the DOM.

export type NodeType =
  | "input"
  | "shred"
  | "select"
  | "filter"
  | "formula"
  | "summarize"
  | "sort"
  | "sample"
  | "unique"
  | "unpivot"
  | "window"
  | "perioddelta"
  | "bin"
  | "rank"
  | "fill"
  | "dedupe"
  | "split"
  | "jsonextract"
  | "explode"
  | "textclean"
  | "antijoin"
  | "groupconcat"
  | "date"
  | "maprecode"
  | "parse"
  | "topn"
  | "crossjoin"
  | "coalesce"
  | "renamecols"
  | "validate"
  | "pivot"
  | "join"
  | "multijoin"
  | "union"
  | "chart"
  | "dashboard"
  | "browse"
  | "profile"
  | "reconcile"
  | "createtable"
  | "text"
  | "variable"
  | "directory"
  | "appendfolder"
  | "filebrowser"
  | "apinode"
  | "sqlserver"
  | "sharepoint"
  | "webscrape"
  | "iterator"
  | "while"
  | "sql"
  | "python"
  | "group"
  | "write"
  | "output"
  | "samqldash"
  | "dyn_input"
  | "dyn_output"
  | "usernode";

export interface NbNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  config: Record<string, any>;
}
export interface NbEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export const PORTS: Record<NodeType, { inputs: string[]; outputs: string[] }> = {
  input: { inputs: [], outputs: ["out"] },
  shred: { inputs: [], outputs: ["out"] },
  select: { inputs: ["in"], outputs: ["out"] },
  filter: { inputs: ["in"], outputs: ["true", "false"] },
  formula: { inputs: ["in"], outputs: ["out"] },
  summarize: { inputs: ["in"], outputs: ["out"] },
  sort: { inputs: ["in"], outputs: ["out"] },
  sample: { inputs: ["in"], outputs: ["out"] },
  unique: { inputs: ["in"], outputs: ["out"] },
  unpivot: { inputs: ["in"], outputs: ["out"] },
  window: { inputs: ["in"], outputs: ["out"] },
  perioddelta: { inputs: ["in"], outputs: ["out"] },
  bin: { inputs: ["in"], outputs: ["out"] },
  rank: { inputs: ["in"], outputs: ["out"] },
  fill: { inputs: ["in"], outputs: ["out"] },
  dedupe: { inputs: ["in"], outputs: ["out"] },
  split: { inputs: ["in"], outputs: ["out"] },
  jsonextract: { inputs: ["in"], outputs: ["out"] },
  explode: { inputs: ["in"], outputs: ["out"] },
  textclean: { inputs: ["in"], outputs: ["out"] },
  antijoin: { inputs: ["left", "right"], outputs: ["out"] },
  groupconcat: { inputs: ["in"], outputs: ["out"] },
  date: { inputs: ["in"], outputs: ["out"] },
  maprecode: { inputs: ["in"], outputs: ["out"] },
  parse: { inputs: ["in"], outputs: ["out"] },
  topn: { inputs: ["in"], outputs: ["out"] },
  crossjoin: { inputs: ["left", "right"], outputs: ["out"] },
  coalesce: { inputs: ["in"], outputs: ["out"] },
  renamecols: { inputs: ["in"], outputs: ["out"] },
  validate: { inputs: ["in"], outputs: ["out"] },
  pivot: { inputs: ["in"], outputs: ["out"] },
  join: { inputs: ["left", "right"], outputs: ["left_only", "inner", "right_only"] },
  multijoin: { inputs: ["in1", "in2", "in3", "in4", "in5"], outputs: ["out"] },
  union: {
    inputs: ["in1", "in2", "in3", "in4", "in5",
             "in6", "in7", "in8", "in9", "in10"],
    outputs: ["out"],
  },
  chart: { inputs: ["in"], outputs: ["out"] },
  dashboard: {
    inputs: ["in1", "in2", "in3", "in4"],
    outputs: ["out"],
  },
  browse: { inputs: ["in"], outputs: ["out"] },
  profile: { inputs: ["in"], outputs: ["out"] },
  reconcile: { inputs: ["left", "right"], outputs: ["out"] },
  createtable: { inputs: [], outputs: ["out"] },
  text: { inputs: [], outputs: [] },
  variable: { inputs: [], outputs: [] },
  directory: { inputs: [], outputs: ["out"] },
  appendfolder: { inputs: [], outputs: ["out"] },
  filebrowser: { inputs: [], outputs: ["out"] },
  apinode: { inputs: [], outputs: ["out", "err"] },
  sqlserver: { inputs: [], outputs: ["out"] },
  sharepoint: { inputs: [], outputs: ["out"] },
  webscrape: { inputs: [], outputs: ["out"] },
  iterator: { inputs: ["vars", "in"], outputs: ["out"] },
  while: { inputs: ["in"], outputs: [] },
  sql: { inputs: ["in"], outputs: ["out"] },
  python: { inputs: ["in"], outputs: ["out"] },
  group: { inputs: ["in", "in2", "in3", "in4", "in5"], outputs: ["out"] },
  write: { inputs: ["in"], outputs: ["out"] },
  output: { inputs: ["in"], outputs: [] },
  samqldash: { inputs: ["in"], outputs: [] },
  dyn_input: { inputs: [], outputs: ["out"] },
  dyn_output: { inputs: ["in"], outputs: [] },
  // Max ports; visible count comes from config.inputCount / outputCount.
  usernode: {
    inputs: ["in1", "in2", "in3", "in4", "in5", "in6", "in7", "in8", "in9", "in10"],
    outputs: ["out1", "out2", "out3", "out4", "out5", "out6", "out7", "out8", "out9", "out10"],
  },
};
export const PORT_LABEL: Record<string, string> = {
  out: "out",
  err: "errors",
  in: "in",
  true: "True",
  false: "False",
  left: "left",
  right: "right",
  left_only: "only L",
  inner: "inner",
  right_only: "only R",
  in1: "in 1",
  in2: "in 2",
  in3: "in 3",
  in4: "in 4",
  in5: "in 5",
  in6: "in 6",
  in7: "in 7",
  in8: "in 8",
  in9: "in 9",
  in10: "in 10",
  out1: "out 1",
  out2: "out 2",
  out3: "out 3",
  out4: "out 4",
  out5: "out 5",
  out6: "out 6",
  out7: "out 7",
  out8: "out 8",
  out9: "out 9",
  out10: "out 10",
  vars: "values",
};

/** Letter drawn inside a left/right input arrow (join, reconcile, …). */
export function inputPortMark(port: string): "L" | "R" | null {
  if (port === "left") return "L";
  if (port === "right") return "R";
  return null;
}

/**
 * Side-port caption next to the arrow. Plain in/out (and numbered inN/outN)
 * and left/right are suppressed — left/right use {@link inputPortMark} instead.
 * Semantic captions (True/False, only L, inner, errors, …) still show.
 */
export function sidePortLabel(port: string): string | null {
  if (port === "in" || port === "out") return null;
  if (port === "left" || port === "right") return null;
  if (/^in\d+$/.test(port) || /^out\d+$/.test(port)) return null;
  return PORT_LABEL[port] || port;
}

/** Favorites may be a built-in NodeType or `created:<definitionId>`. */
export const CREATED_FAVORITE_PREFIX = "created:";

export function createdFavoriteKey(definitionId: string): string {
  return CREATED_FAVORITE_PREFIX + String(definitionId || "").trim();
}

export function isCreatedFavoriteKey(key: string): boolean {
  return String(key || "").startsWith(CREATED_FAVORITE_PREFIX);
}

export function createdIdFromFavorite(key: string): string {
  return String(key || "").slice(CREATED_FAVORITE_PREFIX.length);
}

// Some inputs render on the TOP edge of the node (pointing down) rather than on
// the left. Today only the iterator's "vars" driver does this: it takes a table
// whose rows produce the loop's scalar values, while the optional "in" (the
// body / side input) stays on the left. Centralised so the renderer and the
// wire-anchor geometry agree on which ports are on top.
export const TOP_INPUTS: Record<string, string[]> = {
  iterator: ["vars"],
};
export const isTopInput = (type: string, port: string) =>
  (TOP_INPUTS[type] || []).includes(port);
export const leftInputsOf = (type: string) =>
  ((PORTS as Record<string, { inputs: string[]; outputs: string[] }>)[type]
    ?.inputs || []
  ).filter((p: string) => !isTopInput(type, p));

// Migrate older saved graphs: the join node used to expose a single mode-driven
// "out" port; it now has three (left_only / inner / right_only). Re-point any
// saved edge leaving a join's "out" to its "inner" port so old canvases load
// without a dangling wire.
export function migrateJoinEdges(nodes: any[], edges: any[]): any[] {
  const joins = new Set(
    (nodes || []).filter((n) => n && n.type === "join").map((n) => n.id),
  );
  return (edges || []).map((e) =>
    e && e.from && joins.has(e.from.node) && e.from.port === "out"
      ? { ...e, from: { ...e.from, port: "inner" } }
      : e,
  );
}

export const NODEFLOW_FILE_FORMAT = "samql-nodeflow";
export const LEGACY_NODEFLOW_FILE_FORMAT = "samql-nodebook";
export const NODEFLOW_FILE_VERSION = 3;
export const NODEFLOW_TABS_VERSION = 3;

export interface NodeFlowGraphFile {
  format: string;
  version: number;
  nodes: NbNode[];
  edges: NbEdge[];
  migratedFrom?: number;
}

const GRAPH_MIGRATIONS = {
  0: (raw: any) => ({
    format: NODEFLOW_FILE_FORMAT,
    version: 1,
    nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw?.edges) ? raw.edges : [],
  }),
  1: (raw: any) => {
    const nodes = (Array.isArray(raw?.nodes) ? raw.nodes : [])
      .filter((n: any) => n && typeof n.id === "string" && typeof n.type === "string")
      .map((n: any) => ({
        ...n,
        x: Number.isFinite(n.x) ? n.x : 0,
        y: Number.isFinite(n.y) ? n.y : 0,
        config: n.config && typeof n.config === "object" ? n.config : {},
      }));
    const edges = migrateJoinEdges(nodes, Array.isArray(raw?.edges) ? raw.edges : [])
      .filter((e: any) => e?.from?.node && e?.from?.port && e?.to?.node && e?.to?.port)
      .map((e: any, i: number) => ({
        ...e,
        id: typeof e.id === "string" && e.id ? e.id : `edge_${i}`,
      }));
    return { ...raw, format: LEGACY_NODEFLOW_FILE_FORMAT, version: 2, nodes, edges };
  },
  2: (raw: any) => ({ ...raw, format: NODEFLOW_FILE_FORMAT, version: 3 }),
};

function validateNodeFlowGraphFile(value: any): asserts value is NodeFlowGraphFile {
  if (value?.format !== NODEFLOW_FILE_FORMAT)
    throw new Error("This SamQL node workflow has an invalid format marker.");
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    throw new Error("This SamQL node workflow is missing its nodes or edges.");

  const knownPorts = PORTS as Record<
    string,
    { inputs: string[]; outputs: string[] } | undefined
  >;
  const allNodeIds = new Set<string>();
  const topLevelById = new Map<string, NbNode>();

  const validateNode = (node: any, topLevel: boolean, path: string) => {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      typeof node.type !== "string" ||
      !node.type ||
      !node.config ||
      typeof node.config !== "object" ||
      Array.isArray(node.config) ||
      (topLevel && (!Number.isFinite(node.x) || !Number.isFinite(node.y)))
    ) {
      throw new Error(`This SamQL node workflow contains an invalid node at ${path}.`);
    }
    if (!knownPorts[node.type]) {
      throw new Error(
        `This SamQL node workflow uses unknown node type “${node.type}” at ${path}.`,
      );
    }
    if (allNodeIds.has(node.id)) {
      throw new Error(
        `This SamQL node workflow contains duplicate node id “${node.id}”.`,
      );
    }
    allNodeIds.add(node.id);
    if (topLevel) topLevelById.set(node.id, node as NbNode);

    const children = node.config.children;
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new Error(
          `This SamQL node workflow contains invalid children for node “${node.id}”.`,
        );
      }
      children.forEach((child: any, index: number) =>
        validateNode(child, false, `${path}.config.children[${index}]`),
      );
    }
  };

  value.nodes.forEach((node: any, index: number) =>
    validateNode(node, true, `nodes[${index}]`),
  );

  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      !edge.id ||
      typeof edge.from?.node !== "string" ||
      !edge.from.node ||
      typeof edge.from?.port !== "string" ||
      !edge.from.port ||
      typeof edge.to?.node !== "string" ||
      !edge.to.node ||
      typeof edge.to?.port !== "string" ||
      !edge.to.port
    ) {
      throw new Error("This SamQL node workflow contains an invalid connection.");
    }
    if (edgeIds.has(edge.id)) {
      throw new Error(
        `This SamQL node workflow contains duplicate connection id “${edge.id}”.`,
      );
    }
    edgeIds.add(edge.id);

    const fromNode = topLevelById.get(edge.from.node);
    const toNode = topLevelById.get(edge.to.node);
    if (!fromNode || !toNode) {
      const missing = !fromNode ? edge.from.node : edge.to.node;
      throw new Error(
        `Connection “${edge.id}” references missing node “${missing}”.`,
      );
    }
    if (!knownPorts[fromNode.type]?.outputs.includes(edge.from.port)) {
      throw new Error(
        `Connection “${edge.id}” uses unknown output port “${edge.from.port}” on node “${fromNode.id}”.`,
      );
    }
    if (!knownPorts[toNode.type]?.inputs.includes(edge.to.port)) {
      throw new Error(
        `Connection “${edge.id}” uses unknown input port “${edge.to.port}” on node “${toNode.id}”.`,
      );
    }
  }
}

export function parseNodeFlowGraph(input: any): NodeFlowGraphFile {
  if (input?.format && input.format !== NODEFLOW_FILE_FORMAT &&
      input.format !== LEGACY_NODEFLOW_FILE_FORMAT)
    throw new Error("This doesn't look like a SamQL NodeFlow workflow.");
  const migrated = runMigrations<NodeFlowGraphFile>(
    input || {},
    NODEFLOW_FILE_VERSION,
    GRAPH_MIGRATIONS,
    "This SamQL node workflow",
  );
  validateNodeFlowGraphFile(migrated.value);
  return {
    ...migrated.value,
    migratedFrom: migrated.migrated ? migrated.fromVersion : undefined,
  };
}

export function serializeNodeFlowGraph(
  nodes: NbNode[],
  edges: NbEdge[],
): NodeFlowGraphFile {
  return {
    format: NODEFLOW_FILE_FORMAT,
    version: NODEFLOW_FILE_VERSION,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      config: n.config,
    })),
    edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };
}

export interface NodeFlowTabsFile {
  version: number;
  tabs: Array<{
    id: string;
    name: string;
    savedWorkflowName?: string;
    savedFilePath?: string;
    editingDefinitionId?: string;
  }>;
  activeTabId: string;
  migratedFrom?: number;
}

const TAB_MIGRATIONS = {
  0: (raw: any) => ({ ...raw, version: 1 }),
  1: (raw: any) => ({ ...raw, version: 2 }),
  2: (raw: any) => ({
    version: 3,
    tabs: Array.isArray(raw?.tabs)
      ? raw.tabs
          .filter((t: any) => t && typeof t.id === "string")
          .map((t: any) => ({ id: t.id, name: String(t.name || "Tab") }))
      : [],
    activeTabId: typeof raw?.activeTabId === "string" ? raw.activeTabId : "",
  }),
};

function validateNodeFlowTabsFile(value: any): asserts value is NodeFlowTabsFile {
  if (!Array.isArray(value?.tabs) || typeof value.activeTabId !== "string")
    throw new Error("NodeFlow tab state is missing its tab index.");
  const ids = new Set<string>();
  for (const tab of value.tabs) {
    if (!tab || typeof tab.id !== "string" || !tab.id || typeof tab.name !== "string")
      throw new Error("NodeFlow tab state contains an invalid tab.");
    if (
      tab.editingDefinitionId !== undefined &&
      typeof tab.editingDefinitionId !== "string"
    ) {
      throw new Error("NodeFlow tab state contains an invalid editing definition id.");
    }
    if (
      tab.savedWorkflowName !== undefined &&
      typeof tab.savedWorkflowName !== "string"
    ) {
      throw new Error("NodeFlow tab state contains an invalid saved workflow name.");
    }
    if (tab.savedFilePath !== undefined && typeof tab.savedFilePath !== "string") {
      throw new Error("NodeFlow tab state contains an invalid saved file path.");
    }
    if (ids.has(tab.id))
      throw new Error(`NodeFlow tab state contains duplicate tab id “${tab.id}”.`);
    ids.add(tab.id);
  }
}

export function parseNodeFlowTabs(input: any): NodeFlowTabsFile {
  const migrated = runMigrations<NodeFlowTabsFile>(
    input || {},
    NODEFLOW_TABS_VERSION,
    TAB_MIGRATIONS,
    "NodeFlow tab state",
  );
  validateNodeFlowTabsFile(migrated.value);
  return {
    ...migrated.value,
    migratedFrom: migrated.migrated ? migrated.fromVersion : undefined,
  };
}

export function serializeNodeFlowTabs(
  tabs: Array<{
    id: string;
    name: string;
    savedWorkflowName?: string;
    savedFilePath?: string;
    editingDefinitionId?: string;
  }>,
  activeTabId: string,
): NodeFlowTabsFile {
  return {
    version: NODEFLOW_TABS_VERSION,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      ...(tab.savedWorkflowName
        ? { savedWorkflowName: tab.savedWorkflowName }
        : {}),
      ...(tab.savedFilePath ? { savedFilePath: tab.savedFilePath } : {}),
      ...(tab.editingDefinitionId
        ? { editingDefinitionId: tab.editingDefinitionId }
        : {}),
    })),
    activeTabId,
  };
}
export const NODE_W = 184;
export const DASH_W = 470;
export const GROUP_W = 252;
export const CHART_BODY_H = 168;
export const DASH_BODY_H = 360;
export const SQL_BODY_H = 96; // default height of the read-only query body on a sql node
export const SQL_W = 300; // default width of a sql node (wider than NODE_W to show a line)
/** Soft ceiling for resized SQL/Python node bodies (was 820 — clipped long queries). */
export const SQL_BODY_H_MAX = 8000;
/** Minimum NodeFlow canvas world size; grows when nodes sit past the edge. */
export const CANVAS_MIN_W = 3200;
export const CANVAS_MIN_H = 2000;
export const CANVAS_PAD = 240;
export const HEAD_H = 30;
export const PORT_TOP = 46;
export const PORT_GAP = 24;
/** Icon-sphere node diameter (Settings → Visual → Sphere nodes). */
export const SPHERE_SIZE = 56;
/** Sphere ring stroke (px); must match `.nb2-node.sphere { border-width }`. */
export const SPHERE_RING = 3;
/** Port-center distance past the sphere rim so triangles clear the ring. */
export const SPHERE_PORT_OUTSET = 14;
/** Gap between sphere rim and floating under-node chart/dashboard panel. */
export const SPHERE_UNDER_GAP = 8;
/**
 * Extra gap for group/iterator under-panels: bottom-fanned left-rim inputs
 * (iterator vars/in, multi-in group) sit past the sphere bottom; the shared
 * chart gap is too tight and the panel (z-index above ports) covers them.
 *
 * Sized to clear the always-visible expand/minimize pill hung below the
 * sphere (see `.nb2-sphere-container-toggle` `bottom`), which itself clears
 * outset 14 + 14×16 triangle half + ring + margin (~44px past the rim).
 */
export const SPHERE_UNDER_GAP_CONTAINER = 48;
/** CSS `bottom` magnitude for the group/iterator sphere toggle pill (px). */
export const SPHERE_CONTAINER_PILL_BOTTOM = 44;

/** Vertical gap under the sphere rim before the floating under-panel. */
export function sphereUnderGap(n?: NbNode): number {
  const base =
    n && (n.type === "group" || n.type === "iterator")
      ? SPHERE_UNDER_GAP_CONTAINER
      : SPHERE_UNDER_GAP;
  return densify(base);
}
/**
 * Total angular span (radians) for multi-port fan on one side of the sphere.
 * Kept well under π so N outputs stay on the *right* rim (and inputs on the
 * *left*) with clear pixel separation — a full semicircle put extremes at
 * top/bottom dead-center where `contain: layout` + circular clipping hid them
 * (Join looked like a single out; Filter's true/false both left the right rim).
 */
export const SPHERE_PORT_SPREAD = Math.PI * 0.55;

/** Dense NodeFlow scale (Settings > View). Eye Care zooms chrome; dense
 *  shrinks canvas geometry so more nodes fit. Composes with Eye Care. */
export const NB_DENSE_SCALE = 0.85;

// React sets this via setNodeFlowDenseMode so layout helpers see the flag
// during the same render that toggles Settings (classList alone would lag
// one frame behind useEffect).
let _denseMode = false;
let _sphereMode = false;

export function setNodeFlowDenseMode(on: boolean): void {
  _denseMode = !!on;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("nb-dense", _denseMode);
    document.documentElement.setAttribute(
      "data-nb-dense",
      _denseMode ? "on" : "off",
    );
  }
}

export function nodeFlowDenseActive(): boolean {
  // Prefer the document class so React.lazy NodeFlow chunks share one truth
  // with App (module-level _denseMode is per-chunk after code split).
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("nb-dense");
  }
  return _denseMode;
}

export function setNodeFlowSphereMode(on: boolean): void {
  _sphereMode = !!on;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("nb-sphere", _sphereMode);
    document.documentElement.setAttribute(
      "data-nb-sphere",
      _sphereMode ? "on" : "off",
    );
  }
}

export function nodeFlowSphereActive(): boolean {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("nb-sphere");
  }
  return _sphereMode;
}

/**
 * Transparent icon-sphere chrome (vs classic box cards).
 *
 * Kept as boxes (strong product reason):
 * - text — sticky-note body is the canvas content
 *
 * Group and iterator use sphere chrome; their child lists float under the
 * sphere via `.nb2-sphere-under` (classic box mode unchanged). Chart /
 * dashboard keep sphere chrome when expanded; their viz floats the same way.
 *
 * SQL, Variable, Python, and Created Nodes (`usernode`) use spheres like
 * other leaves; edit in the inspector (classic mode still shows canvas
 * body previews where applicable).
 *
 * Pass `sphereMode` from React props when available so newly mounted cards
 * match Settings immediately even if the shared html/module flag lags a
 * frame (lazy chunks / first paint after create).
 */
export function nodeUsesSphereChrome(
  n: NbNode,
  sphereMode?: boolean,
): boolean {
  const on =
    sphereMode !== undefined ? !!sphereMode : nodeFlowSphereActive();
  if (!on) return false;
  if (n.type === "text") return false;
  return true;
}

/**
 * World top-left for a node dropped/created at a content-space point so the
 * cursor lands on the visual center (sphere) or classic header band.
 */
export function nodeSpawnOrigin(
  type: NodeType,
  contentX: number,
  contentY: number,
  sphereMode?: boolean,
): { x: number; y: number } {
  const probe: NbNode = { id: "", type, x: 0, y: 0, config: {} };
  const sphere = nodeUsesSphereChrome(probe, sphereMode);
  if (sphere) {
    const s = sphereSize();
    return { x: contentX - s / 2, y: contentY - s / 2 };
  }
  return {
    x: contentX - densify(NODE_W) / 2,
    y: contentY - densify(HEAD_H),
  };
}

function denseScale(): number {
  return nodeFlowDenseActive() ? NB_DENSE_SCALE : 1;
}

function densify(n: number): number {
  const s = denseScale();
  return s === 1 ? n : Math.max(1, Math.round(n * s));
}

export function sphereSize(): number {
  return densify(SPHERE_SIZE);
}

export const STORE_KEY = "samql.nodeflow.v1";
export const LEGACY_STORE_KEY = "samql.nodebook.v1";
// tabbed canvases: an index of tabs + a per-tab graph key
export const TABS_KEY = "samql.nodeflow.tabs.v3";
export const LEGACY_TABS_KEY = "samql.nodebook.tabs.v2";
export const TAB_KEY = (id: string) => "samql.nodeflow.tab." + id;
export const LEGACY_TAB_KEY = (id: string) => "samql.nodebook.tab." + id;
export const FAVORITES_KEY = "samql.nodeflow.favorites.v1";
export const LEGACY_FAVORITES_KEY = "samql.nodebook.favorites.v1";

/** Drop MIME for palette → canvas / favorites (built-in nodes). */
export const NB_NODE_MIME = "application/x-nb-node";
/** Drop MIME for created-node definitions. */
export const NB_CREATED_NODE_MIME = "application/x-nb-created-node";

// charts render under the node when expanded; dashboards are wider so their
// 2x2 board has room. Charts are hidden unless explicitly shown; dashboards
// / groups / iterators show unless explicitly collapsed (`config.collapsed`).
export function nodeShowsBody(n: NbNode) {
  if (n.type === "chart") return n.config.collapsed === false;
  if (
    n.type === "dashboard" ||
    n.type === "group" ||
    n.type === "iterator"
  ) {
    return n.config.collapsed !== true;
  }
  return false;
}

/**
 * Floating under-node panel size (chart/dashboard viz, group/iterator
 * children), or null when hidden. Callers only attach this panel under
 * sphere chrome.
 */
export function nodeUnderBodySize(n: NbNode): { w: number; h: number } | null {
  if (n.type === "group" || n.type === "iterator") {
    if (!nodeShowsBody(n)) return null;
    // Under-panel: 30px label bar + child rows (~30px) + gaps/padding.
    // Shared by group/iterator (no classic 30px head). Expand/minimize is
    // the always-visible sphere pill above this panel, not the bar.
    const bar = 30;
    const k = ((n.config && n.config.children) || []).length;
    const rows = Math.max(1, k);
    const h = Math.max(
      bar + 72,
      Math.min(360, bar + 8 + rows * 30 + Math.max(0, rows - 1) * 4),
    );
    return { w: densify(GROUP_W), h: densify(h) };
  }
  if ((n.type !== "chart" && n.type !== "dashboard") || !nodeShowsBody(n)) {
    return null;
  }
  const defW = densify(n.type === "dashboard" ? DASH_W : NODE_W);
  const defH = densify(n.type === "dashboard" ? DASH_BODY_H : CHART_BODY_H);
  const w =
    typeof n.config.bodyW === "number"
      ? Math.max(densify(NODE_W), Math.min(1100, densify(n.config.bodyW)))
      : defW;
  const h =
    typeof n.config.bodyH === "number"
      ? Math.max(110, Math.min(820, densify(n.config.bodyH)))
      : defH;
  return { w, h };
}

/**
 * Axis-aligned world bounds including a sphere's floating under-node panel
 * (centered horizontally under the sphere, gap below the rim).
 */
export function nodeWorldBounds(n: NbNode): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const x = Number(n.x) || 0;
  const y = Number(n.y) || 0;
  const w = nodeWidth(n);
  const h = nodeHeight(n);
  let x0 = x;
  let y0 = y;
  let x1 = x + w;
  let y1 = y + h;
  if (nodeUsesSphereChrome(n)) {
    const body = nodeUnderBodySize(n);
    if (body) {
      const gap = sphereUnderGap(n);
      const cx = x + w / 2;
      x0 = Math.min(x0, cx - body.w / 2);
      x1 = Math.max(x1, cx + body.w / 2);
      y1 = Math.max(y1, y + h + gap + body.h);
    }
  }
  return { x0, y0, x1, y1 };
}

export function nodeWidth(n: NbNode) {
  if (nodeUsesSphereChrome(n)) return sphereSize();
  if (n.type === "group" || n.type === "iterator") return densify(GROUP_W);
  if ((n.type === "chart" || n.type === "dashboard") && nodeShowsBody(n)) {
    return nodeUnderBodySize(n)?.w ?? densify(NODE_W);
  }
  if (n.type === "sql") {
    const w = n.config.bodyW;
    return typeof w === "number"
      ? Math.max(densify(NODE_W), Math.min(1100, densify(w)))
      : densify(SQL_W);
  }
  return densify(NODE_W);
}
/** Effective ports for layout (usernode trims to configured counts). */
export function portsOf(n: NbNode): { inputs: string[]; outputs: string[] } {
  const base = PORTS[n.type] || { inputs: [], outputs: [] };
  if (n.type !== "usernode") return base;
  const inCount = Math.max(
    0,
    Math.min(base.inputs.length, Number(n.config?.inputCount) || 0),
  );
  const outCount = Math.max(
    0,
    Math.min(base.outputs.length, Number(n.config?.outputCount) || 0),
  );
  return {
    inputs: base.inputs.slice(0, inCount),
    outputs: base.outputs.slice(0, outCount),
  };
}

export function nodeHeight(n: NbNode) {
  if (nodeUsesSphereChrome(n)) return sphereSize();
  const head = densify(HEAD_H);
  const portTop = densify(PORT_TOP);
  const portGap = densify(PORT_GAP);
  if (n.type === "text") {
    const lines = String(n.config.text || "")
      .split("\n")
      .reduce((a, ln) => a + Math.max(1, Math.ceil(ln.length / 26)), 0);
    return densify(Math.max(58, Math.min(40 + lines * 16, 240)));
  }
  if (n.type === "variable") {
    const k = ((n.config && n.config.vars) || []).filter(
      (v: any) => v && v.name,
    ).length;
    return densify(Math.max(58, Math.min(46 + Math.max(1, k) * 22, 260)));
  }
  const p = portsOf(n);
  const leftIns = p.inputs.filter((port) => !isTopInput(n.type, port));
  const rows = Math.max(leftIns.length, p.outputs.length, 1);
  const base = portTop + rows * portGap + densify(8);
  const bodyH = (def: number, maxH = 820) =>
    typeof n.config.bodyH === "number"
      ? Math.max(110, Math.min(maxH, densify(n.config.bodyH)))
      : densify(def);
  if (n.type === "chart" && nodeShowsBody(n)) return base + bodyH(CHART_BODY_H);
  if (n.type === "dashboard" && nodeShowsBody(n))
    return base + bodyH(DASH_BODY_H);
  if (n.type === "sql" || n.type === "python") {
    // Prefer explicit resize; otherwise grow with query/code lines so the
    // canvas preview is not stuck at ~96px (looks "cut off").
    if (typeof n.config.bodyH === "number") {
      return base + bodyH(SQL_BODY_H, densify(SQL_BODY_H_MAX));
    }
    const src =
      n.type === "sql"
        ? String(n.config.sql || "")
        : String(n.config.code || "");
    const lines = src.split("\n").reduce(
      (acc, ln) => acc + Math.max(1, Math.ceil(ln.length / 42)),
      0,
    );
    const auto = Math.max(
      densify(SQL_BODY_H),
      Math.min(densify(SQL_BODY_H_MAX), densify(24 + lines * 16)),
    );
    return base + auto;
  }
  if (n.type === "group" || n.type === "iterator") {
    // Classic collapse: header + ports only (sphere uses under-panel hide).
    if (!nodeShowsBody(n)) return Math.max(base, head + densify(8));
    const k = ((n.config && n.config.children) || []).length;
    return Math.max(
      base,
      head + densify(10) + Math.max(densify(50), k * densify(30) + densify(36)) + densify(10),
    );
  }
  return base;
}

/** Canvas world size: at least CANVAS_MIN_*, grows so nodes are never clipped. */
export function canvasWorldSize(nodes: NbNode[]): { w: number; h: number } {
  let maxX = CANVAS_MIN_W;
  let maxY = CANVAS_MIN_H;
  for (const n of nodes) {
    const b = nodeWorldBounds(n);
    maxX = Math.max(maxX, b.x1 + CANVAS_PAD);
    maxY = Math.max(maxY, b.y1 + CANVAS_PAD);
  }
  return { w: Math.ceil(maxX), h: Math.ceil(maxY) };
}

/**
 * Mid-drag world size: expand only so a node dragged past the edge is not
 * clipped, without thrashing shrink/grow every RAF. Callers recompute exact
 * size when the drag ends.
 */
export function canvasWorldSizeExpandOnly(
  prev: { w: number; h: number },
  nodes: NbNode[],
): { w: number; h: number } {
  const next = canvasWorldSize(nodes);
  return {
    w: Math.max(prev.w, next.w),
    h: Math.max(prev.h, next.h),
  };
}

/** True while NodeFlow node drag/resize sets the shared chrome lock flag. */
export function isNodeFlowPointerDragging(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.samqlNfDrag === "1";
}

// How many input ports a node actually shows. Most nodes show their whole
// static port list. A group shows only as many inputs as it needs: every
// connected input plus one spare to wire next, capped at the five it supports
// (and never fewer than one). So a freshly-dropped group shows a single input
// arrow instead of five empty ones, and a new arrow appears as you wire each.
// Critically this is also used to lay the arrows out and to anchor the wires,
// so the rendered triangles and the wire endpoints always agree.
export function visibleInputCount(n: NbNode, edges: NbEdge[]): number {
  const arr = portsOf(n).inputs;
  // .551: UNION shows ONE input triangle that accepts up to 10 stacked
  // connections. The 10 in1..in10 ports are backing slots; each new wire
  // auto-routes to the next free one, but only a single arrow is drawn.
  if (n.type === "union") return 1;
  if (n.type === "usernode") return Math.max(arr.length, 0);
  if (n.type !== "group") return arr.length;
  let maxIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    if (edges.some((e) => e.to.node === n.id && e.to.port === arr[i])) maxIdx = i;
  }
  return Math.min(arr.length, Math.max(1, maxIdx + 2));
}

export function visibleOutputCount(n: NbNode): number {
  return portsOf(n).outputs.length;
}
// Vertical offset (from the node's top) of port `idx` on a side. Ports are
// centered as a block within the node's height -- so a single in/out sits in
// the middle, and multiple ports (e.g. a join's three outputs) straddle the
// middle evenly. Chart/dashboard nodes showing a tall body keep their ports up
// near the header instead, where the in/out conceptually belong. `total` lets a
// caller override the port count (groups pass their visible-input count so the
// shown arrows centre correctly); it defaults to the static port list.
/**
 * Port center in the node's padding-box coordinates (CSS `left`/`top` for
 * absolutely positioned `.nb2-port.sphere-port`).
 *
 * Nodes use `box-sizing: border-box`, so the padding edge is inset by
 * {@link SPHERE_RING}. Wire world coords must add that ring back (see
 * {@link portXY}) — otherwise endpoints sit on the padding origin and miss
 * the visual center of the 14×16 triangles after `translate(-50%, -50%)`.
 */
export function spherePortOffset(
  n: NbNode,
  side: "in" | "out",
  idx: number,
  total?: number,
): { left: number; top: number } {
  const S = sphereSize();
  // CSS border is not densified; keep ring in sync with styles.css.
  const ring = SPHERE_RING;
  // Padding-box center of the circle (border-box center minus ring).
  const cx = S / 2 - ring;
  const cy = S / 2 - ring;
  // Distance from padding center to outer rim is S/2; sit past it so the
  // 14×16 triangle clears the stroke.
  const r = S / 2 + densify(SPHERE_PORT_OUTSET);
  // Default to the node's real port count (not 1) so Join's three outs,
  // Filter's true/false, multi-in joins, iterator vars+in, etc. fan around
  // the rim instead of stacking on a single angle. Classic "top" inputs
  // (iterator vars) join the left-rim fan in sphere mode.
  const ports = portsOf(n);
  const t = Math.max(
    1,
    total ?? (side === "in" ? ports.inputs.length : ports.outputs.length),
  );
  // Fan around the horizontal axis on each side (not a full semicircle).
  // Outputs cluster on the right rim; inputs on the left — top→bottom order.
  const spread = SPHERE_PORT_SPREAD;
  let angle: number;
  if (t === 1) {
    angle = side === "in" ? Math.PI : 0;
  } else {
    const u = idx / Math.max(1, t - 1); // 0…1
    if (side === "in") {
      // π + spread/2 (upper-left) → π - spread/2 (lower-left)
      angle = Math.PI + spread / 2 - u * spread;
    } else {
      // -spread/2 (upper-right) → +spread/2 (lower-right)
      angle = -spread / 2 + u * spread;
    }
  }
  return {
    left: cx + r * Math.cos(angle),
    top: cy + r * Math.sin(angle),
  };
}

export function portTopOffset(
  n: NbNode,
  side: "in" | "out",
  idx: number,
  total?: number,
) {
  if (nodeUsesSphereChrome(n)) {
    return spherePortOffset(n, side, idx, total).top;
  }
  const portTop = densify(PORT_TOP);
  const portGap = densify(PORT_GAP);
  if (
    ((n.type === "chart" || n.type === "dashboard") && nodeShowsBody(n)) ||
    n.type === "sql"
  ) {
    return portTop + idx * portGap;
  }
  const t =
    total ??
    (side === "in"
      ? portsOf(n).inputs.length
      : portsOf(n).outputs.length);
  const span = (t - 1) * portGap;
  return nodeHeight(n) / 2 - span / 2 + idx * portGap;
}
export function portXY(
  n: NbNode,
  side: "in" | "out",
  idx: number,
  total?: number,
) {
  const arr = side === "in" ? portsOf(n).inputs : portsOf(n).outputs;
  const port = arr[idx];
  if (nodeUsesSphereChrome(n)) {
    // Padding-box → border-box/world (see spherePortOffset).
    // All inputs (including classic top-edge ports like iterator "vars")
    // fan on the left rim — no separate top-of-sphere anchor.
    const ring = SPHERE_RING;
    const off = spherePortOffset(
      n,
      side,
      idx,
      total ?? arr.length,
    );
    // Sphere ports use translate(-50%,-50%) so left/top is the triangle
    // bounding-box center; both in/out glyphs point right, so that center
    // is the visual attachment point for the wire.
    return { x: n.x + ring + off.left, y: n.y + ring + off.top };
  }
  // top inputs (the iterator's "vars" driver) anchor on the top edge, centered
  if (side === "in" && isTopInput(n.type, port)) {
    return { x: n.x + nodeWidth(n) / 2, y: n.y };
  }
  if (side === "in") {
    // left inputs are laid out excluding any top inputs, so the remaining
    // arrows stay centered on the left edge (e.g. the iterator's lone "in")
    const left = arr.filter((p) => !isTopInput(n.type, p));
    if (left.length !== arr.length) {
      const li = Math.max(0, left.indexOf(port));
      return { x: n.x, y: n.y + portTopOffset(n, "in", li, left.length) };
    }
  }
  return {
    x: side === "in" ? n.x : n.x + nodeWidth(n),
    y: n.y + portTopOffset(n, side, idx, total),
  };
}


// The explicit state that determines a canvas node card's rendered output.
// Callback and JSX-child identities are deliberately absent: NodeFlow creates
// those closures/elements each parent render, but they do not change what an
// otherwise-stable node displays. This lets React.memo skip stationary cards
// while a different node is being dragged.
export interface CanvasNodeMemoState {
  node: NbNode;
  index: number;
  selected: boolean;
  dropHover: boolean;
  error?: string;
  warning?: string;
  ripple: boolean;
  snapped: boolean;
  dying: boolean;
  born: boolean;
  /** White glow when lineage modal highlights this node. */
  lineageFlash: boolean;
  /** Dense NodeFlow layout flag — module densify() is not visible to React.memo. */
  denseMode: boolean;
  /** Icon-sphere chrome flag — module sphere helpers are not visible to React.memo. */
  sphereMode: boolean;
  renderVersion: string;
  chartVersion: unknown;
  childSelection: string | null;
}

export function sameCanvasNodeMemoState(
  a: CanvasNodeMemoState,
  b: CanvasNodeMemoState,
): boolean {
  return (
    a.node === b.node &&
    a.index === b.index &&
    a.selected === b.selected &&
    a.dropHover === b.dropHover &&
    a.error === b.error &&
    a.warning === b.warning &&
    a.ripple === b.ripple &&
    a.snapped === b.snapped &&
    a.dying === b.dying &&
    a.born === b.born &&
    a.lineageFlash === b.lineageFlash &&
    a.denseMode === b.denseMode &&
    a.sphereMode === b.sphereMode &&
    a.renderVersion === b.renderVersion &&
    a.chartVersion === b.chartVersion &&
    a.childSelection === b.childSelection
  );
}
