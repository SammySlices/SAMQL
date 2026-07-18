import { backupLocalStorageValue, runMigrations } from "./migrations";
import { quoteSqlIdent } from "./sql";

// Notebook-mode logic: cell-chaining (let a cell query an earlier cell's
// result by name) and localStorage persistence of the cell list. Chaining is
// done purely on the front end by composing a WITH clause, so the backend just
// runs an ordinary query -- no new endpoints, no view lifecycle. A cell may
// only reference cells that appear before it, which keeps the graph acyclic;
// referenced cells are expanded depth-first (post-order) so each CTE precedes
// the ones that use it, satisfying SQLite's "no forward CTE references" rule.

export type NbCellType = "sql" | "note" | "chart" | "pivot" | "reconcile";

// Key/compare selection for a reconcile cell (unmapped, same-named columns;
// column-name mapping can be layered on later via colmap_a / colmap_b).
export interface NbReconSpec {
  keys: string[];
  compare: string[];
  balance?: string;
}

// The persisted shape of a cell (no transient run state / results).
export interface NbCellDef {
  id: string;
  type: NbCellType;
  name?: string; // stable handle for chaining, e.g. "cell1"
  code?: string; // sql cells
  text?: string; // note cells
  sourceName?: string; // chart/pivot cells: the cell they visualise
  leftSource?: string; // reconcile cells: left input (cell name or table)
  rightSource?: string; // reconcile cells: right input (cell name or table)
  recon?: NbReconSpec; // reconcile cells: key/compare/balance selection
  collapsed?: boolean; // cell minimized (body hidden) in the notebook
  boxW?: number; // user-resized box width (sql editor / note / chart / pivot)
  boxH?: number; // user-resized box height
  group?: string; // id of the group (section) this cell belongs to
}

// A group (section) of cells. Groups lay out left-to-right; each runs its cells
// top-to-bottom, and a later group can reference an earlier group's output.
export interface NbGroupDef {
  id: string;
  name: string;
  collapsed?: boolean; // section minimized to just its header
}

const NB_KEY = "samql.notebook.v1";

