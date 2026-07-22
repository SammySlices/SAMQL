import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NbNode } from "../../lib/nodeFlowModel";
import { reconcileSelectFields } from "../../lib/selectFields";
import type { TableInfo } from "../../lib/types";
import {
  NodeFlowInspector,
  type NodeFlowInspectorContext,
} from "./NodeFlowInspector";

const sharepointDownload = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    path: "C:/Downloads/report.xlsx",
    filename: "report.xlsx",
  })),
);
const sharepointAuthDeviceStart = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    flow_id: "flow1",
    user_code: "ABCD",
    verification_uri: "https://microsoft.com/devicelogin",
    message: "enter ABCD",
    secret_key: "sharepoint:Finance",
  })),
);
const sharepointAuthDevicePoll = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    stored: true,
    secret_key: "sharepoint:Finance",
  })),
);
const sharepointAuthInteractive = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    stored: true,
    secret_key: "sharepoint:Finance",
  })),
);

vi.mock("../../lib/api", () => ({
  api: {
    sharepointDownload,
    sharepointAuthDeviceStart,
    sharepointAuthDevicePoll,
    sharepointAuthInteractive,
    sharepointAuthCapabilities: vi.fn(async () => ({
      msal: true,
      windows_negotiate: true,
      modes: ["bearer", "device_code", "interactive", "windows"],
    })),
    mssqlDrivers: vi.fn(async () => ({
      available: true,
      drivers: ["ODBC Driver 18 for SQL Server"],
    })),
    connectionProfilesList: vi.fn(async () => ({
      profiles: [],
      secrets_available: true,
    })),
    connectionProfilesUpsert: vi.fn(async () => ({ ok: true })),
    connectionProfilesDelete: vi.fn(async () => ({ ok: true })),
    secretSet: vi.fn(async () => ({ ok: true, available: true })),
    secretDelete: vi.fn(async () => ({ ok: true })),
  },
}));

const table = (name: string): TableInfo => ({
  engine: "duckdb",
  name,
  source: "test",
  row_count: 1,
  columns: [],
});

const context = (
  sel: NbNode | null,
  overrides: Partial<NodeFlowInspectorContext> = {},
): NodeFlowInspectorContext =>
  ({
    sel,
    inspectorHost: null,
    inspectorDocked: false,
    showTables: false,
    running: false,
    tables: [],
    nodes: sel ? [sel] : [],
    edges: [],
    patch: vi.fn(),
    removeNode: vi.fn(),
    setHelpFor: vi.fn(),
    doPreview: vi.fn().mockResolvedValue(undefined),
    onToast: vi.fn(),
    staleColRefs: [],
    inspCols: {},
    inspColsProbing: false,
    ...overrides,
  }) as NodeFlowInspectorContext;

