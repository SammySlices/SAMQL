import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("./api", () => ({
  api: {
    cancelQuery: cancelQueryMock,
  },
}));

import {
  cancelAllRuns,
  cancelById,
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
  wasCancelled,
} from "./runController";

describe("runController end-to-end cancel", () => {
  beforeEach(() => {
    cancelQueryMock.mockClear();
    // Drain any leftover registrations from prior tests.
    cancelAllRuns();
  });

  it("cancelOne aborts every registered controller and always cancelQueries", () => {
    const a = new AbortController();
    const b = new AbortController();
    registerRun("q-multi", a);
    registerRun("q-multi", b);

    cancelOne("q-multi", a);

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(cancelQueryMock).toHaveBeenCalledWith("q-multi");
    expect(wasCancelled("q-multi")).toBe(true);
    expect(isCancelledError(new Error("Failed to fetch"), "q-multi")).toBe(
      true,
    );

    unregisterRun("q-multi");
  });

  it("cancelById aborts registered fetches even when no ctrl is passed", () => {
    const ctrl = new AbortController();
    registerRun("q-byid", ctrl);
    cancelById("q-byid");
    expect(ctrl.signal.aborted).toBe(true);
    expect(cancelQueryMock).toHaveBeenCalledWith("q-byid");
    unregisterRun("q-byid");
  });

  it("cancelOne still cancelQueries when nothing is registered yet", () => {
    const ctrl = new AbortController();
    cancelOne("q-early", ctrl);
    expect(ctrl.signal.aborted).toBe(true);
    expect(cancelQueryMock).toHaveBeenCalledWith("q-early");
    expect(wasCancelled("q-early")).toBe(true);
  });
});
