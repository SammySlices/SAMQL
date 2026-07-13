import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, abortInflight, cancelAllBgOps } from "../lib/api";
import { deriveActivity, POLL_MS } from "../lib/activity";
import type { ActivityStatus, TaskCard } from "../lib/types";
import { Icon } from "./Icon";
import { formatBytes } from "../lib/format";

// Polls /api/status while ``active`` (single-flighted, so overlapping polls
// never pile up and exhaust the connection pool). Shared by the Activity modal
// and the memory widget so both read live status the same way.
//
// The last good snapshot is cached at module scope so a consumer that mounts
// fresh (e.g. the memory popover, which unmounts when closed) shows the
// last-known status immediately instead of flashing/sticking on "checking..."
// until its first poll returns -- which can lag when a load has saturated the
// connection pool.
let _lastStatus: ActivityStatus | null = null;
let _lastBeat = 0;

export function useActivityStatus(active: boolean, pollMs = POLL_MS) {
  const [status, setStatus] = useState<ActivityStatus | null>(_lastStatus);
  const [err, setErr] = useState<string | null>(null);
  const [beat, setBeat] = useState(_lastBeat); // ticks each poll -> the pulse
  const polling = useRef(false);
  const timer = useRef<number | null>(null);

  const refresh = () => {
    if (polling.current) return;
    polling.current = true;
    api
      .status()
      .then((d) => {
        _lastStatus = d;
        setStatus(d);
        setErr(null);
        setBeat((b) => {
          const n = (b + 1) % 1000;
          _lastBeat = n;
          return n;
        });
      })
      .catch((e: any) => setErr(String(e?.message || e)))
      .finally(() => {
        polling.current = false;
      });
  };

  useEffect(() => {
    if (!active) return;
    refresh();
    timer.current = window.setInterval(refresh, pollMs);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
     
  }, [active, pollMs]);

  return { status, err, beat, refresh };
}

// The engine/server reset action + its transient state. Frees the connection
// pool first (abortInflight) so the reset request can get through even when a
// busy engine has occupied every per-host slot, then rebuilds tables.
// .524: the nuke destroys the JOURNAL and NODEFLOW working state too --
// autosaved cells, docs, groups, recovery snapshots, graphs, tabs and
// favorites all go. Profiles, saved workflows, theme/view prefs and the
// IDE editor-tab autosave are launch state and stay. sessionStorage is
// ephemeral by definition: cleared wholesale.
const NUKE_PREFIXES = ["samql.nb.", "samql.notebook.", "samql.nodebook.", "samql.nodeflow."];
export function purgeWorkingState(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && NUKE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    /* private mode / quota */
  }
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

export function useEngineReset(onDone?: () => void) {
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  // .524: IN-APP two-step confirmation -- the first click ARMS the button
  // (native window.confirm is dialog-host dependent in the pywebview
  // window; this one always asks). A second click within 6s fires; doing
  // nothing disarms.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const disarm = () => {
    setArmed(false);
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const resetEngines = () => {
    // .523: NUCLEAR. Kill + wipe everything on the server (queries, loads,
    // flows, engines, tables, results, temps, restore manifest), then
    // hard-reload the page so the frontend restarts from scratch too --
    // both sides land in their exact launch state. The reload fires even
    // if the request itself hangs; a fresh page reconnects regardless.
    if (!armed) {
      setArmed(true);
      setResetMsg(
        "NUCLEAR RESET — nothing survives. Every running query, load and " +
          "flow is killed; every loaded table, result and temp file is " +
          "destroyed; the journal and NodeFlow working state are wiped; " +
          "both engines restart EMPTY and the app reloads to its launch " +
          "state. Saved workflows, history and settings are kept. " +
          "Click the button again to confirm.",
      );
      armTimer.current = window.setTimeout(disarm, 6000);
      return;
    }
    disarm();
    setResetting(true);
    setResetMsg("Nuking…");
    try {
      abortInflight();
      cancelAllBgOps();
    } catch {
      /* ignore */
    }
    let boomed = false;
    const boom = () => {
      if (boomed) return;
      boomed = true;
      try {
        abortInflight();
      } catch {
        /* ignore */
      }
      purgeWorkingState();
      window.location.reload();
    };
    api.nuke().then(boom, boom);
    // reload even if the request never settles -- absurdly aggressive
    window.setTimeout(boom, 4000);
  };

  return { resetEngines, resetting, resetMsg, armed };
}

