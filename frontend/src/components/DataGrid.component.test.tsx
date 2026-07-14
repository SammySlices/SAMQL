import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { ResultPage } from "../lib/types";
import { DataGrid } from "./DataGrid";

function page(rows: unknown[][], columns = ["id", "value"]): ResultPage {
  return { columns, rows: rows as any[][], total_rows: rows.length, result_id: "r1" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function mount(result: ResultPage, overrides: Partial<React.ComponentProps<typeof DataGrid>> = {}) {
  const props: React.ComponentProps<typeof DataGrid> = {
    page: result,
    sortCol: null,
    descending: false,
    onSort: vi.fn(),
    ...overrides,
  };
  const rendered = render(<DataGrid {...props} />);
  const grid = screen.getByTestId("result-grid");
  Object.defineProperties(grid, {
    clientHeight: { configurable: true, value: 280 },
    scrollHeight: { configurable: true, value: Math.max(560, result.rows.length * 28) },
  });
  return { ...rendered, grid, props };
}

afterEach(() => vi.restoreAllMocks());

describe("DataGrid DOM behavior", () => {
  it("virtualizes a large result instead of rendering every row", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i + 1, `row-${i + 1}`]);
    const { grid } = mount(page(rows));

    const renderedCells = grid.querySelectorAll('[data-column="id"][data-row-index]');
    expect(renderedCells.length).toBeGreaterThan(0);
    expect(renderedCells.length).toBeLessThan(80);
    expect(grid.querySelector('[data-row-index="499"]')).not.toBeInTheDocument();
  });

  it("shows absolute row numbers and capped badge for windowed pages", () => {
    const result = page(
      [
        [101, "a"],
        [102, "b"],
      ],
      ["id", "value"],
    );
    result.offset = 100;
    result.total_rows = 500;
    result.result_capped = true;
    result.result_cap = 10_000_000;
    mount(result);
    expect(screen.getByTestId("result-capped-badge")).toBeInTheDocument();
    expect(screen.getByTestId("grid-window-range").textContent).toMatch(
      /Showing rows 101/,
    );
    expect(
      document.querySelector('.gc-cell.rownum')?.textContent,
    ).toBe("101");
    expect(
      document.querySelector('[data-column="id"][data-row-index="100"]'),
    ).toBeTruthy();
  });

  it("renders the scrolled window and drops the distant first rows", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i + 1, `row-${i + 1}`]);
    const { grid } = mount(page(rows));

    Object.defineProperty(grid, "scrollTop", { configurable: true, writable: true, value: 28 * 250 });
    fireEvent.scroll(grid);

    await waitFor(() => expect(grid.querySelector('[data-row-index="250"]')).toBeInTheDocument());
    expect(grid.querySelector('[data-row-index="0"]')).not.toBeInTheDocument();
  });

  it("routes header clicks and near-bottom scrolling to the owning controller", () => {
    const onSort = vi.fn();
    const onLoadMore = vi.fn();
    const rows = Array.from({ length: 40 }, (_, i) => [i + 1, `row-${i + 1}`]);
    const { grid } = mount(page(rows), { onSort, onLoadMore, hasMore: true });

    fireEvent.click(screen.getByText("value"));
    expect(onSort).toHaveBeenCalledWith("value");

    Object.defineProperties(grid, {
      scrollTop: { configurable: true, writable: true, value: 1000 },
      clientHeight: { configurable: true, value: 280 },
      scrollHeight: { configurable: true, value: 1120 },
    });
    fireEvent.scroll(grid);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("opens structured values and ignores a stale full-value response", async () => {
    const first = deferred<{ value: string }>();
    const second = deferred<{ value: string }>();
    vi.spyOn(api, "resultCell")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    mount(
      page([
        [1, "first … [900 chars — truncated]"],
        [2, "second … [800 chars — truncated]"],
      ]),
      { cellFetch: { resultId: "r1" } },
    );

    const expanders = screen.getAllByTitle("View formatted");
    fireEvent.click(expanders[0]);
    fireEvent.click(expanders[1]);

    second.resolve({ value: '{"winner":"second"}' });
    await waitFor(() => expect(screen.getByTestId("structured-value-viewer")).toHaveTextContent("winner"));

    first.resolve({ value: '{"stale":"first"}' });
    await act(async () => { await Promise.resolve(); });
    const viewer = screen.getByTestId("structured-value-viewer");
    expect(viewer).toHaveTextContent("second");
    expect(viewer).not.toHaveTextContent("stale");
  });

  it("invalidates an in-flight full-value request when the viewer closes", async () => {
    const pending = deferred<{ value: string }>();
    vi.spyOn(api, "resultCell").mockReturnValueOnce(pending.promise);
    mount(page([[1, "payload … [900 chars — truncated]"]]), {
      cellFetch: { resultId: "r1" },
    });

    fireEvent.click(screen.getByTitle("View formatted"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("structured-value-viewer")).not.toBeInTheDocument();

    pending.resolve({ value: "late value" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("structured-value-viewer")).not.toBeInTheDocument();
  });
  it("uses an updated result id for a memoized grid's full-cell fetch", async () => {
    const spy = vi.spyOn(api, "resultCell").mockResolvedValue({ value: '{"ok":true}' });
    const result = page([[1, "payload … [900 chars — truncated]"]]);
    const { rerender, props } = mount(result, { cellFetch: { resultId: "old" } });

    rerender(<DataGrid {...props} cellFetch={{ resultId: "new" }} />);
    fireEvent.click(screen.getByTestId("structured-cell-expand"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].result_id).toBe("new");
  });

  it("copies selected cells via the selection bar and Ctrl+C", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    mount(
      page([
        [1, "alpha"],
        [2, "beta"],
      ]),
    );

    const cell = screen.getByTestId("result-grid").querySelector(
      '[data-column="value"][data-row-index="0"]',
    ) as HTMLElement;
    expect(cell).toBeTruthy();
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.mouseUp(cell);

    expect(screen.getByTestId("grid-sel-bar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("grid-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha"));

    writeText.mockClear();
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha"));

    fireEvent.click(screen.getByTestId("grid-copy-headers"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("value\nalpha"),
    );
  });

  it("opens a portaled cell menu with copy actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    mount(page([[10, "gamma"]]));
    const cell = screen.getByTestId("result-grid").querySelector(
      '[data-column="value"][data-row-index="0"]',
    ) as HTMLElement;
    fireEvent.contextMenu(cell);

    expect(screen.getByTestId("grid-cell-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("grid-menu-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("gamma"));
  });

});
