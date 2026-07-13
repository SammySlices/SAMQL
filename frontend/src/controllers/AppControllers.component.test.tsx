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
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    apiMock.tables
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useCatalogController(toast));

    act(() => {
      result.current.refreshTables();
      result.current.refreshTables();
    });
    await act(async () => {
      second.resolve([{ name: "new", engine: "duckdb", columns: [] }]);
      await second.promise;
    });
    await act(async () => {
      first.resolve([{ name: "old", engine: "duckdb", columns: [] }]);
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
