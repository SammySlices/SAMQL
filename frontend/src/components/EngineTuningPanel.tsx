import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

/** Parse DuckDB ``memory_limit`` strings like ``8.0 GiB`` / ``8192MB`` to GB. */
function memoryLimitToGb(limit: string | null | undefined): string {
  if (!limit) return "";
  const n = parseFloat(limit);
  if (!Number.isFinite(n)) return "";
  const lower = limit.toLowerCase();
  if (lower.includes("mi") || lower.includes("mb")) {
    return String(Math.max(1, Math.round(n / 1024) || 1));
  }
  return String(n);
}

/**
 * Live DuckDB memory_limit / threads controls (same ``/api/engine/tuning``
 * pathway previously opened via Settings → Engine tuning prompts).
 */
export const EngineTuningPanel: React.FC<{ onToast: ToastFn }> = ({
  onToast,
}) => {
  const [memoryGb, setMemoryGb] = useState("");
  const [threads, setThreads] = useState("");
  const [liveLimit, setLiveLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // Engine routing preference (persisted server-side). dual = route by table
  // location; duckdb = unpinned flows + table-less queries always use DuckDB.
  const [engineMode, setEngineMode] = useState<"dual" | "duckdb">("dual");
  const [duckdbAvailable, setDuckdbAvailable] = useState(true);
  const [engineModeBusy, setEngineModeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getEngineMode()
      .then((r) => {
        if (cancelled) return;
        setEngineMode(r.engine_mode === "duckdb" ? "duckdb" : "dual");
        setDuckdbAvailable(r.duckdb_available !== false);
      })
      .catch(() => {
        /* leave the control at its default; tuning below still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyEngineMode = async (mode: "dual" | "duckdb") => {
    if (mode === engineMode) return;
    setEngineModeBusy(true);
    try {
      const r = await api.setEngineMode(mode);
      if (r.error) {
        onToast("error", "Engine mode", r.error);
        return;
      }
      setEngineMode(r.engine_mode === "duckdb" ? "duckdb" : "dual");
      setDuckdbAvailable(r.duckdb_available !== false);
      onToast(
        "ok",
        "Engine mode",
        r.engine_mode === "duckdb"
          ? "Always DuckDB (when available)"
          : "Automatic (route by table location)",
      );
    } catch (e: any) {
      onToast("error", "Engine mode", e?.message || String(e));
    } finally {
      setEngineModeBusy(false);
    }
  };

  const applyResponse = useCallback(
    (r: Awaited<ReturnType<typeof api.engineTuning>>) => {
      if (r.busy || r.error) {
        setError(r.error || "The engine is busy.");
        return false;
      }
      setLiveLimit(r.memory_limit ?? null);
      setMemoryGb(memoryLimitToGb(r.memory_limit));
      setThreads(r.threads != null ? String(r.threads) : "");
      setNote(r.note || "");
      setError("");
      return true;
    },
    [],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.engineTuning({});
      if (!applyResponse(r)) {
        onToast("warn", "Engine tuning", r.error);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "Engine tuning", msg);
    } finally {
      setBusy(false);
    }
  }, [applyResponse, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async () => {
    const memRaw = memoryGb.trim();
    const thRaw = threads.trim();
    const mem = memRaw === "" ? undefined : Number.parseFloat(memRaw);
    const th = thRaw === "" ? undefined : Number.parseInt(thRaw, 10);
    if (memRaw !== "" && (!Number.isFinite(mem!) || mem! < 1)) {
      setError("Memory limit must be at least 1 GB");
      return;
    }
    if (thRaw !== "" && (!Number.isFinite(th!) || th! < 1)) {
      setError("Threads must be at least 1");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api.engineTuning({
        memory_gb: mem,
        threads: th,
      });
      if (!applyResponse(r)) {
        onToast("error", "Engine tuning failed", r.error);
        return;
      }
      onToast(
        "ok",
        "Engine tuned",
        `memory_limit ${r.memory_limit} · ${r.threads} threads` +
          (r.note ? ` (${r.note})` : ""),
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "Engine tuning failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    // Discard drafts and reload the live engine settings (no factory-default
    // endpoint — session SET values are the source of truth).
    await refresh();
    onToast("ok", "Engine tuning", "Reloaded current memory / threads");
  };

  return (
    <div data-testid="engine-tuning-panel" className="settings-grid">
      <div
        className="threshold-field"
        style={{ gridColumn: "1 / -1" }}
        title="Which engine runs unpinned flows and table-less queries"
      >
        <span className="threshold-field-head">
          <span>Engine</span>
        </span>
        <div
          className="engine-mode-seg"
          data-testid="engine-mode-control"
          style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
        >
          <button
            type="button"
            className={"btn sm" + (engineMode === "dual" ? " primary" : " ghost")}
            disabled={engineModeBusy || !duckdbAvailable}
            aria-pressed={engineMode === "dual"}
            data-testid="engine-mode-dual"
            onClick={() => void applyEngineMode("dual")}
          >
            Automatic (route by table location)
          </button>
          <button
            type="button"
            className={"btn sm" + (engineMode === "duckdb" ? " primary" : " ghost")}
            disabled={engineModeBusy || !duckdbAvailable}
            aria-pressed={engineMode === "duckdb"}
            data-testid="engine-mode-duckdb"
            onClick={() => void applyEngineMode("duckdb")}
          >
            Always DuckDB (when available)
          </button>
        </div>
        <span className="faint" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
          {duckdbAvailable
            ? "Automatic keeps tables on the engine they live on; Always DuckDB prefers DuckDB for anything unpinned."
            : "DuckDB is not available in this build — engine routing is fixed."}
        </span>
      </div>
      <div className="hint" style={{ marginBottom: 4, gridColumn: "1 / -1" }}>
        Adjust DuckDB&apos;s memory limit and thread count for this session.
        Changes apply immediately when the engine is idle.
        {liveLimit ? (
          <>
            {" "}
            Live limit: <b>{liveLimit}</b>.
          </>
        ) : null}
        {note ? (
          <>
            {" "}
            {note}
          </>
        ) : (
          <>
            {" "}
            Set <code>SAMQL_DUCKDB_MEMORY_GB</code> /{" "}
            <code>SAMQL_DUCKDB_THREADS</code> to persist across restarts.
          </>
        )}
      </div>
      <label className="threshold-field" title="DuckDB memory_limit (GB)">
        <span className="threshold-field-head">
          <span>
            Memory limit
            <span className="faint"> (GB)</span>
          </span>
          <span className="faint" style={{ fontSize: 11 }}>
            1–1024
          </span>
        </span>
        <input
          type="number"
          min={1}
          max={1024}
          step="any"
          value={memoryGb}
          onChange={(e) => setMemoryGb(e.target.value)}
          data-testid="engine-tuning-memory-gb"
          disabled={busy}
        />
        <span className="faint" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
          Working-memory budget for queries and loads in this session.
        </span>
      </label>
      <label className="threshold-field" title="DuckDB threads">
        <span className="threshold-field-head">
          <span>
            Threads
            <span className="faint"> (count)</span>
          </span>
          <span className="faint" style={{ fontSize: 11 }}>
            1–256
          </span>
        </span>
        <input
          type="number"
          min={1}
          max={256}
          step={1}
          value={threads}
          onChange={(e) => setThreads(e.target.value)}
          data-testid="engine-tuning-threads"
          disabled={busy}
        />
        <span className="faint" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
          Parallel worker threads for the DuckDB engine.
        </span>
      </label>
      {error ? (
        <div className="error" style={{ gridColumn: "1 / -1" }}>
          {error}
        </div>
      ) : null}
      <div
        className="flow-cache-actions"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
          gridColumn: "1 / -1",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => void reset()}
          data-testid="engine-tuning-reset"
        >
          Reset
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void refresh()}
          data-testid="engine-tuning-refresh"
        >
          Refresh
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => void apply()}
          data-testid="engine-tuning-apply"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
};
