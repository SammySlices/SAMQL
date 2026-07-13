import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import type {
  HistoryEntry,
  SavedQuery,
  TableInfo,
  WorkflowSummary,
} from "../lib/types";
import type { ToastFn } from "./appTypes";

/**
 * Owns the sidebar/catalog collections and their latest-response-wins refresh
 * rails. Keeping these sequences together prevents one surface from silently
 * reintroducing the stale-catalog race fixed in build .439.
 */
export function useCatalogController(toast: ToastFn) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);

  const tablesSeq = useRef(0);
  const historySeq = useRef(0);
  const savedSeq = useRef(0);
  const workflowsSeq = useRef(0);

  const refreshTables = useCallback(() => {
    const sequence = ++tablesSeq.current;
    const apply = (value: TableInfo[]) => {
      if (sequence === tablesSeq.current) setTables(value);
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
