import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  FieldExplorer: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="field-explorer-panel">JSON Field Explorer</div> : null,
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

describe("Settings View consolidations", () => {
  beforeEach(() => {
    localStorage.clear();
    setNodeFlowDenseMode(false);
    document.documentElement.classList.remove("eye-care", "nb-dense");
    document.documentElement.removeAttribute("data-eye-care");
    document.documentElement.removeAttribute("data-nb-dense");
    document.body.classList.remove("motion-reduced");
    apiMock.health.mockClear();
    apiMock.tables.mockClear();
  });

  it("nests former toolbar toggles under Toolbar Toggle", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    expect(screen.getByTestId("settings-toolbar-toggle")).toBeTruthy();
    expect(screen.queryByTestId("settings-toolbar-tables-panel")).toBeNull();
    // Tools & Tables opens via Ctrl/Cmd+K command palette, not Settings.
    expect(screen.queryByText("Tools & Tables…")).toBeNull();
    // JSON Field Explorer stays under Settings → Tools (and Tools & Tables).
    expect(
      within(document.querySelector(".settings-menu") as HTMLElement).getByRole(
        "button",
        { name: "JSON Field Explorer" },
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-json-field-explorer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-toolbar-toggle"));
    const tables = screen.getByTestId("settings-toolbar-tables-panel");
    const search = screen.getByTestId("settings-toolbar-node-search");
    const nodeTb = screen.getByTestId("settings-toolbar-node-toolbar");
    expect(tables).toHaveAttribute("aria-checked", "true");
    expect(search).toHaveAttribute("aria-checked", "true");
    expect(nodeTb).toHaveAttribute("aria-checked", "true");

    fireEvent.click(tables);
    await waitFor(() =>
      expect(tables).toHaveAttribute("aria-checked", "false"),
    );

    fireEvent.click(nodeTb);
    await waitFor(() => {
      expect(nodeTb).toHaveAttribute("aria-checked", "false");
      expect(localStorage.getItem("samql.nb2.paletteHidden")).toBe("1");
    });
  });

  it("opens JSON Field Explorer from Settings → Tools", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    const menu = document.querySelector(".settings-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    // Still no general Tools & Tables entry in Settings.
    expect(within(menu).queryByText("Tools & Tables…")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-json-field-explorer"));
    await waitFor(() => {
      expect(document.querySelector(".settings-menu")).toBeNull();
      expect(screen.getByTestId("field-explorer-panel")).toBeTruthy();
    });
  });

  it("exposes Open / Save section with Open, Save, then Save As", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    const menu = document.querySelector(".settings-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(within(menu).getByText(/^Open \/ Save$/)).toBeTruthy();
    const open = within(menu).getByTestId("settings-open");
    const save = within(menu).getByTestId("settings-save");
    const saveAs = within(menu).getByTestId("settings-save-as");
    expect(open).toHaveTextContent(/^Open$/);
    expect(save).toHaveTextContent(/^Save$/);
    expect(saveAs).toHaveTextContent(/^Save As$/);
    // DOM order: Open, then Save, then Save As underneath Save.
    expect(
      open.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      save.compareDocumentPosition(saveAs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("nests theme, Eye Care, Reduce motion, and Condensed NodeFlow under Visual Toggles", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    expect(screen.getByTestId("settings-visual-toggles")).toBeTruthy();
    expect(screen.queryByTestId("settings-theme-toggle")).toBeNull();
    expect(screen.queryByTestId("eye-care-toggle")).toBeNull();
    expect(screen.queryByTestId("nodeflow-dense-toggle")).toBeNull();
    expect(screen.queryByTestId("settings-reduce-motion-toggle")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const theme = screen.getByTestId("settings-theme-toggle");
    const eye = screen.getByTestId("eye-care-toggle");
    const motion = screen.getByTestId("settings-reduce-motion-toggle");
    const dense = screen.getByTestId("nodeflow-dense-toggle");
    expect(theme).toHaveTextContent("Toggle Light Mode");
    expect(eye).toHaveTextContent("Eye Care");
    expect(motion).toHaveTextContent("Reduce motion");
    expect(dense).toHaveTextContent("Condensed NodeFlow");

    fireEvent.click(theme);
    await waitFor(() => {
      expect(theme).toHaveTextContent("Toggle Dark Mode");
      expect(localStorage.getItem("samql.canvasIvory")).toBe("1");
      expect(localStorage.getItem("samql.editorIvory")).toBe("1");
      expect(document.body.classList.contains("canvas-ivory")).toBe(true);
      expect(document.body.classList.contains("editor-ivory")).toBe(true);
    });

    fireEvent.click(motion);
    await waitFor(() => {
      expect(motion).toHaveAttribute("aria-pressed", "true");
      expect(localStorage.getItem("samql.reduceMotion")).toBe("1");
      expect(document.body.classList.contains("motion-reduced")).toBe(true);
    });
  });

  it("closes Toolbar Toggle flyout after pointer leaves trigger and menu", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      await waitFor(() =>
        expect(screen.getByTestId("samql-app")).toHaveAttribute(
          "data-ready",
          "true",
        ),
      );

      fireEvent.click(screen.getByTestId("settings-button"));
      fireEvent.click(screen.getByTestId("settings-toolbar-toggle"));
      expect(screen.getByTestId("settings-toolbar-toggle-menu")).toBeTruthy();

      fireEvent.mouseLeave(screen.getByTestId("settings-toolbar-toggle"));
      expect(screen.getByTestId("settings-toolbar-toggle-menu")).toBeTruthy();

      await vi.advanceTimersByTimeAsync(120);
      expect(screen.queryByTestId("settings-toolbar-toggle-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps flyout open when pointer moves into the submenu within grace", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      await waitFor(() =>
        expect(screen.getByTestId("samql-app")).toHaveAttribute(
          "data-ready",
          "true",
        ),
      );

      fireEvent.click(screen.getByTestId("settings-button"));
      fireEvent.click(screen.getByTestId("settings-visual-toggles"));
      const menu = screen.getByTestId("settings-visual-toggles-menu");

      fireEvent.mouseLeave(screen.getByTestId("settings-visual-toggles"));
      fireEvent.mouseEnter(menu);
      await vi.advanceTimersByTimeAsync(200);
      expect(screen.getByTestId("settings-visual-toggles-menu")).toBeTruthy();

      fireEvent.mouseLeave(menu);
      await vi.advanceTimersByTimeAsync(120);
      expect(screen.queryByTestId("settings-visual-toggles-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes Settings flyout on Escape, then Settings itself", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-toolbar-toggle"));
    expect(screen.getByTestId("settings-toolbar-toggle-menu")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("settings-toolbar-toggle-menu")).toBeNull(),
    );
    expect(screen.getByTestId("settings-toolbar-toggle")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("settings-toolbar-toggle")).toBeNull(),
    );
  });
});
