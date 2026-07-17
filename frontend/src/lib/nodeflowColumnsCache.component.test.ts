import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNodeflowColsCache,
  fingerprintColumnReqs,
  getNodeflowColsCache,
  nodeflowColsCacheKey,
  nodeflowColsCacheSizeForTests,
  setNodeflowColsCache,
} from "./nodeflowColumnsCache";

describe("nodeflowColumnsCache", () => {
  beforeEach(() => {
    clearNodeflowColsCache();
  });

  it("returns cached columns for the same graphSig + sel + fingerprint", () => {
    const reqs = [{ port: "in", node: "up", fromPort: "out" }];
    const key = nodeflowColsCacheKey(
      "sig-a",
      "sel-1",
      "canvas",
      fingerprintColumnReqs(reqs),
    );
    setNodeflowColsCache(key, { in: ["a", "b"] });
    expect(getNodeflowColsCache(key)).toEqual({ in: ["a", "b"] });
    // Same key hits again (skip duplicate API).
    expect(getNodeflowColsCache(key)?.in).toEqual(["a", "b"]);
  });

  it("misses after graphSig changes (upstream config invalidation)", () => {
    const fp = fingerprintColumnReqs([
      { port: "in", node: "up", fromPort: "out" },
    ]);
    const oldKey = nodeflowColsCacheKey("sig-old", "sel-1", "canvas", fp);
    setNodeflowColsCache(oldKey, { in: ["stale"] });
    const newKey = nodeflowColsCacheKey("sig-new", "sel-1", "canvas", fp);
    expect(getNodeflowColsCache(newKey)).toBeUndefined();
    setNodeflowColsCache(newKey, { in: ["fresh"] });
    // Writing under a new graphSig prunes older signatures.
    expect(getNodeflowColsCache(oldKey)).toBeUndefined();
    expect(getNodeflowColsCache(newKey)).toEqual({ in: ["fresh"] });
    expect(nodeflowColsCacheSizeForTests()).toBe(1);
  });

  it("does not mutate the cache when the caller mutates the returned arrays", () => {
    const key = nodeflowColsCacheKey("sig", "n1", "canvas", "in:u.out");
    setNodeflowColsCache(key, { in: ["a"] });
    const hit = getNodeflowColsCache(key)!;
    hit.in.push("mutated");
    expect(getNodeflowColsCache(key)).toEqual({ in: ["a"] });
  });
});
