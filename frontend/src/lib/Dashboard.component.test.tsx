import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashboardExportBundle,
  importDashboardBundle,
  sortPageClient,
  Dashboard,
} from "../components/Dashboard";
import {
  DASHBOARD_WORKSPACE_KEY,
  emptyDashboardWorkspace,
  loadDashboardWorkspace,
  saveDashboardWorkspace,
  type DashboardWorkspace,
} from "./dashboardModel";

const apiMock = vi.hoisted(() => ({
  workflowsList: vi.fn(async () => ({ workflows: [] as { name: string; kind?: string }[] })),
  workflowLoad: vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>),
  workflowSave: vi.fn(async () => ({})),
  nodeflowRun: vi.fn(),
  nodeflowChart: vi.fn(),
  nodeflowReconcile: vi.fn(),
  cancelAll: vi.fn(async () => ({})),
}));

const cancelOneMock = vi.hoisted(() => vi.fn());
const registerRunMock = vi.hoisted(() => vi.fn());
const unregisterRunMock = vi.hoisted(() => vi.fn());
const wasCancelledMock = vi.hoisted(() => vi.fn(() => false));
const isCancelledErrorMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./api", () => ({
  api: apiMock,
  saveToDownloads: vi.fn(async () => ({
    path: "C:/Downloads/x.samql-dashboard.json",
    filename: "x.samql-dashboard.json",
  })),
}));

const exportPdfMock = vi.hoisted(() =>
  vi.fn(
    async (
      _el: HTMLElement,
      _filename: string,
      _title?: string,
    ): Promise<{ path: string; filename: string }> => ({
      path: "C:/Users/me/Downloads/Dashboard.pdf",
      filename: "Dashboard.pdf",
    }),
  ),
);

vi.mock("./dashboardPdf", () => ({
  exportDashboardElementToPdf: exportPdfMock,
}));

vi.mock("./runController", () => ({
  cancelOne: cancelOneMock,
  registerRun: registerRunMock,
  unregisterRun: unregisterRunMock,
  wasCancelled: wasCancelledMock,
  isCancelledError: isCancelledErrorMock,
}));

vi.mock("../components/DataGrid", () => ({
  DataGrid: () => <div data-testid="mock-grid" />,
}));
vi.mock("../components/ChartView", () => ({
  ChartView: () => <div data-testid="mock-chart" />,
}));

function samqlGraph(upstreamType = "browse") {
  return {
    nodes: [
      { id: "u1", type: upstreamType, config: { chart_type: "bar", x: "a", y: "b" } },
      { id: "d1", type: "samqldash", config: {} },
    ],
    edges: [{ from: { node: "u1", port: "out" }, to: { node: "d1", port: "in" } }],
  };
}

function openWidgetConfig(id: string) {
  fireEvent.click(screen.getByTestId(`dashboard-widget-configure-${id}`));
}

/** Open the consolidated toolbar More menu (no-op if already open). */
function openDashboardMore() {
  if (!screen.queryByTestId("dashboard-more-menu")) {
    fireEvent.click(screen.getByTestId("dashboard-more"));
  }
  expect(screen.getByTestId("dashboard-more-menu")).toBeTruthy();
}

function clickDashboardMoreItem(testId: string) {
  openDashboardMore();
  fireEvent.click(screen.getByTestId(testId));
}

function seedWorkspace(patch?: (ws: DashboardWorkspace) => void) {
  const ws = emptyDashboardWorkspace();
  ws.dashboards[0].id = "main";
  ws.activeId = "main";
  ws.dashboards[0].widgets = [
    {
      id: "w1",
      x: 0,
      y: 0,
      w: 6,
      h: 3,
      showHeader: true,
      headerHeight: 34,
      workflowName: "Sales Dash",
      title: "Sales",
    },
    {
      id: "w2",
      x: 6,
      y: 0,
      w: 6,
      h: 3,
      showHeader: true,
      headerHeight: 34,
    },
  ];
  patch?.(ws);
  saveDashboardWorkspace(ws);
  return ws;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  try {
    window.localStorage?.removeItem(DASHBOARD_WORKSPACE_KEY);
    window.localStorage?.removeItem("samql.dashboard.layout.v1");
    window.localStorage?.removeItem("samql.dashboard.configChrome.v1");
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  wasCancelledMock.mockReturnValue(false);
  isCancelledErrorMock.mockReturnValue(false);
  apiMock.workflowsList.mockResolvedValue({ workflows: [] });
  apiMock.workflowLoad.mockResolvedValue({});
  apiMock.workflowSave.mockResolvedValue({});
  apiMock.cancelAll.mockResolvedValue({});
  apiMock.nodeflowRun.mockResolvedValue({
    columns: ["n"],
    rows: [[1]],
    total_rows: 1,
  });
  apiMock.nodeflowChart.mockResolvedValue({
    series: [],
    categories: [],
  });
});

