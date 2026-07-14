import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NbNode } from "../../lib/nodeFlowModel";
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

vi.mock("../../lib/api", () => ({
  api: {
    sharepointDownload,
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
});
