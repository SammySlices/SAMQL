import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { parseWfFile } from "../lib/workflowFile";
import type { WorkflowKind } from "../lib/types";
import type { AppView, EdTab, ToastFn } from "./appTypes";

export type JournalCommand = {
  id: number;
  action: "save" | "saveAs" | "open" | "exportGraph";
};

export type NodeCommand = {
  id: number;
  action: "save" | "saveAs" | "open" | "exportLineage";
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
  activeIdRef,
  loadSqlIntoEditor,
}: UseWorkspaceControllerOptions) {
  const [view, setView] = useState<AppView>(() => {
    try {
      const saved = window.localStorage?.getItem(viewKey);
      if (saved === "notebook") return "notebook";
      if (saved === "nodeflow" || saved === "nodebook") return "nodeflow";
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
  const [ideWfNames, setIdeWfNames] = useState<Record<string, string>>({});
  const [journalLoad, setJournalLoad] = useState<{
    id: number;
    name: string;
    doc: string;
  } | null>(null);
  const [nodeLoad, setNodeLoad] = useState<{
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
    let name = ideWfNames[tab.id];
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
      toast("ok", "Saved to Workflows", name);
      refreshWorkflows();
    } catch (error: unknown) {
      toast(
        "error",
        "Save failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [activeIdRef, edTabsRef, ideWfNames, refreshWorkflows, toast]);

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
          }
          return;
        }
        if (kind === "journal") {
          setJournalLoad({
            id: Date.now(),
            name,
            doc:
              typeof graph.doc === "string"
                ? graph.doc
                : JSON.stringify(graph),
          });
          switchView("notebook");
          return;
        }
        setNodeLoad({ id: Date.now(), name, graph });
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
    [activeIdRef, loadSqlIntoEditor, switchView, toast],
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
    (content: string, name: string) => {
      const envelope = parseWfFile(content);
      if (!envelope) {
        switchView("ide");
        loadSqlIntoEditor(content);
        return;
      }
      if (envelope.kind === "journal") {
        setJournalLoad({
          id: Date.now(),
          name: envelope.name || name,
          doc:
            typeof envelope.payload?.doc === "string"
              ? envelope.payload.doc
              : JSON.stringify(envelope.payload),
        });
        switchView("notebook");
        return;
      }
      if (envelope.kind === "node") {
        setNodeLoad({
          id: Date.now(),
          name: envelope.name || name,
          graph: envelope.payload,
        });
        switchView("nodeflow");
        return;
      }
      switchView("ide");
      loadSqlIntoEditor(String(envelope.payload?.sql ?? ""));
    },
    [loadSqlIntoEditor, switchView],
  );

  const activeSave = useCallback(() => {
    if (viewRef.current === "ide") void saveIdeWorkflow();
    else if (viewRef.current === "notebook")
      setJournalCmd({ id: Date.now(), action: "save" });
    else setNodeCmd({ id: Date.now(), action: "save" });
  }, [saveIdeWorkflow]);

  const activeSaveAs = useCallback(() => {
    if (viewRef.current === "ide") setIdeFile({ mode: "save" });
    else if (viewRef.current === "notebook")
      setJournalCmd({ id: Date.now(), action: "saveAs" });
    else setNodeCmd({ id: Date.now(), action: "saveAs" });
  }, []);

  const activeOpen = useCallback(() => {
    if (viewRef.current === "ide") setIdeFile({ mode: "open" });
    else if (viewRef.current === "notebook")
      setJournalCmd({ id: Date.now(), action: "open" });
    else setNodeCmd({ id: Date.now(), action: "open" });
  }, []);

  return {
    view,
    viewRef,
    switchView,
    journalCmd,
    setJournalCmd,
    nodeCmd,
    setNodeCmd,
    ideWfNames,
    setIdeWfNames,
    journalLoad,
    setJournalLoad,
    nodeLoad,
    setNodeLoad,
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