// The traffic-light monitor + per-engine connection badges. This is the
// "connection and activity status" block reused by the Activity modal and the
// memory widget.
export const ActivityMonitor: React.FC<{
  status: ActivityStatus;
  beat: number;
}> = ({ status, beat }) => {
  const { state, stateWord, activity } = deriveActivity(status);
  const eng = status.engines;

  const badge = (label: string, active: boolean, busy: boolean) => (
    <span
      className={"act-engine" + (!active ? " off" : busy ? " busy" : " idle")}
      title={
        !active
          ? `${label}: not started`
          : busy
          ? `${label}: working now`
          : `${label}: connected, idle`
      }
    >
      <span className="act-dot" />
      {label}
      <span className="act-engine-state">
        {!active ? "off" : busy ? "busy" : "idle"}
      </span>
    </span>
  );

  return (
    <>
      <div className={"act-monitor " + state}>
        <span className="act-hb" aria-hidden="true">
          <span className="act-hb-ring" key={beat} />
          <span className="act-hb-core" />
        </span>
        <div className="act-monitor-text">
          <div className="act-monitor-state">
            {stateWord}
            <span className="act-live" title="Live — updating">
              <span className="act-live-dot" key={beat} /> live
            </span>
          </div>
          <div className="act-monitor-activity" title={activity}>
            {activity}
          </div>
        </div>
      </div>

      <div className="act-engines">
        {badge("SQLite", true, !!eng?.sqlite.busy)}
        {badge("DuckDB", !!eng?.duckdb.active, !!eng?.duckdb.busy)}
        {status.restoring && (
          <span className="act-engine restoring" title="Rebuilding tables">
            <span className="spin" /> restoring tables
          </span>
        )}
      </div>
    </>
  );
};

// ---- Activity tray -------------------------------------------------------
// Background tasks (loads, conversions, HDFS downloads, flattens, API +
// iterator runs) shown as cards instead of trapping the user on a modal. The
// feed comes from /api/tasks; a card's X cancels via the same per-job cancel
// the modals used; finished cards are dismissed client-side.

// Plain, user-facing names -- never the internal job kind/state strings.
const TASK_KIND_LABEL: Record<string, string> = {
  load: "Load",
  folder: "Folder load",
  hdfs: "HDFS download",
  convert: "Convert to Parquet",
  flatten: "Flatten",
  api: "API run",
  iterator: "Iterator",
};
const TASK_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

// Polls /api/tasks while ``active``. If ``onComplete`` is given, it fires once
// per task as it transitions to a terminal state (done / error / cancelled) --
// this is how completion toasts + a table refresh happen now that there is no
// per-load modal. The first poll is seeded silently, so a task that finished
// before this session started watching never fires a stale toast. Dismissal
// (of finished cards) is local to the client -- the backend sweeps finished
// jobs after a few minutes, so a dismissed card simply will not reappear.
// .413 consolidation: ONE floating-window drag implementation. Three
// components carried identical copies (Activity window, value
// inspector, field-explorer window); they all use this hook now.
export function useWinDrag(init: { x: number; y: number }) {
  const [pos, setPos] = React.useState(init);
  // .459: expose the drag lifecycle so panels can deepen their shadow
  // while held and play a one-shot "settle" when released.
  const [dragging, setDragging] = React.useState(false);
  const [settled, setSettled] = React.useState(false);
  const drag = React.useRef<{ dx: number; dy: number } | null>(null);
  const settleTimer = React.useRef<number | null>(null);
  // .470: drag is IMPERATIVE. Setting state per mousemove re-rendered
  // the whole floating panel (the docs window is heavy) every frame --
  // that was the drag lag. Panels attach winRef; while held we write
  // left/top straight to the element and commit state ONCE on release.
  const winRef = React.useRef<HTMLElement | null>(null);
  const last = React.useRef(init);
  React.useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!drag.current) return;
      const next = {
        x: Math.max(0, e.clientX - drag.current.dx),
        y: Math.max(0, e.clientY - drag.current.dy),
      };
      last.current = next;
      const el = winRef.current;
      if (el) {
        el.style.left = next.x + "px";
        el.style.top = next.y + "px";
      } else {
        setPos(next);
      }
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      setPos(last.current);
      setSettled(true);
      if (settleTimer.current != null)
        window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        setSettled(false);
        settleTimer.current = null;
      }, 320);
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
      if (settleTimer.current != null)
        window.clearTimeout(settleTimer.current);
    };
  }, []);
  const startDrag = React.useCallback(
    (e: { clientX: number; clientY: number; preventDefault(): void }) => {
      drag.current = {
        dx: e.clientX - last.current.x,
        dy: e.clientY - last.current.y,
      };
      setDragging(true);
      setSettled(false);
      e.preventDefault();
    },
    [],
  );
  // external moves (auto-centering on open) must keep the drag
  // anchor in sync with what's on screen.
  const setPosSync = React.useCallback(
    (p: { x: number; y: number }) => {
      last.current = p;
      setPos(p);
    },
    [],
  );
  // panels that never attach winRef keep the legacy per-move renders.
  return { pos, setPos: setPosSync, startDrag, dragging, settled, winRef };
}

