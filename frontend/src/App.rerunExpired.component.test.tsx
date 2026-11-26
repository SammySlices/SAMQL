import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";


const apiMock = vi.hoisted(() => ({
  health: vi.fn(),
  tables: vi.fn(),
  history: vi.fn(),
  saved: vi.fn(),
  workflowsList: vi.fn(),
  assistantStatus: vi.fn(),
  query: vi.fn(),
  page: vi.fn(),
  discardResult: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api: new Proxy(apiMock, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return vi.fn(async () => ({}));
    },
  }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  exportResultToFile: vi.fn(),
  registerBgCancel: vi.fn(() => vi.fn()),
  saveToDownloads: vi.fn(),
  stampResultEpoch: vi.fn((_result, fallback: number) => fallback),
}));

vi.mock("./components/ServerWatchdog", () => ({ ServerWatchdog: () => null }));
vi.mock("./components/FieldExplorer", () => ({ FieldExplorer: () => null }));
vi.mock("./components/NodeFlow", () => ({
  NodeFlow: (props: {
    active?: boolean;
    showTables?: boolean;
    inspectorOverTables?: boolean;
  }) => (
    <div
      data-testid="nodeflow-view"
      data-active={props.active === false ? "0" : "1"}
      data-show-tables={props.showTables ? "1" : "0"}
      data-inspector-over-tables={props.inspectorOverTables ? "1" : "0"}
    >
      NodeFlow
    </div>
  ),
}));
vi.mock("./components/Dashboard", () => ({
  Dashboard: (props: { active?: boolean }) => (
    <div
      data-testid="dashboard-view"
      data-active={props.active === false ? "0" : "1"}
    >
      Dashboard
    </div>
  ),
}));
vi.mock("./components/Notebook", () => ({
  Notebook: (props: {
    assistantOpen?: boolean;
    onAssistantToggle?: () => void;
  }) => (
    <>
      <textarea data-testid="notebook-sql-editor" aria-label="Journal editor" />
      {props.onAssistantToggle && (
        <button
          type="button"
          data-testid="sql-assistant-journal-fab"
          aria-pressed={!!props.assistantOpen}
          onClick={props.onAssistantToggle}
        >
          SQL assistant
        </button>
      )}
    </>
  ),
}));
vi.mock("./components/Sidebar", () => ({
  Sidebar: (props: {
    tables: { name: string }[];
    onRefresh: () => void;
    tablesPinned?: boolean;
    onToggleTablesPin?: () => void;
  }) => (
    <aside>
      <output data-testid="sidebar-tables">
        {props.tables.map((table) => table.name).join(",")}
      </output>
      <button onClick={props.onRefresh}>Refresh tables</button>
      <button
        data-testid="mock-tables-pin"
        aria-pressed={!!props.tablesPinned}
        onClick={props.onToggleTablesPin}
      >
        Pin tables
      </button>
    </aside>
  ),
}));
vi.mock("./components/ActivityShared", () => ({
  useActivityStatus: () => ({ status: null }),
  useEngineReset: () => ({ reset: vi.fn(), resetting: false }),
  useTasks: () => ({ activeCount: 0, opsCount: 0, stalled: false }),
  useWinDrag: () => ({
    pos: { x: 40, y: 40 },
    setPos: vi.fn(),
    startDrag: vi.fn(),
    dragging: false,
    settled: false,
    winRef: { current: null },
  }),
  ActivityMonitor: () => null,
  TaskWatcher: () => null,
}));

const health = {
  version: "2.15.90",
  build: "2026-07-11.579",
  features: { duckdb: true, pyarrow: true, openpyxl: true },
};

async function renderFreshApp() {
  const { default: App } = await import("./App");
  return render(<App />);
}

const SCRIPT = "INSERT INTO audit VALUES (1);\nSELECT * FROM audit";

function seedSession() {
  localStorage.setItem(
    "samql.session.v1",
    JSON.stringify({
      version: 2,
      edTabs: [{ id: "tab", title: "Query", sql: SCRIPT }],
      activeId: "tab",
      // The IDE's CURRENT target differs from where the result ran, so the
      // test also proves the re-run uses the tab's own target.
      target: "__duckdb__",
    }),
  );
}

