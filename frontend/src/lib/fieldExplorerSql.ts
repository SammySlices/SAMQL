/**
 * Field Explorer SQL helpers: readable formatting and multi-field compose.
 *
 * Single-field recipes stay engine-faithful (JSON ->> / from_json + UNNEST).
 * Multi-select builds one SELECT that keeps outer scalars alongside nested
 * fields exploded from a shared UNNEST chain (lowest common array ancestor).
 */

export type FieldAccess = {
  first?: string;
  sel?: string;
  unnests?: string[];
  recursive?: string;
  note?: string;
};

export type FieldPick = {
  name: string;
  access?: FieldAccess | null;
};

/** Always quote AS aliases so multi-select matches ``expr AS "Code"``. */
function quoteAlias(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Pretty multi-line SELECT for a single-field First / All recipe. */
export function formatFieldSql(
  table: string,
  access: FieldAccess | null | undefined,
  which: "first" | "all" | "recursive",
): string | null {
  if (!access) return null;
  const tbl = `"${String(table).replace(/"/g, '""')}"`;
  if (which === "first") {
    if (!access.first) return null;
    return `SELECT ${access.first}\nFROM ${tbl}\nLIMIT 1;`;
  }
  if (which === "recursive") {
    if (!access.recursive) return null;
    return `SELECT ${access.recursive}\nFROM ${tbl}\nLIMIT 50;`;
  }
  if (access.sel == null) return null;
  const unnests = access.unnests || [];
  if (!unnests.length) {
    return `SELECT ${access.sel}\nFROM ${tbl}\nLIMIT 50;`;
  }
  const fromParts = [tbl, ...unnests.map((u) => `     ${u}`)];
  return (
    `SELECT ${access.sel}\n` +
    `FROM ${fromParts.join(",\n")}\n` +
    `LIMIT 50;`
  );
}

/**
 * Compose one All-rows query from multiple selected fields.
 * Uses the longest UNNEST chain; other fields must share that prefix
 * (outer scalars have an empty chain). Sibling-array branches return an error.
 */
export function composeMultiFieldSql(
  table: string,
  picks: FieldPick[],
): { sql?: string; error?: string; firstSql?: string } {
  const usable = picks.filter((p) => p.access && p.access.sel != null);
  if (!usable.length) {
    return { error: "No selectable fields." };
  }
  const chains = usable.map((p) => p.access!.unnests || []);
  let longest = chains[0];
  for (const c of chains) {
    if (c.length > longest.length) longest = c;
  }
  for (const c of chains) {
    for (let i = 0; i < c.length; i++) {
      if (c[i] !== longest[i]) {
        return {
          error:
            "Those fields sit under different arrays. Select fields under the same array path, or shred to tables and JOIN.",
        };
      }
    }
  }

  const tbl = `"${String(table).replace(/"/g, '""')}"`;
  const selectList = usable
    .map((p) => `  ${p.access!.sel} AS ${quoteAlias(p.name)}`)
    .join(",\n");
  const fromParts = [tbl, ...longest.map((u) => `     ${u}`)];
  const sql =
    `SELECT\n${selectList}\n` +
    `FROM ${fromParts.join(",\n")}\n` +
    `LIMIT 50;`;

  const firstList = usable
    .map((p) => {
      const expr = p.access!.first || p.access!.sel;
      return `  ${expr} AS ${quoteAlias(p.name)}`;
    })
    .join(",\n");
  const firstSql = `SELECT\n${firstList}\nFROM ${tbl}\nLIMIT 1;`;

  return { sql, firstSql };
}

/** Build a one-line SQL script with >100 logical statements (repro fixture). */
export function buildLongOneLineSql(statements = 120): string {
  const parts: string[] = [];
  for (let i = 0; i < statements; i++) {
    parts.push(
      `SELECT ${i} AS n, 'row_${i}_` +
        `${"x".repeat(24)}' AS pad, current_timestamp AS ts`,
    );
  }
  return parts.join("; ") + ";";
}
