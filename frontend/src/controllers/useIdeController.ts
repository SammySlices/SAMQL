import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { uid } from "../lib/ids";
import { cancelOne } from "../lib/runController";
import type { EdTab } from "./appTypes";

export interface IdeRunState {
  ctrl: AbortController;
  queryId: string;
  startedAt: number;
}

interface UseIdeControllerOptions {
  saved: any;
  sampleSql: string;
  safeTargets: ReadonlySet<string>;
}

/**
 * Owns editor tabs, editor undo/redo, per-tab run state, and SQL execution
 * settings. Query execution itself remains in App until the run pipeline is
 * extracted, but it now consumes one coherent IDE controller.
 */
export function useIdeController({
  saved,
  sampleSql,
  safeTargets,
}: UseIdeControllerOptions) {
  const [edTabs, setEdTabs] = useState<EdTab[]>(() =>
    Array.isArray(saved?.edTabs) && saved.edTabs.length
      ? saved.edTabs.map((tab: any) => ({
          id: typeof tab?.id === "string" ? tab.id : uid(),
          title: typeof tab?.title === "string" ? tab.title : "Query",
          sql: typeof tab?.sql === "string" ? tab.sql : "",
        }))
      : [{ id: uid(), title: "Query 1", sql: sampleSql }],
  );
  const [activeId, setActiveId] = useState(() =>
    typeof saved?.activeId === "string" ? saved.activeId : "",
  );

  useEffect(() => {
    if (edTabs.length && !edTabs.some((tab) => tab.id === activeId))
      setActiveId(edTabs[0].id);
  }, [activeId, edTabs]);

  const activeTab = edTabs.find((tab) => tab.id === activeId) || edTabs[0];
  const edTabsRef = useRef(edTabs);
  edTabsRef.current = edTabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const dragTab = useRef<string | null>(null);

  const [runs, setRuns] = useState<Record<string, IdeRunState>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const runsNow = useCallback(() => runsRef.current, []);
  const running = !!runs[activeTab?.id ?? ""];

  const endRun = useCallback((key: string, ctrl: AbortController) => {
    setRuns((current) => {
      if (current[key]?.ctrl !== ctrl) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const cancelRunning = useCallback(() => {
    const activeRun = runsRef.current[activeIdRef.current || ""];
    if (activeRun) cancelOne(activeRun.queryId, activeRun.ctrl);
  }, []);

  const [queryError, setQueryError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<any>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const [target, setTarget] = useState(() =>
    safeTargets.has(saved?.target) ? saved.target : "auto",
  );
  const [readOnly, setReadOnly] = useState(() => !!saved?.readOnly);
  const [dialect, setDialect] = useState(() =>
    saved?.dialect === "spark" ? "spark" : "native",
  );

  const ideHistory = useRef<
    Record<string, { past: string[]; future: string[]; at: number }>
  >({});
  const [, bumpHistoryVersion] = useState(0);
  const bumpHistory = () => bumpHistoryVersion((version) => version + 1);
  const primaryTabId = useCallback(() => {
    const tabs = edTabsRef.current;
    const id = activeIdRef.current;
    return tabs.some((tab) => tab.id === id) ? id : tabs[0]?.id;
  }, []);

  const setSql = useCallback(
    (value: string) => {
      const tabs = edTabsRef.current;
      const tabId = primaryTabId();
      const current = tabs.find((tab) => tab.id === tabId);
      if (tabId && current && current.sql !== value) {
        const history =
          ideHistory.current[tabId] ||
          (ideHistory.current[tabId] = { past: [], future: [], at: 0 });
        const now = Date.now();
        if (now - history.at > 500 || history.past.length === 0) {
          history.past.push(current.sql);
          if (history.past.length > 200) history.past.shift();
        }
        history.future = [];
        history.at = now;
        bumpHistory();
      }
      setEdTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.id === tabId ? { ...tab, sql: value } : tab,
        ),
      );
    },
    [primaryTabId],
  );

  const undoIde = useCallback(() => {
    const tabId = primaryTabId();
    const history = tabId ? ideHistory.current[tabId] : undefined;
    if (!tabId || !history?.past.length) return;
    const current =
      edTabsRef.current.find((tab) => tab.id === tabId)?.sql ?? "";
    history.future.push(current);
    const previous = history.past.pop() as string;
    setEdTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId ? { ...tab, sql: previous } : tab,
      ),
    );
    bumpHistory();
  }, [primaryTabId]);

  const redoIde = useCallback(() => {
    const tabId = primaryTabId();
    const history = tabId ? ideHistory.current[tabId] : undefined;
    if (!tabId || !history?.future.length) return;
    const current =
      edTabsRef.current.find((tab) => tab.id === tabId)?.sql ?? "";
    history.past.push(current);
    const next = history.future.pop() as string;
    setEdTabs((tabs) =>
      tabs.map((tab) => (tab.id === tabId ? { ...tab, sql: next } : tab)),
    );
    bumpHistory();
  }, [primaryTabId]);

  const currentHistoryId = primaryTabId();
  const canUndoIde = !!(
    currentHistoryId && ideHistory.current[currentHistoryId]?.past.length
  );
  const canRedoIde = !!(
    currentHistoryId && ideHistory.current[currentHistoryId]?.future.length
  );

  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoIde();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redoIde();
      }
    },
    [redoIde, undoIde],
  );

  const newTab = useCallback(() => {
    const nextNumber =
      Math.max(
        0,
        ...edTabsRef.current.map((tab) => {
          const match = /^Query (\d+)$/.exec(tab.title || "");
          return match ? Number.parseInt(match[1], 10) : 0;
        }),
      ) + 1;
    const tab: EdTab = {
      id: uid(),
      title: `Query ${nextNumber}`,
      sql: "",
    };
    setEdTabs((tabs) => [...tabs, tab]);
    setActiveId(tab.id);
  }, []);

  const loadSqlIntoEditor = useCallback(
    (sql: string, preferredTabId?: string): string => {
      const tabs = edTabsRef.current;
      const current =
        (preferredTabId
          ? tabs.find((tab) => tab.id === preferredTabId)
          : undefined) ||
        tabs.find((tab) => tab.id === activeIdRef.current) ||
        tabs[0];
      if (current && !current.sql.trim()) {
        setEdTabs((existing) =>
          existing.map((tab) =>
            tab.id === current.id ? { ...tab, sql } : tab,
          ),
        );
        return current.id;
      }
      const nextNumber =
        Math.max(
          0,
          ...tabs.map((tab) => {
            const match = /^Query (\d+)$/.exec(tab.title || "");
            return match ? Number.parseInt(match[1], 10) : 0;
          }),
        ) + 1;
      const next: EdTab = {
        id: uid(),
        title: `Query ${nextNumber}`,
        sql,
      };
      setEdTabs((existing) => [...existing, next]);
      if (!preferredTabId || activeIdRef.current === preferredTabId) {
        setActiveId(next.id);
      }
      return next.id;
    },
    [],
  );

  const insertText = useCallback((text: string) => {
    setEdTabs((tabs) => {
      const id = activeIdRef.current;
      const tabId = tabs.some((tab) => tab.id === id) ? id : tabs[0]?.id;
      return tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const needsSpace = tab.sql.length > 0 && !/\s$/.test(tab.sql);
        return {
          ...tab,
          sql: tab.sql + (needsSpace ? " " : "") + text,
        };
      });
    });
  }, []);

  const titleForTab = useCallback(
    (id: string) =>
      edTabsRef.current.find((tab) => tab.id === id)?.title || "Result",
    [],
  );

  const [runFlash, setRunFlash] = useState(false);
  const flashRun = useCallback(() => {
    setRunFlash(true);
    window.setTimeout(() => setRunFlash(false), 600);
  }, []);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabUl, setTabUl] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const container = tabsRef.current;
    const active = container?.querySelector(".tab.active") as HTMLElement | null;
    if (active)
      setTabUl({ left: active.offsetLeft, width: active.offsetWidth });
  }, [activeId, edTabs]);

  return {
    edTabs,
    setEdTabs,
    activeId,
    setActiveId,
    activeTab,
    edTabsRef,
    activeIdRef,
    dragTab,
    runs,
    setRuns,
    runsRef,
    runsNow,
    running,
    endRun,
    cancelRunning,
    queryError,
    setQueryError,
    conflict,
    setConflict,
    okMessage,
    setOkMessage,
    target,
    setTarget,
    readOnly,
    setReadOnly,
    dialect,
    setDialect,
    setSql,
    undoIde,
    redoIde,
    canUndoIde,
    canRedoIde,
    onEditorKeyDown,
    newTab,
    loadSqlIntoEditor,
    insertText,
    titleForTab,
    runFlash,
    flashRun,
    tabsRef,
    tabUl,
  };
}