async function runScriptOnce(firstResult: Record<string, unknown>) {
  seedSession();
  apiMock.query.mockResolvedValueOnce(firstResult);
  await renderFreshApp();
  await waitFor(() =>
    expect(screen.getByTestId("samql-app")).toHaveAttribute("data-ready", "true"),
  );
  fireEvent.click(screen.getByTestId("run-query"));
  await waitFor(() => expect(apiMock.query).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getAllByTestId("grid-col-header").length).toBeGreaterThan(0),
  );
  expect(apiMock.query.mock.calls[0][0]).toBe(SCRIPT);
}

describe("Q-C1: an expired result tab never re-runs its script", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    apiMock.health.mockReset().mockResolvedValue(health);
    apiMock.tables.mockReset().mockResolvedValue({ tables: [], data_epoch: 0 });
    apiMock.history.mockReset().mockResolvedValue([]);
    apiMock.saved.mockReset().mockResolvedValue([]);
    apiMock.workflowsList.mockReset().mockResolvedValue({ workflows: [] });
    apiMock.discardResult.mockReset().mockResolvedValue({ ok: true });
    apiMock.query.mockReset();
    apiMock.page.mockReset();
  });

  it("re-runs only the producing SELECT, read-only, on the tab's own target", async () => {
    await runScriptOnce({
      result_id: "r1",
      columns: ["v"],
      rows: [[1]],
      total_rows: 1,
      stmt_kind: "write",
      sql: "SELECT * FROM audit",
      target: "__local__",
      engine: "sqlite",
      statements: [
        { index: 0, sql_preview: "INSERT INTO audit VALUES (1)", total_rows: 1 },
        { index: 1, sql_preview: "SELECT * FROM audit", result_id: "r1", total_rows: 1 },
      ],
    });
    // The sort finds the result expired (another tab's write bumped the epoch).
    apiMock.page
      .mockResolvedValueOnce({ error: "result expired", columns: [], rows: [], total_rows: 0 })
      .mockResolvedValue({
        columns: ["v"], rows: [[1]], total_rows: 1, offset: 0,
        sql: "SELECT * FROM audit", target: "__local__",
      });
    apiMock.query.mockResolvedValueOnce({
      result_id: "r2",
      columns: ["v"],
      rows: [[1]],
      total_rows: 1,
      stmt_kind: "read",
      sql: "SELECT * FROM audit",
      target: "__local__",
    });

    fireEvent.click(screen.getAllByTestId("grid-col-header")[0]);

    await waitFor(() => expect(apiMock.query).toHaveBeenCalledTimes(2));
    const [sql, target, readOnly, , , dialect, , opts] =
      apiMock.query.mock.calls[1];
    expect(sql).toBe("SELECT * FROM audit");
    expect(sql).not.toMatch(/insert/i);
    expect(target).toBe("__local__");
    expect(readOnly).toBe(true);
    expect(dialect).toBeUndefined();
    expect(opts?.per_statement).toBeFalsy();
    await waitFor(() => expect(apiMock.page).toHaveBeenCalledTimes(2));
    expect(apiMock.page.mock.calls[1][0]).toBe("r2");
  });

  it("never auto-re-runs a grid that a write produced; marks it stale", async () => {
    await runScriptOnce({
      result_id: "r1",
      columns: ["v"],
      rows: [[1]],
      total_rows: 1,
      stmt_kind: "write",
      sql: "INSERT INTO audit VALUES (1) RETURNING *",
      target: "__duckdb__",
      engine: "duckdb",
    });
    apiMock.page.mockResolvedValue({
      error: "result expired", columns: [], rows: [], total_rows: 0,
    });

    fireEvent.click(screen.getAllByTestId("grid-col-header")[0]);

    await waitFor(() =>
      expect(screen.getByTestId("result-data-stale-chip")).toBeTruthy(),
    );
    expect(apiMock.query).toHaveBeenCalledTimes(1);
  });
});
