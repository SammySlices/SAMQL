import { act, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnFilter, ResultPage } from "./types";

vi.mock("./runController", async () => {
  const actual = await vi.importActual<typeof import("./runController")>(
    "./runController",
  );
  return {
    ...actual,
  };
});

import {
  usePagedResult,
  type PageRequestOptions,
  type PagedResultSnapshot,
} from "./usePagedResult";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function page(rows: number[][], total = rows.length): ResultPage {
  return { columns: ["n"], rows, total_rows: total };
}

function makeState(
  extra: Partial<PagedResultSnapshot> = {},
): PagedResultSnapshot {
  return {
    id: "result-1",
    resultId: "rid-1",
    page: page([[1]], 3),
    sortCol: null,
    descending: false,
    filters: [],
    ...extra,
  };
}

function patchState(
  state: PagedResultSnapshot,
  patch: Partial<PagedResultSnapshot>,
): void {
  Object.assign(state, patch);
}

describe("shared IDE/Journal paging controller", () => {
  it("keeps only the latest rapid filter response", async () => {
    const state = makeState({ queryId: "run-page-1" });
    const first = deferred<ResultPage>();
    const second = deferred<ResultPage>();
    const requests: {
      options: PageRequestOptions;
      signal: AbortSignal;
    }[] = [];
    const fetchPage = vi.fn(
      (_resultId: string, options: PageRequestOptions, signal: AbortSignal) => {
        requests.push({ options, signal });
        return requests.length === 1 ? first.promise : second.promise;
      },
    );
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
      }),
    );

    const filtersA: ColumnFilter[] = [
      { column: "n", op: "equals", value: "1" },
    ];
    const filtersB: ColumnFilter[] = [
      { column: "n", op: "equals", value: "2" },
    ];
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.applyFilters(state.id, filtersA);
      b = result.current.applyFilters(state.id, filtersB);
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].options.filters).toEqual(filtersB);
    // Supersede aborts the prior fetch; query_id still rides for Stop mid-send.
    expect(requests[0].options.query_id).toBe("run-page-1");
    expect(requests[1].options.query_id).toBe("run-page-1");

    await act(async () => {
      second.resolve(page([[2]], 1));
      await b;
    });
    expect(state.page?.rows).toEqual([[2]]);
    expect(state.filters).toEqual(filtersB);

    await act(async () => {
      first.resolve(page([[1]], 1));
      await a;
    });
    expect(state.page?.rows).toEqual([[2]]);
    expect(state.filters).toEqual(filtersB);
  });

  it("prevents duplicate next-page requests and appends once", async () => {
    const state = makeState();
    const pending = deferred<ResultPage>();
    let requestCount = 0;
    let requestedOptions: PageRequestOptions | null = null;
    const fetchPage = (
      _resultId: string,
      options: PageRequestOptions,
      _signal: AbortSignal,
    ) => {
      requestCount += 1;
      requestedOptions = options;
      return pending.promise;
    };
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
        pageSize: 2,
      }),
    );

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.loadMore(state.id);
      duplicate = result.current.loadMore(state.id);
    });
    expect(requestCount).toBe(1);
    expect(requestedOptions).toMatchObject({ offset: 1, limit: 2 });

    await act(async () => {
      pending.resolve(page([[2], [3]], 3));
      await Promise.all([first, duplicate]);
    });
    expect(state.page?.rows).toEqual([[1], [2], [3]]);
    expect(state.loadingMore).toBe(false);
  });

  it("reruns an expired result and reapplies the requested sort", async () => {
    const state = makeState();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        columns: [],
        rows: [],
        total_rows: 0,
        error: "result expired",
      } satisfies ResultPage)
      .mockResolvedValueOnce(page([[3], [2], [1]], 3));
    const rerunExpired = vi.fn(async () => {
      state.resultId = "rid-2";
      state.page = page([[1]], 3);
      state.sortCol = null;
      state.descending = false;
      return "rid-2";
    });
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
        rerunExpired,
      }),
    );

    await act(async () => {
      await result.current.sortBy(state.id, "n");
    });

    expect(rerunExpired).toHaveBeenCalledWith(state.id, "sort");
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toBe("rid-2");
    expect(fetchPage.mock.calls[1][1]).toMatchObject({
      sort_col: "n",
      descending: false,
    });
    expect(state.resultId).toBe("rid-2");
    expect(state.sortCol).toBe("n");
    expect(state.page?.rows).toEqual([[3], [2], [1]]);
  });

  it("drops a stale load-more response after the view changes", async () => {
    const state = makeState();
    const more = deferred<ResultPage>();
    const sorted = deferred<ResultPage>();
    const fetchPage = vi
      .fn()
      .mockImplementationOnce(() => more.promise)
      .mockImplementationOnce(() => sorted.promise);
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
      }),
    );

    let moreRun!: Promise<void>;
    let sortRun!: Promise<void>;
    act(() => {
      moreRun = result.current.loadMore(state.id);
      sortRun = result.current.sortBy(state.id, "n");
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      sorted.resolve(page([[3], [2], [1]], 3));
      await sortRun;
    });
    await act(async () => {
      more.resolve(page([[2], [3]], 3));
      await moreRun;
    });
    expect(state.page?.rows).toEqual([[3], [2], [1]]);
  });

  it("aborts pending page work on unmount", async () => {
    const state = makeState();
    const pending = deferred<ResultPage>();
    const requestSignals: AbortSignal[] = [];
    const fetchPage = vi.fn(
      (_resultId: string, _options: PageRequestOptions, signal: AbortSignal) => {
        requestSignals.push(signal);
        return pending.promise;
      },
    );
    const { result, unmount } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
      }),
    );

    let run!: Promise<void>;
    act(() => {
      run = result.current.refresh(state.id);
    });
    unmount();
    expect(requestSignals[0]?.aborted).toBe(true);

    pending.resolve(page([[9]], 1));
    await run;
    expect(state.page?.rows).toEqual([[1]]);
  });

  it("cancelPending drops a late page so it cannot repaint after epoch clear", async () => {
    const state = makeState({ page: page([[1]], 3) });
    const pending = deferred<ResultPage>();
    const requestSignals: AbortSignal[] = [];
    const fetchPage = vi.fn(
      (_resultId: string, _options: PageRequestOptions, signal: AbortSignal) => {
        requestSignals.push(signal);
        return pending.promise;
      },
    );
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
      }),
    );

    let run!: Promise<void>;
    act(() => {
      run = result.current.refresh(state.id);
    });
    // Simulate dataEpoch bump: IDE/Journal clear rows + cancelPending.
    act(() => {
      patchState(state, { page: page([], 0) });
      result.current.cancelPending();
    });
    expect(requestSignals[0]?.aborted).toBe(true);

    await act(async () => {
      pending.resolve(page([[99], [100]], 2));
      await run;
    });
    // Late response must not repaint the cleared grid.
    expect(state.page?.rows).toEqual([]);
    expect(state.page?.total_rows).toBe(0);
  });

  it("survives React StrictMode effect replay", async () => {
    const state = makeState();
    const fetchPage = vi.fn(async () => page([[7]], 1));
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () =>
        usePagedResult({
          getItem: () => state,
          patchItem: (_id, patch) => patchState(state, patch),
          fetchPage,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.refresh(state.id);
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(state.page?.rows).toEqual([[7]]);
  });

  it("slides the retained window instead of blocking loadMore (retained-row memory ceiling)", async () => {
    const state = makeState({ page: page([[1], [2]], 10) });
    state.page!.offset = 0;
    const fetchPage = vi.fn(async (_id, opts) => {
      expect(opts.offset).toBe(2);
      return page([[3]], 10);
    });
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
        maxRetainedRows: 2,
      }),
    );

    await act(async () => {
      await result.current.loadMore(state.id);
    });
    expect(fetchPage).toHaveBeenCalled();
    expect(state.page?.rows).toEqual([[2], [3]]);
    expect(state.page?.offset).toBe(1);
  });

  it("passes visibleColumns through page fetches", async () => {
    const state = makeState({
      page: page([[1]], 1),
      visibleColumns: ["id"],
    });
    const fetchPage = vi.fn(async () => page([[1]], 1));
    const { result } = renderHook(() =>
      usePagedResult({
        getItem: () => state,
        patchItem: (_id, patch) => patchState(state, patch),
        fetchPage,
      }),
    );

    await act(async () => {
      await result.current.refresh(state.id);
    });
    expect(fetchPage).toHaveBeenCalledWith(
      state.resultId,
      expect.objectContaining({ columns: ["id"] }),
      expect.any(AbortSignal),
    );
  });
});