describe("NodeFlowInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharepointDownload.mockResolvedValue({
      ok: true,
      path: "C:/Downloads/report.xlsx",
      filename: "report.xlsx",
    });
  });

  it("renders the empty selection state", () => {
    render(<NodeFlowInspector context={context(null)} />);
    expect(screen.getByText("Select a node to configure it.")).toBeInTheDocument();
  });

  it("renders and updates an input node through the extracted inspector", () => {
    const node: NbNode = {
      id: "input-1",
      type: "input",
      x: 0,
      y: 0,
      config: { table: "", label: "input" },
    };
    const patch = vi.fn();
    const doPreview = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeFlowInspector
        context={context(node, {
          tables: [table("orders")],
          patch,
          doPreview,
        })}
      />,
    );

    expect(screen.getByText("Input node")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "orders" },
    });
    expect(patch).toHaveBeenCalledWith("input-1", {
      table: "orders",
      label: "orders",
    });

    fireEvent.click(screen.getByRole("button", { name: /preview output/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "out", "input · output");
  });

  it("imports comma-separated pasted data in a Create Table node", () => {
    const node: NbNode = {
      id: "create-1",
      type: "createtable",
      x: 0,
      y: 0,
      config: {
        label: "new_table",
        columns: ["col1", "col2"],
        rows: [["", ""]],
        dest: "duckdb",
      },
    };
    const patch = vi.fn();
    const onToast = vi.fn();
    const { container } = render(
      <NodeFlowInspector context={context(node, { patch, onToast })} />,
    );
    const pasteArea = container.querySelector("textarea.nb2-ct-paste");
    expect(pasteArea).not.toBeNull();
    fireEvent.paste(pasteArea as HTMLTextAreaElement, {
      clipboardData: {
        getData: () => 'id,name\n1,"Smith, Alice"\n2,Bob',
      },
    });

    expect(patch).toHaveBeenCalledWith("create-1", {
      columns: ["id", "name"],
      rows: [
        ["1", "Smith, Alice"],
        ["2", "Bob"],
      ],
    });
    expect(onToast).toHaveBeenCalledWith(
      "ok",
      "Pasted",
      expect.stringMatching(/2 columns.*2 rows/),
    );
  });

  it("opens SQL IDE on select and Preview uses out", async () => {
    const orders: NbNode = {
      id: "in-orders",
      type: "input",
      x: 0,
      y: 0,
      config: { table: "orders", label: "orders" },
    };
    const customers: NbNode = {
      id: "in-customers",
      type: "input",
      x: 0,
      y: 0,
      config: { table: "customers", label: "customers" },
    };
    const node: NbNode = {
      id: "sj-1",
      type: "sql",
      x: 0,
      y: 0,
      config: {
        label: "sql",
        sql: "SELECT *\nFROM orders\nLEFT JOIN customers ON orders.id = customers.id",
      },
    };
    const doPreview = vi.fn().mockResolvedValue(undefined);
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          nodes: [orders, customers, node],
          edges: [
            {
              id: "e1",
              from: { node: "in-orders", port: "out" },
              to: { node: "sj-1", port: "in1" },
            },
            {
              id: "e2",
              from: { node: "in-customers", port: "out" },
              to: { node: "sj-1", port: "in2" },
            },
          ],
          inspCols: {
            in1: ["id", "customer_id"],
            in2: ["id", "name"],
          },
          doPreview,
          patch,
        })}
      />,
    );

    expect(screen.getByText("SQL node")).toBeInTheDocument();
    expect(await screen.findByTestId("sql-ide-window")).toBeInTheDocument();
    expect(screen.getByTestId("sql-wired-list").textContent).toMatch(
      /orders/,
    );
    expect(screen.getByTestId("sql-wired-list").textContent).toMatch(
      /customers/,
    );

    fireEvent.click(screen.getByRole("button", { name: /preview output/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "out", "sql · output");

    fireEvent.click(screen.getByTitle("Close editor"));
    await waitFor(() => {
      expect(screen.queryByTestId("sql-ide-window")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("sql-open-ide"));
    expect(await screen.findByTestId("sql-ide-window")).toBeInTheDocument();
  });

  it("renders shred Preview output wired to doPreview port out", () => {
    const node: NbNode = {
      id: "shred-1",
      type: "shred",
      x: 0,
      y: 0,
      config: { table: "nested", label: "shred nested", base: "built" },
    };
    const doPreview = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeFlowInspector
        context={context(node, {
          tables: [table("nested"), table("built")],
          doPreview,
        })}
      />,
    );
    expect(screen.getByText("Shred node")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /preview output/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "out", "shred nested · output");
  });

  it("renders Join Preview left/right and only L / only R wired to doPreview", () => {
    const node: NbNode = {
      id: "join-1",
      type: "join",
      x: 0,
      y: 0,
      config: {
        label: "join",
        keys: [{ left: "id", right: "id" }],
      },
    };
    const doPreview = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeFlowInspector
        context={context(node, {
          doPreview,
          inspCols: { left: ["id"], right: ["id"] },
        })}
      />,
    );
    expect(screen.getByText("Join node")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /preview left/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "left", "join · left");
    fireEvent.click(screen.getByRole("button", { name: /preview right/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "right", "join · right");
    fireEvent.click(screen.getByRole("button", { name: /^only L$/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "left_only", "join · only L");
    fireEvent.click(screen.getByRole("button", { name: /^only R$/i }));
    expect(doPreview).toHaveBeenCalledWith(node, "right_only", "join · only R");
  });

  it("renders SharePoint drive mode and downloads via api.sharepointDownload", async () => {
    const onToast = vi.fn();
    const node: NbNode = {
      id: "sp-1",
      type: "sharepoint",
      x: 0,
      y: 0,
      config: {
        mode: "drive",
        site_url: "https://contoso.sharepoint.com/sites/Finance",
        item_id: "abc",
        secret_key: "sharepoint:Finance",
        label: "sharepoint",
      },
    };
    render(
      <NodeFlowInspector context={context(node, { onToast })} />,
    );
    expect(screen.getByRole("option", { name: /browse folders/i })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sharepoint-download"));
    await waitFor(() => expect(sharepointDownload).toHaveBeenCalled());
    const callArg = (sharepointDownload.mock.calls as unknown as unknown[][])[0]?.[0] as
      | { config?: { item_id?: string } }
      | undefined;
    expect(callArg).toMatchObject({
      config: expect.objectContaining({ item_id: "abc" }),
    });
    expect(onToast).toHaveBeenCalledWith(
      "ok",
      "Downloaded",
      expect.stringContaining("report.xlsx"),
    );
  });

  it("warns when SharePoint download has no file id or URL", async () => {
    const onToast = vi.fn();
    const node: NbNode = {
      id: "sp-2",
      type: "sharepoint",
      x: 0,
      y: 0,
      config: {
        mode: "drive",
        site_url: "https://contoso.sharepoint.com/sites/Finance",
        label: "sharepoint",
      },
    };
    render(
      <NodeFlowInspector context={context(node, { onToast })} />,
    );
    fireEvent.click(screen.getByTestId("sharepoint-download"));
    expect(sharepointDownload).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(
      "warn",
      "Pick a file",
      expect.any(String),
    );
  });

  it("starts SharePoint device-code sign-in from the auth controls", async () => {
    const onToast = vi.fn();
    const patch = vi.fn();
    const node: NbNode = {
      id: "sp-auth",
      type: "sharepoint",
      x: 0,
      y: 0,
      config: {
        mode: "list",
        site_url: "https://contoso.sharepoint.com/sites/Finance",
        list_title: "Invoices",
        auth_mode: "device_code",
        secret_key: "sharepoint:Finance",
        label: "sharepoint",
      },
    };
    render(
      <NodeFlowInspector context={context(node, { onToast, patch })} />,
    );
    expect(screen.getByTestId("sharepoint-auth-mode")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sharepoint-device-start"));
    await waitFor(() => expect(sharepointAuthDeviceStart).toHaveBeenCalled());
    expect(onToast).toHaveBeenCalledWith(
      "ok",
      "Enter this code",
      expect.stringContaining("ABCD"),
    );
  });

  it("renders SQL Server connect form parity controls", async () => {
    const doFetchApi = vi.fn().mockResolvedValue({ ok: true });
    const node: NbNode = {
      id: "sql-1",
      type: "sqlserver",
      x: 0,
      y: 0,
      config: {
        auth: "sql",
        server: "db1",
        user: "sa",
        save_password: true,
        query: "SELECT 1",
        label: "sql server",
      },
    };
    render(
      <NodeFlowInspector context={context(node, { doFetchApi })} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sqlserver-node-connect-form")).toBeTruthy(),
    );
    expect(screen.getByTestId("sqlserver-node-server")).toBeTruthy();
    expect(screen.getByTestId("sqlserver-node-auth")).toBeTruthy();
    expect(screen.getByTestId("sqlserver-node-save-password")).toBeTruthy();
    expect(screen.getByTestId("sqlserver-node-query")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sqlserver-node-fetch"));
    expect(doFetchApi).toHaveBeenCalled();
  });

  it("shows missing column warning banner when refs remain", () => {
    const node: NbNode = {
      id: "sort-1",
      type: "sort",
      x: 0,
      y: 0,
      config: { sorts: [{ col: "old_name", dir: "asc" }], label: "sort" },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          staleColRefs: [{ area: "sort", columns: ["old_name"] }],
        })}
      />,
    );
    expect(screen.getByTestId("stale-col-refs-warn")).toBeInTheDocument();
    expect(screen.getByText(/Missing column references/i)).toBeInTheDocument();
    expect(screen.getByTestId("stale-col-refs-warn")).toHaveTextContent(
      /successful workflow rerun/i,
    );
    expect(screen.getByTestId("stale-col-refs-warn")).toHaveTextContent("old_name");
    expect(patch).not.toHaveBeenCalled();
  });

  it("Clear missing patches only the selected sort node (local-only)", () => {
    const node: NbNode = {
      id: "sort-1",
      type: "sort",
      x: 0,
      y: 0,
      config: {
        sorts: [
          { col: "keep_me", dir: "asc" },
          { col: "old_name", dir: "desc" },
        ],
        label: "sort",
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          staleColRefs: [{ area: "sort", columns: ["old_name"] }],
          inspCols: { in: ["keep_me", "a"] },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("clear-missing-fields"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "sort-1",
      expect.objectContaining({
        sorts: [{ col: "keep_me", dir: "asc" }],
      }),
    );
  });

  it("Clear missing on Select drops missing fields only (local-only)", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select",
        fields: [
          { name: "a", keep: true },
          { name: "gone", keep: true },
          { name: "b", keep: true, rename: "bee" },
        ],
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          inspCols: { in: ["a", "b"] },
        })}
      />,
    );
    expect(screen.getByTestId("clear-missing-fields")).toBeInTheDocument();
    const goneRow = document.querySelector(".nb2-field[data-missing='1']");
    expect(goneRow).toBeTruthy();
    expect(goneRow).toHaveClass("missing");
    fireEvent.click(screen.getByTestId("clear-missing-fields"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("sel-1", {
      fields: [
        { name: "a", keep: true },
        { name: "b", keep: true, rename: "bee" },
      ],
    });
  });

  it("Select rename commits on blur only — intermediate A→Hi→Hi My→Hi My Name do not patch", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select",
        fields: [{ name: "A", keep: true }],
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          nodes: [node],
          inspCols: { in: ["A"] },
        })}
      />,
    );
    const input = screen.getByTestId("select-field-rename-A");
    fireEvent.focus(input);
    for (const value of ["Hi", "Hi My", "Hi My Name"]) {
      fireEvent.change(input, { target: { value } });
      expect(patch).not.toHaveBeenCalled();
    }
    fireEvent.blur(input);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("sel-1", {
      fields: [{ name: "A", keep: true, rename: "Hi My Name" }],
    });
  });

  it("Select rename Escape discards the draft without patching", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select",
        fields: [{ name: "A", keep: true, rename: "kept" }],
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          nodes: [node],
          inspCols: { in: ["A"] },
        })}
      />,
    );
    const input = screen.getByTestId("select-field-rename-A");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(patch).not.toHaveBeenCalled();
  });

  it("Select rename sticks on the draft node when selection changes before blur", () => {
    // Canvas selects on pointerdown, often before the rename input blurs.
    // The draft must commit to sel-1 (not the newly selected sel-2).
    const sel1: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select-1",
        fields: [{ name: "A", keep: true }],
      },
    };
    const sel2: NbNode = {
      id: "sel-2",
      type: "select",
      x: 120,
      y: 0,
      config: {
        label: "select-2",
        fields: [{ name: "A", keep: true }],
      },
    };
    const patch = vi.fn();
    const { rerender } = render(
      <NodeFlowInspector
        context={context(sel1, {
          patch,
          nodes: [sel1, sel2],
          inspCols: { in: ["A"] },
        })}
      />,
    );
    const input = screen.getByTestId("select-field-rename-A");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Hi My Name" } });
    expect(patch).not.toHaveBeenCalled();
    // Selection change without blur (pointerdown path).
    rerender(
      <NodeFlowInspector
        context={context(sel2, {
          patch,
          nodes: [sel1, sel2],
          inspCols: { in: ["A"] },
        })}
      />,
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("sel-1", {
      fields: [{ name: "A", keep: true, rename: "Hi My Name" }],
    });
  });

  it("Select rename blur commits final name that downstream reconcile can see", () => {
    const sel1: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select-1",
        fields: [{ name: "A", keep: true }],
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(sel1, {
          patch,
          nodes: [sel1],
          inspCols: { in: ["A"] },
        })}
      />,
    );
    const input = screen.getByTestId("select-field-rename-A");
    fireEvent.focus(input);
    for (const value of ["Hi", "Hi My", "Hi My Name"]) {
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.blur(input);
    const committed = patch.mock.calls[0][1].fields as {
      name: string;
      rename?: string;
    }[];
    expect(committed).toEqual([
      { name: "A", keep: true, rename: "Hi My Name" },
    ]);
    // Downstream Select sees only the final output name (no Hi / Hi My).
    const down = reconcileSelectFields(
      ["Hi My Name", "amount"],
      [
        { name: "A", keep: true },
        { name: "amount", keep: true },
      ],
    );
    expect(down.map((f: { name: string }) => f.name)).toEqual([
      "A",
      "amount",
      "Hi My Name",
    ]);
    expect(down.map((f: { name: string }) => f.name)).not.toContain("Hi");
    expect(down.map((f: { name: string }) => f.name)).not.toContain("Hi My");
  });

  it("Clear blanks filter field + condition for dropped / spaced headers", () => {
    const node: NbNode = {
      id: "filt-1",
      type: "filter",
      x: 0,
      y: 0,
      config: {
        filterMode: "simple",
        field: "Order Date",
        condition: "[Order Date] > 5",
        label: "filter",
      },
    };
    const patch = vi.fn();
    render(
      <NodeFlowInspector
        context={context(node, {
          patch,
          staleColRefs: [
            { area: "condition", columns: ["Order Date"] },
            { area: "field", columns: ["Order Date"] },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("clear-missing-fields"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "filt-1",
      expect.objectContaining({
        condition: "",
        field: "",
      }),
    );
  });

  it("shows Loading fields while column probe is in flight, not Connect an input", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: { fields: [], label: "select" },
    };
    render(
      <NodeFlowInspector
        context={context(node, { inspCols: {}, inspColsProbing: true })}
      />,
    );
    expect(screen.getByTestId("insp-cols-loading")).toHaveTextContent(
      /Loading fields/i,
    );
    expect(screen.queryByText(/Connect an input/i)).toBeNull();
  });

  it("shows Connect an input only when probe finished empty", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: { fields: [], label: "select" },
    };
    render(
      <NodeFlowInspector
        context={context(node, { inspCols: {}, inspColsProbing: false })}
      />,
    );
    expect(screen.queryByTestId("insp-cols-loading")).toBeNull();
    expect(screen.getByText(/Connect an input to choose fields and types/i)).toBeTruthy();
  });

  it("keeps the same config body DOM across selection changes (no swap remount)", () => {
    const sumNode: NbNode = {
      id: "sum-1",
      type: "summarize",
      x: 0,
      y: 0,
      config: {
        label: "summarize",
        group_by: ["region"],
        aggs: [{ col: "amount", func: "sum" }],
      },
    };
    const sortNode: NbNode = {
      id: "sort-1",
      type: "sort",
      x: 0,
      y: 0,
      config: { label: "sort", sorts: [{ col: "amount", dir: "asc" }] },
    };
    const { rerender } = render(
      <NodeFlowInspector
        context={context(sumNode, { inspCols: { in: ["region", "amount"] } })}
      />,
    );
    const firstBody = screen.getByTestId("insp-swap-body");
    expect(firstBody.className).toContain("nb2-insp-body");
    expect(screen.getByText("Summarize node")).toBeInTheDocument();

    rerender(
      <NodeFlowInspector
        context={context(sortNode, { inspCols: { in: ["amount"] } })}
      />,
    );
    const secondBody = screen.getByTestId("insp-swap-body");
    // Stable wrapper: content updates in place (no opacity remount fade).
    expect(secondBody).toBe(firstBody);
    expect(screen.queryByText("Summarize node")).toBeNull();
    expect(screen.getByText("Sort node")).toBeInTheDocument();
  });

  it("keeps the same config body across config edits of the same node", () => {
    const sortNode: NbNode = {
      id: "sort-1",
      type: "sort",
      x: 0,
      y: 0,
      config: { label: "sort", sorts: [{ col: "amount", dir: "asc" }] },
    };
    const { rerender } = render(
      <NodeFlowInspector
        context={context(sortNode, { inspCols: { in: ["amount"] } })}
      />,
    );
    const firstBody = screen.getByTestId("insp-swap-body");
    rerender(
      <NodeFlowInspector
        context={context(
          { ...sortNode, config: { ...sortNode.config, label: "sorted" } },
          { inspCols: { in: ["amount"] } },
        )}
      />,
    );
    // Same selection: editing config must NOT remount (no focus loss).
    expect(screen.getByTestId("insp-swap-body")).toBe(firstBody);
  });

  it("does not flash missing-field UI while columns are probing", () => {
    const node: NbNode = {
      id: "sel-1",
      type: "select",
      x: 0,
      y: 0,
      config: {
        label: "select",
        fields: [
          { name: "a", keep: true },
          { name: "b", keep: true },
        ],
      },
    };
    render(
      <NodeFlowInspector
        context={context(node, { inspCols: {}, inspColsProbing: true })}
      />,
    );
    expect(screen.queryByTestId("stale-col-refs-warn")).toBeNull();
    expect(screen.queryByText(/Missing column references/i)).toBeNull();
    const fields = screen.getAllByTitle("Keep this field");
    expect(fields.length).toBe(2);
    expect(document.querySelectorAll(".nb2-field.missing").length).toBe(0);
  });

  it("uses red xbtn on summarize and sort remove controls", () => {
    const sumNode: NbNode = {
      id: "sum-1",
      type: "summarize",
      x: 0,
      y: 0,
      config: {
        label: "summarize",
        group_by: ["region"],
        aggs: [{ col: "amount", func: "sum" }],
      },
    };
    const { container: sumRoot, unmount: unmountSum } = render(
      <NodeFlowInspector
        context={context(sumNode, { inspCols: { in: ["region", "amount"] } })}
      />,
    );
    const sumRemove = sumRoot.querySelectorAll("button.xbtn");
    expect(sumRemove.length).toBeGreaterThanOrEqual(2);
    for (const btn of Array.from(sumRemove)) {
      expect(btn.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["btn", "ghost", "icon", "xbtn"]),
      );
    }
    unmountSum();

    const sortNode: NbNode = {
      id: "sort-1",
      type: "sort",
      x: 0,
      y: 0,
      config: {
        label: "sort",
        sorts: [{ col: "amount", dir: "asc" }],
      },
    };
    const { container: sortRoot } = render(
      <NodeFlowInspector
        context={context(sortNode, { inspCols: { in: ["amount"] } })}
      />,
    );
    const sortRemove = sortRoot.querySelectorAll('button.xbtn[title="Remove"]');
    expect(sortRemove.length).toBeGreaterThanOrEqual(1);
    expect(sortRemove[0].className.split(/\s+/)).toEqual(
      expect.arrayContaining(["btn", "ghost", "icon", "xbtn"]),
    );
  });
});
