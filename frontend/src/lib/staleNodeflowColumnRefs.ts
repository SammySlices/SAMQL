import { PORTS, type NodeType } from "./nodeFlowModel";

export type StaleColumnRef = {
  area: string;
  columns: string[];
};

const SKIP_TYPES = new Set<NodeType>(["select", "pivot"]);

/** Every node type with stale-ref detection (kept in sync with the switch below). */
export const STALE_REF_NODE_TYPES: readonly NodeType[] = [
  "filter",
  "formula",
  "summarize",
  "sort",
  "unique",
  "unpivot",
  "window",
  "perioddelta",
  "bin",
  "rank",
  "fill",
  "dedupe",
  "split",
  "jsonextract",
  "explode",
  "textclean",
  "maprecode",
  "parse",
  "topn",
  "coalesce",
  "renamecols",
  "validate",
  "chart",
  "join",
  "multijoin",
  "antijoin",
  "reconcile",
  "groupconcat",
  "date",
  "iterator",
  "while",
] as const;

/**
 * Never auto-prune on schema refresh / inspCols settle. Missing refs stay
 * visible (strikethrough) until the user clears them or a successful workflow
 * rerun prunes them. Freeform filter/formula were already in this set (typing
 * mid-identifier looked "stale"); structured nodes now follow the same rule.
 */
export const NO_AUTO_PRUNE_STALE_TYPES = new Set<NodeType>([
  ...STALE_REF_NODE_TYPES,
]);

const SQL_WORDS = new Set([
  "and",
  "or",
  "not",
  "null",
  "true",
  "false",
  "in",
  "is",
  "as",
  "on",
  "by",
  "asc",
  "desc",
  "case",
  "when",
  "then",
  "else",
  "end",
  "if",
  "like",
  "between",
  "from",
  "where",
  "select",
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "coalesce",
  "cast",
  "integer",
  "real",
  "text",
  "upper",
  "lower",
  "trim",
  "length",
  "substr",
  "replace",
  "instr",
  "round",
  "abs",
  "nullif",
  "ifnull",
  "input",
]);

function colSet(cols: string[] | undefined): Set<string> {
  return new Set((cols || []).map((c) => c.toLowerCase()));
}

function missing(stored: string | undefined | null, live: Set<string>): string | null {
  const s = (stored || "").trim();
  if (!s) return null;
  return live.has(s.toLowerCase()) ? null : s;
}

function missingMany(stored: string[], live: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of stored || []) {
    const m = missing(s, live);
    if (m && !seen.has(m.toLowerCase())) {
      out.push(m);
      seen.add(m.toLowerCase());
    }
  }
  return out;
}

function pushStale(out: StaleColumnRef[], area: string, columns: string[]) {
  if (!columns.length) return;
  const row = out.find((x) => x.area === area);
  if (row) {
    for (const c of columns) {
      if (!row.columns.some((x) => x.toLowerCase() === c.toLowerCase())) row.columns.push(c);
    }
    return;
  }
  out.push({ area, columns: [...columns] });
}

/** Drop spans that can never name a column: single-quoted string literals and
 *  ``{{var}}`` / ``${var}`` workflow placeholders. */
function stripNonColumnSpans(text: string): string {
  return String(text || "")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\$\{[^}]*\}/g, " ");
}

/** Column refs written with explicit ``[brackets]`` or ``"quotes"``.
 *
 *  These are the only unambiguous form: a bare word in a free-form expression
 *  may equally be a function name or an identifier the user is still halfway
 *  through typing. Callers that DESTROY user text must use this, not
 *  ``exprColumnRefs``. */
export function delimitedExprColumnRefs(text: string): string[] {
  const stripped = stripNonColumnSpans(text);
  const names = new Set<string>();
  for (const m of stripped.matchAll(/\[([^\]]+)\]/g)) names.add(m[1].trim());
  for (const m of stripped.matchAll(/"((?:[^"]|"")*)"/g))
    names.add(m[1].replace(/""/g, '"').trim());
  return [...names].filter(Boolean);
}

/** Pull column-ish identifiers from a free-form expression (filter / formula).
 *  Bracketed / double-quoted names are taken as whole identifiers (so
 *  ``[Order Date]`` is one ref, not bare ``Order`` + ``Date``). Bare-word
 *  scanning runs only on the leftover text after those spans are removed. */
