import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { api, registerBgCancel } from "../lib/api";
import type { RootIdChoice } from "../lib/api";
import { cancelOne, registerRun, unregisterRun } from "../lib/runController";
import type { TaskCard } from "../lib/types";
import type { ToastFn } from "./appTypes";
import { uid } from "../lib/ids";

export interface BackgroundOperation {
  queryId: string;
  ctrl: AbortController;
}

/**
 * Owns cancellable non-editor operations such as profiles, materialization,
 * flattening, and column-type changes. The controller centralizes the client
 * AbortController and server query-id lifecycle so every caller cleans up the
 * same way and engine reset can cancel all outstanding work.
 */
interface UseBackgroundOperationsOptions {
  toast: ToastFn;
  refreshTables: () => void;
  setLoadOpen: Dispatch<SetStateAction<boolean>>;
}

export function useBackgroundOperations({
  toast,
  refreshTables,
  setLoadOpen,
}: UseBackgroundOperationsOptions) {
  const operations = useRef<Map<string, AbortController>>(new Map());

  const startBgOp = useCallback((): BackgroundOperation => {
    const queryId = uid();
    const ctrl = new AbortController();
    operations.current.set(queryId, ctrl);
    registerRun(queryId, ctrl);
    return { queryId, ctrl };
  }, []);

  const endBgOp = useCallback((queryId: string) => {
    const ctrl = operations.current.get(queryId);
    operations.current.delete(queryId);
    unregisterRun(queryId, ctrl);
  }, []);

  const cancelBgOp = useCallback((queryId?: string | null) => {
    if (!queryId) return;
    const ctrl = operations.current.get(queryId);
    operations.current.delete(queryId);
    cancelOne(queryId, ctrl);
  }, []);

  const cancelAllBgOps = useCallback(() => {
    for (const queryId of Array.from(operations.current.keys()))
      cancelBgOp(queryId);
  }, [cancelBgOp]);

  useEffect(() => registerBgCancel(cancelAllBgOps), [cancelAllBgOps]);

  const beginLoad = useCallback(
    async (
      path: string,
      dest: string,
      delimiter?: string,
      mode?: string,
      sheet?: string,
      headerRow?: number,
      exclude?: string,
      opts?: {
        flatten?: boolean;
        shred?: boolean;
        root_id?: RootIdChoice;
      },
    ) => {
      setLoadOpen(false);
      const fileName =
        (path.split("/").pop() || path)
          .split(String.fromCharCode(92))
          .pop() || path;
      toast(
        "ok",
        `Loading ${fileName}`,
        "Started — tracking in the activity panel.",
      );
      try {
        await api.loadStart(
          path,
          dest,
          delimiter,
          mode,
          sheet,
          headerRow,
          exclude,
          opts,
        );
      } catch (error: unknown) {
        toast(
          "error",
          "Load failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [setLoadOpen, toast],
  );

  const beginLoadFolder = useCallback(
    async (directory: string, dest: string, delimiter?: string) => {
      setLoadOpen(false);
      const directoryName =
        (directory.split("/").pop() || directory)
          .split(String.fromCharCode(92))
          .pop() || directory;
      toast(
        "ok",
        `Loading folder ${directoryName}`,
        "Started — tracking in the activity panel.",
      );
      try {
        await api.loadFolderStart(directory, dest, false, delimiter);
      } catch (error: unknown) {
        toast(
          "error",
          "Load failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [setLoadOpen, toast],
  );

  const beginHdfsFileLoad = useCallback(
    async (path: string) => {
      setLoadOpen(false);
      try {
        await api.hdfsLoadFileStart(path, { mode: "view" });
      } catch (error: unknown) {
        toast(
          "error",
          "Load failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [setLoadOpen, toast],
  );

  const beginOptimize = useCallback(
    (name: string) => {
      api.optimizeTableStart(name).catch((error: unknown) => {
        toast(
          "error",
          "Conversion failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [toast],
  );

  const onTaskComplete = useCallback(
    async (task: TaskCard) => {
      if (task.kind === "flatten") return;
      refreshTables();
      if (task.state === "error") {
        toast(
          "error",
          task.kind === "convert" ? "Conversion failed" : "Load failed",
          task.error || "Unknown error",
        );
        return;
      }
      if (task.state === "cancelled") {
        toast(
          "warn",
          task.kind === "convert" ? "Conversion cancelled" : "Cancelled",
          task.title || "",
        );
        return;
      }
      if (task.kind === "convert") {
        toast(
          "ok",
          "Converted to Parquet",
          `${task.title} is now stored columnar — repeat queries will be faster.`,
        );
        return;
      }
      toast(
        "ok",
        "Loaded",
        `${task.title} → ${(task.rows ?? 0).toLocaleString()} rows` +
          ((task as any).note ? ` (${(task as any).note})` : ""),
      );
      try {
        const progress = await api.loadProgress(task.id);
        const loaded = (progress.loaded || []) as Array<{
          rows?: number;
          skipped?: number;
          view?: boolean;
        }>;
        const skipped = loaded.reduce(
          (total, entry) => total + (entry.skipped || 0),
          0,
        );
        const emptyTables = loaded.filter(
          (entry) => !entry.view && (entry.rows || 0) === 0,
        ).length;
        if (!skipped && !emptyTables) return;
        const warnings: string[] = [];
        if (skipped)
          warnings.push(
            `${skipped} feed/date combination${
              skipped === 1 ? "" : "s"
            } skipped (no file)`,
          );
        if (emptyTables)
          warnings.push(
            `${emptyTables} table${
              emptyTables === 1 ? "" : "s"
            } loaded 0 rows`,
          );
        toast("warn", "Heads up", warnings.join("; ") + ".");
      } catch {
        // Per-table detail is best-effort.
      }
    },
    [refreshTables, toast],
  );

  return {
    startBgOp,
    endBgOp,
    cancelBgOp,
    cancelAllBgOps,
    beginLoad,
    beginLoadFolder,
    beginHdfsFileLoad,
    beginOptimize,
    onTaskComplete,
  };
}
