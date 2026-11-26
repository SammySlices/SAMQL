/** Client-side "can this SQL change data?" classifier, shared by the Journal
 * Run-all planner (J-H1) and the IDE's expired-result re-run (Q-C1). */

// J-H1: statement leads that change data, schema or session state. Mirrors the
// backend's sqlutil._WRITE_LEADERS plus transaction control, which on SQLite's
// shared connection commits or rolls back other work just like a write does.
export const SIDE_EFFECT_LEADS = new Set([
  "insert", "update", "delete", "merge", "upsert", "truncate", "drop",
  "alter", "create", "replace", "grant", "revoke", "exec", "execute",
  "sp_executesql", "call", "copy", "attach", "detach", "install", "load",
  "set", "reset", "pragma", "checkpoint", "vacuum", "export", "import",
  "use", "backup", "restore", "bulk", "comment", "analyze",
  "begin", "commit", "rollback", "end", "savepoint", "release", "abort",
]);

// One left-to-right pass, so a quote inside a comment (or `--` inside a
// string) is read the way the engine reads it.
const SQL_NOISE_RE =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\$\$[\s\S]*?\$\$/g;

/** True when running `sql` can change what another cell reads: any statement
 * that writes a table, changes the schema or session state, or opens/closes a
 * transaction. Classified per statement on its LEADING keyword (after comments
 * and quoted text are blanked), so `SELECT replace(a, 'x', 'y')` or a string
 * literal 'update' is not a write. A leading WITH writes only when it carries
 * DML; SELECT ... INTO (SQL Server) creates a table; EXPLAIN ANALYZE <write>
 * runs the write. Uncertain cases lean toward "side effect": a false positive
 * only costs parallelism, a false negative races a reader against its table. */
export function isSideEffectSql(sql: string): boolean {
  const body = String(sql || "").replace(SQL_NOISE_RE, " ");
  for (const stmt of body.split(";")) {
    const words = stmt.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (!words || !words.length) continue;
    const lead = words[0].toLowerCase();
    if (SIDE_EFFECT_LEADS.has(lead)) return true;
    if (lead === "with" && /\b(insert|update|delete|merge|upsert)\b/i.test(stmt))
      return true;
    if (lead === "explain" &&
        words.slice(1, 4).some((w) => SIDE_EFFECT_LEADS.has(w.toLowerCase())))
      return true;
    if (lead === "select" && /\binto\b/i.test(stmt)) return true;
  }
  return false;
}


/** What an expired IDE result tab may re-run on its own (Q-C1). */
export type ResultRerunPlan =
  | {
      kind: "rerun";
      /** The ONE statement that produced the grid, in the engine's SQL. */
      sql: string;
      /** The engine target that statement resolved to when it ran. */
      target?: string;
      /** Row cap when the grid was a preview run. */
      previewLimit?: number;
    }
  | { kind: "refuse"; reason: "write" | "missing" };

export interface RerunnableResult {
  rerunSql?: string;
  rerunTarget?: string;
  rerunPreviewLimit?: number;
  page?: { sql?: string; target?: string } | null;
}

/** Q-C1: an expired result tab used to re-send the WHOLE editor script (the
 * tab's `sql`), INSERTs and all, whenever a sort, scroll or tab switch found
 * its result expired. Only the statement that produced the grid may be re-run
 * automatically, and never one that can change data: that grid is marked
 * stale and the user re-runs it on purpose. The statement comes from the
 * backend's own record (`page.sql`, i.e. `_CachedResult.sql`), captured on
 * the tab at run time; the editor script is never a fallback. */
export function planResultTabRerun(r: RerunnableResult): ResultRerunPlan {
  const sql = String(r.rerunSql ?? r.page?.sql ?? "").trim();
  if (!sql) return { kind: "refuse", reason: "missing" };
  if (isSideEffectSql(sql)) return { kind: "refuse", reason: "write" };
  const target = r.rerunTarget ?? r.page?.target ?? undefined;
  return {
    kind: "rerun",
    sql,
    ...(target ? { target } : {}),
    ...(r.rerunPreviewLimit ? { previewLimit: r.rerunPreviewLimit } : {}),
  };
}

/** The fields to stamp on a result tab from the response that produced it. */
export function rerunFieldsFrom(
  res: { sql?: string; target?: string; preview?: boolean;
         preview_limit?: number } | null | undefined,
  fallbackTarget?: string,
): { rerunSql?: string; rerunTarget?: string; rerunPreviewLimit?: number } {
  return {
    rerunSql: res?.sql ? String(res.sql) : undefined,
    rerunTarget: res?.target || fallbackTarget || undefined,
    rerunPreviewLimit:
      res?.preview && res.preview_limit ? Number(res.preview_limit) : undefined,
  };
}
