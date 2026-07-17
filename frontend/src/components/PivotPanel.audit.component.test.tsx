import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const pivotMock = vi.hoisted(() => vi.fn());
const cancelQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../lib/api", () => ({
  api: {
    pivot: pivotMock,
    cancelQuery: cancelQueryMock,
  },
}));

import { PivotPanel } from "./PivotPanel";

function dropField(field: string, tileSelector: string, from = "drawer") {
  const tile = document.querySelector(tileSelector);
  expect(tile).toBeTruthy();
  fireEvent.drop(tile!, {
    dataTransfer: {
      getData: () => JSON.stringify({ field, from }),
    },
  });
}

describe("PivotPanel — audit fixes", () => {
  beforeEach(() => {
    pivotMock.mockReset();
    cancelQueryMock.mockReset();
  });

  // C1: switching the underlying result (same "Current result" slot, new id)
  // must reset the stale layout and recompute against the new result.
  it("resets and recomputes when the result id changes (C1)", async () => {
    pivotMock.mockResolvedValue({
      columns: ["g", "sum(bal)"],
      rows: [["a", 1]],
      row_count: 1,
    });
    const { rerender } = render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={vi.fn()}
      />,
    );

    dropField("g", ".pv-tile.pv-rows");
    await waitFor(() => expect(pivotMock).toHaveBeenCalledTimes(1));
    expect(pivotMock.mock.calls[0][0]).toMatchObject({ result_id: "r1" });

    // switch to a different result id in the same slot
    rerender(
      <PivotPanel
        tables={[]}
        result={{ id: "r2", columns: ["g", "bal"] }}
        onToast={vi.fn()}
      />,
    );

    // layout resets -> the build prompt returns (rows cleared, canRun false)
    await waitFor(() =>
      expect(screen.getByText(/Drag fields into/i)).toBeTruthy(),
    );

    // and a fresh drop now aggregates against the NEW result id
    dropField("g", ".pv-tile.pv-rows");
    await waitFor(() => expect(pivotMock).toHaveBeenCalledTimes(2));
    expect(pivotMock.mock.calls[1][0]).toMatchObject({ result_id: "r2" });
  });

  // C2: an expired result must not leave the panel stuck on "Building…".
  it("shows an explicit expired state and toasts when the result expired (C2)", async () => {
    pivotMock.mockResolvedValue({ error: "result expired" });
    const onToast = vi.fn();
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={onToast}
      />,
    );

    dropField("g", ".pv-tile.pv-rows");

    await waitFor(() =>
      expect(screen.getByTestId("pivot-expired")).toBeTruthy(),
    );
    expect(screen.queryByText("Building…")).toBeNull();
    expect(onToast).toHaveBeenCalledWith(
      "warn",
      "Result expired",
      expect.any(String),
    );
  });

  it("calls onExpired (and does not toast) when the host wires it (C2)", async () => {
    pivotMock.mockResolvedValue({ error: "result expired" });
    const onToast = vi.fn();
    const onExpired = vi.fn();
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={onToast}
        onExpired={onExpired}
      />,
    );

    dropField("g", ".pv-tile.pv-rows");

    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("pivot-expired")).toBeTruthy(),
    );
    expect(onToast).not.toHaveBeenCalledWith(
      "warn",
      "Result expired",
      expect.any(String),
    );
  });

  // S2: a drawer field dropped on cols while it is already in rows must leave
  // rows (a field can't sit in both axes).
  it("removes a field from the opposite axis when dropped on the other (S2)", async () => {
    pivotMock.mockResolvedValue({ columns: ["g"], rows: [], row_count: 0 });
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={vi.fn()}
      />,
    );

    dropField("g", ".pv-tile.pv-rows");
    const rowsTile = document.querySelector(".pv-tile.pv-rows") as HTMLElement;
    await waitFor(() =>
      expect(within(rowsTile).getByText("g")).toBeTruthy(),
    );

    // now drop the same field on cols
    dropField("g", ".pv-tile.pv-cols");
    const colsTile = document.querySelector(".pv-tile.pv-cols") as HTMLElement;
    await waitFor(() =>
      expect(within(colsTile).getByText("g")).toBeTruthy(),
    );
    // it must no longer be a chip in rows
    expect(within(rowsTile).queryByText("g")).toBeNull();
  });

  it("summarize popover has dialog role, focuses on open, and restores focus on Escape (S5)", async () => {
    pivotMock.mockResolvedValue({
      columns: ["g", "sum(bal)"],
      rows: [["a", 1]],
      row_count: 1,
    });
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={vi.fn()}
      />,
    );

    dropField("bal", ".pv-tile.pv-values");
    const chip = await screen.findByRole("button", { name: /sum of bal/i });
    chip.focus();
    fireEvent.click(chip);

    const dialog = await screen.findByRole("dialog", { name: /summarize bal/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(dialog.querySelector("button"));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  it("filter popover restores focus to the invoking chip on backdrop close (S5)", async () => {
    pivotMock.mockResolvedValue({
      columns: ["g", "sum(bal)"],
      rows: [["a", 1]],
      row_count: 1,
    });
    render(
      <PivotPanel
        tables={[]}
        result={{ id: "r1", columns: ["g", "bal"] }}
        onToast={vi.fn()}
      />,
    );

    dropField("g", ".pv-tile.pv-filters");
    const chip = await screen.findByRole("button", { name: /g/i });
    chip.focus();
    fireEvent.click(chip);

    await screen.findByRole("dialog", { name: /filter: g/i });
    fireEvent.mouseDown(document.querySelector(".pv-pop-back")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(chip);
  });
});