export function exprColumnRefs(text: string): string[] {
  const stripped = stripNonColumnSpans(text);
  const names = new Set<string>(delimitedExprColumnRefs(text));
  // Do not re-tokenize insides of [..] / ".." — spaced headers would otherwise
  // look like missing bare columns while the real quoted/bracketed name exists.
  const bareSrc = stripped
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ")
    // A trailing unclosed ``[Amoun`` is a reference still being typed (the
    // autocomplete popup is open on it) — not a missing column.
    .replace(/\[[^\]]*$/, " ");
  for (const m of bareSrc.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0];
    if (SQL_WORDS.has(w.toLowerCase())) continue;
    // ``FOO(`` is a call, not a column. Skipping these keeps every function
    // the engine supports (LTRIM, regexp_replace, strftime, …) out of the
    // missing-column list without having to enumerate them all here.
    if (/^\s*\(/.test(bareSrc.slice(m.index + w.length))) continue;
    names.add(w);
  }
  return [...names].filter(Boolean);
}

function staleExprs(
  area: string,
  exprs: string[],
  live: Set<string>,
  out: StaleColumnRef[],
) {
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const e of exprs) {
    for (const ref of exprColumnRefs(e)) {
      const m = missing(ref, live);
      if (m && !seen.has(m.toLowerCase())) {
        stale.push(m);
        seen.add(m.toLowerCase());
      }
    }
  }
  pushStale(out, area, stale);
}

function hasLiveCols(upstreamCols: Record<string, string[]>, port: string): boolean {
  return (upstreamCols[port] || []).length > 0;
}

function readyForWarn(nodeType: NodeType, upstreamCols: Record<string, string[]>): boolean {
  const inputs = PORTS[nodeType]?.inputs || [];
  if (!inputs.length) return false;
  if (nodeType === "join" || nodeType === "antijoin" || nodeType === "crossjoin" || nodeType === "reconcile") {
    return hasLiveCols(upstreamCols, "left") && hasLiveCols(upstreamCols, "right");
  }
  if (nodeType === "multijoin") {
    return inputs.some((p) => hasLiveCols(upstreamCols, p));
  }
  return hasLiveCols(upstreamCols, "in");
}

function deadSet(stale: StaleColumnRef[]): Set<string> {
  const dead = new Set<string>();
  for (const row of stale) {
    for (const c of row.columns || []) {
      const t = String(c || "").trim();
      if (t) dead.add(t.toLowerCase());
    }
  }
  return dead;
}

function isDead(name: string | undefined | null, dead: Set<string>): boolean {
  const s = String(name || "").trim();
  return !!s && dead.has(s.toLowerCase());
}

function dropDeadNames(names: string[] | undefined, dead: Set<string>): string[] {
  return (names || []).filter((n) => !isDead(n, dead));
}

