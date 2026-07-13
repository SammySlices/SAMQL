import { useEffect } from "react";
import {
  TABS_KEY,
  serializeNodeFlowTabs,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";
import type { NodeFlowTab } from "./NodeFlowTabBar";

export interface NodeFlowSnapshot {
  nodes: NbNode[];
  edges: NbEdge[];
}

interface UseNodeFlowAutosaveOptions {
  loadedRef: { current: boolean };
  activeTabId: string;
  tabs: NodeFlowTab[];
  nodes: NbNode[];
  edges: NbEdge[];
  tabGraphsRef: { current: Record<string, NodeFlowSnapshot> };
  activeTabRef: { current: string };
  liveRef: { current: NodeFlowSnapshot };
  persistGraphNow: (id?: string, snapshot?: NodeFlowSnapshot) => boolean;
  debounceMs?: number;
}

export function useNodeFlowAutosave({
  loadedRef,
  activeTabId,
  tabs,
  nodes,
  edges,
  tabGraphsRef,
  activeTabRef,
  liveRef,
  persistGraphNow,
  debounceMs = 150,
}: UseNodeFlowAutosaveOptions) {
  useEffect(() => {
    if (!loadedRef.current || !activeTabId) return;
    const snapshot = { nodes, edges };
    tabGraphsRef.current[activeTabId] = snapshot;
    const timer = window.setTimeout(() => {
      persistGraphNow(activeTabId, snapshot);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [
    activeTabId,
    debounceMs,
    edges,
    loadedRef,
    nodes,
    persistGraphNow,
    tabGraphsRef,
  ]);

  useEffect(() => {
    const flushAll = () => {
      const active = activeTabRef.current;
      if (active) persistGraphNow(active, liveRef.current);
      for (const [id, snapshot] of Object.entries(tabGraphsRef.current)) {
        if (id !== active) persistGraphNow(id, snapshot);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flushAll();
      window.removeEventListener("pagehide", flushAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeTabRef, liveRef, persistGraphNow, tabGraphsRef]);

  useEffect(() => {
    if (!loadedRef.current || !tabs.length) return;
    try {
      window.localStorage?.setItem(
        TABS_KEY,
        JSON.stringify(serializeNodeFlowTabs(tabs, activeTabId)),
      );
    } catch {
      // Storage can be unavailable in private mode; the live graph still works.
    }
  }, [activeTabId, loadedRef, tabs]);
}
