import React from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./components/load/FileBrowser";
import { useNodeFlowViewport } from "./components/nodeflow/useNodeFlowViewport";
import { useWorkspaceController } from "./controllers/useWorkspaceController";
import { api } from "./lib/api";
import {
  cancelAllRuns,
  registerRun,
  unregisterRun,
} from "./lib/runController";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("async request ownership regressions", () => {
  it("keeps the newest saved-workflow response", async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    vi.spyOn(api, "workflowLoad").mockImplementation((name: string) =>
      (name === "older" ? older.promise : newer.promise) as ReturnType<
        typeof api.workflowLoad
      >,
    );
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "audit.view",
        toast: vi.fn(),
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: { current: [] },
        setEdTabs: vi.fn(),
        activeIdRef: { current: "tab-a" },
        loadSqlIntoEditor: vi.fn(),
      }),
    );

    let olderPending!: Promise<void>;
    let newerPending!: Promise<void>;
    act(() => {
      olderPending = result.current.onLoadWorkflow("node", "older");
      newerPending = result.current.onLoadWorkflow("node", "newer");
    });
    await act(async () => {
      newer.resolve({ graph: { marker: "new" } });
      await newerPending;
    });
    await act(async () => {
      older.resolve({ graph: { marker: "old" } });
      await olderPending;
    });

    expect(result.current.nodeLoad?.name).toBe("newer");
    expect(result.current.nodeLoad?.graph).toEqual({ marker: "new" });
  });

  it("attaches an IDE workflow name to the tab that received its SQL", async () => {
    const request = deferred<any>();
    vi.spyOn(api, "workflowLoad").mockReturnValue(
      request.promise as ReturnType<typeof api.workflowLoad>,
    );
    const activeIdRef = { current: "tab-a" };
    const loadSqlIntoEditor = vi.fn((_sql: string, preferred?: string) => preferred);
    const { result } = renderHook(() =>
      useWorkspaceController({
        viewKey: "audit.view",
        toast: vi.fn(),
        askConfirm: vi.fn(),
        refreshWorkflows: vi.fn(),
        edTabsRef: {
          current: [
            { id: "tab-a", title: "Query 1", sql: "" },
            { id: "tab-b", title: "Query 2", sql: "" },
          ],
        },
        setEdTabs: vi.fn(),
        activeIdRef,
        loadSqlIntoEditor,
      }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.onLoadWorkflow("ide", "saved-query");
    });
    activeIdRef.current = "tab-b";
    await act(async () => {
      request.resolve({ graph: { sql: "select 1" } });
      await pending;
    });

    expect(loadSqlIntoEditor).toHaveBeenCalledWith("select 1", "tab-a");
    expect(result.current.ideWfNames).toEqual({ "tab-a": "saved-query" });
  });

  it("prevents an older FileBrowser response from replacing the newest path", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    vi.spyOn(api, "fsList").mockImplementation((path?: string) => {
      if (path === "/a") return first.promise;
      if (path === "/b") return second.promise;
      return Promise.resolve({
        path: "/root",
        parent: null,
        sep: "/",
        drives: [],
        shortcuts: [
          { label: "A", path: "/a" },
          { label: "B", path: "/b" },
        ],
        entries: [],
      });
    });

    render(<FileBrowser onPick={vi.fn()} onClose={vi.fn()} initialPath="/root" />);
    expect(await screen.findByText("/root")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));

    await act(async () => {
      second.resolve({
        path: "/b",
        parent: "/root",
        sep: "/",
        drives: [],
        shortcuts: [],
        entries: [],
      });
      await second.promise;
    });
    await act(async () => {
      first.resolve({
        path: "/a",
        parent: "/root",
        sep: "/",
        drives: [],
        shortcuts: [],
        entries: [],
      });
      await first.promise;
    });

    expect(screen.getByText("/b")).toBeInTheDocument();
    expect(screen.queryByText("/a")).not.toBeInTheDocument();
  });

  it("cancels registered runs without aborting unrelated API requests", async () => {
    const originalFetch = globalThis.fetch;
    let healthSignal: AbortSignal | undefined;
    let resolveHealth!: (response: Response) => void;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/health")) {
        healthSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveHealth = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const runController = new AbortController();
    registerRun("owned-run", runController);
    try {
      const health = api.health();
      await Promise.resolve();
      cancelAllRuns(["owned-run"]);
      expect(runController.signal.aborted).toBe(true);
      expect(healthSignal?.aborted).toBe(false);
      resolveHealth(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await health;
    } finally {
      unregisterRun("owned-run", runController);
      globalThis.fetch = originalFetch;
    }
  });

  it("observes canvas container resizing for virtualization bounds", async () => {
    vi.useFakeTimers();
    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));

    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 80 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const ref = { current: element };
    const { result, unmount } = renderHook(() => useNodeFlowViewport(ref));
    expect(observe).toHaveBeenCalledWith(element);
    expect(result.current.scrollPos.w).toBe(100);

    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      value: 240,
    });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
      vi.runOnlyPendingTimers();
    });
    expect(result.current.scrollPos.w).toBe(240);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
