import { describe, expect, it } from "vitest";
import {
  classifySqlType,
  defaultPivotAgg,
  groupColumnsByRole,
  inferColumnTypes,
  inferTypeFromSamples,
  pickDefaultChartAxes,
  shortFieldType,
} from "./fieldRoles";

describe("fieldRoles", () => {
  it("classifies SQL types into measure vs dimension", () => {
    expect(classifySqlType("INTEGER")).toBe("measure");
    expect(classifySqlType("DOUBLE")).toBe("measure");
    expect(classifySqlType("DECIMAL(18,2)")).toBe("measure");
    expect(classifySqlType("VARCHAR")).toBe("dimension");
    expect(classifySqlType("BOOLEAN")).toBe("dimension");
    expect(classifySqlType("TIMESTAMP")).toBe("dimension");
    expect(classifySqlType("DATE")).toBe("dimension");
    expect(classifySqlType("STRUCT(a INT)")).toBe("dimension");
    expect(classifySqlType("JSON")).toBe("dimension");
    expect(classifySqlType("")).toBe("unknown");
  });

  it("infers types from sample cells", () => {
    expect(inferTypeFromSamples([1, 2, 3])).toBe("INTEGER");
    expect(inferTypeFromSamples([1.5, 2])).toBe("DOUBLE");
    expect(inferTypeFromSamples([true, false])).toBe("BOOLEAN");
    expect(inferTypeFromSamples(["a", "b"])).toBe("VARCHAR");
    expect(inferTypeFromSamples(["2024-01-01", "2024-02-01"])).toBe(
      "TIMESTAMP",
    );
  });

  it("infers a type map from a result page", () => {
    const types = inferColumnTypes(
      ["cat", "amt", "flag"],
      [
        ["east", 10, true],
        ["west", 20, false],
      ],
    );
    expect(types.cat).toBe("VARCHAR");
    expect(types.amt).toBe("INTEGER");
    expect(types.flag).toBe("BOOLEAN");
  });

  it("groups columns by role without dropping any", () => {
    const cols = ["region", "sales", "mystery"];
    const g = groupColumnsByRole(cols, {
      region: "VARCHAR",
      sales: "DOUBLE",
    });
    expect(g.dimensions).toEqual(["region"]);
    expect(g.measures).toEqual(["sales"]);
    expect(g.other).toEqual(["mystery"]);
    expect([...g.dimensions, ...g.measures, ...g.other].sort()).toEqual(
      [...cols].sort(),
    );
  });

  it("picks dimension X and measure Y by default", () => {
    const { x, y } = pickDefaultChartAxes(
      ["amount", "region", "qty"],
      { amount: "DOUBLE", region: "VARCHAR", qty: "INTEGER" },
    );
    expect(x).toBe("region");
    expect(y).toBe("amount");
  });

  it("preserves a still-valid previous chart selection", () => {
    const { x, y } = pickDefaultChartAxes(
      ["a", "b", "c"],
      { a: "VARCHAR", b: "INTEGER", c: "DOUBLE" },
      { x: "a", y: "c" },
    );
    expect(x).toBe("a");
    expect(y).toBe("c");
  });

  it("defaults pivot agg to count for dimensions only", () => {
    expect(defaultPivotAgg("DOUBLE")).toBe("sum");
    expect(defaultPivotAgg("VARCHAR")).toBe("count");
    expect(defaultPivotAgg("")).toBe("sum");
  });

  it("shortens type labels for chips", () => {
    expect(shortFieldType("INTEGER")).toBe("int");
    expect(shortFieldType("VARCHAR")).toBe("text");
    expect(shortFieldType("TIMESTAMP")).toBe("date");
  });
});
