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

  it("shows residual stale column warning banner when refs remain (F2)", () => {
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
    expect(screen.getByText(/Stale column references/i)).toBeInTheDocument();
    expect(screen.getByTestId("stale-col-refs-warn")).toHaveTextContent(
      /after auto-prune/i,
    );
    expect(screen.getByTestId("stale-col-refs-warn")).toHaveTextContent("old_name");
    expect(patch).not.toHaveBeenCalled();
  });

  it("Clear stale references patches only the stale entries (user-initiated)", () => {
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
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("stale-col-refs-clear"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "sort-1",
      expect.objectContaining({
        sorts: [{ col: "keep_me", dir: "asc" }],
      }),
    );
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
    fireEvent.click(screen.getByTestId("stale-col-refs-clear"));
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

  it("remounts the keyed config body when the selected node changes (swap fade)", () => {
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
    expect(firstBody.className).toContain("nb2-insp-swap");
    expect(screen.getByText("Summarize node")).toBeInTheDocument();

    rerender(
      <NodeFlowInspector
        context={context(sortNode, { inspCols: { in: ["amount"] } })}
      />,
    );
    const secondBody = screen.getByTestId("insp-swap-body");
    // Keyed by node id+type: a different selection must be a fresh DOM subtree
    // (the swap-in fade plays on mount), never the old form updated in place.
    expect(secondBody).not.toBe(firstBody);
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
    // Same id+type: editing config must NOT remount (no focus loss, no re-fade).
    expect(screen.getByTestId("insp-swap-body")).toBe(firstBody);
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
