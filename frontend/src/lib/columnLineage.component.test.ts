import { describe, expect, it } from "vitest";
import {
  formatTransformSummary,
  formatTypeChange,
  kindLabel,
} from "./columnLineage";

describe("columnLineage helpers", () => {
  it("kindLabel maps known kinds", () => {
    expect(kindLabel("source")).toBe("Source");
    expect(kindLabel("derived")).toBe("Derived");
    expect(kindLabel("passthrough")).toBe("Passthrough");
  });

  it("formatTransformSummary prefers backend transform line", () => {
    expect(
      formatTransformSummary({
        summary: "short",
        transform: "a, b → a+b → total",
        inputs: ["a", "b"],
        output: "total",
      }),
    ).toBe("a, b → a+b → total");
  });

  it("formatTransformSummary builds inputs → op → output when transform missing", () => {
    expect(
      formatTransformSummary({
        summary: "sum",
        inputs: ["amount"],
        expression: "sum(amount)",
        output: "sum_amount",
      }),
    ).toBe("amount → sum(amount) → sum_amount");
  });

  it("formatTypeChange shows cast targets", () => {
    expect(formatTypeChange({ summary: "cast", type_to: "integer" })).toBe(
      "→ integer",
    );
    expect(
      formatTypeChange({
        summary: "cast",
        type_from: "varchar",
        type_to: "integer",
      }),
    ).toBe("varchar → integer");
    expect(formatTypeChange({ summary: "x" })).toBeNull();
  });
});
