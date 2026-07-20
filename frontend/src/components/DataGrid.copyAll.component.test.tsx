import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { ResultPage } from "../lib/types";
import { DataGrid } from "./DataGrid";

function page(
  rows: unknown[][],
  columns = ["id", "value"],
  extra: Partial<ResultPage> = {},
): ResultPage {
  return {
    columns,
    rows: rows as any[][],
    total_rows: rows.length,
    result_id: "r1",
    ...extra,
  };
}

function mount(
  result: ResultPage,
  overrides: Partial<React.ComponentProps<typeof DataGrid>> = {},
) {
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
    clientWidth: { configurable: true, value: 480 },
    scrollHeight: {
      configurable: true,
      value: Math.max(560, result.rows.length * 28),
    },
    scrollWidth: {
      configurable: true,
      value: Math.max(960, 56 + result.columns.length * 150),
    },
  });
  fireEvent.scroll(grid);
  return { ...rendered, grid, props };
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => vi.restoreAllMocks());

describe("copy whole result", () => {
  it("offers a panel menu when the right-click misses a cell", () => {
    mount(page([[1, "a"]]));
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    expect(screen.getByTestId("grid-panel-menu")).toBeTruthy();
    expect(screen.getByTestId("grid-panel-copy-all")).toBeTruthy();
  });

  it("copies every loaded row with headers, not just the selection", async () => {
    const writeText = stubClipboard();
    mount(
      page([
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ]),
    );

    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\ta\n2\tb\n3\tc"),
    );
  });

  it("can copy without headers", async () => {
    const writeText = stubClipboard();
    mount(page([[1, "a"]]));
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all-noheaders"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("1\ta"));
  });

  it("fetches beyond the loaded window when the result is larger", async () => {
    const writeText = stubClipboard();
    const spy = vi.spyOn(api, "page").mockResolvedValue(
      page([
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ]),
    );

    // Grid holds one row; the result really has three.
    mount(page([[1, "a"]], ["id", "value"], { total_rows: 3 }), {
      cellFetch: { resultId: "r1" },
    });

    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toBe("r1");
    expect(spy.mock.calls[0][1]).toMatchObject({ offset: 0, limit: 3 });
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\ta\n2\tb\n3\tc"),
    );
  });

  it("caps the fetch at 5,000 rows for a huge result", async () => {
    stubClipboard();
    const spy = vi.spyOn(api, "page").mockResolvedValue(page([[1, "a"]]));

    mount(page([[1, "a"]], ["id", "value"], { total_rows: 250_000 }), {
      cellFetch: { resultId: "r1" },
    });
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][1]).toMatchObject({ limit: 5000 });
  });

  it("says how many of the total rows the copy will actually take", () => {
    mount(page([[1, "a"]], ["id", "value"], { total_rows: 250_000 }), {
      cellFetch: { resultId: "r1" },
    });
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    expect(screen.getByTestId("grid-panel-menu")).toHaveTextContent(
      /250,000 rows total — copying 5,000/,
    );
  });

  it("promises only the loaded rows when there is no way to fetch more", () => {
    // A NodeFlow preview: 200 loaded of 10,000, and no result id to page with.
    // The label must not claim 5,000.
    const rows = Array.from({ length: 200 }, (_, i) => [i, `v${i}`]);
    mount(page(rows, ["id", "value"], { total_rows: 10_000, result_id: null }));
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    const menu = screen.getByTestId("grid-panel-menu");
    expect(menu).toHaveTextContent(/Copy results with headers \(200 rows\)/);
    expect(menu).toHaveTextContent(/10,000 rows total — copying 200/);
  });

  it("keeps the server's sort and filters so the copy matches the view", async () => {
    stubClipboard();
    const spy = vi.spyOn(api, "page").mockResolvedValue(page([[1, "a"]]));
    const filters = [{ col: "id", op: "gt", value: 0 }] as any;

    mount(page([[1, "a"]], ["id", "value"], { total_rows: 9 }), {
      sortCol: "value",
      descending: true,
      cellFetch: { resultId: "r1", filters },
    });
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][1]).toMatchObject({
      sort_col: "value",
      descending: true,
      filters,
    });
  });

  it("falls back to the loaded rows when the fetch fails", async () => {
    const writeText = stubClipboard();
    vi.spyOn(api, "page").mockRejectedValue(new Error("network"));

    mount(page([[1, "a"]], ["id", "value"], { total_rows: 3 }), {
      cellFetch: { resultId: "r1" },
    });
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    // Partial data beats an empty clipboard.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\ta"));
  });

  it("copies loaded rows without a round trip when there is no result id", async () => {
    const writeText = stubClipboard();
    const spy = vi.spyOn(api, "page");

    // NodeFlow previews build their page inline, with no result id.
    mount(page([[1, "a"]], ["id", "value"], { total_rows: 3, result_id: null }));
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\ta"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("also offers copy-all from the cell menu", async () => {
    const writeText = stubClipboard();
    mount(
      page([
        [1, "a"],
        [2, "b"],
      ]),
    );
    const cell = screen
      .getByTestId("result-grid")
      .querySelector('[data-column="value"][data-row-index="0"]') as HTMLElement;
    fireEvent.contextMenu(cell);

    fireEvent.click(screen.getByTestId("grid-menu-copy-all"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\ta\n2\tb"),
    );
  });

  it("copies every column, including ones scrolled out of view", async () => {
    const writeText = stubClipboard();
    const columns = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const rows = [columns.map((_, c) => `v${c}`)];
    mount(page(rows, columns));

    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const tsv = String(writeText.mock.calls[0][0]);
    expect(tsv).toContain("c99");
    expect(tsv).toContain("v99");
  });

  it("writes empty cells for nulls rather than the text 'null'", async () => {
    const writeText = stubClipboard();
    mount(page([[1, null]]));
    fireEvent.contextMenu(screen.getByTestId("result-grid"));
    fireEvent.click(screen.getByTestId("grid-panel-copy-all"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("id\tvalue\n1\t"));
  });
});
