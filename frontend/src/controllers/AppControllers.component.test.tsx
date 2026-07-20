import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdTab, ResultTab } from "./appTypes";
import { useBackgroundOperations } from "./useBackgroundOperations";
import { useCatalogController } from "./useCatalogController";
import { useIdeController } from "./useIdeController";
import { useResultController } from "./useResultController";
import { useWorkspaceController } from "./useWorkspaceController";
import { wfEnvelope } from "../lib/workflowFile";

const apiMock = vi.hoisted(() => ({
  tables: vi.fn(),
  history: vi.fn(),
  saved: vi.fn(),
  workflowsList: vi.fn(),
  workflowSave: vi.fn(),
  workflowLoad: vi.fn(),
  workflowDelete: vi.fn(),
  saveFile: vi.fn(),
  mssqlDisconnect: vi.fn(),
  page: vi.fn(),
  cancelQuery: vi.fn(),
  loadStart: vi.fn(),
  loadFolderStart: vi.fn(),
  hdfsLoadFileStart: vi.fn(),
  optimizeTableStart: vi.fn(),
  loadProgress: vi.fn(),
}));
const registerBgCancelMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const cancelOneMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({
  api: apiMock,
  registerBgCancel: registerBgCancelMock,
}));

vi.mock("../lib/runController", () => ({
  cancelOne: cancelOneMock,
  registerRun: vi.fn(),
  unregisterRun: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const toast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  apiMock.history.mockResolvedValue([]);
  apiMock.saved.mockResolvedValue([]);
  apiMock.workflowsList.mockResolvedValue({ workflows: [] });
  apiMock.workflowSave.mockResolvedValue({ ok: true });
  apiMock.saveFile.mockResolvedValue({ ok: true });
  apiMock.cancelQuery.mockResolvedValue({});
  apiMock.loadProgress.mockResolvedValue({ loaded: [] });
});

describe("Phase 5 App controllers", () => {
  it("IDE controller recovers a stale active id and allocates a unique tab name", async () => {
    const { result } = renderHook(() =>
      useIdeController({
        saved: {
          edTabs: [
            { id: "one", title: "Query 1", sql: "SELECT 1" },
            { id: "three", title: "Query 3", sql: "SELECT 3" },
          ],
          activeId: "missing",
          target: "__local__",
        },
        sampleSql: "SELECT 0",
        safeTargets: new Set(["auto", "__local__", "__duckdb__"]),
      }),
    );

    await waitFor(() => expect(result.current.activeId).toBe("one"));
    act(() => result.current.newTab());
    expect(result.current.edTabs[result.current.edTabs.length - 1]?.title).toBe("Query 4");
    expect(result.current.target).toBe("__local__");
  });

  it("IDE controller cancels only the active tab run", () => {
    const { result } = renderHook(() =>
      useIdeController({
        saved: {
          edTabs: [
            { id: "one", title: "One", sql: "SELECT 1" },
            { id: "two", title: "Two", sql: "SELECT 2" },
          ],
          activeId: "one",
        },
        sampleSql: "",
        safeTargets: new Set(["auto"]),
      }),
    );
    const first = new AbortController();
    const second = new AbortController();
    act(() => {
      result.current.setRuns({
        one: { ctrl: first, queryId: "q-one", startedAt: 1 },
        two: { ctrl: second, queryId: "q-two", startedAt: 2 },
      });
    });
    act(() => result.current.cancelRunning());
    expect(cancelOneMock).toHaveBeenCalledTimes(1);
    expect(cancelOneMock).toHaveBeenCalledWith("q-one", first);
  });

  it("catalog controller keeps the newest table refresh response", async () => {
    const first = deferred<{ tables: any[]; data_epoch: number }>();
    const second = deferred<{ tables: any[]; data_epoch: number }>();
    apiMock.tables
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useCatalogController(toast));

    act(() => {
      result.current.refreshTables();
      result.current.refreshTables();
    });
    await act(async () => {
      second.resolve({
        tables: [{ name: "new", engine: "duckdb", columns: [] }],
        data_epoch: 2,
      });
      await second.promise;
    });
    await act(async () => {
      first.resolve({
        tables: [{ name: "old", engine: "duckdb", columns: [] }],
        data_epoch: 1,
      });
      await first.promise;
    });
    expect(result.current.tables.map((table) => table.name)).toEqual(["new"]);
  });

  it("result controller releases inactive rows but preserves metadata", async () => {
    const { result } = renderHook(() => useResultController(toast, 100));
    const first: ResultTab = {
      id: "first",
      kind: "result",
      title: "First",
      resultId: "rid-first",
      page: { columns: ["n"], rows: [[1]], total_rows: 1 },
    };
    const second: ResultTab = {
      id: "second",
      kind: "result",
      title: "Second",
      resultId: "rid-second",
      page: { columns: ["n"], rows: [[2]], total_rows: 1 },
    };
    act(() => {
      result.current.setResTabs([first, second]);
      result.current.setActiveResId("first");
    });
    await waitFor(() =>
      expect(
        result.current.resTabs.find((tab) => tab.id === "second")?.released,
      ).toBe(true),
    );
    const released = result.current.resTabs.find((tab) => tab.id === "second");
    expect(released?.page?.rows).toEqual([]);
    expect(released?.page?.columns).toEqual(["n"]);
    expect(result.current.activeResultTab?.id).toBe("first");
  });

  it("workspace controller routes raw SQL and Journal envelopes to the right surface", () => {
    const loadSql = vi.fn();
    const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
    const activeRef = createRef<string>() as React.MutableRefObject<string>;
    tabsRef.current = [{ id: "one", title: "One", sql: "" }];
    activeRef.current = "one";
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "samql.test.view",
        toast,
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: tabsRef,
        setEdTabs: vi.fn(),
        activeIdRef: activeRef,
        loadSqlIntoEditor: loadSql,
      }),
    );

    act(() => result.current.openWorkflowContent("SELECT 9", "raw.sql"));
    expect(loadSql).toHaveBeenCalledWith("SELECT 9");
    expect(result.current.view).toBe("ide");

    const journal = wfEnvelope("journal", "Daily", { doc: "journal-doc" });
    act(() => result.current.openWorkflowContent(journal, "daily.samql.json"));
    expect(result.current.view).toBe("notebook");
    expect(result.current.journalLoad).toMatchObject({
      name: "Daily",
      doc: "journal-doc",
    });
  });

  it("workspace controller routes dashboard envelopes and activeSave commands", async () => {
    const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
    const activeRef = createRef<string>() as React.MutableRefObject<string>;
    tabsRef.current = [{ id: "one", title: "One", sql: "" }];
    activeRef.current = "one";
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "samql.test.view",
        toast,
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: tabsRef,
        setEdTabs: vi.fn(),
        activeIdRef: activeRef,
        loadSqlIntoEditor: vi.fn(),
      }),
    );

    const dash = wfEnvelope("dashboard", "Board Pack", {
      version: 2,
      activeId: "d1",
      dashboards: [{ id: "d1", name: "Main", widgets: [] }],
    });
    act(() => result.current.openWorkflowContent(dash, "board.samql.json"));
    expect(result.current.view).toBe("dashboard");
    expect(result.current.dashboardLoad).toMatchObject({
      name: "Board Pack",
      graph: expect.objectContaining({ version: 2 }),
    });

    act(() => result.current.switchView("dashboard"));
    act(() => result.current.activeSave());
    expect(result.current.dashboardCmd).toMatchObject({ action: "save" });
    act(() => result.current.activeSaveAs());
    expect(result.current.dashboardCmd).toMatchObject({ action: "saveAs" });
    // Unified Open always uses the App-level file picker (ideFile), which
    // routes by detected document kind via openWorkflowContent.
    act(() => result.current.activeOpen());
    expect(result.current.ideFile).toMatchObject({ mode: "open" });

    act(() => result.current.switchView("ide"));
    act(() => result.current.activeOpen());
    expect(result.current.ideFile).toMatchObject({ mode: "open" });

    act(() => result.current.switchView("notebook"));
    act(() => result.current.activeOpen());
    expect(result.current.ideFile).toMatchObject({ mode: "open" });
    expect(result.current.journalCmd).toBeNull();

    act(() => result.current.switchView("nodeflow"));
    act(() => result.current.activeOpen());
    expect(result.current.ideFile).toMatchObject({ mode: "open" });
    expect(result.current.nodeCmd).toBeNull();

    apiMock.workflowLoad.mockResolvedValue({
      graph: {
        version: 2,
        activeId: "d1",
        dashboards: [{ id: "d1", name: "Main", widgets: [] }],
      },
    });
    await act(async () => {
      await result.current.onLoadWorkflow("dashboard", "From List");
    });
    expect(result.current.view).toBe("dashboard");
    expect(result.current.dashboardLoad?.name).toBe("From List");
  });

  it.each([
    {
      label: "query",
      content: () => wfEnvelope("ide", "Q1", { sql: "select 42" }),
      view: "ide" as const,
      check: (
        r: { journalLoad: unknown; nodeLoad: unknown; dashboardLoad: unknown },
        loadSql: ReturnType<typeof vi.fn>,
      ) => {
        expect(loadSql).toHaveBeenCalledWith("select 42");
        expect(r.journalLoad).toBeNull();
        expect(r.nodeLoad).toBeNull();
        expect(r.dashboardLoad).toBeNull();
      },
    },
    {
      label: "journal",
      content: () => wfEnvelope("journal", "Daily", { doc: "journal-doc" }),
      view: "notebook" as const,
      check: (r: { journalLoad: unknown }) => {
        expect(r.journalLoad).toMatchObject({ name: "Daily", doc: "journal-doc" });
      },
    },
    {
      label: "node workflow",
      content: () =>
        wfEnvelope("node", "Flow", { nodes: [{ id: "a" }], edges: [] }),
      view: "nodeflow" as const,
      check: (r: { nodeLoad: unknown }) => {
        expect(r.nodeLoad).toMatchObject({
          name: "Flow",
          graph: expect.objectContaining({ nodes: [{ id: "a" }] }),
        });
      },
    },
    {
      label: "dashboard",
      content: () =>
        wfEnvelope("dashboard", "Board", {
          version: 2,
          activeId: "d1",
          dashboards: [{ id: "d1", name: "Main", widgets: [] }],
        }),
      view: "dashboard" as const,
      check: (r: { dashboardLoad: unknown }) => {
        expect(r.dashboardLoad).toMatchObject({ name: "Board" });
      },
    },
  ])(
    "openWorkflowContent routes $label to the $view surface",
    ({ content, view, check }) => {
      const loadSql = vi.fn();
      const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
      const activeRef = createRef<string>() as React.MutableRefObject<string>;
      tabsRef.current = [{ id: "one", title: "One", sql: "" }];
      activeRef.current = "one";
      const { result } = renderHook(() =>
        useWorkspaceController({
          viewKey: "samql.test.view",
          toast,
          askConfirm: vi.fn(),
          refreshWorkflows: vi.fn(),
          edTabsRef: tabsRef,
          setEdTabs: vi.fn(),
          activeIdRef: activeRef,
          loadSqlIntoEditor: loadSql,
        }),
      );

      act(() =>
        result.current.openWorkflowContent(content(), `${view}.samql.json`),
      );
      expect(result.current.view).toBe(view);
      check(result.current, loadSql);
    },
  );

  it("openWorkflowContent loads a created-node export into NodeFlow", () => {
    const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
    const activeRef = createRef<string>() as React.MutableRefObject<string>;
    tabsRef.current = [{ id: "one", title: "One", sql: "" }];
    activeRef.current = "one";
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "samql.test.view",
        toast,
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: tabsRef,
        setEdTabs: vi.fn(),
        activeIdRef: activeRef,
        loadSqlIntoEditor: vi.fn(),
      }),
    );

    const payload = JSON.stringify({
      format: "samql-created-node",
      version: 1,
      node: {
        id: "cn-1",
        name: "Scaler",
        icon: "Sparkle",
        graph: {
          nodes: [
            { id: "di", type: "dyn_input", x: 0, y: 0, config: {} },
            { id: "do", type: "dyn_output", x: 80, y: 0, config: {} },
          ],
          edges: [
            {
              id: "e1",
              from: { node: "di", port: "out" },
              to: { node: "do", port: "in" },
            },
          ],
        },
        inputs: [{ id: "in", label: "in" }],
        outputs: [{ id: "out", label: "out" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    act(() =>
      result.current.openWorkflowContent(payload, "scaler.created.json"),
    );
    expect(result.current.view).toBe("nodeflow");
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Created node loaded",
      expect.stringContaining("Scaler"),
    );
  });

  it("activeSaveAs dispatches Save As for the active surface", () => {
    const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
    const activeRef = createRef<string>() as React.MutableRefObject<string>;
    tabsRef.current = [{ id: "one", title: "One", sql: "" }];
    activeRef.current = "one";
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "samql.test.view",
        toast,
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: tabsRef,
        setEdTabs: vi.fn(),
        activeIdRef: activeRef,
        loadSqlIntoEditor: vi.fn(),
      }),
    );

    act(() => result.current.switchView("ide"));
    act(() => result.current.activeSaveAs());
    expect(result.current.ideFile).toMatchObject({ mode: "save" });

    act(() => result.current.switchView("notebook"));
    act(() => result.current.activeSaveAs());
    expect(result.current.journalCmd).toMatchObject({ action: "saveAs" });

    act(() => result.current.switchView("nodeflow"));
    act(() => result.current.activeSaveAs());
    expect(result.current.nodeCmd).toMatchObject({ action: "saveAs" });

    act(() => result.current.switchView("dashboard"));
    act(() => result.current.activeSaveAs());
    expect(result.current.dashboardCmd).toMatchObject({ action: "saveAs" });
  });

  it("IDE Save reuses workflow and file identities", async () => {
    const tabsRef = createRef<EdTab[]>() as React.MutableRefObject<EdTab[]>;
    const activeRef = createRef<string>() as React.MutableRefObject<string>;
    tabsRef.current = [
      {
        id: "one",
        title: "Renamed tab",
        sql: "select 1",
        savedWorkflowName: "Original query",
      },
    ];
    activeRef.current = "one";
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "samql.test.view",
        toast,
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: tabsRef,
        setEdTabs: vi.fn(),
        activeIdRef: activeRef,
        loadSqlIntoEditor: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.saveIdeWorkflow();
    });
    expect(apiMock.workflowSave).toHaveBeenCalledWith(
      "Original query",
      { sql: "select 1" },
      "ide",
    );

    apiMock.workflowSave.mockClear();
    tabsRef.current = [
      {
        ...tabsRef.current[0],
        savedWorkflowName: undefined,
        savedFilePath: "C:/flows/query.samql.json",
      },
    ];
    await act(async () => {
      await result.current.saveIdeWorkflow();
    });
    expect(apiMock.saveFile).toHaveBeenCalledWith(
      "C:/flows/query.samql.json",
      expect.stringContaining('"kind": "ide"'),
    );
    expect(apiMock.workflowSave).not.toHaveBeenCalled();

    apiMock.saveFile.mockClear();
    tabsRef.current = [
      {
        id: "two",
        title: "Untitled",
        sql: "select 2",
      },
    ];
    activeRef.current = "two";
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Brand new");
    await act(async () => {
      await result.current.saveIdeWorkflow();
    });
    expect(apiMock.workflowSave).toHaveBeenCalledWith(
      "Brand new",
      { sql: "select 2" },
      "ide",
    );
    prompt.mockRestore();
  });

  it("background controller starts loads, closes the modal, and reports completion", async () => {
    apiMock.loadStart.mockResolvedValue({ job_id: "job-1" });
    const refreshTables = vi.fn();
    const { result } = renderHook(() => {
      const [loadOpen, setLoadOpen] = useState(true);
      return {
        loadOpen,
        controller: useBackgroundOperations({
          toast,
          refreshTables,
          setLoadOpen,
        }),
      };
    });

    await act(async () => {
      await result.current.controller.beginLoad("C:/data/file.csv", "duckdb");
    });
    expect(result.current.loadOpen).toBe(false);
    expect(apiMock.loadStart).toHaveBeenCalledWith(
      "C:/data/file.csv",
      "duckdb",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    await act(async () => {
      await result.current.controller.onTaskComplete({
        id: "job-1",
        kind: "load",
        state: "done",
        title: "file.csv",
        rows: 12,
      } as any);
    });
    expect(refreshTables).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Loaded",
      expect.stringContaining("12 rows"),
    );
  });

});
