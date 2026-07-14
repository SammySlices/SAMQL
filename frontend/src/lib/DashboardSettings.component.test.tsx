import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardSettings } from "../components/DashboardSettings";
import {
  DASHBOARD_WORKSPACE_KEY,
  emptyDashboardDoc,
  emptyDashboardWorkspace,
  saveDashboardWorkspace,
} from "./dashboardModel";

const apiMock = vi.hoisted(() => ({
  workflowSave: vi.fn(async () => ({})),
  workflowLoad: vi.fn(async (..._args: unknown[]) => ({
    graph: { nodes: [] as unknown[], edges: [] as unknown[] },
  })),
}));

vi.mock("./api", () => ({
  api: apiMock,
  saveToDownloads: vi.fn(async () => ({
    path: "C:/Downloads/board.samql-dashboard.json",
    filename: "board.samql-dashboard.json",
  })),
}));

function Harness({
  onToast,
  onLoaded,
}: {
  onToast: (
    kind: "ok" | "error" | "warn",
    title: string,
    msg?: string,
  ) => void;
  onLoaded?: () => void;
}) {
  const ui = useDashboardSettings(onToast, onLoaded);
  return (
    <div>
      <div data-testid="menu">{ui.menu(() => undefined)}</div>
      {ui.modals}
    </div>
  );
}

afterEach(() => {
  cleanup();
  try {
    window.localStorage?.removeItem(DASHBOARD_WORKSPACE_KEY);
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  const ws = emptyDashboardWorkspace();
  ws.savedName = "Board Pack";
  ws.dashboards[0].widgets[0].workflowName = "WF1";
  saveDashboardWorkspace(ws);
  apiMock.workflowLoad.mockResolvedValue({
    graph: {
      nodes: [
        { id: "u", type: "browse", config: {} },
        { id: "d", type: "samqldash", config: {} },
      ],
      edges: [
        { from: { node: "u", port: "out" }, to: { node: "d", port: "in" } },
      ],
    },
  });
  apiMock.workflowSave.mockResolvedValue({});
});

describe("useDashboardSettings", () => {
  it("exports the workspace bundle to Downloads", async () => {
    const toast = vi.fn();
    render(<Harness onToast={toast} />);
    fireEvent.click(screen.getByText(/export dashboard/i));
    fireEvent.click(screen.getByRole("button", { name: /export to downloads/i }));
    await waitFor(async () => {
      const { saveToDownloads } = await import("./api");
      expect(saveToDownloads).toHaveBeenCalledWith(
        expect.stringMatching(/\.samql-dashboard\.json$/),
        expect.objectContaining({ text: expect.stringContaining("dashboard-bundle") }),
      );
    });
    expect(toast).toHaveBeenCalledWith("ok", "Exported", expect.any(String));
  });

  it("loads a bundle file and invokes onLoaded", async () => {
    const toast = vi.fn();
    const onLoaded = vi.fn();
    render(<Harness onToast={toast} onLoaded={onLoaded} />);
    fireEvent.click(screen.getByText(/load dashboard/i));
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    const ws = emptyDashboardWorkspace();
    ws.dashboards[0].id = "from-file";
    ws.activeId = "from-file";
    const file = new File(
      [
        JSON.stringify({
          samql: "dashboard-bundle",
          workspace: ws,
          workflows: [{ name: "WF1", kind: "node", graph: { nodes: [] } }],
        }),
      ],
      "pack.samql-dashboard.json",
      { type: "application/json" },
    );
    await waitFor(() => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    expect(apiMock.workflowSave).toHaveBeenCalledWith(
      "WF1",
      expect.anything(),
      "node",
    );
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Dashboard loaded",
      "pack.samql-dashboard.json",
    );
  });

  it("opens Dashboard Manager and reorders / renames / deletes boards", async () => {
    const toast = vi.fn();
    const onLoaded = vi.fn();
    const ws = emptyDashboardWorkspace();
    ws.dashboards = [
      { ...emptyDashboardDoc("First"), id: "board-a" },
      { ...emptyDashboardDoc("Second"), id: "board-b" },
    ];
    ws.activeId = "board-a";
    saveDashboardWorkspace(ws);

    render(<Harness onToast={toast} onLoaded={onLoaded} />);
    fireEvent.click(screen.getByTestId("settings-dashboard-manager"));
    expect(screen.getByTestId("dashboard-manager")).toBeTruthy();

    fireEvent.click(screen.getByTestId("dashboard-manager-down-board-a"));
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    const afterMove = JSON.parse(
      window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY) || "{}",
    );
    expect(afterMove.dashboards.map((d: { name: string }) => d.name)).toEqual([
      "Second",
      "First",
    ]);

    const nameInput = screen.getByTestId(
      "dashboard-manager-name-board-a",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.blur(nameInput);
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY) || "{}",
      );
      expect(
        stored.dashboards.find((d: { id: string }) => d.id === "board-a")
          ?.name,
      ).toBe("Renamed");
    });

    fireEvent.click(screen.getByTestId("dashboard-manager-delete-board-a"));
    await waitFor(() => {
      expect(document.querySelector(".nb2-delconfirm")).toBeTruthy();
    });
    fireEvent.click(
      document.querySelector(".nb2-delconfirm .btn.danger") as HTMLButtonElement,
    );
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY) || "{}",
      );
      expect(stored.dashboards.map((d: { id: string }) => d.id)).toEqual([
        "board-b",
      ]);
    });
  });
});
