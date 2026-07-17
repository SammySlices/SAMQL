import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NbNode } from "../lib/nodeFlowModel";
import { CanvasNodeFrame, NodeMinimap, WireLayer } from "./NodeFlowCanvas";
import { NodeFlowCanvasShell } from "./nodeflow/NodeFlowCanvasShell";

const inputNode: NbNode = {
  id: "n1",
  type: "input",
  x: 20,
  y: 30,
  config: { label: "Trades" },
};

describe("NodeFlow canvas components", () => {
  it("selects and deletes a connection through separate hit targets", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <WireLayer
        wires={[{ id: "w1", ax: 0, ay: 0, bx: 100, by: 100, fromN: "n1", toN: "n2" }]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(container.querySelector(".nb2-wire-hit")!);
    expect(onSelect).toHaveBeenCalledWith("w1");
    fireEvent.click(container.querySelector(".nb2-wire-del")!);
    expect(onDelete).toHaveBeenCalledWith("w1");
  });

  it("applies lineage-flash class for white glow highlight", () => {
    const onPointerDown = vi.fn();
    const onContextMenu = vi.fn();
    const { rerender } = render(
      <CanvasNodeFrame
        node={inputNode}
        index={0}
        selected
        dropHover={false}
        error={undefined}
        warning={undefined}
        ripple={false}
        snapped={false}
        dying={false}
        born={false}
        lineageFlash={false}
        denseMode={false}
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <span>node body</span>
      </CanvasNodeFrame>,
    );

    expect(screen.getByTestId("nodeflow-node")).not.toHaveClass("lineage-flash");

    rerender(
      <CanvasNodeFrame
        node={inputNode}
        index={0}
        selected
        dropHover={false}
        error={undefined}
        warning={undefined}
        ripple={false}
        snapped={false}
        dying={false}
        born={false}
        lineageFlash
        denseMode={false}
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <span>node body</span>
      </CanvasNodeFrame>,
    );

    expect(screen.getByTestId("nodeflow-node")).toHaveClass("lineage-flash");
  });

  it("gives every connector a directional running-glow overlay", () => {
    const { container } = render(
      <WireLayer
        wires={[{ id: "w1", ax: 0, ay: 0, bx: 100, by: 100, fromN: "n1", toN: "n2" }]}
        selectedId={null}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // If per-node state is not supplied, the glow path preserves the global fallback.
    const glow = container.querySelector(".nb2-wire-glow");
    expect(glow).not.toBeNull();
    expect(glow).toHaveClass("active");
    const line = container.querySelector(".nb2-wire-line");
    expect(glow!.getAttribute("d")).toBe(line!.getAttribute("d"));
  });

  it("only activates input-edge glow for currently running target nodes", () => {
    const wires = [
      { id: "into-running", ax: 0, ay: 0, bx: 100, by: 40, fromN: "n1", toN: "n2" },
      { id: "from-running", ax: 100, ay: 40, bx: 200, by: 80, fromN: "n2", toN: "n3" },
      { id: "unrelated", ax: 0, ay: 80, bx: 100, by: 120, fromN: "n4", toN: "n5" },
    ];
    const { container, rerender } = render(
      <WireLayer
        wires={wires}
        runningNodeIds={new Set(["n2"])}
        selectedId={null}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const glows = [...container.querySelectorAll(".nb2-wire-glow")];
    expect(glows[0]).toHaveClass("active");
    expect(glows[1]).not.toHaveClass("active");
    expect(glows[2]).not.toHaveClass("active");

    rerender(
      <WireLayer
        wires={wires}
        runningNodeIds={new Set()}
        selectedId={null}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect([...container.querySelectorAll(".nb2-wire-glow.active")]).toHaveLength(0);
  });

  it("marks the canvas .flowing only while a workflow runs", () => {
    const shellProps = {
      isWiring: false,
      wrapRef: React.createRef<HTMLDivElement>(),
      contentRef: React.createRef<HTMLDivElement>(),
      onScroll: vi.fn(),
      onPointerDown: vi.fn(),
      onContextMenu: vi.fn(),
      onDrop: vi.fn(),
      zoom: 1,
      snap: false,
      wires: [{ id: "w1", ax: 0, ay: 0, bx: 100, by: 100, fromN: "n1", toN: "n2" }],
      dyingIds: new Set<string>(),
      dyingEdgeIds: new Set<string>(),
      runningNodeIds: new Set<string>(),
      selectedEdge: null,
      onSelectEdge: vi.fn(),
      onDeleteEdge: vi.fn(),
      pendingWire: null,
      marquee: null,
      nodes: [inputNode],
      selectedId: null,
      viewport: { x: 0, y: 0, w: 300, h: 200 },
      minimapMini: false,
      onToggleMinimap: vi.fn(),
      onPan: vi.fn(),
      renderedNodeCount: 1,
    };

    const { container, rerender } = render(
      <NodeFlowCanvasShell {...shellProps} running={false}>
        <div />
      </NodeFlowCanvasShell>,
    );
    expect(container.querySelector(".nb2-canvas-wrap")).not.toHaveClass("flowing");

    rerender(
      <NodeFlowCanvasShell {...shellProps} running>
        <div />
      </NodeFlowCanvasShell>,
    );
    expect(container.querySelector(".nb2-canvas-wrap")).toHaveClass("flowing");
  });

  it("renders semantic node identity and routes pointer selection", () => {
    const onPointerDown = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <CanvasNodeFrame
        node={inputNode}
        index={0}
        selected
        dropHover={false}
        error={undefined}
        warning={undefined}
        ripple={false}
        snapped={false}
        dying={false}
        born={false}
        lineageFlash={false}
        denseMode={false}
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <span>node body</span>
      </CanvasNodeFrame>,
    );

    const node = screen.getByTestId("nodeflow-node");
    expect(node).toHaveAttribute("data-node-id", "n1");
    expect(node).toHaveAttribute("data-node-label", "Trades");
    expect(node).toHaveClass("sel");
    fireEvent.pointerDown(node);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("routes right-click to contextmenu without treating it as inspector open", () => {
    const onPointerDown = vi.fn();
    const onContextMenu = vi.fn((e: React.MouseEvent) => {
      e.preventDefault();
    });
    const onInspectorOpen = vi.fn();
    render(
      <CanvasNodeFrame
        node={inputNode}
        index={0}
        selected
        dropHover={false}
        error={undefined}
        warning={undefined}
        ripple={false}
        snapped={false}
        dying={false}
        born={false}
        lineageFlash={false}
        denseMode={false}
        renderVersion="g1"
        chartVersion={0}
        childSelection={null}
        onPointerDown={(e, n) => {
          // Mirror startNodeDrag: ignore secondary button.
          if (e.button === 2) return;
          onPointerDown(e, n);
        }}
        onContextMenu={(e, n) => {
          // Mirror Scene: menu only — never open inspector.
          onContextMenu(e, n);
        }}
      >
        <span>node body</span>
      </CanvasNodeFrame>,
    );

    const node = screen.getByTestId("nodeflow-node");
    fireEvent.pointerDown(node, { button: 2 });
    fireEvent.contextMenu(node);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onInspectorOpen).not.toHaveBeenCalled();
  });

  it("exposes minimap collapse and pan behavior", () => {
    const onToggle = vi.fn();
    const onPan = vi.fn();
    const { container } = render(
      <NodeMinimap
        nodes={[inputNode, { ...inputNode, id: "n2", x: 500, y: 400 }]}
        selectedId="n1"
        zoom={1}
        viewport={{ x: 0, y: 0, w: 300, h: 200 }}
        mini={false}
        onToggle={onToggle}
        onPan={onPan}
      />,
    );

    const minimap = container.querySelector(".nb2-minimap")!;
    fireEvent.mouseDown(minimap, { clientX: 80, clientY: 60 });
    expect(onPan).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".nb2-mm-toggle")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not render an empty minimap", () => {
    const { container } = render(
      <NodeMinimap
        nodes={[]}
        selectedId={null}
        zoom={1}
        viewport={{ x: 0, y: 0, w: 100, h: 100 }}
        mini={false}
        onToggle={vi.fn()}
        onPan={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
