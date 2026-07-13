import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ColumnFilter, ResultPage } from "./types";

export type PagedResultOperation =
  | "sort"
  | "filter"
  | "loadMore"
  | "refresh";

export interface PagedResultSnapshot {
  id: string;
  resultId?: string | null;
  page?: ResultPage | null;
  sortCol?: string | null;
  descending?: boolean;
  filters?: ColumnFilter[];
  queryId?: string;
  loadingMore?: boolean;
  released?: boolean;
}

export interface PagedResultPatch {
  page?: ResultPage | null;
  sortCol?: string | null;
  descending?: boolean;
  filters?: ColumnFilter[];
  loadingMore?: boolean;
  released?: boolean;
}

export interface PageRequestOptions {
  offset?: number;
  limit?: number;
  sort_col?: string | null;
  descending?: boolean;
  filters?: ColumnFilter[];
  query_id?: string;
}

interface PagedView {
  resultId: string;
  sortCol: string | null;
  descending: boolean;
  filters: ColumnFilter[];
}

interface UsePagedResultOptions<T extends PagedResultSnapshot> {
  getItem: (id: string) => T | undefined;
  patchItem: (id: string, patch: PagedResultPatch) => void;
  fetchPage: (
    resultId: string,
    options: PageRequestOptions,
    signal: AbortSignal,
  ) => Promise<ResultPage>;
  rerunExpired?: (
    id: string,
    operation: PagedResultOperation,
  ) => Promise<string | null | undefined>;
  onError?: (operation: PagedResultOperation, message: string) => void;
  pageSize?: number;
  maxRetainedRows?: number;
}

export interface PagedResultController {
  sortBy: (id: string, column: string) => Promise<void>;
  applyFilters: (id: string, filters: ColumnFilter[]) => Promise<void>;
  clearFilters: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
  loadMore: (id: string) => Promise<void>;
  cancelPending: (id?: string) => void;
}

const DEFAULT_PAGE_SIZE = 1000;
const EXPIRED_ERROR = "result expired";

function copyFilters(filters: ColumnFilter[] | undefined): ColumnFilter[] {
  return (filters || []).map((filter) => ({ ...filter }));
}

