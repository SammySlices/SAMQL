import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { paletteColors } from "../../lib/chartOption";
import { compositeImages, renderToDataURL } from "../../lib/echart";
import { uid } from "../../lib/ids";
import {
  PORTS,
  type NbEdge,
  type NbNode,
} from "../../lib/nodeFlowModel";
import { NODEFLOW_COSMETIC_CONFIG_KEYS } from "../../lib/nodegraph";
import {
  ancestorNodeIds,
  applyMissingRefPruneToNodes,
  columnProbeReqsForNodes,
} from "../../lib/pruneNodeflowMissingAfterRun";
import { getRunAllParallelNodeflows } from "../../lib/runAllConcurrency";
import { cancelAllRuns, cancelOne, isCancelledError, registerRun, unregisterRun } from "../../lib/runController";
import type { ChartData } from "../../lib/types";
import type { NodeFlowSnapshot } from "./useNodeFlowDocumentController";

/** FE last-run preview rows — enough for a typical Run-all ancestor closure. */
const PREVIEW_CACHE_MAX = 64;
/** Match rememberTableLastRun row cap; keeps seed SELECTs cheap. */
const LAST_RUN_SEED_PREVIEW_LIMIT = 200;

/** Node types whose output is not a table last-run preview. */
const LAST_RUN_SEED_SKIP = new Set([
  "browse",
  "chart",
  "dashboard",
  "text",
  "output",
  "write",
  "iterator",
  "while",
  "variable",
  "samqldash",
  "dyn_output",
  "profile",
  "reconcile",
]);

/**
 * Zero-input load/source nodes. Runnable as Run-all leaves with no inbound
 * wire, and allowed to preview-execute on cache miss (table peek). Connectors
 * (apinode / sqlserver / sharepoint / webscrape) stay off this list — they
 * materialize via Fetch, not bare nodeflowRun.
 */
export const NODEFLOW_SOURCE_TYPES = new Set([
  "input",
  "shred",
  "directory",
  "appendfolder",
  "filebrowser",
  "createtable",
  "sql",
]);

/**
 * Output port to request when a node is a Run-all leaf (no Output/Write).
 * Most nodes expose ``out``; Filter only has ``true``/``false``. Hardcoding
 * ``out`` for Filter yields backend ``Unknown filter output: out`` and empty
 * previews. Join still accepts legacy ``out`` even though the palette shows
 * named ports — keep that so leaf Join behavior is unchanged.
 */
export function leafRunPort(type: string): string {
  const outs = (PORTS as Record<string, { outputs?: string[] } | undefined>)[type]
    ?.outputs;
  if (!outs?.length) return "out";
  if (outs.includes("out")) return "out";
  if (type === "join") return "out";
  return outs[0];
}

/**
 * (node, port) pairs to seed after a successful Run all / leaf run.
 * Wired outgoing ports for intermediates; all declared outs for leaves.
 * Join always seeds all three side outputs (only L / inner / only R) even when
 * only ``inner`` is wired — otherwise left/right Preview stays empty after Run all.
 * Filter always seeds True and False for the same reason (Preview False after a
 * True-only wire must not wait for a cache-miss peek).
 */