export function useTasks(
  active: boolean,
  onComplete?: (t: TaskCard) => void,
  pollMs = 1500,
) {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [opsCount, setOpsCount] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  // mirror the latest tasks so clearCompleted can hide finished cards
  // optimistically while staying a stable ([]) callback
  const tasksRef = useRef<TaskCard[]>([]);
  tasksRef.current = tasks;
  const fired = useRef<Record<string, boolean>>({});
  const seeded = useRef(false);
  const onDone = useRef(onComplete);
  onDone.current = onComplete;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const terminal = (st: string) =>
      st === "done" || st === "error" || st === "cancelled";
    const tick = async () => {
      // .455 [PLAN PASS 12]: prune the once-fired flags for tasks that
      // left the list -- a long session's ids can no longer pile up.
      const live = new Set(tasksRef.current.map((t) => t.id));
      for (const k of Object.keys(fired.current))
        if (!live.has(k)) delete fired.current[k];
      try {
        const r = await api.tasks();
        if (!alive) return;
        const list = r.tasks || [];
        setTasks(list);
        setOpsCount(Number((r as { operations?: number }).operations) || 0);
        setStalled(Boolean((r as { stalled?: boolean }).stalled));
        const cb = onDone.current;
        if (cb) {
          if (!seeded.current) {
            list.forEach((t) => {
              if (terminal(t.state)) fired.current[t.id] = true;
            });
            seeded.current = true;
          } else {
            list.forEach((t) => {
              if (terminal(t.state) && !fired.current[t.id]) {
                fired.current[t.id] = true;
                cb(t);
              }
            });
          }
        }
      } catch {
        /* transient; keep polling */
      }
    };
    void tick();
    const iv = window.setInterval(tick, pollMs);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [active, pollMs]);

  const cancel = useCallback((id: string) => {
    api.loadCancel(id).catch(() => {});
  }, []);
  const dismiss = useCallback((id: string) => {
    setDismissed((d) => ({ ...d, [id]: true })); // optimistic hide
    api.dismissTask(id).catch(() => {}); // remove it for good, so it can't
    // reappear when the modal/popover is reopened (shared across both)
  }, []);
  const clearCompleted = useCallback(() => {
    setDismissed((d) => {
      const next = { ...d };
      tasksRef.current.forEach((t) => {
        if (t.state === "done" || t.state === "error" || t.state === "cancelled")
          next[t.id] = true; // optimistic hide
      });
      return next;
    });
    api.clearCompletedTasks().catch(() => {}); // remove them all for good
  }, []);
  const visible = tasks.filter((t) => !dismissed[t.id]);
  const activeTasks = visible.filter(
    (t) => t.state === "running" || t.state === "queued",
  );
  const completedTasks = visible.filter(
    (t) => t.state === "done" || t.state === "error" || t.state === "cancelled",
  );
  const cancelAll = useCallback(() => {
    // One robust halt: interrupt every engine + flag every in-flight job
    // (including queued / just-started ones a per-card loop can miss).
    void api.cancelAll().catch(() => {});
  }, []);
  return {
    tasks,
    visible,
    activeTasks,
    activeCount: activeTasks.length,
    opsCount,
    stalled,
    completedTasks,
    completedCount: completedTasks.length,
    cancel,
    cancelAll,
    dismiss,
    clearCompleted,
  };
}

