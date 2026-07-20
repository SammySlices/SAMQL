import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type {
  EngineKind,
  HistoryEntry,
  SavedQuery,
  TableInfo,
  WorkflowSummary,
} from "../lib/types";
import type { ToastFn } from "./appTypes";

/** Stable catalog key — engine prefix matches TableInfo.engine. */
type TableCatalogKey = `${EngineKind}:${string}`;

/**
 * Focused-window catalog / origin poll interval (ms).
 * Light 3s tick while the window is visible — not aggressive.
 * Skips when a prior /api/tables request is still in flight; backs off
 * on failure so a busy server is not hammered.
 */
export const CATALOG_ORIGIN_POLL_MS = 3000;

/** True when two catalog snapshots are equivalent for sidebar render. */
export function tablesCatalogEqual(
  prev: TableInfo[],
  next: TableInfo[],
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (
      a.engine !== b.engine ||
      a.name !== b.name ||
      a.row_count !== b.row_count ||
      (a.source || "") !== (b.source || "") ||
      !!a.source_changed !== !!b.source_changed ||
      (a.source_reload_error || "") !== (b.source_reload_error || "")
    ) {
      return false;
    }
    const ac = a.columns || [];
    const bc = b.columns || [];
    if (ac.length !== bc.length) return false;
    for (let j = 0; j < ac.length; j += 1) {
      const ca = ac[j] as { name?: string; type?: string } | string;
      const cb = bc[j] as { name?: string; type?: string } | string;
      const an = typeof ca === "string" ? ca : ca?.name;
      const bn = typeof cb === "string" ? cb : cb?.name;
      const at = typeof ca === "string" ? "" : ca?.type || "";
      const bt = typeof cb === "string" ? "" : cb?.type || "";
      if (an !== bn || at !== bt) return false;
    }
  }
  return true;
}

/** Tables that left source_changed without an error → auto-reload succeeded. */
export function detectFileRefreshedToasts(
  prev: TableInfo[],
  next: TableInfo[],
): Array<{ engine: string; name: string }> {
  if (!prev.length || !next.length) return [];
  const prevByKey = new Map<TableCatalogKey, TableInfo>(
    prev.map((t) => [`${t.engine}:${t.name}` as TableCatalogKey, t]),
  );
  const out: Array<{ engine: string; name: string }> = [];
  for (const t of next) {
    const key = `${t.engine}:${t.name}` as TableCatalogKey;
    const was = prevByKey.get(key);
    if (!was) continue;
    if (
      was.source_changed &&
      !t.source_changed &&
      !t.source_reload_error &&
      !was.source_reload_error
    ) {
      out.push({ engine: t.engine, name: t.name });
    }
  }
  return out;
}

/**
 * Owns the sidebar/catalog collections and their latest-response-wins refresh
 * rails. Keeping these sequences together prevents one surface from silently
 * reintroducing the stale-catalog race fixed in build .439.
 */
export function useCatalogController(toast: ToastFn) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  /** Backend Session._data_epoch — bumps on catalog-mutating writes/loads. */
  const [dataEpoch, setDataEpoch] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);

  const tablesSeq = useRef(0);
  const historySeq = useRef(0);
  const savedSeq = useRef(0);
  const workflowsSeq = useRef(0);
  /** Single-flight for periodic origin poll (not for mutation refreshes). */
  const pollInFlight = useRef(false);
  const pollBackoffUntil = useRef(0);
  const tablesRef = useRef<TableInfo[]>([]);
  tablesRef.current = tables;

  const refreshTables = useCallback(() => {
    const sequence = ++tablesSeq.current;
    const apply = (snapshot: { tables: TableInfo[]; data_epoch: number }) => {
      if (sequence !== tablesSeq.current) return;
      // Epoch can advance without a schema/row_count reshape (UPDATE in place).
      setDataEpoch(snapshot.data_epoch);
      const next = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
      const refreshed = detectFileRefreshedToasts(tablesRef.current, next);
      setTables((prev) => (tablesCatalogEqual(prev, next) ? prev : next));
      for (const t of refreshed.slice(0, 3)) {
        toast("ok", "File refreshed", t.name);
      }
    };
    api
      .tables()
      .then(apply)
      .catch(() => {
        window.setTimeout(() => {
          api.tables().then(apply).catch(() => {});
        }, 600);
      });
  }, [toast]);

  /**
   * Focused-window poll: skip if a prior poll is in flight; backoff on error.
   * Mutation paths should call ``refreshTables`` (always allowed).
   */
  const pollTablesIfIdle = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (pollInFlight.current) return;
    if (Date.now() < pollBackoffUntil.current) return;
    pollInFlight.current = true;
    const sequence = ++tablesSeq.current;
    const apply = (snapshot: { tables: TableInfo[]; data_epoch: number }) => {
      if (sequence !== tablesSeq.current) return;
      setDataEpoch(snapshot.data_epoch);
      const next = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
      const refreshed = detectFileRefreshedToasts(tablesRef.current, next);
      setTables((prev) => (tablesCatalogEqual(prev, next) ? prev : next));
      for (const t of refreshed.slice(0, 3)) {
        toast("ok", "File refreshed", t.name);
      }
    };
    api
      .tables()
      .then((snapshot) => {
        pollBackoffUntil.current = 0;
        apply(snapshot);
      })
      .catch(() => {
        // Back off one extra interval when the server is busy / unreachable.
        pollBackoffUntil.current = Date.now() + CATALOG_ORIGIN_POLL_MS * 2;
      })
      .finally(() => {
        pollInFlight.current = false;
      });
  }, [toast]);

  // Light periodic catalog/origin poll while the window is focused.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) pollTablesIfIdle();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const id = window.setInterval(pollTablesIfIdle, CATALOG_ORIGIN_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(id);
    };
  }, [pollTablesIfIdle]);

  const refreshHistory = useCallback(() => {
    const sequence = ++historySeq.current;
    api
      .history()
      .then((value) => {
        if (sequence === historySeq.current) setHistory(value);
      })
      .catch(() => {});
  }, []);

  const refreshSaved = useCallback(() => {
    const sequence = ++savedSeq.current;
    api
      .saved()
      .then((value) => {
        if (sequence === savedSeq.current) setSaved(value);
      })
      .catch(() => {});
  }, []);

  const refreshWorkflows = useCallback(() => {
    const sequence = ++workflowsSeq.current;
    api
      .workflowsList()
      .then((response) => {
        if (sequence !== workflowsSeq.current) return;
        setWorkflows((response.workflows as WorkflowSummary[]) || []);
      })
      .catch(() => {});
  }, []);

  const disconnectSqlServer = useCallback(
    async (connection: string) => {
      try {
        const response = await api.mssqlDisconnect(connection);
        if (response?.error) {
          toast("error", "Disconnect failed", response.error);
          return;
        }
        refreshTables();
        toast("ok", "Disconnected", `Closed ${connection}`);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        toast("error", "Disconnect failed", message);
      }
    },
    [refreshTables, toast],
  );

  return {
    tables,
    setTables,
    dataEpoch,
    setDataEpoch,
    history,
    setHistory,
    saved,
    setSaved,
    workflows,
    setWorkflows,
    refreshTables,
    pollTablesIfIdle,
    refreshHistory,
    refreshSaved,
    refreshWorkflows,
    onDisconnect: disconnectSqlServer,
  };
}
