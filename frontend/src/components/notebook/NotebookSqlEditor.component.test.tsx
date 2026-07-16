import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotebookSqlEditor } from "./NotebookCellShared";
import type { RunCell } from "./NotebookCellTypes";

describe("NotebookSqlEditor height", () => {
  it("does not cap shell minHeight at 16 lines for tall Journal SQL", () => {
    const code = Array.from({ length: 40 }, (_, i) => `SELECT ${i}`).join("\n");
    const cell: RunCell = {
      id: "c1",
      type: "sql",
      name: "cell1",
      code,
      text: "",
    };
    render(
      <NotebookSqlEditor
        cell={cell}
        tables={[]}
        onChangeCode={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    const shell = screen.getByTestId("notebook-sql-editor-shell");
    const minH = parseFloat(shell.style.minHeight || "0");
    // 40 lines × 20 + 22 — must exceed the old 16-line ceiling (16*20+22=342)
    expect(minH).toBeGreaterThan(342);
    expect(minH).toBe(40 * 20 + 22);
  });
});