// Blank out comments and string literals so reference scanning never matches
// a cell name that only appears inside a comment or a quoted string.
function stripForScan(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Which of `names` appear as a whole identifier in `sql` (case-insensitive,
// not part of a longer identifier and not a qualified column like t.cell1).
// A double-quoted form ("Group 1") also counts, so a chain/group whose name
// isn't identifier-safe can still be referenced.
export function referencedNames(sql: string, names: string[]): string[] {
  const scan = stripForScan(sql);
  const out: string[] = [];
  for (const n of names) {
    const bare = new RegExp(`(?<![\\w".])${escapeRe(n)}(?![\\w"])`, "i");
    const quoted = new RegExp(`"${escapeRe(n)}"`, "i");
    if (bare.test(scan) || quoted.test(scan)) out.push(n);
  }
  return out;
}

function dropTrailingSemicolon(sql: string): string {
  return sql.replace(/\s*;\s*$/, "");
}

function quoteName(name: string): string {
  return quoteSqlIdent(name);
}

// Detect a leading WITH / WITH RECURSIVE on the target query, skipping leading
// whitespace and comments. Returns where the user's CTE list begins.
function leadingClause(
  sql: string,
): { kind: "with" | "with_recursive" | "none"; afterIdx: number } {
  const m = /^((?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*)(with\s+recursive\b|with\b)?/i.exec(
    sql,
  );
  if (!m || !m[2]) return { kind: "none", afterIdx: 0 };
  const kind = /recursive/i.test(m[2]) ? "with_recursive" : "with";
  return { kind, afterIdx: m.index + m[0].length };
}

function indent(sql: string): string {
  return sql
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

// Compose the SQL to actually run for a cell, expanding any references to
// earlier cells into CTEs. `earlier` is the ordered list of SQL cells that
// precede this one (each with a stable `name` and its own `sql`).
export function composeChainedSql(
  targetSql: string,
  earlier: { name: string; sql: string }[],
  materialized?: Set<string>,
): string {
  const byName = new Map<string, { name: string; sql: string }>();
  const names: string[] = [];
  for (const c of earlier) {
    if (c && c.name && c.sql != null && c.sql.trim()) {
      byName.set(c.name.toLowerCase(), c);
      names.push(c.name);
    }
  }
  if (names.length === 0) return targetSql;

  const needed: { name: string; sql: string }[] = [];
  const seen = new Set<string>();
  const visit = (sql: string) => {
    for (const n of referencedNames(sql, names)) {
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      // A materialized name resolves to a live TEMP VIEW over that cell's
      // already-computed result (journal chain reuse), so it is neither
      // inlined as a CTE nor walked for ITS dependencies -- its result
      // already embodies them.
      if (materialized && materialized.has(k)) continue;
      const dep = byName.get(k);
      if (!dep) continue;
      visit(dep.sql); // dependencies first (post-order)
      needed.push(dep);
    }
  };
  visit(targetSql);
  if (needed.length === 0) return targetSql;

  const cteList = needed
    .map(
      (c) => `${quoteName(c.name)} AS (\n${indent(dropTrailingSemicolon(c.sql))}\n)`,
    )
    .join(",\n");

  const lead = leadingClause(targetSql);
  if (lead.kind !== "none") {
    const head = lead.kind === "with_recursive" ? "WITH RECURSIVE " : "WITH ";
    const rest = targetSql.slice(lead.afterIdx).replace(/^\s+/, "");
    return `${head}${cteList},\n${rest}`;
  }
  return `WITH ${cteList}\n${dropTrailingSemicolon(targetSql)}`;
}

// Next free "cellN" handle given the names already in use.
export function nextCellName(existing: string[]): string {
  let max = 0;
  for (const n of existing) {
    const m = /^cell(\d+)$/i.exec(n || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `cell${max + 1}`;
}

// Normalise a user-typed cell name into a safe handle (letters/digits/_, with a
// leading letter or underscore). Returns "" if nothing usable remains.
export function sanitizeCellName(raw: string): string {
  let s = (raw || "").trim().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "";
  if (/^\d/.test(s)) s = "_" + s;
  return s;
}

// Make `name` unique among `taken` (case-insensitive) by suffixing _2, _3, ...
export function uniqueCellName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => (t || "").toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  let i = 2;
  while (lower.has(`${name}_${i}`.toLowerCase())) i++;
  return `${name}_${i}`;
}

// Rewrite whole-identifier references to a renamed cell within a SQL string so
// renaming a cell keeps later cells that query it working. Uses the same
// identifier boundaries as referencedNames (won't touch a qualified t.old or a
// longer identifier like old2).
export function renameInSql(
  sql: string,
  oldName: string,
  newName: string,
): string {
  if (!sql || !oldName || oldName === newName) return sql;
  const re = new RegExp(`(?<![\\w".])${escapeRe(oldName)}(?![\\w"])`, "gi");
  // Rewrite only in "code" spans: string literals, line comments and block
  // comments are copied verbatim so a name inside them is never touched.
  const tok = /('(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(sql)) !== null) {
    out += sql.slice(last, m.index).replace(re, newName);
    out += m[0];
    last = m.index + m[0].length;
  }
  out += sql.slice(last).replace(re, newName);
  return out;
}

// ---- persistence --------------------------------------------------------

// Validate a persisted/loaded reconcile spec, dropping anything malformed so a
// hand-edited or older file can't inject non-string keys.
export function sanitizeRecon(r: unknown): NbReconSpec | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const balance =
    typeof o.balance === "string" && o.balance ? o.balance : undefined;
  return { keys: strs(o.keys), compare: strs(o.compare), balance };
}

function slimCell(c: NbCellDef): NbCellDef {
  const viz = c.type === "chart" || c.type === "pivot";
  const recon = c.type === "reconcile";
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    code: c.type === "sql" ? c.code : undefined,
    text: c.type === "note" ? c.text : undefined,
    sourceName: viz ? c.sourceName : undefined,
    leftSource: recon ? c.leftSource : undefined,
    rightSource: recon ? c.rightSource : undefined,
    recon: recon ? c.recon : undefined,
    collapsed: c.collapsed || undefined,
    boxW: c.boxW || undefined,
    boxH: c.boxH || undefined,
    group: c.group || undefined,
  };
}

export function loadNotebook(): NbCellDef[] | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(NB_KEY);
    if (!raw) return null;
    const doc = migrateNotebookData(JSON.parse(raw));
    if (doc.migratedFrom !== undefined) {
      backupLocalStorageValue(NB_KEY, raw);
      window.localStorage.setItem(NB_KEY, JSON.stringify(notebookStorageValue(doc.cells, doc.groups)));
    }
    return doc.cells;
  } catch {
    return null;
  }
}

export function saveNotebook(cells: NbCellDef[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(NB_KEY, JSON.stringify(notebookStorageValue(cells)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

// ---- a small library of saved notebooks (localStorage) ------------------
// Index of notebooks + a per-notebook document key + a "current" pointer,
// plus a rolling recovery snapshot of whatever is being edited.

export interface NbMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  savedWorkflowName?: string;
  savedFilePath?: string;
}
export interface NbRecovery {
  id: string;
  name: string;
  at: number;
  cells: NbCellDef[];
}
export interface NbBootstrap {
  meta: NbMeta;
  cells: NbCellDef[];
  recoveredOrphan: NbRecovery | null;
}

const IDX_KEY = "samql.nb.index";
const NB_INDEX_VERSION = 2;
const CUR_KEY = "samql.nb.current";
const DOC_PREFIX = "samql.nb.doc.";
const RECOVERY_KEY = "samql.nb.recovery";

import { uid } from "./ids";

function nbId(): string {
  return uid("nb_");
}

// --- pure index helpers (no storage; unit-tested in node) ---
export function upsertMeta(index: NbMeta[], meta: NbMeta): NbMeta[] {
  const rest = index.filter((m) => m.id !== meta.id);
  return [meta, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function removeMeta(index: NbMeta[], id: string): NbMeta[] {
  return index.filter((m) => m.id !== id);
}
export function uniqueNbName(index: NbMeta[], base: string): string {
  const taken = new Set(index.map((m) => m.name.trim().toLowerCase()));
  const root = (base || "Untitled").trim() || "Untitled";
  if (!taken.has(root.toLowerCase())) return root;
  for (let i = 2; i < 9999; i++) {
    const cand = `${root} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${root} ${Date.now()}`;
}

// --- guarded localStorage I/O ---
function lsGet(k: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(k, v);
  } catch {
    /* quota / serialization */
  }
}
function lsDel(k: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function listNotebooks(): NbMeta[] {
  try {
    const raw = lsGet(IDX_KEY);
    const parsed = raw ? JSON.parse(raw) : { version: NB_INDEX_VERSION, notebooks: [] };
    const legacy = Array.isArray(parsed);
    const version = legacy ? 0 : Number.isInteger(parsed?.version) ? parsed.version : 0;
    if (version > NB_INDEX_VERSION) return [];
    const arr = legacy ? parsed : parsed?.notebooks;
    if (!Array.isArray(arr)) return [];
    const clean = arr
      .filter(
        (m) => m && typeof m.id === "string" && typeof m.name === "string",
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (raw && version !== NB_INDEX_VERSION) {
      backupLocalStorageValue(IDX_KEY, raw);
      writeIndex(clean);
    }
    return clean;
  } catch {
    return [];
  }
}
function writeIndex(index: NbMeta[]): void {
  lsSet(IDX_KEY, JSON.stringify({ version: NB_INDEX_VERSION, notebooks: index }));
}
export function currentNotebookId(): string | null {
  const id = lsGet(CUR_KEY);
  return id || null;
}
export function setCurrentNotebookId(id: string): void {
  lsSet(CUR_KEY, id);
}
export function loadNotebookDoc(id: string): NbCellDef[] | null {
  try {
    const key = DOC_PREFIX + id;
    const raw = lsGet(key);
    if (!raw) return null;
    const doc = migrateNotebookData(JSON.parse(raw));
    if (doc.migratedFrom !== undefined) {
      backupLocalStorageValue(key, raw);
      lsSet(key, JSON.stringify(notebookStorageValue(doc.cells, doc.groups)));
    }
    return doc.cells;
  } catch {
    return null;
  }
}
export function saveNotebookDoc(id: string, cells: NbCellDef[]): void {
  lsSet(DOC_PREFIX + id, JSON.stringify(notebookStorageValue(cells)));
  const idx = listNotebooks();
  const existing = idx.find((m) => m.id === id);
  const now = Date.now();
  const meta: NbMeta = existing
    ? { ...existing, updatedAt: now }
    : { id, name: "Untitled", createdAt: now, updatedAt: now };
  writeIndex(upsertMeta(idx, meta));
}

// Groups (sections) are stored in a small sidecar keyed by notebook id, so the
// cell serialization format never has to change. Each cell also carries its
// group id, so which cells belong to which group survives even a file
// round-trip; only the group names/order live here.
const GROUP_PREFIX = "samql.nb.groups.";
export const DEFAULT_GROUP_ID = "g1";
export function defaultGroups(): NbGroupDef[] {
  return [{ id: DEFAULT_GROUP_ID, name: "Group 1" }];
}
export function loadGroups(id: string): NbGroupDef[] | null {
  try {
    const key = GROUP_PREFIX + id;
    const raw = lsGet(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const legacy = Array.isArray(parsed);
    const version = legacy ? 0 : Number.isInteger(parsed?.version) ? parsed.version : 0;
    if (version > 1) return null;
    const arr = legacy ? parsed : parsed?.groups;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const clean = arr.filter(
      (g: any) => g && typeof g.id === "string" && typeof g.name === "string",
    );
    if (legacy) {
      backupLocalStorageValue(key, raw);
      saveGroups(id, clean);
    }
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}
export function saveGroups(id: string, groups: NbGroupDef[]): void {
  try {
    lsSet(GROUP_PREFIX + id, JSON.stringify({ version: 1, groups }));
  } catch {
    /* storage full / unavailable */
  }
}
export function createNotebook(name: string, cells: NbCellDef[]): NbMeta {
  const idx = listNotebooks();
  const now = Date.now();
  const meta: NbMeta = {
    id: nbId(),
    name: uniqueNbName(idx, name || "Untitled"),
    createdAt: now,
    updatedAt: now,
  };
  lsSet(DOC_PREFIX + meta.id, JSON.stringify(notebookStorageValue(cells)));
  writeIndex(upsertMeta(idx, meta));
  return meta;
}
export function renameNotebook(id: string, name: string): NbMeta | null {
  const idx = listNotebooks();
  const m = idx.find((x) => x.id === id);
  if (!m) return null;
  const others = idx.filter((x) => x.id !== id);
  const updated: NbMeta = {
    ...m,
    name: uniqueNbName(others, name || "Untitled"),
    updatedAt: Date.now(),
  };
  writeIndex(upsertMeta(others, updated));
  return updated;
}
export function setNotebookSaveIdentity(
  id: string,
  identity: { savedWorkflowName?: string; savedFilePath?: string },
): NbMeta | null {
  const idx = listNotebooks();
  const existing = idx.find((item) => item.id === id);
  if (!existing) return null;
  const updated: NbMeta = {
    ...existing,
    savedWorkflowName: identity.savedWorkflowName,
    savedFilePath: identity.savedFilePath,
    updatedAt: Date.now(),
  };
  writeIndex(upsertMeta(idx.filter((item) => item.id !== id), updated));
  return updated;
}
export function duplicateNotebook(id: string): NbMeta | null {
  const cells = loadNotebookDoc(id);
  if (!cells) return null;
  const idx = listNotebooks();
  const src = idx.find((x) => x.id === id);
  return createNotebook(src ? `${src.name} copy` : "Untitled copy", cells);
}
export function deleteNotebook(id: string): void {
  const idx = listNotebooks();
  const m = idx.find((x) => x.id === id);
  const cells = loadNotebookDoc(id);
  if (m && cells) writeRecovery(id, m.name, cells); // recoverable after delete
  lsDel(DOC_PREFIX + id);
  const next = removeMeta(idx, id);
  writeIndex(next);
  if (currentNotebookId() === id) setCurrentNotebookId(next[0]?.id || "");
}

// --- rolling recovery snapshot ---
export function writeRecovery(id: string, name: string, cells: NbCellDef[]): void {
  lsSet(
    RECOVERY_KEY,
    JSON.stringify({ id, name, at: Date.now(), cells: cells.map(slimCell) }),
  );
}
export function readRecovery(): NbRecovery | null {
  try {
    const raw = lsGet(RECOVERY_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && typeof o.id === "string" && Array.isArray(o.cells))
      return o as NbRecovery;
    return null;
  } catch {
    return null;
  }
}
export function clearRecovery(): void {
  lsDel(RECOVERY_KEY);
}

// --- bootstrap: migrate the legacy single notebook, guarantee a current one ---
export function ensureNotebookStore(seed: () => NbCellDef[]): NbBootstrap {
  let idx = listNotebooks();
  if (idx.length === 0) {
    const legacy = loadNotebook(); // old single-notebook key
    if (legacy && legacy.length) {
      const meta = createNotebook("My notebook", legacy);
      setCurrentNotebookId(meta.id);
      lsDel(NB_KEY);
      idx = listNotebooks();
    }
  }
  if (idx.length === 0) {
    const meta = createNotebook("Untitled", seed());
    setCurrentNotebookId(meta.id);
    idx = listNotebooks();
  }
  let curId = currentNotebookId();
  if (!curId || !idx.find((m) => m.id === curId)) {
    curId = idx[0].id;
    setCurrentNotebookId(curId);
  }
  const meta = idx.find((m) => m.id === curId) as NbMeta;
  let cells = loadNotebookDoc(curId);
  const rec = readRecovery();
  if ((!cells || cells.length === 0) && rec && rec.id === curId && rec.cells.length)
    cells = rec.cells;
  if (!cells) cells = seed();
  const recoveredOrphan = rec && !idx.find((m) => m.id === rec.id) ? rec : null;
  return { meta, cells, recoveredOrphan };
}

// ---- save to / open from a file on disk ---------------------------------
// A notebook file is plain JSON, so it survives clearing the browser cache
// and can be re-opened into SamQL at any time (or kept under version control).

// ---------------------------------------------------------------------------
// Pure journal logic extracted from Notebook.tsx (2026-07-01 test audit,
// phase 1): everything below is React-free and structurally typed so the
// node harness can exercise it directly with real inputs instead of the
// suite grepping the component's source.

/** Minimal cell shape the pure helpers need. */
export interface ChainCell {
  id: string;
  type: string;
  code: string;
  name?: string | null;
  group?: string | null;
  sourceName?: string | null;
  leftSource?: string | null;
  rightSource?: string | null;
  ranOnce?: boolean;
  resultId?: string | null;
  queryId?: string; // .520: the run that produced resultId (cancel plumbing)
  ranCompiledSql?: string | null;
  /** Session data_epoch observed when this result was produced. */
  ranDataEpoch?: number | null;
}

/** A cell whose parquet result can stand in for its SQL: it ran, isn't stale
 * against the canonical composition (`compiledNow`), wasn't capped (a capped
 * store is not the full answer), and still matches the session data epoch
 * when one is supplied (so an UPDATE/reload can't silently reuse old parquet). */
export function cellIsFresh(
  c: ChainCell,
  compiledNow: string | undefined,
  resultCapped: boolean,
  dataEpoch?: number,
): boolean {
  return !!(
    c.type === "sql" &&
    c.ranOnce &&
    c.resultId &&
    c.ranCompiledSql != null &&
    compiledNow === c.ranCompiledSql &&
    !resultCapped &&
    (dataEpoch === undefined || c.ranDataEpoch === dataEpoch)
  );
}

/** Keep the cells array grouped: stable within a group, groups in `gs` order.
 * Unknown / missing group ids fall into the first group. */
export function reorderByGroups<T extends { group?: string | null }>(
  list: T[],
  gs: { id: string }[],
  defaultGid: string = DEFAULT_GROUP_ID,
): T[] {
  const rank = new Map(gs.map((g, i) => [g.id, i] as const));
  const gid = (c: T) =>
    c.group && rank.has(c.group) ? c.group : gs[0]?.id || defaultGid;
  return list
    .map((c, i) => ({ c, i, r: rank.get(gid(c)) ?? 0 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** The LAST SQL cell (with code) in each group, by array order — the cell a
 * group-output alias resolves to. `uptoId` (when given) stops the walk before
 * that cell, matching "earlier cells only" semantics. */
export function lastSqlCellByGroup<T extends ChainCell>(
  list: T[],
  uptoId: string | null,
  gs: { id: string }[],
): Map<string, T> {
  const rank = new Map(gs.map((g, i) => [g.id, i] as const));
  const gidOf = (c: T) =>
    c.group && rank.has(c.group) ? (c.group as string) : gs[0]?.id;
  const out = new Map<string, T>();
  for (const c of list) {
    if (uptoId != null && c.id === uptoId) break;
    if (c.type === "sql" && c.code.trim()) {
      const g = gidOf(c);
      if (g) out.set(g, c);
    }
  }
  return out;
}

/** R1 chain reuse planning: walk the target's references; a FRESH name (in
 * `freshRid`, lowercase keys) is materialized server-side from its result —
 * so it is neither inlined nor walked for its own dependencies; a stale name
 * is inlined and ITS references examined the same way. Returns the reuse map
 * (original-cased names -> result ids) and the materialized name set for
 * composeChainedSql. */
export function planChainReuse(
  targetCode: string,
  earlier: { name: string; sql: string }[],
  freshRid: Map<string, string>,
): { reuse: Record<string, string>; materialized: Set<string> } {
  const names = earlier.map((e) => e.name);
  const sqlByName = new Map(
    earlier.map((e) => [e.name.toLowerCase(), e.sql] as const),
  );
  const reuse: Record<string, string> = {};
  const materialized = new Set<string>();
  const seen = new Set<string>();
  const walk = (sql: string) => {
    for (const n of referencedNames(sql, names)) {
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const rid = freshRid.get(k);
      if (rid) {
        materialized.add(k);
        reuse[n] = rid;
      } else {
        const s = sqlByName.get(k);
        if (s) walk(s);
      }
    }
  };
  walk(targetCode);
  return { reuse, materialized };
}


export interface JournalDependencyGraph {
  depIds: Record<string, string[]>;
  dependentIds: Record<string, string[]>;
  depNames: Record<string, string[]>;
  dependentNames: Record<string, string[]>;
}

/** Build the Journal DAG, including references through an earlier group name.
 * Real cell names take precedence over group aliases, matching SQL composition.
 * Edges always point backward in notebook order, so the graph is acyclic. */
export function buildJournalDependencyGraph(
  list: ChainCell[],
  groups: { id: string; name: string }[] = [],
): JournalDependencyGraph {
  const depIds: Record<string, string[]> = {};
  const dependentIds: Record<string, string[]> = {};
  const depNames: Record<string, string[]> = {};
  const dependentNames: Record<string, string[]> = {};
  const indexOf = new Map(list.map((c, i) => [c.id, i] as const));
  const realIdByName = new Map<string, string>();
  for (const c of list) {
    depIds[c.id] = [];
    dependentIds[c.id] = [];
    depNames[c.id] = [];
    dependentNames[c.id] = [];
    if (c.type === "sql" && c.name)
      realIdByName.set(c.name.toLowerCase(), c.id);
  }
  const realNames = new Set(realIdByName.keys());
  const rank = new Map(groups.map((g, i) => [g.id, i] as const));
  const defaultGroup = groups[0]?.id;
  const gidOf = (c: ChainCell) =>
    c.group && rank.has(c.group) ? c.group : defaultGroup;

  const addEdge = (fromId: string, to: ChainCell, label: string) => {
    if (!fromId || fromId === to.id) return;
    if ((indexOf.get(fromId) ?? 1e9) >= (indexOf.get(to.id) ?? -1)) return;
    if (depIds[to.id].includes(fromId)) return;
    depIds[to.id].push(fromId);
    depNames[to.id].push(label);
    dependentIds[fromId].push(to.id);
    dependentNames[fromId].push(to.name || to.id);
  };

  for (const c of list) {
    if (c.type === "sql" && c.code.trim()) {
      const names: string[] = [];
      const idForRef = new Map<string, string>();
      const ci = indexOf.get(c.id) ?? -1;
      for (const earlier of list) {
        const ei = indexOf.get(earlier.id) ?? 1e9;
        if (ei >= ci) break;
        if (earlier.type === "sql" && earlier.name && earlier.code.trim()) {
          names.push(earlier.name);
          idForRef.set(earlier.name.toLowerCase(), earlier.id);
        }
      }
      if (groups.length > 1) {
        const targetRank = rank.get(gidOf(c) as string) ?? 0;
        const last = lastSqlCellByGroup(list, c.id, groups);
        for (const g of groups) {
          if ((rank.get(g.id) ?? 0) >= targetRank) continue;
          const alias = g.name.trim();
          const src = last.get(g.id);
          if (!alias || !src || realNames.has(alias.toLowerCase())) continue;
          names.push(alias);
          idForRef.set(alias.toLowerCase(), src.id);
        }
      }
      for (const ref of referencedNames(c.code, names)) {
        const did = idForRef.get(ref.toLowerCase());
        if (did) addEdge(did, c, ref);
      }
    } else if ((c.type === "chart" || c.type === "pivot") && c.sourceName) {
      const did = realIdByName.get(c.sourceName.toLowerCase());
      if (did) addEdge(did, c, c.sourceName);
    } else if (c.type === "reconcile") {
      for (const src of [c.leftSource, c.rightSource]) {
        if (!src) continue;
        const did = realIdByName.get(src.toLowerCase());
        if (did) addEdge(did, c, src);
      }
    }
  }
  return { depIds, dependentIds, depNames, dependentNames };
}

export interface JournalRunPlan {
  runIds: string[];
  reusedIds: string[];
  waves: string[][];
  graph: JournalDependencyGraph;
}

/** Plan Run all so fresh cells are not sent to the server again.
 * Stale independent cells share a wave; stale dependencies are completed in
 * earlier waves. Fresh dependencies remain available through chain reuse. */
export function planJournalRunAll(
  list: ChainCell[],
  groups: { id: string; name: string }[],
  compiledById: Record<string, string | undefined>,
  cappedById: Record<string, boolean> = {},
  dataEpoch?: number,
): JournalRunPlan {
  const graph = buildJournalDependencyGraph(list, groups);
  const runnable = list.filter(
    (c) => c.type === "sql" && typeof c.code === "string" && c.code.trim(),
  );
  const reusedIds: string[] = [];
  const runIds: string[] = [];
  for (const c of runnable) {
    if (cellIsFresh(c, compiledById[c.id], !!cappedById[c.id], dataEpoch))
      reusedIds.push(c.id);
    else runIds.push(c.id);
  }

  const order = new Map(runnable.map((c, i) => [c.id, i] as const));
  const pending = new Set(runIds);
  const waves: string[][] = [];
  while (pending.size) {
    const wave = runIds.filter((id) => {
      if (!pending.has(id)) return false;
      return (graph.depIds[id] || []).every(
        (dep) => !pending.has(dep),
      );
    });
    // Defensive fallback for a hand-edited/corrupt notebook. Normal notebook
    // references are backward-only, so this branch is never needed in healthy
    // state, but it prevents Run all from hanging forever on a cycle.
    if (!wave.length) {
      const first = Array.from(pending).sort(
        (a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9),
      )[0];
      wave.push(first);
    }
    waves.push(wave);
    for (const id of wave) pending.delete(id);
  }
  return { runIds, reusedIds, waves, graph };
}

/** The journal dependency export as CSV (Cell, SQL, uses, feeds) with a BOM
 * so Excel reads UTF-8, RFC-quoted cells, CRLF rows. */
export function journalGraphCsv(
  rows: { label: string; group?: string; sql: string; uses: string[];
    feeds: string[] }[],
): string {
  const uniq = (a: string[]) => Array.from(new Set(a));
  const csvCell = (v: string) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ["Cell", "Group", "SQL", "uses", "feeds"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows)
    lines.push(
      [r.label, r.group || "", r.sql, uniq(r.uses).join(", "),
       uniq(r.feeds).join(", ")]
        .map(csvCell)
        .join(","),
    );
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

export const NB_FILE_FORMAT = "samql-notebook";
export const NB_FILE_VERSION = 2;

export interface NotebookFile {
  format: string;
  version: number;
  savedAt: string;
  cells: NbCellDef[];
  groups?: NbGroupDef[];
  migratedFrom?: number;
}

const NOTEBOOK_MIGRATIONS = {
  0: (raw: any) => ({
    format: NB_FILE_FORMAT,
    version: 1,
    savedAt: "",
    cells: Array.isArray(raw) ? raw : raw?.cells || [],
    groups: Array.isArray(raw?.groups) ? raw.groups : undefined,
  }),
  1: (raw: any) => ({
    ...raw,
    format: NB_FILE_FORMAT,
    version: 2,
    savedAt: typeof raw?.savedAt === "string" ? raw.savedAt : "",
    cells: Array.isArray(raw?.cells) ? raw.cells : [],
    groups: Array.isArray(raw?.groups) ? raw.groups : undefined,
  }),
};

function migrateNotebookData(data: any): NotebookFile {
  if (!Array.isArray(data) && data?.format && data.format !== NB_FILE_FORMAT)
    throw new Error("This doesn't look like a SamQL notebook file.");
  const migrated = runMigrations<NotebookFile>(
    data,
    NB_FILE_VERSION,
    NOTEBOOK_MIGRATIONS,
    "This SamQL notebook",
  );
  if (!Array.isArray(migrated.value.cells))
    throw new Error("This SamQL notebook is missing its cells.");
  return {
    ...migrated.value,
    migratedFrom: migrated.migrated ? migrated.fromVersion : undefined,
  };
}

function notebookStorageValue(cells: NbCellDef[], groups?: NbGroupDef[]) {
  return {
    format: NB_FILE_FORMAT,
    version: NB_FILE_VERSION,
    savedAt: new Date().toISOString(),
    cells: cells.map(slimCell),
    ...(groups && groups.length > 1 ? { groups } : {}),
  };
}

export function serializeNotebook(
  cells: NbCellDef[],
  groups?: NbGroupDef[],
): string {
  return JSON.stringify(notebookStorageValue(cells, groups), null, 2);
}

export function parseNotebookDocument(text: string): NotebookFile {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return migrateNotebookData(data);
}

export function parseNotebookGroups(text: string): NbGroupDef[] | null {
  const gs = parseNotebookDocument(text).groups;
  if (!Array.isArray(gs) || gs.length === 0) return null;
  const clean = gs.filter(
    (g: any) => g && typeof g.id === "string" && typeof g.name === "string",
  );
  return clean.length ? clean : null;
}

// Parse a saved notebook file into cell definitions. Accepts either the
// wrapped {format,version,cells} object or a bare array of cells. Throws a
// human-readable Error if the text isn't a usable notebook. SQL cells missing
// a handle are given a fresh cellN so chaining still works.
export function parseNotebookFile(text: string): NbCellDef[] {
  const raw = parseNotebookDocument(text).cells;

  const names: string[] = [];
  const out: NbCellDef[] = [];
  for (const c of raw) {
    if (
      !c ||
      (c.type !== "sql" &&
        c.type !== "note" &&
        c.type !== "chart" &&
        c.type !== "pivot" &&
        c.type !== "reconcile")
    )
      continue;
    const viz = c.type === "chart" || c.type === "pivot";
    const isRecon = c.type === "reconcile";
    let name: string | undefined =
      typeof c.name === "string" && c.name ? c.name : undefined;
    if (c.type === "sql") {
      if (!name) name = nextCellName(names);
      names.push(name);
    }
    out.push({
      id: typeof c.id === "string" && c.id ? c.id : `nbf${out.length}`,
      type: c.type,
      name: c.type === "sql" ? name : undefined,
      code:
        c.type === "sql" ? (typeof c.code === "string" ? c.code : "") : undefined,
      text:
        c.type === "note" ? (typeof c.text === "string" ? c.text : "") : undefined,
      sourceName:
        viz && typeof c.sourceName === "string" ? c.sourceName : undefined,
      leftSource:
        isRecon && typeof c.leftSource === "string" ? c.leftSource : undefined,
      rightSource:
        isRecon && typeof c.rightSource === "string"
          ? c.rightSource
          : undefined,
      recon: isRecon ? sanitizeRecon(c.recon) : undefined,
      collapsed: c.collapsed === true ? true : undefined,
    });
  }
  if (out.length === 0) throw new Error("No cells found in this notebook file.");
  return out;
}

// ---- relational families (shred output) ---------------------------------
// A "family" is a shred result set: children named `<root>_<path>` that
// carry the `_rid` join key, grouped under their root table in the sidebar.
export interface FamilyTable {
  name: string;
  engine?: string;
  columns?: { name: string }[];
  parent?: string | null; // .501: explicit flatten parentage from the backend
}

const colNames = (t: FamilyTable) => (t.columns || []).map((c) => c.name);

export function groupRelationalFamilies<T extends FamilyTable>(
  tables: T[],
): { table: T; children: T[] }[] {
  const byName = new Map<string, T>();
  for (const t of tables) byName.set(t.name, t);
  const childOf = new Map<string, string>();
  for (const t of tables) {
    // .501: explicit parentage from the backend wins -- path-only child
    // names ("json", "legs") carry no parent in the name, so prefix
    // guessing can't place them (and can even mis-parent across loads).
    const explicit = (t as any).parent as string | undefined | null;
    if (explicit && byName.has(explicit) && byName.get(explicit) !== t) {
      const p = byName.get(explicit)!;
      if ((p as any).engine === (t as any).engine) {
        childOf.set(t.name, explicit);
        continue;
      }
    }
    if (!colNames(t).includes("_rid")) continue;
    // legacy fallback (pre-.501 names / restarted sessions): deepest
    // existing prefix wins: trades_legs_cashflows -> trades_legs
    const parts = t.name.split("_");
    for (let i = parts.length - 1; i >= 1; i--) {
      const cand = parts.slice(0, i).join("_");
      const p = byName.get(cand);
      if (p && p !== t && (p as any).engine === (t as any).engine) {
        childOf.set(t.name, cand);
        break;
      }
    }
  }
  // resolve every child to its TOP root so one caret holds the whole family
  const rootOf = (n: string): string => {
    let cur = n;
    while (childOf.has(cur)) cur = childOf.get(cur)!;
    return cur;
  };
  const kids = new Map<string, T[]>();
  for (const name of childOf.keys()) {
    const root = rootOf(name);
    if (!kids.has(root)) kids.set(root, []);
    kids.get(root)!.push(byName.get(name)!);
  }
  const familyChildRank = (n: string) => {
    if (n === "Master_Keys" || /^Master_Keys_\d+$/i.test(n)) return 0;
    if (n === "Join_Keys" || /^Join_Keys_\d+$/i.test(n)) return 1;
    return 2;
  };
  const out: { table: T; children: T[] }[] = [];
  for (const t of tables) {
    if (childOf.has(t.name)) continue; // rendered under its root
    const ch = (kids.get(t.name) || []).slice().sort(
      (a, b) =>
        familyChildRank(a.name) - familyChildRank(b.name) ||
        a.name.localeCompare(b.name),
    );
    out.push({ table: t, children: ch });
  }
  return out;
}

/** Flat catalog order after dragging a family root from ``from`` to ``to``.
 * Children stay immediately under their root so family grouping is preserved. */
export function flattenFamilyOrderAfterReorder<T extends FamilyTable>(
  families: { table: T; children: T[] }[],
  from: number,
  to: number,
): { engine: string; name: string }[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= families.length ||
    to >= families.length
  ) {
    return families.flatMap((f) => [
      { engine: String((f.table as any).engine || "duckdb"), name: f.table.name },
      ...f.children.map((c) => ({
        engine: String((c as any).engine || "duckdb"),
        name: c.name,
      })),
    ]);
  }
  const next = families.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.flatMap((f) => [
    { engine: String((f.table as any).engine || "duckdb"), name: f.table.name },
    ...f.children.map((c) => ({
      engine: String((c as any).engine || "duckdb"),
      name: c.name,
    })),
  ]);
}

export function familyJoinKeys(
  parent: FamilyTable,
  child: FamilyTable,
): string[] {
  const isKey = (c: string) => c === "_rid" || /_ord$/.test(c);
  const pc = new Set(colNames(parent).filter(isKey));
  return colNames(child).filter((c) => isKey(c) && pc.has(c));
}

export function familyJoinSql(parent: FamilyTable, child: FamilyTable): string {
  const q = (n: string) => '"' + n.replace(/"/g, '""') + '"';
  // .501: prefer the one-column surrogate join (child._parent_sk =
  // parent._sk) when both sides carry it -- it is exact at every depth,
  // where shared _rid/_ord keys only reach the source-record grain.
  const pc = new Set(colNames(parent));
  const cc = new Set(colNames(child));
  const direct = (child as any).parent === parent.name;
  if (direct && pc.has("_sk") && cc.has("_parent_sk")) {
    // only when joining a child to its RECORDED immediate parent --
    // a grandchild's _parent_sk holds the MID-parent's _sk, not the
    // root's, so the surrogate join would match nothing there.
    return (
      `SELECT *\nFROM ${q(parent.name)} p\nJOIN ${q(child.name)} c ` +
      `ON c."_parent_sk" = p."_sk"\nLIMIT 100`
    );
  }
  const keys = familyJoinKeys(parent, child);
  const using = keys.length
    ? `USING (${keys.map(q).join(", ")})`
    : `ON /* no shared keys found */ 1 = 1`;
  return (
    `SELECT *\nFROM ${q(parent.name)}\nJOIN ${q(child.name)} ${using}\n` +
    `LIMIT 100`
  );
}
