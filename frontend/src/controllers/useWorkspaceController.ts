import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  parseCreatedNodeFile,
  upsertCreatedNode,
} from "../lib/createdNodes";
import { parseWfFile, wfEnvelope } from "../lib/workflowFile";
import type { WorkflowKind } from "../lib/types";
import type { AppView, EdTab, ToastFn } from "./appTypes";

export type JournalCommand = {
  id: number;
  action: "save" | "saveAs" | "open" | "exportGraph";
};

export type NodeCommand = {
  id: number;
  action:
    | "save"
    | "saveAs"
    | "open"
    | "exportLineage"
    | "selectNode"
    | "clearSelection";
  nodeId?: string;
};

export type DashboardCommand = {
  id: number;
  action: "save" | "saveAs" | "open" | "export";
};

export type ConfirmAsk = (
  anchor: HTMLElement | { left: number; top: number; side?: "left" | "right" },
  message: React.ReactNode,
  onConfirm: () => void,
  confirmLabel?: string,
) => void;

interface UseWorkspaceControllerOptions {
  viewKey: string;
  toast: ToastFn;
  askConfirm: ConfirmAsk;
  refreshWorkflows: () => void;
  edTabsRef: React.MutableRefObject<EdTab[]>;
  setEdTabs: React.Dispatch<React.SetStateAction<EdTab[]>>;
  activeIdRef: React.MutableRefObject<string>;
  loadSqlIntoEditor: (sql: string, preferredTabId?: string) => string | null | void;
}

/**
 * Owns cross-surface workspace navigation, saved-workflow dispatch, and file
 * command routing. The IDE, Journal, and NodeFlow keep their own serialization,
 * while this controller owns which surface receives each operation.
 */
