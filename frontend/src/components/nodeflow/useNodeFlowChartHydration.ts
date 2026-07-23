import { useEffect, useRef } from "react";
import { nodeShowsBody, type NbEdge, type NbNode } from "../../lib/nodeFlowModel";

interface UseNodeFlowChartHydrationOptions {
  activeTabId: string;
  graphSignature: string;
  dataEpoch: number;
  /** When false, NodeFlow is hidden but kept mounted — defer re-hydration
   * until it becomes visible again (the cleared chart data can't go stale
   * while hidden, and re-fetching then is wasted work). */
  active?: boolean;
  nodes: NbNode[];
  edges: NbEdge[];
  ensureChartFor: (node: NbNode | null, force?: boolean) => Promise<void>;
}

/**
 * Restores expanded chart and dashboard bodies one frame at a time. The effect
 * is keyed by the structural graph signature—not the nodes array—so dragging
 * cards never requeues chart work, while loading a different graph into the
 * same tab still hydrates correctly. Every queued frame is canceled when the
 * graph, tab, or component changes.
 */
export function useNodeFlowChartHydration({
  activeTabId,
  graphSignature,
  dataEpoch,
  active = true,
  nodes,
  edges,
  ensureChartFor,
}: UseNodeFlowChartHydrationOptions): void {
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const ensureRef = useRef(ensureChartFor);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  ensureRef.current = ensureChartFor;

  useEffect(() => {
    if (!active) return;
    const currentNodes = nodesRef.current;
    if (!currentNodes.length) return;

    const nodeById = new Map<string, NbNode>(
      currentNodes.map((node): [string, NbNode] => [node.id, node]),
    );
    const incomingByPort = new Map<string, NbNode>();
    for (const edge of edgesRef.current) {
      const source = nodeById.get(edge.from.node);
      if (!source || source.type !== "chart") continue;
      incomingByPort.set(`${edge.to.node}\u001f${edge.to.port}`, source);
    }

    const queuedIds = new Set<string>();
    const queue: NbNode[] = [];
    const enqueue = (node: NbNode | null | undefined) => {
      if (!node || queuedIds.has(node.id)) return;
      queuedIds.add(node.id);
      queue.push(node);
    };

    for (const node of currentNodes) {
      if (node.type === "chart" && nodeShowsBody(node)) {
        enqueue(node);
      } else if (node.type === "dashboard" && nodeShowsBody(node)) {
        const panes = node.config.panes || ["in1", "in2", "in3", "in4"];
        for (const port of panes) {
          enqueue(incomingByPort.get(`${node.id}\u001f${port}`));
        }
      }
    }

    let cursor = 0;
    let frame: number | null = null;
    let cancelled = false;
    const pump = () => {
      frame = null;
      if (cancelled || cursor >= queue.length) return;
      void ensureRef.current(queue[cursor]);
      cursor += 1;
      if (cursor < queue.length) {
        frame = window.requestAnimationFrame(pump);
      }
    };
    if (queue.length) frame = window.requestAnimationFrame(pump);

    return () => {
      cancelled = true;
      if (frame != null) window.cancelAnimationFrame(frame);
    };
    // dataEpoch is a dep so a data change (which clears the chart-data cache in
    // the exec controller) re-queues the redraw -- otherwise expanded charts /
    // dashboards stayed blank until a manual refresh. `active` defers that
    // re-queue while NodeFlow is hidden: the data was already cleared, so
    // hydrating on return still shows fresh results without a background
    // refetch storm.
  }, [activeTabId, graphSignature, dataEpoch, active]);
}