const TaskCardRow: React.FC<{
  t: TaskCard;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  forceLeaving?: boolean;
}> = ({ t, onCancel, onDismiss, forceLeaving }) => {
  const p = t.progress || { mode: "spinner", done: 0, total: 0 };
  // after the read finishes, a load still writes rows + counts with no byte
  // signal; show an indeterminate "Finalizing" bar then, not one frozen at 100%
  const finalizing = t.phase === "finalizing";
  const determinate =
    (p.mode === "bytes" || p.mode === "steps") && p.total > 0 && !finalizing;
  const pct = determinate
    ? Math.min(100, Math.round((p.done / p.total) * 100))
    : null;
  const running = t.state === "running" || t.state === "queued";
  const label = finalizing
    ? "Finalizing — writing rows…"
    : p.mode === "bytes" && p.total > 0
      ? `${formatBytes(p.done)} / ${formatBytes(p.total)}`
      : p.mode === "steps" && p.total > 0
        ? `pass ${p.done}/${p.total}`
        : t.state === "queued"
          ? "Waiting for the engine…"
          : `${t.phase || "Working"}…`;
  // .460: dismissing slides the card away before removal; survivors
  // reflow smoothly under the collapsing height.
  const [leaving, setLeaving] = React.useState(false);
  const leaveTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (leaveTimer.current != null)
        window.clearTimeout(leaveTimer.current);
    },
    [],
  );
  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      onDismiss(t.id);
    }, 210);
  };
  return (
    <div
      className={
        "task-card s-" + t.state + (leaving || forceLeaving ? " leaving" : "")
      }
    >
      <div className="task-card-head">
        <span className={"act-kind k-" + t.kind}>
          {TASK_KIND_LABEL[t.kind] || t.kind}
        </span>
        <span className="task-title" title={t.title}>
          {t.title}
        </span>
        <span className="spacer" />
        <span className={"task-state st-" + t.state}>
          {TASK_STATE_LABEL[t.state] || t.state}
        </span>
        <button
          className={"btn ghost icon" + (running ? " task-cancel-x" : "")}
          title={running ? "Cancel this task" : "Dismiss"}
          onClick={() => (running ? onCancel(t.id) : dismiss())}
        >
          <Icon.X size={15} />
        </button>
      </div>
      {t.state === "error" && t.error ? (
        <div className="task-err">{t.error}</div>
      ) : t.state === "done" ? (
        <div className="task-prog-label faint">
          <svg className="task-check" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5 L6.5 12 L13 4.5" />
          </svg>
          Done{t.rows != null ? ` · ${t.rows.toLocaleString()} rows` : ""}
          {t.note ? ` · ${t.note}` : ""}
        </div>
      ) : t.state === "cancelled" ? (
        <div className="task-prog-label faint">Cancelled</div>
      ) : (
        <div className="task-prog">
          <div className={"progress" + (determinate ? "" : " indeterminate")}>
            <div
              className="bar"
              style={determinate ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="task-prog-label faint">
            {label}
            {pct != null ? ` · ${pct}%` : ""}
          </div>
        </div>
      )}
    </div>
  );
};

