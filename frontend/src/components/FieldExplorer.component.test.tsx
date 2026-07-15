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
  flattenNestPath,
} from "./FieldExplorer";
import { api } from "../lib/api";
import type { TableInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    columnFields: vi.fn(),
    tableFields: vi.fn(),
    columnAccessPreview: vi.fn(),
    shredPlan: vi.fn(),
    tableRootIdOptions: vi.fn(),
    tableRootIdStats: vi.fn(),
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
      name: "json",
      type: "JSON",
      kind: "struct",
      column: "json",
      path: "json",
      access: { first: '"json"', sel: '"json"', unnests: [] },
    },
    {
      depth: 2,
      name: "legs",
      type: "array of object",
      kind: "array",
      column: "json",
      path: "json.legs",
      access: {
        first: "json -> '$.legs[0]'",
        sel: "json(e1)",
        unnests: ["UNNEST(from_json(json -> '$.legs', '[\"VARCHAR\"]')) AS x1(e1)"],
        note: "one row per JSON array element",
      },
    },
  ],
};

/** Expand a collapsed Field Explorer node so nested children become visible. */
async function expandField(name: string) {
  const caret = await screen.findByTestId(`fx-caret-${name}`);
  fireEvent.click(caret);
}

describe("FieldExplorer shred steering", () => {
  beforeEach(() => {
    localStorage.removeItem(FIELD_EXPLORER_STORE_KEY);
    vi.mocked(api.tableFields).mockResolvedValue(arrayFieldTree as any);
    vi.mocked(api.columnAccessPreview).mockResolvedValue({
      ok: true,
      sample: "preview-ok",
      sql: "SELECT json ->> '$.legs[0]' FROM \"orders\"",
      all_sql: "SELECT json(e1) FROM \"orders\", UNNEST(...)",
      access: arrayFieldTree.fields[1].access,
    } as any);
  });

  it("lists one source per loaded table (not per nested column)", async () => {
    vi.mocked(api.tableFields).mockResolvedValue({
      fields: [
        {
          depth: 1,
          name: "tradeId",
          type: "VARCHAR",
          kind: "scalar",
          column: "tradeId",
          access: { first: '"tradeId"', sel: '"tradeId"', unnests: [] },
        },
        {
          depth: 1,
          name: "terms",
          type: "STRUCT(...)",
          kind: "struct",
          column: "terms",
          access: { first: '"terms"', sel: '"terms"', unnests: [] },
        },
        {
          depth: 2,
          name: "legs",
          type: "array of object",
          kind: "array",
          column: "terms",
          path: "terms.legs",
          access: {
            first: "terms.legs[1]",
            sel: "e0",
            unnests: ['UNNEST("terms"."legs") AS _(e0)'],
          },
        },
        {
          depth: 1,
          name: "counterparty",
          type: "STRUCT(...)",
          kind: "struct",
          column: "counterparty",
          access: { first: '"counterparty"', sel: '"counterparty"', unnests: [] },
        },
      ],
    } as any);
    const highlyNestedTable = (): TableInfo[] => [
      {
        engine: "duckdb",
        name: "highly_nested_trades",
        source: "highly_nested_trades.json",
        row_count: 2,
        columns: [
          { name: "tradeId", type: "VARCHAR" },
          { name: "product", type: "VARCHAR" },
          { name: "book", type: "VARCHAR" },
          { name: "counterparty", type: "STRUCT(...)", hint: "struct" },
          { name: "terms", type: "STRUCT(...)", hint: "struct" },
          { name: "collateral", type: "STRUCT(...)", hint: "struct" },
          { name: "audit", type: "STRUCT(...)", hint: "struct" },
        ],
      },
    ];
    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={highlyNestedTable()}
        onToast={vi.fn()}
      />,
    );
    const select = await screen.findByTitle("Pick a loaded table to explore");
    const opts = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    // One table source — never table › column per nested STRUCT.
    expect(opts.filter((t) => t && t !== "Pick a table…")).toEqual([
      "highly_nested_trades",
    ]);
    expect(opts.some((t) => t?.includes("›") || t?.includes(" > "))).toBe(
      false,
    );
    expect(
      opts.some(
        (t) =>
          !!t &&
          /counterparty|terms|collateral|audit/i.test(t) &&
          t !== "highly_nested_trades",
      ),
    ).toBe(false);
    await screen.findByText("tradeId");
    await screen.findByText("terms");
    await screen.findByText("counterparty");
    // Nested children stay hidden until the parent caret is expanded.
    expect(screen.queryByText("legs")).toBeNull();
    await expandField("terms");
    await screen.findByText("legs");
    await waitFor(() =>
      expect(api.tableFields).toHaveBeenCalledWith(
        "duckdb",
        "highly_nested_trades",
      ),
    );
  });

  it("expands and collapses nested fields via the caret without selecting the row", async () => {
    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
      />,
    );
    await screen.findByText("json");
    expect(screen.queryByText("legs")).toBeNull();
    const caret = await screen.findByTestId("fx-caret-json");
    expect(caret.textContent).toBe("▸");

    fireEvent.click(caret);
    expect(caret.textContent).toBe("▾");
    await screen.findByText("legs");
    // Caret click must not select the parent row (selection stays empty).
    expect(screen.getByTestId("fx-sel-bar").textContent).toMatch(
      /Check fields to combine/i,
    );
    expect(screen.queryByTestId("fx-preview-sample")).toBeNull();

    fireEvent.click(caret);
    expect(caret.textContent).toBe("▸");
    expect(screen.queryByText("legs")).toBeNull();
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

    // Structs start collapsed — expand the parent before selecting the array.
    await expandField("json");
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

  it("flattenNestPath walks up from null-path (element) leaves to contacts", () => {
    const fields = [
      {
        depth: 1,
        name: "counterparty",
        type: "object",
        kind: "struct",
        column: "counterparty",
        path: "counterparty",
      },
      {
        depth: 2,
        name: "contacts",
        type: "array of object",
        kind: "array",
        column: "counterparty",
        path: "counterparty.contacts",
      },
      {
        depth: 3,
        name: "(element)",
        type: "object",
        kind: "struct",
        column: "counterparty",
        path: null,
      },
      {
        depth: 4,
        name: "phones",
        type: "array of text",
        kind: "array-scalar",
        column: "counterparty",
        path: null,
      },
    ];
    expect(flattenNestPath(fields, 3, "counterparty")).toBe(
      "counterparty.contacts",
    );
    expect(flattenNestPath(fields, 1, "counterparty")).toBe(
      "counterparty.contacts",
    );
    expect(flattenNestPath(fields, 0, "counterparty")).toBe("counterparty");
  });

  it("Flatten on a null-path leaf sends the ancestor nest path, not the leaf name", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);
    vi.mocked(api.tableFields).mockResolvedValue({
      fields: [
        {
          depth: 1,
          name: "counterparty",
          type: "object",
          kind: "struct",
          column: "counterparty",
          path: "counterparty",
          access: { first: "counterparty", sel: "counterparty", unnests: [] },
        },
        {
          depth: 2,
          name: "contacts",
          type: "array of object",
          kind: "array",
          column: "counterparty",
          path: "counterparty.contacts",
          access: {
            first: "counterparty.contacts",
            sel: "e1",
            unnests: ["UNNEST(...)"],
          },
        },
        {
          depth: 3,
          name: "(element)",
          type: "object",
          kind: "struct",
          column: "counterparty",
          path: null,
          access: { first: "e1", sel: "e1", unnests: [] },
        },
        {
          depth: 4,
          name: "phones",
          type: "array of text",
          kind: "array-scalar",
          column: "counterparty",
          path: null,
          access: { first: "e1.phones", sel: "e2", unnests: [] },
        },
      ],
    } as any);
    const onFlatten = vi.fn().mockResolvedValue({ ok: true, created: 3 });
    vi.mocked(api.tableRootIdOptions).mockResolvedValue({
      ok: true,
      candidates: [{ steps: ["tradeId"], label: "tradeId", map: false }],
    } as any);
    vi.mocked(api.tableRootIdStats).mockResolvedValue({
      ok: true,
      unique: true,
      records: 2,
      distinct: 2,
      nonnull: 2,
      duplicated: 0,
      nulls: 0,
      label: "tradeId",
    } as any);

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={[
          {
            engine: "duckdb",
            name: "trades",
            source: "trades.json",
            row_count: 2,
            columns: [
              { name: "counterparty", type: "STRUCT(...)", hint: "json" },
            ],
          },
        ]}
        onToast={vi.fn()}
        onShred={vi.fn()}
        onFlatten={onFlatten}
      />,
    );

    await expandField("counterparty");
    await expandField("contacts");
    // (element) defaults open — select phones
    fireEvent.click(await screen.findByText("phones"));
    fireEvent.click(await screen.findByTestId("fx-flatten-run"));
    fireEvent.change(await screen.findByTestId("fx-uid-select"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("fx-uid-confirm")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("fx-uid-confirm"));
    await waitFor(() =>
      expect(onFlatten).toHaveBeenCalledWith(
        "duckdb",
        "trades",
        expect.objectContaining({ steps: ["tradeId"] }),
        "counterparty",
        "counterparty.contacts",
      ),
    );
  });

  it("offers 'Flatten to tables' for a deep-opaque column that can't shred in place", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);
    const onFlatten = vi.fn().mockResolvedValue({ ok: true, created: 3 });
    const choice = {
      steps: ["id"],
      label: "id",
      map: false,
      in_list: null,
    };
    vi.mocked(api.tableRootIdOptions).mockResolvedValue({
      ok: true,
      candidates: [choice],
    } as any);
    vi.mocked(api.tableRootIdStats).mockResolvedValue({
      ok: true,
      unique: true,
      records: 10,
      distinct: 10,
      nonnull: 10,
      duplicated: 0,
      nulls: 0,
      label: "id",
    } as any);

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

    await expandField("json");
    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);

    const btn = await screen.findByTestId("fx-flatten-run");
    fireEvent.click(btn);
    expect(await screen.findByTestId("fx-flatten-uid-modal")).toBeTruthy();
    expect(onFlatten).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByTestId("fx-uid-select"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("fx-uid-confirm")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("fx-uid-confirm"));
    await waitFor(() =>
      expect(onFlatten).toHaveBeenCalledWith(
        "duckdb",
        "orders",
        expect.objectContaining({ steps: ["id"], label: "id" }),
        "json",
        "json.legs",
      ),
    );
    expect(screen.queryByTestId("fx-shred-run")).toBeNull();
  });

  it("places Flatten to tables above Sample and Peek SQL in the detail panel", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={vi.fn()}
        onFlatten={vi.fn()}
      />,
    );

    await expandField("json");
    fireEvent.click(await screen.findByText("legs"));

    const shred = await screen.findByTestId("fx-shred");
    const sample = await screen.findByTestId("fx-preview-sample");
    const peek = await screen.findByText("Peek one value");
    expect(shred.compareDocumentPosition(sample)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(shred.compareDocumentPosition(peek)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the nested field tree when Flatten fails (does not re-sample)", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);
    const onFlatten = vi
      .fn()
      .mockResolvedValue({ error: "OutOfMemoryException: 3.4 of 3.4 GiB used" });
    const onTablesChanged = vi.fn();
    vi.mocked(api.tableRootIdOptions).mockResolvedValue({
      ok: true,
      candidates: [{ steps: ["id"], label: "id", map: false }],
    } as any);
    vi.mocked(api.tableRootIdStats).mockResolvedValue({
      ok: true,
      unique: true,
      records: 10,
      distinct: 10,
      nonnull: 10,
      duplicated: 0,
      nulls: 0,
    } as any);

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={vi.fn()}
        onFlatten={onFlatten}
        onTablesChanged={onTablesChanged}
      />,
    );

    await expandField("json");
    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);
    const fieldsCallsBefore = vi.mocked(api.tableFields).mock.calls.length;

    fireEvent.click(await screen.findByTestId("fx-flatten-run"));
    fireEvent.change(await screen.findByTestId("fx-uid-select"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("fx-uid-confirm")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("fx-uid-confirm"));
    await waitFor(() => expect(onFlatten).toHaveBeenCalled());

    // Failed flatten must not refresh tables or re-fetch fields — a post-OOM
    // sample falls back to DESCRIBE-only top-level fields.
    expect(onTablesChanged).not.toHaveBeenCalled();
    expect(vi.mocked(api.tableFields).mock.calls.length).toBe(fieldsCallsBefore);
    expect(screen.getAllByText("legs").length).toBeGreaterThan(0);
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

    await expandField("json");
    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);

    const guide = await screen.findByTestId("fx-shred-guide");
    expect(guide.textContent).toContain("Flatten into relational tables");
    expect(screen.queryByTestId("fx-shred-run")).toBeNull();
  });

  it("previews validated SQL sample on field select", async () => {
    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onShred={vi.fn()}
      />,
    );
    await expandField("json");
    const legRow = await screen.findByText("legs");
    fireEvent.click(legRow);
    await waitFor(() =>
      expect(api.columnAccessPreview).toHaveBeenCalled(),
    );
    const sample = await screen.findByTestId("fx-preview-sample");
    expect(sample.textContent).toContain("preview-ok");
  });

  it("composes Id + nested field when Ctrl-selecting two fields", async () => {
    vi.mocked(api.shredPlan).mockResolvedValue({ tables: [] } as any);
    vi.mocked(api.tableFields).mockResolvedValue({
      fields: [
        {
          depth: 1,
          name: "Id",
          type: "number",
          kind: "scalar",
          column: "json",
          access: {
            first: "json ->> '$.Id'",
            sel: "json ->> '$.Id'",
            unnests: [],
          },
        },
        {
          depth: 2,
          name: "fixingdate",
          type: "string",
          kind: "scalar",
          column: "json",
          access: {
            first: "json -> '$.legs[0]' ->> '$.fixingdate'",
            sel: "e1 ->> '$.fixingdate'",
            unnests: [
              "UNNEST(from_json(json_extract(json, '$.legs'), '[\"JSON\"]')) AS x1(e1)",
            ],
          },
        },
      ],
    } as any);

    render(
      <FieldExplorer
        open
        onClose={vi.fn()}
        tables={nestedTable()}
        onToast={vi.fn()}
        onFlatten={vi.fn()}
      />,
    );

    const idRow = await screen.findByTestId("fx-field-Id");
    await expandField("Id");
    const nestCheck = await screen.findByTestId("fx-check-fixingdate");
    fireEvent.click(idRow);
    fireEvent.click(nestCheck);

    await waitFor(() =>
      expect(screen.getByTestId("fx-multi-hint").textContent).toMatch(
        /Combined query/i,
      ),
    );
    expect(screen.getByTestId("fx-sel-bar").textContent).toMatch(/2 selected/);
    expect(screen.getByText(/All rows \(combined fields\)/)).toBeTruthy();
    const sqlText = Array.from(document.querySelectorAll(".fx-sql"))
      .map((el) => el.textContent || "")
      .join("\n");
    expect(sqlText).toContain("AS Id");
    expect(sqlText).toContain("AS fixingdate");
    expect(sqlText).toContain("UNNEST(from_json");
  });
});

describe("FieldExplorer minimize", () => {
  beforeEach(() => {
    localStorage.removeItem(FIELD_EXPLORER_STORE_KEY);
    vi.mocked(api.tableFields).mockResolvedValue({ fields: [] } as any);
    vi.mocked(api.columnAccessPreview).mockResolvedValue({ ok: false } as any);
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
