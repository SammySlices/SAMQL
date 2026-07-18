import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRunAllParallelHint,
  getRunAllParallelNodeflows,
} from "./runAllConcurrency";

describe("runAllConcurrency cache", () => {
  afterEach(() => {
    clearRunAllParallelHint();
  });

  it("fetches once within the TTL then reuses the hint", async () => {
    const fetchInfo = vi
      .fn()
      .mockResolvedValueOnce({ parallel_nodeflows: true })
      .mockResolvedValueOnce({ parallel_nodeflows: false });
    await expect(getRunAllParallelNodeflows(fetchInfo)).resolves.toBe(true);
    await expect(getRunAllParallelNodeflows(fetchInfo)).resolves.toBe(true);
    expect(fetchInfo).toHaveBeenCalledTimes(1);
  });

  it("refetches after clearRunAllParallelHint", async () => {
    const fetchInfo = vi
      .fn()
      .mockResolvedValueOnce({ parallel_nodeflows: true })
      .mockResolvedValueOnce({ parallel_nodeflows: false });
    await expect(getRunAllParallelNodeflows(fetchInfo)).resolves.toBe(true);
    clearRunAllParallelHint();
    await expect(getRunAllParallelNodeflows(fetchInfo)).resolves.toBe(false);
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });
});
