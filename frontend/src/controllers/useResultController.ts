import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ColumnFilter, FilterOp } from "../lib/types";
import {
  addFloat,
  bringToFront,
  maxZ,
  pruneCompare,
  removeFloat,
  type CompareState,
  type FloatPanel,
  type FloatView,
  type Rect,
} from "../lib/docking";
import {
  usePagedResult,
  type PagedResultOperation,
} from "../lib/usePagedResult";
import type { ResultTab, ToastFn } from "./appTypes";

export interface ResultMenuState {
  id: string;
  x: number;
  y: number;
}

export interface ColumnMenuState {
  col: string;
  x: number;
  y: number;
}

/**
 * Owns result-tab identity, paging, detached panels, compare state, and result
 * menus. Domain actions (run/profile/export/reconcile) remain in App, but they
 * now operate through one stable result-workspace controller.
 */
export function useResultController(toast: ToastFn, pageSize: number) {
  const [resTabs, setResTabs] = useState<ResultTab[]>([]);
  const [activeResId, setActiveResId] = useState<string | null>(null);
  const [resMenu, setResMenu] = useState<ResultMenuState | null>(null);
  const [colMenu, setColMenu] = useState<ColumnMenuState | null>(null);
  const [filterDraft, setFilterDraft] = useState<{
    op: FilterOp;
    value: string;
  }>({ op: "contains", value: "" });

  const resTabsRef = useRef(resTabs);
  resTabsRef.current = resTabs;
  const activeResIdRef = useRef(activeResId);
  activeResIdRef.current = activeResId;
  const dragRes = useRef<string | null>(null);

  const activeRes = resTabs.find((result) => result.id === activeResId) || null;
  const activeResultTab =
    activeRes?.kind === "result" ? activeRes : null;

  const patchRes = (id: string, patch: Partial<ResultTab>) =>
    setResTabs((results) =>
      results.map((result) =>
        result.id === id ? { ...result, ...patch } : result,
      ),
    );

  const [floats, setFloats] = useState<FloatPanel[]>([]);
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [dockHot, setDockHot] = useState(false);
  const resultPaneRef = useRef<HTMLDivElement | null>(null);

  const dockRect = (): Rect | null => {
    const element = resultPaneRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const floatView = (resId: string, view: FloatView) => {
    setActiveResId(resId);
    setFloats((current) =>
      addFloat(
        current,
        resId,
        view,
        { width: window.innerWidth, height: window.innerHeight },
        maxZ(current),
      ),
    );
  };

  const dockFloat = (id: string) => {
    setDockHot(false);
    setFloats((current) => removeFloat(current, id));
  };

  const focusFloat = (id: string) =>
    setFloats((current) => bringToFront(current, id, maxZ(current)));

  useEffect(() => {
    const resultIds = resTabs.map((result) => result.id);
    setFloats((current) =>
      current.filter((panel) => resultIds.includes(panel.resId)),
    );
    setCompare((current) => pruneCompare(current, resultIds));
  }, [resTabs]);

  const rerunExpiredResultRef = useRef<
    (id: string, operation: PagedResultOperation) => Promise<string | null>
  >(async () => null);

  const resultPaging = usePagedResult<ResultTab>({
    getItem: (id) => resTabsRef.current.find((tab) => tab.id === id),
    patchItem: (id, pagingPatch) =>
      patchRes(id, pagingPatch as Partial<ResultTab>),
    fetchPage: (resultId, pageOptions, signal) =>
      api.page(resultId, pageOptions, signal),
    rerunExpired: (id, operation) =>
      rerunExpiredResultRef.current(id, operation),
    onError: (operation, message) => {
      const title =
        operation === "sort"
          ? "Sort failed"
          : operation === "filter"
            ? "Filter failed"
            : operation === "loadMore"
              ? "Load more failed"
              : "Result refresh failed";
      toast("error", title, message);
    },
    pageSize,
    // Match Journal: keep scrolling from retaining every row forever.
    maxRetainedRows: 50000,
  });

  // Release inactive result rows to keep browser memory bounded. Metadata,
  // sort, and filters remain, so reactivation uses the shared paging rail.
  useEffect(() => {
    const activeId = activeResId;
    const current = resTabsRef.current;
    if (
      current.some(
        (result) =>
          result.kind === "result" &&
          result.id !== activeId &&
          !result.released &&
          !!result.page &&
          (result.page.rows?.length ?? 0) > 0,
      )
    ) {
      setResTabs((previous) =>
        previous.map((result) =>
          result.kind === "result" &&
          result.id !== activeId &&
          !result.released &&
          result.page &&
          (result.page.rows?.length ?? 0) > 0
            ? {
                ...result,
                page: { ...result.page, rows: [] },
                released: true,
              }
            : result,
        ),
      );
    }
    const activeTab = current.find(
      (result) => result.id === activeId && result.kind === "result",
    );
    if (activeTab?.released && activeTab.resultId)
      void resultPaging.refresh(activeTab.id);
  }, [activeResId, resultPaging]);

  return {
    resTabs,
    setResTabs,
    activeResId,
    setActiveResId,
    activeRes,
    activeResultTab,
    resTabsRef,
    activeResIdRef,
    dragRes,
    patchRes,
    resMenu,
    setResMenu,
    colMenu,
    setColMenu,
    filterDraft,
    setFilterDraft,
    floats,
    setFloats,
    compare,
    setCompare,
    dockHot,
    setDockHot,
    resultPaneRef,
    dockRect,
    floatView,
    dockFloat,
    focusFloat,
    resultPaging,
    rerunExpiredResultRef,
  };
}
