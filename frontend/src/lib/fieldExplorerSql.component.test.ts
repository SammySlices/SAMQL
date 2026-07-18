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