export function useWorkspaceController({
  viewKey,
  toast,
  askConfirm,
  refreshWorkflows,
  edTabsRef,
  setEdTabs,
  activeIdRef,
  loadSqlIntoEditor,
}: UseWorkspaceControllerOptions) {
  const [view, setView] = useState<AppView>(() => {
    try {
      const saved = window.localStorage?.getItem(viewKey);
      if (saved === "notebook") return "notebook";
      if (saved === "nodeflow" || saved === "nodebook") return "nodeflow";
      if (saved === "dashboard") return "dashboard";
      return "ide";
    } catch {
      return "ide";
    }
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const workflowLoadSeqRef = useRef(0);
  const workflowLoadControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      workflowLoadSeqRef.current += 1;
      workflowLoadControllerRef.current?.abort();
      workflowLoadControllerRef.current = null;
    },
    [],
  );

  const switchView = useCallback(
    (next: AppView) => {
      setView(next);
      try {
        window.localStorage?.setItem(viewKey, next);
      } catch {
        // Persistence is best-effort; navigation still succeeds.
      }
    },
    [viewKey],
  );

  const [journalCmd, setJournalCmd] = useState<JournalCommand | null>(null);
  const [nodeCmd, setNodeCmd] = useState<NodeCommand | null>(null);
  const [dashboardCmd, setDashboardCmd] = useState<DashboardCommand | null>(
    null,
  );
  const [ideWfNames, setIdeWfNames] = useState<Record<string, string>>({});
  const [journalLoad, setJournalLoad] = useState<{
    id: number;
    name: string;
    doc: string;
    savedWorkflowName?: string;
    savedFilePath?: string;
  } | null>(null);
  const [nodeLoad, setNodeLoad] = useState<{
    id: number;
    name: string;
    graph: unknown;
    savedWorkflowName?: string;
    savedFilePath?: string;
  } | null>(null);
  const [dashboardLoad, setDashboardLoad] = useState<{
    id: number;
    name: string;
    graph: unknown;
  } | null>(null);
  const [ideFile, setIdeFile] = useState<{ mode: "save" | "open" } | null>(
    null,
  );
  const saveIdeWorkflow = useCallback(async () => {
    const tab = edTabsRef.current.find(
      (candidate) => candidate.id === activeIdRef.current,
    );
    if (!tab) return;
    if (!tab.sql.trim()) {
      toast("error", "Nothing to save", "The editor is empty.");
      return;
    }
    if (tab.savedFilePath) {
      try {
        const response = await api.saveFile(
          tab.savedFilePath,
          wfEnvelope("ide", tab.title || "query", { sql: tab.sql }),
        );
        if (response.error) {
          toast("error", "Save failed", response.error);
          return;
        }
        toast("ok", "Saved", response.name || tab.savedFilePath);
      } catch (error: unknown) {
        toast(
          "error",
          "Save failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    let name = tab.savedWorkflowName || ideWfNames[tab.id];
    if (!name) {
      name = (window.prompt("Save SQL as:", tab.title || "") || "").trim();
      if (!name) return;
    }
    try {
      const response = await api.workflowSave(name, { sql: tab.sql }, "ide");
      if (response.error) {
        toast("error", "Save failed", response.error);
        return;
      }
      setIdeWfNames((current) => ({ ...current, [tab.id]: name as string }));
      setEdTabs((current) =>
        current.map((item) =>
          item.id === tab.id
            ? {
                ...item,
                savedWorkflowName: response.name || name,
                savedFilePath: undefined,
              }
            : item,
        ),
      );
      toast("ok", "Saved to Workflows", name);
      refreshWorkflows();
    } catch (error: unknown) {
      toast(
        "error",
        "Save failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [
    activeIdRef,
    edTabsRef,
    ideWfNames,
    refreshWorkflows,
    setEdTabs,
    toast,
  ]);

  const onLoadWorkflow = useCallback(
    async (kind: WorkflowKind, name: string) => {
      const sequence = ++workflowLoadSeqRef.current;
      workflowLoadControllerRef.current?.abort();
      const controller = new AbortController();
      workflowLoadControllerRef.current = controller;
      const destinationTabId = activeIdRef.current;
      const isCurrent = () =>
        sequence === workflowLoadSeqRef.current && !controller.signal.aborted;

      try {
        const response = await api.workflowLoad(name, kind, controller.signal);
        if (!isCurrent()) return;
        if (response.error || !response.graph) {
          toast("error", "Open failed", response.error || "Not found.");
          return;
        }
        const graph = response.graph as any;
        if (kind === "ide") {
          switchView("ide");
          const loadedTabId =
            loadSqlIntoEditor(String(graph.sql || ""), destinationTabId) ||
            destinationTabId;
          if (loadedTabId && isCurrent()) {
            setIdeWfNames((current) => ({
              ...current,
              [loadedTabId]: name,
            }));
            setEdTabs((current) =>
              current.map((tab) =>
                tab.id === loadedTabId
                  ? {
                      ...tab,
                      savedWorkflowName: name,
                      savedFilePath: undefined,
                    }
                  : tab,
              ),
            );
          }
          return;
        }
        if (kind === "journal") {
          setJournalLoad({
            id: Date.now(),
            name,
            savedWorkflowName: name,
            doc:
              typeof graph.doc === "string"
                ? graph.doc
                : JSON.stringify(graph),
          });
          switchView("notebook");
          return;
        }
        if (kind === "dashboard") {
          setDashboardLoad({ id: Date.now(), name, graph });
          switchView("dashboard");
          return;
        }
        setNodeLoad({
          id: Date.now(),
          name,
          graph,
          savedWorkflowName: name,
        });
        switchView("nodeflow");
      } catch (error: unknown) {
        if (!isCurrent() || (error as any)?.name === "AbortError") return;
        toast(
          "error",
          "Open failed",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (workflowLoadControllerRef.current === controller) {
          workflowLoadControllerRef.current = null;
        }
      }
    },
    [activeIdRef, loadSqlIntoEditor, setEdTabs, switchView, toast],
  );

  const onDeleteWorkflow = useCallback(
    async (kind: WorkflowKind, name: string) => {
      askConfirm(
        { left: window.innerWidth / 2 - 94, top: 96, side: "right" },
        `Delete “${name}” from Saved Workflows?`,
        async () => {
          try {
            await api.workflowDelete(name, kind);
            refreshWorkflows();
          } catch {
            // The sidebar refresh will retain the item if deletion failed.
          }
        },
      );
    },
    [askConfirm, refreshWorkflows],
  );

  const openWorkflowContent = useCallback(
    (content: string, name: string, filePath?: string) => {
      // Created-node exports share disk space with workflows but are not
      // workflow envelopes — detect them before falling through to SQL.
      try {
        const created = parseCreatedNodeFile(JSON.parse(content));
        if (created.ok) {
          upsertCreatedNode(created.definition);
          switchView("nodeflow");
          toast(
            "ok",
            "Created node loaded",
            `"${created.definition.name}" is in the palette.`,
          );
          return;
        }
      } catch {
        // Not JSON / not a created-node export — continue.
      }

      let envelope: ReturnType<typeof parseWfFile> = null;
      try {
        envelope = parseWfFile(content);
      } catch (error: unknown) {
        toast(
          "error",
          "Open failed",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      if (envelope?.kind === "journal") {
        setJournalLoad({
          id: Date.now(),
          name: envelope.name || name,
          savedFilePath: filePath,
          doc:
            typeof envelope.payload?.doc === "string"
              ? envelope.payload.doc
              : JSON.stringify(envelope.payload),
        });
        switchView("notebook");
        return;
      }
      if (envelope?.kind === "node") {
        setNodeLoad({
          id: Date.now(),
          name: envelope.name || name,
          graph: envelope.payload,
          savedFilePath: filePath,
        });
        switchView("nodeflow");
        return;
      }
      if (envelope?.kind === "dashboard") {
        setDashboardLoad({
          id: Date.now(),
          name: envelope.name || name,
          graph: envelope.payload,
        });
        switchView("dashboard");
        return;
      }
      if (envelope?.kind === "ide") {
        switchView("ide");
        const loadedId = loadSqlIntoEditor(String(envelope.payload?.sql ?? ""));
        if (loadedId && filePath) {
          setEdTabs((current) =>
            current.map((tab) =>
              tab.id === loadedId
                ? {
                    ...tab,
                    savedFilePath: filePath,
                    savedWorkflowName: undefined,
                  }
                : tab,
            ),
          );
        }
        return;
      }

      // Non-envelope JSON: dashboard bundle / bare workspace, or node graph.
      try {
        const parsed = JSON.parse(content) as {
          samql?: string;
          dashboards?: unknown;
          nodes?: unknown;
          edges?: unknown;
        };
        if (
          parsed?.samql === "dashboard-bundle" ||
          Array.isArray(parsed?.dashboards)
        ) {
          setDashboardLoad({
            id: Date.now(),
            name,
            graph: parsed,
          });
          switchView("dashboard");
          return;
        }
        if (Array.isArray(parsed?.nodes)) {
          setNodeLoad({
            id: Date.now(),
            name,
            graph: parsed,
            savedFilePath: filePath,
          });
          switchView("nodeflow");
          return;
        }
      } catch {
        // Raw SQL / text — open in the editor below.
      }

      switchView("ide");
      const loadedId = loadSqlIntoEditor(content);
      if (loadedId && filePath) {
        setEdTabs((current) =>
          current.map((tab) =>
            tab.id === loadedId
              ? {
                  ...tab,
                  savedFilePath: filePath,
                  savedWorkflowName: undefined,
                }
              : tab,
          ),
        );
      }
    },
    [loadSqlIntoEditor, setEdTabs, switchView, toast],
  );

  const activeSave = useCallback(() => {
    if (viewRef.current === "ide") void saveIdeWorkflow();
    else if (viewRef.current === "notebook")
      setJournalCmd({ id: Date.now(), action: "save" });
    else if (viewRef.current === "dashboard")
      setDashboardCmd({ id: Date.now(), action: "save" });
    else setNodeCmd({ id: Date.now(), action: "save" });
  }, [saveIdeWorkflow]);

  const activeSaveAs = useCallback(() => {
    if (viewRef.current === "ide") setIdeFile({ mode: "save" });
    else if (viewRef.current === "notebook")
      setJournalCmd({ id: Date.now(), action: "saveAs" });
    else if (viewRef.current === "dashboard")
      setDashboardCmd({ id: Date.now(), action: "saveAs" });
    else setNodeCmd({ id: Date.now(), action: "saveAs" });
  }, []);

  /** Unified Open: one file picker that routes by detected document kind. */
  const activeOpen = useCallback(() => {
    setIdeFile({ mode: "open" });
  }, []);

  return {
    view,
    viewRef,
    switchView,
    journalCmd,
    setJournalCmd,
    nodeCmd,
    setNodeCmd,
    dashboardCmd,
    setDashboardCmd,
    ideWfNames,
    setIdeWfNames,
    journalLoad,
    setJournalLoad,
    nodeLoad,
    setNodeLoad,
    dashboardLoad,
    setDashboardLoad,
    ideFile,
    setIdeFile,
    saveIdeWorkflow,
    onLoadWorkflow,
    onDeleteWorkflow,
    openWorkflowContent,
    activeSave,
    activeSaveAs,
    activeOpen,
  };
}
