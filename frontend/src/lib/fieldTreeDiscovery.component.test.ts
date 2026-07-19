import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelOneMock = vi.hoisted(() => vi.fn());

vi.mock("./runController", () => ({
  cancelOne: cancelOneMock,
}));

import {
  abortColumnFieldsDiscovery,
  abortFieldTreeDiscoveriesForTable,
  fieldTreeDiscoveryInflightCountForTests,
  fieldTreeDiscoveryQueryIdForTests,
  resetFieldTreeDiscoveryForTests,
  startColumnFieldsDiscovery,
  startTableFieldsDiscovery,
} from "./fieldTreeDiscovery";

describe("fieldTreeDiscovery", () => {
  beforeEach(() => {
    cancelOneMock.mockReset();
    cancelOneMock.mockImplementation(
      (_qid: string, ctrl?: AbortController | null) => {
        try {
          ctrl?.abort();
        } catch {
          /* ignore */
        }
      },
    );
    resetFieldTreeDiscoveryForTests();
  });

  it("aborts prior column discovery when a second column on the same table starts", () => {
    const a = startColumnFieldsDiscovery("duckdb", "t1", "legs");
    expect(a.signal.aborted).toBe(false);
    const b = startColumnFieldsDiscovery("duckdb", "t1", "nest");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(fieldTreeDiscoveryInflightCountForTests()).toBe(1);
  });

  it("Field Explorer table sample aborts competing Sidebar column discovery", () => {
    const col = startColumnFieldsDiscovery("duckdb", "t1", "legs");
    const fe = startTableFieldsDiscovery("duckdb", "t1");
    expect(col.signal.aborted).toBe(true);
    expect(fe.signal.aborted).toBe(false);
  });

  it("Sidebar column start aborts competing Field Explorer sample", () => {
    const fe = startTableFieldsDiscovery("duckdb", "t1");
    const col = startColumnFieldsDiscovery("duckdb", "t1", "legs");
    expect(fe.signal.aborted).toBe(true);
    expect(col.signal.aborted).toBe(false);
  });

  it("abortColumnFieldsDiscovery cancels that column only", () => {
    const a = startColumnFieldsDiscovery("duckdb", "t1", "legs");
    // Different table must not be aborted by column abort of t1.
    const other = startColumnFieldsDiscovery("duckdb", "t2", "x");
    abortColumnFieldsDiscovery("duckdb", "t1", "legs");
    expect(a.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("abortFieldTreeDiscoveriesForTable clears all slots for that table", () => {
    const fe = startTableFieldsDiscovery("duckdb", "t1");
    // FE occupies the table slot; starting a column replaces it — use abort helper directly.
    abortFieldTreeDiscoveriesForTable("duckdb", "t1");
    expect(fe.signal.aborted).toBe(true);
    const col = startColumnFieldsDiscovery("duckdb", "t1", "legs");
    abortFieldTreeDiscoveriesForTable("duckdb", "t1");
    expect(col.signal.aborted).toBe(true);
    expect(fieldTreeDiscoveryInflightCountForTests()).toBe(0);
  });

  it("abort with query_id uses cancelOne (frontend + backend)", () => {
    const ctrl = startColumnFieldsDiscovery(
      "duckdb",
      "t1",
      "legs",
      "sb-colfields-test",
    );
    expect(fieldTreeDiscoveryQueryIdForTests("duckdb", "t1", "legs")).toBe(
      "sb-colfields-test",
    );
    abortColumnFieldsDiscovery("duckdb", "t1", "legs");
    expect(ctrl.signal.aborted).toBe(true);
    expect(cancelOneMock).toHaveBeenCalledWith("sb-colfields-test", ctrl);
  });

  it("supersede with query_id cancelOnes the prior discovery", () => {
    const a = startColumnFieldsDiscovery(
      "duckdb",
      "t1",
      "legs",
      "sb-old",
    );
    startColumnFieldsDiscovery("duckdb", "t1", "nest", "sb-new");
    expect(a.signal.aborted).toBe(true);
    expect(cancelOneMock).toHaveBeenCalledWith("sb-old", a);
  });

  it("Field Explorer start with query_id cancelOnes competing Sidebar", () => {
    const col = startColumnFieldsDiscovery(
      "duckdb",
      "t1",
      "legs",
      "sb-col",
    );
    startTableFieldsDiscovery("duckdb", "t1", "fe-fields-1");
    expect(col.signal.aborted).toBe(true);
    expect(cancelOneMock).toHaveBeenCalledWith("sb-col", col);
    expect(fieldTreeDiscoveryQueryIdForTests("duckdb", "t1")).toBe(
      "fe-fields-1",
    );
  });
});
