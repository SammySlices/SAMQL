import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELD_EXPLORER_STORE_KEY,
  FieldExplorer,
} from "./FieldExplorer";
import { api } from "../lib/api";
import type { TableInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    columnFields: vi.fn(),
    shredPlan: vi.fn(),
  },
  copyText: vi.fn(() => Promise.resolve()),
}));

const nestedTable = (): TableInfo[] => [
  {
    engine: "duckdb",
    name: "orders",
    source: "orders.json",
    row_count: 10,
    columns: [{ name: "json", type: "JSON", hint: "json" }],
  },
];

const arrayFieldTree = {
  fields: [
    {
      depth: 1,
      name: "legs",
      type: "array of object",
      kind: "array",
      access: {
        first: "json -> '$.legs[0]'",
        sel: "json(e1)",
        unnests: ["UNNEST(from_json(json -> '$.legs', '[\"VARCHAR\"]')) AS x1(e1)"],
        note: "one row per JSON array element",
      },
    },
  ],
};

describe("FieldExplorer shred steering", () => {
  beforeEach(() => {
    localStorage.removeItem(FIELD_EXPLORER_STORE_KEY);
    vi.mocked(api.columnFields).mockResolvedValue(arrayFieldTree as any);
  });

  it("offers 'Shred to tables' for an array node when the column is shreddable", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({
      tables: [
        { name: "orders", path: "json", keys: ["_rid"], parent: null, depth: 1, fields: [], child_arrays: [] },
        { name: "orders_legs", path: "json.legs", keys: ["_rid", "legs_ord"], parent: "orders", depth: 1, fields: [], child_arrays: [] },
      ],
    } as any);
    const onShred = vi
      .fn()
      .mockResolvedValue({ ok: true, created: 2 });

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={onShred}
      />,
    );

    // the single nested column auto-selects; click the array field
    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);

    const btn = await screen.findByTestId("fx-shred-run");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(onShred).toHaveBeenCalledWith(
        "duckdb",
        "orders",
        "json",
        ["orders", "orders_legs"],
      ),
    );
  });

  it("offers 'Flatten to tables' for a deep-opaque column that can't shred in place", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);
    const onFlatten = vi.fn().mockResolvedValue({ ok: true, created: 3 });

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={vi.fn()}
        onFlatten={onFlatten}
      />,
    );

    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);

    const btn = await screen.findByTestId("fx-flatten-run");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(onFlatten).toHaveBeenCalledWith("duckdb", "orders"),
    );
    expect(screen.queryByTestId("fx-shred-run")).toBeNull();
  });

  it("guides to Flatten-on when the column is not shreddable and no flatten handler", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={vi.fn()}
      />,
    );

    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);

    const guide = await screen.findByTestId("fx-shred-guide");
    expect(guide.textContent).toContain("Flatten into relational tables");
    expect(screen.queryByTestId("fx-shred-run")).toBeNull();
  });
});

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
