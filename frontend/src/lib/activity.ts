// Shared activity/connection logic, so the Activity modal and the memory
// widget's status section derive state the same way instead of each computing
// it. Pure helpers live here; the React hooks + monitor component live in
// components/ActivityShared.tsx.
import { formatCount } from "./format";
import type { ActivityStatus } from "./types";

export const POLL_MS = 1500;
export const STALL_HINT_S = 20;
// how recently a failure counts as "current" for the red light
export const FAIL_WINDOW_S = 30;

export function opSummary(kind: string, target: string | null): string {
  const verb =
    kind === "load"
      ? "Loading"
      : kind === "restore"
      ? "Restoring"
      : kind === "query"
      ? "Running query"
      : kind === "run"
      ? "Running flow"
      : kind;
  return target ? `${verb} ${target}` : verb;
}

export interface DerivedActivity {
  state: "idle" | "busy" | "error";
  stateWord: string;
  activity: string;
}

// Traffic light: red on a recent failure (a fresh server error or a watchdog
// stall), yellow while anything is working, green when idle.
export function deriveActivity(status: ActivityStatus | null): DerivedActivity {
  const ops = status?.operations || [];
  const eng = status?.engines;
  const stall = status?.last_stall || null;
  const recentError =
    status?.last_error && status.last_error.age_s <= FAIL_WINDOW_S
      ? status.last_error
      : null;
  const failing = !!stall || !!recentError;
  const working =
    ops.length > 0 ||
    !!eng?.sqlite.busy ||
    !!eng?.duckdb.busy ||
    !!status?.restoring;
  const state: "idle" | "busy" | "error" = failing
    ? "error"
    : working
    ? "busy"
    : "idle";
  const stateWord =
    state === "error" ? "Problem" : state === "busy" ? "Working" : "Idle";
  const activity =
    state === "error"
      ? recentError
        ? recentError.error
        : stall
        ? `Stalled — ${opSummary(stall.kind, stall.target)} (no progress for ${Math.round(
            stall.idle_s,
          )}s)`
        : "A failure was detected."
      : ops.length === 1
      ? `${opSummary(ops[0].kind, ops[0].target)}${
          ops[0].rows ? ` — ${formatCount(ops[0].rows)} rows so far` : ""
        }`
      : ops.length > 1
      ? `${ops.length} operations running`
      : status?.restoring
      ? "Rebuilding tables"
      : eng?.duckdb.busy
      ? "DuckDB is working on something"
      : eng?.sqlite.busy
      ? "SQLite is working on something"
      : "All clear — nothing running";
  return { state, stateWord, activity };
}