export function lastRunSeedRequests(
  nodes: NbNode[],
  edges: NbEdge[],
  terminalIds: Iterable<string>,
): { node: string; port: string }[] {
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const closure = ancestorNodeIds(edges, terminalIds);
  const reqs: { node: string; port: string }[] = [];
  const seen = new Set<string>();
  for (const id of closure) {
    const n = byId.get(id);
    if (!n || LAST_RUN_SEED_SKIP.has(n.type)) continue;
    const outs = PORTS[n.type]?.outputs || [];
    if (!outs.length) continue;
    const used = [
      ...new Set(
        (edges || [])
          .filter(
            (e) => e.from.node === id && outs.includes(e.from.port),
          )
          .map((e) => e.from.port),
      ),
    ];
    const ports =
      n.type === "join" || n.type === "filter"
        ? outs
        : used.length
          ? used
          : outs;
    for (const port of ports) {
      const key = `${id}::${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reqs.push({ node: id, port });
    }
  }
  return reqs;
}

/** Join output ports that may preview-execute on cache miss (plus legacy ``out``). */
export function isJoinSidePreviewPort(port: string): boolean {
  return (
    port === "out" ||
    port === "inner" ||
    port === "left_only" ||
    port === "right_only"
  );
}

/** Filter True/False ports may preview-execute on cache miss (like Join sides). */
export function isFilterPreviewPort(port: string): boolean {
  return port === "true" || port === "false";
}

/** Downstream closure of root node ids (includes the roots). */
export function descendantNodeIds(
  edges: NbEdge[],
  rootIds: Iterable<string>,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const e of edges || []) {
    const list = outgoing.get(e.from.node) || [];
    list.push(e.to.node);
    outgoing.set(e.from.node, list);
  }
  const out = new Set<string>();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of outgoing.get(id) || []) stack.push(child);
  }
  return out;
}

const COSMETIC_CONFIG_KEYS = new Set<string>(NODEFLOW_COSMETIC_CONFIG_KEYS);

/**
 * True when a config patch changes anything execution-relevant. Cosmetic keys
 * (label / style / body size / collapsed) never invalidate last-run previews.
 */
export function isSemanticConfigPatch(
  currentConfig: Record<string, unknown> | null | undefined,
  patchConfig: Record<string, unknown> | null | undefined,
): boolean {
  const before = currentConfig || {};
  for (const key of Object.keys(patchConfig || {})) {
    if (COSMETIC_CONFIG_KEYS.has(key)) continue;
    const prev = before[key];
    const next = (patchConfig as Record<string, unknown>)[key];
    if (prev === next) continue;
    try {
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) {
        continue;
      }
    } catch {
      /* non-serialisable values: treat as changed */
    }
    return true;
  }
  return false;
}

export type NodeFlowPreview =
  | {
      kind: "table";
      title: string;
      columns: string[];
      rows: unknown[][];
      total: number;
      limited?: boolean;
      /** Terminal node whose output this preview shows (for column lineage). */
      sourceNodeId?: string;
      sourcePort?: string;
    }
  | { kind: "chart"; title: string; data: ChartData }
  | {
      kind: "profile";
      title: string;
      total: number;
      columns: Record<string, any>[];
      limited?: boolean;
    }
  | {
      kind: "report";
      title: string;
      totals: Record<string, number>;
      fields: {
        field: string;
        label?: string;
        matching: number;
        non_matching: number;
        a_only: number;
        b_only: number;
      }[];
    };

type LastRunTablePreview = Extract<NodeFlowPreview, { kind: "table" }>;

/**
 * Module-scoped last-run preview cache. App also keeps NodeFlow mounted
 * via display:none across IDE / Journal / Dashboard switches (same as
 * Journal), but this Map still survives a true remount (StrictMode,
 * dashReload-style remount, or a future layout change). A component
 * useRef alone would wipe Run-all seeds on that remount. Persist here
 * until Run all start, dataEpoch bump, workflow-tab reset, or explicit
 * clear — not App view switches.
 */
const lastRunPreviewCache = new Map<string, LastRunTablePreview>();

/** Test helper: drop module cache between cases so seeds do not leak. */
export function clearLastRunPreviewCacheForTests(): void {
  lastRunPreviewCache.clear();
}

interface UseNodeFlowExecutionControllerOptions {
  activeTabId: string;
  nodes: NbNode[];
  edges: NbEdge[];
  liveRef: React.MutableRefObject<NodeFlowSnapshot>;
  /** Retained for call-site stability; last-run keys no longer salt on it. */
  graphSig: string;
  /** Backend Session._data_epoch — included in preview cache keys. */
  dataEpoch?: number;
  graphForApi: () => any;
  graphForRun: () => any;
  childCtx: (id: string | null) =>
    | { groupId: string; index: number; child: NbNode }
    | null;
  partialGroupGraph: (groupId: string, count: number) => any;
  patch: (id: string, config: Record<string, any>) => void;
  setNodes: React.Dispatch<React.SetStateAction<NbNode[]>>;
  setNodeErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setNodeWarnings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onToast: (
    kind: "ok" | "error" | "warn",
    title: string,
    message?: string,
  ) => void;
  onTablesChanged?: () => void;
  fireRipple: () => void;
}

type AuxRequestOwner = {
  key: string;
  generation: number;
  scope: number;
  controller: AbortController;
  queryId?: string;
};

export function useNodeFlowExecutionController({
  activeTabId,
  nodes,
  edges,
  liveRef,
  graphSig: _graphSig,
  dataEpoch = 0,
  graphForApi,
  graphForRun,
  childCtx,
  partialGroupGraph,
  patch,
  setNodes,
  setNodeErrors,
  setNodeWarnings,
  onToast,
  onTablesChanged,
  fireRipple,
}: UseNodeFlowExecutionControllerOptions) {
  const [preview, setPreview] = useState<NodeFlowPreview | null>(null);
  const [previewHeight, setPreviewHeight] = useState(300);
  const [running, setRunning] = useState(false);
  const [runningNodeIds, setRunningNodeIds] = useState<Set<string>>(new Set());
  const [runId, setRunId] = useState<string | null>(null);
  const runDepth = useRef(0);
  const cancelRequested = useRef(false);
  const activeRunIds = useRef<Set<string>>(new Set());
  const runIdRef = useRef<string | null>(null);
  const runScopesRef = useRef<Map<string, number>>(new Map());
  const runNodeIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const runningNodeCountsRef = useRef<Map<string, number>>(new Map());
  const scopeVersionRef = useRef(0);
  const previousTabRef = useRef(activeTabId);
  const mountedRef = useRef(true);
  const auxGenerationRef = useRef<Map<string, number>>(new Map());
  const auxRequestsRef = useRef<Map<string, AuxRequestOwner>>(new Map());
  const chartPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const cancelRecoveryTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<{
    kind: "idle" | "running" | "done" | "cancelled" | "error";
    text: string;
  }>({ kind: "idle", text: "Ready" });
  const [browseFolder, setBrowseFolder] = useState(false);
  const [dirList, setDirList] = useState<{
    folder: string;
    files: { name: string; path: string; ext: string }[];
    loading: boolean;
    error?: string;
  }>({ folder: "", files: [], loading: false });
  const doPreviewRef = useRef<
    ((node: NbNode, port: string, title: string) => void) | null
  >(null);
  // Shared module Map — survives App IDE/Journal remount of NodeFlow.
  const previewCache = useRef(lastRunPreviewCache);
  const previewEpochRef = useRef(dataEpoch);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const dataEpochRef = useRef(dataEpoch);
  dataEpochRef.current = dataEpoch;
  /** Open drawer snapshot — used to refresh after Run all seeds last-run cache. */
  const previewRef = useRef<NodeFlowPreview | null>(null);
  previewRef.current = preview;

  // Last-run keys intentionally omit graphSig. Post-run missing-ref prune (and
  // other config patches) change executionGraphSignature while the rows are
  // still the latest run — salting by graphSig orphaned seeds so the next
  // output click said "no cached results" (often noticed after an IDE tab
  // round-trip). Invalidate by clearing on Run all / dataEpoch / workflow tab,
  // plus targeted downstream invalidation on user config edits / rewiring
  // (patchNode + the edge-diff effect below).
  const previewCacheKey = (nodeId: string, port: string) =>
    `${activeTabIdRef.current}::${dataEpochRef.current}::${nodeId}::${port}`;

  /**
   * Drop last-run previews for the given nodes AND everything downstream of
   * them; a stale pre-edit table must never be served as "(cached)" after an
   * upstream config or wiring change. If the open drawer shows one of those
   * nodes, clear it too — the rows on screen are no longer the latest intent.
   */
  const invalidateLastRunDownstream = (rootIds: Iterable<string>) => {
    const closure = descendantNodeIds(liveRef.current.edges, rootIds);
    if (!closure.size) return;
    for (const key of [...previewCache.current.keys()]) {
      // Key layout: tab::epoch::nodeId::port (node/port never contain "::").
      const parts = key.split("::");
      const nodeId = parts[parts.length - 2];
      if (nodeId && closure.has(nodeId)) previewCache.current.delete(key);
    }
    const open = previewRef.current;
    if (
      open &&
      open.kind === "table" &&
      open.sourceNodeId &&
      closure.has(open.sourceNodeId)
    ) {
      setPreview(null);
      setStatus({
        kind: "idle",
        text: "Flow edited — run or preview again for fresh results",
      });
    }
  };

  /**
   * Config patch that also invalidates stale last-run previews downstream of
   * the edited node (group children invalidate from their container). The
   * automatic post-run missing-ref prune bypasses this on purpose — those
   * patches describe the run that just happened, not a user edit.
   */
  const patchNode = (id: string, config: Record<string, any>) => {
    const top = liveRef.current.nodes.find((n) => n.id === id);
    const cctx = top ? null : childCtx(id);
    const target = top || cctx?.child || null;
    if (target && isSemanticConfigPatch(target.config, config)) {
      invalidateLastRunDownstream([cctx ? cctx.groupId : id]);
    }
    patch(id, config);
  };

  // Rewiring changes what flows into the edge's target: invalidate the
  // target-side downstream closure for added AND removed wires. Tab switches
  // already clear the whole cache (resetExecutionScope) — skip their diff.
  const edgeSigRef = useRef<string[] | null>(null);
  const edgeSigTabRef = useRef(activeTabId);
  useEffect(() => {
    const sig = (edges || []).map(
      (e) => `${e.from.node}>${e.from.port}>${e.to.node}>${e.to.port}`,
    );
    const prev = edgeSigRef.current;
    edgeSigRef.current = sig;
    if (edgeSigTabRef.current !== activeTabId) {
      edgeSigTabRef.current = activeTabId;
      return;
    }
    if (prev === null) return;
    const prevSet = new Set(prev);
    const curSet = new Set(sig);
    const affected = new Set<string>();
    for (const k of curSet) {
      if (!prevSet.has(k)) affected.add(k.split(">")[2]);
    }
    for (const k of prevSet) {
      if (!curSet.has(k)) affected.add(k.split(">")[2]);
    }
    if (affected.size) invalidateLastRunDownstream(affected);
    // invalidateLastRunDownstream reads only refs; edges/tab drive the diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, activeTabId]);

  /** Store last-run table rows for a node/port so later output clicks reuse them. */
  const rememberTableLastRun = (
    cacheNodeId: string,
    cachePort: string,
    title: string,
    result: {
      columns?: string[];
      rows?: unknown[][];
      total_rows?: number;
      preview_limited?: boolean;
    },
    /** Terminal lineage id (may differ for group-child previews). */
    sourceNodeId?: string,
    sourcePort?: string,
  ) => {
    const pv: Extract<NodeFlowPreview, { kind: "table" }> = {
      kind: "table",
      title,
      columns: result.columns || [],
      rows: (result.rows || []).slice(0, 200),
      total: result.total_rows || 0,
      limited: !!result.preview_limited,
      sourceNodeId: sourceNodeId || cacheNodeId,
      sourcePort: sourcePort || cachePort,
    };
    const cacheKey = previewCacheKey(cacheNodeId, cachePort);
    previewCache.current.set(cacheKey, pv);
    if (previewCache.current.size > PREVIEW_CACHE_MAX) {
      const oldest = previewCache.current.keys().next().value;
      if (oldest !== undefined) previewCache.current.delete(oldest);
    }
    return pv;
  };

  /**
   * After terminals succeed, fetch preview rows for every data node in the
   * ancestor closure and store them under that node's id/port. Backend run
   * APIs only return terminal envelopes; intermediates were never remembered.
   * Preview-limited so this does not rematerialize full tables for tracing.
   */
  const seedLastRunCaches = async (terminalIds: string[]) => {
    if (!terminalIds.length || cancelRequested.current) return;
    const snapNodes = liveRef.current.nodes;
    const snapEdges = liveRef.current.edges;
    const requests = lastRunSeedRequests(snapNodes, snapEdges, terminalIds);
    if (!requests.length) return;
    // Backend run_nodeflows caps at 64 targets.
    const capped = requests.slice(0, 64);
    const id = uid("nblr");
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.nodeflowRunBatch(
        graphForRun(),
        capped,
        id,
        ctrl.signal,
        true,
        LAST_RUN_SEED_PREVIEW_LIMIT,
      );
      if (
        cancelRequested.current ||
        !mountedRef.current ||
        r.cancelled ||
        !r.ok ||
        !r.results
      ) {
        return;
      }
      const byId = new Map(snapNodes.map((n) => [n.id, n]));
      for (const x of r.results) {
        if (!x || x.error || x.cancelled) continue;
        const n = byId.get(x.node);
        const port = x.port || "out";
        rememberTableLastRun(
          x.node,
          port,
          `${n?.config?.label || x.node} · ${port}`,
          x,
        );
      }
    } catch {
      /* best-effort; terminals may already be remembered */
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  /** After Run all, open drawer must show the new last-run rows (not pre-run). */
  const refreshOpenPreviewFromLastRun = () => {
    const open = previewRef.current;
    if (!open || open.kind !== "table" || !open.sourceNodeId) return;
    const key = previewCacheKey(
      open.sourceNodeId,
      open.sourcePort || "out",
    );
    const hit = previewCache.current.get(key);
    if (hit) setPreview(hit);
    else setPreview(null);
  };

  const isRunCurrent = (id: string) =>
    mountedRef.current && runScopesRef.current.get(id) === scopeVersionRef.current;

  const publishRunningNodes = () => {
    setRunningNodeIds(new Set(runningNodeCountsRef.current.keys()));
  };

  const markRunNodes = (runId: string, nodeIds: Iterable<string | null | undefined>) => {
    const ids = new Set([...nodeIds].filter((id): id is string => !!id));
    if (!ids.size) return;
    runNodeIdsRef.current.set(runId, ids);
    for (const nodeId of ids) {
      runningNodeCountsRef.current.set(
        nodeId,
        (runningNodeCountsRef.current.get(nodeId) || 0) + 1,
      );
    }
    publishRunningNodes();
  };

  const clearRunNodes = (runId: string) => {
    const ids = runNodeIdsRef.current.get(runId);
    if (!ids) return;
    runNodeIdsRef.current.delete(runId);
    for (const nodeId of ids) {
      const next = (runningNodeCountsRef.current.get(nodeId) || 1) - 1;
      if (next > 0) runningNodeCountsRef.current.set(nodeId, next);
      else runningNodeCountsRef.current.delete(nodeId);
    }
    publishRunningNodes();
  };

  const clearAllRunningNodes = (publish = true) => {
    runNodeIdsRef.current.clear();
    runningNodeCountsRef.current.clear();
    if (publish) publishRunningNodes();
  };

  const abortAuxRequests = () => {
    for (const owner of auxRequestsRef.current.values()) {
      if (owner.queryId) cancelOne(owner.queryId, owner.controller);
      else {
        try {
          owner.controller.abort();
        } catch {
          // Best-effort cancellation only.
        }
      }
    }
    auxRequestsRef.current.clear();
    chartPromisesRef.current.clear();
  };

  // Data mutations bump the session epoch (file change / load). Drop any
  // FE preview hits AND the open drawer so prior rows cannot look current.
  // Abort in-flight preview/chart/validate so completions cannot repaint stale.
  useEffect(() => {
    if (previewEpochRef.current === dataEpoch) return;
    previewEpochRef.current = dataEpoch;
    abortAuxRequests();
    previewCache.current.clear();
    setPreview(null);
  }, [dataEpoch]);

  const beginAuxRequest = (key: string, queryId?: string): AuxRequestOwner => {
    const previous = auxRequestsRef.current.get(key);
    if (previous) {
      if (previous.queryId) cancelOne(previous.queryId, previous.controller);
      else {
        try {
          previous.controller.abort();
        } catch {
          // Best-effort replacement only.
        }
      }
    }
    const generation = (auxGenerationRef.current.get(key) || 0) + 1;
    auxGenerationRef.current.set(key, generation);
    const controller = new AbortController();
    if (queryId) registerRun(queryId, controller);
    const owner = {
      key,
      generation,
      scope: scopeVersionRef.current,
      controller,
      queryId,
    };
    auxRequestsRef.current.set(key, owner);
    return owner;
  };

  const finishAuxRequest = (owner: AuxRequestOwner) => {
    if (owner.queryId) unregisterRun(owner.queryId, owner.controller);
    if (auxRequestsRef.current.get(owner.key) === owner) {
      auxRequestsRef.current.delete(owner.key);
    }
  };

  const cancelAuxRequest = (key: string) => {
    const owner = auxRequestsRef.current.get(key);
    if (!owner) return;
    if (owner.queryId) cancelOne(owner.queryId, owner.controller);
    else {
      try {
        owner.controller.abort();
      } catch {
        // Best-effort cancellation only.
      }
    }
    if (owner.queryId) unregisterRun(owner.queryId, owner.controller);
    auxRequestsRef.current.delete(key);
    chartPromisesRef.current.delete(key);
  };

  const isAuxRequestCurrent = (owner: AuxRequestOwner) =>
    mountedRef.current &&
    owner.scope === scopeVersionRef.current &&
    auxGenerationRef.current.get(owner.key) === owner.generation &&
    auxRequestsRef.current.get(owner.key) === owner;

  /**
   * Cancel in-flight work for this mount / workflow tab.
   * clearLastRunCache: true for workflow-tab switches (stale graph);
   * false on App view unmount so IDE / Journal / Dashboard round-trips
   * keep Run-all seeds in the module Map.
   */
  const resetExecutionScope = (
    updateUi: boolean,
    clearLastRunCache = true,
  ) => {
    scopeVersionRef.current += 1;
    const ids = [...activeRunIds.current];
    if (ids.length) cancelAllRuns(ids);
    abortAuxRequests();
    activeRunIds.current.clear();
    runScopesRef.current.clear();
    clearAllRunningNodes(updateUi);
    runDepth.current = 0;
    runIdRef.current = null;
    cancelRequested.current = false;
    if (clearLastRunCache) previewCache.current.clear();
    if (cancelRecoveryTimerRef.current != null) {
      window.clearTimeout(cancelRecoveryTimerRef.current);
      cancelRecoveryTimerRef.current = null;
    }
    if (!updateUi) return;
    setRunning(false);
    setRunId(null);
    setPreview(null);
    setStatus({ kind: "idle", text: "Ready" });
    setChartData({});
    chartDataRef.current = {};
    setValidateResults({});
    setDirList({ folder: "", files: [], loading: false });
  };

  useLayoutEffect(() => {
    if (previousTabRef.current === activeTabId) return;
    const prev = previousTabRef.current;
    previousTabRef.current = activeTabId;
    // Document controller boots activeTabId as "" then the real tab id.
    // That bootstrap (and any empty id) is not a workflow switch — a remount
    // after IDE/Journal/Dashboard must keep module last-run seeds.
    const isBootstrap = !prev || !activeTabId;
    resetExecutionScope(true, !isBootstrap);
    // resetExecutionScope intentionally reads only current refs and stable state
    // setters; re-running for function identity would cancel active work on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel runs/aux only — keep module last-run cache for remount.
      resetExecutionScope(false, false);
    };
    // One mount lifetime owns one cancellation scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // run / preview -----------------------------------------------------------
  const newRunId = () => uid() + uid();
  const startRun = (
    text: string,
    nodeIds: Iterable<string | null | undefined> = [],
  ): string => {
    if (cancelRecoveryTimerRef.current != null) {
      window.clearTimeout(cancelRecoveryTimerRef.current);
      cancelRecoveryTimerRef.current = null;
    }
    const id = newRunId();
    if (runDepth.current === 0) cancelRequested.current = false; // fresh batch
    runDepth.current += 1; // keep "running" true until the LAST run finishes
    runIdRef.current = id;
    activeRunIds.current.add(id);
    runScopesRef.current.set(id, scopeVersionRef.current);
    setRunId(id);
    setRunning(true);
    setStatus({ kind: "running", text });
    markRunNodes(id, nodeIds);
    return id;
  };
  const finishRun = (
    id: string,
    r: { error?: string; cancelled?: boolean } | null,
    okText: string,
  ) => {
    if (!isRunCurrent(id)) return;
    runScopesRef.current.delete(id);
    activeRunIds.current.delete(id);
    clearRunNodes(id);
    if (runDepth.current === 0) {
      // Nothing is considered active. This is either a defensive double-finish
      // or the late result of a run we already force-recovered from after a
      // stalled cancel (see cancelRun). Either way, leave the idle / recovered
      // UI untouched so a straggler can't wipe a fresh run's spinner or status.
      return;
    }
    runDepth.current -= 1;
    const stillRunning = runDepth.current > 0;
    setRunning(stillRunning);
    if (!stillRunning) {
      if (cancelRecoveryTimerRef.current != null) {
        window.clearTimeout(cancelRecoveryTimerRef.current);
        cancelRecoveryTimerRef.current = null;
      }
      setRunId(null);
      runIdRef.current = null;
      activeRunIds.current.clear();
    }
    if (r?.cancelled) setStatus({ kind: "cancelled", text: "Cancelled" });
    else if (r?.error) setStatus({ kind: "error", text: r.error });
    else {
      setStatus({ kind: "done", text: okText });
      fireRipple();
    }
  };
  // Pull the UI out of a stalled run/cancel without a page refresh. The backend
  // run is interrupted (cancelRun) but a wedged DuckDB op may never return its
  // POST; rather than leave the user stuck on "Cancelling…" forever, reset the
  // run state to idle. Any late straggler is swallowed by finishRun's
  // runDepth===0 guard, so this can't desync a subsequent run.
  const forceRecoverFromCancel = () => {
    if (runDepth.current === 0) return;
    runDepth.current = 0;
    runIdRef.current = null;
    // .552: clear the cancel flag as part of recovery, so the NEXT run
    // starts clean -- otherwise a stale `true` here survived (the next
    // startRun only resets when runDepth===0, which it now is) and every
    // subsequent terminal reported cancelled.
    cancelRequested.current = false;
    activeRunIds.current.clear();
    runScopesRef.current.clear();
    clearAllRunningNodes();
    if (cancelRecoveryTimerRef.current != null) {
      window.clearTimeout(cancelRecoveryTimerRef.current);
      cancelRecoveryTimerRef.current = null;
    }
    setRunning(false);
    setRunId(null);
    setStatus({ kind: "cancelled", text: "Cancelled" });
  };
  const cancelRun = async () => {
    // Stop is a global halt. First, always flag + interrupt any background tray
    // task (loads, conversions, flattens) so it stops too -- even when nothing
    // is running foreground in the NodeFlow (cancelAll is a harmless no-op when
    // there is nothing to stop). Then, if a foreground run is active, hard-kill
    // it as well and arm the grace timer.
    const ids = [...activeRunIds.current];
    const stuckId = runIdRef.current;
    void api.cancelAll().catch(() => {});
    if (!ids.length) return;
    cancelRequested.current = true;
    setStatus({ kind: "running", text: "Cancelling…" });
    try {
      // Hard kill: abort every in-flight run fetch (so no request lingers) AND
      // interrupt every backend run in this batch (so no engine statement keeps
      // going). cancelAllRuns aborts this controller's registered fetches and
      // interrupts the matching backend query IDs without touching unrelated API calls.
      cancelAllRuns(ids);
    } catch {
      /* best effort */
    }
    // If the run honours the interrupt it returns promptly and finishRun shows
    // "Cancelled". But a wedged backend run can fail to return, which used to
    // strand the UI on "Cancelling…" until a manual refresh. After a short
    // grace period, recover the UI ourselves -- but only if we're still stuck
    // on the SAME run (a new run, or a normal finish, clears runIdRef).
    if (cancelRecoveryTimerRef.current != null) {
      window.clearTimeout(cancelRecoveryTimerRef.current);
    }
    cancelRecoveryTimerRef.current = window.setTimeout(() => {
      cancelRecoveryTimerRef.current = null;
      if (runDepth.current > 0 && runIdRef.current === stuckId) {
        forceRecoverFromCancel();
      }
    }, 4000);
  };
  // a run outcome counts as cancelled if the backend said so OR the user has
  // asked to stop -- so an interrupted statement that unwinds as a plain error
  // (e.g. a half-built temp table) is reported as "Cancelled", not a failure.
  const wasCancelled = (
    r: { cancelled?: boolean } | null,
    id?: string,
  ) =>
    !!r?.cancelled || cancelRequested.current || (id ? !isRunCurrent(id) : false);

  const doPreview = async (node: NbNode, port: string, title: string) => {
    // Prefer last-run cache (seeded by Run all / leaf run). Cleared on
    // workflow-tab switch / dataEpoch bump / Run-all start. Survives App
    // IDE / Journal / Dashboard switches.
    //
    // Policy:
    // - Load/source (incl. SQL): preview-limited nodeflowRun on miss (table peek).
    // - Join side outputs (only L / inner / only R / legacy out): same peek —
    //   otherwise left/right Preview stays empty until a seed that often only
    //   covers the wired ``inner`` port.
    // - Filter True/False: same peek — users expect Preview True to show
    //   matching rows (e.g. order_id = 101) without a prior Run all seed.
    // - Join input ports (left / right): resolve the wired parent and preview
    //   that upstream output (source parents may peek; other transforms stay
    //   cache-only).
    // - Other transforms (Select/…): cache-only on miss so a port click
    //   never starts a full pipeline.
    const cacheKey = previewCacheKey(node.id, port);
    const hit = previewCache.current.get(cacheKey);
    if (hit) {
      setPreview({ ...hit, title: title || hit.title });
      previewCache.current.delete(cacheKey); // refresh LRU position
      previewCache.current.set(cacheKey, {
        ...hit,
        title: title || hit.title,
      });
      setStatus({
        kind: "done",
        text: `${(hit.total || 0).toLocaleString()} rows (cached)`,
      });
      return;
    }

    // Join left/right inputs → peek the connected upstream node/port.
    if (node.type === "join" && (port === "left" || port === "right")) {
      const snap = liveRef.current;
      const edge = (snap.edges || []).find(
        (e) => e.to.node === node.id && e.to.port === port,
      );
      const previewTitle =
        title || `${node.config.label || node.id} · ${port}`;
      if (!edge) {
        setPreview({
          kind: "table",
          title: previewTitle,
          columns: [],
          rows: [],
          total: 0,
          sourceNodeId: node.id,
          sourcePort: port,
        });
        setStatus({
          kind: "idle",
          text: `Connect the ${port} input`,
        });
        return;
      }
      const parent = (snap.nodes || []).find((n) => n.id === edge.from.node);
      if (!parent) {
        setPreview({
          kind: "table",
          title: previewTitle,
          columns: [],
          rows: [],
          total: 0,
          sourceNodeId: node.id,
          sourcePort: port,
        });
        setStatus({
          kind: "idle",
          text: `Connect the ${port} input`,
        });
        return;
      }
      await doPreview(parent, edge.from.port, previewTitle);
      return;
    }

    const mayPeek =
      NODEFLOW_SOURCE_TYPES.has(node.type) ||
      (node.type === "join" && isJoinSidePreviewPort(port)) ||
      (node.type === "filter" && isFilterPreviewPort(port));

    if (!mayPeek) {
      // Empty / stale transform: open the drawer with no rows so the click
      // is visible, but do not call nodeflowRun / startRun.
      setPreview({
        kind: "table",
        title: title || `${node.config.label || node.id} · ${port}`,
        columns: [],
        rows: [],
        total: 0,
        sourceNodeId: node.id,
        sourcePort: port,
      });
      setStatus({
        kind: "idle",
        text: "No cached results — use Run all",
      });
      return;
    }

    // Source / Join-side / Filter peek: preview-limited nodeflowRun.
    const previewTitle =
      title || `${node.config.label || node.id} · ${port}`;
    const id = startRun(`Previewing ${node.config.label || node.id}…`, [
      node.id,
    ]);
    const cctx = childCtx(node.id);
    const graph = cctx
      ? partialGroupGraph(cctx.groupId, cctx.index + 1)
      : graphForRun();
    const runNode = cctx ? cctx.groupId : node.id;
    const runPort = cctx ? "out" : port;
    try {
      const ctrl = new AbortController();
      registerRun(id, ctrl);
      let r;
      try {
        r = await api.nodeflowRun(
          graph,
          runNode,
          runPort,
          id,
          ctrl.signal,
          true,
          LAST_RUN_SEED_PREVIEW_LIMIT,
        );
      } finally {
        unregisterRun(id, ctrl);
      }
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      if (r.error) {
        const culprit = (r as { node?: string }).node || node.id;
        setNodeErrors((p) => ({ ...p, [culprit]: r.error as string }));
        finishRun(id, r, "");
        setPreview({
          kind: "table",
          title: previewTitle,
          columns: [],
          rows: [],
          total: 0,
          sourceNodeId: node.id,
          sourcePort: port,
        });
        return;
      }
      setNodeErrors((p) => {
        if (!(node.id in p)) return p;
        const { [node.id]: _drop, ...rest } = p;
        return rest;
      });
      // Cache under the clicked node/port so inspector Preview and the
      // output-port click share the same last-run key.
      const pv = rememberTableLastRun(
        node.id,
        port,
        previewTitle,
        r,
        node.id,
        port,
      );
      setPreview(pv);
      finishRun(
        id,
        r,
        `${(r.total_rows || 0).toLocaleString()}${
          r.preview_limited ? "+" : ""
        } rows preview`,
      );
    } catch (e: any) {
      if (
        !isRunCurrent(id) ||
        cancelRequested.current ||
        isCancelledError(e, id)
      ) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      setNodeErrors((p) => ({
        ...p,
        [node.id]: e.message || String(e),
      }));
      finishRun(id, { error: e.message || String(e) }, "");
      setPreview({
        kind: "table",
        title: previewTitle,
        columns: [],
        rows: [],
        total: 0,
        sourceNodeId: node.id,
        sourcePort: port,
      });
    }
  };

  // After a successful run/rerun, drop obsolete missing column refs from
  // nodes in the successful terminals' ancestor closure. Schema refresh alone
  // keeps tombstones; this is the automatic cleanup path.
  const pruneMissingRefsAfterSuccessfulRun = async (
    successfulTerminalIds: string[],
  ) => {
    if (!successfulTerminalIds.length) return;
    const snapNodes = liveRef.current.nodes;
    const snapEdges = liveRef.current.edges;
    const targets = ancestorNodeIds(snapEdges, successfulTerminalIds);
    const probes = columnProbeReqsForNodes(snapNodes, snapEdges, targets);
    if (!probes.length) return;
    try {
      const r = await api.nodeflowColumnsBatch(
        graphForRun(),
        probes.map((q) => ({ node: q.fromNode, port: q.fromPort })),
      );
      const colsByNodeId: Record<string, Record<string, string[]>> = {};
      (r.results || []).forEach((res, i) => {
        const q = probes[i];
        if (!q || !res?.columns?.length) return;
        if (!colsByNodeId[q.nodeId]) colsByNodeId[q.nodeId] = {};
        colsByNodeId[q.nodeId][q.port] = res.columns;
      });
      if (!Object.keys(colsByNodeId).length) return;
      setNodes((prev) =>
        applyMissingRefPruneToNodes(prev, targets, colsByNodeId),
      );
    } catch {
      /* best-effort post-run cleanup */
    }
  };

  // run a node's pipeline to completion (no Output node needed). Results stay
  // out of the preview drawer until the user clicks an output port (doPreview).
  const runLeaf = async (node: NbNode): Promise<RunOutcome> => {
    const id = startRun(`Running ${node.config.label}…`, [node.id]);
    const cctx = childCtx(node.id);
    const graph = cctx
      ? partialGroupGraph(cctx.groupId, cctx.index + 1)
      : graphForRun();
    const runNode = cctx ? cctx.groupId : node.id;
    // Filter (and similar) leaves must use a declared output — not hardcoded "out".
    const port = leafRunPort(node.type);
    try {
      const ctrl = new AbortController();
      registerRun(id, ctrl);
      let r;
      try {
        r = await api.nodeflowRun(graph, runNode, port, id, ctrl.signal);
      } finally {
        unregisterRun(id, ctrl);
      }
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      if (r.error) {
        setNodeErrors((p) => ({ ...p, [node.id]: r.error as string }));
        finishRun(id, r, "");
        return { ok: false };
      }
      setNodeErrors((p) => {
        if (!(node.id in p)) return p;
        const { [node.id]: _drop, ...rest } = p;
        return rest;
      });
      // Seed last-run cache so a later output click reuses this run's rows.
      rememberTableLastRun(
        runNode,
        port,
        `${node.config.label || node.id} · ${port}`,
        r,
      );
      finishRun(id, r, `${(r.total_rows || 0).toLocaleString()} rows`);
      await pruneMissingRefsAfterSuccessfulRun([node.id]);
      return { ok: true };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      setNodeErrors((p) => ({ ...p, [node.id]: e.message || String(e) }));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  // Run several top-level terminal branches through the backend's one-pass
  // scheduler. Shared ancestors are computed once; disjoint DuckDB branches
  // execute on separate registered child connections. Group children retain
  // their partial-graph semantics and therefore stay on runLeaf individually.
  const runLeafBatch = async (leaves: NbNode[]): Promise<RunOutcome[]> => {
    const id = startRun(
      `Running ${leaves.length} NodeFlow branches…`,
      leaves.map((node) => node.id),
    );
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.nodeflowRunBatch(
        graphForRun(),
        leaves.map((n) => ({ node: n.id, port: leafRunPort(n.type) })),
        id,
        ctrl.signal,
      );
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return leaves.map(() => ({ ok: false, cancelled: true }));
      }
      if (r.error || !r.ok || !r.results) {
        finishRun(id, { error: r.error || "Batch run failed." }, "");
        if (r.error) {
          setNodeErrors((prev) => {
            const next = { ...prev };
            for (const n of leaves) next[n.id] = r.error as string;
            return next;
          });
        }
        return leaves.map(() => ({ ok: false }));
      }
      const byId = new Map(r.results.map((x) => [x.node, x]));
      const outcomes = leaves.map((n): RunOutcome => {
        const x = byId.get(n.id);
        if (!x || x.error) {
          setNodeErrors((prev) => ({
            ...prev,
            [n.id]: x?.error || "The branch returned no result.",
          }));
          return { ok: false };
        }
        if (x.cancelled) return { ok: false, cancelled: true };
        setNodeErrors((prev) => {
          if (!(n.id in prev)) return prev;
          const { [n.id]: _drop, ...rest } = prev;
          return rest;
        });
        const port = x.port || leafRunPort(n.type);
        rememberTableLastRun(
          n.id,
          port,
          `${n.config.label || n.id} · ${port}`,
          x,
        );
        return { ok: true };
      });
      // Do not auto-open the preview drawer on run success; the user opens
      // results by clicking a node's output port (doPreview). Last-run rows
      // are already seeded above for those clicks.
      finishRun(id, 
        r,
        `${outcomes.filter((x) => x.ok).length} of ${leaves.length} branches ran`,
      );
      const okIds = leaves
        .filter((_, i) => outcomes[i]?.ok)
        .map((n) => n.id);
      await pruneMissingRefsAfterSuccessfulRun(okIds);
      return outcomes;
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return leaves.map(() => ({ ok: false, cancelled: true }));
      }
      const msg = e?.message || String(e);
      setNodeErrors((prev) => {
        const next = { ...prev };
        for (const n of leaves) next[n.id] = msg;
        return next;
      });
      finishRun(id, { error: msg }, "");
      return leaves.map(() => ({ ok: false }));
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  // ---- on-canvas charts + dashboard --------------------------------------
  // cache of rendered chart data per chart-node id (used under chart nodes and
  // inside dashboard panes).
  const [chartData, setChartData] = useState<
    Record<string, { data?: ChartData; loading?: boolean; error?: string }>
  >({});
  const chartDataRef = useRef(chartData);
  useLayoutEffect(() => {
    chartDataRef.current = chartData;
  }, [chartData]);
  const setChartEntry = (
    nodeId: string,
    entry: { data?: ChartData; loading?: boolean; error?: string },
  ) => {
    const next = { ...chartDataRef.current, [nodeId]: entry };
    chartDataRef.current = next;
    setChartData(next);
  };
  // validate-node check results, keyed by node id
  const [validateResults, setValidateResults] = useState<
    Record<
      string,
      {
        ok?: boolean;
        total_rows?: number;
        results?: { type: string; target: string; pass: boolean; detail: string }[];
        error?: string;
        loading?: boolean;
      }
    >
  >({});
  // Latest-data wins: canvas charts / validate panels must not keep pre-mutation
  // aggregates after the session epoch advances.
  const chartEpochRef = useRef(dataEpoch);
  useEffect(() => {
    if (chartEpochRef.current === dataEpoch) return;
    chartEpochRef.current = dataEpoch;
    chartDataRef.current = {};
    setChartData({});
    setValidateResults({});
    chartPromisesRef.current.clear();
  }, [dataEpoch]);
  // the chart node feeding a given dashboard input port (if any)
  const upstreamChartNode = (dash: NbNode, inPort: string): NbNode | null => {
    const e = edges.find((x) => x.to.node === dash.id && x.to.port === inPort);
    if (!e) return null;
    const src = nodes.find((n) => n.id === e.from.node);
    return src && src.type === "chart" ? src : null;
  };
  doPreviewRef.current = doPreview;

  // Map a UI chart type to the data shape the backend produces. area reuses the
  // bar (category + series) shape and donut reuses the pie (category + value)
  // shape; the real UI type is re-attached client-side so the renderer can draw
  // the variant. bar / line / pie / scatter / histogram pass straight through.
  const backendChartType = (t?: string): string =>
    t === "area" || t === "tree" ? "bar" : t === "donut" ? "pie" : t || "bar";
  // The chart spec sent to the backend for a chart node.
  const chartSpecOf = (node: NbNode) => ({
    chart_type: backendChartType(node.config.chart_type) as any,
    x: node.config.x,
    y: node.config.y || undefined,
    series: node.config.series || undefined,
    agg: node.config.agg || "sum",
    bins: node.config.bins || undefined,
    open: node.config.open || undefined,
    high: node.config.high || undefined,
    low: node.config.low || undefined,
    close: node.config.close || undefined,
    x2: node.config.x2 || undefined,
    y2: node.config.y2 || undefined,
  });
  // Re-attach the UI chart type + the node's style to the returned ChartData so
  // the renderer sees the real variant and the chosen palette / theme / labels.
  const styleChartData = (node: NbNode, r: any): ChartData => ({
    ...r,
    chart_type: node.config.chart_type || "bar",
    style: node.config.style || undefined,
  });
  // patch one key of a chart node's style object. No rerun / refetch: the
  // on-canvas chart re-renders from the already-cached data, so appearance
  // edits are instant and only flow to downstream nodes on a full rerun.
  const patchStyle = (node: NbNode, k: string, v: any) => {
    const st = { ...(node.config.style || {}) };
    if (v === undefined || v === "") delete st[k];
    else st[k] = v;
    patchNode(node.id, { style: st });
  };
  // set / clear a single per-element colour override
  const patchSeriesColor = (node: NbNode, name: string, color: string | null) => {
    const sc = { ...((node.config.style || {}).seriesColors || {}) };
    if (color) sc[name] = color;
    else delete sc[name];
    patchStyle(node, "seriesColors", Object.keys(sc).length ? sc : undefined);
  };
  const ensureChartFor = (node: NbNode | null, force = false): Promise<void> => {
    if (!node || node.type !== "chart") return Promise.resolve();
    const key = `chart:${node.id}`;
    const existing = chartPromisesRef.current.get(key);
    if (!force && existing) return existing;
    const cur = chartDataRef.current[node.id];
    if (!force && cur?.data) return Promise.resolve();
    if (!node.config.x) {
      cancelAuxRequest(key);
      setChartEntry(node.id, {
        error: "Pick an X field in this chart's config.",
      });
      return Promise.resolve();
    }

    const owner = beginAuxRequest(key, `chart-${node.id}-${uid()}`);
    setChartEntry(node.id, { loading: true });
    const request = (async () => {
      try {
        const r = await api.nodeflowChart(
          graphForRun(),
          node.id,
          chartSpecOf(node),
          owner.queryId,
          owner.controller.signal,
        );
        if (!isAuxRequestCurrent(owner)) return;
        if (wasCancelled(r) || !!r.cancelled) {
          setChartEntry(node.id, {});
          return;
        }
        if (r.error) {
          if (/interrupt|cancel/i.test(r.error)) {
            setChartEntry(node.id, {});
            return;
          }
          setChartEntry(node.id, { error: r.error });
          return;
        }
        setChartEntry(node.id, { data: styleChartData(node, r) });
      } catch (e: any) {
        if (
          !isAuxRequestCurrent(owner) ||
          owner.controller.signal.aborted ||
          cancelRequested.current ||
          isCancelledError(e, owner.queryId)
        ) {
          return;
        }
        setChartEntry(node.id, { error: e.message || String(e) });
      } finally {
        finishAuxRequest(owner);
      }
    })();
    chartPromisesRef.current.set(key, request);
    void request.finally(() => {
      if (chartPromisesRef.current.get(key) === request) {
        chartPromisesRef.current.delete(key);
      }
    });
    return request;
  };
  // set which input a dashboard pane shows
  const setDashPane = (dash: NbNode, idx: number, port: string) => {
    const panes = [...(dash.config.panes || ["in1", "in2", "in3", "in4"])];
    panes[idx] = port;
    patchNode(dash.id, { panes });
    const cn = upstreamChartNode(dash, port);
    if (cn) void ensureChartFor(cn);
  };

  const doChart = async (node: NbNode) => {
    if (!node.config.x) {
      onToast("error", "Pick an X field", "Choose what to plot.");
      return;
    }
    const id = startRun(`Charting ${node.config.label}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.nodeflowChart(
        graphForApi(),
        node.id,
        chartSpecOf(node),
        id,
        ctrl.signal,
      );
      if (wasCancelled(r, id)) return finishRun(id, { cancelled: true }, "");
      if (r.error) {
        onToast("error", "Chart error", r.error);
        return finishRun(id, r, "");
      }
      setPreview({
        kind: "chart",
        title: `${node.config.label} · chart`,
        data: styleChartData(node, r),
      });
      finishRun(id, r, "Chart ready");
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      onToast("error", "Chart error", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  const doValidate = async (node: NbNode) => {
    const queryId = "validate-" + uid();
    const owner = beginAuxRequest(`validate:${node.id}`, queryId);
    setValidateResults((p) => ({ ...p, [node.id]: { loading: true } }));
    try {
      const r = await api.nodeflowValidate(
        graphForApi(),
        node.id,
        node.config.checks || [],
        owner.controller.signal,
        queryId,
      );
      if (!isAuxRequestCurrent(owner) || wasCancelled(r, queryId)) return;
      setValidateResults((p) => ({
        ...p,
        [node.id]: r.error ? { error: r.error } : r,
      }));
      if (r.error) onToast("error", "Validate failed", r.error);
      else
        onToast(
          r.ok ? "ok" : "warn",
          r.ok ? "All checks passed" : "Some checks failed",
        );
    } catch (e: any) {
      if (
        !isAuxRequestCurrent(owner) ||
        cancelRequested.current ||
        isCancelledError(e, queryId)
      ) {
        return;
      }
      const message = e.message || String(e);
      setValidateResults((p) => ({
        ...p,
        [node.id]: { error: message },
      }));
      onToast("error", "Validate failed", message);
    } finally {
      finishAuxRequest(owner);
    }
  };

  const doProfile = async (node: NbNode) => {
    const id = startRun(`Profiling ${node.config.label}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.nodeflowBrowse(graphForRun(), node.id, id, ctrl.signal);
      if (wasCancelled(r, id)) return finishRun(id, { cancelled: true }, "");
      if (r.error) {
        onToast("error", "Browse error", r.error);
        return finishRun(id, r, "");
      }
      setPreview({
        kind: "profile",
        title: `${node.config.label} · profile`,
        total: r.total_rows || 0,
        columns: r.columns || [],
      });
      finishRun(id, r, `${(r.total_rows || 0).toLocaleString()} rows profiled`);
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      onToast("error", "Browse error", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  const doReconcile = async (node: NbNode) => {
    const wiredPorts = edges
      .filter((e) => e.to.node === node.id)
      .map((e) => e.to.port);
    if (!wiredPorts.includes("left") || !wiredPorts.includes("right")) {
      onToast(
        "error",
        "Connect two inputs",
        "Reconcile compares two tables — wire one into the left input and one into the right.",
      );
      return;
    }
    const keys: string[] = node.config.keys || [];
    if (!keys.length) {
      onToast("error", "Pick a key", "Choose at least one key field to match on.");
      return;
    }
    const id = startRun(`Reconciling ${node.config.label}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.nodeflowReconcile(
        graphForApi(),
        node.id,
        keys,
        node.config.compare || [],
        id,
        node.config.balance || null,
        ctrl.signal,
      );
      if (wasCancelled(r, id)) return finishRun(id, { cancelled: true }, "");
      if (r.error) {
        onToast("error", "Reconcile error", r.error);
        return finishRun(id, r, "");
      }
      setPreview({
        kind: "report",
        title: `${node.config.label} · reconciliation`,
        totals: r.totals || {},
        fields: r.fields || [],
      });
      finishRun(id, r, "Reconciliation ready");
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      onToast("error", "Reconcile error", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  type RunOutcome = { ok: boolean; cancelled?: boolean };
  // the node feeding a sink's single input (used by the Output node to decide
  // whether it is saving an image or data)
  const inputNodeOf = (node: NbNode, port = "in"): NbNode | null => {
    const e = edges.find((x) => x.to.node === node.id && x.to.port === port);
    if (!e) return null;
    return nodes.find((n) => n.id === e.from.node) || null;
  };
  // chart -> image, dashboard -> image, anything else -> data
  const outputKind = (node: NbNode): "chart" | "dashboard" | "data" | "none" => {
    const src = inputNodeOf(node);
    if (!src) return "none";
    if (src.type === "chart") return "chart";
    if (src.type === "dashboard") return "dashboard";
    return "data";
  };
  const IMAGE_FORMATS_CHART = ["png", "svg", "jpeg"];
  const IMAGE_FORMATS_DASH = ["png", "jpeg"];
  const DATA_FORMATS = ["csv", "tsv", "json", "ndjson", "xlsx", "parquet"];
  // Friendlier label for the one format whose bare name isn't self-explanatory.
  const FORMAT_LABELS: Record<string, string> = {
    xlsx: "Excel (xlsx)",
  };

  // fetch a chart node's ChartData (for export; bypasses the on-canvas cache)
  const fetchChartData = async (chartNode: NbNode): Promise<ChartData | null> => {
    const scope = scopeVersionRef.current;
    if (!chartNode || chartNode.type !== "chart" || !chartNode.config.x) return null;
    const r = await api.nodeflowChart(graphForRun(), chartNode.id, chartSpecOf(chartNode));
    if (scope !== scopeVersionRef.current) return null;
    if (r.error || wasCancelled(r)) return null;
    return styleChartData(chartNode, r);
  };

  const doExportImage = async (node: NbNode): Promise<RunOutcome> => {
    // Empty folder → server writes to the user's Downloads folder.
    const folder = (node.config.folder || "").trim();
    const kind = outputKind(node);
    const src = inputNodeOf(node);
    if (!src || (kind !== "chart" && kind !== "dashboard")) {
      onToast("error", "Nothing to draw", "Connect a chart or dashboard to this Output.");
      return { ok: false };
    }
    let fmt = (node.config.format || "png").toLowerCase();
    const allowed = kind === "chart" ? IMAGE_FORMATS_CHART : IMAGE_FORMATS_DASH;
    if (!allowed.includes(fmt)) fmt = allowed[0];
    const id = startRun(`Rendering ${node.config.label}…`, [node.id]);
    try {
      let dataUrl = "";
      if (kind === "chart") {
        const cd = await fetchChartData(src);
        if (!isRunCurrent(id)) return { ok: false, cancelled: true };
        if (!cd) {
          onToast("error", "Chart not ready", "Give the chart an X field and data first.");
          finishRun(id, { error: "Chart not ready." }, "");
          return { ok: false };
        }
        dataUrl = await renderToDataURL(cd, { type: fmt as any });
        if (!isRunCurrent(id)) return { ok: false, cancelled: true };
      } else {
        // dashboard: render each mapped pane, then composite a 2x2 board
        const panes = src.config.panes || ["in1", "in2", "in3", "in4"];
        const urls: (string | null)[] = [];
        for (let i = 0; i < 4; i++) {
          const cn = upstreamChartNode(src, panes[i] || `in${i + 1}`);
          if (!cn) {
            urls.push(null);
            continue;
          }
          const cd = await fetchChartData(cn);
          if (!isRunCurrent(id)) return { ok: false, cancelled: true };
          urls.push(cd ? await renderToDataURL(cd, { type: "png" }) : null);
          if (!isRunCurrent(id)) return { ok: false, cancelled: true };
        }
        if (urls.every((u) => !u)) {
          onToast("error", "Empty dashboard", "Wire charts into the dashboard first.");
          finishRun(id, { error: "Empty dashboard." }, "");
          return { ok: false };
        }
        dataUrl = await compositeImages(urls, { type: fmt as any });
        if (!isRunCurrent(id)) return { ok: false, cancelled: true };
      }
      const r = await api.exportImage(
        folder,
        node.config.base_name || "chart",
        fmt,
        dataUrl,
      );
      if (!isRunCurrent(id)) return { ok: false, cancelled: true };
      if (r.error || !r.ok) {
        onToast("error", "Export failed", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        return { ok: false };
      }
      onToast("ok", "Image saved", r.file || "");
      finishRun(id, r, `Saved image`);
      return { ok: true };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Export failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  const doExport = async (node: NbNode): Promise<RunOutcome> => {
    // Empty folder → server writes to the user's Downloads folder.
    const folder = (node.config.folder || "").trim();
    const id = startRun(`Exporting ${node.config.label}…`, [node.id]);
    try {
      const r = await api.nodeflowExport(
        graphForApi(),
        node.id,
        folder,
        node.config.format || "csv",
        node.config.base_name || "output",
        id,
      );
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      if (r.error || !r.ok) {
        onToast("error", "Export failed", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        return { ok: false };
      }
      onToast(
        "ok",
        "Exported",
        `${r.path || r.file} — ${(r.rows ?? 0).toLocaleString()} rows`,
      );
      finishRun(id, r, `Exported ${(r.rows ?? 0).toLocaleString()} rows`);
      return { ok: true };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Export failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  // Run all: export several file-output nodes in ONE shared materialisation
  // pass, so a subgraph feeding more than one of them is computed once for the
  // batch. Falls back to exporting each node on its own if the shared build
  // fails, so a failure still localises to a single node. Returns one
  // RunOutcome per node in `outs`, in order.
  const doExportBatch = async (outs: NbNode[]): Promise<RunOutcome[]> => {
    const eachAlone = async (): Promise<RunOutcome[]> => {
      const rr: RunOutcome[] = [];
      for (const n of outs) rr.push(await doExport(n));
      return rr;
    };
    // Empty folder is OK — the server writes to Downloads. Batch still
    // shares one materialisation when every output participates.
    const items = outs.map((n) => ({
      node_id: n.id,
      folder: (n.config.folder || "").trim(),
      fmt: n.config.format || "csv",
      base_name: n.config.base_name || "output",
    }));
    const id = startRun(
      `Exporting ${outs.length} outputs…`,
      outs.map((node) => node.id),
    );
    let r: Awaited<ReturnType<typeof api.nodeflowExportMany>>;
    try {
      r = await api.nodeflowExportMany(graphForRun(), items, id);
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return outs.map(() => ({ ok: false, cancelled: true }));
      }
      finishRun(id, { error: e?.message || String(e) }, "");
      return eachAlone();
    }
    if (wasCancelled(r, id)) {
      finishRun(id, { cancelled: true }, "");
      return outs.map(() => ({ ok: false, cancelled: true }));
    }
    if (r.error || !r.ok || !r.results) {
      // the shared build failed -> fall back so the error points at one node
      finishRun(id, { error: r.error || "Failed." }, "");
      return eachAlone();
    }
    const byId = new Map(r.results.map((x) => [x.node_id, x]));
    let okCount = 0;
    const outcomes = outs.map((n): RunOutcome => {
      const x = byId.get(n.id);
      if (x && x.ok) {
        okCount++;
        onToast(
          "ok",
          "Exported",
          `${x.file} — ${(x.rows ?? 0).toLocaleString()} rows`,
        );
        return { ok: true };
      }
      onToast("error", "Export failed", (x && x.error) || "Failed.");
      return { ok: false };
    });
    finishRun(id, null, `Exported ${okCount} of ${outs.length}`);
    return outcomes;
  };

  const doWriteTable = async (node: NbNode): Promise<RunOutcome> => {
    const name = (node.config.name || "").trim();
    if (!name) {
      onToast("error", "Name the table", "Give the output table a name.");
      return { ok: false };
    }
    const id = startRun(`Writing ${node.config.label}…`, [node.id]);
    try {
      const r = await api.nodeflowToTable(graphForRun(), node.id, name, id);
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      if (r.error || !r.ok) {
        onToast("error", "Write failed", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        return { ok: false };
      }
      onToast(
        "ok",
        "Table written",
        `${r.table} (${r.engine}) — ${(r.rows ?? 0).toLocaleString()} rows`,
      );
      finishRun(id, r, `Wrote ${r.table}`);
      onTablesChanged?.();
      return { ok: true };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Write failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  // directory node: list loadable files in a folder, and read the chosen one
  const DIR_EXTS = [
    "csv", "tsv", "txt", "json", "ndjson", "jsonl",
    "parquet", "pq", "xlsx", "xlsm", "xls",
  ];
  const loadDirList = async (folder: string) => {
    const key = "directory-list";
    if (!folder) {
      cancelAuxRequest(key);
      setDirList({ folder: "", files: [], loading: false });
      return;
    }
    const owner = beginAuxRequest(key);
    setDirList({ folder, files: [], loading: true });
    try {
      const r = await api.fsList(folder, owner.controller.signal);
      if (!isAuxRequestCurrent(owner)) return;
      const files = (r.entries || [])
        .filter((e) => !e.is_dir && DIR_EXTS.includes((e.ext || "").toLowerCase()))
        .map((e) => ({ name: e.name, path: e.path, ext: e.ext }));
      setDirList({ folder, files, loading: false, error: r.error });
    } catch (e: any) {
      if (!isAuxRequestCurrent(owner) || isCancelledError(e)) return;
      setDirList({
        folder,
        files: [],
        loading: false,
        error: e.message || String(e),
      });
    } finally {
      finishAuxRequest(owner);
    }
  };
  const doReadDirectory = async (node: NbNode, path: string, file: string) => {
    const id = startRun(`Reading ${file}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.directoryRead(path, id, ctrl.signal);
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      if (r.error || !r.ok) {
        onToast("error", "Couldn't read file", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        patchNode(node.id, { file, path, table: "", columns: [] });
        return;
      }
      patchNode(node.id, {
        file,
        path,
        table: r.table,
        columns: r.columns || [],
        engine: r.engine,
      });
      onToast(
        "ok",
        "File ready",
        `${file} — ${(r.rows ?? 0).toLocaleString()} rows`,
      );
      finishRun(id, r, `Read ${(r.rows ?? 0).toLocaleString()} rows`);
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      onToast("error", "Couldn't read file", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  const doReadFolder = async (node: NbNode, folder: string) => {
    const id = startRun(`Reading folder…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.folderRead(folder, id, ctrl.signal);
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      if (r.error || !r.ok) {
        onToast("error", "Couldn't read folder", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        patchNode(node.id, { folder, table: "", columns: [], files: 0 });
        return;
      }
      patchNode(node.id, {
        folder,
        table: r.table,
        columns: r.columns || [],
        files: r.files || 0,
        engine: r.engine,
      });
      onToast(
        "ok",
        "Folder loaded",
        `${r.files ?? 0} file(s) → ${(r.rows ?? 0).toLocaleString()} rows`,
      );
      finishRun(id, r, `Stacked ${(r.rows ?? 0).toLocaleString()} rows`);
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      onToast("error", "Couldn't read folder", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  const doFetchApi = async (
    node: NbNode,
    configExtra?: Record<string, unknown>,
  ): Promise<RunOutcome> => {
    const sourceTypes = new Set(["apinode", "sqlserver", "sharepoint", "webscrape"]);
    if (!sourceTypes.has(node.type)) {
      onToast("error", "Cannot fetch", "This node type has no Fetch action.");
      return { ok: false };
    }
    if (node.type === "apinode" && !(node.config.url || "").trim()) {
      onToast("error", "Add a URL", "The API node needs a URL to fetch.");
      return { ok: false };
    }
    if (node.type === "sqlserver" && !(node.config.query || "").trim()) {
      onToast("error", "Add a query", "The SQL Server node needs a SELECT to run.");
      return { ok: false };
    }
    if (
      node.type === "sqlserver" &&
      !(node.config.server || "").trim() &&
      !(node.config.profile_key || "").trim() &&
      !(node.config.connection || "").trim()
    ) {
      onToast(
        "error",
        "Connection required",
        "Set a server / saved profile, or an active connection name.",
      );
      return { ok: false };
    }
    if (
      node.type === "sharepoint" &&
      !(node.config.site_url || "").trim()
    ) {
      onToast("error", "Site URL", "Set the SharePoint site URL.");
      return { ok: false };
    }
    if (
      node.type === "sharepoint" &&
      (node.config.mode || "list") === "list" &&
      !(node.config.list_title || "").trim()
    ) {
      onToast("error", "List title", "Set the SharePoint list name.");
      return { ok: false };
    }
    if (node.type === "webscrape" && !(node.config.url || "").trim()) {
      onToast("error", "Add a URL", "The Web scrape node needs a page URL.");
      return { ok: false };
    }
    const fetchConfig = configExtra
      ? { ...node.config, ...configExtra }
      : node.config;
    const id = startRun(`Fetching ${node.config.label}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r =
        node.type === "apinode"
          ? await api.nodeApiFetch(
              {
                node_id: node.id,
                config: fetchConfig,
                graph: graphForRun(),
                query_id: id,
              },
              ctrl.signal,
            )
          : await api.nodeSourceFetch(
              {
                type: node.type,
                node_id: node.id,
                config: fetchConfig,
                graph: graphForRun(),
                query_id: id,
              },
              ctrl.signal,
            );
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false };
      }
      if (r.error || !r.ok) {
        onToast("error", "Fetch failed", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        patchNode(node.id, { table: "", columns: [] });
        return { ok: false };
      }
      if (r.fetched === false) {
        // continue-on-error: the failure was captured on the errors output
        patchNode(node.id, {
          table: "",
          columns: [],
          rows: 0,
          err_table: r.err_table,
          err_rows: r.err_rows ?? 1,
          fetched_url: r.url,
        });
        onToast(
          "ok",
          "Error captured",
          r.error_captured || "Fetch failed; routed to the errors output.",
        );
        finishRun(id, r, "Fetch error captured");
        return { ok: true };
      }
      patchNode(node.id, {
        table: r.table,
        columns: r.columns || [],
        rows: r.rows,
        engine: r.engine,
        err_table: r.err_table,
        err_rows: r.err_rows ?? 0,
        fetched_url: r.url,
      });
      onToast(
        "ok",
        "Fetched",
        `${(r.rows ?? 0).toLocaleString()} row(s) · ${
          (r.columns || []).length
        } column(s)`,
      );
      finishRun(id, r, `Fetched ${(r.rows ?? 0).toLocaleString()} rows`);
      return { ok: true };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Fetch failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    } finally {
      unregisterRun(id, ctrl);
    }
  };

  const doRunIterator = async (node: NbNode): Promise<RunOutcome> => {
    if (!(node.config.table || "").trim()) {
      onToast("error", "Name the output table", "Give the iterator's accumulator a table name.");
      return { ok: false };
    }
    // The passes come from the wired "values" table (container) or the classic
    // driver; the backend validates that and returns a clear error if neither
    // is set, so we don't pre-require a loop-variable name here — a container
    // iterator binds each values row's columns as ${vars} and uses no var name.
    const id = startRun(`Iterating ${node.config.label}…`, [node.id]);
    try {
      const r = await api.iteratorRun({
        node_id: node.id,
        graph: graphForRun(),
        query_id: id,
      });
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false };
      }
      if (r.error && !r.passes) {
        onToast("error", "Iterator failed", r.error);
        finishRun(id, { error: r.error }, "");
        return { ok: false };
      }
      const errs = r.errors || [];
      patchNode(node.id, {
        it_passes: r.passes,
        it_attempted: r.attempted,
        it_rows: r.rows,
        it_errors: errs.length,
        // Keep the user's accumulator name on a failed pass (the backend
        // returns table: null when nothing was written). Clearing it here is
        // what made a name "vanish" after a run and blocked a simple rerun.
        ...(r.table ? { table: r.table } : {}),
      });
      if (errs.length) {
        onToast(
          r.ok ? "ok" : "error",
          `Iterated ${r.passes}/${r.attempted}`,
          `${(r.rows ?? 0).toLocaleString()} row(s); ${errs.length} value(s) failed (e.g. ${errs[0].value}: ${errs[0].error}).`,
        );
      } else {
        onToast(
          "ok",
          `Iterated ${r.passes} pass(es)`,
          `${(r.rows ?? 0).toLocaleString()} row(s) → ${r.table}${r.note ? ` · ${r.note}` : ""}`,
        );
      }
      finishRun(id, r, `Iterated ${r.passes} pass(es)`);
      onTablesChanged?.();
      return { ok: !!r.ok };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Iterator failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  const doRunWhile = async (node: NbNode): Promise<RunOutcome> => {
    if (!(node.config.table || "").trim()) {
      onToast("error", "Name the output table", "Give the controller's accumulator a table name.");
      return { ok: false };
    }
    const id = startRun(`Repeating ${node.config.label}…`, [node.id]);
    try {
      const r = await api.whileRun({
        node_id: node.id,
        graph: graphForRun(),
        query_id: id,
      });
      if (wasCancelled(r, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false };
      }
      if (r.error && !r.iterations) {
        onToast("error", "Controller failed", r.error);
        finishRun(id, { error: r.error }, "");
        return { ok: false };
      }
      patchNode(node.id, {
        wh_iters: r.iterations,
        wh_converged: r.converged,
        wh_rows: r.rows,
        // Same as the iterator: don't wipe the user's table name on a run that
        // wrote nothing, so a rerun works without retyping it.
        ...(r.table ? { table: r.table } : {}),
      });
      onToast(
        "ok",
        r.converged
          ? `Converged in ${r.iterations} iteration(s)`
          : `Ran ${r.iterations} iteration(s)`,
        `${(r.rows ?? 0).toLocaleString()} row(s) → ${r.table}${r.note ? ` · ${r.note}` : ""}`,
      );
      finishRun(id, r, `Repeated ${r.iterations} iteration(s)`);
      onTablesChanged?.();
      return { ok: !!r.ok };
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return { ok: false, cancelled: true };
      }
      onToast("error", "Controller failed", e.message || String(e));
      finishRun(id, { error: e.message || String(e) }, "");
      return { ok: false };
    }
  };

  const runAll = async () => {
    const batchScope = scopeVersionRef.current;
    // A new batch owns fresh cancellation state. Clear it before computing
    // terminals or starting any child run so no prior Stop can poison Run all.
    cancelRequested.current = false;
    // Drop pre–Run-all FE preview hits so individual node views cannot stick
    // on stale last-run rows. Successful terminals + ancestors re-seed below.
    previewCache.current.clear();
    // Snapshot the synchronously maintained refs at click time.  This avoids
    // sending a render-old graph when Run is clicked immediately after an
    // inspector edit (React may not have committed the next render yet).
    const runNodes = liveRef.current.nodes;
    const runEdges = liveRef.current.edges;
    // .552: a fresh Run all is a NEW user-initiated batch -- it is never
    // pre-cancelled. Resetting the flag here (not only inside startRun's
    // runDepth===0 branch) closes a race where a prior cancel / a
    // forceRecoverFromCancel left cancelRequested stuck true, which made
    // wasCancelled() report EVERY terminal as cancelled and produced the
    // "Run all cancelled" toast with no results while the same query ran
    // fine in the IDE.
    const hasIn = (n: NbNode) => runEdges.some((e) => e.to.node === n.id);
    const hasOut = (n: NbNode) => runEdges.some((e) => e.from.node === n.id);
    // Zero-input sources may be Run-all leaves with no inbound wire.
    const SOURCES = NODEFLOW_SOURCE_TYPES;
    const SKIP_LEAF = new Set([
      "browse",
      "chart",
      "dashboard",
      "text",
      "output",
      "write",
      "iterator",
      "while",
    ]);

    // a fresh run re-evaluates connectivity, so clear last run's soft warnings
    setNodeWarnings({});

    const exporters = runNodes.filter(
      (n) =>
        n.type === "output" ||
        n.type === "write" ||
        n.type === "iterator" ||
        n.type === "while",
    );
    let runList: NbNode[] = [];
    const danglingOut: NbNode[] = [];
    let mode: "outputs" | "leaves" = "outputs";
    let noConnectedOutput = false; // (badge-only since .468)
    void noConnectedOutput;
    if (exporters.length) {
      // run connected exporters; an Output/Write with no input is "dangling"
      for (const n of exporters) (hasIn(n) ? runList : danglingOut).push(n);
    }
    if (!runList.length) {
      // No CONNECTED output/terminal node (none exist, or the only ones aren't
      // wired up). Running a bare chain to preview results through the
      // output-port arrows -- before adding an Output -- is a normal way to
      // work, so fall back to running the end-of-chain data nodes and nudge
      // softly (yellow), never a red error.
      mode = "leaves";
      noConnectedOutput = true;
      runList = runNodes.filter(
        (n) =>
          (PORTS[n.type]?.outputs?.length || 0) > 0 &&
          !hasOut(n) &&
          !SKIP_LEAF.has(n.type) &&
          (hasIn(n) || SOURCES.has(n.type)),
      );
    }

    // flag any present-but-unconnected Output node yellow (a gentle nudge,
    // not a red error)
    const warnUnconnectedOutputs = () => {
      if (!danglingOut.length) return;
      setNodeWarnings((p) => {
        const q = { ...p };
        for (const n of danglingOut) q[n.id] = "Output node not connected";
        return q;
      });
    };

    const runIds = new Set(runList.map((n) => n.id));
    // fully-unconnected nodes (excluding notes + anything we're running)
    const isolated = runNodes.filter(
      (n) =>
        n.type !== "text" && !hasIn(n) && !hasOut(n) && !runIds.has(n.id),
    );

    if (!runList.length) {
      // nothing runnable at all (e.g., only a lone, unconnected Output node)
      warnUnconnectedOutputs();
      // .468: retitled -- the output-node nudge lives on the node's
      // yellow badge, not in toast titles. This toast only says WHY
      // nothing could run.
      onToast(
        "warn",
        "Nothing to run",
        danglingOut.length
          ? "Connect an input to your Output node, or build a chain to preview through the output arrows."
          : "Connect a chain of nodes (or add an Output) to run.",
      );
      return;
    }

    const totalTerminals = runList.length;
    // Top-level data leaves can use the backend multi-target scheduler. It
    // keeps shared ancestors single and runs genuinely independent DuckDB
    // branches concurrently. Child nodes need their own truncated group graph.
    let batchOutcomes: RunOutcome[] = [];
    const successfulTerminalIds: string[] = [];
    if (
      mode === "leaves" &&
      runList.length >= 2 &&
      runList.every((n) => !childCtx(n.id))
    ) {
      const batched = [...runList];
      batchOutcomes = await runLeafBatch(runList);
      if (batchScope !== scopeVersionRef.current) return;
      batched.forEach((n, i) => {
        if (batchOutcomes[i]?.ok) successfulTerminalIds.push(n.id);
      });
      runList = [];
      if (batchOutcomes.some((r) => r.cancelled)) {
        onToast("warn", "Run all cancelled", `0 of ${totalTerminals} done`);
        return;
      }
    }

    // Export file-output nodes (≥2) together in one shared pass so any common
    // upstream is built once; the remaining terminals (write / chart /
    // dashboard image, and single outputs) keep running through the pool.
    if (mode === "outputs") {
      const fileOuts = runList.filter(
        (n) => n.type === "output" && outputKind(n) === "data",
      );
      if (fileOuts.length >= 2) {
        const batchIds = new Set(fileOuts.map((n) => n.id));
        runList = runList.filter((n) => !batchIds.has(n.id));
        batchOutcomes = await doExportBatch(fileOuts);
        if (batchScope !== scopeVersionRef.current) return;
        fileOuts.forEach((n, i) => {
          if (batchOutcomes[i]?.ok) successfulTerminalIds.push(n.id);
        });
        if (batchOutcomes.some((r) => r.cancelled)) {
          onToast("warn", "Run all cancelled", `0 of ${totalTerminals} done`);
          return;
        }
      }
    }

    // run the terminals through a small concurrency pool. The engines
    // serialise the heavy materialisation themselves (DuckDB holds a
    // connection lock and already multithreads within a query; SQLite locks
    // on writes), so this mainly overlaps file I/O with the next query and
    // lets terminals on different engines run at once -- while per-run temp
    // tables are uniquely named so concurrent runs can't collide.
    const runOne = (n: NbNode): Promise<RunOutcome> => {
      if (mode === "leaves") return runLeaf(n);
      const kind = n.type === "output" ? outputKind(n) : "data";
      return n.type === "iterator"
        ? doRunIterator(n)
        : n.type === "while"
          ? doRunWhile(n)
          : n.type === "write"
            ? doWriteTable(n)
            : kind === "chart" || kind === "dashboard"
            ? doExportImage(n)
            : doExport(n);
    };
    // Cap frontend Run-all concurrency when the backend already parallelizes
    // DuckDB branch workers — stacking both pools oversubscribes CPU/RAM.
    // Cache the parallel_nodeflows flag briefly so Run all is not gated on a
    // fresh flowCacheInfo RTT every click.
    let CONCURRENCY = Math.min(3, runList.length || 1);
    try {
      if (await getRunAllParallelNodeflows(() => api.flowCacheInfo())) {
        CONCURRENCY = 1;
      }
    } catch {
      /* keep default pool */
    }
    const results: RunOutcome[] = [...batchOutcomes];
    let next = 0;
    const worker = async () => {
      while (next < runList.length) {
        // Stop must halt the whole workflow: once cancellation is requested, no
        // worker starts another node (the in-flight ones were already aborted +
        // interrupted by cancelRun).
        if (cancelRequested.current) break;
        const n = runList[next++];
        const outcome = await runOne(n);
        results.push(outcome);
        if (outcome.ok) successfulTerminalIds.push(n.id);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (batchScope !== scopeVersionRef.current) return;

    if (results.some((r) => r.cancelled)) {
      onToast("warn", "Run all cancelled", `${results.filter((r) => r.ok).length} of ${totalTerminals} done`);
      return;
    }
    const ok = results.filter((r) => r.ok).length;
    const bad = results.filter((r) => !r.ok).length;
    warnUnconnectedOutputs();
    // Post-run missing-ref prune for terminals that succeeded in this Run all.
    // Leaf/batch already pruned inside runLeaf/runLeafBatch; export paths and
    // a second pass here cover the rest (idempotent).
    if (successfulTerminalIds.length) {
      await pruneMissingRefsAfterSuccessfulRun(successfulTerminalIds);
    }
    // Seed last-run rows for every data node in the successful terminals'
    // ancestor closure (Select/Join/Filter/…), not only the sink leaf/Output.
    // Most transforms stay cache-only; sources, Join sides, and Filter may peek.
    if (successfulTerminalIds.length && !cancelRequested.current) {
      await seedLastRunCaches(successfulTerminalIds);
    }
    if (batchScope !== scopeVersionRef.current) return;
    // Open drawer: swap to new last-run rows (or clear if this node wasn't
    // part of the batch) so the UI never stays on pre–Run-all data.
    refreshOpenPreviewFromLastRun();
    const bits = [`${ok} ran`];
    if (bad) bits.push(`${bad} failed`);
    if (isolated.length)
      bits.push(`${isolated.length} unconnected node(s) ignored`);
    if (bad) {
      // a genuine node failure is still a red error (and reds that node)
      onToast("error", "Run all finished", bits.join(" · "));
    } else if (isolated.length) {
      // .468: the output-node nudge is the yellow badge on the node
      // itself now -- no toast. Only genuinely ignored nodes still warn.
      onToast("warn", "Run all finished", bits.join(" · "));
    } else {
      onToast("ok", "Run all finished", bits.join(" · "));
    }
  };

  const doCreateTable = async (node: NbNode) => {
    const cols = (node.config.columns || [])
      .map((c: string) => (c || "").trim())
      .filter(Boolean);
    if (!cols.length) {
      onToast("error", "Add a column", "Give the table at least one column.");
      return;
    }
    const rows = (node.config.rows || []).filter((r: any[]) =>
      (r || []).some((c) => String(c ?? "").trim() !== ""),
    );
    if (!rows.length) {
      onToast("error", "Add a row", "Enter or paste at least one row of data.");
      return;
    }
    const name = (node.config.label || "table").trim() || "table";
    const id = startRun(`Creating ${name}…`, [node.id]);
    const ctrl = new AbortController();
    registerRun(id, ctrl);
    try {
      const r = await api.tableCreate(
        name,
        cols,
        rows,
        node.config.dest || "duckdb",
        ctrl.signal,
      );
      if (!isRunCurrent(id)) return;
      if (r.error || !r.ok) {
        onToast("error", "Create failed", r.error || "Failed.");
        finishRun(id, { error: r.error || "Failed." }, "");
        return;
      }
      const t = r.table || name;
      onToast(
        "ok",
        "Table created",
        `${t} (${r.engine}) — ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}`,
      );
      finishRun(id, r, `Created ${t}`);
      onTablesChanged?.();
    } catch (e: any) {
      if (!isRunCurrent(id) || cancelRequested.current || isCancelledError(e, id)) {
        finishRun(id, { cancelled: true }, "");
        return;
      }
      const message = e.message || String(e);
      onToast("error", "Create failed", message);
      finishRun(id, { error: message }, "");
    } finally {
      unregisterRun(id, ctrl);
    }
  };



  const setDocumentStatus = (text: string) => {
    setStatus({ kind: "idle", text });
  };

  return {
    preview,
    setPreview,
    previewHeight,
    setPreviewHeight,
    running,
    runningNodeIds,
    runId,
    status,
    setDocumentStatus,
    browseFolder,
    setBrowseFolder,
    dirList,
    doPreviewRef,
    previewCache,
    chartData,
    validateResults,
    upstreamChartNode,
    patchStyle,
    patchSeriesColor,
    ensureChartFor,
    setDashPane,
    doChart,
    doValidate,
    doProfile,
    doReconcile,
    doExport,
    doWriteTable,
    doReadDirectory,
    doReadFolder,
    doFetchApi,
    doRunIterator,
    doRunWhile,
    doCreateTable,
    doPreview,
    patchNode,
    outputKind,
    IMAGE_FORMATS_CHART,
    IMAGE_FORMATS_DASH,
    DATA_FORMATS,
    FORMAT_LABELS,
    loadDirList,
    runAll,
    cancelRun,
  };
}
