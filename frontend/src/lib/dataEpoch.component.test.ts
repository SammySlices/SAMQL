import { describe, expect, it } from "vitest";
import { nextMonotonicDataEpoch, stampResultEpoch } from "./api";

describe("nextMonotonicDataEpoch", () => {
  it("advances when incoming is higher", () => {
    expect(nextMonotonicDataEpoch(3, 5)).toBe(5);
  });

  it("keeps prev when a slow poll echoes an older epoch", () => {
    expect(nextMonotonicDataEpoch(7, 4)).toBe(7);
  });

  it("accepts equal epochs", () => {
    expect(nextMonotonicDataEpoch(2, 2)).toBe(2);
  });

  it("returns null for non-finite incoming (caller leaves state)", () => {
    expect(nextMonotonicDataEpoch(1, undefined)).toBeNull();
    expect(nextMonotonicDataEpoch(1, "nope")).toBeNull();
    expect(nextMonotonicDataEpoch(1, NaN)).toBeNull();
  });

  it("treats non-finite prev as 0", () => {
    expect(nextMonotonicDataEpoch(Number.NaN, 3)).toBe(3);
  });
});

describe("stampResultEpoch", () => {
  it("prefers snapshot data_epoch over fallback", () => {
    expect(stampResultEpoch({ data_epoch: 9 }, 1)).toBe(9);
  });

  it("falls back when snapshot lacks a finite epoch", () => {
    expect(stampResultEpoch({}, 4)).toBe(4);
    expect(stampResultEpoch(null, 4)).toBe(4);
  });
});
