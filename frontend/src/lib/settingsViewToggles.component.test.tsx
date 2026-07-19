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
import { setNodeFlowDenseMode, setNodeFlowSphereMode } from "./nodeFlowModel";

describe("Settings View consolidations", () => {
  beforeEach(() => {
    localStorage.clear();
    setNodeFlowDenseMode(false);
    setNodeFlowSphereMode(false);
    document.documentElement.classList.remove(
      "eye-care",
      "nb-dense",
      "nb-sphere",
      "theme-light",
      "has-user-canvas-bg",
      "has-user-canvas-bg-ide",
      "has-user-canvas-bg-journal",
      "has-user-canvas-bg-node",
      "has-user-canvas-dot-node",
      "canvas-node-luma-dark",
      "canvas-node-luma-light",
    );
    document.documentElement.style.removeProperty("--user-canvas-bg");
    document.documentElement.style.removeProperty("--user-canvas-bg-ide");
    document.documentElement.style.removeProperty("--user-canvas-bg-journal");
    document.documentElement.style.removeProperty("--user-canvas-bg-node");
    document.documentElement.style.removeProperty("--user-canvas-dot-color-node");
    document.documentElement.style.removeProperty(
      "--user-canvas-dot-opacity-node",
    );
    document.documentElement.removeAttribute("data-canvas-node-luma");
    document.documentElement.removeAttribute("data-eye-care");
    document.documentElement.removeAttribute("data-nb-dense");
    document.documentElement.removeAttribute("data-nb-sphere");
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.classList.remove("motion-reduced", "canvas-ivory", "editor-ivory");
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
    // JSON Field Explorer stays under Settings → Tools.
    expect(
      within(document.querySelector(".settings-menu") as HTMLElement).getByRole(
        "button",
        { name: "JSON Field Explorer" },
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-json-field-explorer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-toolbar-toggle"));
    expect(screen.queryByTestId("settings-toolbar-tables-panel")).toBeNull();
    const search = screen.getByTestId("settings-toolbar-node-search");
    const nodeTb = screen.getByTestId("settings-toolbar-node-toolbar");
    expect(search).toHaveAttribute("aria-checked", "true");
    expect(nodeTb).toHaveAttribute("aria-checked", "true");

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

  it("nests theme, Eye Care, Reduce motion, Condensed NodeFlow, Node Snap, and Sphere nodes under Visual Toggles", async () => {
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
    expect(screen.queryByTestId("node-snap-toggle")).toBeNull();
    expect(screen.queryByTestId("nodeflow-sphere-toggle")).toBeNull();
    expect(screen.queryByTestId("settings-reduce-motion-toggle")).toBeNull();
    expect(screen.queryByTestId("settings-canvas-color")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const theme = screen.getByTestId("settings-theme-toggle");
    const eye = screen.getByTestId("eye-care-toggle");
    const motion = screen.getByTestId("settings-reduce-motion-toggle");
    const dense = screen.getByTestId("nodeflow-dense-toggle");
    const snap = screen.getByTestId("node-snap-toggle");
    const sphere = screen.getByTestId("nodeflow-sphere-toggle");
    const canvasColor = screen.getByTestId("settings-canvas-color");
    expect(theme).toHaveTextContent("Toggle Light Mode");
    expect(eye).toHaveTextContent("Eye Care");
    expect(motion).toHaveTextContent("Reduce motion");
    expect(dense).toHaveTextContent("Condensed NodeFlow");
    expect(snap).toHaveTextContent("Node Snap");
    expect(snap).toHaveAttribute("aria-pressed", "false");
    expect(sphere).toHaveTextContent("Sphere nodes: on");
    expect(sphere).toHaveAttribute("aria-pressed", "true");
    expect(canvasColor).toHaveTextContent("Change Canvas Color");
    expect(localStorage.getItem("samql.nodeSnap")).toBe("0");
    expect(localStorage.getItem("samql.nodeSphere")).toBe("1");
    expect(document.documentElement.classList.contains("nb-sphere")).toBe(true);

    fireEvent.click(theme);
    await waitFor(() => {
      expect(theme).toHaveTextContent("Toggle Dark Mode");
      expect(localStorage.getItem("samql.canvasIvory")).toBe("1");
      expect(localStorage.getItem("samql.editorIvory")).toBe("1");
      expect(localStorage.getItem("samql.theme")).toBe("light");
      expect(document.body.classList.contains("canvas-ivory")).toBe(true);
      expect(document.body.classList.contains("editor-ivory")).toBe(true);
      expect(document.documentElement.classList.contains("theme-light")).toBe(
        true,
      );
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    fireEvent.click(theme);
    await waitFor(() => {
      expect(theme).toHaveTextContent("Toggle Light Mode");
      expect(localStorage.getItem("samql.theme")).toBe("dark");
      expect(document.documentElement.classList.contains("theme-light")).toBe(
        false,
      );
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    fireEvent.click(motion);
    await waitFor(() => {
      expect(motion).toHaveAttribute("aria-pressed", "true");
      expect(localStorage.getItem("samql.reduceMotion")).toBe("1");
      expect(document.body.classList.contains("motion-reduced")).toBe(true);
    });

    fireEvent.click(snap);
    await waitFor(() => {
      expect(snap).toHaveAttribute("aria-pressed", "true");
      expect(snap).toHaveTextContent("Node Snap: on");
      expect(localStorage.getItem("samql.nodeSnap")).toBe("1");
    });

    fireEvent.click(sphere);
    await waitFor(() => {
      expect(sphere).toHaveAttribute("aria-pressed", "false");
      expect(sphere).toHaveTextContent("Sphere nodes");
      expect(localStorage.getItem("samql.nodeSphere")).toBe("0");
      expect(document.documentElement.classList.contains("nb-sphere")).toBe(
        false,
      );
    });

    fireEvent.click(sphere);
    await waitFor(() => {
      expect(sphere).toHaveAttribute("aria-pressed", "true");
      expect(sphere).toHaveTextContent("Sphere nodes: on");
      expect(localStorage.getItem("samql.nodeSphere")).toBe("1");
      expect(document.documentElement.classList.contains("nb-sphere")).toBe(
        true,
      );
    });
  });

  it("restores Sphere nodes off from explicit localStorage 0", async () => {
    localStorage.setItem("samql.nodeSphere", "0");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const sphere = screen.getByTestId("nodeflow-sphere-toggle");
    expect(sphere).toHaveAttribute("aria-pressed", "false");
    expect(sphere).toHaveTextContent("Sphere nodes");
    expect(localStorage.getItem("samql.nodeSphere")).toBe("0");
  });

  it("defaults Sphere nodes on for missing or corrupt localStorage", async () => {
    localStorage.setItem("samql.nodeSphere", "maybe");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    const sphere = screen.getByTestId("nodeflow-sphere-toggle");
    expect(sphere).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("samql.nodeSphere")).toBe("1");
  });

  it("Change Canvas Color opens floating modal with surface tabs", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );

    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    fireEvent.click(screen.getByTestId("settings-canvas-color"));
    // Settings closes; floating modal opens (hot-path: UI first).
    await waitFor(() => {
      expect(document.querySelector(".settings-menu")).toBeNull();
      expect(screen.getByTestId("settings-canvas-color-panel")).toBeTruthy();
    });
    expect(screen.getByTestId("settings-canvas-tab-ide")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("settings-canvas-tab-journal")).toBeTruthy();
    expect(screen.getByTestId("settings-canvas-tab-node")).toBeTruthy();
    expect(screen.getByTestId("settings-canvas-color-input")).toBeTruthy();
    expect(screen.getByTestId("settings-canvas-text-input")).toBeTruthy();

    const swatch = screen.getByTestId("settings-canvas-swatch-e4ebe4");
    fireEvent.click(swatch);
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasColor.ide")).toBe("#e4ebe4");
      expect(
        document.documentElement.classList.contains("has-user-canvas-bg-ide"),
      ).toBe(true);
      expect(
        document.documentElement.style.getPropertyValue("--user-canvas-bg-ide"),
      ).toBe("#e4ebe4");
    });

    fireEvent.click(screen.getByTestId("settings-canvas-text-swatch-ffffff"));
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasTextColor.ide")).toBe("#ffffff");
      expect(
        document.documentElement.classList.contains("has-user-canvas-text-ide"),
      ).toBe(true);
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-text-ide",
        ),
      ).toBe("#ffffff");
    });

    fireEvent.click(screen.getByTestId("settings-canvas-tab-journal"));
    expect(screen.getByTestId("settings-canvas-tab-journal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByTestId("settings-canvas-swatch-ffffff"));
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasColor.journal")).toBe("#ffffff");
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-bg-journal",
        ),
      ).toBe("#ffffff");
      // IDE color unchanged
      expect(localStorage.getItem("samql.canvasColor.ide")).toBe("#e4ebe4");
    });

    fireEvent.click(screen.getByTestId("settings-canvas-text-swatch-111111"));
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasTextColor.journal")).toBe(
        "#111111",
      );
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-text-journal",
        ),
      ).toBe("#111111");
    });

    fireEvent.click(screen.getByTestId("settings-canvas-tab-node"));
    const wheel = screen.getByTestId(
      "settings-canvas-color-input",
    ) as HTMLInputElement;
    fireEvent.input(wheel, { target: { value: "#ececec" } });
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasColor.node")).toBe("#ececec");
      expect(
        document.documentElement.style.getPropertyValue("--user-canvas-bg-node"),
      ).toBe("#ececec");
    });
    const textWheel = screen.getByTestId(
      "settings-canvas-text-input",
    ) as HTMLInputElement;
    fireEvent.input(textWheel, { target: { value: "#54b949" } });
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasTextColor.node")).toBe(
        "#54b949",
      );
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-text-node",
        ),
      ).toBe("#54b949");
    });
    expect(screen.getByTestId("settings-canvas-dots")).toBeTruthy();
    expect(screen.getByTestId("settings-canvas-dot-color")).toBeTruthy();
    expect(screen.getByTestId("settings-canvas-dot-opacity")).toBeTruthy();
  });

  it("Node tab sets snap-grid dot color and opacity", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    fireEvent.click(screen.getByTestId("settings-canvas-color"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-canvas-color-panel")).toBeTruthy(),
    );
    // Dots controls only on Node tab
    expect(screen.queryByTestId("settings-canvas-dots")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-canvas-tab-node"));
    expect(screen.getByTestId("settings-canvas-dots")).toBeTruthy();

    const dotColor = screen.getByTestId(
      "settings-canvas-dot-color",
    ) as HTMLInputElement;
    fireEvent.input(dotColor, { target: { value: "#224466" } });
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasDotColor.node")).toBe("#224466");
      expect(
        document.documentElement.classList.contains("has-user-canvas-dot-node"),
      ).toBe(true);
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-dot-color-node",
        ),
      ).toBe("#224466");
    });

    const opacity = screen.getByTestId(
      "settings-canvas-dot-opacity",
    ) as HTMLInputElement;
    fireEvent.input(opacity, { target: { value: "55" } });
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasDotOpacity.node")).toBe("55");
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-dot-opacity-node",
        ),
      ).toBe("55");
    });

    fireEvent.click(screen.getByTestId("settings-canvas-dot-reset"));
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasDotColor.node")).toBeNull();
      expect(localStorage.getItem("samql.canvasDotOpacity.node")).toBeNull();
      expect(
        document.documentElement.classList.contains("has-user-canvas-dot-node"),
      ).toBe(false);
    });
  });

  it("restores persisted NodeFlow snap-grid dots on load", async () => {
    localStorage.setItem("samql.canvasDotColor.node", "#aabbcc");
    localStorage.setItem("samql.canvasDotOpacity.node", "40");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    expect(
      document.documentElement.classList.contains("has-user-canvas-dot-node"),
    ).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue(
        "--user-canvas-dot-color-node",
      ),
    ).toBe("#aabbcc");
    expect(
      document.documentElement.style.getPropertyValue(
        "--user-canvas-dot-opacity-node",
      ),
    ).toBe("40");
  });

  it("restores persisted per-surface canvas colors on load", async () => {
    localStorage.setItem("samql.canvasColor.ide", "#ececec");
    localStorage.setItem("samql.canvasColor.journal", "#e4ebe4");
    localStorage.setItem("samql.canvasColor.node", "#ffffff");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    expect(
      document.documentElement.classList.contains("has-user-canvas-bg-ide"),
    ).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue("--user-canvas-bg-ide"),
    ).toBe("#ececec");
    expect(
      document.documentElement.style.getPropertyValue(
        "--user-canvas-bg-journal",
      ),
    ).toBe("#e4ebe4");
    expect(
      document.documentElement.style.getPropertyValue("--user-canvas-bg-node"),
    ).toBe("#ffffff");
  });

  it("migrates legacy samql.canvasColor to all three surfaces", async () => {
    localStorage.setItem("samql.canvasColor", "#d8d8d8");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    expect(localStorage.getItem("samql.canvasColor.ide")).toBe("#d8d8d8");
    expect(localStorage.getItem("samql.canvasColor.journal")).toBe("#d8d8d8");
    expect(localStorage.getItem("samql.canvasColor.node")).toBe("#d8d8d8");
    expect(localStorage.getItem("samql.canvasColor")).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--user-canvas-bg-ide"),
    ).toBe("#d8d8d8");
  });

  it("resets a surface canvas color to default", async () => {
    localStorage.setItem("samql.canvasColor.ide", "#ffffff");
    localStorage.setItem("samql.canvasTextColor.ide", "#111111");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("samql-app")).toHaveAttribute(
        "data-ready",
        "true",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-button"));
    fireEvent.click(screen.getByTestId("settings-visual-toggles"));
    fireEvent.click(screen.getByTestId("settings-canvas-color"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-canvas-color-panel")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("settings-canvas-color-reset"));
    await waitFor(() => {
      expect(localStorage.getItem("samql.canvasColor.ide")).toBeNull();
      expect(localStorage.getItem("samql.canvasTextColor.ide")).toBeNull();
      expect(
        document.documentElement.classList.contains("has-user-canvas-bg-ide"),
      ).toBe(false);
      expect(
        document.documentElement.classList.contains("has-user-canvas-text-ide"),
      ).toBe(false);
      expect(
        document.documentElement.style.getPropertyValue("--user-canvas-bg-ide"),
      ).toBe("");
      expect(
        document.documentElement.style.getPropertyValue(
          "--user-canvas-text-ide",
        ),
      ).toBe("");
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
