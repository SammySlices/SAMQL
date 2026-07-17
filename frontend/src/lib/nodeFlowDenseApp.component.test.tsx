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
  tables: vi.fn(async () => []),
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
  NodeFlow: () => <div data-testid="nodeflow-view">NodeFlow</div>,
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
import { setNodeFlowDenseMode } from "./nodeFlowModel";

describe("Dense NodeFlow view setting", () => {
  beforeEach(() => {
    localStorage.clear();
    setNodeFlowDenseMode(false);
    document.documentElement.classList.remove("nb-dense");
    document.documentElement.removeAttribute("data-nb-dense");
    apiMock.health.mockClear();
    apiMock.tables.mockClear();
  });

  it("toggles html.nb-dense and persists the preference", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const toggle = screen.getByTestId("nodeflow-dense-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.classList.contains("nb-dense")).toBe(
      false,
    );

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.classList.contains("nb-dense")).toBe(
        true,
      );
      expect(document.documentElement.getAttribute("data-nb-dense")).toBe(
        "on",
      );
      expect(localStorage.getItem("samql.nodeFlowDense")).toBe("1");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.classList.contains("nb-dense")).toBe(
        false,
      );
      expect(document.documentElement.getAttribute("data-nb-dense")).toBe(
        "off",
      );
      expect(localStorage.getItem("samql.nodeFlowDense")).toBe("0");
    });
  });

  it("restores Dense NodeFlow from localStorage on boot", async () => {
    localStorage.setItem("samql.nodeFlowDense", "1");
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("nb-dense")).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    expect(screen.getByTestId("nodeflow-dense-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
