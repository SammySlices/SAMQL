// Pure helpers for keeping a Select node's field list in sync with the columns
// flowing out of the node upstream of it. Kept dependency-free so it can be
// unit-tested under Node, and so the same logic backs the canvas inspector.

export type SelField = {
  name: string;
  keep?: boolean;
  rename?: string;
  type?: string;
};

/** Non-empty rename the user typed for a Select field (trimmed). */
export function selectFieldRename(f: SelField | null | undefined): string {
  return String(f?.rename || "").trim();
}

/**
 * True when this Select field's source column is not in the current upstream
 * column list (case-insensitive). Used for inspector strikethrough / missing
 * styling on kept, unchecked, and renamed tombstones.
 *
 * `null` / `undefined` upstream means columns are not known yet (selection
 * switch / probe in flight) — treat as not missing so the inspector does not
 * flash every field as tombstoned. An empty array means upstream is known and
 * empty; those fields are missing.
 */
export function isSelectFieldMissingUpstream(
  f: SelField,
  upstreamCols: string[] | null | undefined,
): boolean {
  const name = String(f?.name || "").trim();
  if (!name) return true;
  if (upstreamCols == null) return false;
  const up = new Set(upstreamCols.map((c) => String(c).toLowerCase()));
  return !up.has(name.toLowerCase());
}

/**
 * Rebuild a Select node's field list against the columns it now receives,
 * WITHOUT disturbing the order the user put them in.
 *
 *   - columns the user already has are kept in their current order (so a manual
 *     drag-reorder, or any chosen order, survives a re-run / column refresh),
 *     carrying their prior keep / rename / type,
 *   - a newly-available column (a formula's new column, or a column an upstream
 *     Select just renamed into existence) is appended at the end, kept by
 *     default,
 *   - a column that no longer exists upstream is RETAINED as a missing
 *     tombstone (kept, unchecked, or renamed). The inspector shows these with
 *     strikethrough; the user clears them via "Clear missing" or a successful
 *     workflow rerun — never by schema-refresh alone.
 *
 * Keeping surviving columns in the user's order is what lets a drag-reorder
 * stick; appending new columns (without auto-dropping gone ones) is what lets
 * a downstream node see upstream adds while preserving user settings.
 */
export function reconcileSelectFields(
  upstreamCols: string[],
  current: SelField[],
): SelField[] {
  const cols = upstreamCols || [];
  // match names case-insensitively -- the backend Select resolves columns
  // case-insensitively, so a case-only upstream rename (Name -> name) must
  // keep the user's field (its keep / rename / type / order), not be treated
  // as a remove + re-add that discards those settings.
  const seen = new Set<string>();
  const out: SelField[] = [];
  // Keep every existing field in user order (including missing sources).
  for (const f of current || []) {
    const key = String(f.name).toLowerCase();
    if (seen.has(key)) continue;
    out.push(f);
    seen.add(key);
  }
  // append columns that are genuinely new upstream (not already matched
  // case-insensitively above), in upstream order
  for (const c of cols) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      out.push({ name: c, keep: true });
      seen.add(key);
    }
  }
  return out;
}

/**
 * Drop Select fields whose source column is absent from upstream.
 * Used by the inspector "Clear missing" button and by post-run prune —
 * never by schema-refresh reconcile alone.
 */
export function clearMissingSelectFields(
  fields: SelField[],
  upstreamCols: string[] | null | undefined,
): SelField[] {
  const list = fields || [];
  // Without a known upstream schema, do not wipe the list.
  if (!upstreamCols || !upstreamCols.length) return list;
  return list.filter((f) => !isSelectFieldMissingUpstream(f, upstreamCols));
}

/** True when two field lists differ in their column names or order (a cheap
 *  guard so the inspector only writes when something actually changed). */
export function fieldsDiffer(a: SelField[], b: SelField[]): boolean {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return true;
  return x.some((f, i) => f.name !== y[i]?.name);
}

/**
 * Filter the Select field list for the inspector search box. Matches against
 * the source column name and any rename the user typed (case-insensitive
 * substring). Empty query returns the list unchanged.
 */
export function filterSelectFields(
  fields: SelField[],
  query: string,
): SelField[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return fields || [];
  return (fields || []).filter((f) => {
    const name = String(f?.name || "").toLowerCase();
    const rename = String(f?.rename || "").toLowerCase();
    return name.includes(q) || rename.includes(q);
  });
}

/**
 * Sort Select fields by column name (case-insensitive). Does not mutate the
 * input. Asc/desc toggle backs the inspector Sort button next to All/None.
 */
