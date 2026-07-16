import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  health: vi.fn(),
  tables: vi.fn(),
  history: vi.fn(),
  saved: vi.fn(),
  workflowsList: vi.fn(),
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
}));

vi.mock("./components/ServerWatchdog", () => ({ ServerWatchdog: () => null }));
vi.mock("./components/FieldExplorer", () => ({ FieldExplorer: () => null }));
vi.mock("./components/NodeFlow", () => ({
  NodeFlow: () => <div data-testid="nodeflow-view">NodeFlow</div>,
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
  Sidebar: (props: { tables: { name: string }[]; onRefresh: () => void }) => (
    <aside>
      <output data-testid="sidebar-tables">
        {props.tables.map((table) => table.name).join(",")}
      </output>
      <button onClick={props.onRefresh}>Refresh tables</button>
    </aside>
  ),
}));
vi.mock("./components/ActivityShared", () => ({
  useActivityStatus: () => ({ status: null }),
  useEngineReset: () => ({ reset: vi.fn(), resetting: false }),
  useTasks: () => ({ activeCount: 0, opsCount: 0, stalled: false }),
  useWinDrag: () => ({
    pos: { x: 40, y: 40 },
    startDrag: vi.fn(),
    dragging: false,
    settled: false,
    winRef: { current: null },
  }),
  ActivityMonitor: () => null,
  TaskWatcher: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const health = {
  version: "2.15.90",
  build: "2026-07-11.579",
  features: { duckdb: true, pyarrow: true, openpyxl: true },
};

async function renderFreshApp() {
  const { default: App } = await import("./App");
  return render(<App />);
}

describe("App runtime behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    apiMock.health.mockReset().mockResolvedValue(health);
    apiMock.tables.mockReset().mockResolvedValue([]);
    apiMock.history.mockReset().mockResolvedValue([]);
    apiMock.saved.mockReset().mockResolvedValue([]);
    apiMock.workflowsList.mockReset().mockResolvedValue({ workflows: [] });
  });

  it("publishes data-ready only after the backend health request resolves", async () => {
    const gate = deferred<typeof health>();
    apiMock.health.mockReturnValueOnce(gate.promise);
    await renderFreshApp();
    const app = screen.getByTestId("samql-app");
    expect(app).toHaveAttribute("data-ready", "false");

    gate.resolve(health);
    await waitFor(() => expect(app).toHaveAttribute("data-ready", "true"));
  });

  it("keeps Journal mounted but hidden while the visible IDE editor owns focus", async () => {
    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute("data-ready", "true"),
    );

    const ide = screen.getByTestId("ide-sql-editor");
    const journal = screen.getByTestId("notebook-sql-editor");
    expect(ide).toBeVisible();
    expect(journal).not.toBeVisible();

    fireEvent.click(screen.getByTestId("view-journal"));
    expect(journal).toBeVisible();
    expect(screen.queryByTestId("ide-sql-editor")).not.toBeInTheDocument();
  });

  it("opens SQL assistant from Journal in copy-only mode", async () => {
    apiMock.assistantStatus = vi.fn().mockResolvedValue({
      available: false,
      pack_ok: false,
      hint: "Copy an offline assistant pack to ./assistant/",
      duckdb_busy: false,
    });
    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute("data-ready", "true"),
    );
    fireEvent.click(screen.getByTestId("view-journal"));
    fireEvent.click(screen.getByTestId("sql-assistant-journal-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("sql-assistant-panel")).toBeTruthy();
    });
    expect(
      screen.getByText(/copy it and paste into a Journal cell/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Insert into IDE" })).toBeNull();
  });

  it("recovers a stale saved active tab id to the first real editor tab", async () => {
    localStorage.setItem(
      "samql.session.v1",
      JSON.stringify({
        version: 2,
        edTabs: [
          { id: "first", title: "First", sql: "SELECT 'first'" },
          { id: "second", title: "Second", sql: "SELECT 'second'" },
        ],
        activeId: "missing",
        target: "__local__",
      }),
    );

    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("ide-sql-editor")).toHaveValue("SELECT 'first'"),
    );
    expect(screen.getByTestId("ide-engine")).toHaveValue("__local__");
  });

  it("backs up and migrates legacy session state before React persistence starts", async () => {
    const legacy = JSON.stringify({
      edTabs: [{ id: "legacy", title: "Legacy", sql: "SELECT 7" }],
      activeId: "legacy",
      target: "__local__",
    });
    localStorage.setItem("samql.session.v1", legacy);

    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("ide-sql-editor")).toHaveValue("SELECT 7"),
    );

    expect(localStorage.getItem("samql.session.v1.pre-migration-backup")).toBe(legacy);
    const migrated = JSON.parse(localStorage.getItem("samql.session.v1") || "{}");
    expect(migrated.version).toBe(2);
    expect(migrated.target).toBe("__local__");
    expect(screen.getByTestId("ide-engine")).toHaveValue("__local__");
  });

  it("backs up malformed session JSON before replacing it with clean state", async () => {
    const malformed = "{broken-json";
    localStorage.setItem("samql.session.v1", malformed);

    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute("data-ready", "true"),
    );
    await waitFor(() =>
      expect(localStorage.getItem("samql.session.v1")).not.toBe(malformed),
    );

    expect(localStorage.getItem("samql.session.v1.pre-migration-backup")).toBe(
      malformed,
    );
    expect(JSON.parse(localStorage.getItem("samql.session.v1") || "{}").version)
      .toBe(2);
  });

  it("preserves and backs up a future-version session instead of overwriting it", async () => {
    const future = JSON.stringify({
      version: 99,
      edTabs: [{ id: "future", title: "Future", sql: "SELECT 99" }],
      activeId: "future",
    });
    localStorage.setItem("samql.session.v1", future);

    await renderFreshApp();
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute("data-ready", "true"),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    });

    expect(localStorage.getItem("samql.session.v1")).toBe(future);
    expect(localStorage.getItem("samql.session.v1.pre-migration-backup")).toBe(
      future,
    );
  });

  it("debounces editor persistence and stores the latest SQL", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "samql.session.v1",
      JSON.stringify({
        version: 2,
        edTabs: [{ id: "tab", title: "Query", sql: "SELECT 1" }],
        activeId: "tab",
        target: "__local__",
      }),
    );

    await renderFreshApp();
    const editor = screen.getByTestId("ide-sql-editor");
    fireEvent.change(editor, { target: { value: "SELECT 2" } });

    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(JSON.parse(localStorage.getItem("samql.session.v1") || "{}").edTabs[0].sql)
      .toBe("SELECT 1");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(JSON.parse(localStorage.getItem("samql.session.v1") || "{}").edTabs[0].sql)
      .toBe("SELECT 2");
  });

  it("keeps the newest table refresh when responses complete out of order", async () => {
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    apiMock.tables
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    await renderFreshApp();
    fireEvent.focus(window);

    newer.resolve([{ name: "new_catalog", columns: [], engine: "sqlite" }]);
    await waitFor(() => expect(screen.getByTestId("sidebar-tables")).toHaveTextContent("new_catalog"));

    older.resolve([{ name: "stale_catalog", columns: [], engine: "sqlite" }]);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("sidebar-tables")).toHaveTextContent("new_catalog");
    expect(screen.getByTestId("sidebar-tables")).not.toHaveTextContent("stale_catalog");
  });
});
