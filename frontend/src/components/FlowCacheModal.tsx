import React, { useCallback, useEffect, useState } from "react";
import { api, type FlowCacheInfo } from "../lib/api";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
}

const pct = (v: number | null) =>
  v == null ? "—" : `${Math.round(v * 1000) / 10}%`;

export const FlowCacheModal: React.FC<Props> = ({ onClose, onToast }) => {
  const [info, setInfo] = useState<FlowCacheInfo | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [maxEntries, setMaxEntries] = useState("32");
  const [maxMb, setMaxMb] = useState("1024");
  const [adaptive, setAdaptive] = useState(true);
  const [parallel, setParallel] = useState(true);
  const [parallelWorkers, setParallelWorkers] = useState("2");
  const [persistentEnabled, setPersistentEnabled] = useState(true);
  const [persistentMaxMb, setPersistentMaxMb] = useState("4096");
  const [persistentDays, setPersistentDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyInfo = useCallback((next: FlowCacheInfo) => {
    setInfo(next);
    setEnabled(!!next.enabled);
    setMaxEntries(String(next.max ?? 0));
    setMaxMb(String(Math.round(next.configured_mb_max ?? next.mb_max ?? 0)));
    setAdaptive(!!next.adaptive_resources);
    setParallel(!!next.parallel_nodeflows);
    setParallelWorkers(String(next.parallel_workers_configured ?? 1));
    setPersistentEnabled(!!next.persistent_enabled);
    setPersistentMaxMb(String(Math.round(next.persistent_configured_mb_max ?? next.persistent?.mb_max ?? 0)));
    setPersistentDays(String(next.persistent?.max_age_days ?? 14));
    setError(next.error || "");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.flowCacheInfo();
      applyInfo(next);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [applyInfo]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(id);
  }, [refresh]);

  const update = async (opts: Parameters<typeof api.flowCacheConfigure>[0]) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.flowCacheConfigure(opts);
      applyInfo(next);
      return next;
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "Flow cache", msg);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const entries = Number.parseInt(maxEntries, 10);
    const mb = Number.parseInt(maxMb, 10);
    const workers = Number.parseInt(parallelWorkers, 10);
    const persistMb = Number.parseInt(persistentMaxMb, 10);
    const days = Number.parseInt(persistentDays, 10);
    if (!Number.isFinite(entries) || entries < 0 || !Number.isFinite(mb) || mb < 0 ||
        !Number.isFinite(workers) || workers < 1 || !Number.isFinite(persistMb) || persistMb < 0 ||
        !Number.isFinite(days) || days < 0) {
      setError("Cache limits and retention must be non-negative integers; workers must be at least one.");
      return;
    }
    const next = await update({
      enabled,
      max_entries: entries,
      max_mb: mb,
      adaptive_resources: adaptive,
      parallel_nodeflows: parallel,
      parallel_workers: workers,
      persistent_enabled: persistentEnabled,
      persistent_max_mb: persistMb,
      persistent_days: days,
    });
    if (next) onToast("ok", "Flow cache updated", `${next.size} entries · ${next.mb} MB in use`);
  };

  const clear = async (resetStats = false) => {
    const next = await update({ clear: true, reset_stats: resetStats });
    if (next)
      onToast(
        "ok",
        resetStats ? "Flow cache and counters cleared" : "Flow cache cleared",
        `${next.cleared ?? 0} cached table${next.cleared === 1 ? "" : "s"} removed`,
      );
  };

  const clearPersistent = async () => {
    const next = await update({ clear_persistent: true });
    if (next)
      onToast(
        "ok",
        "Persistent NodeFlow cache cleared",
        `${next.persistent_cleared ?? 0} file${next.persistent_cleared === 1 ? "" : "s"} removed`,
      );
  };

  const footer = (
    <>
      <button className="btn" disabled={busy} onClick={() => void clear(false)}>
        Clear memory cache
      </button>
      <button className="btn" disabled={busy} onClick={() => void clearPersistent()}>
        Clear persistent cache
      </button>
      <button className="btn" disabled={busy} onClick={() => void clear(true)}>
        Reset counters
      </button>
      <span className="spacer" />
      <button className="btn" onClick={onClose}>Close</button>
      <button className="btn primary" disabled={busy} onClick={() => void apply()}>
        {busy ? "Applying…" : "Apply"}
      </button>
    </>
  );

  return (
    <Modal title="NodeFlow cache" onClose={onClose} footer={footer} wide>
      <div data-testid="flow-cache-modal" className="settings-grid">
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Reuse unchanged intermediate node results
        </label>
        <label>
          Maximum entries
          <input
            type="number"
            min={0}
            max={10000}
            value={maxEntries}
            onChange={(e) => setMaxEntries(e.target.value)}
          />
        </label>
        <label>
          Memory budget ceiling (MB)
          <input
            type="number"
            min={0}
            max={1048576}
            value={maxMb}
            onChange={(e) => setMaxMb(e.target.value)}
          />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
          Adapt cache and worker budgets to available RAM and temp-disk space
        </label>
        <label className="check-row">
          <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
          Run independent NodeFlow branches in parallel on DuckDB
        </label>
        <label>
          Parallel branch worker ceiling
          <input type="number" min={1} max={16} value={parallelWorkers}
            onChange={(e) => setParallelWorkers(e.target.value)} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={persistentEnabled}
            onChange={(e) => setPersistentEnabled(e.target.checked)} />
          Reuse safe, deterministic intermediates after restart
        </label>
        <label>
          Persistent cache ceiling (MB)
          <input type="number" min={0} max={1048576} value={persistentMaxMb}
            onChange={(e) => setPersistentMaxMb(e.target.value)} />
        </label>
        <label>
          Persistent retention (days; 0 = no age expiry)
          <input type="number" min={0} max={3650} value={persistentDays}
            onChange={(e) => setPersistentDays(e.target.value)} />
        </label>
      </div>

      {error && <div className="inline-error">{error}</div>}

      {info && (
        <>
          <div className="diag-cards flow-cache-cards">
            <div><b>{info.size}</b><span>entries</span></div>
            <div><b>{info.mb.toLocaleString()} MB</b><span>of {info.mb_max.toLocaleString()} MB</span></div>
            <div><b>{pct(info.hit_rate)}</b><span>hit rate</span></div>
            <div><b>{info.hits.toLocaleString()}</b><span>hits</span></div>
            <div><b>{info.misses.toLocaleString()}</b><span>misses</span></div>
            <div><b>{info.evictions.toLocaleString()}</b><span>evictions</span></div>
            <div><b>{info.oversized.toLocaleString()}</b><span>oversized skipped</span></div>
            <div><b>{info.stale.toLocaleString()}</b><span>stale removed</span></div>
            <div><b>{info.parallel_workers_effective}</b><span>effective branch workers</span></div>
            <div><b>{info.resource_budget.engine_memory_mb.toLocaleString()} MB</b><span>effective DuckDB ceiling</span></div>
            <div><b>{info.persistent.mb.toLocaleString()} MB</b><span>persistent cache</span></div>
            <div><b>{info.persistent.hits.toLocaleString()}</b><span>restart-cache hits</span></div>
            <div><b>{info.persistent.oversized.toLocaleString()}</b><span>persistent oversized skipped</span></div>
            <div><b>{info.persistent.skips.toLocaleString()}</b><span>unsafe graphs kept session-only</span></div>
            <div><b>{info.persistent.errors.toLocaleString()}</b><span>persistent cache errors</span></div>
            <div><b>{info.persistent.pinned.toLocaleString()}</b><span>persistent reads pinned</span></div>
          </div>

          <p className="muted">
            Resource pressure: <b>{info.resource_budget.pressure}</b> · available memory {info.resource_budget.memory_available_mb.toLocaleString()} MB · temp disk free {info.resource_budget.disk_free_gb.toLocaleString()} GB. Effective DuckDB ceiling: {info.resource_budget.engine_memory_mb.toLocaleString()} MB; in-memory cache: {info.resource_budget.flow_cache_mb.toLocaleString()} MB; persistent cache: {info.resource_budget.persistent_cache_mb.toLocaleString()} MB.
          </p>

          <h3>Largest cached intermediates</h3>
          {info.largest.length === 0 ? (
            <p className="muted">No intermediate tables are currently cached.</p>
          ) : (
            <div className="table-wrap">
              <table className="plain-table">
                <thead>
                  <tr><th>Table</th><th>Engine</th><th>Fingerprint</th><th>Approx. size</th></tr>
                </thead>
                <tbody>
                  {info.largest.map((entry) => (
                    <tr key={`${entry.engine}:${entry.table}`}>
                      <td><code>{entry.table}</code></td>
                      <td>{entry.engine}</td>
                      <td><code>{entry.fingerprint}</code></td>
                      <td>{entry.mb.toLocaleString()} MB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            Limits persist in SamQL settings. Adaptive mode treats them as ceilings.
            Environment variables <code>SAMQL_FLOW_CACHE_MB</code>, <code>SAMQL_PERSISTENT_FLOW_CACHE_MB</code>, and <code>SAMQL_NODEFLOW_WORKERS</code> supply initial defaults.
          </p>
        </>
      )}
    </Modal>
  );
};
