import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  HEAD_H,
  NODE_W,
  type NbEdge,
  type NbNode,
  nodeFlowDenseActive,
  setNodeFlowDenseMode,
} from "../lib/nodeFlowModel";
import type { TableInfo } from "../lib/types";
import { useStableEvent } from "../lib/useStableEvent";
import { wfFileName } from "../lib/workflowFile";
import { FileBrowser } from "./LoadDataModal";
import { NodeFlowMenus, type CanvasMenuState, type DeleteConfirmState, type NodeMenuState } from "./nodeflow/NodeFlowMenus";
import { NodeFlowPalette, useNodeFlowPalette } from "./nodeflow/NodeFlowPalette";
import { ToolsTablesPanel } from "./ToolsTablesPanel";
import { NodeFlowPreviewDrawer } from "./nodeflow/NodeFlowPreviewDrawer";
import { NodeFlowScene } from "./nodeflow/NodeFlowScene";
import { NodeFlowStatusBar } from "./nodeflow/NodeFlowStatusBar";
import { NodeFlowTabBar } from "./nodeflow/NodeFlowTabBar";
import { NodeFlowInspectorPanel } from "./nodeflow/NodeFlowInspectorPanel";
import { useNodeFlowAnimations } from "./nodeflow/useNodeFlowAnimations";
import { useNodeFlowChartHydration } from "./nodeflow/useNodeFlowChartHydration";
import { useNodeFlowCanvasInteractions } from "./nodeflow/useNodeFlowCanvasInteractions";
import { useNodeFlowClipboard } from "./nodeflow/useNodeFlowClipboard";
import { useNodeFlowDocumentController } from "./nodeflow/useNodeFlowDocumentController";
import { useNodeFlowExecutionController } from "./nodeflow/useNodeFlowExecutionController";
import { useNodeFlowGraphController } from "./nodeflow/useNodeFlowGraphController";
import { useNodeFlowGraphSnapshot } from "./nodeflow/useNodeFlowGraphSnapshot";
import { useNodeFlowKeyboardShortcuts } from "./nodeflow/useNodeFlowKeyboardShortcuts";
import { useNodeFlowViewport } from "./nodeflow/useNodeFlowViewport";
import { findChildNode } from "./nodeflow/nodeFlowGraphCommands";
import {
  loadCreatedNodes,
  registerActiveNodeFlowGraphGetter,
} from "../lib/createdNodes";

