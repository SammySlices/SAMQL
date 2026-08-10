import { describe, expect, it } from "vitest";
import {
  buildLongOneLineSql,
  buildUnnestPipelineSql,
  composeMultiFieldSql,
  formatFieldSql,
  parseUnnestAsClause,
} from "./fieldExplorerSql";

describe("fieldExplorerSql", () => {
  it("parses UNNEST AS clauses with nested from_json parens", () => {
    const hop = parseUnnestAsClause(
      "UNNEST(from_json(json_extract(payload, '$.CashFlows.receivingLeg'), '[\"JSON\"]')) AS x1(e1)",
    );
    expect(hop?.alias).toBe("x1");
    expect(hop?.elem).toBe("e1");
    expect(hop?.expr).toContain("from_json(");
  });

  it("formats a nested All-rows recipe as a CTE pipeline", () => {
    const sql = formatFieldSql(
      "orders",
      {
        sel: "e1 ->> '$.fixingdate'",
        unnests: [
          "UNNEST(from_json(json_extract(payload, '$.CashFlows.receivingLeg'), '[\"JSON\"]')) AS x1(e1)",
        ],
      },
      "all",
    );
    expect(sql).toContain("SELECT e1 ->> '$.fixingdate'");
    expect(sql).toContain("WITH x1 AS");
    expect(sql).toContain("UNNEST(from_json");
    expect(sql).not.toContain('FROM "orders",');
    expect(sql?.split("\n").length).toBeGreaterThan(2);
  });

  it("formats an exact count over the same UNNEST pipeline", () => {
    const sql = formatFieldSql(
      "orders",
      {
        sel: "e1",
        unnests: [
          "UNNEST(from_json(json_extract(payload, '$.legs'), '[\"JSON\"]')) AS x1(e1)",
        ],
      },
      "count",
    );
    expect(sql).toContain("SELECT count(*)");
    expect(sql).toContain("WITH x1 AS");
    expect(sql).toContain("_samql_cnt");
    expect(sql).not.toContain("LIMIT");
  });

  it("composes top-level Id with a nested array field via CTE carry", () => {
    const out = composeMultiFieldSql("trades", [
      {
        name: "Id",
        access: {
          first: "payload ->> '$.Id'",
          sel: "payload ->> '$.Id'",
          unnests: [],
        },
      },
      {
        name: "fixingdate",
        access: {
          first:
            "payload -> '$.CashFlows.receivingLeg[0]' ->> '$.fixingdate'",
          sel: "e1 ->> '$.fixingdate'",
          unnests: [
            "UNNEST(from_json(json_extract(payload, '$.CashFlows.receivingLeg'), '[\"JSON\"]')) AS x1(e1)",
          ],
        },
      },
    ]);
    expect(out.error).toBeUndefined();
    expect(out.sql).toContain("WITH x1 AS");
    expect(out.sql).toContain('_c0 AS "Id"');
    expect(out.sql).toContain('e1 ->> \'$.fixingdate\' AS "fixingdate"');
    expect(out.sql).toContain("UNNEST(from_json");
    expect(out.sql).not.toContain('FROM "trades",');
    expect(out.firstSql).toContain("LIMIT 1");
  });

  it("composes a top-level unique id with IDE-style bare select + quoted alias", () => {
    const out = composeMultiFieldSql("trades", [
      {
        name: "Code",
        access: { first: "Code", sel: "Code", unnests: [] },
      },
      {
        name: "sku",
        access: {
          first: "payload ->> '$.sku'",
          sel: "payload ->> '$.sku'",
          unnests: [],
        },
      },
    ]);
    expect(out.error).toBeUndefined();
    expect(out.sql).toContain('Code AS "Code"');
    expect(out.sql).not.toContain('"Code" AS');
    expect(out.sql).toContain('payload ->> \'$.sku\' AS "sku"');
  });

  it("carries an intermediate-level element through deeper hops", () => {
    // The 8/10 report: id lives on the tradeValuations[] element (1 hop),
    // metric on the nested metricValues[] element (2 hops). The composed
    // query previously bound "e2 ->> '$.id'" against the x4 CTE, which only
    // projected e4 -> DuckDB BinderException 'Referenced column "e2" not
    // found in FROM clause! Candidate bindings: "e4"'. Every hop CTE after
    // an intermediate pick's own hop must keep projecting its element.
    const hop1 =
      "UNNEST(from_json(json_extract(data::JSON, '$.tradeValuations'), '[\"JSON\"]')) AS x2(e2)";
    const hop2 =
      "UNNEST(from_json(json_extract(e2, '$.metricValues'), '[\"JSON\"]')) AS x4(e4)";
    const out = composeMultiFieldSql("api_results1", [
      {
        name: "id",
        access: {
          first: "data::JSON -> '$.tradeValuations[0]' ->> '$.id'",
          sel: "e2 ->> '$.id'",
          unnests: [hop1],
        },
      },
      {
        name: "metric",
        access: {
          first:
            "data::JSON -> '$.tradeValuations[0]' -> '$.metricValues[0]' ->> '$.metric'",
          sel: "e4 ->> '$.metric'",
          unnests: [hop1, hop2],
        },
      },
    ]);
    expect(out.error).toBeUndefined();
    // The deeper CTE re-projects e2 as a standalone column alongside its own
    // UNNEST ("SELECT e2, UNNEST(...) AS e4"), so the final SELECT can bind
    // both elements. Pre-fix, x4 projected ONLY the UNNEST and the query
    // died in DuckDB's binder.
    expect(out.sql).toMatch(/x4 AS \(\s*SELECT e2,\s*UNNEST\(/);
    expect(out.sql).toContain('e2 ->> \'$.id\' AS "id"');
    expect(out.sql).toContain('e4 ->> \'$.metric\' AS "metric"');
  });

  it("rejects fields under sibling arrays", () => {
    const out = composeMultiFieldSql("t", [
      {
        name: "a",
        access: {
          sel: "e1",
          unnests: ["UNNEST(x) AS x1(e1)"],
        },
      },
      {
        name: "b",
        access: {
          sel: "e1",
          unnests: ["UNNEST(y) AS x1(e1)"],
        },
      },
    ]);
    expect(out.error).toMatch(/different arrays/);
  });

  it("buildUnnestPipelineSql keeps multi-hop aliases", () => {
    const sql = buildUnnestPipelineSql(
      "t",
      "e2.amt",
      [
        "UNNEST(legs) AS x1(e1)",
        "UNNEST(e1.cashflows) AS x2(e2)",
      ],
      { limit: 50 },
    );
    expect(sql).toContain("WITH x1 AS");
    expect(sql).toContain("x2 AS");
    expect(sql).toContain("FROM x2");
    expect(sql).toContain("LIMIT 50");
  });

  it("buildLongOneLineSql emits many statements", () => {
    const s = buildLongOneLineSql(120);
    expect(s.split(";").length).toBeGreaterThan(100);
  });
});
