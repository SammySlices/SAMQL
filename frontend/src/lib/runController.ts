import { api } from "./api";

// Shared run/cancel primitives used by all three run surfaces -- the IDE query,
// the Journal cells, and the Node workflow. Starting and (above all) cancelling
// a run must behave identically everywhere.
//
// MANTRA: Cancel must ALWAYS stop BOTH the frontend request AND the backend
// work immediately. Aborting the fetch alone leaves the engine running;
// interrupt alone leaves the UI waiting. Every Stop uses cancelOne/cancelById.

// True when a thrown error is really a cancellation rather than a genuine
// failure: an aborted fetch, a client-side timeout (ApiError carries status 0),
// or a backend "cancelled". Used so a Stop reads as "Cancelled", never a red
// error, on every surface.
export function isCancelledError(e: any, queryId?: string | null): boolean {
  // .519: a run the USER cancelled must read as cancelled even when the
  // failure surfaces as a network error -- the server aborts a cancelled
  // response mid-send, so the fetch rejects with "Failed to fetch".
  if (queryId && wasCancelled(queryId)) return true;
  if (!e) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (typeof e.status === "number" && e.status === 0) return true;
  const m = String(e?.message ?? e).toLowerCase();
  return (
    m.includes("abort") || m.includes("cancel") || m.includes("timed out")
  );
}

// .519: the central run registry. Every surface registers its run's
// AbortController under the query id, so a Cancel from ANYWHERE (the
// Activity modal above all) can abort the frontend fetch AND interrupt the
// backend in one call -- no orphaned request, no "Failed to fetch" error
// painted for a stop the user asked for.
const _ctl = new Map<string, Set<AbortController>>();
const _cancelled = new Map<string, number>();
const CANCEL_MEMORY_MS = 60_000;

export function registerRun(queryId: string, ctrl: AbortController): void {
  if (!queryId) return;
  let set = _ctl.get(queryId);
  if (!set) {
    set = new Set();
    _ctl.set(queryId, set);
  }
  set.add(ctrl);
}

// Remove one controller (a finished page fetch) or, with no ctrl, every
// controller under the id (the run is over).
export function unregisterRun(
  queryId: string | null | undefined,
  ctrl?: AbortController,
): void {
  if (!queryId) return;
  const set = _ctl.get(queryId);
  if (!set) return;
  if (ctrl) set.delete(ctrl);
  else set.clear();
  if (set.size === 0) _ctl.delete(queryId);
}

export function markCancelled(queryId: string | null | undefined): void {
  if (queryId) _cancelled.set(queryId, Date.now());
}

export function wasCancelled(queryId: string | null | undefined): boolean {
  if (!queryId) return false;
  const t = _cancelled.get(queryId);
  if (!t) return false;
  if (Date.now() - t > CANCEL_MEMORY_MS) {
    _cancelled.delete(queryId);
    return false;
  }
  return true;
}

function abortRegistered(queryId: string): void {
  const set = _ctl.get(queryId);
  if (!set) return;
  for (const c of set) {
    try {
      c.abort();
    } catch {
      /* ignore */
    }
  }
}

// One call cancels a run END TO END: remember the intent (so the pending
// promise's rejection reads as Cancelled), abort every local fetch under
// the id (run + page siblings), interrupt the backend. Aborting the fetch
// alone is never enough -- the engine keeps running until cancelQuery.
export function cancelById(queryId: string): void {
  if (!queryId) return;
  markCancelled(queryId);
  abortRegistered(queryId);
  api.cancelQuery(queryId).catch(() => {});
}

// Cancel a single run end-to-end. Always interrupts the backend; aborts every
// registered controller under the id (not just the one the caller held), so a
// Stop mid-page-fetch cannot leave a sibling request or the engine running.
// The optional ctrl is aborted too for callers that have not registered yet.
export function cancelOne(
  queryId: string | null | undefined,
  ctrl?: AbortController | null,
): void {
  markCancelled(queryId);
  if (queryId) abortRegistered(queryId);
  try {
    ctrl?.abort();
  } catch {
    /* ignore */
  }
  if (queryId) api.cancelQuery(queryId).catch(() => {});
}

// Hard stop / recovery for the explicitly-owned runs only. Older builds called
// abortInflight() here, which also killed unrelated metadata/navigation calls
// such as health checks and file-browser listings. Every executable surface now
// registers its own controller under the run id, so cancellation can stay
// scoped while still aborting the frontend request and interrupting the backend.
export function cancelAllRuns(
  queryIds: ReadonlyArray<string | null | undefined> = [],
): void {
  const ids = queryIds.length
    ? queryIds.filter((id): id is string => !!id)
    : [..._ctl.keys()];
  for (const id of new Set(ids)) cancelById(id);
}