export const NodeFlow: React.FC<{
  tables: TableInfo[];
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  features: { duckdb?: boolean } | null;
  onTablesChanged?: () => void;
  // when the tables panel is shown, the inspector is portaled into this host
  // (which replaces the tables list) instead of floating over the canvas
  showTables?: boolean;
  inspectorHost?: HTMLElement | null;
  onSelectionChange?: (hasSelection: boolean) => void;
  showNodeSearch?: boolean;
  // a one-shot request from the sidebar to open a saved (kind=node) workflow
  loadRequest?: { id: number; name: string; graph: unknown } | null;
  onLoadConsumed?: () => void;
  onWorkflowsChanged?: () => void;
  // a one-shot command (from sidebar/settings) to run save / save-as / open
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
  // node palette/toolbar visibility is owned by App (Settings → Toolbar Toggle)
  paletteHidden?: boolean;
  /** Tools & Tables floating window (App-owned open flag; NodeFlow-only UI). */
  toolsTablesOpen?: boolean;
  onToolsTablesOpenChange?: (open: boolean) => void;
  onOpenLoad?: () => void;
  /** Dense NodeFlow layout (owned by App Settings so Scene memo sees toggles). */
  denseMode?: boolean;
  /** Canvas grid snap while dragging (owned by App Settings → Visual). Default ON. */
  snap?: boolean;
}> = ({
  tables,
  onToast,
  onTablesChanged,
  showTables,
  inspectorHost,
  onSelectionChange,
  showNodeSearch,
  loadRequest,
  onLoadConsumed,
  onWorkflowsChanged,
  command,
  paletteHidden,
  toolsTablesOpen,
  onToolsTablesOpenChange,
  onOpenLoad,
  denseMode = false,
  snap = true,
}) => {
  // Keep densify() aligned with App Settings before Scene paints (also syncs
  // a lazy-chunk module copy if Rollup ever duplicates nodeFlowModel).
  if (nodeFlowDenseActive() !== denseMode) {
    setNodeFlowDenseMode(denseMode);
  }
  const [nodes, setNodes] = useState<NbNode[]>([]);
  // node-type whose help window is open (the inspector "?" button), or null
  const [helpFor, setHelpFor] = useState<string | null>(null);
  const [edges, setEdges] = useState<NbEdge[]>([]);
  // always-current snapshot of nodes for use inside long-lived pointer handlers
  const nodesRef = useRef(nodes);
  useLayoutEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  // marquee multi-selection of top-level nodes (for copy / delete)
  const [selIds, setSelIds] = useState<string[]>([]);
  const selIdsRef = useRef<string[]>([]);
  useEffect(() => {
    selIdsRef.current = selIds;
  });
  const edgesRef = useRef<NbEdge[]>([]);
  useLayoutEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // nodes that errored on their last preview/run (id -> message) for inline
  // error badges on the canvas
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  // nodes flagged with a soft (yellow) warning rather than a red error -- e.g.
  // an Output node that isn't wired up when Run all falls back to previewing
  // the chain. Never blocks the run; just a gentle nudge.
  const [nodeWarnings, setNodeWarnings] = useState<Record<string, string>>({});
  const [selId, setSelId] = useState<string | null>(null);
  // the single currently-selected connection (click a wire to select+highlight,
  // then Delete/Backspace removes it -- no confirm for links)
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const selEdgeRef = useRef<string | null>(null);
  useEffect(() => {
    selEdgeRef.current = selEdge;
  });
  // selecting a node (any path) clears a selected connection, so Delete is
  // never ambiguous between the two
  useEffect(() => {
    if (selId) setSelEdge(null);
  }, [selId]);
  const {
    ripple,
    dyingIds,
    dyingEdgeIds,
    bornId,
    lineageFlashId,
    fireRipple,
    fireBorn,
    fireLineageFlash,
    withImplosion,
    withEdgeRetract,
  } = useNodeFlowAnimations();
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  // in-canvas confirmations are rendered by NodeFlowMenus.
  const [delConfirm, setDelConfirm] = useState<DeleteConfirmState | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState | null>(null);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const {
    mmMini,
    scrollPos,
    zoom,
    zoomRef,
    measureViewport,
    panTo,
    toggleMinimap,
    zoomBy,
    resetZoom,
  } = useNodeFlowViewport(wrapRef);
  const paletteModel = useNodeFlowPalette(showNodeSearch);

  const documentStatusRef = useRef<(text: string) => void>(() => {});
  const {
    liveRef,
    tabs,
    activeTabId,
    editingTab,
    editingName,
    setEditingTab,
    setEditingName,
    historyState: hist,
    nodeFileModal,
    setNodeFileModal,
    graphForRun,
    fullGraph,
    activeTabName,
    switchTab,
    addTab,
    closeTab,
    startRenameTab,
    commitRenameTab,
    undo,
    redo,
    openGraphInNewTab,
    refreshUsernodesFromDefinition,
    stripUsernodesByDefinitionId,
    onPickNodeFile,
  } = useNodeFlowDocumentController({
    nodes,
    edges,
    nodesRef,
    edgesRef,
    setNodes,
    setEdges,
    setSelectedId: setSelId,
    setSelectedIds: setSelIds,
    setNodeErrors,
    setNodeWarnings,
    setNodeMenu,
    setDeleteConfirm: setDelConfirm,
    onToast,
    loadRequest,
    onLoadConsumed,
    onWorkflowsChanged,
    command,
    onDocumentStatus: (text) => documentStatusRef.current(text),
  });

  useEffect(() => {
    registerActiveNodeFlowGraphGetter(() => ({
      nodes: nodesRef.current,
      edges: edgesRef.current,
    }));
    return () => registerActiveNodeFlowGraphGetter(null);
  }, []);

  const highlightNode = useCallback(
    (nodeId: string) => {
      if (!nodeId) return;
      const node =
        nodesRef.current.find((n) => n.id === nodeId) ||
        findChildNode(nodesRef.current, nodeId)?.child ||
        null;
      setSelId(nodeId);
      setSelIds([nodeId]);
      fireLineageFlash(nodeId);
      if (node && typeof node.x === "number" && typeof node.y === "number") {
        panTo(node.x + 90, node.y + 40);
      }
    },
    [fireLineageFlash, panTo],
  );

  const lastSelectCmd = useRef(0);
  useEffect(() => {
    if (!command || command.id === lastSelectCmd.current) return;
    if (command.action === "clearSelection") {
      lastSelectCmd.current = command.id;
      setSelId(null);
      setSelIds([]);
      setSelEdge(null);
      return;
    }
    if (command.action !== "selectNode" || !command.nodeId) return;
    lastSelectCmd.current = command.id;
    highlightNode(command.nodeId);
  }, [command, highlightNode]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const definition = detail?.definition;
      if (!definition || typeof definition.id !== "string") return;
      refreshUsernodesFromDefinition(definition);
    };
    const onDeleted = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const definitionId = detail?.definitionId;
      if (!definitionId || typeof definitionId !== "string") return;
      stripUsernodesByDefinitionId(definitionId);
    };
    window.addEventListener("samql-created-node-updated", onUpdated);
    window.addEventListener("samql-created-node-deleted", onDeleted);
    return () => {
      window.removeEventListener("samql-created-node-updated", onUpdated);
      window.removeEventListener("samql-created-node-deleted", onDeleted);
    };
  }, [refreshUsernodesFromDefinition, stripUsernodesByDefinitionId]);

  const openCreatedNode = useCallback(
    (nodeId: string) => {
      const top = nodesRef.current.find((node) => node.id === nodeId) || null;
      const nested = top ? null : findChildNode(nodesRef.current, nodeId);
      const node = top || nested?.child || null;
      if (!node || node.type !== "usernode") {
        onToast("warn", "Open Node", "Select a Created Node instance.");
        return;
      }
      const definitionId = String(node.config?.definitionId || "").trim();
      const embedded = node.config?.graph;
      const catalog = definitionId
        ? loadCreatedNodes().find((item) => item.id === definitionId)
        : undefined;
      const graph = catalog?.graph || embedded;
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        onToast("error", "Open Node", "This Created Node has no editable graph.");
        return;
      }
      const name =
        catalog?.name ||
        String(node.config?.name || node.config?.label || "Created node");
      openGraphInNewTab(graph, name, {
        editingDefinitionId:
          definitionId ||
          (catalog?.id ? catalog.id : undefined),
      });
      onToast("ok", "Opened node", name);
    },
    [onToast, openGraphInNewTab],
  );

  // A selection can be a top-level node or a child living inside a container.
  // Child lookup is shared with graph commands so every editor path resolves
  // nested nodes the same way.
  const childCtx = useCallback(
    (id: string | null) => findChildNode(nodes, id),
    [nodes],
  );
  const topSel = nodes.find((n) => n.id === selId) || null;
  const childSelCtx = topSel ? null : childCtx(selId);
  const sel: NbNode | null = topSel || (childSelCtx ? childSelCtx.child : null);
  const { graphForApi, graphSig } = useNodeFlowGraphSnapshot(nodes, edges);

  const {
    addNodeAt,
    patch,
    groupAddChild,
    groupReorder,
    partialGroupGraph,
    extractChildToCanvas,
    dissolveContainer,
    doRemoveNode,
    removeNode,
    deleteMany,
    moveNodeIntoGroup,
  } = useNodeFlowGraphController({
    nodesRef,
    edgesRef,
    liveRef,
    setNodes,
    setEdges,
    selectedId: selId,
    setSelectedId: setSelId,
    setSelectedIds: setSelIds,
    setNodeErrors,
    setDeleteConfirm: setDelConfirm,
    contentRef,
    zoomRef,
    fireBorn,
    withImplosion,
  });

  const onDeleteEdge = useCallback(
    (id: string) => {
      setSelEdge((current) => (current === id ? null : current));
      withEdgeRetract(id, () => {
        setEdges((current) => current.filter((edge) => edge.id !== id));
      });
    },
    [withEdgeRetract],
  );

  const { canPaste, copySelection, pasteClipboard } = useNodeFlowClipboard({
    nodesRef,
    edgesRef,
    selectedId: selId,
    selectedIdsRef: selIdsRef,
    setNodes,
    setEdges,
    setSelectedId: setSelId,
    setSelectedIds: setSelIds,
  });

  const {
    preview,
    setPreview,
    previewHeight,
    setPreviewHeight,
    running,
    runningNodeIds,
    status,
    setDocumentStatus,
    browseFolder,
    setBrowseFolder,
    dirList,
    doPreviewRef,
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
    outputKind,
    IMAGE_FORMATS_CHART,
    IMAGE_FORMATS_DASH,
    DATA_FORMATS,
    FORMAT_LABELS,
    loadDirList,
    runAll,
    cancelRun,
  } = useNodeFlowExecutionController({
    activeTabId,
    nodes,
    edges,
    liveRef,
    graphSig,
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
  });
  documentStatusRef.current = setDocumentStatus;

  const {
    groupHover,
    marquee,
    pendingWire,
    snapId,
    toContent,
    groupAtContentPoint,
    startCanvasPointer,
    startNodeDrag,
    startNodeResize,
    startWire,
    setHoveredInput,
  } = useNodeFlowCanvasInteractions({
    nodesRef,
    edgesRef,
    selectedIdsRef: selIdsRef,
    contentRef,
    wrapRef,
    zoomRef,
    doPreviewRef,
    setNodes,
    setEdges,
    setSelectedId: setSelId,
    setSelectedIds: setSelIds,
    setSelectedEdge: setSelEdge,
    moveNodeIntoGroup,
    patchNode: patch,
    onToast,
    snap,
    onInspectorOpen: () => onSelectionChange?.(true),
    onInspectorClose: () => onSelectionChange?.(false),
  });

  useNodeFlowKeyboardShortcuts({
    selectedId: selId,
    selectedEdgeRef: selEdgeRef,
    selectedIdsRef: selIdsRef,
    undo,
    redo,
    copy: copySelection,
    paste: () => {
      pasteClipboard();
    },
    deleteEdge: onDeleteEdge,
    deleteMany,
    deleteNode: removeNode,
  });

  useNodeFlowChartHydration({
    activeTabId,
    graphSignature: graphSig,
    nodes,
    edges,
    ensureChartFor,
  });

  // Keep the selected directory listing aligned with the folder field even
  // when the user edits that field without changing the node selection. A new
  // folder supersedes an older in-flight listing immediately.
  const selectedDirectoryFolder =
    sel?.type === "directory" ? String(sel.config.folder || "").trim() : null;
  const loadDirListEvent = useStableEvent(loadDirList);
  useEffect(() => {
    if (
      selectedDirectoryFolder !== null &&
      dirList.folder !== selectedDirectoryFolder
    ) {
      void loadDirListEvent(selectedDirectoryFolder);
    }
  }, [dirList.folder, loadDirListEvent, selectedDirectoryFolder]);

  // Keep the memoized canvas scene insulated from inspector, palette, preview,
  // and menu renders while still dispatching every event to the latest graph
  // and execution-controller implementation.
  const sceneAddNodeAt = useStableEvent(addNodeAt);
  const sceneGroupAddChild = useStableEvent(groupAddChild);
  const scenePatchNode = useStableEvent(patch);
  const sceneEnsureChartFor = useStableEvent(ensureChartFor);
  const sceneUpstreamChartNode = useStableEvent(upstreamChartNode);
  const sceneSetDashboardPane = useStableEvent(setDashPane);
  const sceneGroupReorder = useStableEvent(groupReorder);
  const sceneExtractChild = useStableEvent(extractChildToCanvas);

  // ---- render --------------------------------------------------------------
  return (
    <div className="nodeflow" data-testid="nodeflow-view" data-active-tab={activeTabId}>
      {nodeFileModal && (
        <FileBrowser
          saveMode={nodeFileModal.mode === "save"}
          defaultFileName={wfFileName(activeTabName() || "workflow")}
          onClose={() => setNodeFileModal(null)}
          onPick={onPickNodeFile}
        />
      )}
      <NodeFlowTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        editingTab={editingTab}
        editingName={editingName}
        setEditingName={setEditingName}
        onSwitchTab={switchTab}
        onStartRename={startRenameTab}
        onCommitRename={commitRenameTab}
        onCancelRename={() => {
          setEditingTab(null);
          setEditingName("");
        }}
        onCloseTab={closeTab}
        onAddTab={addTab}
        running={running}
        onCancelRun={() => { void cancelRun(); }}
        onRunAll={() => { void runAll(); }}
        canUndo={hist.canUndo}
        canRedo={hist.canRedo}
        onUndo={undo}
        onRedo={redo}
      />
      <NodeFlowPalette
        paletteHidden={paletteHidden}
        showNodeSearch={showNodeSearch}
        zoom={zoom}
        zoomBy={zoomBy}
        resetZoom={resetZoom}
        model={paletteModel}
      />
      <ToolsTablesPanel
        open={!!toolsTablesOpen}
        onClose={() => onToolsTablesOpenChange?.(false)}
        tables={tables}
        onRefreshTables={onTablesChanged}
        onOpenLoad={onOpenLoad}
        palette={paletteModel}
      />

      <div className="nb2-body">
        <NodeFlowScene
          nodes={nodes}
          edges={edges}
          running={status.kind === "running"}
          runningNodeIds={runningNodeIds}
          wrapRef={wrapRef}
          contentRef={contentRef}
          onScroll={measureViewport}
          onCanvasPointerDown={startCanvasPointer}
          toContent={toContent}
          groupAtContentPoint={groupAtContentPoint}
          setCanvasMenu={setCanvasMenu}
          addNodeAt={sceneAddNodeAt}
          groupAddChild={sceneGroupAddChild}
          zoom={zoom}
          snap={snap}
          dyingIds={dyingIds}
          dyingEdgeIds={dyingEdgeIds}
          selectedEdge={selEdge}
          setSelectedEdge={setSelEdge}
          deleteEdge={onDeleteEdge}
          pendingWire={pendingWire}
          marquee={marquee}
          selectedId={selId}
          selectedIds={selIds}
          selectedIdsRef={selIdsRef}
          setSelectedId={setSelId}
          setSelectedIds={setSelIds}
          viewport={scrollPos}
          minimapMini={mmMini}
          toggleMinimap={toggleMinimap}
          panTo={panTo}
          groupHover={groupHover}
          nodeErrors={nodeErrors}
          nodeWarnings={nodeWarnings}
          ripple={ripple}
          snapId={snapId}
          bornId={bornId}
          lineageFlashId={lineageFlashId}
          chartData={chartData}
          patchNode={scenePatchNode}
          ensureChartFor={sceneEnsureChartFor}
          upstreamChartNode={sceneUpstreamChartNode}
          setDashboardPane={sceneSetDashboardPane}
          groupReorder={sceneGroupReorder}
          extractChildToCanvas={sceneExtractChild}
          startNodeDrag={startNodeDrag}
          startNodeResize={startNodeResize}
          startWire={startWire}
          setHoveredInput={setHoveredInput}
          setNodeMenu={setNodeMenu}
          denseMode={denseMode}
        />

        {/* inspector — floats over the canvas, or (when the tables panel is
            shown and a node is selected) is portaled into the tables-panel slot */}
        <NodeFlowInspectorPanel
          scopeKey={activeTabId}
          nodes={nodes}
          edges={edges}
          selectedId={selId}
          graphSig={graphSig}
          graphForApi={graphForApi}
          childCtx={childCtx}
          partialGroupGraph={partialGroupGraph}
          patch={patch}
          showTables={showTables}
          inspectorHost={inspectorHost}
          onSelectionChange={onSelectionChange}
          runtime={{
            chartData,
            DATA_FORMATS,
            dirList,
            dissolveContainer,
            doChart,
            doCreateTable,
            doExport,
            doFetchApi,
            doPreview,
            doProfile,
            doReadDirectory,
            doReadFolder,
            doReconcile,
            doRunIterator,
            doRunWhile,
            doValidate,
            doWriteTable,
            ensureChartFor,
            FORMAT_LABELS,
            IMAGE_FORMATS_CHART,
            IMAGE_FORMATS_DASH,
            loadDirList,
            onToast,
            outputKind,
            patchSeriesColor,
            patchStyle,
            removeNode,
            running,
            setBrowseFolder,
            setDashPane,
            setHelpFor,
            tables,
            upstreamChartNode,
            validateResults,
          }}
        />
      </div>

      <NodeFlowPreviewDrawer
        preview={preview}
        height={previewHeight}
        setHeight={setPreviewHeight}
        onClose={() => setPreview(null)}
        getLineageGraph={fullGraph}
        onHighlightNode={highlightNode}
      />

      {browseFolder && sel && (sel.type === "output" || sel.type === "directory" || sel.type === "appendfolder") && (
        <FileBrowser
          pickFolder
          initialPath={sel.config.folder || undefined}
          onClose={() => setBrowseFolder(false)}
          onPick={(dir) => {
            if (sel.type === "directory") {
              patch(sel.id, { folder: dir, file: "", path: "", table: "", columns: [] });
              void loadDirList(dir);
            } else if (sel.type === "appendfolder") {
              patch(sel.id, { folder: dir, table: "", columns: [], files: 0 });
              void doReadFolder(sel, dir);
            } else {
              patch(sel.id, { folder: dir });
            }
            setBrowseFolder(false);
          }}
        />
      )}

      <NodeFlowMenus
        nodeMenu={nodeMenu}
        setNodeMenu={setNodeMenu}
        selectedIds={selIds}
        canPaste={canPaste}
        copySelection={copySelection}
        pasteClipboard={pasteClipboard}
        deleteMany={deleteMany}
        removeNode={removeNode}
        canOpenCreatedNode={(() => {
          if (!nodeMenu) return false;
          const top =
            nodes.find((node) => node.id === nodeMenu.id) || null;
          const nested = top ? null : findChildNode(nodes, nodeMenu.id);
          const node = top || nested?.child || null;
          return !!(
            node &&
            node.type === "usernode" &&
            (node.config?.graph || node.config?.definitionId)
          );
        })()}
        onOpenCreatedNode={
          nodeMenu ? () => openCreatedNode(nodeMenu.id) : undefined
        }
        deleteConfirm={delConfirm}
        setDeleteConfirm={setDelConfirm}
        doRemoveNode={doRemoveNode}
        helpFor={helpFor}
        setHelpFor={setHelpFor}
        canvasMenu={canvasMenu}
        setCanvasMenu={setCanvasMenu}
        running={running}
        nodeCount={nodes.length}
        cancelRun={() => { void cancelRun(); }}
        runAll={() => { void runAll(); }}
        addTypeAt={(type, point) => {
          const group = groupAtContentPoint(point.x, point.y);
          if (
            group &&
            type !== "group" &&
            type !== "iterator" &&
            type !== "usernode"
          ) {
            groupAddChild(group.id, type);
          } else {
            addNodeAt(type, point.x - NODE_W / 2, point.y - HEAD_H);
          }
        }}
      />

      <NodeFlowStatusBar
        kind={status.kind}
        text={status.text}
        running={running}
        nodeCount={nodes.length}
        edgeCount={edges.length}
      />
    </div>
  );
};
