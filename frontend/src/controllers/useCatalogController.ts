import { useCallback, useRef, useState } from "react";
import { api, nextMonotonicDataEpoch } from "../lib/api";
import type {
  HistoryEntry,
  SavedQuery,
  TableInfo,
  WorkflowSummary,
} from "../lib/types";
import type { ToastFn } from "./appTypes";

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
      (a.source || "") !== (b.source || "")
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

  const refreshTables = useCallback(() => {
    const sequence = ++tablesSeq.current;
    const apply = (snapshot: { tables: TableInfo[]; data_epoch: number }) => {
      if (sequence !== tablesSeq.current) return;
      // Epoch can advance without a schema/row_count reshape (UPDATE in place).
      // Never move backwards: a slow poll must not overwrite a newer mutation echo.
      setDataEpoch((prev) => {
        const next = nextMonotonicDataEpoch(prev, snapshot.data_epoch);
        return next == null ? prev : next;
      });
      const next = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
      setTables((prev) => (tablesCatalogEqual(prev, next) ? prev : next));
    };
    api
      .tables()
      .then(apply)
      .catch(() => {
        window.setTimeout(() => {
          api.tables().then(apply).catch(() => {});
        }, 600);
      });
  }, []);

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
    refreshHistory,
    refreshSaved,
    refreshWorkflows,
    onDisconnect: disconnectSqlServer,
  };
}
