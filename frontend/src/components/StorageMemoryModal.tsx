import React, { useState } from "react";
import { api } from "../lib/api";
import type { MemInfo } from "../lib/types";
import { Modal } from "./Modal";
import { FlowCachePanel } from "./FlowCacheModal";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

type StorageReport = Awaited<ReturnType<typeof api.storageReport>>;

export type StorageMemoryTab = "storage" | "cache";

const gb = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : Math.round(n / 1e6) + " MB";

export const StorageMemoryModal: React.FC<{
  busy: boolean;
  report: StorageReport | null | undefined;
  mem: MemInfo | null;
  initialTab?: StorageMemoryTab;
  onClose: () => void;
  onToast: ToastFn;
  onRefreshReport: () => void;
  onMemFreed: (mem: MemInfo) => void;
}> = ({
  busy,
  report,
  mem,
  initialTab = "storage",
  onClose,
  onToast,
  onRefreshReport,
  onMemFreed,
}) => {
  const [tab, setTab] = useState<StorageMemoryTab>(initialTab);

  return (
    <Modal
      title="Storage & memory"
      onClose={onClose}
      wide={tab === "cache"}
      testId="storage-memory-modal"
    >
      <div
        className="storage-memory-tabs"
        role="tablist"
        aria-label="Storage and memory sections"
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 12,
          borderBottom: "1px solid var(--border, #ddd)",
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "storage"}
          data-testid="storage-tab"
          className={"btn sm" + (tab === "storage" ? " primary" : " ghost")}
          onClick={() => setTab("storage")}
        >
          Storage
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cache"}
          data-testid="flow-cache-tab"
          className={"btn sm" + (tab === "cache" ? " primary" : " ghost")}
          onClick={() => setTab("cache")}
          title="Inspect, resize, or clear the incremental NodeFlow cache"
        >
          NodeFlow cache
        </button>
      </div>

      {tab === "cache" ? (
        <FlowCachePanel embedded onToast={onToast} />
      ) : busy || !report ? (
        <div className="faint">
          <span className="spin" /> measuring…
        </div>
      ) : (
        <div className="storage-panel" data-testid="storage-panel">
          <div className="hint" style={{ marginBottom: 8 }}>
            Removed automatically: this instance&apos;s temp on close; dead
            instances, zombies and installer leftovers on every open. The
            conversion cache persists on purpose (it&apos;s why reloads are
            instant) inside its budget.
          </div>
          <div className="storage-row">
            <span>
              Engine memory
              {mem?.duckdb_mb != null
                ? ` · DuckDB ${Math.round(mem.duckdb_mb)} MB`
                : ""}
              {mem?.cached_results != null
                ? ` · ${mem.cached_results} cached results`
                : ""}
            </span>
            <b>
              {mem?.rss_mb != null ? Math.round(mem.rss_mb) + " MB" : "—"}
            </b>
          </div>
          <div className="storage-row">
            <span>This session (results, uploads, engine spill)</span>
            <b>{gb(report.instance.bytes)}</b>
          </div>
          <div className="storage-row">
            <span>
              Other instances ({report.other_instances.count},{" "}
              {report.other_instances.dead} dead)
            </span>
            <b>{gb(report.other_instances.bytes)}</b>
          </div>
          <div className="storage-row">
            <span>
              Installer leftovers (_MEI ×{report.mei_orphans.count})
            </span>
            <b>{gb(report.mei_orphans.bytes)}</b>
          </div>
          {(report as any).mei_live_launcher?.present ? (
            <div className="storage-row">
              <span>
                Held by the running launcher (_MEI — frees on exit)
              </span>
              <b>{gb((report as any).mei_live_launcher.bytes)}</b>
            </div>
          ) : null}
          {(report as any).webview_cache ? (
            <div className="storage-row">
              <span>App-window cache (Chromium)</span>
              <b>{gb((report as any).webview_cache.bytes)}</b>
            </div>
          ) : null}
          <div className="storage-row">
            <span>
              Conversion cache ({report.filecache.count} file
              {report.filecache.count === 1 ? "" : "s"}, budget{" "}
              {report.filecache.budget_gb.toFixed(0)} GB)
            </span>
            <b>{gb(report.filecache.bytes)}</b>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 12,
            }}
          >
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  const r = await api.storageClean({ orphans: true });
                  if ((r as any).note)
                    onToast(
                      r.freed.orphans ? "ok" : "warn",
                      r.freed.orphans
                        ? gb(r.freed.orphans) + " reclaimed"
                        : "Nothing reclaimed",
                      (r as any).note,
                    );
                  else
                    onToast(
                      "ok",
                      "Cleaned up",
                      gb(r.freed.orphans) + " reclaimed",
                    );
                  onRefreshReport();
                } catch (e: any) {
                  onToast("error", "Cleanup failed", e.message);
                }
              }}
            >
              Clean orphans &amp; leftovers
            </button>
            <button
              className="btn sm ghost"
              title="Every cached conversion is deleted; the next load of each file converts again (slower once, then cached)."
              onClick={async () => {
                try {
                  const r = await api.storageClean({ filecache: true });
                  onToast(
                    "ok",
                    "Conversion cache cleared",
                    gb(r.freed.filecache) + " reclaimed",
                  );
                  onRefreshReport();
                } catch (e: any) {
                  onToast("error", "Cleanup failed", e.message);
                }
              }}
            >
              Clear conversion cache
            </button>
            <button
              className="btn sm ghost"
              title="Clears the native window's Chromium cache dirs (Cache, Code Cache, GPU/shader caches). Cookies, saved logins and local storage are untouched. Files the open window holds clear next time."
              onClick={async () => {
                try {
                  const r = await api.storageClean({
                    webview_cache: true,
                  });
                  onToast(
                    "ok",
                    "Window cache cleared",
                    gb(r.freed.webview_cache) +
                      " reclaimed" +
                      (r.note ? " — " + r.note : ""),
                  );
                  onRefreshReport();
                } catch (e: any) {
                  onToast("error", "Cleanup failed", e.message);
                }
              }}
            >
              Clear window cache
            </button>
            <button
              className="btn sm ghost"
              title="Release unused engine memory and drop cold cached results."
              onClick={async () => {
                try {
                  const m = await api.freeMemory();
                  onToast(
                    "ok",
                    "Memory & cache freed",
                    m.freed_mb != null
                      ? `Released ~${m.freed_mb} MB`
                      : undefined,
                  );
                  onMemFreed(m);
                } catch (e: any) {
                  onToast("error", "Free memory failed", e.message);
                }
              }}
            >
              Free unused memory
            </button>
            <button
              className="btn sm ghost"
              title="Remove stale temp from previous runs; this session's usage is shown above."
              onClick={async () => {
                try {
                  const r = await api.sweepTemp();
                  onToast(
                    "ok",
                    "Temp files cleared",
                    r.removed > 0
                      ? `Removed ${r.removed} stale folder${
                          r.removed === 1 ? "" : "s"
                        }.`
                      : "No stale temp to remove.",
                  );
                  onRefreshReport();
                } catch (e: any) {
                  onToast("error", "Clear temp files failed", e.message);
                }
              }}
            >
              Clear temp files
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
