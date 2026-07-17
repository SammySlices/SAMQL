import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ExportResultsButton,
  ExportResultsCtxItem,
} from "../components/ExportResultsMenu";
import type { ExportFormatOption } from "./resultExportFormats";

const formats: ExportFormatOption[] = [
  ["csv", "CSV"],
  ["json", "JSON"],
  ["parquet", "Parquet"],
];

describe("ExportResultsMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens format submenu on click and exports on select", () => {
    const onExport = vi.fn();
    render(<ExportResultsButton formats={formats} onExport={onExport} />);

    fireEvent.click(screen.getByTestId("export-results-button"));
    expect(screen.getByTestId("export-results-button-menu")).toBeTruthy();

    fireEvent.click(screen.getByTestId("export-json"));
    expect(onExport).toHaveBeenCalledWith("json");
    expect(screen.queryByTestId("export-results-button-menu")).toBeNull();
  });

  it("closes submenu on Escape and outside click", () => {
    render(
      <ExportResultsButton formats={formats} onExport={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("export-results-button"));
    expect(screen.getByTestId("export-results-button-menu")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("export-results-button-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("export-results-button"));
    fireEvent.mouseDown(document.querySelector(".rc-backdrop")!);
    expect(screen.queryByTestId("export-results-button-menu")).toBeNull();
  });

  it("renders ctx-menu flyout with accessible labels", () => {
    const onExport = vi.fn();
    render(
      <div className="ctx-menu">
        <ExportResultsCtxItem
          testId="ctx-export-results"
          formats={formats}
          onExport={onExport}
        />
      </div>,
    );

    const trigger = screen.getByTestId("ctx-export-results");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByTestId("ctx-export-results-menu")).toBeTruthy();

    fireEvent.click(screen.getByTestId("export-csv"));
    expect(onExport).toHaveBeenCalledWith("csv");
    expect(screen.queryByTestId("ctx-export-results-menu")).toBeNull();
  });
});
