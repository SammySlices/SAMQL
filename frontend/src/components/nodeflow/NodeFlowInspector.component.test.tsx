import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NbNode } from "../../lib/nodeFlowModel";
import type { TableInfo } from "../../lib/types";
import {
  NodeFlowInspector,
  type NodeFlowInspectorContext,
} from "./NodeFlowInspector";

const table = (name: string): TableInfo => ({
  engine: "duckdb",
  name,
  source: "test",
  row_count: 1,
  columns: [],
});

const context = (
  sel: NbNode | null,
  overrides: Partial<NodeFlowInspectorContext> = {},
): NodeFlowInspectorContext =>
  ({
    sel,
    inspectorHost: null,
    inspectorDocked: false,
    showTables: false,
    running: false,
    tables: [],
    nodes: sel ? [sel] : [],
    edges: [],
    patch: vi.fn(),
    removeNode: vi.fn(),
    setHelpFor: vi.fn(),
    doPreview: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as NodeFlowInspectorContext;

describe("NodeFlowInspector", () => {
  it("renders the empty selection state", () => {
    render(<NodeFlowInspector context={context(null)} />);
    expect(screen.getByText("Select a node to configure it.")).toBeInTheDocument();
  });

  it("renders and updates an input node through the extracted inspector", () => {
    const node: NbNode = {
      id: "input-1",
      type: "input",
      x: 0,
      y: 0,
      config: { table: "", label: "input" },
    };
    const patch = vi.fn();
    const doPreview = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeFlowInspector
        context={context(node, {
          tables: [table("orders")],
          patch,
          doPreview,
        })}
      />,
    );

    expect(screen.getByText("Input node")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "orders" },
    });
    expect(patch).toHaveBeenCalledWith("input-1", {
      table: "orders",
      label: "orders",
    });

    fireEvent.click(screen.getByRole("button", { name: /preview output/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "out", "input · output");
  });
});
