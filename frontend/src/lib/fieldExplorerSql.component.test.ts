import { describe, expect, it } from "vitest";
import {
  buildLongOneLineSql,
  composeMultiFieldSql,
  formatFieldSql,
} from "./fieldExplorerSql";

describe("fieldExplorerSql", () => {
  it("formats a nested All-rows recipe across lines", () => {
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
    expect(sql).toContain("FROM \"orders\",");
    expect(sql).toContain("UNNEST(from_json");
    expect(sql?.split("\n").length).toBeGreaterThan(2);
  });

  it("composes top-level Id with a nested array field", () => {
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
    expect(out.sql).toContain("payload ->> '$.Id' AS Id");
    expect(out.sql).toContain("e1 ->> '$.fixingdate' AS fixingdate");
    expect(out.sql).toContain("UNNEST(from_json");
    expect(out.firstSql).toContain("LIMIT 1");
  });

  it("rejects fields under sibling arrays", () => {
    const out = composeMultiFieldSql("t", [
      {
        name: "a",
        access: {
          sel: "e1 ->> '$.x'",
          unnests: ["UNNEST(from_json(a, '[\"JSON\"]')) AS x1(e1)"],
        },
      },
      {
        name: "b",
        access: {
          sel: "e1 ->> '$.y'",
          unnests: ["UNNEST(from_json(b, '[\"JSON\"]')) AS x1(e1)"],
        },
      },
    ]);
    expect(out.error).toMatch(/different arrays/i);
  });

  it("builds a one-line script longer than 100 statements", () => {
    const sql = buildLongOneLineSql(120);
    expect(sql.includes("\n")).toBe(false);
    expect((sql.match(/SELECT/g) || []).length).toBe(120);
    expect(sql.length).toBeGreaterThan(5000);
  });
});
