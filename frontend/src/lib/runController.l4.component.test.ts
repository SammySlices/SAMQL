import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelledIdCount, markCancelled, wasCancelled } from "./runController";

// L-4: the cancelled-id map only forgot an id when that exact id was asked
// about again, so ids nobody re-checked stayed for the life of the page.

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelled ids expire (L-4)", () => {
  it("markCancelled sweeps ids past the cancel memory", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const before = cancelledIdCount();
    for (let i = 0; i < 1000; i += 1) markCancelled(`l4-${i}`);
    expect(cancelledIdCount()).toBe(before + 1000);
    vi.setSystemTime(new Date("2026-11-24T12:01:01Z"));
    markCancelled("l4-fresh");
    expect(cancelledIdCount()).toBe(1);
    expect(wasCancelled("l4-fresh")).toBe(true);
    expect(wasCancelled("l4-1")).toBe(false);
  });
});
