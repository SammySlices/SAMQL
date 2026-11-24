import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";
import { isCancelledError, markCancelled } from "./runController";

// H-8: a cancel is decided only from structured signals -- the run registry,
// an aborted fetch, or the backend's `cancelled: true` -- never from words
// in an error message, and never from a timeout.
describe("isCancelledError (H-8)", () => {
  it("a real error that mentions cancel/abort/interrupt is a failure", () => {
    expect(
      isCancelledError(
        new ApiError(500, 'Binder Error: Referenced column "cancel_dt" not found'),
      ),
    ).toBe(false);
    expect(
      isCancelledError(new ApiError(500, "Catalog Error: Table cancelled_trades does not exist")),
    ).toBe(false);
    expect(isCancelledError(new Error('column "abort_reason" not found'))).toBe(false);
    expect(isCancelledError(new Error("interrupt_flag must be boolean"))).toBe(false);
  });

  it("a client timeout or a dropped connection is a failure, not a cancel", () => {
    expect(isCancelledError(new ApiError(0, "Request timed out after 3s", { timedOut: true }))).toBe(false);
    expect(isCancelledError(new ApiError(0, "Failed to fetch"))).toBe(false);
    expect(isCancelledError(new DOMException("t", "TimeoutError"))).toBe(false);
  });

  it("structured cancels still read as cancelled", () => {
    expect(isCancelledError(new ApiError(0, "Request aborted", { aborted: true }))).toBe(true);
    expect(isCancelledError(new ApiError(500, "interrupted", { cancelled: true }))).toBe(true);
    expect(isCancelledError(new DOMException("Aborted", "AbortError"))).toBe(true);
    markCancelled("h8-q");
    expect(isCancelledError(new Error("Failed to fetch"), "h8-q")).toBe(true);
  });
});

describe("apiFetch classifies aborts, timeouts and backend cancels (H-8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function hangingFetch() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
  }

  it("a caller abort is an aborted ApiError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctrl = new AbortController();
    const p = api.reconcile({ left: "a", right: "b", keys: ["k"] } as any, ctrl.signal);
    ctrl.abort();
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.aborted).toBe(true);
    expect(isCancelledError(e)).toBe(true);
  });

  it("the client timeout is a timedOut ApiError, not a cancel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = api.health().catch((x) => x);
    await vi.advanceTimersByTimeAsync(4000);
    const e = await p;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.timedOut).toBe(true);
    expect(isCancelledError(e)).toBe(false);
  });

  it("a backend error body with cancelled:true is a cancel; one without is not", async () => {
    const reply = (body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status: 500 }));
    vi.stubGlobal("fetch", reply({ error: "interrupted", cancelled: true }));
    const e1 = await api.health().catch((x) => x);
    expect(isCancelledError(e1)).toBe(true);
    vi.stubGlobal(
      "fetch",
      reply({ error: 'Binder Error: Referenced column "cancel_dt" not found' }),
    );
    const e2 = await api.health().catch((x) => x);
    expect(isCancelledError(e2)).toBe(false);
  });
});
