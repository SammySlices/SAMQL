import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { DiagnosticsPanel } from "./DiagnosticsModal";
import { api, saveToDownloads } from "../lib/api";
import type { ErrorLogEntry, TableInfo } from "../lib/types";

// A debuggable history of recent server-side failures, plus a Diagnostics tab
// for the /api/diagnostics runners. Unexpected errors carry a full Python
// traceback; handled (validation) errors and soft application failures
// (query / load / flatten returning {error}) carry status, kind, and request
// detail. The whole log can be exported to a text file.

type ErrorLogTab = "errors" | "diagnostics";

export const ErrorLogModal: React.FC<{
  onClose: () => void;
  tables: TableInfo[];
  initialTab?: ErrorLogTab;
}> = ({ onClose, tables, initialTab = "errors" }) => {
  const [tab, setTab] = useState<ErrorLogTab>(initialTab);
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [fileTail, setFileTail] = useState<{
    path: string;
    size: number;
    text: string;
  } | null>(null);
  const [launcherTail, setLauncherTail] = useState<{
    path: string;
    size: number;
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [version, setVersion] = useState("");

  const load = () => {
    setLoading(true);
    setErr(null);
    api
      .errors()
      .then((d) => {
        setEntries(d.errors || []);
        setFileTail(d.file || null);
        setLauncherTail(d.launcher || null);
        setVersion(d.version || "");
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const clear = () => {
    api
      .clearErrors()
      .then(() => setEntries([]))
      .catch(() => {});
  };

  const exportLog = () => {
    const blocks = entries.map((e) => {
      const head = `[${e.ts}] ${e.status} ${e.kind} — ${e.method} ${e.path}`;
      const msg = `  ${e.error}`;
      const det = e.detail ? `\n  detail: ${e.detail}` : "";
      const tb = e.traceback
        ? `\n${e.traceback.replace(/^/gm, "  ")}`
        : "";
      return `${head}\n${msg}${det}${tb}`;
    });
    const text =
      `SamQL error log (build ${version})\n` +
      `Exported ${new Date().toISOString()}\n` +
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n` +
      "=".repeat(64) +
      "\n\n" +
      blocks.join("\n\n" + "-".repeat(64) + "\n\n") +
      "\n";
    saveToDownloads(`samql-error-log-${Date.now()}.txt`, { text })
      .then((r) => setSavedPath(r.path))
      .catch((e: any) => setSavedPath("save failed: " + (e?.message || e)));
  };

  return (
    <Modal
      title="Error log"
      wide
      onClose={onClose}
      testId="error-log-modal"
      footer={
        tab === "diagnostics" ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <span className="dim" style={{ fontSize: 12 }}>
              {entries.length} recent error
              {entries.length === 1 ? "" : "s"} (query, load, flatten, NodeFlow,
              and server failures)
            </span>
            <span className="spacer" />
            <button className="btn sm" onClick={load}>
              Refresh
            </button>
            <button
              className="btn sm"
              onClick={exportLog}
              disabled={!entries.length}
            >
              Export…
            </button>
            {savedPath && (
              <span className="faint" style={{ fontSize: 11 }}>
                {savedPath}
              </span>
            )}
            <button
              className="btn sm danger"
              onClick={clear}
              disabled={!entries.length}
            >
              Clear
            </button>
          </>
        )
      }
    >
      <div
        className="tabs"
        role="tablist"
        aria-label="Error log sections"
        style={{ borderRadius: 7, marginBottom: 12 }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "errors"}
          data-testid="error-log-errors-tab"
          className={"tab" + (tab === "errors" ? " active" : "")}
          onClick={() => setTab("errors")}
        >
          Errors
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "diagnostics"}
          data-testid="error-log-diagnostics-tab"
          className={"tab" + (tab === "diagnostics" ? " active" : "")}
          onClick={() => setTab("diagnostics")}
        >
          Diagnostics
        </button>
      </div>

      {tab === "diagnostics" ? (
        <DiagnosticsPanel tables={tables} />
      ) : loading ? (
        <div className="faint">
          <span className="spin" /> loading…
        </div>
      ) : err ? (
        <div className="error-box">{err}</div>
      ) : !entries.length ? (
        <div className="faint">
          No errors logged. Failed queries, loads, flatten/shred jobs, NodeFlow
          runs, reconciles, exports, handled API errors, and unexpected server
          failures (with tracebacks) appear here as they happen — useful for
          tracking down a problem and attaching to a bug report.
        </div>
      ) : (
        <div className="errlog">
          {entries.map((e) => {
            const sev = e.status >= 500;
            return (
              <div className={"errlog-row" + (sev ? " sev" : "")} key={e.id}>
                <div
                  className="errlog-head"
                  onClick={() =>
                    setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))
                  }
                >
                  <span className={"errlog-badge" + (sev ? " sev" : "")}>
                    {e.status}
                  </span>
                  <span className="errlog-kind" title={e.kind}>
                    {e.kind}
                  </span>
                  <span className="errlog-ts">{e.ts}</span>
                  <span className="errlog-route">
                    {e.method} {e.path}
                  </span>
                  <span className="errlog-msg" title={e.error}>
                    {e.error}
                  </span>
                  <span className="errlog-exp">{open[e.id] ? "▾" : "▸"}</span>
                </div>
                {open[e.id] && (
                  <div className="errlog-detail">
                    {e.detail && (
                      <div className="errlog-line">
                        <b>detail:</b> {e.detail}
                      </div>
                    )}
                    {e.traceback ? (
                      <pre className="errlog-tb">{e.traceback}</pre>
                    ) : (
                      <div className="errlog-line dim">
                        No Python traceback — application or handled error.
                        Expand the message and detail above for the cause.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {(fileTail?.text || launcherTail?.text) && (
            <div style={{ marginTop: 12 }}>
              {fileTail?.text ? (
                <details>
                  <summary>
                    On-disk log (survives restarts) — {fileTail.path}
                  </summary>
                  <pre className="errlog-file">{fileTail.text}</pre>
                </details>
              ) : null}
              {launcherTail?.text ? (
                <details>
                  <summary>
                    App-window launcher log — {launcherTail.path}
                  </summary>
                  <pre className="errlog-file">{launcherTail.text}</pre>
                </details>
              ) : null}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