function sameFilters(a: ColumnFilter[], b: ColumnFilter[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((filter, index) => {
    const other = b[index];
    return (
      filter.column === other.column &&
      filter.op === other.op &&
      filter.value === other.value
    );
  });
}

function sameView(a: PagedView, b: PagedView): boolean {
  return (
    a.resultId === b.resultId &&
    a.sortCol === b.sortCol &&
    a.descending === b.descending &&
    sameFilters(a.filters, b.filters)
  );
}

function requestOptions(
  item: PagedResultSnapshot,
  view: PagedView,
  offset: number,
  limit: number,
): PageRequestOptions {
  return {
    offset,
    limit,
    sort_col: view.sortCol ?? undefined,
    descending: view.descending,
    filters: view.filters.length ? copyFilters(view.filters) : undefined,
    query_id: item.queryId,
  };
}

/**
 * Shared result paging state machine for the IDE and Journal.
 *
 * It owns request cancellation, latest-request-wins sequencing, duplicate-page
 * prevention, result-expiry recovery, and synchronous view snapshots so a
 * rapid filter/sort sequence cannot accidentally issue the second request with
 * the first request's stale React state.
 */
export function usePagedResult<T extends PagedResultSnapshot>(
  options: UsePagedResultOptions<T>,
): PagedResultController {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const generations = useRef<Map<string, number>>(new Map());
  const controllers = useRef<Map<string, Set<AbortController>>>(new Map());
  const loadingMore = useRef<Set<string>>(new Set());
  const views = useRef<Map<string, PagedView>>(new Map());
  const mounted = useRef(true);

  const generationOf = useCallback(
    (id: string) => generations.current.get(id) || 0,
    [],
  );

  const abortFor = useCallback((id: string) => {
    const set = controllers.current.get(id);
    if (set) {
      for (const controller of set) controller.abort();
      controllers.current.delete(id);
    }
  }, []);

  const invalidate = useCallback(
    (id: string): number => {
      abortFor(id);
      const next = generationOf(id) + 1;
      generations.current.set(id, next);
      loadingMore.current.delete(id);
      optionsRef.current.patchItem(id, { loadingMore: false });
      return next;
    },
    [abortFor, generationOf],
  );

  const registerController = useCallback((id: string) => {
    const controller = new AbortController();
    const set = controllers.current.get(id) || new Set<AbortController>();
    set.add(controller);
    controllers.current.set(id, set);
    return controller;
  }, []);

  const unregisterController = useCallback(
    (id: string, controller: AbortController) => {
      const set = controllers.current.get(id);
      if (!set) return;
      set.delete(controller);
      if (set.size === 0) controllers.current.delete(id);
    },
    [],
  );

  const currentView = useCallback((item: T): PagedView | null => {
    if (!item.resultId) return null;
    const remembered = views.current.get(item.id);
    if (remembered?.resultId === item.resultId) return remembered;
    const view: PagedView = {
      resultId: item.resultId,
      sortCol: item.sortCol ?? null,
      descending: !!item.descending,
      filters: copyFilters(item.filters),
    };
    views.current.set(item.id, view);
    return view;
  }, []);

  const rememberView = useCallback(
    (id: string, view: PagedView, patch: PagedResultPatch) => {
      views.current.set(id, {
        ...view,
        filters: copyFilters(view.filters),
      });
      optionsRef.current.patchItem(id, patch);
    },
    [],
  );

  const isCurrent = useCallback(
    (id: string, generation: number, expected: PagedView): boolean => {
      if (!mounted.current || generationOf(id) !== generation) return false;
      const item = optionsRef.current.getItem(id);
      if (!item?.resultId || item.resultId !== expected.resultId) return false;
      const actual = currentView(item);
      return !!actual && sameView(actual, expected);
    },
    [currentView, generationOf],
  );

  const fetchReplacement = useCallback(
    async (
      id: string,
      operation: PagedResultOperation,
      desired: PagedView,
      allowRerun: boolean,
    ): Promise<void> => {
      const opts = optionsRef.current;
      const generation = invalidate(id);
      const item = opts.getItem(id);
      if (!item?.resultId) return;

      const expected: PagedView = {
        ...desired,
        resultId: item.resultId,
        filters: copyFilters(desired.filters),
      };
      views.current.set(id, expected);

      const controller = registerController(id);
      try {
        const page = await opts.fetchPage(
          expected.resultId,
          requestOptions(item, expected, 0, opts.pageSize || DEFAULT_PAGE_SIZE),
          controller.signal,
        );
        if (!isCurrent(id, generation, expected)) return;

        if (page.error === EXPIRED_ERROR && allowRerun && opts.rerunExpired) {
          const freshResultId = await opts.rerunExpired(id, operation);
          if (!freshResultId || generationOf(id) !== generation) return;
          const freshItem = opts.getItem(id);
          if (!freshItem) return;
          const retried: PagedView = {
            ...expected,
            resultId: freshResultId,
            filters: copyFilters(expected.filters),
          };
          views.current.set(id, retried);
          const retryController = registerController(id);
          try {
            const retryPage = await opts.fetchPage(
              freshResultId,
              requestOptions(
                { ...freshItem, resultId: freshResultId },
                retried,
                0,
                opts.pageSize || DEFAULT_PAGE_SIZE,
              ),
              retryController.signal,
            );
            if (generationOf(id) !== generation || retryController.signal.aborted)
              return;
            if (retryPage.error) {
              opts.onError?.(operation, retryPage.error);
              return;
            }
            opts.patchItem(id, {
              page: retryPage,
              sortCol: retried.sortCol,
              descending: retried.descending,
              filters: copyFilters(retried.filters),
              loadingMore: false,
              released: false,
            });
          } finally {
            unregisterController(id, retryController);
          }
          return;
        }

        if (page.error) {
          opts.onError?.(operation, page.error);
          return;
        }
        opts.patchItem(id, {
          page,
          sortCol: expected.sortCol,
          descending: expected.descending,
          filters: copyFilters(expected.filters),
          loadingMore: false,
          released: false,
        });
      } catch (error) {
        if (!controller.signal.aborted && generationOf(id) === generation) {
          const message = error instanceof Error ? error.message : String(error);
          opts.onError?.(operation, message);
        }
      } finally {
        unregisterController(id, controller);
      }
    },
    [generationOf, invalidate, isCurrent, registerController, unregisterController],
  );

  const sortBy = useCallback(
    async (id: string, column: string) => {
      const item = optionsRef.current.getItem(id);
      if (!item?.resultId) return;
      const base = currentView(item);
      if (!base) return;
      const desired: PagedView = {
        ...base,
        sortCol: column,
        descending: base.sortCol === column ? !base.descending : false,
      };
      rememberView(id, desired, {
        sortCol: desired.sortCol,
        descending: desired.descending,
      });
      await fetchReplacement(id, "sort", desired, true);
    },
    [currentView, fetchReplacement, rememberView],
  );

  const applyFilters = useCallback(
    async (id: string, filters: ColumnFilter[]) => {
      const item = optionsRef.current.getItem(id);
      if (!item?.resultId) return;
      const base = currentView(item);
      if (!base) return;
      const desired: PagedView = {
        ...base,
        filters: copyFilters(filters),
      };
      rememberView(id, desired, { filters: copyFilters(filters) });
      await fetchReplacement(id, "filter", desired, true);
    },
    [currentView, fetchReplacement, rememberView],
  );

  const clearFilters = useCallback(
    async (id: string) => applyFilters(id, []),
    [applyFilters],
  );

  const refresh = useCallback(
    async (id: string) => {
      const item = optionsRef.current.getItem(id);
      if (!item?.resultId) return;
      const desired = currentView(item);
      if (!desired) return;
      await fetchReplacement(id, "refresh", desired, true);
    },
    [currentView, fetchReplacement],
  );

  const loadMoreRows = useCallback(
    async (id: string) => {
      const opts = optionsRef.current;
      const item = opts.getItem(id);
      if (!item?.resultId || !item.page) return;
      const have = item.page.rows?.length || 0;
      const total = item.page.total_rows || 0;
      if (have >= total) return;
      if (opts.maxRetainedRows != null && have >= opts.maxRetainedRows) return;
      if (loadingMore.current.has(id)) return;

      const view = currentView(item);
      if (!view) return;
      const generation = generationOf(id);
      loadingMore.current.add(id);
      opts.patchItem(id, { loadingMore: true });
      const controller = registerController(id);
      try {
        const page = await opts.fetchPage(
          item.resultId,
          requestOptions(
            item,
            view,
            have,
            opts.pageSize || DEFAULT_PAGE_SIZE,
          ),
          controller.signal,
        );
        if (!isCurrent(id, generation, view)) return;

        if (page.error === EXPIRED_ERROR && opts.rerunExpired) {
          await opts.rerunExpired(id, "loadMore");
          return;
        }
        if (page.error) {
          opts.onError?.("loadMore", page.error);
          return;
        }

        const latest = opts.getItem(id);
        if (!latest?.page || latest.resultId !== item.resultId) return;
        if ((latest.page.rows?.length || 0) !== have) return;
        const latestView = currentView(latest);
        if (!latestView || !sameView(latestView, view)) return;

        const room =
          opts.maxRetainedRows == null
            ? page.rows.length
            : Math.max(0, opts.maxRetainedRows - have);
        const rows = page.rows.slice(0, room);
        opts.patchItem(id, {
          loadingMore: false,
          page: {
            ...latest.page,
            ...page,
            rows: [...(latest.page.rows || []), ...rows],
            total_rows: page.total_rows ?? latest.page.total_rows,
          },
        });
      } catch (error) {
        if (!controller.signal.aborted && generationOf(id) === generation) {
          const message = error instanceof Error ? error.message : String(error);
          opts.onError?.("loadMore", message);
        }
      } finally {
        unregisterController(id, controller);
        loadingMore.current.delete(id);
        if (mounted.current) opts.patchItem(id, { loadingMore: false });
      }
    },
    [currentView, generationOf, isCurrent, registerController, unregisterController],
  );

  const cancelPending = useCallback(
    (id?: string) => {
      if (id) {
        invalidate(id);
        return;
      }
      const ids = new Set<string>([
        ...generations.current.keys(),
        ...controllers.current.keys(),
        ...loadingMore.current.keys(),
      ]);
      for (const itemId of ids) invalidate(itemId);
    },
    [invalidate],
  );

  useEffect(() => {
    // React StrictMode intentionally runs setup -> cleanup -> setup in
    // development. Re-arm the instance on each setup so the simulated cleanup
    // cannot leave every later response permanently classified as stale.
    mounted.current = true;
    const controllerMap = controllers.current;
    const loadingSet = loadingMore.current;
    const viewMap = views.current;
    return () => {
      mounted.current = false;
      for (const set of controllerMap.values()) {
        for (const controller of set) controller.abort();
      }
      controllerMap.clear();
      loadingSet.clear();
      viewMap.clear();
    };
  }, []);

  return useMemo(
    () => ({
      sortBy,
      applyFilters,
      clearFilters,
      refresh,
      loadMore: loadMoreRows,
      cancelPending,
    }),
    [
      applyFilters,
      cancelPending,
      clearFilters,
      loadMoreRows,
      refresh,
      sortBy,
    ],
  );
}