export function sortSelectFields(
  fields: SelField[],
  dir: "asc" | "desc" = "asc",
): SelField[] {
  const mul = dir === "desc" ? -1 : 1;
  return [...(fields || [])].sort(
    (a, b) =>
      mul *
      String(a?.name || "").localeCompare(String(b?.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
  );
}

/**
 * Apply keep=true/false to every field whose name is in `names` (the
 * currently visible/filtered set). Fields outside the set are left alone so
 * All/None while searching only touches what the user can see.
 */
export function setFieldsKept(
  fields: SelField[],
  keep: boolean,
  names?: Iterable<string> | null,
): SelField[] {
  const list = fields || [];
  if (names == null) return list.map((f) => ({ ...f, keep }));
  const want = new Set(names);
  return list.map((f) => (want.has(f.name) ? { ...f, keep } : f));
}

/** A Select node and how its `in` port is fed. */
export type SelectUpstreamReq = {
  selectId: string;
  /** Canvas edge into a top-level Select, or into a group's bound input. */
  kind: "canvas" | "group-input" | "step-above";
  upstreamNode?: string;
  upstreamPort?: string;
  groupId?: string;
  /** Group input port name when kind is group-input. */
  groupPort?: string;
  /** Child index when kind is step-above (fetch via partialGroupGraph). */
  childIndex?: number;
};

type GraphNode = {
  id: string;
  type: string;
  config?: Record<string, any>;
};

type GraphEdge = {
  to: { node: string; port: string };
  from: { node: string; port: string };
};

/**
 * Every wired Select in the graph -- top-level AND group/iterator children.
 * Used so an upstream Input table change refreshes Select fields even when
 * the Select lives inside a container and is not selected.
 */
export function listWiredSelectUpstreams(
  nodes: GraphNode[],
  edges: GraphEdge[],
): SelectUpstreamReq[] {
  const out: SelectUpstreamReq[] = [];
  const edgeList = edges || [];
  for (const n of nodes || []) {
    if (n.type === "select") {
      const e = edgeList.find(
        (x) => x.to.node === n.id && x.to.port === "in",
      );
      if (e)
        out.push({
          selectId: n.id,
          kind: "canvas",
          upstreamNode: e.from.node,
          upstreamPort: e.from.port,
        });
      continue;
    }
    if (n.type !== "group" && n.type !== "iterator") continue;
    const children = (n.config?.children || []) as any[];
    const bindsRoot = (n.config?.bindings || {}) as Record<
      string,
      Record<string, string>
    >;
    children.forEach((child, index) => {
      if (!child || child.type !== "select" || !child.id) return;
      const binds = bindsRoot[child.id] || {};
      const gp =
        binds.in || (index === 0 ? "in" : null);
      if (gp) {
        const e = edgeList.find(
          (x) => x.to.node === n.id && x.to.port === gp,
        );
        if (e) {
          out.push({
            selectId: child.id,
            kind: "group-input",
            upstreamNode: e.from.node,
            upstreamPort: e.from.port,
            groupId: n.id,
            groupPort: gp,
          });
        }
      } else if (index > 0) {
        out.push({
          selectId: child.id,
          kind: "step-above",
          groupId: n.id,
          childIndex: index,
        });
      }
    });
  }
  return out;
}

function reconcileOneSelectConfig(
  config: Record<string, any> | undefined,
  cols: string[],
): { config: Record<string, any>; changed: boolean } {
  const cur = (config?.fields || []) as SelField[];
  const fields = reconcileSelectFields(cols, cur);
  if (!fieldsDiffer(fields, cur))
    return { config: config || {}, changed: false };
  return { config: { ...(config || {}), fields }, changed: true };
}

/**
 * Apply freshly fetched upstream columns onto every Select in `nodes`,
 * including Selects nested in group/iterator children. Returns the same
 * array reference when nothing changed.
 */
export function applySelectColumnsReconcile<T extends GraphNode>(
  nodes: T[],
  columnsBySelectId: Record<string, string[]>,
): T[] {
  const map = columnsBySelectId || {};
  let changed = false;
  const next = (nodes || []).map((n) => {
    if (n.type === "select") {
      const cols = map[n.id];
      if (!cols || !cols.length) return n;
      const { config, changed: c } = reconcileOneSelectConfig(n.config, cols);
      if (!c) return n;
      changed = true;
      return { ...n, config } as T;
    }
    if (n.type !== "group" && n.type !== "iterator") return n;
    const children = [...((n.config?.children || []) as any[])];
    let childChanged = false;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.type !== "select") continue;
      const cols = map[child.id];
      if (!cols || !cols.length) continue;
      const { config, changed: c } = reconcileOneSelectConfig(
        child.config,
        cols,
      );
      if (!c) continue;
      children[i] = { ...child, config };
      childChanged = true;
    }
    if (!childChanged) return n;
    changed = true;
    return {
      ...n,
      config: { ...n.config, children },
    } as T;
  });
  return changed ? next : nodes;
}

/** Collect Select ids whose fields differ between two node trees (for patch). */
export function collectSelectFieldPatches(
  before: GraphNode[],
  after: GraphNode[],
): { id: string; fields: SelField[] }[] {
  const patches: { id: string; fields: SelField[] }[] = [];
  const beforeById = new Map<string, GraphNode>();
  const walk = (list: GraphNode[], into: Map<string, GraphNode>) => {
    for (const n of list || []) {
      into.set(n.id, n);
      if (n.type === "group" || n.type === "iterator") {
        for (const c of (n.config?.children || []) as GraphNode[]) {
          if (c?.id) into.set(c.id, c);
        }
      }
    }
  };
  walk(before, beforeById);
  const seen = new Set<string>();
  const consider = (n: GraphNode | undefined) => {
    if (!n || n.type !== "select" || seen.has(n.id)) return;
    seen.add(n.id);
    const prev = beforeById.get(n.id);
    const fields = (n.config?.fields || []) as SelField[];
    const prevFields = (prev?.config?.fields || []) as SelField[];
    if (fieldsDiffer(fields, prevFields))
      patches.push({ id: n.id, fields });
  };
  for (const n of after || []) {
    consider(n);
    if (n.type === "group" || n.type === "iterator") {
      for (const c of (n.config?.children || []) as GraphNode[]) consider(c);
    }
  }
  return patches;
}
