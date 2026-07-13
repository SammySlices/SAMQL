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
  ActivityMonitor: () => null,
  TaskWatcher: () => null,
}));

import App from "../App";

describe("Eye Care view setting", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("eye-care");
    document.documentElement.removeAttribute("data-eye-care");
    apiMock.health.mockClear();
    apiMock.tables.mockClear();
  });

  it("toggles html.eye-care and persists the preference", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    const toggle = screen.getByTestId("eye-care-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.classList.contains("eye-care")).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.classList.contains("eye-care")).toBe(true);
      expect(document.documentElement.getAttribute("data-eye-care")).toBe("on");
      expect(localStorage.getItem("samql.eyeCare")).toBe("1");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.classList.contains("eye-care")).toBe(
        false,
      );
      expect(document.documentElement.getAttribute("data-eye-care")).toBe(
        "off",
      );
      expect(localStorage.getItem("samql.eyeCare")).toBe("0");
    });
  });

  it("restores Eye Care from localStorage on boot", async () => {
    localStorage.setItem("samql.eyeCare", "1");
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("eye-care")).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    expect(screen.getByTestId("eye-care-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
