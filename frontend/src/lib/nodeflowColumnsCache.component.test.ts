import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNodeflowColsCache,
  fingerprintColumnReqs,
  getNodeflowColsCache,
  nodeflowColsCacheKey,
  nodeflowColsCacheSizeForTests,
  setNodeflowColsCache,
  tablesSchemaSig,
} from "./nodeflowColumnsCache";
import type { TableInfo } from "./types";

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

  it("misses after loaded-table schema changes (reload/reshape)", () => {
    const fp = fingerprintColumnReqs([
      { port: "in", node: "up", fromPort: "out" },
    ]);
    const tablesA: TableInfo[] = [
      {
        engine: "duckdb",
        name: "orders",
        source: "/a.json",
        row_count: 1,
        columns: [{ name: "a", type: "INTEGER" }],
      },
    ];
    const tablesB: TableInfo[] = [
      {
        engine: "duckdb",
        name: "orders",
        source: "/b.json",
        row_count: 1,
        columns: [
          { name: "a", type: "INTEGER" },
          { name: "b", type: "VARCHAR" },
        ],
      },
    ];
    const oldKey = nodeflowColsCacheKey(
      "sig",
      "sel-1",
      "canvas",
      fp,
      tablesSchemaSig(tablesA),
    );
    setNodeflowColsCache(oldKey, { in: ["a"] });
    const newKey = nodeflowColsCacheKey(
      "sig",
      "sel-1",
      "canvas",
      fp,
      tablesSchemaSig(tablesB),
    );
    expect(newKey).not.toBe(oldKey);
    expect(getNodeflowColsCache(newKey)).toBeUndefined();
  });

  it("does not mutate the cache when the caller mutates the returned arrays", () => {
    const key = nodeflowColsCacheKey("sig", "n1", "canvas", "in:u.out");
    setNodeflowColsCache(key, { in: ["a"] });
    const hit = getNodeflowColsCache(key)!;
    hit.in.push("mutated");
    expect(getNodeflowColsCache(key)).toEqual({ in: ["a"] });
  });
});