// The tray section, shown under the connection monitor in the Activity modal.
export const TaskTray: React.FC<{ hideEmpty?: boolean }> = ({ hideEmpty }) => {
  const {
    visible,
    activeTasks,
    completedTasks,
    cancel,
    cancelAll,
    dismiss,
    clearCompleted,
  } = useTasks(true);
  // .483: Clear all should slide every finished card away together (the
  // same exit a single dismiss plays) instead of blinking them out. Mark
  // the completed cards leaving, then actually clear them once the
  // animation has run. `clearing` drives the cards' forceLeaving; the ref
  // guards a double-click and the unmount cleanup cancels a pending clear.
  const [clearing, setClearing] = useState(false);
  const clearTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (clearTimer.current != null) window.clearTimeout(clearTimer.current);
    },
    [],
  );
  const gracefulClear = useCallback(() => {
    if (clearing) return; // a clear is already animating
    setClearing(true);
    clearTimer.current = window.setTimeout(() => {
      clearTimer.current = null;
      clearCompleted(); // remove them for good once they've slid away
      setClearing(false); // reset for the next batch of finished cards
    }, 230); // just past the .task-card.leaving 0.22s transition
  }, [clearing, clearCompleted]);
  // in the compact stat popover, render nothing when there is nothing to show
  if (hideEmpty && !visible.length) return null;
  const isDone = (t: TaskCard) =>
    t.state === "done" || t.state === "error" || t.state === "cancelled";
  return (
    <div className="task-tray">
      <div className="act-section-label task-tray-head">
        <span>
          Background tasks{visible.length ? ` (${visible.length})` : ""}
        </span>
        {completedTasks.length > 0 && (
          <span className="task-tray-actions">
            <button
              className="btn ghost sm"
              onClick={gracefulClear}
              disabled={clearing}
            >
              Clear all
            </button>
          </span>
        )}
      </div>
      {activeTasks.length > 0 && (
        <button
          className="btn ghost sm task-tray-cancel-all"
          onClick={cancelAll}
          title="Stop every running background task"
        >
          <Icon.X size={12} /> Cancel all
        </button>
      )}
      {!visible.length ? (
        <div className="faint">
          No background tasks. Loads, conversions, HDFS downloads, and flattens
          appear here while they work — each with its own progress and a button
          to stop it.
        </div>
      ) : (
        <div className="task-list">
          {visible.map((t) => (
            <TaskCardRow
              key={t.id}
              t={t}
              onCancel={cancel}
              onDismiss={dismiss}
              forceLeaving={clearing && isDone(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// An invisible, always-mounted poll that fires completion toasts as background
// tasks finish. Kept in its own component so the 1.5s /api/tasks tick
// re-renders only itself, never the IDE -- the per-load modal isolated its
// poll the same way before the tray replaced it.
export const TaskWatcher: React.FC<{
  onComplete: (t: TaskCard) => void;
}> = ({ onComplete }) => {
  useTasks(true, onComplete);
  return null;
};

export const ServerStatus: React.FC<{ embedded?: boolean }> = ({
  embedded,
}) => {
  // ``embedded``: hosted inside the Activity dashboard, which ALREADY
  // renders the monitor at the top and owns Reset in its footer -- skip
  // both here or the window shows everything twice (on-box 2026-07-02).
  const { status, beat, refresh } = useActivityStatus(true);
  const { resetEngines, resetting, resetMsg, armed } = useEngineReset(refresh);
  // Foreground runs / bg ops (queries, flows, profiles, save-as-table, change
  // type, connector imports) surfaced here so they can be cancelled without
  // opening the Activity modal. Background loads have their own tray cards
  // below; restore is uncancellable by design and never appears here.
  const cancelOps = (status?.operations || []).filter((o) => o.cancellable);
  return (
    <>
      {!embedded && <div className="label">Server</div>}
      <div className="mem-status">
        {status && !embedded ? (
          <ActivityMonitor status={status} beat={beat} />
        ) : status ? null : (
          <div className="faint" style={{ padding: "2px 10px" }}>
            <span className="spin" /> checking…
          </div>
        )}
        {resetMsg && <div className="act-note mem-reset-note">{resetMsg}</div>}
      </div>
      {cancelOps.length > 0 && (
        <div className="mem-ops">
          {cancelOps.map((o) => (
            <div className="mem-op" key={o.id}>
              <span className={"act-kind k-" + o.kind}>{o.kind}</span>
              {o.target ? (
                <span className="act-target"> {o.target}</span>
              ) : null}
              <span className="spacer" />
              <button
                className="btn ghost icon"
                title="Cancel this operation"
                onClick={() => {
                  api.cancelQuery(o.id).catch(() => {});
                  refresh();
                }}
              >
                <Icon.X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <TaskTray hideEmpty />
      {!embedded && (
        <button
          className="danger"
          disabled={resetting}
          onClick={resetEngines}
        >
          {resetting
            ? "Nuking…"
            : armed
              ? "Click again to confirm"
              : "Reset server"}
        </button>
      )}
    </>
  );
};
