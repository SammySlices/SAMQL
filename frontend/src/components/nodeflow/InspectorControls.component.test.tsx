import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnPicker } from "./InspectorControls";

describe("ColumnPicker remove ×", () => {
  it("uses the shared red xbtn class for remove controls", () => {
    const onChange = vi.fn();
    render(
      <ColumnPicker
        chosen={["a", "b"]}
        available={["a", "b", "c"]}
        onChange={onChange}
        addLabel="+ Add field…"
      />,
    );
    const removeBtns = screen.getAllByTitle("Remove");
    expect(removeBtns).toHaveLength(2);
    for (const btn of removeBtns) {
      expect(btn.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["btn", "ghost", "icon", "xbtn"]),
      );
      expect(btn.textContent).toBe("×");
    }
    fireEvent.click(removeBtns[0]);
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("marks chosen columns missing from available with strikethrough class", () => {
    render(
      <ColumnPicker
        chosen={["a", "gone"]}
        available={["a", "b"]}
        onChange={vi.fn()}
        addLabel="+ Add field…"
      />,
    );
    const gone = screen.getByText("gone");
    expect(gone).toHaveClass("nb2-col-missing");
    expect(gone).toHaveAttribute("data-missing", "1");
    expect(screen.getByText("a")).not.toHaveClass("nb2-col-missing");
  });

  it("does not mark chosen columns missing when available is still unknown", () => {
    render(
      <ColumnPicker
        chosen={["a", "b"]}
        available={undefined}
        onChange={vi.fn()}
        addLabel="+ Add field…"
      />,
    );
    expect(document.querySelectorAll(".nb2-col-missing").length).toBe(0);
  });
});
