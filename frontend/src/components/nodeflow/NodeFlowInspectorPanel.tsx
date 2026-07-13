import React, { useEffect } from "react";
import type { NbEdge, NbNode } from "../../lib/nodeFlowModel";
import { NodeFlowInspector } from "./NodeFlowInspector";
import {
  useNodeFlowInspectorController,
  type NodeFlowInspectorRuntime,
} from "./useNodeFlowInspectorController";

interface ChildSelection {
  groupId: string;
  index: number;
  child: NbNode;
}

interface NodeFlowInspectorPanelProps {
  scopeKey: string;
  nodes: NbNode[];
  edges: NbEdge[];
  selectedId: string | null;
  graphSig: string;
  graphForApi: () => any;
  childCtx: (id: string | null) => ChildSelection | null;
  partialGroupGraph: (groupId: string, count: number) => any;
  patch: (id: string, config: Record<string, any>) => void;
  showTables?: boolean;
  inspectorHost?: HTMLElement | null;
  onSelectionChange?: (hasSelection: boolean) => void;
  runtime: NodeFlowInspectorRuntime;
}

function NodeFlowInspectorPanelImpl({
  scopeKey,
  nodes,
  edges,
  selectedId,
  graphSig,
  graphForApi,
  childCtx,
  partialGroupGraph,
  patch,
  showTables,
  inspectorHost,
  onSelectionChange,
  runtime,
}: NodeFlowInspectorPanelProps) {
  const topLevelSelection =
    nodes.find((node) => node.id === selectedId) || null;
  const childSelection = topLevelSelection ? null : childCtx(selectedId);
  const selectedNode =
    topLevelSelection || (childSelection ? childSelection.child : null);

  useEffect(() => {
    onSelectionChange?.(!!selectedNode);
  }, [onSelectionChange, selectedNode]);

  const context = useNodeFlowInspectorController({
    scopeKey,
    nodes,
    edges,
    selectedId,
    selectedNode,
    childSelection,
    graphSig,
    graphForApi,
    partialGroupGraph,
    patch,
    showTables,
    inspectorHost,
    runtime,
  });

  return <NodeFlowInspector context={context} />;
}

// Node arrays receive new x/y objects on drag frames. The inspector consumes
// graph structure/configuration, not canvas position, so its memo boundary is
// keyed to the structural graph signature and to the small set of runtime
// result objects that actually change what the panel displays.
function sameInspectorPanelProps(
  previous: NodeFlowInspectorPanelProps,
  next: NodeFlowInspectorPanelProps,
): boolean {
  return (
    previous.scopeKey === next.scopeKey &&
    previous.selectedId === next.selectedId &&
    previous.graphSig === next.graphSig &&
    previous.showTables === next.showTables &&
    previous.inspectorHost === next.inspectorHost &&
    previous.onSelectionChange === next.onSelectionChange &&
    previous.runtime.chartData === next.runtime.chartData &&
    previous.runtime.dirList === next.runtime.dirList &&
    previous.runtime.running === next.runtime.running &&
    previous.runtime.tables === next.runtime.tables &&
    previous.runtime.validateResults === next.runtime.validateResults
  );
}

export const NodeFlowInspectorPanel = React.memo(
  NodeFlowInspectorPanelImpl,
  sameInspectorPanelProps,
);
