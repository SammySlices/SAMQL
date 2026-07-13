// Pure helpers for keeping a Select node's field list in sync with the columns
// flowing out of the node upstream of it. Kept dependency-free so it can be
// unit-tested under Node, and so the same logic backs the canvas inspector.

export type SelField = {
  name: string;
  keep?: boolean;
  rename?: string;
  type?: string;
};

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
 *   - a column that no longer exists upstream is dropped (its old settings
 *     would only produce a "no such column" error downstream).
 *
 * Keeping surviving columns in the user's order is what lets a drag-reorder
 * stick; still appending new columns and dropping gone ones is what lets a
 * downstream node read every change made upstream.
 */
export function reconcileSelectFields(
  upstreamCols: string[],
  current: SelField[],
): SelField[] {
  const up = new Set(upstreamCols || []);
  const seen = new Set<string>();
  const out: SelField[] = [];
  // keep the user's existing fields, in their current order, for columns that
  // still exist upstream
  for (const f of current || []) {
    if (up.has(f.name) && !seen.has(f.name)) {
      out.push(f);
      seen.add(f.name);
    }
  }
  // append columns that are newly available upstream, in upstream order
  for (const c of upstreamCols || []) {
    if (!seen.has(c)) {
      out.push({ name: c, keep: true });
      seen.add(c);
    }
  }
  return out;
}

/** True when two field lists differ in their column names or order (a cheap
 *  guard so the inspector only writes when something actually changed). */
export function fieldsDiffer(a: SelField[], b: SelField[]): boolean {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return true;
  return x.some((f, i) => f.name !== y[i]?.name);
}
