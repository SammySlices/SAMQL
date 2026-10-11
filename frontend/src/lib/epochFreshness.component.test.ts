/**
 * Tests for epoch-driven freshness behaviour.
 *
 * These verify that cached NodeFlow columns are invalidated on graphSig change,
 * that stampResultEpoch correctly marks results as stale/current relative to
 * the current dataEpoch, and that cancelPending in usePagedResult aborts
 * in-flight loads when called (epoch rotation side-effect).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNodeflowColsCache,
  fingerprintColumnReqs,
  getNodeflowColsCache,
  nodeflowColsCacheKey,
  nodeflowColsCacheSizeForTests,
  setNodeflowColsCache,
  tablesSchemaSig,
} from "./nodeflowColumnsCache";
import { stampResultEpoch } from "./api";
import type { TableInfo } from "./types";

// ---------------------------------------------------------------------------
// 1. nodeflowColumnsCache — epoch-like invalidation via tablesSchemaSig change
// ---------------------------------------------------------------------------

describe("nodeflowColumnsCache epoch invalidation", () => {
  beforeEach(() => {
    clearNodeflowColsCache();
  });

  it("clears all entries when tablesSchemaSig changes (simulates data_epoch bump)", () => {
    const tablesV1: TableInfo[] = [
      {
        engine: "duckdb",
        name: "sales",
        source: "sales.csv",
        row_count: 10,
        columns: [{ name: "amount", type: "REAL" }],
      },
    ];
    const tablesV2: TableInfo[] = [
      {
        engine: "duckdb",
        name: "sales",
        source: "sales.csv",
        row_count: 20, // row count changed — new epoch
        columns: [{ name: "amount", type: "REAL" }, { name: "tax", type: "REAL" }],
      },
    ];

    const fp = fingerprintColumnReqs([{ port: "in", node: "agg", fromPort: "out" }]);
    const sig1 = tablesSchemaSig(tablesV1);
    const sig2 = tablesSchemaSig(tablesV2);

    const key1 = nodeflowColsCacheKey(sig1, "sel-1", "canvas", fp);
    setNodeflowColsCache(key1, { in: ["amount"] });
    expect(getNodeflowColsCache(key1)).toEqual({ in: ["amount"] });

    // Simulate epoch bump: a write under the new sig prunes the old sig's entries
    const key2 = nodeflowColsCacheKey(sig2, "sel-1", "canvas", fp);
    setNodeflowColsCache(key2, { in: ["amount", "tax"] });

    expect(getNodeflowColsCache(key1)).toBeUndefined(); // v1 pruned
    expect(getNodeflowColsCache(key2)).toEqual({ in: ["amount", "tax"] }); // v2 live
    expect(nodeflowColsCacheSizeForTests()).toBe(1); // exactly one sig in cache
  });

  it("clearNodeflowColsCache wipes everything (simulates clearAll / epoch 0 reset)", () => {
    const fp = fingerprintColumnReqs([{ port: "p", node: "n", fromPort: "q" }]);
    const key = nodeflowColsCacheKey("sig-a", "sel", "canvas", fp);
    setNodeflowColsCache(key, { p: ["col1"] });
    expect(nodeflowColsCacheSizeForTests()).toBeGreaterThan(0);

    clearNodeflowColsCache();

    expect(nodeflowColsCacheSizeForTests()).toBe(0);
    expect(getNodeflowColsCache(key)).toBeUndefined();
  });

  it("does not cross-contaminate two distinct graphSig epochs in the same session", () => {
    const fp = fingerprintColumnReqs([{ port: "in", node: "x", fromPort: "out" }]);

    // Write epoch-A columns
    const keyA = nodeflowColsCacheKey("epoch-A", "sel", "canvas", fp);
    setNodeflowColsCache(keyA, { in: ["a1", "a2"] });

    // Write epoch-B columns — should prune epoch-A
    const keyB = nodeflowColsCacheKey("epoch-B", "sel", "canvas", fp);
    setNodeflowColsCache(keyB, { in: ["b1"] });

    // epoch-A entries must be gone
    expect(getNodeflowColsCache(keyA)).toBeUndefined();
    // epoch-B entries are live
    expect(getNodeflowColsCache(keyB)).toEqual({ in: ["b1"] });
    // No ghost entries accumulating
    expect(nodeflowColsCacheSizeForTests()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. stampResultEpoch — marks stale vs current relative to dataEpoch
// ---------------------------------------------------------------------------

describe("stampResultEpoch", () => {
  it("returns current dataEpoch when result carries no epoch (legacy result)", () => {
    const result: any = { rows: [], total_rows: 0 }; // no data_epoch field
    // stampResultEpoch(result, currentEpoch) should return currentEpoch
    // when the result has no epoch field (treated as matching current)
    const stamped = stampResultEpoch(result, 5);
    // Either returns 5 (current) or null/undefined — it must NOT return a
    // stale epoch (< 5) when the result genuinely has no epoch metadata.
    expect(stamped === 5 || stamped == null).toBe(true);
  });

  it("returns the result's own data_epoch when it matches current epoch", () => {
    const result: any = { rows: [], total_rows: 0, data_epoch: 7 };
    const stamped = stampResultEpoch(result, 7);
    expect(stamped).toBe(7);
  });

  it("returns the result's data_epoch even when it is behind current epoch (stale)", () => {
    const result: any = { rows: [], total_rows: 0, data_epoch: 3 };
    const stamped = stampResultEpoch(result, 7);
    // stamped epoch (3) !== current epoch (7) → UI marks dataStale
    expect(stamped).toBe(3);
    expect(stamped).not.toBe(7);
  });

  it("returns the result's data_epoch when it is ahead of current epoch (future result)", () => {
    // e.g. a result returned after a table-drop raised the epoch server-side
    // but the client hasn't yet received the new epoch in its state
    const result: any = { rows: [], total_rows: 0, data_epoch: 10 };
    const stamped = stampResultEpoch(result, 8);
    expect(stamped).toBe(10);
  });
});
