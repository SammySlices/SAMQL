// Pure helper for keeping a NodeFlow pivot node's config in sync with the
// columns flowing out of the node upstream of it -- analogous to
// reconcileSelectFields, but for the pivot node's rows / cols / values.
// Dependency-free so it can be unit-tested under Node.

export type PivotMeasure = {
  field?: string | null;
  agg?: string;
  [k: string]: any;
};

export type PivotConfig = {
  rows?: string[];
  cols?: string[];
  values?: PivotMeasure[];
  [k: string]: any;
};

/**
 * Drop any `rows` / `cols` entries and any `values[].field` that no longer
 * exist upstream, returning only the config keys that changed as a patch.
 *
 *   - row/col fields not in `upstreamCols` are removed (a stale reference would
 *     become a "no such column" error downstream),
 *   - a measure whose field is set but missing upstream is dropped; a measure
 *     with no field (count rows) is always kept,
 *   - matching is case-insensitive, mirroring the backend's column resolution.
 *
 * Callers gate this on a non-empty `upstreamCols` so a momentarily-disconnected
 * node (no columns known yet) is never wiped.
 */
export function reconcilePivotFields(
  upstreamCols: string[],
  config: PivotConfig,
): { patch: Partial<PivotConfig>; changed: boolean } {
  const valid = new Set((upstreamCols || []).map((c) => String(c).toLowerCase()));
  const cfg = config || {};
  const patch: Partial<PivotConfig> = {};

  if (Array.isArray(cfg.rows)) {
    const kept = cfg.rows.filter((c) => valid.has(String(c).toLowerCase()));
    if (kept.length !== cfg.rows.length) patch.rows = kept;
  }
  if (Array.isArray(cfg.cols)) {
    const kept = cfg.cols.filter((c) => valid.has(String(c).toLowerCase()));
    if (kept.length !== cfg.cols.length) patch.cols = kept;
  }
  if (Array.isArray(cfg.values)) {
    const kept = cfg.values.filter(
      (m) => !m || !m.field || valid.has(String(m.field).toLowerCase()),
    );
    if (kept.length !== cfg.values.length) patch.values = kept;
  }

  return { patch, changed: Object.keys(patch).length > 0 };
}