/** Drop WARN-listed stale names from config (manual Clear or post-run prune). */
export function clearStaleNodeflowColumnRefs(
  nodeType: NodeType,
  config: Record<string, any>,
  stale: StaleColumnRef[],
): Record<string, any> | null {
  if (SKIP_TYPES.has(nodeType) || !stale.length) return null;
  const dead = deadSet(stale);
  if (!dead.size) return null;
  const cfg = { ...(config || {}) };
  let changed = false;

  const blankIfDead = (v: string | undefined | null): string => {
    if (isDead(v, dead)) {
      changed = true;
      return "";
    }
    return String(v || "");
  };

  const clearFieldIfDead = (key: string) => {
    if (isDead(cfg[key], dead)) {
      cfg[key] = "";
      changed = true;
    }
  };

  switch (nodeType) {
    case "filter":
      // Only a delimited ref justifies destroying the user's text. A bare
      // word that merely looks dead may be a function name or an identifier
      // still being typed, and blanking the whole condition over one is how
      // hand-written expressions used to vanish.
      if (delimitedExprColumnRefs(cfg.condition || "").some((r) => isDead(r, dead))) {
        cfg.condition = "";
        changed = true;
      }
      // Simple-mode field picker is independent of condition text; Clear must
      // blank it too or the banner / next simple rebuild keeps the dead ref.
      clearFieldIfDead("field");
      break;
    case "formula":
      cfg.formulas = (cfg.formulas || []).map((f: any) => {
        if (!f?.expr) return f;
        // Delimited refs only — see the filter case above. Bare-word matching
        // here is what erased formulas the user had just typed.
        if (!delimitedExprColumnRefs(f.expr).some((r) => isDead(r, dead))) return f;
        changed = true;
        return { ...f, expr: "" };
      });
      break;
    case "summarize": {
      const group_by = dropDeadNames(cfg.group_by, dead);
      const aggs = (cfg.aggs || []).filter((a: any) => !isDead(a?.col, dead));
      if (group_by.length !== (cfg.group_by || []).length) {
        cfg.group_by = group_by;
        changed = true;
      }
      if (aggs.length !== (cfg.aggs || []).length) {
        cfg.aggs = aggs;
        changed = true;
      }
      break;
    }
    case "sort": {
      const sorts = (cfg.sorts || []).filter((s: any) => !isDead(s?.col, dead));
      if (sorts.length !== (cfg.sorts || []).length) {
        cfg.sorts = sorts.length ? sorts : [{ col: "", dir: "asc" }];
        changed = true;
      }
      break;
    }
    case "unique": {
      const by = dropDeadNames(cfg.by, dead);
      if (by.length !== (cfg.by || []).length) {
        cfg.by = by;
        changed = true;
      }
      break;
    }
    case "unpivot": {
      const keep = dropDeadNames(cfg.keep, dead);
      const unpivot = dropDeadNames(cfg.unpivot, dead);
      if (keep.length !== (cfg.keep || []).length) {
        cfg.keep = keep;
        changed = true;
      }
      if (unpivot.length !== (cfg.unpivot || []).length) {
        cfg.unpivot = unpivot;
        changed = true;
      }
      break;
    }
    case "window":
      cfg.windows = (cfg.windows || []).map((w: any) => {
        const next = {
          ...w,
          col: blankIfDead(w.col),
          partition_by: dropDeadNames(w.partition_by, dead),
          order_by: (w.order_by || []).filter((o: any) => !isDead(o?.col, dead)),
        };
        if (
          next.col !== (w.col || "") ||
          next.partition_by.length !== (w.partition_by || []).length ||
          next.order_by.length !== (w.order_by || []).length
        )
          changed = true;
        return next;
      });
      break;
    case "perioddelta":
      clearFieldIfDead("value");
      clearFieldIfDead("order");
      {
        const partition = dropDeadNames(cfg.partition, dead);
        if (partition.length !== (cfg.partition || []).length) {
          cfg.partition = partition;
          changed = true;
        }
      }
      break;
    case "bin":
    case "split":
    case "jsonextract":
    case "explode":
    case "maprecode":
      clearFieldIfDead("col");
      break;
    case "rank":
      {
        const partition = dropDeadNames(cfg.partition, dead);
        if (partition.length !== (cfg.partition || []).length) {
          cfg.partition = partition;
          changed = true;
        }
      }
      clearFieldIfDead("order");
      break;
    case "fill": {
      const fills = (cfg.fills || []).filter((f: any) => !isDead(f?.col, dead));
      if (fills.length !== (cfg.fills || []).length) {
        cfg.fills = fills;
        changed = true;
      }
      break;
    }
    case "dedupe": {
      const keys = dropDeadNames(cfg.keys, dead);
      if (keys.length !== (cfg.keys || []).length) {
        cfg.keys = keys;
        changed = true;
      }
      clearFieldIfDead("sort");
      break;
    }
    case "textclean":
    case "parse":
    case "coalesce": {
      const cols = dropDeadNames(cfg.cols, dead);
      if (cols.length !== (cfg.cols || []).length) {
        cfg.cols = cols;
        changed = true;
      }
      break;
    }
    case "topn": {
      const group = dropDeadNames(cfg.group, dead);
      if (group.length !== (cfg.group || []).length) {
        cfg.group = group;
        changed = true;
      }
      clearFieldIfDead("sort");
      break;
    }
    case "renamecols": {
      const mappings = (cfg.mappings || []).filter(
        (m: any) => !isDead(m?.from, dead),
      );
      if (mappings.length !== (cfg.mappings || []).length) {
        cfg.mappings = mappings;
        changed = true;
      }
      break;
    }
    case "validate": {
      const checks = (cfg.checks || []).filter((c: any) => {
        if (c?.type === "rows_min" || c?.type === "rows_max") return true;
        return !isDead(c?.col, dead);
      });
      if (checks.length !== (cfg.checks || []).length) {
        cfg.checks = checks;
        changed = true;
      }
      break;
    }
    case "chart":
      for (const k of ["x", "y", "x2", "y2", "open", "high", "low", "close"]) {
        clearFieldIfDead(k);
      }
      break;
    case "join":
    case "antijoin":
      cfg.keys = (cfg.keys || []).map((k: any) => {
        const left = isDead(k.left, dead) ? "" : k.left || "";
        const right = isDead(k.right, dead) ? "" : k.right || "";
        if (left !== (k.left || "") || right !== (k.right || "")) changed = true;
        return { ...k, left, right };
      });
      break;
    case "multijoin":
      cfg.joins = (cfg.joins || []).map((j: any) => ({
        ...j,
        on: (j.on || []).map((pair: any) => {
          const left = isDead(pair.left, dead) ? "" : pair.left || "";
          const right = isDead(pair.right, dead) ? "" : pair.right || "";
          if (left !== (pair.left || "") || right !== (pair.right || ""))
            changed = true;
          return { ...pair, left, right };
        }),
      }));
      break;
    case "reconcile": {
      const keys = dropDeadNames(cfg.keys, dead);
      const compare = dropDeadNames(cfg.compare, dead);
      if (keys.length !== (cfg.keys || []).length) {
        cfg.keys = keys;
        changed = true;
      }
      if (compare.length !== (cfg.compare || []).length) {
        cfg.compare = compare;
        changed = true;
      }
      clearFieldIfDead("balance");
      break;
    }
    case "groupconcat": {
      const group = dropDeadNames(cfg.group, dead);
      if (group.length !== (cfg.group || []).length) {
        cfg.group = group;
        changed = true;
      }
      clearFieldIfDead("col");
      break;
    }
    case "date":
      clearFieldIfDead("col");
      clearFieldIfDead("other");
      break;
    case "iterator":
    case "while": {
      const replace_keys = dropDeadNames(cfg.replace_keys, dead);
      if (replace_keys.length !== (cfg.replace_keys || []).length) {
        cfg.replace_keys = replace_keys;
        changed = true;
      }
      if ((cfg.accumulate || "append") === "reduce") {
        const reduce_keys = dropDeadNames(cfg.reduce_keys, dead);
        const reduce_aggs = (cfg.reduce_aggs || []).filter(
          (a: any) => !isDead(a?.col, dead),
        );
        if (reduce_keys.length !== (cfg.reduce_keys || []).length) {
          cfg.reduce_keys = reduce_keys;
          changed = true;
        }
        if (reduce_aggs.length !== (cfg.reduce_aggs || []).length) {
          cfg.reduce_aggs = reduce_aggs;
          changed = true;
        }
      }
      break;
    }
    default:
      break;
  }
  return changed ? cfg : null;
}

