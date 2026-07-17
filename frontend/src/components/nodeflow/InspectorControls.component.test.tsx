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
});
