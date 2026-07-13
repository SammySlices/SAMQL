import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotebookCell, type RunCell } from "./NotebookCell";

function sqlCell(overrides: Partial<RunCell> = {}): RunCell {
  return {
    id: "cell-1",
    type: "sql",
    name: "cell1",
    code: "SELECT 1",
    text: "",
    ...overrides,
  };
}

function noteCell(overrides: Partial<RunCell> = {}): RunCell {
  return {
    id: "note-1",
    type: "note",
    code: "",
    text: "# Heading\n- one\n- two",
    ...overrides,
  };
}

function mount(cell: RunCell, extra: Partial<React.ComponentProps<typeof NotebookCell>> = {}) {
  const props: React.ComponentProps<typeof NotebookCell> = {
    cell,
    index: 1,
    tables: [],
    canMoveUp: false,
    canMoveDown: true,
    onChangeCode: vi.fn(),
    onChangeText: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onReorderStart: vi.fn(),
    onRunUpstream: vi.fn(),
    onRunDownstream: vi.fn(),
    onRunBranch: vi.fn(),
    onAddBelow: vi.fn(),
    onToggleCollapse: vi.fn(),
    onResize: vi.fn(),
    onSetOutView: vi.fn(),
    onSort: vi.fn(),
    onLoadMore: vi.fn(),
    onExport: vi.fn(),
    onToast: vi.fn(),
    ...extra,
  };
  return { ...render(<NotebookCell {...props} />), props };
}

describe("NotebookCell interactions", () => {
  it("renders a surface-specific Journal editor and runs the owning cell", () => {
    const { props } = mount(sqlCell());
    expect(screen.getByTestId("notebook-sql-editor")).toHaveValue("SELECT 1");
    fireEvent.click(screen.getByTestId("journal-cell-run"));
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("turns the run badge into a scoped cancel while the cell is running", () => {
    const { props } = mount(sqlCell({ running: true }));
    fireEvent.click(screen.getByTestId("journal-cell-run"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("surfaces stale output and supports an inline rename commit", () => {
    const { props } = mount(sqlCell(), { stale: true, onRename: vi.fn() });
    expect(screen.getByText("stale")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/Click to rename/));
    const input = screen.getByDisplayValue("cell1");
    fireEvent.change(input, { target: { value: "renamed_cell" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("renamed_cell");
  });

  it("renders note markdown and switches to an editable textarea on double click", () => {
    const { props } = mount(noteCell());
    expect(screen.getByText("Heading")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByTitle("Double-click to edit"));
    const editor = screen.getByPlaceholderText(/Write a note/);
    fireEvent.change(editor, { target: { value: "updated" } });
    expect(props.onChangeText).toHaveBeenCalledWith("updated");
  });

  it("routes cell creation and deletion actions without mutating siblings", () => {
    const { props } = mount(noteCell());
    fireEvent.click(screen.getByRole("button", { name: /SQL/ }));
    expect(props.onAddBelow).toHaveBeenCalledWith("sql");
    fireEvent.click(screen.getByTitle("Delete note"));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("NotebookCell extracted renderers", () => {
  it("routes visualization source and collapse actions through the chart renderer", () => {
    const cell: RunCell = {
      id: "chart-1",
      type: "chart",
      code: "",
      text: "",
      sourceName: "",
    };
    const { props } = mount(cell, {
      sources: [{ name: "cell1", resultId: "r1", columns: ["x"] }],
      onSetSource: vi.fn(),
    });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "cell1" },
    });
    expect(props.onSetSource).toHaveBeenCalledWith("cell1");
    fireEvent.click(screen.getByTitle("Minimize"));
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("routes left and right source changes through the reconcile renderer", () => {
    const cell: RunCell = {
      id: "recon-1",
      type: "reconcile",
      code: "",
      text: "",
      recon: { keys: [], compare: [] },
    };
    const { props } = mount(cell, {
      reconSources: [
        { name: "left", columns: ["id"] },
        { name: "right", columns: ["id"] },
      ],
      onSetReconSource: vi.fn(),
    });

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "left" } });
    fireEvent.change(selects[1], { target: { value: "right" } });
    expect(props.onSetReconSource).toHaveBeenNthCalledWith(1, "left", "left");
    expect(props.onSetReconSource).toHaveBeenNthCalledWith(2, "right", "right");
  });
});
