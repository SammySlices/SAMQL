import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  type LoadThresholdField,
  type LoadThresholdsInfo,
} from "../lib/api";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

/** Field order for the Load thresholds tab (matches backend FIELDS). */
const FIELD_ORDER = [
  "ondisk_mb",
  "ondisk_hard_mb",
  "json_ondisk_mb",
  "json_stream_mb",
  "json_stream_flatten_mb",
  "json_object_mb",
  "upload_mb",
  "filecache_gb",
] as const;

const sourceLabel = (src: string) => {
  if (src === "override") return "saved";
  if (src === "env") return "env";
  return "default";
};

/** Editable load-file size thresholds (Parquet / JSON / upload / cache). */
export const LoadThresholdsPanel: React.FC<{
  onToast: ToastFn;
}> = ({ onToast }) => {
  const [fields, setFields] = useState<Record<string, LoadThresholdField>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyInfo = useCallback((info: LoadThresholdsInfo) => {
    const next = info.thresholds || {};
    setFields(next);
    const d: Record<string, string> = {};
    for (const key of FIELD_ORDER) {
      const f = next[key];
      if (f) d[key] = String(f.value);
    }
    setDrafts(d);
    setError("");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const info = await api.loadThresholdsInfo();
      applyInfo(info);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [applyInfo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async () => {
    const thresholds: Record<string, number> = {};
    for (const key of FIELD_ORDER) {
      const meta = fields[key];
      const raw = drafts[key];
      if (!meta || raw == null || raw === "") continue;
      const n =
        meta.kind === "int"
          ? Number.parseInt(raw, 10)
          : Number.parseFloat(raw);
      if (!Number.isFinite(n)) {
        setError(`${meta.label}: enter a valid number`);
        return;
      }
      if (n < meta.min || n > meta.max) {
        setError(
          `${meta.label}: must be between ${meta.min} and ${meta.max} ${meta.unit}`,
        );
        return;
      }
      thresholds[key] = n;
    }
    setBusy(true);
    setError("");
    try {
      const info = await api.loadThresholdsConfigure({ thresholds });
      applyInfo(info);
      onToast("ok", "Load thresholds saved", "Applied for this session and later runs");
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "Load thresholds", msg);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError("");
    try {
      const info = await api.loadThresholdsConfigure({ reset: true });
      applyInfo(info);
      onToast(
        "ok",
        "Load thresholds reset",
        "Using environment variables and built-in defaults",
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "Load thresholds", msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="load-thresholds-panel" className="settings-grid">
      <div className="hint" style={{ marginBottom: 4, gridColumn: "1 / -1" }}>
        Controls when large files convert to on-disk Parquet (and related
        JSON / upload limits). Changes apply immediately and persist across
        restarts. Set a field to 0 where noted to disable that gate.
      </div>
      {FIELD_ORDER.map((key) => {
        const meta = fields[key];
        if (!meta) return null;
        return (
          <label key={key} title={meta.help}>
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>
                {meta.label}
                <span className="faint"> ({meta.unit})</span>
              </span>
              <span className="faint" style={{ fontSize: 11 }}>
                {sourceLabel(meta.source)}
                {meta.zero_means ? ` · 0 = ${meta.zero_means}` : ""}
              </span>
            </span>
            <input
              type="number"
              min={meta.min}
              max={meta.max}
              step={meta.kind === "int" ? 1 : "any"}
              value={drafts[key] ?? ""}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
              }
              data-testid={`load-threshold-${key}`}
            />
            <span className="faint" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
              {meta.help}
            </span>
          </label>
        );
      })}
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
          data-testid="load-thresholds-reset"
        >
          Reset to defaults
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => void apply()}
          data-testid="load-thresholds-apply"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
};
