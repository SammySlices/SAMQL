import React, { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NbNode } from "../../lib/nodeFlowModel";
import {
  NODE_CLICK_SLOP_PX,
  useNodeFlowCanvasInteractions,
} from "./useNodeFlowCanvasInteractions";

const node: NbNode = {
  id: "n1",
  type: "input",
  x: 40,
  y: 50,
  config: { label: "Trades" },
};

function pointer(partial: Partial<React.PointerEvent>): React.PointerEvent {
  return {
    button: 0,
    clientX: 100,
    clientY: 80,
    stopPropagation() {},
    preventDefault() {},
    ...partial,
  } as React.PointerEvent;
}

function setup() {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const setSelectedId = vi.fn();
  const setSelectedIds = vi.fn();
  const setNodes = vi.fn();
  const wrap = document.createElement("div");
  const content = document.createElement("div");
  content.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;

  const { result } = renderHook(() => {
    const nodesRef = useRef<NbNode[]>([node]);
    const edgesRef = useRef([]);
    const selectedIdsRef = useRef<string[]>([]);
    const contentRef = useRef<HTMLDivElement | null>(content);
    const wrapRef = useRef<HTMLDivElement | null>(wrap);
    const zoomRef = useRef(1);
    const doPreviewRef = useRef(null);
    return useNodeFlowCanvasInteractions({
      nodesRef,
      edgesRef,
      selectedIdsRef,
      contentRef,
      wrapRef,
      zoomRef,
      doPreviewRef,
      setNodes,
      setEdges: vi.fn(),
      setSelectedId,
      setSelectedIds,
      setSelectedEdge: vi.fn(),
      moveNodeIntoGroup: vi.fn(),
      patchNode: vi.fn(),
      onToast: vi.fn(),
      onInspectorOpen: onOpen,
      onInspectorClose: onClose,
    });
  });

  return { result, onOpen, onClose, setSelectedId };
}

describe("node click vs drag inspector", () => {
  it("opens configure on a left click that stays under the slop", () => {
    const { result, onOpen, onClose } = setup();
    act(() => {
      result.current.startNodeDrag(pointer({ clientX: 120, clientY: 90 }), node);
      window.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 122, clientY: 91, button: 0 }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("n1");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not open configure when the pointer moves past the slop", () => {
    const { result, onOpen, onClose } = setup();
    act(() => {
      result.current.startNodeDrag(pointer({ clientX: 120, clientY: 90 }), node);
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 120 + NODE_CLICK_SLOP_PX + 8,
          clientY: 90,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          clientX: 120 + NODE_CLICK_SLOP_PX + 8,
          clientY: 90,
          button: 0,
        }),
      );
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("treats a fast drag as a drag even if rAF never flushed before pointerup", () => {
    const { result, onOpen, onClose } = setup();
    act(() => {
      result.current.startNodeDrag(pointer({ clientX: 200, clientY: 40 }), node);
      // No pointermove / rAF — only a far-away pointerup, as in a quick flick.
      window.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 280, clientY: 48, button: 0 }),
      );
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
