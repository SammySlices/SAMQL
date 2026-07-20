import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const pivotMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const saveToDownloadsMock = vi.hoisted(() =>
  vi.fn(async (filename: string) => ({
    path: "C:/Downloads/" + filename,
    filename,
  })),
);

vi.mock("../lib/api", () => ({
  api: {
    pivot: pivotMock,
    cancelQuery: cancelQueryMock,
  },
  saveToDownloads: saveToDownloadsMock,
}));

import { PivotPanel } from "./PivotPanel";

function dropField(field: string, tileSelector: string, from = "drawer") {
  const tile = document.querySelector(tileSelector);
  expect(tile).toBeTruthy();
  fireEvent.drop(tile!, {
    dataTransfer: { getData: () => JSON.stringify({ field, from }) },
  });
}

/** Render the panel and aggregate one pivot so there is something to export. */
async function withPivot(
  result = {
    columns: ["region", "sum(bal)"],
    rows: [
      ["North", 1200],
      ["South", 3400],
    ],
    row_count: 2,
  },
  onToast = vi.fn(),
) {
  pivotMock.mockResolvedValue(result);
  render(
    <PivotPanel
      tables={[]}
      result={{ id: "r1", columns: ["region", "bal"] }}
      onToast={onToast}
    />,
  );
  dropField("region", ".pv-tile.pv-rows");
  await waitFor(() => expect(pivotMock).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByTestId("pivot-export-csv")).not.toBeDisabled(),
  );
  return { onToast };
}

describe("PivotPanel — export to CSV", () => {
  beforeEach(() => {
    pivotMock.mockReset();
    cancelQueryMock.mockReset();
    saveToDownloadsMock.mockClear();
  });

  it("disables the button until there is a pivot to export", () => {
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["region", "bal"] }}
        onToast={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pivot-export-csv")).toBeDisabled();
  });

  it("writes the pivot to a CSV file with a header row", async () => {
    await withPivot();
    fireEvent.click(screen.getByTestId("pivot-export-csv"));

    await waitFor(() => expect(saveToDownloadsMock).toHaveBeenCalled());
    const [filename, payload] = saveToDownloadsMock.mock.calls[0] as any;
    expect(filename).toBe("pivot_result.csv");
    expect(payload.text).toBe("region,sum(bal)\nNorth,1200\nSouth,3400\n");
  });

  it("reports the saved path back to the host", async () => {
    const { onToast } = await withPivot();
    fireEvent.click(screen.getByTestId("pivot-export-csv"));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "ok",
        "Exported",
        "C:/Downloads/pivot_result.csv",
      ),
    );
  });

  it("surfaces a failure instead of failing silently", async () => {
    const { onToast } = await withPivot();
    saveToDownloadsMock.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getByTestId("pivot-export-csv"));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("error", "Export failed", "disk full"),
    );
    // and the button recovers rather than staying stuck on "Exporting…"
    await waitFor(() =>
      expect(screen.getByTestId("pivot-export-csv")).not.toBeDisabled(),
    );
  });

  it("quotes values containing commas", async () => {
    await withPivot({
      columns: ["region", "note"],
      rows: [["North", "a,b"]],
      row_count: 1,
    });
    fireEvent.click(screen.getByTestId("pivot-export-csv"));
    await waitFor(() => expect(saveToDownloadsMock).toHaveBeenCalled());
    const payload = (saveToDownloadsMock.mock.calls[0] as any)[1];
    expect(payload.text).toBe('region,note\nNorth,"a,b"\n');
  });

  it("exports in the order the grid is sorted, not the raw order", async () => {
    await withPivot({
      columns: ["region", "total"],
      rows: [
        ["North", 1],
        ["South", 2],
      ],
      row_count: 2,
    });

    // The sort handler lives on the header's inner label span.
    const labels = document.querySelectorAll("thead .pv-th-label");
    expect(labels.length).toBeGreaterThan(0);
    fireEvent.click(labels[0]); // ascending
    fireEvent.click(labels[0]); // descending

    fireEvent.click(screen.getByTestId("pivot-export-csv"));
    await waitFor(() => expect(saveToDownloadsMock).toHaveBeenCalled());
    const payload = (saveToDownloadsMock.mock.calls[0] as any)[1];
    expect(payload.text).toBe("region,total\nSouth,2\nNorth,1\n");
  });
});
