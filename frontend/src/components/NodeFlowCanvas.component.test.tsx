import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NbNode } from "../lib/nodeFlowModel";
import { CanvasNodeFrame, NodeMinimap, WireLayer } from "./NodeFlowCanvas";

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