describe("sortPageClient", () => {
  it("sorts numeric columns asc/desc (nulls first ascending)", () => {
    const page = {
      columns: ["n"],
      rows: [[3], [null], [1]],
      offset: 0,
      total_rows: 3,
    };
    expect(sortPageClient(page, "n", false).rows.map((r) => r[0])).toEqual([
      null,
      1,
      3,
    ]);
    expect(sortPageClient(page, "n", true).rows.map((r) => r[0])).toEqual([
      3,
      1,
      null,
    ]);
  });
});

describe("buildDashboardExportBundle / importDashboardBundle", () => {
  it("builds a bundle with referenced node workflows only", async () => {
    apiMock.workflowLoad.mockImplementation(async (name: unknown) => ({
      graph: samqlGraph(),
      name: String(name),
    }));
    const ws = seedWorkspace();
    const bundle = await buildDashboardExportBundle(ws);
    expect(bundle.samql).toBe("dashboard-bundle");
    expect(bundle.workflows).toHaveLength(1);
    expect(bundle.workflows[0].name).toBe("Sales Dash");
    expect(bundle.workflows[0].kind).toBe("node");
  });

  it("rejects non-bundles and restores node workflows on success", async () => {
    const bad = await importDashboardBundle({ samql: "nope" });
    expect(bad.ok).toBe(false);

    apiMock.workflowSave.mockResolvedValue({});
    const ws = seedWorkspace();
    const ok = await importDashboardBundle({
      samql: "dashboard-bundle",
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: ws,
      workflows: [{ name: "Sales Dash", kind: "node", graph: samqlGraph() }],
    });
    expect(ok.ok).toBe(true);
    expect(apiMock.workflowSave).toHaveBeenCalledWith(
      "Sales Dash",
      expect.anything(),
      "node",
    );
  });

  it("fails import when a node workflow cannot be restored", async () => {
    apiMock.workflowSave.mockResolvedValue({ error: "disk full" });
    const r = await importDashboardBundle({
      samql: "dashboard-bundle",
      workspace: emptyDashboardWorkspace(),
      workflows: [{ name: "X", kind: "node", graph: {} }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/X/);
  });
});

describe("Dashboard", () => {
  it("renders the board with Run, board select, More menu, and page title", () => {
    render(<Dashboard onToast={() => undefined} />);
    expect(screen.getByTestId("dashboard-root")).toBeTruthy();
    expect(screen.getByTestId("dashboard-run")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-export-pdf")).toBeNull();
    expect(screen.getByTestId("dashboard-select")).toBeTruthy();
    expect(screen.getByTestId("dashboard-page-title")).toBeTruthy();
    const pageTitle = screen.getByTestId(
      "dashboard-page-title",
    ) as HTMLTextAreaElement;
    expect(pageTitle.tagName).toBe("TEXTAREA");
    expect(pageTitle.value).toBe("Dashboard");
    expect(screen.getByTestId("dashboard-more")).toBeTruthy();
    expect(screen.getByText("More")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-add-widget")).toBeNull();
    openDashboardMore();
    expect(screen.getByTestId("dashboard-export-pdf")).toBeTruthy();
    expect(screen.getByTestId("dashboard-add-empty")).toBeTruthy();
    expect(screen.getByTestId("dashboard-add-text")).toBeTruthy();
    expect(screen.getByTestId("dashboard-undo")).toBeTruthy();
    expect(screen.getByTestId("dashboard-redo")).toBeTruthy();
    expect(screen.getByTestId("dashboard-lock")).toBeTruthy();
    expect(
      (screen.getByTestId("dashboard-undo") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("dashboard-redo") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("undoes and redoes widget layout edits", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openDashboardMore();
    const undo = screen.getByTestId("dashboard-undo") as HTMLButtonElement;
    const redo = screen.getByTestId("dashboard-redo") as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);

    clickDashboardMoreItem("dashboard-add-empty");
    openDashboardMore();
    await waitFor(() =>
      expect(
        (screen.getByTestId("dashboard-undo") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    const beforeUndo = loadDashboardWorkspace().dashboards[0].widgets.length;
    expect(beforeUndo).toBe(3);
    fireEvent.click(screen.getByTestId("dashboard-undo"));
    await waitFor(() =>
      expect(loadDashboardWorkspace().dashboards[0].widgets.length).toBe(2),
    );
    openDashboardMore();
    expect(
      (screen.getByTestId("dashboard-redo") as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("dashboard-redo"));
    await waitFor(() =>
      expect(loadDashboardWorkspace().dashboards[0].widgets.length).toBe(3),
    );
  });

  it("locks widgets from move/resize and persists lock state", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openDashboardMore();
    const lockBtn = screen.getByTestId("dashboard-lock");
    const board = screen.getByTestId("dashboard-board");
    expect(board.getAttribute("data-locked")).toBe("false");
    expect(lockBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(lockBtn);
    await waitFor(() => {
      expect(board.getAttribute("data-locked")).toBe("true");
      expect(board.className).toMatch(/dash-board-locked/);
    });
    expect(loadDashboardWorkspace().dashboards[0].widgetsLocked).toBe(true);
    expect(screen.getByTestId("dashboard-more").className).toMatch(/active/);

    const widget = screen.getByTestId("dashboard-widget-w1");
    fireEvent.pointerDown(widget, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(board, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(board, { pointerId: 1 });
    const after = loadDashboardWorkspace().dashboards[0].widgets.find(
      (w) => w.id === "w1",
    );
    expect(after?.x).toBe(0);
    expect(after?.y).toBe(0);

    clickDashboardMoreItem("dashboard-lock");
    await waitFor(() => {
      expect(board.getAttribute("data-locked")).toBe("false");
      expect(loadDashboardWorkspace().dashboards[0].widgetsLocked).toBeFalsy();
    });
  });

  it("exports the board as a PDF into Downloads", async () => {
    const toast = vi.fn();
    render(<Dashboard onToast={toast} />);
    clickDashboardMoreItem("dashboard-export-pdf");
    await waitFor(() => expect(exportPdfMock).toHaveBeenCalled());
    expect(exportPdfMock.mock.calls[0]?.[1]).toBe("Dashboard");
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "PDF exported",
      expect.stringMatching(/Downloads|Dashboard\.pdf/i),
    );
  });

  it("keeps the original theme board background (no color menu)", async () => {
    render(<Dashboard onToast={() => undefined} />);
    const board = screen.getByTestId("dashboard-board");
    const root = screen.getByTestId("dashboard-root");
    fireEvent.contextMenu(board, { clientX: 120, clientY: 160 });
    expect(screen.queryByTestId("dashboard-bg-menu")).toBeNull();
    expect(board.style.background).toBe("");
    expect(root.style.background).toBe("");
    expect(root.className).not.toMatch(/dash-root-custom-bg/);
  });

  it("opens a page title configure window with size, font, style, and color", async () => {
    render(<Dashboard onToast={() => undefined} />);
    expect(screen.queryByTestId("dashboard-title-config")).toBeNull();
    expect(screen.queryByTestId("dashboard-title-size-pop")).toBeNull();
    fireEvent.click(screen.getByTestId("dashboard-title-configure"));
    const config = screen.getByTestId("dashboard-title-config");
    expect(config).toBeTruthy();
    expect(within(config).getByText("Font size")).toBeTruthy();
    expect(within(config).getByText("Font")).toBeTruthy();
    expect(within(config).getByText("Style")).toBeTruthy();
    expect(within(config).getByText("Color")).toBeTruthy();
    expect(config.className).toMatch(/dash-config/);

    fireEvent.change(screen.getByTestId("dashboard-title-size"), {
      target: { value: "32" },
    });
    fireEvent.change(screen.getByTestId("dashboard-title-font"), {
      target: { value: "Georgia, serif" },
    });
    const titleFont = screen.getByTestId(
      "dashboard-title-font",
    ) as HTMLSelectElement;
    expect(titleFont.querySelectorAll("optgroup").length).toBeGreaterThanOrEqual(4);
    expect(
      within(titleFont).getByRole("option", { name: "Calibri" }),
    ).toBeTruthy();
    expect(
      within(titleFont).getByRole("option", { name: "Consolas" }),
    ).toBeTruthy();
    expect(
      within(titleFont).getByRole("option", { name: "Impact" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("dashboard-title-bold"));
    fireEvent.click(screen.getByTestId("dashboard-title-italic"));
    fireEvent.change(screen.getByTestId("dashboard-title-color"), {
      target: { value: "#ff6600" },
    });

    const title = screen.getByTestId(
      "dashboard-page-title",
    ) as HTMLTextAreaElement;
    expect(title.style.fontSize).toBe("32px");
    expect(title.style.fontFamily).toMatch(/Georgia/);
    expect(title.style.fontWeight).toBe("700");
    expect(title.style.fontStyle).toBe("italic");
    expect(title.style.color.toLowerCase()).toMatch(
      /#ff6600|rgb\(255,\s*102,\s*0\)/,
    );

    await waitFor(() => {
      const raw = window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.pageTitleSize).toBe(32);
      expect(parsed.pageTitleFontFamily).toMatch(/Georgia/);
      expect(parsed.pageTitleBold).toBe(true);
      expect(parsed.pageTitleItalic).toBe(true);
      expect(parsed.pageTitleColor).toBe("#ff6600");
    });
  });

  it("wraps the page title and grows height so the board shifts down", async () => {
    render(<Dashboard onToast={() => undefined} />);
    const title = screen.getByTestId(
      "dashboard-page-title",
    ) as HTMLTextAreaElement;
    const board = screen.getByTestId("dashboard-board");
    const toolbar = board.parentElement?.previousElementSibling as HTMLElement;
    expect(title.tagName).toBe("TEXTAREA");
    expect(title.getAttribute("wrap")).toBe("soft");
    expect(toolbar?.className).toMatch(/dash-toolbar/);

    const boardTopBefore = board.offsetTop;
    Object.defineProperty(title, "scrollHeight", {
      configurable: true,
      get() {
        // Match the auto-grow pattern: measure at height 0, then expand.
        return title.style.height === "0px" ? 72 : 24;
      },
    });

    fireEvent.change(title, {
      target: {
        value:
          "A very long dashboard heading that should wrap within the title window instead of running off screen",
      },
    });

    expect(title.style.height).toBe("72px");
    expect(Number.parseFloat(title.style.height)).toBeGreaterThan(24);
    // Title stays in normal toolbar flow above the board (no absolute overlay).
    expect(toolbar.contains(title)).toBe(true);
    expect(board.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // Growing the title height must not place the board above the toolbar.
    expect(board.offsetTop).toBeGreaterThanOrEqual(boardTopBefore);
    expect(screen.getByTestId("dashboard-more")).toBeTruthy();
    openDashboardMore();
    expect(screen.getByTestId("dashboard-undo")).toBeTruthy();
    expect(screen.getByTestId("dashboard-lock")).toBeTruthy();
  });

  it("autosaves workspace edits to localStorage", async () => {
    render(<Dashboard onToast={() => undefined} />);
    clickDashboardMoreItem("dashboard-add-empty");
    await waitFor(() => {
      const raw = window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.dashboards[0].widgets.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("adds a widget with anim class without opening config on select", async () => {
    const onSel = vi.fn();
    render(<Dashboard onToast={() => undefined} onSelectionChange={onSel} />);
    clickDashboardMoreItem("dashboard-add-empty");
    await waitFor(() => expect(onSel).toHaveBeenCalledWith(false));
    const widgets = screen.getAllByTestId(/dashboard-widget-/);
    expect(widgets.some((el) => el.className.includes("dash-anim-add"))).toBe(
      true,
    );
    expect(screen.queryByTestId("dashboard-config")).toBeNull();
    const added = widgets.find((el) => el.className.includes("dash-anim-add"))!;
    const id = added.getAttribute("data-testid")!.replace("dashboard-widget-", "");
    fireEvent.click(screen.getByTestId(`dashboard-widget-configure-${id}`));
    expect(screen.getByTestId("dashboard-config")).toBeTruthy();
    expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy();
  });

  it("adds an Add Text widget from the More menu", async () => {
    render(<Dashboard onToast={() => undefined} />);
    openDashboardMore();
    expect(screen.getByTestId("dashboard-more-menu")).toBeTruthy();
    expect(screen.getByTestId("dashboard-add-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dashboard-add-text"));
    await waitFor(() =>
      expect(screen.getAllByDisplayValue("Section header").length).toBeGreaterThan(0),
    );
    const textWidget = document.querySelector(
      ".dash-widget-text",
    ) as HTMLElement;
    const id = textWidget
      .getAttribute("data-testid")!
      .replace("dashboard-widget-", "");
    openWidgetConfig(id);
    expect(screen.getByText("Text widget")).toBeTruthy();
    const config = screen.getByTestId("dashboard-config");
    expect(within(config).getByText("Show header")).toBeTruthy();
    expect(within(config).getByText("Text size")).toBeTruthy();
    expect(within(config).getByText("Font")).toBeTruthy();
    fireEvent.click(within(config).getByTitle("Italic"));
    const body = document.querySelector(
      ".dash-widget-text .dash-text-body",
    ) as HTMLTextAreaElement;
    expect(body).toBeTruthy();
    expect(body.style.fontStyle).toBe("italic");
  });

  it("deletes a widget after the remove animation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    const config = screen.getByTestId("dashboard-config");
    fireEvent.click(within(config).getByRole("button", { name: /delete widget/i }));
    expect(screen.getByTestId("dashboard-widget-w1").className).toMatch(
      /dash-anim-remove/,
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("dashboard-widget-w1")).toBeNull(),
    );
  });

  it("adds another dashboard board via the select", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Ops");
    render(<Dashboard onToast={() => undefined} />);
    fireEvent.change(screen.getByTestId("dashboard-select"), {
      target: { value: "__new__" },
    });
    await waitFor(() => {
      const select = screen.getByTestId("dashboard-select") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.textContent === "Ops"),
      ).toBe(true);
    });
    prompt.mockRestore();
  });

  it("deletes the active dashboard after confirm (keeps at least one)", async () => {
    const toast = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Ops");
    render(<Dashboard onToast={toast} />);
    openDashboardMore();
    expect(
      (screen.getByTestId("dashboard-delete") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.mouseDown(screen.getByTestId("dashboard-more-backdrop"));

    fireEvent.change(screen.getByTestId("dashboard-select"), {
      target: { value: "__new__" },
    });
    await waitFor(() => {
      openDashboardMore();
      expect(
        (screen.getByTestId("dashboard-delete") as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByTestId("dashboard-delete"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));
    await waitFor(() => {
      const select = screen.getByTestId("dashboard-select") as HTMLSelectElement;
      expect(
        Array.from(select.options).some((o) => o.textContent === "Ops"),
      ).toBe(false);
    });
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Dashboard deleted",
      expect.stringContaining("Ops"),
    );
    openDashboardMore();
    expect(
      (screen.getByTestId("dashboard-delete") as HTMLButtonElement).disabled,
    ).toBe(true);
    prompt.mockRestore();
  });

  it("updates widget title and header toggles from the config panel", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    const config = screen.getByTestId("dashboard-config");
    fireEvent.change(within(config).getByPlaceholderText("Widget title"), {
      target: { value: "Renamed" },
    });
    await waitFor(() =>
      expect(within(screen.getByTestId("dashboard-widget-w1")).getByText("Renamed")).toBeTruthy(),
    );
    const showHeader = within(config).getByRole("checkbox", {
      name: /show header/i,
    });
    fireEvent.click(showHeader);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("dashboard-widget-w1")
          .querySelector(".dash-widget-head"),
      ).toBeNull(),
    );
  });

  it("lists only node workflows with a samqldash sink in the picker", async () => {
    seedWorkspace((ws) => {
      ws.dashboards[0].widgets[1].workflowName = undefined;
    });
    apiMock.workflowsList.mockResolvedValue({
      workflows: [
        { name: "Good", kind: "node" },
        { name: "Bad", kind: "node" },
        { name: "IDE", kind: "ide" },
      ],
    });
    apiMock.workflowLoad.mockImplementation(async (name: unknown) => {
      if (name === "Good") return { graph: samqlGraph() };
      return { graph: { nodes: [{ id: "o", type: "output" }], edges: [] } };
    });
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w2");
    fireEvent.click(screen.getByRole("button", { name: /pick/i }));
    await waitFor(() => expect(screen.getByTestId("dashboard-picker")).toBeTruthy());
    expect(screen.getByText("Good")).toBeTruthy();
    expect(screen.queryByText("Bad")).toBeNull();
    expect(screen.queryByText("IDE")).toBeNull();
    fireEvent.click(screen.getByText("Good"));
    await waitFor(() =>
      expect(
        (
          screen
            .getByTestId("dashboard-config")
            .querySelector("input[readonly]") as HTMLInputElement
        )?.value,
      ).toBe("Good"),
    );
  });

  it("warns when Run has no bound widgets", async () => {
    const toast = vi.fn();
    render(<Dashboard onToast={toast} />);
    fireEvent.click(screen.getByTestId("dashboard-run"));
    expect(toast).toHaveBeenCalledWith(
      "warn",
      "Nothing to run",
      expect.any(String),
    );
    expect(apiMock.nodeflowRun).not.toHaveBeenCalled();
  });

  it("runs bound widgets and fills table results", async () => {
    seedWorkspace((ws) => {
      ws.dashboards[0].lastRunAt = undefined;
      ws.dashboards[0].lastRunMs = undefined;
    });
    apiMock.workflowLoad.mockResolvedValue({ graph: samqlGraph("browse") });
    const toast = vi.fn();
    render(<Dashboard onToast={toast} />);
    expect(screen.queryByTestId("dashboard-last-runtime")).toBeNull();
    fireEvent.click(screen.getByTestId("dashboard-run"));
    await waitFor(() => expect(apiMock.nodeflowRun).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("mock-grid")).toBeTruthy());
    expect(registerRunMock).toHaveBeenCalled();
    await waitFor(() => {
      const el = screen.getByTestId("dashboard-last-runtime");
      expect(el.textContent).toMatch(/Last run /);
      // Date present (month abbrev or year) and duration with ms or seconds.
      expect(el.textContent).toMatch(/\d{4}|[A-Za-z]{3}/);
      expect(el.textContent).toMatch(/ms|s/);
    });
  });

  it("shows persisted last-run date and duration on load", () => {
    seedWorkspace((ws) => {
      ws.dashboards[0].lastRunAt = Date.UTC(2026, 6, 13, 15, 30, 45);
      ws.dashboards[0].lastRunMs = 420;
    });
    render(<Dashboard onToast={() => undefined} />);
    const el = screen.getByTestId("dashboard-last-runtime");
    expect(el.textContent).toMatch(/Last run /);
    expect(el.textContent).toMatch(/420 ms/);
    expect(el.textContent).toMatch(/2026|Jul/);
  });

  it("configures header color, widget background, and liquid glass", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    const config = screen.getByTestId("dashboard-config");
    expect(within(config).getByText("Header color")).toBeTruthy();
    expect(within(config).getByText("Widget background")).toBeTruthy();
    expect(within(config).getByText("Liquid glass")).toBeTruthy();

    fireEvent.change(screen.getByTestId("dashboard-header-color"), {
      target: { value: "#ff0000" },
    });
    fireEvent.change(screen.getByTestId("dashboard-widget-bg"), {
      target: { value: "#00ff00" },
    });
    fireEvent.click(screen.getByTestId("dashboard-liquid-glass"));

    await waitFor(() => {
      const widget = screen.getByTestId("dashboard-widget-w1");
      expect(widget.className).toMatch(/dash-widget-glass/);
      expect(widget.style.background).toMatch(/#00ff00|rgb\(0,\s*255,\s*0\)|color-mix/);
      const head = widget.querySelector(".dash-widget-head") as HTMLElement;
      expect(head.style.background).toMatch(/#ff0000|rgb\(255,\s*0,\s*0\)/);
    });

    // Config panel should not force horizontal overflow via fixed wide width.
    expect(config.scrollWidth).toBeLessThanOrEqual(config.clientWidth + 1);
  });

  it("places text grab + resize below the header area", async () => {
    render(<Dashboard onToast={() => undefined} />);
    clickDashboardMoreItem("dashboard-add-text");
    await waitFor(() =>
      expect(document.querySelector(".dash-widget-text")).toBeTruthy(),
    );
    const textWidget = document.querySelector(
      ".dash-widget-text",
    ) as HTMLElement;
    const id = textWidget.getAttribute("data-testid")!.replace(
      "dashboard-widget-",
      "",
    );
    expect(screen.getByTestId(`dashboard-text-grab-${id}`)).toBeTruthy();
    const resize = screen.getByTestId(`dashboard-text-resize-${id}`);
    expect(resize.className).toMatch(/dash-resize-text/);
    // Resize lives inside the body (below the header), not above the head.
    expect(resize.closest(".dash-widget-body")).toBeTruthy();
    expect(resize.closest(".dash-widget-head")).toBeNull();
    // Resize must not open the config modal.
    fireEvent.click(resize);
    expect(screen.queryByTestId("dashboard-config")).toBeNull();
  });

  it("persists text widget style options through localStorage", async () => {
    render(<Dashboard onToast={() => undefined} />);
    clickDashboardMoreItem("dashboard-add-text");
    await waitFor(() =>
      expect(document.querySelector(".dash-widget-text")).toBeTruthy(),
    );
    const textWidget = document.querySelector(
      ".dash-widget-text",
    ) as HTMLElement;
    const id = textWidget
      .getAttribute("data-testid")!
      .replace("dashboard-widget-", "");
    openWidgetConfig(id);
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-config")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("dashboard-header-color"), {
      target: { value: "#abcdef" },
    });
    fireEvent.change(screen.getByTestId("dashboard-widget-font"), {
      target: { value: 'Calibri, "Segoe UI", sans-serif' },
    });
    fireEvent.change(screen.getByTestId("dashboard-widget-bg"), {
      target: { value: "#123456" },
    });
    fireEvent.click(screen.getByTestId("dashboard-liquid-glass"));
    await waitFor(() => {
      const raw = window.localStorage.getItem(DASHBOARD_WORKSPACE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      const text = parsed.dashboards[0].widgets.find(
        (w: { kind?: string }) => w.kind === "text",
      );
      expect(text.headerColor).toBe("#abcdef");
      expect(text.fontFamily).toMatch(/Calibri/);
      expect(text.backgroundColor).toBe("#123456");
      expect(text.liquidGlass).toBe(true);
    });
  });

  it("toggles Run to Cancel and cancels FE + BE", async () => {
    seedWorkspace();
    let resolveRun!: (v: unknown) => void;
    apiMock.workflowLoad.mockResolvedValue({ graph: samqlGraph("browse") });
    apiMock.nodeflowRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    const toast = vi.fn();
    render(<Dashboard onToast={toast} />);
    fireEvent.click(screen.getByTestId("dashboard-run"));
    await waitFor(() => expect(screen.getByText("Cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dashboard-run"));
    await waitFor(() => expect(cancelOneMock).toHaveBeenCalled());
    expect(apiMock.cancelAll).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "warn",
      "Cancelled",
      expect.any(String),
    );
    resolveRun({ columns: ["n"], rows: [[1]], total_rows: 1 });
  });

  it("persists via command save with kind=dashboard", async () => {
    seedWorkspace((ws) => {
      ws.savedName = "Board Pack";
    });
    const consumed = vi.fn();
    const toast = vi.fn();
    const changed = vi.fn();
    render(
      <Dashboard
        onToast={toast}
        command={{ id: 11, action: "save" }}
        onCommandConsumed={consumed}
        onWorkflowsChanged={changed}
      />,
    );
    await waitFor(() =>
      expect(apiMock.workflowSave).toHaveBeenCalledWith(
        "Board Pack",
        expect.objectContaining({ version: 2 }),
        "dashboard",
      ),
    );
    expect(consumed).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Dashboard saved",
      expect.stringContaining("Board Pack"),
    );
  });

  it("exports via command using saveToDownloads", async () => {
    seedWorkspace();
    apiMock.workflowLoad.mockResolvedValue({ graph: samqlGraph() });
    const toast = vi.fn();
    render(
      <Dashboard
        onToast={toast}
        command={{ id: 12, action: "export" }}
        onCommandConsumed={vi.fn()}
      />,
    );
    await waitFor(async () => {
      const { saveToDownloads: save } = await import("./api");
      expect(save).toHaveBeenCalled();
    });
    expect(toast).toHaveBeenCalledWith("ok", "Exported", expect.any(String));
  });

  it("applies loadRequest workspace and soft-loads referenced node workflows", async () => {
    const toast = vi.fn();
    const consumed = vi.fn();
    apiMock.workflowLoad.mockResolvedValue({ graph: samqlGraph() });
    const ws = emptyDashboardWorkspace();
    ws.dashboards[0].id = "loaded";
    ws.activeId = "loaded";
    ws.dashboards[0].widgets = [
      {
        id: "lx",
        x: 0,
        y: 0,
        w: 6,
        h: 3,
        workflowName: "Sales Dash",
        showHeader: true,
        headerHeight: 34,
      },
    ];
    render(
      <Dashboard
        onToast={toast}
        loadRequest={{ id: 7, name: "From Server", graph: ws }}
        onLoadConsumed={consumed}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-widget-lx")).toBeTruthy(),
    );
    expect(apiMock.workflowLoad).toHaveBeenCalledWith("Sales Dash", "node");
    expect(consumed).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("ok", "Dashboard loaded", "From Server");
  });

  it("imports a dashboard-bundle loadRequest and restores node workflows", async () => {
    const toast = vi.fn();
    apiMock.workflowSave.mockResolvedValue({});
    const ws = emptyDashboardWorkspace();
    ws.dashboards[0].id = "b1";
    ws.activeId = "b1";
    ws.dashboards[0].widgets = [
      {
        id: "bw",
        x: 0,
        y: 0,
        w: 6,
        h: 3,
        workflowName: "Pack WF",
        showHeader: true,
        headerHeight: 34,
      },
    ];
    render(
      <Dashboard
        onToast={toast}
        loadRequest={{
          id: 8,
          name: "Bundle",
          graph: {
            samql: "dashboard-bundle",
            workspace: ws,
            workflows: [
              { name: "Pack WF", kind: "node", graph: samqlGraph() },
            ],
          },
        }}
        onLoadConsumed={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(apiMock.workflowSave).toHaveBeenCalledWith(
        "Pack WF",
        expect.anything(),
        "node",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-widget-bw")).toBeTruthy(),
    );
  });

  it("opens a resizable expand window next to Configure", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    expect(screen.queryByTestId("dashboard-expand-w1")).toBeNull();

    fireEvent.click(screen.getByTestId("dashboard-widget-expand-w1"));
    const win = screen.getByTestId("dashboard-expand-w1");
    expect(win).toBeTruthy();
    expect(win.className).toMatch(/dash-expand-win/);
    expect(screen.getByTestId("dashboard-expand-resize")).toBeTruthy();
    expect(screen.getByTestId("dashboard-expand-close")).toBeTruthy();
    expect((win as HTMLElement).style.width).toMatch(/px/);
    expect((win as HTMLElement).style.height).toMatch(/px/);
    // Expanded window shows the widget title from the board.
    expect(within(win).getByText("Sales")).toBeTruthy();

    fireEvent.click(screen.getByTestId("dashboard-expand-close"));
    expect(screen.queryByTestId("dashboard-expand-w1")).toBeNull();
  });

  it("closes the expand window via backdrop click", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    fireEvent.click(screen.getByTestId("dashboard-widget-expand-w1"));
    expect(screen.getByTestId("dashboard-expand-w1")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("dashboard-expand-backdrop"));
    expect(screen.queryByTestId("dashboard-expand-w1")).toBeNull();
  });

  it("expands a text widget", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    clickDashboardMoreItem("dashboard-add-text");
    const textWidget = document.querySelector(
      ".dash-widget-text",
    ) as HTMLElement | null;
    expect(textWidget).toBeTruthy();
    const id = (textWidget!.getAttribute("data-testid") || "").replace(
      "dashboard-widget-",
      "",
    );
    expect(id).toBeTruthy();
    fireEvent.click(screen.getByTestId(`dashboard-widget-expand-${id}`));
    const win = screen.getByTestId(`dashboard-expand-${id}`);
    expect(win).toBeTruthy();
    expect(within(win).getByPlaceholderText("Section header text")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dashboard-expand-close"));
    expect(screen.queryByTestId(`dashboard-expand-${id}`)).toBeNull();
  });

  it("closes the expand window with Escape before config", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    fireEvent.click(screen.getByTestId("dashboard-widget-expand-w1"));
    openWidgetConfig("w1");
    expect(screen.getByTestId("dashboard-expand-w1")).toBeTruthy();
    expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("dashboard-expand-w1")).toBeNull();
    expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy();
  });

  it("opens a draggable Field Explore–style config float that can minimize", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    const panel = screen.getByTestId("dashboard-config-panel");
    expect(panel.className).toMatch(/win-float/);
    expect(screen.getByTestId("dashboard-config")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dashboard-config-minimize"));
    expect(screen.queryByTestId("dashboard-config-panel")).toBeNull();
    const mini = screen.getByTestId("dashboard-config-mini");
    expect(mini.className).toMatch(/tt-mini/);
    // click-without-drag expands (same pattern as Field Explorer)
    fireEvent.mouseDown(mini, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-config-mini")).toBeNull();
  });

  it("opens config only via Configure / title button, not widget click", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    expect(screen.queryByTestId("dashboard-config")).toBeNull();

    fireEvent.click(screen.getByTestId("dashboard-widget-w1"));
    expect(screen.getByTestId("dashboard-widget-w1").className).toMatch(
      /selected/,
    );
    expect(screen.queryByTestId("dashboard-config")).toBeNull();

    fireEvent.click(screen.getByTestId("dashboard-widget-w2"));
    expect(screen.getByTestId("dashboard-widget-w2").className).toMatch(
      /selected/,
    );
    expect(screen.queryByTestId("dashboard-config")).toBeNull();

    openWidgetConfig("w1");
    expect(screen.getByTestId("dashboard-config")).toBeTruthy();
    expect(within(screen.getByTestId("dashboard-config")).getByDisplayValue("Sales")).toBeTruthy();

    fireEvent.click(screen.getByTestId("dashboard-config-close"));
    expect(screen.queryByTestId("dashboard-config")).toBeNull();

    fireEvent.click(screen.getByTestId("dashboard-title-configure"));
    expect(screen.getByTestId("dashboard-title-config")).toBeTruthy();
  });

  it("keeps config stable (no flash) when selecting other widgets", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    const panel = screen.getByTestId("dashboard-config-panel");
    expect(
      within(screen.getByTestId("dashboard-config")).getByDisplayValue("Sales"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("dashboard-widget-w2"));
    // Selection moves, but the float stays on the configured widget (no close/reopen flash).
    expect(screen.getByTestId("dashboard-widget-w2").className).toMatch(
      /selected/,
    );
    expect(screen.getByTestId("dashboard-config-panel")).toBe(panel);
    expect(
      within(screen.getByTestId("dashboard-config")).getByDisplayValue("Sales"),
    ).toBeTruthy();
  });

  it("closes the config float with Escape when expanded", async () => {
    seedWorkspace();
    render(<Dashboard onToast={() => undefined} />);
    openWidgetConfig("w1");
    expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("dashboard-config")).toBeNull();
  });

  it("does not portal config into inspectorHost (float instead)", async () => {
    seedWorkspace();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <Dashboard onToast={() => undefined} inspectorHost={host} />,
    );
    openWidgetConfig("w1");
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-config-panel")).toBeTruthy(),
    );
    expect(host.querySelector("[data-testid='dashboard-config']")).toBeNull();
    host.remove();
  });
});
