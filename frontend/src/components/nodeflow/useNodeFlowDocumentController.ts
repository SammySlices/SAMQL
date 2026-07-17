import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { uid } from "../../lib/ids";
import { backupLocalStorageValue } from "../../lib/migrations";
import {
  LEGACY_STORE_KEY,
  LEGACY_TAB_KEY,
  LEGACY_TABS_KEY,
  STORE_KEY,
  TAB_KEY,
  TABS_KEY,
  parseNodeFlowGraph,
  parseNodeFlowTabs,
  serializeNodeFlowGraph,
  serializeNodeFlowTabs,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";
import { persistNodeFlowSnapshot } from "../../lib/nodeFlowPersistence";
import { serializeGraph } from "../../lib/nodegraph";
import { wfEnvelope, parseWfFile, wfKindSurface } from "../../lib/workflowFile";
import {
  applyCreatedNodeToGraph,
  parseCreatedNodeFile,
  stripCreatedNodeFromGraph,
  updateCreatedNodeDefinition,
  upsertCreatedNode,
  type CreatedNodeDefinition,
} from "../../lib/createdNodes";
import type { DeleteConfirmState, NodeMenuState } from "./NodeFlowMenus";
import type { NodeFlowTab } from "./NodeFlowTabBar";
import { useNodeFlowAutosave } from "./useNodeFlowAutosave";

export type NodeFlowSnapshot = { nodes: NbNode[]; edges: NbEdge[] };
type TabHistory = {
  past: NodeFlowSnapshot[];
  future: NodeFlowSnapshot[];
  prev: NodeFlowSnapshot | null;
};

interface UseNodeFlowDocumentControllerOptions {
  nodes: NbNode[];
  edges: NbEdge[];
  nodesRef: React.RefObject<NbNode[]>;
  edgesRef: React.RefObject<NbEdge[]>;
  setNodes: React.Dispatch<React.SetStateAction<NbNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<NbEdge[]>>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setNodeErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setNodeWarnings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setNodeMenu: React.Dispatch<React.SetStateAction<NodeMenuState | null>>;
  setDeleteConfirm: React.Dispatch<React.SetStateAction<DeleteConfirmState | null>>;
  onToast: (
    kind: "ok" | "error" | "warn",
    title: string,
    message?: string,
  ) => void;
  loadRequest?: {
    id: number;
    name: string;
    graph: unknown;
    savedWorkflowName?: string;
    savedFilePath?: string;
  } | null;
  onLoadConsumed?: () => void;
  onWorkflowsChanged?: () => void;
  command?: {
    id: number;
    action:
      | "save"
      | "saveAs"
      | "open"
      | "exportLineage"
      | "selectNode"
      | "clearSelection";
    nodeId?: string;
  } | null;
  onDocumentStatus?: (text: string) => void;
}

export function useNodeFlowDocumentController({
  nodes,
  edges,
  nodesRef,
  edgesRef,
  setNodes,
  setEdges,
  setSelectedId,
  setSelectedIds,
  setNodeErrors,
  setNodeWarnings,
  setNodeMenu,
  setDeleteConfirm,
  onToast,
  loadRequest,
  onLoadConsumed,
  onWorkflowsChanged,
  command,
  onDocumentStatus,
}: UseNodeFlowDocumentControllerOptions) {
  const loadedRef = useRef(false);
  const histPastRef = useRef<NodeFlowSnapshot[]>([]);
  const histFutureRef = useRef<NodeFlowSnapshot[]>([]);
  const histPrevRef = useRef<NodeFlowSnapshot | null>(null);
  const histApplyingRef = useRef(false);
  const liveRef = useRef<NodeFlowSnapshot>({ nodes: [], edges: [] });
  const tabGraphsRef = useRef<Record<string, NodeFlowSnapshot>>({});
  const tabHistoryRef = useRef<Record<string, TabHistory>>({});
  const activeTabRef = useRef("");
  const [tabs, setTabs] = useState<NodeFlowTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [nodeFileModal, setNodeFileModal] = useState<{
    mode: "save" | "open";
  } | null>(null);
  const openFileSeqRef = useRef(0);

  const refreshHistory = useCallback(() => {
    setHistoryState({
      canUndo: histPastRef.current.length > 0,
      canRedo: histFutureRef.current.length > 0,
    });
  }, []);

  useLayoutEffect(() => {
    liveRef.current = { nodes, edges };
  }, [nodes, edges]);

  const persistGraphNow = useCallback(
    (id = activeTabRef.current, snap = liveRef.current) => {
      if (!id) return false;
      const stable = { nodes: snap.nodes, edges: snap.edges };
      tabGraphsRef.current[id] = stable;
      try {
        return persistNodeFlowSnapshot(window.localStorage, id, stable);
      } catch {
        return false;
      }
    },
    [],
  );

  // Load a tab graph into the cache (and from localStorage when never opened).
  // Does not activate the tab — used by refresh of Created Node instances on
  // inactive / never-selected tabs.
  const ensureTabGraphLoaded = useCallback((id: string): NodeFlowSnapshot => {
    const cached = tabGraphsRef.current[id];
    if (cached) return cached;
    const key = TAB_KEY(id);
    const legacyKey = LEGACY_TAB_KEY(id);
    let sourceKey = key;
    let raw: string | null = null;
    let graph: NodeFlowSnapshot;
    try {
      const canonicalRaw = window.localStorage?.getItem(key);
      raw = canonicalRaw || window.localStorage?.getItem(legacyKey) || null;
      sourceKey = canonicalRaw ? key : legacyKey;
      const parsed = parseNodeFlowGraph(raw ? JSON.parse(raw) : {});
      if (raw && (parsed.migratedFrom !== undefined || sourceKey !== key)) {
        backupLocalStorageValue(sourceKey, raw);
        window.localStorage?.setItem(
          key,
          JSON.stringify(serializeNodeFlowGraph(parsed.nodes, parsed.edges)),
        );
      }
      graph = { nodes: parsed.nodes, edges: parsed.edges };
    } catch {
      if (raw) backupLocalStorageValue(sourceKey, raw);
      graph = { nodes: [], edges: [] };
      try {
        window.localStorage?.setItem(
          key,
          JSON.stringify(serializeNodeFlowGraph(graph.nodes, graph.edges)),
        );
      } catch {
        // The recovered blank graph remains usable in memory.
      }
    }
    tabGraphsRef.current[id] = graph;
    return graph;
  }, []);

  useEffect(() => {
    let list: NodeFlowTab[] = [];
    let active = "";
    let graph: NodeFlowSnapshot = { nodes: [], edges: [] };

    try {
      const storage = window.localStorage;
      const canonicalIndexRaw = storage?.getItem(TABS_KEY);
      const legacyIndexRaw = storage?.getItem(LEGACY_TABS_KEY);
      const indexRaw = canonicalIndexRaw || legacyIndexRaw;
      const indexSourceKey = canonicalIndexRaw ? TABS_KEY : LEGACY_TABS_KEY;

      if (indexRaw) {
        try {
          const index = parseNodeFlowTabs(JSON.parse(indexRaw));
          list = index.tabs;
          active = index.activeTabId || "";
          if (index.migratedFrom !== undefined || indexSourceKey !== TABS_KEY) {
            backupLocalStorageValue(indexSourceKey, indexRaw);
          }
        } catch {
          // A malformed/future tab index must not strand the editor with zero
          // tabs. Preserve the exact bytes for recovery, then start a clean
          // document and publish a valid replacement index below.
          backupLocalStorageValue(indexSourceKey, indexRaw);
        }
      }

      if (!list.length) {
        const id = uid();
        list = [{ id, name: "Tab 1" }];
        active = id;

        const storeKey = storage?.getItem(STORE_KEY)
          ? STORE_KEY
          : LEGACY_STORE_KEY;
        const legacyGraph = storage?.getItem(storeKey);
        if (legacyGraph) {
          try {
            const parsed = parseNodeFlowGraph(JSON.parse(legacyGraph));
            graph = { nodes: parsed.nodes, edges: parsed.edges };
            tabGraphsRef.current[id] = graph;
            backupLocalStorageValue(storeKey, legacyGraph);
          } catch {
            backupLocalStorageValue(storeKey, legacyGraph);
          }
        }
      }

      if (!active || !list.some((tab) => tab.id === active)) {
        active = list[0].id;
      }

      const readTabGraph = (id: string): NodeFlowSnapshot => {
        const cached = tabGraphsRef.current[id];
        if (cached) return cached;
        const key = TAB_KEY(id);
        const canonicalRaw = storage?.getItem(key);
        const legacyKey = LEGACY_TAB_KEY(id);
        const raw = canonicalRaw || storage?.getItem(legacyKey);
        const sourceKey = canonicalRaw ? key : legacyKey;
        if (!raw) return { nodes: [], edges: [] };
        try {
          const parsed = parseNodeFlowGraph(JSON.parse(raw));
          const snapshot = { nodes: parsed.nodes, edges: parsed.edges };
          if (parsed.migratedFrom !== undefined || sourceKey !== key) {
            backupLocalStorageValue(sourceKey, raw);
            storage?.setItem(
              key,
              JSON.stringify(serializeNodeFlowGraph(snapshot.nodes, snapshot.edges)),
            );
          }
          return snapshot;
        } catch {
          // A corrupt tab body affects only that tab. Keep the tab index and
          // every other workflow intact, preserve the source bytes, and replace
          // this tab with a valid blank graph.
          backupLocalStorageValue(sourceKey, raw);
          const blank = { nodes: [], edges: [] } satisfies NodeFlowSnapshot;
          storage?.setItem(
            key,
            JSON.stringify(serializeNodeFlowGraph(blank.nodes, blank.edges)),
          );
          return blank;
        }
      };

      graph = readTabGraph(active);
      tabGraphsRef.current[active] = graph;
      storage?.setItem(
        TABS_KEY,
        JSON.stringify(serializeNodeFlowTabs(list, active)),
      );
      if (!storage?.getItem(TAB_KEY(active))) {
        storage?.setItem(
          TAB_KEY(active),
          JSON.stringify(serializeNodeFlowGraph(graph.nodes, graph.edges)),
        );
      }
    } catch {
      // Storage is optional. Always initialize a valid in-memory document even
      // when localStorage is unavailable (private mode, quota, security policy).
    }

    if (!list.length) {
      const id = uid();
      list = [{ id, name: "Tab 1" }];
      active = id;
      graph = { nodes: [], edges: [] };
    }
    if (!active || !list.some((tab) => tab.id === active)) active = list[0].id;

    tabGraphsRef.current[active] = graph;
    setTabs(list);
    setActiveTabId(active);
    activeTabRef.current = active;
    setNodes(graph.nodes);
    setEdges(graph.edges);
    histPrevRef.current = graph;
    liveRef.current = graph;
    loadedRef.current = true;
  }, [setEdges, setNodes]);

  useNodeFlowAutosave({
    loadedRef,
    activeTabId,
    tabs,
    nodes,
    edges,
    tabGraphsRef,
    activeTabRef,
    liveRef,
    persistGraphNow,
  });

  useEffect(() => {
    if (!loadedRef.current) return;
    if (histApplyingRef.current) {
      histApplyingRef.current = false;
      histPrevRef.current = { nodes, edges };
      return;
    }
    const timer = window.setTimeout(() => {
      if (histPrevRef.current) {
        histPastRef.current.push(histPrevRef.current);
        if (histPastRef.current.length > 80) histPastRef.current.shift();
        histFutureRef.current = [];
        refreshHistory();
      }
      histPrevRef.current = { nodes, edges };
    }, 350);
    return () => window.clearTimeout(timer);
  }, [edges, nodes, refreshHistory]);

  const loadTabIntoState = useCallback(
    (id: string) => {
      const graph = ensureTabGraphLoaded(id);
      const tabHistory =
        tabHistoryRef.current[id] ||
        ({ past: [], future: [], prev: graph } satisfies TabHistory);
      histPastRef.current = tabHistory.past;
      histFutureRef.current = tabHistory.future;
      histPrevRef.current = tabHistory.prev || graph;
      liveRef.current = graph;
      histApplyingRef.current = true;
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setSelectedId(null);
      setSelectedIds([]);
      setNodeErrors({});
      setNodeWarnings({});
      setNodeMenu(null);
      activeTabRef.current = id;
      setActiveTabId(id);
      refreshHistory();
    },
    [
      ensureTabGraphLoaded,
      refreshHistory,
      setEdges,
      setNodeErrors,
      setNodeMenu,
      setNodeWarnings,
      setNodes,
      setSelectedId,
      setSelectedIds,
    ],
  );

  const saveActiveTab = useCallback(() => {
    const current = activeTabRef.current;
    if (!current) return;
    const snapshot = {
      nodes: nodesRef.current || [],
      edges: edgesRef.current || [],
    };
    tabGraphsRef.current[current] = snapshot;
    persistGraphNow(current, snapshot);
    tabHistoryRef.current[current] = {
      past: histPastRef.current,
      future: histFutureRef.current,
      prev: histPrevRef.current,
    };
  }, [edgesRef, nodesRef, persistGraphNow]);

  const switchTab = useCallback(
    (id: string) => {
      if (id === activeTabRef.current) return;
      saveActiveTab();
      loadTabIntoState(id);
    },
    [loadTabIntoState, saveActiveTab],
  );

  const addTab = useCallback(() => {
    saveActiveTab();
    const id = uid();
    const empty = { nodes: [], edges: [] } satisfies NodeFlowSnapshot;
    tabGraphsRef.current[id] = empty;
    tabHistoryRef.current[id] = { past: [], future: [], prev: empty };
    setTabs((current) => {
      const maxNumber = current.reduce((max, tab) => {
        const match = /^Tab (\d+)$/.exec(tab.name);
        return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
      }, 0);
      return [...current, { id, name: `Tab ${maxNumber + 1}` }];
    });
    loadTabIntoState(id);
  }, [loadTabIntoState, saveActiveTab]);

  const reallyCloseTab = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const wasActive = id === activeTabRef.current;
      const remaining = tabs.filter((tab) => tab.id !== id);
      delete tabGraphsRef.current[id];
      delete tabHistoryRef.current[id];
      try {
        window.localStorage?.removeItem(TAB_KEY(id));
      } catch {
        // Best-effort cleanup only.
      }
      setTabs(remaining);
      if (wasActive) {
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) loadTabIntoState(next.id);
      }
    },
    [loadTabIntoState, tabs],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const tab = tabs[index];
      const tabNodes =
        id === activeTabRef.current
          ? nodesRef.current || []
          : tabGraphsRef.current[id]?.nodes || [];
      if (tabNodes.length) {
        setDeleteConfirm({
          left: Math.round(window.innerWidth / 2 - 94),
          top: 84,
          side: "right",
          msg: `Close “${tab.name}”? Its nodes will be removed.`,
          label: "Close",
          onOk: () => reallyCloseTab(id),
        });
        return;
      }
      reallyCloseTab(id);
    },
    [nodesRef, reallyCloseTab, setDeleteConfirm, tabs],
  );

  const startRenameTab = useCallback((id: string, name: string) => {
    setEditingTab(id);
    setEditingName(name);
  }, []);

  const commitRenameTab = useCallback(() => {
    if (!editingTab) return;
    const name = editingName.trim() || "Tab";
    setTabs((current) =>
      current.map((tab) => (tab.id === editingTab ? { ...tab, name } : tab)),
    );
    setEditingTab(null);
    setEditingName("");
  }, [editingName, editingTab]);

  const undo = useCallback(() => {
    if (!histPastRef.current.length) return;
    const snapshot = histPastRef.current.pop()!;
    histFutureRef.current.push(liveRef.current);
    histApplyingRef.current = true;
    histPrevRef.current = snapshot;
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedId(null);
    setNodeMenu(null);
    refreshHistory();
  }, [refreshHistory, setEdges, setNodeMenu, setNodes, setSelectedId]);

  const redo = useCallback(() => {
    if (!histFutureRef.current.length) return;
    const snapshot = histFutureRef.current.pop()!;
    histPastRef.current.push(liveRef.current);
    histApplyingRef.current = true;
    histPrevRef.current = snapshot;
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedId(null);
    setNodeMenu(null);
    refreshHistory();
  }, [refreshHistory, setEdges, setNodeMenu, setNodes, setSelectedId]);

  const graphForRun = useCallback(
    () => serializeGraph(liveRef.current.nodes as any, liveRef.current.edges as any),
    [],
  );
  const fullGraph = useCallback(
    () => serializeNodeFlowGraph(nodesRef.current || [], edgesRef.current || []),
    [edgesRef, nodesRef],
  );
  const activeTabName = useCallback(
    () =>
      (tabs.find((tab) => tab.id === activeTabRef.current)?.name || "").trim(),
    [tabs],
  );
  const activeTab = useCallback(
    () => tabs.find((tab) => tab.id === activeTabRef.current) || null,
    [tabs],
  );

  const exportLineage = useCallback(async () => {
    const graph = fullGraph();
    if (!graph.nodes?.length) {
      onToast("error", "Nothing to trace", "Add nodes to the workflow first.");
      return;
    }
    try {
      const result = await api.saveLineage(graph);
      onToast("ok", "Lineage exported", result.path);
    } catch (error: any) {
      onToast("error", "Lineage export failed", error.message || String(error));
    }
  }, [fullGraph, onToast]);

  const saveWorkflow = useCallback(async () => {
    const tab = activeTab();
    const graph = fullGraph();
    if (tab?.editingDefinitionId) {
      // Workspace Save overwrites the open Created Node by stable id (no duplicate).
      const result = updateCreatedNodeDefinition(
        tab.editingDefinitionId,
        graph.nodes,
        graph.edges,
      );
      if (!result.ok) {
        onToast("error", "Save failed", result.error);
        return;
      }
      onToast(
        "ok",
        "Node saved",
        `"${result.definition.name}" updated (${result.definition.inputs.length} in · ${result.definition.outputs.length} out).`,
      );
      return;
    }
    const name = tab?.savedWorkflowName || tab?.name.trim() || "";
    if (!name) return;
    try {
      if (tab?.savedFilePath) {
        const result = await api.saveFile(
          tab.savedFilePath,
          wfEnvelope("node", tab.name, graph),
        );
        if (result.error) {
          onToast("error", "Save failed", result.error);
          return;
        }
        onToast("ok", "Workflow saved", result.name || tab.savedFilePath);
        return;
      }
      const result = await api.workflowSave(name, graph, "node");
      if (result.error) {
        onToast("error", "Save failed", result.error);
        return;
      }
      setTabs((current) =>
        current.map((item) =>
          item.id === tab?.id
            ? {
                ...item,
                savedWorkflowName: result.name || name,
                savedFilePath: undefined,
              }
            : item,
        ),
      );
      onToast("ok", "Workflow saved", name);
      onWorkflowsChanged?.();
    } catch (error: any) {
      onToast("error", "Save failed", error.message || String(error));
    }
  }, [activeTab, fullGraph, onToast, onWorkflowsChanged]);

  const openGraphInNewTab = useCallback(
    (
      graphLike: { nodes?: NbNode[]; edges?: any[] },
      requestedName: string,
      options?: {
        editingDefinitionId?: string;
        savedWorkflowName?: string;
        savedFilePath?: string;
      },
    ) => {
      const editingDefinitionId = options?.editingDefinitionId?.trim() || "";
      const savedWorkflowName = options?.savedWorkflowName?.trim() || "";
      const savedFilePath = options?.savedFilePath?.trim() || "";
      if (editingDefinitionId || savedWorkflowName || savedFilePath) {
        const existing = tabs.find(
          (tab) =>
            (editingDefinitionId &&
              tab.editingDefinitionId === editingDefinitionId) ||
            (savedWorkflowName &&
              tab.savedWorkflowName === savedWorkflowName) ||
            (savedFilePath && tab.savedFilePath === savedFilePath),
        );
        if (existing) {
          if (existing.id !== activeTabRef.current) {
            saveActiveTab();
            loadTabIntoState(existing.id);
          }
          onDocumentStatus?.(`Opened “${existing.name}”`);
          return existing.id;
        }
      }
      saveActiveTab();
      const id = uid();
      const parsed = parseNodeFlowGraph(graphLike);
      const nextGraph = {
        nodes: parsed.nodes,
        edges: parsed.edges.map((edge, index) => ({
          id: edge.id || `e${index}_${uid()}`,
          from: edge.from,
          to: edge.to,
        })),
      } satisfies NodeFlowSnapshot;
      tabGraphsRef.current[id] = nextGraph;
      tabHistoryRef.current[id] = { past: [], future: [], prev: nextGraph };
      setTabs((current) => {
        const taken = new Set(current.map((tab) => tab.name));
        let name = requestedName.trim() || "Workflow";
        if (taken.has(name)) {
          let suffix = 2;
          while (taken.has(`${name} (${suffix})`)) suffix += 1;
          name = `${name} (${suffix})`;
        }
        return [
          ...current,
          {
            id,
            name,
            ...(savedWorkflowName ? { savedWorkflowName } : {}),
            ...(savedFilePath ? { savedFilePath } : {}),
            ...(editingDefinitionId ? { editingDefinitionId } : {}),
          },
        ];
      });
      loadTabIntoState(id);
      onDocumentStatus?.(`Loaded “${requestedName}” in a new tab`);
      return id;
    },
    [loadTabIntoState, onDocumentStatus, saveActiveTab, tabs],
  );

  const activeEditingDefinitionId = useCallback((): string | null => {
    const tab = tabs.find((item) => item.id === activeTabRef.current);
    const id = tab?.editingDefinitionId?.trim();
    return id || null;
  }, [tabs]);

  const refreshUsernodesFromDefinition = useCallback(
    (definition: CreatedNodeDefinition) => {
      saveActiveTab();
      let activeChanged = false;
      let anyChanged = false;
      for (const tab of tabs) {
        const snap =
          tab.id === activeTabRef.current
            ? {
                nodes: nodesRef.current || [],
                edges: edgesRef.current || [],
              }
            : ensureTabGraphLoaded(tab.id);
        const next = applyCreatedNodeToGraph(snap.nodes, snap.edges, definition);
        if (!next.changed) continue;
        anyChanged = true;
        const updated = { nodes: next.nodes, edges: next.edges };
        tabGraphsRef.current[tab.id] = updated;
        persistGraphNow(tab.id, updated);
        if (tab.id === activeTabRef.current) {
          activeChanged = true;
          histApplyingRef.current = true;
          setNodes(updated.nodes);
          setEdges(updated.edges);
          liveRef.current = updated;
          histPrevRef.current = updated;
        }
      }
      if (activeChanged) {
        onDocumentStatus?.(`Updated “${definition.name}” on the canvas`);
      } else if (anyChanged) {
        onDocumentStatus?.(
          `Updated “${definition.name}” on other tabs`,
        );
      }
      setTabs((current) => {
        let touched = false;
        const next = current.map((tab) => {
          if (tab.editingDefinitionId !== definition.id) return tab;
          if (tab.name === definition.name) return tab;
          touched = true;
          return { ...tab, name: definition.name };
        });
        return touched ? next : current;
      });
    },
    [
      edgesRef,
      ensureTabGraphLoaded,
      nodesRef,
      onDocumentStatus,
      persistGraphNow,
      saveActiveTab,
      setEdges,
      setNodes,
      tabs,
    ],
  );

  const stripUsernodesByDefinitionId = useCallback(
    (definitionId: string) => {
      const id = definitionId.trim();
      if (!id) return;
      saveActiveTab();
      let activeChanged = false;
      for (const tab of tabs) {
        const snap =
          tab.id === activeTabRef.current
            ? {
                nodes: nodesRef.current || [],
                edges: edgesRef.current || [],
              }
            : ensureTabGraphLoaded(tab.id);
        const next = stripCreatedNodeFromGraph(snap.nodes, snap.edges, id);
        if (!next.changed) continue;
        const updated = { nodes: next.nodes, edges: next.edges };
        tabGraphsRef.current[tab.id] = updated;
        persistGraphNow(tab.id, updated);
        if (tab.id === activeTabRef.current) {
          activeChanged = true;
          histApplyingRef.current = true;
          setNodes(updated.nodes);
          setEdges(updated.edges);
          liveRef.current = updated;
          histPrevRef.current = updated;
          setSelectedId(null);
          setSelectedIds([]);
        }
      }
      // Close Open Node editing tabs for the deleted definition.
      setTabs((current) => {
        const remaining = current.filter(
          (tab) => tab.editingDefinitionId !== id,
        );
        if (remaining.length === current.length) return current;
        if (!remaining.length) {
          const freshId = uid();
          const blank = { nodes: [] as NbNode[], edges: [] as NbEdge[] };
          tabGraphsRef.current[freshId] = blank;
          persistGraphNow(freshId, blank);
          activeTabRef.current = freshId;
          histApplyingRef.current = true;
          setNodes([]);
          setEdges([]);
          liveRef.current = blank;
          histPrevRef.current = blank;
          setActiveTabId(freshId);
          return [{ id: freshId, name: "Tab 1" }];
        }
        if (!remaining.some((tab) => tab.id === activeTabRef.current)) {
          const nextActive = remaining[0].id;
          activeTabRef.current = nextActive;
          setActiveTabId(nextActive);
          const graph = ensureTabGraphLoaded(nextActive);
          histApplyingRef.current = true;
          setNodes(graph.nodes);
          setEdges(graph.edges);
          liveRef.current = graph;
          histPrevRef.current = graph;
        }
        return remaining;
      });
      if (activeChanged) {
        onDocumentStatus?.("Removed deleted Created Node from the canvas");
      }
    },
    [
      edgesRef,
      ensureTabGraphLoaded,
      nodesRef,
      onDocumentStatus,
      persistGraphNow,
      saveActiveTab,
      setEdges,
      setNodes,
      setSelectedId,
      setSelectedIds,
      tabs,
    ],
  );

  const lastLoadReq = useRef(0);
  useEffect(() => {
    if (!loadRequest || loadRequest.id === lastLoadReq.current) return;
    lastLoadReq.current = loadRequest.id;
    const graph = loadRequest.graph as { nodes?: NbNode[]; edges?: any[] };
    if (graph && (graph.nodes || graph.edges)) {
      openGraphInNewTab(graph, loadRequest.name, {
        savedWorkflowName: loadRequest.savedWorkflowName,
        savedFilePath: loadRequest.savedFilePath,
      });
      onToast("ok", "Workflow loaded", loadRequest.name);
    }
    onLoadConsumed?.();
  }, [loadRequest, onLoadConsumed, onToast, openGraphInNewTab]);

  const onPickNodeFile = useCallback(
    async (path: string) => {
      const mode = nodeFileModal?.mode;
      setNodeFileModal(null);
      const requestSeq = ++openFileSeqRef.current;
      try {
        if (mode === "save") {
          const content = wfEnvelope(
            "node",
            activeTabName() || "workflow",
            fullGraph(),
          );
          const result = await api.saveFile(path, content);
          if (requestSeq !== openFileSeqRef.current) return;
          if (result.error) onToast("error", "Save failed", result.error);
          else {
            setTabs((current) =>
              current.map((tab) =>
                tab.id === activeTabRef.current
                  ? {
                      ...tab,
                      savedFilePath: result.path || path,
                      savedWorkflowName: undefined,
                    }
                  : tab,
              ),
            );
            onToast("ok", "Saved", result.name || path);
          }
          return;
        }
        const result = await api.openFile(path);
        if (requestSeq !== openFileSeqRef.current) return;
        if (result.error || typeof result.content !== "string") {
          onToast("error", "Open failed", result.error || "Empty file.");
          return;
        }
        const baseName = (result.name || "Workflow").replace(
          /\.samql\.json$|\.json$/i,
          "",
        );
        try {
          const created = parseCreatedNodeFile(JSON.parse(result.content));
          if (created.ok) {
            upsertCreatedNode(created.definition);
            onToast(
              "ok",
              "Created node loaded",
              `"${created.definition.name}" is in the palette.`,
            );
            return;
          }
        } catch {
          // Not JSON / not a created-node export — fall through to workflow parsing.
        }
        const envelope = parseWfFile(result.content);
        if (envelope?.kind === "node") {
          openGraphInNewTab(
            envelope.payload as { nodes?: NbNode[]; edges?: any[] },
            envelope.name || baseName,
            { savedFilePath: result.path || path },
          );
          onToast("ok", "Workflow loaded", envelope.name || baseName);
        } else if (envelope) {
          onToast(
            "warn",
            "Not a node workflow",
            `That looks like a ${envelope.kind} workflow — open it from the ${wfKindSurface(envelope.kind)}.`,
          );
        } else {
          try {
            openGraphInNewTab(
              parseNodeFlowGraph(JSON.parse(result.content)),
              baseName,
              { savedFilePath: result.path || path },
            );
            onToast("ok", "Workflow loaded", baseName);
          } catch {
            onToast("error", "Open failed", "Not a node workflow file.");
          }
        }
      } catch (error: any) {
        if (requestSeq !== openFileSeqRef.current) return;
        onToast("error", "File error", error?.message || String(error));
      }
    },
    [activeTabName, fullGraph, nodeFileModal, onToast, openGraphInNewTab],
  );

  const lastNodeCmd = useRef(0);
  useEffect(() => {
    if (!command || command.id === lastNodeCmd.current) return;
    lastNodeCmd.current = command.id;
    if (command.action === "save") void saveWorkflow();
    else if (command.action === "saveAs") setNodeFileModal({ mode: "save" });
    else if (command.action === "open") setNodeFileModal({ mode: "open" });
    else if (command.action === "exportLineage") void exportLineage();
    // selectNode / clearSelection are handled by NodeFlow (selection lives there)
  }, [command, exportLineage, saveWorkflow]);

  return {
    loadedRef,
    liveRef,
    tabs,
    activeTabId,
    activeTabRef,
    editingTab,
    editingName,
    setEditingTab,
    setEditingName,
    historyState,
    nodeFileModal,
    setNodeFileModal,
    persistGraphNow,
    graphForRun,
    fullGraph,
    switchTab,
    addTab,
    closeTab,
    startRenameTab,
    commitRenameTab,
    undo,
    redo,
    activeTabName,
    saveWorkflow,
    exportLineage,
    openGraphInNewTab,
    activeEditingDefinitionId,
    refreshUsernodesFromDefinition,
    stripUsernodesByDefinitionId,
    onPickNodeFile,
  };
}
