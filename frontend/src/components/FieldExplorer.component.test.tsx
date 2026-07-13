import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELD_EXPLORER_STORE_KEY,
  FieldExplorer,
} from "./FieldExplorer";

describe("FieldExplorer minimize", () => {
  beforeEach(() => {
    localStorage.removeItem(FIELD_EXPLORER_STORE_KEY);
  });

  it("minimizes to an icon and expands on click", () => {
    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={[]}
        onToast={vi.fn()}
      />,
    );
    expect(screen.getByTestId("field-explorer-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("field-explorer-minimize"));
    expect(screen.queryByTestId("field-explorer-panel")).toBeNull();
    const mini = screen.getByTestId("field-explorer-mini");
    expect(mini).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(FIELD_EXPLORER_STORE_KEY) || "{}")
      .minimized).toBe(true);

    // click-without-drag expands
    fireEvent.mouseDown(mini, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("field-explorer-panel")).toBeTruthy();
    expect(screen.queryByTestId("field-explorer-mini")).toBeNull();
  });
});
