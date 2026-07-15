import { afterEach, describe, expect, it } from "vitest";
import {
  DASH_COLS,
  DASH_HEADER_DEFAULT,
  DASH_HEADER_MAX,
  DASH_HEADER_MIN,
  DASH_TEXT_FONTS,
  DASHBOARD_WORKSPACE_KEY,
  collectWorkflowNames,
  deleteDashboardInWorkspace,
  emptyDashboardDoc,
  emptyDashboardWorkspace,
  findSamqlDashboardTargets,
  formatDashboardLastRun,
  formatDashboardRuntime,
  graphHasSamqlDashboard,
  groupDashTextFonts,
  kindFromUpstream,
  loadDashboardWorkspace,
  moveDashboardInWorkspace,
  normalizeWidget,
  normalizeWorkspace,
  packWidgetsNoOverlap,
  packAroundFocus,
  renameDashboardInWorkspace,
  resizeWidgetFitting,
  saveDashboardWorkspace,
  widgetsOverlap,
} from "./dashboardModel";

afterEach(() => {
  try {
    window.localStorage?.removeItem(DASHBOARD_WORKSPACE_KEY);
    window.localStorage?.removeItem("samql.dashboard.layout.v1");
  } catch {
    /* ignore */
  }
});

describe("dashboardModel", () => {
  it("starts with one Main board of three empty widgets", () => {
    const ws = emptyDashboardWorkspace();
    expect(ws.version).toBe(2);
    expect(ws.dashboards).toHaveLength(1);
    expect(ws.dashboards[0].name).toBe("Main");
    expect(ws.dashboards[0].widgets).toHaveLength(3);
    expect(ws.dashboards[0].widgets.every((w) => !w.workflowName)).toBe(true);
    expect(ws.dashboards[0].widgets.every((w) => w.showHeader !== false)).toBe(
      true,
    );
  });

  it("preserves widgetsLocked on normalize / round-trip", () => {
    const ws = normalizeWorkspace({
      version: 2,
      activeId: "d1",
      dashboards: [
        {
          id: "d1",
          name: "Main",
          widgetsLocked: true,
          widgets: [{ id: "w1", x: 0, y: 0, w: 6, h: 3 }],
        },
      ],
    });
    expect(ws.dashboards[0].widgetsLocked).toBe(true);
    saveDashboardWorkspace(ws);
    expect(loadDashboardWorkspace().dashboards[0].widgetsLocked).toBe(true);
  });

  it("migrates legacy cell layouts into a workspace", () => {
    const ws = normalizeWorkspace({
      version: 1,
      cells: [
        { id: "c1", x: 0, y: 0, w: 6, h: 3, workflowName: "sales" },
        { id: "c2", x: 6, y: 0, w: 6, h: 3 },
      ],
    });
    expect(ws.version).toBe(2);
    expect(ws.dashboards[0].widgets).toHaveLength(2);
    expect(ws.dashboards[0].widgets[0].workflowName).toBe("sales");
  });

  it("formats and preserves last run timing on a board", () => {
    expect(formatDashboardRuntime(340)).toBe("340 ms");
    expect(formatDashboardRuntime(1240)).toBe("1.2 s");
    expect(formatDashboardRuntime(12500)).toBe("13 s");
    const label = formatDashboardLastRun(1_700_000_000_000, 340);
    expect(label).toMatch(/ms/);
    expect(label).toMatch(/·/);
    // Includes a calendar date (month or numeric), not just duration.
    expect(label).toMatch(/\d{4}|[A-Za-z]{3}/);
    const ws = normalizeWorkspace({
      version: 2,
      activeId: "d1",
      dashboards: [
        {
          id: "d1",
          name: "Main",
          widgets: [{ id: "w1", x: 0, y: 0, w: 6, h: 3 }],
          lastRunAt: 1_700_000_000_000,
          lastRunMs: 1500,
        },
      ],
    });
    expect(ws.dashboards[0].lastRunAt).toBe(1_700_000_000_000);
    expect(ws.dashboards[0].lastRunMs).toBe(1500);
  });

  it("normalizes page title typography fields", () => {
    const ws = normalizeWorkspace({
      version: 2,
      activeId: "d1",
      pageTitle: "Ops Board",
      pageTitleSize: 36,
      pageTitleFontFamily: "Georgia, serif",
      pageTitleBold: true,
      pageTitleItalic: true,
      pageTitleUnderline: true,
      pageTitleColor: "#abcdef",
      dashboards: [
        { id: "d1", name: "Main", widgets: [{ id: "w1", x: 0, y: 0, w: 6, h: 3 }] },
      ],
    });
    expect(ws.pageTitle).toBe("Ops Board");
    expect(ws.pageTitleSize).toBe(36);
    expect(ws.pageTitleFontFamily).toBe("Georgia, serif");
    expect(ws.pageTitleBold).toBe(true);
    expect(ws.pageTitleItalic).toBe(true);
    expect(ws.pageTitleUnderline).toBe(true);
    expect(ws.pageTitleColor).toBe("#abcdef");
  });

  it("normalizes widget header color, background, and liquid glass", () => {
    const w = normalizeWidget({
      id: "styled",
      x: 0,
      y: 0,
      w: 6,
      h: 3,
      headerColor: "  #334455  ",
      backgroundColor: "#112233",
      liquidGlass: true,
    });
    expect(w).toMatchObject({
      headerColor: "#334455",
      backgroundColor: "#112233",
      liquidGlass: true,
    });
    const plain = normalizeWidget({
      id: "plain",
      x: 0,
      y: 0,
      w: 6,
      h: 3,
      liquidGlass: false,
      headerColor: "   ",
    });
    expect(plain?.headerColor).toBeUndefined();
    expect(plain?.liquidGlass).toBeUndefined();
  });

  it("ignores legacy board backgroundColor on load (theme background only)", () => {
    const ws = normalizeWorkspace({
      version: 2,
      activeId: "d1",
      dashboards: [
        {
          id: "d1",
          name: "Main",
          backgroundColor: "  #1e2430  ",
          widgets: [{ id: "w1", x: 0, y: 0, w: 6, h: 3 }],
        },
      ],
    });
    expect(
      Object.prototype.hasOwnProperty.call(ws.dashboards[0], "backgroundColor"),
    ).toBe(false);
  });

  it("clamps widget geometry and header height; rejects bad ids", () => {
    expect(normalizeWidget(null)).toBeNull();
    expect(normalizeWidget({ id: 1 })).toBeNull();
    const w = normalizeWidget({
      id: "w",
      x: -5,
      y: -2,
      w: 99,
      h: 99,
      headerHeight: 999,
      showHeader: false,
      workflowName: "  sales  ",
      title: "T",
    });
    expect(w).toMatchObject({
      id: "w",
      x: 0,
      y: 0,
      w: DASH_COLS,
      h: 40,
      showHeader: false,
      headerHeight: DASH_HEADER_MAX,
      workflowName: "sales",
      title: "T",
    });
    const tiny = normalizeWidget({
      id: "t",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      headerHeight: 1,
    });
    expect(tiny?.w).toBe(2);
    expect(tiny?.h).toBe(2);
    expect(tiny?.headerHeight).toBe(DASH_HEADER_MIN);
  });

  it("normalizes workspace activeId / savedName and empty fallbacks", () => {
    const empty = normalizeWorkspace(null);
    expect(empty.dashboards[0].widgets.length).toBeGreaterThan(0);
    const badActive = normalizeWorkspace({
      version: 2,
      activeId: "missing",
      savedName: "  Board  ",
      dashboards: [
        {
          id: "d1",
          name: "One",
          widgets: [{ id: "w1", x: 0, y: 0, w: 6, h: 3 }],
        },
      ],
    });
    expect(badActive.activeId).toBe("d1");
    expect(badActive.savedName).toBe("Board");
  });

  it("collects unique sorted workflow names across boards", () => {
    const names = collectWorkflowNames({
      version: 2,
      activeId: "a",
      dashboards: [
        {
          id: "a",
          name: "A",
          widgets: [
            { id: "1", x: 0, y: 0, w: 6, h: 3, workflowName: "zeta" },
            { id: "2", x: 0, y: 0, w: 6, h: 3, workflowName: "alpha" },
          ],
        },
        {
          id: "b",
          name: "B",
          widgets: [
            { id: "3", x: 0, y: 0, w: 6, h: 3, workflowName: "alpha" },
            { id: "4", x: 0, y: 0, w: 6, h: 3 },
          ],
        },
      ],
    });
    expect(names).toEqual(["alpha", "zeta"]);
  });

  it("persists workspace to localStorage", () => {
    const ws = emptyDashboardWorkspace();
    ws.savedName = "Mine";
    saveDashboardWorkspace(ws);
    const loaded = loadDashboardWorkspace();
    expect(loaded.savedName).toBe("Mine");
    expect(loaded.dashboards[0].id).toBe(ws.dashboards[0].id);
  });

  it("detects SamQL Dashboard sinks and upstream kinds", () => {
    const graph = {
      nodes: [
        { id: "c1", type: "chart", config: { chart_type: "bar", x: "a" } },
        { id: "d1", type: "samqldash", config: { label: "dashboard out" } },
      ],
      edges: [
        { from: { node: "c1", port: "out" }, to: { node: "d1", port: "in" } },
      ],
    };
    expect(graphHasSamqlDashboard(graph)).toBe(true);
    const targets = findSamqlDashboardTargets(graph);
    expect(targets).toHaveLength(1);
    expect(targets[0].upstreamType).toBe("chart");
    expect(kindFromUpstream("pivot")).toBe("pivot");
    expect(kindFromUpstream("reconcile")).toBe("reconcile");
    expect(kindFromUpstream("browse")).toBe("table");
  });

  it("returns no targets when samqldash has no inbound edge", () => {
    expect(
      findSamqlDashboardTargets({
        nodes: [{ id: "d1", type: "samqldash", config: {} }],
        edges: [],
      }),
    ).toEqual([]);
  });

  it("rejects graphs without a SamQL Dashboard sink", () => {
    expect(
      graphHasSamqlDashboard({
        nodes: [{ id: "o1", type: "output", config: {} }],
      }),
    ).toBe(false);
  });

  it("defaults header height when omitted", () => {
    const w = normalizeWidget({ id: "h", x: 0, y: 0, w: 4, h: 3 });
    expect(w?.headerHeight).toBe(DASH_HEADER_DEFAULT);
    expect(w?.showHeader).toBe(true);
  });

  it("packs overlapping widgets downward without covering each other", () => {
    const a = {
      id: "a",
      kind: "data" as const,
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      showHeader: true,
      headerHeight: DASH_HEADER_DEFAULT,
    };
    const b = {
      id: "b",
      kind: "data" as const,
      x: 0,
      y: 1,
      w: 6,
      h: 3,
      showHeader: true,
      headerHeight: DASH_HEADER_DEFAULT,
    };
    expect(widgetsOverlap(a, b)).toBe(true);
    const packed = packWidgetsNoOverlap([a, b]);
    const pa = packed.find((w) => w.id === "a")!;
    const pb = packed.find((w) => w.id === "b")!;
    expect(widgetsOverlap(pa, pb)).toBe(false);
    expect(pb.y).toBeGreaterThanOrEqual(pa.y + pa.h);
  });

  it("grows a widget and pushes siblings clear", () => {
    const widgets = [
      {
        id: "a",
        kind: "data" as const,
        x: 0,
        y: 0,
        w: 4,
        h: 2,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      },
      {
        id: "b",
        kind: "data" as const,
        x: 0,
        y: 2,
        w: 4,
        h: 2,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      },
    ];
    const next = resizeWidgetFitting(widgets, "a", { h: 5 });
    const a = next.find((w) => w.id === "a")!;
    const b = next.find((w) => w.id === "b")!;
    expect(a.h).toBe(5);
    expect(widgetsOverlap(a, b)).toBe(false);
  });

  it("snaps widgets up to fill empty vertical space", () => {
    const widgets = [
      {
        id: "top",
        kind: "data" as const,
        x: 0,
        y: 0,
        w: 6,
        h: 2,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      },
      {
        id: "gap",
        kind: "data" as const,
        x: 0,
        y: 8,
        w: 6,
        h: 2,
        showHeader: true,
        headerHeight: DASH_HEADER_DEFAULT,
      },
    ];
    const packed = packWidgetsNoOverlap(widgets);
    const gap = packed.find((w) => w.id === "gap")!;
    expect(gap.y).toBe(2);
  });

  it("packs around a focused widget without moving it", () => {
    const focus = {
      id: "focus",
      kind: "data" as const,
      x: 0,
      y: 2,
      w: 6,
      h: 3,
      showHeader: true,
      headerHeight: DASH_HEADER_DEFAULT,
    };
    const other = {
      id: "other",
      kind: "data" as const,
      x: 0,
      y: 2,
      w: 6,
      h: 2,
      showHeader: true,
      headerHeight: DASH_HEADER_DEFAULT,
    };
    const packed = packAroundFocus([focus, other], "focus");
    const f = packed.find((w) => w.id === "focus")!;
    const o = packed.find((w) => w.id === "other")!;
    expect(f.y).toBe(2);
    expect(widgetsOverlap(f, o)).toBe(false);
    // Gravity fills the gap above the focused widget when possible.
    expect(o.y).toBe(0);
  });

  it("normalizes text widgets with typography and fitted height", () => {
    const t = normalizeWidget({
      id: "t",
      kind: "text",
      x: 0,
      y: 0,
      w: 12,
      h: 3,
      text: "Hello",
      textSize: 28,
      fontFamily: "Georgia, serif",
      textBold: true,
      textItalic: true,
      headerColor: "#aabbcc",
      backgroundColor: "#010203",
      liquidGlass: true,
    });
    expect(t).toMatchObject({
      kind: "text",
      text: "Hello",
      textSize: 28,
      fontFamily: "Georgia, serif",
      textBold: true,
      textItalic: true,
      headerColor: "#aabbcc",
      backgroundColor: "#010203",
      liquidGlass: true,
    });
    expect(t?.workflowName).toBeUndefined();
    // Fitted height should be well under a full empty data row.
    expect(t!.h).toBeLessThan(1.2);
    expect(t!.h).toBeGreaterThanOrEqual(0.35);
  });

  it("moves, renames, and deletes boards in the workspace", () => {
    const a = emptyDashboardDoc("Alpha");
    const b = emptyDashboardDoc("Beta");
    const c = emptyDashboardDoc("Gamma");
    let ws = {
      ...emptyDashboardWorkspace(),
      activeId: a.id,
      dashboards: [a, b, c],
    };
    ws = moveDashboardInWorkspace(ws, a.id, 1);
    expect(ws.dashboards.map((d) => d.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
    ws = renameDashboardInWorkspace(ws, b.id, "Ops");
    expect(ws.dashboards.find((d) => d.id === b.id)?.name).toBe("Ops");
    const del = deleteDashboardInWorkspace(ws, a.id);
    expect(del.ok).toBe(true);
    if (del.ok) {
      expect(del.workspace.dashboards.map((d) => d.name)).toEqual([
        "Ops",
        "Gamma",
      ]);
      expect(del.workspace.activeId).not.toBe(a.id);
    }
    const only = deleteDashboardInWorkspace(
      { ...ws, dashboards: [b], activeId: b.id },
      b.id,
    );
    expect(only.ok).toBe(false);
  });

  it("exposes a large grouped system-font catalog with stable legacy values", () => {
    expect(DASH_TEXT_FONTS.length).toBeGreaterThanOrEqual(40);
    const values = DASH_TEXT_FONTS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
    // Backward-compatible stacks for existing saved dashboards.
    for (const legacy of [
      "inherit",
      '"Segoe UI", system-ui, sans-serif',
      "Arial, Helvetica, sans-serif",
      "Verdana, Geneva, sans-serif",
      '"Trebuchet MS", sans-serif',
      "Georgia, serif",
      '"Times New Roman", Times, serif',
      "Garamond, serif",
      '"Courier New", Courier, monospace',
    ]) {
      expect(values).toContain(legacy);
    }
    const groups = groupDashTextFonts();
    expect(groups.map((g) => g.group)).toEqual([
      "Default",
      "Sans",
      "Serif",
      "Mono",
      "Display",
    ]);
    expect(groups.reduce((n, g) => n + g.fonts.length, 0)).toBe(
      DASH_TEXT_FONTS.length,
    );
    expect(values.some((v) => /Calibri|Consolas|Impact/.test(v))).toBe(true);
  });
});