export function staleNodeflowColumnRefs(
  nodeType: NodeType,
  config: Record<string, any>,
  upstreamCols: Record<string, string[]>,
): StaleColumnRef[] {
  if (SKIP_TYPES.has(nodeType) || !readyForWarn(nodeType, upstreamCols)) return [];
  const cfg = config || {};
  const out: StaleColumnRef[] = [];
  const inLive = colSet(upstreamCols.in);
  const leftLive = colSet(upstreamCols.left);
  const rightLive = colSet(upstreamCols.right);

  switch (nodeType) {
    case "filter":
      staleExprs("condition", [cfg.condition], inLive, out);
      pushStale(out, "field", missingMany([cfg.field].filter(Boolean), inLive));
      break;
    case "formula": {
      // A formula may reference a column an earlier formula in the same node
      // creates, so this node's own outputs are live too — otherwise every
      // chained formula reports its own input as missing.
      const fxLive = new Set(inLive);
      for (const f of cfg.formulas || []) {
        const name = String(f?.name || "").trim();
        if (name) fxLive.add(name.toLowerCase());
      }
      staleExprs(
        "formula",
        (cfg.formulas || []).map((f: any) => f.expr).filter(Boolean),
        fxLive,
        out,
      );
      break;
    }
    case "summarize":
      pushStale(out, "group by", missingMany(cfg.group_by || [], inLive));
      pushStale(
        out,
        "measures",
        missingMany(
          (cfg.aggs || []).map((a: any) => a.col).filter(Boolean),
          inLive,
        ),
      );
      break;
    case "sort":
      pushStale(
        out,
        "sort",
        missingMany(
          (cfg.sorts || []).map((s: any) => s.col).filter(Boolean),
          inLive,
        ),
      );
      break;
    case "unique":
      pushStale(out, "by", missingMany(cfg.by || [], inLive));
      break;
    case "unpivot":
      pushStale(out, "keep", missingMany(cfg.keep || [], inLive));
      pushStale(out, "unpivot", missingMany(cfg.unpivot || [], inLive));
      break;
    case "window":
      for (const [i, w] of (cfg.windows || []).entries()) {
        pushStale(out, `window ${i + 1} column`, missingMany([w.col].filter(Boolean), inLive));
        pushStale(out, `window ${i + 1} partition`, missingMany(w.partition_by || [], inLive));
        pushStale(
          out,
          `window ${i + 1} order`,
          missingMany(
            (w.order_by || []).map((o: any) => o.col).filter(Boolean),
            inLive,
          ),
        );
      }
      break;
    case "perioddelta":
      pushStale(out, "value", missingMany([cfg.value].filter(Boolean), inLive));
      pushStale(out, "order", missingMany([cfg.order].filter(Boolean), inLive));
      pushStale(out, "partition", missingMany(cfg.partition || [], inLive));
      break;
    case "bin":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "rank":
      pushStale(out, "partition", missingMany(cfg.partition || [], inLive));
      pushStale(out, "order", missingMany([cfg.order].filter(Boolean), inLive));
      break;
    case "fill":
      pushStale(
        out,
        "fill",
        missingMany(
          (cfg.fills || []).map((f: any) => f.col).filter(Boolean),
          inLive,
        ),
      );
      break;
    case "dedupe":
      pushStale(out, "keys", missingMany(cfg.keys || [], inLive));
      pushStale(out, "sort", missingMany([cfg.sort].filter(Boolean), inLive));
      break;
    case "split":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "jsonextract":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "explode":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "textclean":
      pushStale(out, "columns", missingMany(cfg.cols || [], inLive));
      break;
    case "maprecode":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "parse":
      pushStale(out, "columns", missingMany(cfg.cols || [], inLive));
      break;
    case "topn":
      pushStale(out, "group", missingMany(cfg.group || [], inLive));
      pushStale(out, "sort", missingMany([cfg.sort].filter(Boolean), inLive));
      break;
    case "coalesce":
      pushStale(out, "columns", missingMany(cfg.cols || [], inLive));
      break;
    case "renamecols":
      pushStale(
        out,
        "rename from",
        missingMany(
          (cfg.mappings || []).map((m: any) => m.from).filter(Boolean),
          inLive,
        ),
      );
      break;
    case "validate":
      pushStale(
        out,
        "checks",
        missingMany(
          (cfg.checks || [])
            .filter((c: any) => c.type !== "rows_min" && c.type !== "rows_max")
            .map((c: any) => c.col)
            .filter(Boolean),
          inLive,
        ),
      );
      break;
    case "chart":
      pushStale(
        out,
        "chart axes",
        missingMany(
          [cfg.x, cfg.y, cfg.x2, cfg.y2, cfg.open, cfg.high, cfg.low, cfg.close].filter(
            Boolean,
          ),
          inLive,
        ),
      );
      break;
    case "join":
      for (const [i, k] of (cfg.keys || []).entries()) {
        pushStale(out, `join key ${i + 1} left`, missingMany([k.left].filter(Boolean), leftLive));
        pushStale(out, `join key ${i + 1} right`, missingMany([k.right].filter(Boolean), rightLive));
      }
      break;
    case "multijoin": {
      const base = cfg.base || "in1";
      const joins = cfg.joins || [];
      for (const [i, j] of joins.entries()) {
        const against = j.against || (i === 0 ? base : joins[i - 1]?.input) || base;
        const left = colSet(upstreamCols[against]);
        const right = colSet(upstreamCols[j.input]);
        if (!left.size && !right.size) continue;
        for (const [pi, pair] of (j.on || []).entries()) {
          pushStale(out, `join ${i + 1} key ${pi + 1} left`, missingMany([pair.left].filter(Boolean), left));
          pushStale(out, `join ${i + 1} key ${pi + 1} right`, missingMany([pair.right].filter(Boolean), right));
        }
      }
      break;
    }
    case "antijoin":
      for (const [i, k] of (cfg.keys || []).entries()) {
        pushStale(out, `key ${i + 1} left`, missingMany([k.left].filter(Boolean), leftLive));
        pushStale(out, `key ${i + 1} right`, missingMany([k.right].filter(Boolean), rightLive));
      }
      break;
    case "reconcile":
      pushStale(out, "keys", missingMany(cfg.keys || [], leftLive));
      pushStale(out, "compare", missingMany(cfg.compare || [], leftLive));
      pushStale(out, "balance", missingMany([cfg.balance].filter(Boolean), leftLive));
      break;
    case "groupconcat":
      pushStale(out, "group", missingMany(cfg.group || [], inLive));
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      break;
    case "date":
      pushStale(out, "column", missingMany([cfg.col].filter(Boolean), inLive));
      pushStale(out, "other", missingMany([cfg.other].filter(Boolean), inLive));
      break;
    case "iterator":
    case "while":
      pushStale(out, "replace keys", missingMany(cfg.replace_keys || [], inLive));
      if ((cfg.accumulate || "append") === "reduce") {
        pushStale(out, "reduce keys", missingMany(cfg.reduce_keys || [], inLive));
        pushStale(
          out,
          "reduce measures",
          missingMany(
            (cfg.reduce_aggs || []).map((a: any) => a.col).filter(Boolean),
            inLive,
          ),
        );
      }
      break;
    default:
      break;
  }
  return out;
}
