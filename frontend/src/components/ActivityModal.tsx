import React from "react";
import { ServerStatus, useWinDrag } from "./ActivityShared";
import { formatCount } from "../lib/format";
import { STALL_HINT_S } from "../lib/activity";
import { cancelById } from "../lib/runController";
import { api } from "../lib/api";
import { Icon } from "./Icon";
import {
  useActivityStatus,
  useEngineReset,
  ActivityMonitor,
} from "./ActivityShared";

// A live view of what the app is doing right now: in-flight operations (with
// rows processed and how long since each last made progress), which engine
// connections are busy, the background thread count, and the most recent stall
// the watchdog recorded. It polls while open so a hang becomes visible instead
// of a mystery, and offers a one-click engine reset to recover without
// restarting the app. The traffic-light monitor, engine badges, status polling,
// and reset logic are shared with the memory widget (see ActivityShared).
export const ActivityModal: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  const { status, err, beat, refresh } = useActivityStatus(true);
  // a floating, draggable, resizable, always-on-top window -- watch runs
  // while working underneath (no backdrop), resize from the corner
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag({
    x: Math.max(20, window.innerWidth - 760),
    y: 64,
  });
  const { resetEngines, resetting, resetMsg, armed } = useEngineReset(refresh);

  const ops = status?.operations || [];
  const stall = status?.last_stall || null;
  // Cancel one in-flight operation by its run id (foreground run / bg op),
  // then refresh so the row clears as soon as the engine unwinds. Loads are
  // cancelled from their tray card; restore has no id and shows no control.
  const cancelOp = (id: string) => {
    // .519: cancel END TO END -- abort the surface's in-flight fetch (via
    // the run registry) AND interrupt the backend. Before this, the modal
    // only poked the backend; a mid-send abort then surfaced as a red
    // "Failed to fetch" on the run's own surface.
    cancelById(id);
    refresh();
  };

  return (
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className={
        "stat-win win-float" +
        (dragging ? " dragging" : "") +
        (settled ? " settle" : "")
      }
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Activity"
    >
      <div
        className="stat-win-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <Icon.Chart size={14} />
        <span className="fx-title">Activity</span>
        <span className="spacer" />
        <button
          className="btn sm ghost"
          title="Close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>
      <div className="stat-win-body">
      {err ? (
        <div className="error-box">Can’t read activity: {err}</div>
      ) : !status ? (
        <div className="faint">
          <span className="spin" /> loading…
        </div>
      ) : (
        <div className="act-wrap">
          <ActivityMonitor status={status} beat={beat} />


          {resetMsg && <div className="act-note">{resetMsg}</div>}

          {stall && (
            <div className="act-stall">
              <b>A stall was detected.</b> “{stall.kind}
              {stall.target ? ` · ${stall.target}` : ""}” went{" "}
              {Math.round(stall.idle_s)}s without progress. The stack trace was
              written to the watchdog log
              {status.stall_log ? (
                <>
                  {" "}
                  at <code>{status.stall_log}</code>
                </>
              ) : null}
              .
            </div>
          )}

          {(() => {
            const qops = ops.filter((o) => o.surface);
            if (!qops.length) return null;
            const order = ["ide", "journal", "node"];
            return (
              <>
                <div className="act-section-label">
                  Running queries ({qops.length})
                </div>
                {order
                  .filter((sf) => qops.some((o) => o.surface === sf))
                  .map((sf) => (
                    <div key={sf} className="act-qgroup">
                      <div className="act-qsurface">{sf}</div>
                      {qops
                        .filter((o) => o.surface === sf)
                        .map((o) => (
                          <div key={o.id} className="act-qrow">
                            <span className="mono">
                              {o.label || o.target || o.id}
                            </span>
                            <span className="dim">
                              {o.elapsed_s.toFixed(1)}s
                            </span>
                            {o.cancellable && (
                              <button
                                className="btn ghost icon"
                                title="Stop this query"
                                onClick={() => cancelOp(o.id)}
                              >
                                <Icon.X size={13} />
                              </button>
                            )}
                          </div>
                        ))}
                    </div>
                  ))}
              </>
            );
          })()}
          <div className="act-section-label">
            Active operations{ops.length ? ` (${ops.length})` : ""}
          </div>
          {!ops.length ? (
            <div className="faint">
              Nothing is running right now. Loads, queries, and flow runs will
              appear here while they work, with rows processed and time since
              their last progress.
            </div>
          ) : (
            <table className="act-ops">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Engine</th>
                  <th className="num">Rows</th>
                  <th className="num">Elapsed</th>
                  <th className="num">Since progress</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => {
                  const stuck = o.idle_s >= STALL_HINT_S;
                  return (
                    <tr key={o.id} className={stuck ? "stuck" : ""}>
                      <td>
                        <span className={"act-kind k-" + o.kind}>{o.kind}</span>
                        {o.target ? (
                          <span className="act-target"> {o.target}</span>
                        ) : null}
                        {o.cancellable ? (
                          <button
                            className="btn ghost icon"
                            style={{ marginLeft: 6 }}
                            title="Cancel this operation"
                            onClick={() => cancelOp(o.id)}
                          >
                            <Icon.X size={13} />
                          </button>
                        ) : null}
                      </td>
                      <td className="dim">{o.engine || "—"}</td>
                      <td className="num">{formatCount(o.rows)}</td>
                      <td className="num dim">{o.elapsed_s.toFixed(0)}s</td>
                      <td className={"num" + (stuck ? " warn" : " dim")}>
                        {o.idle_s.toFixed(0)}s
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="act-section-label" style={{ marginTop: 12 }}>
            Server
          </div>
          <ServerStatus embedded />
        </div>
      )}
      </div>
      <div className="stat-win-foot">
        <span className="dim" style={{ fontSize: 12 }}>
          {status
            ? `${status.threads} background thread${
                status.threads === 1 ? "" : "s"
              }`
            : "…"}
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={refresh}>
          Refresh
        </button>
        <button
          className="btn sm danger"
          onClick={resetEngines}
          disabled={resetting}
        >
          {resetting
            ? "Nuking…"
            : armed
              ? "Click again to confirm"
              : "Reset server"}
        </button>
      </div>
    </div>
  );
};
