import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMock = vi.hoisted(() => ({
  health: vi.fn(async () => ({
    ok: true,
    version: "2.16.4",
    build: "test",
    features: { duckdb: true },
  })),
  tables: vi.fn(async () => ({ tables: [], data_epoch: 0 })),
  history: vi.fn(async () => ({ history: [] })),
  saved: vi.fn(async () => ({ saved: [] })),
  workflowsList: vi.fn(async () => ({ workflows: [] })),
  memory: vi.fn(async () => ({})),
  status: vi.fn(async () => ({})),
  tasks: vi.fn(async () => ({ tasks: [] })),
}));

vi.mock("./api", () => ({
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

vi.mock("../components/ServerWatchdog", () => ({
  ServerWatchdog: () => null,
}));
vi.mock("../components/FieldExplorer", () => ({
  FieldExplorer: () => null,
}));
vi.mock("../components/NodeFlow", () => ({
  NodeFlow: ({ snap }: { snap?: boolean }) => (
    <div data-testid="nodeflow-view" data-snap={snap ? "1" : "0"}>
      NodeFlow
    </div>
  ),
}));
vi.mock("../components/Notebook", () => ({
  Notebook: () => (
    <textarea data-testid="notebook-sql-editor" aria-label="Journal editor" />
  ),
}));
vi.mock("../components/Sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar-stub" />,
}));
vi.mock("../components/ActivityShared", () => ({
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

import App from "../App";

describe("Node Snap visual setting", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.health.mockClear();
    apiMock.tables.mockClear();
  });

  it("defaults Node Snap OFF and persists the preference", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const toggle = screen.getByTestId("node-snap-toggle");
    expect(toggle).toHaveTextContent("Node Snap");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("samql.nodeSnap")).toBe("0");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(toggle).toHaveTextContent("Node Snap: on");
      expect(localStorage.getItem("samql.nodeSnap")).toBe("1");
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(localStorage.getItem("samql.nodeSnap")).toBe("0");
    });
  });

  it("restores Node Snap on from localStorage on boot", async () => {
    localStorage.setItem("samql.nodeSnap", "1");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    expect(screen.getByTestId("node-snap-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
