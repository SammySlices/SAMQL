/**
 * Field Explorer SQL helpers: readable formatting and multi-field compose.
 *
 * Single-field recipes stay engine-faithful (JSON ->> / from_json + UNNEST).
 * Multi-select builds one SELECT that keeps outer scalars alongside nested
 * fields exploded from a shared UNNEST chain (lowest common array ancestor).
 *
 * Nested UNNEST hops are emitted as a narrow WITH CTE pipeline (not comma-FROM
 * UNNEST). Same exact row counts; DuckDB does far less intermediate work.
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

type UnnestHop = { expr: string; alias: string; elem: string };

/** Parse ``UNNEST(<expr>) AS xN(eN)`` (expr may contain nested parens). */
export function parseUnnestAsClause(clause: string): UnnestHop | null {
  const s = String(clause || "").trim();
  if (!s) return null;
  const m = /\)\s+AS\s+(x\d+)\((e\d+)\)\s*$/i.exec(s);
  if (!m) return null;
  const head = s.slice(0, m.index);
  if (!/^UNNEST\(/i.test(head)) return null;
  return {
    expr: head.slice("UNNEST(".length),
    alias: m[1],
    elem: m[2],
  };
}

/**
 * Build DuckDB SQL for a select list over an UNNEST hop chain.
 * Falls back to legacy comma-FROM when a clause cannot be parsed.
 */
export function buildUnnestPipelineSql(
  table: string,
  selectSql: string,
  unnests: string[],
  opts?: {
    limit?: number | null;
    carry?: Array<{ alias: string; expr: string }>;
    pretty?: boolean;
  },
): string {
  const tbl = `"${String(table).replace(/"/g, '""')}"`;
  const hops = unnests || [];
  const carry = opts?.carry || [];
  const pretty = !!opts?.pretty;
  const limit = opts?.limit;
  if (!hops.length) {
    let sql = `SELECT ${selectSql} FROM ${tbl}`;
    if (limit != null) sql += ` LIMIT ${limit}`;
    return sql;
  }
  const parsed: UnnestHop[] = [];
  for (const clause of hops) {
    const got = parseUnnestAsClause(clause);
    if (!got) {
      const joined = hops.map((u) => u).join(", ");
      let sql = `SELECT ${selectSql} FROM ${tbl}, ${joined}`;
      if (limit != null) sql += ` LIMIT ${limit}`;
      return sql;
    }
    parsed.push(got);
  }
  const nl = pretty ? "\n" : " ";
  const ind = pretty ? "  " : "";
  const ctes: string[] = [];
  let prev = tbl;
  const carryCols = carry.map((c) => c.alias);
  parsed.forEach((hop, i) => {
    const proj: string[] = [];
    if (i === 0) {
      for (const c of carry) proj.push(`${c.expr} AS ${c.alias}`);
    } else {
      proj.push(...carryCols);
    }
    proj.push(`UNNEST(${hop.expr}) AS ${hop.elem}`);
    const projSql = pretty ? proj.join(`,\n${ind}`) : proj.join(", ");
    ctes.push(
      `${hop.alias} AS (${pretty ? `\n${ind}` : ""}SELECT ${projSql}${
        pretty ? `\n${ind}` : " "
      }FROM ${prev})`,
    );
    prev = hop.alias;
  });
  let body = `WITH ${ctes.join(pretty ? ",\n" : ", ")}${nl}SELECT ${selectSql}${nl}FROM ${prev}`;
  if (limit != null) body += `${nl}LIMIT ${limit}`;
  return body;
}

/** Pretty multi-line SELECT for a single-field First / All / count recipe. */
export function formatFieldSql(
  table: string,
  access: FieldAccess | null | undefined,
  which: "first" | "all" | "recursive" | "count",
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
  if (which === "count") {
    const unnests = access.unnests || [];
    if (!unnests.length) {
      if (access.sel == null) return null;
      return `SELECT count(*)\nFROM ${tbl};`;
    }
    const inner = buildUnnestPipelineSql(table, "1", unnests, {
      limit: null,
      pretty: true,
    });
    return `SELECT count(*)\nFROM (\n${inner}\n) AS _samql_cnt;`;
  }
  if (access.sel == null) return null;
  const unnests = access.unnests || [];
  if (!unnests.length) {
    return `SELECT ${access.sel}\nFROM ${tbl}\nLIMIT 50;`;
  }
  return (
    buildUnnestPipelineSql(table, access.sel, unnests, {
      limit: 50,
      pretty: true,
    }) + ";"
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
  const carry: Array<{ alias: string; expr: string }> = [];
  const finalParts: string[] = [];
  usable.forEach((p, i) => {
    const alias = quoteAlias(p.name);
    const u = p.access!.unnests || [];
    if (u.length === 0) {
      const cAlias = `_c${i}`;
      carry.push({ alias: cAlias, expr: p.access!.sel! });
      finalParts.push(`  ${cAlias} AS ${alias}`);
    } else {
      finalParts.push(`  ${p.access!.sel} AS ${alias}`);
    }
  });

  let sql: string;
  if (!longest.length) {
    const selectList = usable
      .map((p) => `  ${p.access!.sel} AS ${quoteAlias(p.name)}`)
      .join(",\n");
    sql = `SELECT\n${selectList}\nFROM ${tbl}\nLIMIT 50;`;
  } else {
    sql =
      buildUnnestPipelineSql(table, finalParts.join(",\n"), longest, {
        limit: 50,
        carry,
        pretty: true,
      }) + ";";
  }

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
