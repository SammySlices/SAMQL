import React, { useEffect, useRef, useState } from "react";
import { api, copyText } from "../lib/api";
import type { AssistantStatus } from "../lib/types";
import { Icon } from "./Icon";
import { useWinDrag } from "./ActivityShared";

const WELCOME_INSERT =
  "Ask how to query your loaded tables. I write DuckDB SQL or SparkSQL " +
  "and can insert it into the IDE. I only run while DuckDB is idle.";

const WELCOME_COPY =
  "Ask how to query your loaded tables. I write DuckDB SQL or SparkSQL — " +
  "copy it and paste into a Journal cell. I only run while DuckDB is idle.";

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

/** Compact badge from status.model_name (size hint when present). */
export function assistantModelBadge(modelName?: string | null): string {
  if (!modelName?.trim()) return "";
  const base = modelName.replace(/\.gguf$/i, "").trim();
  if (!base) return "";
  const size = base.match(/(\d+(?:\.\d+)?)[Bb](?![a-zA-Z])/);
  if (size) return ` · ${size[1]}B`;
  return ` · ${base.length > 28 ? `${base.slice(0, 28)}…` : base}`;
}

/**
 * Detachable SQL assistant chat panel (beta).
 *
 * Launchers live in the IDE toolbar and Journal chrome; this component owns
 * the floating draggable panel only. Talks to /api/assistant/* which gates
 * on DuckDB idle and either a local llama.cpp pack or a configured
 * OpenAI-compatible API. When allowInsert is true, inserts/loads SQL into
 * the IDE via parent callbacks. From Journal, allowInsert is false so only
 * Copy SQL is offered (multiple Journal IDEs may be open). Does not touch
 * load/join/flatten paths.
 */
export const SqlAssistant: React.FC<{
  dialect: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertSql: (sql: string) => void;
  onLoadSql: (sql: string) => void;
  onSwitchIde?: () => void;
  /** When false (Journal entry), only Copy SQL — no Insert / Open in tab. */
  allowInsert?: boolean;
  onToast?: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
}> = ({
  dialect,
  open,
  onOpenChange,
  onInsertSql,
  onLoadSql,
  onSwitchIde,
  allowInsert = true,
  onToast,
}) => {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      id: "welcome",
      role: "system",
      text: allowInsert ? WELCOME_INSERT : WELCOME_COPY,
    },
  ]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag({
    x: Math.max(20, window.innerWidth - 420),
    y: Math.max(40, window.innerHeight - 520),
  });

  useEffect(() => {
    setMsgs((m) =>
      m.map((msg) =>
        msg.id === "welcome"
          ? {
              ...msg,
              text: allowInsert ? WELCOME_INSERT : WELCOME_COPY,
            }
          : msg,
      ),
    );
  }, [allowInsert]);

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

  const copySql = (msgId: string, sql: string) => {
    void copyText(sql)
      .then(() => {
        onToast?.("ok", "Copied", "SQL copied to clipboard");
        setCopiedId(msgId);
        if (copiedTimer.current != null)
          window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => {
          setCopiedId(null);
          copiedTimer.current = null;
        }, 900);
      })
      .catch(() => onToast?.("error", "Copy failed"));
  };

  const isApi = status?.mode === "api";
  const packHint =
    status?.duckdb_busy
      ? "DuckDB is busy — finish or cancel the current job, then ask again."
      : isApi && !status?.available
        ? status?.hint ||
          "Configure an API base URL under Settings → SQL assistant."
        : !isApi && status && !status.pack_ok
          ? status.hint ||
            "Assistant pack not installed (see assistant/README.txt)."
          : status?.refuse_low_memory
            ? (() => {
                const m = status.memory || {};
                const need = m.model_need_mb;
                const total = m.memory_total_mb;
                const avail = m.memory_available_mb;
                if (need != null && total != null) {
                  return (
                    `Not enough RAM for this model (~${Math.round(Number(need))} MiB needed; ` +
                    `${Math.round(Number(total))} MiB total` +
                    (avail != null
                      ? `, ${Math.round(Number(avail))} MiB free`
                      : "") +
                    "). SamQL will shrink DuckDB's budget when possible — try again, or pick a smaller GGUF."
                  );
                }
                return "Not enough RAM for the local model right now. Try a smaller GGUF or free DuckDB memory.";
              })()
            : null;

  if (!open) return null;

  return (
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
          {dialect === "spark" ? "SparkSQL" : "DuckDB"}
          {assistantModelBadge(status?.model_name)}
        </span>
        <span className="spacer" />
        <button
          className="btn sm ghost"
          title="Close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onOpenChange(false)}
        >
          <Icon.X size={14} />
        </button>
      </div>

      <div className="sql-asst-status">
        {status?.available
          ? isApi
            ? "API ready · runs only while DuckDB is idle"
            : "Local model ready · runs only while DuckDB is idle"
          : packHint || "Checking assistant…"}
      </div>

      <div className="sql-asst-msgs" ref={listRef}>
        {msgs.map((msg) => (
          <div
            key={msg.id}
            className={
              "sql-asst-msg " + msg.role + (msg.error ? " error" : "")
            }
          >
            <div className="sql-asst-msg-body">{msg.text}</div>
            {msg.sql ? (
              <div className="sql-asst-sql">
                <pre className="mono">{msg.sql}</pre>
                <div className="sql-asst-actions">
                  {allowInsert ? (
                    <>
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
                    </>
                  ) : (
                    <button
                      className="btn sm primary"
                      type="button"
                      data-testid="sql-assistant-copy"
                      title="Copy SQL to clipboard"
                      onClick={() => copySql(msg.id, msg.sql!)}
                    >
                      {copiedId === msg.id ? (
                        <>
                          <Icon.Check size={12} /> Copied
                        </>
                      ) : (
                        <>
                          <Icon.Copy size={12} /> Copy SQL
                        </>
                      )}
                    </button>
                  )}
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
  );
};
