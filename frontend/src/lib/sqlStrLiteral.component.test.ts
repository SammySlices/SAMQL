import { describe, expect, it } from "vitest";
import {
  buildNodeflowFilterCond,
  sqlStrLiteral,
  unwrapSqlQuotedTemporal,
} from "./sql";

describe("sqlStrLiteral / NodeFlow filter date quoting", () => {
  it("does not double-quote bare or already-quoted ISO dates", () => {
    expect(sqlStrLiteral("2026-01-26")).toBe("'2026-01-26'");
    expect(sqlStrLiteral("'2026-01-26'")).toBe("'2026-01-26'");
    expect(sqlStrLiteral('"2026-01-26"')).toBe("'2026-01-26'");
    expect(sqlStrLiteral("2026-01-26")).not.toContain("'''");
    expect(sqlStrLiteral("'2026-01-26'")).not.toBe("'''2026-01-26'''");
  });

  it("unwraps only ISO temporal interiors", () => {
    expect(unwrapSqlQuotedTemporal("'2026-01-26'")).toBe("2026-01-26");
    expect(unwrapSqlQuotedTemporal("2026-01-26T12:00:00")).toBe(
      "2026-01-26T12:00:00",
    );
    expect(unwrapSqlQuotedTemporal("'hello'")).toBe("'hello'");
    expect(unwrapSqlQuotedTemporal("O'Brien")).toBe("O'Brien");
  });

  it("builds Filter equals without triple-quoted ISO dates", () => {
    expect(buildNodeflowFilterCond("d", "=", "2026-01-26")).toBe(
      "[d] = '2026-01-26'",
    );
    expect(buildNodeflowFilterCond("d", "=", "'2026-01-26'")).toBe(
      "[d] = '2026-01-26'",
    );
    const quoted = buildNodeflowFilterCond("d", "=", "'2026-01-26'");
    expect(quoted).not.toContain("'''2026-01-26'''");
    expect(buildNodeflowFilterCond("d", ">=", "2026-01-26")).toBe(
      "[d] >= '2026-01-26'",
    );
  });

  it("still escapes ordinary string values", () => {
    expect(sqlStrLiteral("O'Brien")).toBe("'O''Brien'");
    expect(buildNodeflowFilterCond("name", "=", "O'Brien")).toBe(
      "[name] = 'O''Brien'",
    );
  });

  it("builds Filter numeric equals without quoting (order_id-like)", () => {
    // demo_orders / Create Table: order_id is integer; UI value "101" must
    // emit a bare numeric literal so DuckDB/SQLite equals matches.
    expect(buildNodeflowFilterCond("order_id", "=", "101")).toBe(
      "[order_id] = 101",
    );
    expect(buildNodeflowFilterCond("order_id", "=", "101")).not.toContain(
      "'101'",
    );
    expect(buildNodeflowFilterCond("amount", ">=", "50")).toBe(
      "[amount] >= 50",
    );
  });
});
