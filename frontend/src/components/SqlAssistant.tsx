import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AssistantStatus } from "../lib/types";
import { Icon } from "./Icon";
import { useWinDrag } from "./ActivityShared";

type ChatRole = "user" | "assistant" | "system";

interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  sql?: string;
  error?: boolean;
}

function uid() {
  return (
    "a-" +
    (typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : Math.random().toString(36).slice(2))
  );
}

/**
 * Bottom-right SQL assistant chat (beta).
 *
 * Talks to /api/assistant/* which gates on DuckDB idle and an optional
 * offline llama.cpp pack (Qwen2.5-Coder-1.5B). Inserts SQL into the IDE via
 * parent callbacks — does not touch load/join/flatten paths.
 */
export const SqlAssistant: React.FC<{
  dialect: string;
  onInsertSql: (sql: string) => void;
  onLoadSql: (sql: string) => void;
  onSwitchIde?: () => void;
}> = ({ dialect, onInsertSql, onLoadSql, onSwitchIde }) => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      id: "welcome",
      role: "system",
      text:
        "Ask how to query your loaded tables. I write DuckDB SQL or SparkSQL " +
        "and can insert it into the IDE. I only run while DuckDB is idle.",
    },
  ]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag({
    x: Math.max(20, window.innerWidth - 420),
    y: Math.max(40, window.innerHeight - 520),
  });

  const refreshStatus = async () => {
    try {
      const st = await api.assistantStatus();
      setStatus(st);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const iv = window.setInterval(() => void refreshStatus(), 2500);
    return () => window.clearInterval(iv);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, open, busy]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { id: uid(), role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await api.assistantChat(q, dialect);
      if (!res.ok) {
        setMsgs((m) => [
          ...m,
          {
            id: uid(),
            role: "assistant",
            text: res.error || "Assistant unavailable.",
            error: true,
          },
        ]);
        if (res.status) setStatus(res.status);
        return;
      }
      setMsgs((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: res.reply || "(no reply)",
          sql: res.sql || undefined,
        },
      ]);
      if (res.status) setStatus(res.status);
    } catch (e: any) {
      setMsgs((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: e?.message || String(e),
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
      void refreshStatus();
    }
  };

  const cancel = async () => {
    try {
      await api.assistantCancel();
    } catch {
      /* ignore */
    }
  };

  const packHint =
    status && !status.pack_ok
      ? status.hint || "Assistant pack not installed (see assistant/README.txt)."
      : status?.refuse_low_memory
        ? "Not enough free RAM for the local model right now."
        : status?.duckdb_busy
          ? "DuckDB is busy — finish or cancel the current job, then ask again."
          : null;

  return (
    <>
      <button
        type="button"
        className={"sql-asst-fab" + (open ? " open" : "")}
        title="SQL assistant (local)"
        aria-label="Open SQL assistant"
        data-testid="sql-assistant-fab"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.MessageCircle size={20} />
      </button>

      {open && (
        <div
          ref={winRef as React.RefObject<HTMLDivElement>}
          className={
            "sql-asst-win win-float" +
            (dragging ? " dragging" : "") +
            (settled ? " settle" : "")
          }
          style={{ left: pos.x, top: pos.y }}
          role="dialog"
          aria-label="SQL assistant"
          data-testid="sql-assistant-panel"
        >
          <div
            className="sql-asst-head"
            onMouseDown={startDrag}
            title="Drag to move"
          >
            <Icon.MessageCircle size={14} />
            <span className="fx-title">SQL assistant</span>
            <span className="sql-asst-badge mono">
              {dialect === "spark" ? "SparkSQL" : "DuckDB"} · 1.5B
            </span>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setOpen(false)}
            >
              <Icon.X size={14} />
            </button>
          </div>

          <div className="sql-asst-status">
            {status?.available
              ? "Local model ready · runs only while DuckDB is idle"
              : packHint || "Checking assistant…"}
          </div>

          <div className="sql-asst-msgs" ref={listRef}>
            {msgs.map((msg) => (
              <div
                key={msg.id}
                className={
                  "sql-asst-msg " +
                  msg.role +
                  (msg.error ? " error" : "")
                }
              >
                <div className="sql-asst-msg-body">{msg.text}</div>
                {msg.sql ? (
                  <div className="sql-asst-sql">
                    <pre className="mono">{msg.sql}</pre>
                    <div className="sql-asst-actions">
                      <button
                        className="btn sm"
                        type="button"
                        onClick={() => {
                          onInsertSql(msg.sql!);
                          onSwitchIde?.();
                        }}
                      >
                        Insert into IDE
                      </button>
                      <button
                        className="btn sm primary"
                        type="button"
                        onClick={() => {
                          onLoadSql(msg.sql!);
                          onSwitchIde?.();
                        }}
                      >
                        Open in tab
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            {busy && (
              <div className="sql-asst-msg assistant">
                <div className="sql-asst-msg-body">
                  <span className="spin" /> Thinking…
                </div>
              </div>
            )}
          </div>

          <div className="sql-asst-foot">
            <textarea
              className="sql-asst-input"
              rows={2}
              value={input}
              placeholder="e.g. count rows by status in orders"
              disabled={busy}
              data-testid="sql-assistant-input"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button className="btn" type="button" onClick={() => void cancel()}>
                Stop
              </button>
            ) : (
              <button
                className="btn primary"
                type="button"
                disabled={!input.trim()}
                data-testid="sql-assistant-send"
                onClick={() => void send()}
              >
                Ask
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
};
