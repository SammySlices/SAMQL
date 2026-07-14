import React, { useEffect, useMemo, useState } from "react";
import type {
  TableInfo,
  ColumnInfo,
  HistoryEntry,
  SavedQuery,
  WorkflowSummary,
  WorkflowKind,
  EngineKind,
} from "../lib/types";
import { api } from "../lib/api";
import { Icon } from "./Icon";
import {
  familyJoinKeys,
  familyJoinSql,
  groupRelationalFamilies,
} from "../lib/notebook";
import { useRenderCount } from "../lib/renderDebug";
import { menuPos } from "../lib/menuPos";
import { quoteSqlIdent } from "../lib/sql";
import {
  addWorkflowGroup,
  deleteWorkflowGroup,
  groupedNames,
  groupsForKind,
  loadWorkflowGroups,
  moveWorkflowToGroup,
  renameWorkflowGroup,
  saveWorkflowGroups,
  toggleWorkflowGroupCollapsed,
} from "../lib/workflowGroups";

type Tab = "tables" | "history" | "saved";

// Pull the first concrete example expression out of a column query-hint string
// (e.g. "list of records — one element: json[1].field · all rows: UNNEST(json)"
// -> "json[1].field") so clicking the hint badge inserts a ready-to-edit example.
function exampleFor(name: string, hint?: string): string {
  if (!hint) return name;
  const afterColon = hint.split(": ")[1];
  const first = (afterColon || "").split(" · ")[0].trim();
  return first || name;
}

// A compact label for a (possibly enormous) nested column type, so the tree row
// shows "list of records" instead of a screen-filling STRUCT(...) string. The
// full shape is available by expanding the column.
function shortType(type?: string): string {
  const t = (type || "").trim();
  if (!t) return "?";
  const tu = t.toUpperCase();
  const isList = tu.endsWith("[]");
  const base = (isList ? tu.slice(0, -2) : tu).trim();
  if (base.startsWith("STRUCT")) return isList ? "list of records" : "record";
  if (base.startsWith("MAP")) return "map";
  if (base === "JSON") return "json";
  if (isList) return "list";
  return t.length > 22 ? t.slice(0, 22) + "…" : t;
}

const KIND_COLOR: Record<string, string> = {
  array: "#c98a2b",
  "array-scalar": "#c98a2b",
  struct: "#5b8def",
  map: "#8a6ad6",
  scalar: "",
};

interface Props {
  tables: TableInfo[];
  history: HistoryEntry[];
  saved: SavedQuery[];
  workflows: WorkflowSummary[];
  onInsertTable: (name: string) => void;
  onTableProps?: (engine: string, name: string) => void;
  onInsertColumn: (col: string) => void;
  onLoadSql: (sql: string) => void;
  onProfile: (table: string, engine: EngineKind) => void;
  onReconcile: (table: string, engine: EngineKind) => void;
  onChangeType: (
    engine: EngineKind,
    table: string,
    col: string,
    newType: string,
  ) => void;
  onRename: (engine: EngineKind, oldName: string) => void;
  onDrop: (engine: EngineKind, name: string) => void;
  onDropMany: (items: { engine: EngineKind; name: string }[]) => void;
  onOptimize: (name: string) => void;
  onImport: (name: string) => void;
  onDisconnect: (conn: string) => void;
  onDeleteSaved: (name: string) => void;
  onLoadWorkflow: (kind: WorkflowKind, name: string) => void;
  onDeleteWorkflow: (kind: WorkflowKind, name: string) => void;
  onActiveSave: () => void;
  onActiveSaveAs: () => void;
  onActiveOpen: () => void;
  activeView: "ide" | "notebook" | "nodeflow" | "dashboard";
  onRefresh: () => void;
  onClearHistory: () => void;
  onOpenLoad: () => void;
}

const engineClass = (e: EngineKind) =>
  e === "duckdb" ? "duckdb" : e === "remote" ? "remote" : "sqlite";

const SidebarImpl: React.FC<Props> = (props) => {
  useRenderCount("Sidebar");
  const [tab, setTab] = useState<Tab>("tables");
  const [q, setQ] = useState("");

  return (
    <>
      <div className="side-tabs">
        <button
          className={"side-tab" + (tab === "tables" ? " active" : "")}
          onClick={() => setTab("tables")}
        >
          Tables{" "}
          {(() => {
            const n = props.tables.filter(
              (t) => !t.name.startsWith("__"),
            ).length;
            return n ? `(${n})` : "";
          })()}
        </button>
        <button
          className={"side-tab" + (tab === "history" ? " active" : "")}
          onClick={() => setTab("history")}
        >
          History
        </button>
        <button
          className={"side-tab" + (tab === "saved" ? " active" : "")}
          onClick={() => setTab("saved")}
        >
          Workflows
        </button>
      </div>

      {tab === "tables" && (
        <TablesTree {...props} q={q} setQ={setQ} />
      )}
      {tab === "history" && <HistoryPanel {...props} />}
      {tab === "saved" && <WorkflowsPanel {...props} />}
    </>
  );
};

const TablesTree: React.FC<
  Props & { q: string; setQ: (s: string) => void }
> = ({
  tables,
  q,
  setQ,
  onInsertTable,
  onTableProps,
  onLoadSql,
  onInsertColumn,
  onProfile,
  onReconcile,
  onChangeType,
  onRename,
  onDrop,
  onDropMany,
  onOptimize,
  onImport,
  onDisconnect,
  onRefresh,
  onOpenLoad,
}) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Remote (catalog) columns are not in the tables payload; fetch them the
  // first time a remote table is expanded, and cache by table name.
  const [colsCache, setColsCache] = useState<Record<string, ColumnInfo[]>>({});
  const [colsBusy, setColsBusy] = useState<Record<string, boolean>>({});
  const loadRemoteCols = (name: string) => {
    if (colsCache[name] || colsBusy[name]) return;
    setColsBusy((p) => ({ ...p, [name]: true }));
    api
      .catalogColumns(name)
      .then((r) =>
        setColsCache((p) => ({ ...p, [name]: r.columns || [] })),
      )
      .catch(() => setColsCache((p) => ({ ...p, [name]: [] })))
      .finally(() => setColsBusy((p) => ({ ...p, [name]: false })));
  };
  // Lazily-fetched nested-field tree for a nested column (STRUCT/LIST/MAP), so
  // a huge schema only parses/renders when the user expands that column.
  type FieldRow = {
    depth: number;
    name: string;
    type: string;
    kind: string;
    path?: string | null;
    note?: string | null;
  };
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set());
  const [colFields, setColFields] = useState<Record<string, FieldRow[]>>({});
  const [colFieldsBusy, setColFieldsBusy] = useState<Set<string>>(new Set());
  // Nested field-tree collapse. Real struct/list FIELDS default COLLAPSED (so a
  // freshly-expanded column shows a compact top level, not a wall of nested
  // fields); the transparent "(element)" list-wrapper defaults OPEN so you're
  // not left staring at a single useless row. Both are still togglable. Ignored
  // while filtering so a search match is never hidden.
  const [openFields, setOpenFields] = useState<Set<string>>(new Set());
  const [closedEls, setClosedEls] = useState<Set<string>>(new Set());
  const colKey = (engine: string, table: string, col: string) =>
    `${engine}\u0000${table}\u0000${col}`;
  const fetchColFields = (
    key: string,
    engine: string,
    table: string,
    col: string,
  ) => {
    if (colFields[key] || colFieldsBusy.has(key)) return;
    setColFieldsBusy((p) => new Set(p).add(key));
    api
      .columnFields(engine, table, col)
      .then((r) => setColFields((p) => ({ ...p, [key]: r.fields || [] })))
      .catch(() => setColFields((p) => ({ ...p, [key]: [] })))
      .finally(() =>
        setColFieldsBusy((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        }),
      );
  };
  const toggleColFields = (engine: string, table: string, col: string) => {
    const key = colKey(engine, table, col);
    setExpandedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    fetchColFields(key, engine, table, col);
  };
  // Idempotent open (never collapses) -- used by field search to reveal the
  // tree of a column whose nested field matches the filter.
  const openColFields = (engine: string, table: string, col: string) => {
    const key = colKey(engine, table, col);
    setExpandedCols((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    fetchColFields(key, engine, table, col);
  };
  const toggleFieldNode = (nodeId: string, isEl: boolean) => {
    const flip = (s: Set<string>) => {
      const n = new Set(s);
      if (n.has(nodeId)) n.delete(nodeId);
      else n.add(nodeId);
      return n;
    };
    if (isEl) setClosedEls(flip);
    else setOpenFields(flip);
  };
  const GROUP_STORE = "samql.sidebar.groups.v1";
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(GROUP_STORE) || "{}");
    } catch {
      return {};
    }
  });
  const toggleGroupOpen = (g: string) =>
    setGroupOpen((p) => {
      const next = { ...p, [g]: !(p[g] ?? false) };
      try {
        localStorage.setItem(GROUP_STORE, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  const [menu, setMenu] = useState<{ x: number; y: number; t: TableInfo } | null>(
    null,
  );
  // Multi-select for bulk delete: a set of "engine:name" keys, plus helpers to
  // toggle, clear, and drop the selected local tables in one action.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selKey = (t: TableInfo) => t.engine + ":" + t.name;
  const toggleSel = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clearSel = () => setSelected(new Set());
  // .514: one click to arm a full cleanup -- select every LOCAL table
  // (remote catalogs can't be dropped from here), then Delete takes all.
  const selectAll = () =>
    setSelected(
      new Set(tables.filter((t) => !t.remote).map((t) => selKey(t))),
    );
  const deleteSelected = () => {
    const items = tables
      .filter((t) => !t.remote && selected.has(selKey(t)))
      .map((t) => ({ engine: t.engine, name: t.name }));
    if (items.length) onDropMany(items);
    clearSel();
  };
  const [grpMenu, setGrpMenu] = useState<{
    x: number;
    y: number;
    conn: string;
    name: string;
  } | null>(null);
  const [colMenu, setColMenu] = useState<{
    x: number;
    y: number;
    engine: EngineKind;
    table: string;
    col: string;
    type: string;
  } | null>(null);
  // a file-backed DuckDB view we can re-store as columnar Parquet (CSV/JSON
  // re-parse on every scan; Parquet gets column + row-group pushdown). Already
  // Parquet and non-file tables don't match, and the backend re-checks.
  const isConvertible = (t: TableInfo) =>
    t.engine === "duckdb" &&
    /\.(csv|tsv|txt|json|ndjson|jsonl)$/i.test(t.source || "");
  const filtered = useMemo(() => {
    // Hide notebook materialisation tables (reconcile cells stage their inputs
    // as "__nb_*" tables); they are an implementation detail, not user data.
    const visible = tables.filter((t) => !t.name.startsWith("__"));
    const needle = q.trim().toLowerCase();
    if (!needle) return visible;
    // Match the table name, any column name, the source, or any column's TYPE
    // string. The source match lets SQL Server imports be found by their
    // server/connection ("mssql:<server>") even when the table was given a
    // generic name, and lets file tables be found by path. The type-string
    // match finds a table by a NESTED field it contains: the full STRUCT(...)
    // type carries every nested field name, so "strikePrice" surfaces the table
    // even though that field is buried inside the json column.
    return visible.filter((t) => {
      if (t.name.toLowerCase().includes(needle)) return true;
      if ((t.source || "").toLowerCase().includes(needle)) return true;
      return (t.columns || []).some(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          (c.type || "").toLowerCase().includes(needle),
      );
    });
  }, [tables, q]);

  // local tables stay a flat list; remote (SQL Server catalog) tables roll up
  // under collapsible groups keyed by their database, so thousands of them
  // don't all render at once.
  const { locals, groups } = useMemo(() => {
    const locals: TableInfo[] = [];
    const groups = new Map<string, TableInfo[]>();
    for (const t of filtered) {
      if (t.remote) {
        const g = t.group || t.database || "SQL Server";
        const arr = groups.get(g);
        if (arr) arr.push(t);
        else groups.set(g, [t]);
      } else {
        locals.push(t);
      }
    }
    return { locals, groups };
  }, [filtered]);
  const filtering = q.trim().length > 0;
  // Field search: when the filter matches a NESTED field name (which lives in a
  // column's type string, not its own name), auto-open that column's field tree
  // so the match is actually visible instead of buried under a collapsed column.
  useEffect(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return;
    for (const t of filtered) {
      if (t.remote) continue;
      for (const c of t.columns || []) {
        if (!c.hint) continue; // nested columns only
        const nameHit = c.name.toLowerCase().includes(needle);
        const typeHit = (c.type || "").toLowerCase().includes(needle);
        if (typeHit && !nameHit) openColFields(t.engine, t.name, c.name);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filtered]);

  // relational families (shred output): children grouped under their root
  const [famOpen, setFamOpen] = useState<Record<string, boolean>>({});
  const families = useMemo(
    () => groupRelationalFamilies(locals as any) as unknown as {
      table: TableInfo;
      children: TableInfo[];
    }[],
    [locals],
  );
  const parentOf = useMemo(() => {
    const m = new Map<string, TableInfo>();
    for (const f of families)
      for (const c of f.children) m.set(c.engine + ":" + c.name, f.table);
    return m;
  }, [families]);

  // .460: the refresh icon spins exactly once per click.
  const [refreshSpin, setRefreshSpin] = React.useState(false);
  const spinTimer = React.useRef<number | null>(null);
  const fireRefreshSpin = () => {
    if (spinTimer.current != null) window.clearTimeout(spinTimer.current);
    setRefreshSpin(false);
    requestAnimationFrame(() => setRefreshSpin(true));
    spinTimer.current = window.setTimeout(() => {
      setRefreshSpin(false);
      spinTimer.current = null;
    }, 600);
  };
  React.useEffect(
    () => () => {
      if (spinTimer.current != null)
        window.clearTimeout(spinTimer.current);
    },
    [],
  );

  // .459: tables that just APPEARED flash once in the tree so a load
  // orients you. Diff against the previous name set; hold the fresh
  // marks ~2.2s (matching the CSS), then clear (timeout cleaned up).
  const prevNamesRef = React.useRef<Set<string> | null>(null);
  const [freshNames, setFreshNames] = React.useState<Set<string>>(
    () => new Set(),
  );
  const freshTimer = React.useRef<number | null>(null);
  React.useEffect(() => {
    const now = new Set(tables.map((t) => t.engine + ":" + t.name));
    const prev = prevNamesRef.current;
    prevNamesRef.current = now;
    if (!prev) return; // first paint: nothing is "new"
    const added = new Set([...now].filter((k) => !prev.has(k)));
    if (!added.size) return;
    setFreshNames(added);
    if (freshTimer.current != null)
      window.clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => {
      setFreshNames(new Set());
      freshTimer.current = null;
    }, 2300);
  }, [tables]);
  React.useEffect(
    () => () => {
      if (freshTimer.current != null)
        window.clearTimeout(freshTimer.current);
    },
    [],
  );

  const renderRow = (t: TableInfo, famParent?: TableInfo) => {
    const isOpen = open[t.engine + ":" + t.name];
    return (
      <div key={t.engine + ":" + t.name}>
        <div
          className={
            "tree-row" +
            (freshNames.has(t.engine + ":" + t.name) ? " fresh" : "")
          }
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, t });
          }}
        >
          {!t.remote && (
            <input
              type="checkbox"
              checked={selected.has(selKey(t))}
              onChange={() => toggleSel(selKey(t))}
              onClick={(e) => e.stopPropagation()}
              title="Select for bulk delete"
              style={{ margin: "0 2px 0 0", cursor: "pointer", flex: "0 0 auto" }}
            />
          )}
          <span
            className={"twist" + (isOpen ? " open" : "")}
            onClick={() => {
              if (!isOpen && t.remote) loadRemoteCols(t.name);
              setOpen((p) => ({
                ...p,
                [t.engine + ":" + t.name]: !isOpen,
              }));
            }}
          >
            <Icon.Chevron size={13} />
          </span>
          <span
            className={"chip " + engineClass(t.engine)}
            style={{ padding: "1px 6px" }}
            title={t.engine}
          >
            <span className="dot" />
          </span>
          <span
            className="tname"
            title={
              t.remote
                ? `${t.name}\nSQL Server table — query it in the editor (runs on the server)`
                : `${t.name}\nClick to insert into editor`
            }
            onClick={() => onInsertTable(quoteSqlIdent(t.name))}
            style={{ cursor: "pointer" }}
          >
            {t.name}
          </span>
          {famParent && onLoadSql && (
            <span
              className="join-btn"
              title={
                "Insert a join to " + famParent.name + " — USING(" +
                familyJoinKeys(famParent as any, t as any).join(", ") + ")"
              }
              onClick={(e) => {
                e.stopPropagation();
                onLoadSql(familyJoinSql(famParent as any, t as any));
              }}
            >
              ⋈
            </span>
          )}
          {t.row_count != null ? (
            <span className="rc">{t.row_count.toLocaleString()}</span>
          ) : t.remote ? (
            <span
              className="rc remote-tag"
              title={
                "No data loaded — runs on SQL Server when queried" +
                (t.col_count ? ` · ${t.col_count} columns` : "")
              }
            >
              schema only
            </span>
          ) : null}
          {!t.remote && (
            <span className="row-actions">
              <button
                className="btn ghost icon"
                title="Profile"
                onClick={() => onProfile(t.name, t.engine)}
              >
                <Icon.Info size={14} />
              </button>
              <button
                className="btn ghost icon"
                title="Rename"
                onClick={() => onRename(t.engine, t.name)}
              >
                <Icon.Edit size={14} />
              </button>
              <button
                className="btn ghost icon danger"
                title="Drop"
                onClick={() => onDrop(t.engine, t.name)}
              >
                <span className="icon-trash"><Icon.Trash size={14} /></span>
              </button>
            </span>
          )}
        </div>
        {isOpen && (
          <div className="tree-cols">
            {(t.remote ? colsCache[t.name] || [] : t.columns).map((c) => {
              const nested = !!c.hint; // hint is set only for nested columns
              const key = colKey(t.engine, t.name, c.name);
              const expanded = expandedCols.has(key);
              const fields = colFields[key];
              return (
                <React.Fragment key={c.name}>
                  <div
                    className="tree-col"
                    onClick={() => onInsertColumn(quoteSqlIdent(c.name))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (t.remote) return; // catalog cols: no type ops
                      setMenu(null);
                      setColMenu({
                        x: e.clientX,
                        y: e.clientY,
                        engine: t.engine,
                        table: t.name,
                        col: c.name,
                        type: c.type || "",
                      });
                    }}
                    title={
                      c.hint
                        ? `${c.name}${c.type ? ` · ${c.type}` : ""}\nHow to query: ${c.hint}\n(click to insert · ▸ to expand fields · right-click for options)`
                        : `${c.name}${c.type ? ` · ${c.type}` : ""}\nClick to insert · right-click for options`
                    }
                  >
                    {nested ? (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleColFields(t.engine, t.name, c.name);
                        }}
                        title={expanded ? "Collapse fields" : "Expand fields"}
                        style={{
                          cursor: "pointer",
                          width: 12,
                          display: "inline-block",
                          textAlign: "center",
                          opacity: 0.7,
                        }}
                      >
                        {expanded ? "▾" : "▸"}
                      </span>
                    ) : (
                      <Icon.Column size={12} className="faint" />
                    )}
                    <span>{c.name}</span>
                    <span className="ctype">{shortType(c.type)}</span>
                    {c.hint && (
                      <span
                        title={`How to query: ${c.hint}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInsertColumn(exampleFor(c.name, c.hint));
                        }}
                        style={{
                          marginLeft: 4,
                          opacity: 0.6,
                          cursor: "help",
                          fontSize: 11,
                        }}
                      >
                        ⓘ
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <div className="tree-col-fields">
                      {colFieldsBusy.has(key) && !fields ? (
                        <div
                          className="tree-col faint"
                          style={{ paddingLeft: 26 }}
                        >
                          <span className="spin" /> loading fields…
                        </div>
                      ) : (fields || []).length === 0 ? (
                        <div
                          className="tree-col faint"
                          style={{ paddingLeft: 26 }}
                        >
                          no nested fields
                        </div>
                      ) : (
                        (() => {
                          const rows = fields || [];
                          const needle = q.trim().toLowerCase();
                          const nodes: React.ReactNode[] = [];
                          // Walk the flat depth-tagged tree; skip any subtree
                          // under a collapsed node. Collapse is ignored while
                          // filtering so a matching field is never hidden.
                          let skipDeeper: number | null = null;
                          for (let i = 0; i < rows.length; i++) {
                            const f = rows[i];
                            if (skipDeeper !== null) {
                              if (f.depth > skipDeeper) continue;
                              skipDeeper = null;
                            }
                            const hasKids =
                              i + 1 < rows.length &&
                              rows[i + 1].depth > f.depth;
                            const nid = `${key}\u0000${i}`;
                            const isEl = f.name === "(element)";
                            // Structs load COLLAPSED by default; the "(element)"
                            // wrapper loads open. Both toggle; a filter overrides.
                            const collapsed =
                              !filtering &&
                              hasKids &&
                              (isEl
                                ? closedEls.has(nid)
                                : !openFields.has(nid));
                            const hit =
                              needle.length > 0 &&
                              f.name.toLowerCase().includes(needle);
                            nodes.push(
                              <div
                                key={i}
                                className="tree-col"
                                style={{
                                  paddingLeft: 14 + f.depth * 12,
                                  ...(hit
                                    ? { background: "rgba(255,213,74,0.16)" }
                                    : {}),
                                }}
                                title={f.path || f.note || f.type}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isEl)
                                    onInsertColumn(
                                      quoteSqlIdent(f.path || f.name),
                                    );
                                }}
                              >
                                {hasKids ? (
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleFieldNode(nid, isEl);
                                    }}
                                    title={collapsed ? "Expand" : "Collapse"}
                                    style={{
                                      cursor: "pointer",
                                      width: 12,
                                      display: "inline-block",
                                      textAlign: "center",
                                      opacity: 0.7,
                                    }}
                                  >
                                    {collapsed ? "▸" : "▾"}
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      width: 12,
                                      display: "inline-block",
                                    }}
                                  />
                                )}
                                <span
                                  className="fname"
                                  style={{
                                    color: KIND_COLOR[f.kind] || undefined,
                                    fontStyle: isEl ? "italic" : undefined,
                                    opacity: isEl ? 0.7 : 1,
                                  }}
                                >
                                  {f.name}
                                </span>
                                <span className="ctype">
                                  {shortType(f.type)}
                                </span>
                                {(f.kind === "array" ||
                                  f.kind === "array-scalar") && (
                                  <span style={{ color: "#c98a2b" }}> ⇗</span>
                                )}
                              </div>,
                            );
                            if (hasKids && collapsed) skipDeeper = f.depth;
                          }
                          return nodes;
                        })()
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
            {t.remote &&
              colsBusy[t.name] &&
              !(colsCache[t.name] || []).length && (
                <div className="tree-col faint">
                  <span className="spin" /> loading columns…
                </div>
              )}
            {t.remote &&
              !colsBusy[t.name] &&
              (colsCache[t.name] || []).length === 0 && (
                <div className="tree-col faint">no column info</div>
              )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="side-head">
        <span className="title">Tables</span>
        <span className="spacer" />
        <button
          className={
            "btn ghost icon" + (refreshSpin ? " icon-spin" : "")
          }
          title="Refresh"
          onClick={() => {
            fireRefreshSpin();
            onRefresh();
          }}
        >
          <Icon.Refresh size={15} />
        </button>
        <button className="btn ghost icon" title="Load data" onClick={onOpenLoad}>
          <Icon.Plus size={16} />
        </button>
      </div>
      <input
        className="search"
        placeholder="Filter tables…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="side-body">
        {selected.size === 0 && tables.some((t) => !t.remote) && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              padding: "0 10px 4px",
            }}
          >
            <button
              className="btn ghost"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={selectAll}
              title="Select every loaded table (for bulk delete)"
            >
              Select all
            </button>
          </div>
        )}
        {selected.size > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              margin: "0 0 6px",
              background: "rgba(220,60,60,0.14)",
              border: "1px solid rgba(220,60,60,0.35)",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span style={{ flex: "1 1 auto" }}>
              {selected.size} selected
            </span>
            <button
              className="btn danger"
              style={{ padding: "2px 10px", fontSize: 12 }}
              onClick={deleteSelected}
              title="Drop all selected tables"
            >
              Delete
            </button>
            <button
              className="btn ghost"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={selectAll}
              title="Select every loaded table"
            >
              All
            </button>
            <button
              className="btn ghost"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={clearSel}
              title="Deselect all"
            >
              Clear
            </button>
          </div>
        )}
        {filtered.length === 0 && (
          <div className="empty" style={{ padding: "30px 18px" }}>
            <div className="inner">
              <Icon.Database size={26} className="faint" />
              <h3>No tables yet</h3>
              <p>
                Load a CSV, JSON or Parquet file to get started, or fetch a
                REST endpoint.
              </p>
              <button
                className="btn primary"
                style={{ marginTop: 12 }}
                onClick={onOpenLoad}
              >
                <Icon.Upload size={15} /> Load data
              </button>
            </div>
          </div>
        )}
        <div className="tree-table">
          {families.map(({ table, children }) => {
            const fk = table.engine + ":" + table.name;
            const expanded = famOpen[fk] ?? true;
            return (
              <div key={"fam:" + fk}>
                <div className="fam-head">
                  {children.length > 0 && (
                    <span
                      className={"twist fam-caret" + (expanded ? " open" : "")}
                      title={
                        (expanded ? "Collapse" : "Expand") +
                        " this table's relational tables"
                      }
                      onClick={() =>
                        setFamOpen((p) => ({ ...p, [fk]: !expanded }))
                      }
                    >
                      <Icon.Chevron size={12} />
                    </span>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>{renderRow(table)}</div>
                </div>
                {children.length > 0 && expanded && (
                  <div className="fam-kids">
                    {children.map((c) => renderRow(c, table))}
                  </div>
                )}
              </div>
            );
          })}
          {[...groups.entries()].map(([g, ts]) => {
            const expanded = filtering
              ? true
              : groupOpen[g] ?? ts.length <= 50;
            const conn = ts[0]?.conn || "";
            return (
              <div className="tree-group" key={"grp:" + g}>
                <div
                  className="tree-grp-row"
                  onClick={() => toggleGroupOpen(g)}
                  onContextMenu={(e) => {
                    if (!conn) return;
                    e.preventDefault();
                    setMenu(null);
                    setColMenu(null);
                    setGrpMenu({ x: e.clientX, y: e.clientY, conn, name: g });
                  }}
                  title={
                    conn
                      ? `${g} — ${ts.length} table${
                          ts.length === 1 ? "" : "s"
                        } · right-click to disconnect`
                      : `${g} — ${ts.length} table${ts.length === 1 ? "" : "s"}`
                  }
                >
                  <span className={"twist" + (expanded ? " open" : "")}>
                    <Icon.Chevron size={13} />
                  </span>
                  <Icon.Database size={13} className="faint" />
                  <span className="grp-name">{g}</span>
                  <span className="grp-count">{ts.length.toLocaleString()}</span>
                  {conn && (
                    <button
                      className="btn ghost icon danger grp-disconnect"
                      title={`Disconnect from ${conn}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDisconnect(conn);
                      }}
                    >
                      <Icon.Power size={14} />
                    </button>
                  )}
                </div>
                {expanded && ts.map((t) => renderRow(t))}
              </div>
            );
          })}
        </div>
      </div>
      {menu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 120 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ ...menuPos(menu.x, menu.y, 210), zIndex: 121 }}
          >
            <div className="label">
              {menu.t.engine} · {menu.t.name}
            </div>
            {menu.t.remote && (
              <button
                onClick={() => {
                  onImport(menu.t.name);
                  setMenu(null);
                }}
                title="Pull this table's data into a local DuckDB table"
              >
                Import into workspace (DuckDB)
              </button>
            )}
            {!menu.t.remote && isConvertible(menu.t) && (
              <button
                onClick={() => {
                  onOptimize(menu.t.name);
                  setMenu(null);
                }}
              >
                Convert to Parquet (faster queries)
              </button>
            )}
            <button
              onClick={() => {
                onInsertTable(quoteSqlIdent(menu.t.name));
                setMenu(null);
              }}
            >
              Insert name into editor
            </button>
            <button
              onClick={() => {
                onTableProps && onTableProps(menu.t.engine, menu.t.name);
                setMenu(null);
              }}
            >
              Properties
            </button>
            {onLoadSql && parentOf.has(menu.t.engine + ":" + menu.t.name) && (
              <button
                onClick={() => {
                  const par = parentOf.get(menu.t.engine + ":" + menu.t.name)!;
                  onLoadSql(familyJoinSql(par as any, menu.t as any));
                  setMenu(null);
                }}
              >
                Insert join to{" "}
                {parentOf.get(menu.t.engine + ":" + menu.t.name)!.name}
              </button>
            )}
            {!menu.t.remote && (
              <>
                <button
                  onClick={() => {
                    onProfile(menu.t.name, menu.t.engine);
                    setMenu(null);
                  }}
                >
                  Profile columns
                </button>
                {tables.length >= 2 && (
                  <button
                    onClick={() => {
                      onReconcile(menu.t.name, menu.t.engine);
                      setMenu(null);
                    }}
                  >
                    Reconcile with…
                  </button>
                )}
                <div className="sep" />
                <button
                  onClick={() => {
                    onRename(menu.t.engine, menu.t.name);
                    setMenu(null);
                  }}
                >
                  Rename…
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    onDrop(menu.t.engine, menu.t.name);
                    setMenu(null);
                  }}
                >
                  Drop table
                </button>
              </>
            )}
          </div>
        </>
      )}
      {grpMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 120 }}
            onClick={() => setGrpMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setGrpMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ ...menuPos(grpMenu.x, grpMenu.y, 210), zIndex: 121 }}
          >
            <div className="label">SQL Server · {grpMenu.conn}</div>
            <button
              className="danger"
              onClick={() => {
                onDisconnect(grpMenu.conn);
                setGrpMenu(null);
              }}
              title="Close this connection and remove its tables from the panel"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {colMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 120 }}
            onClick={() => setColMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setColMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ ...menuPos(colMenu.x, colMenu.y, 220), zIndex: 121 }}
          >
            <div className="label">
              {colMenu.col}
              {colMenu.type ? ` · ${colMenu.type}` : ""}
            </div>
            <button
              onClick={() => {
                onInsertColumn(quoteSqlIdent(colMenu.col));
                setColMenu(null);
              }}
            >
              Insert into editor
            </button>
            <button
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(colMenu.col);
                } catch {
                  /* clipboard unavailable */
                }
                setColMenu(null);
              }}
            >
              Copy name
            </button>
            <div className="sep" />
            <div className="label">Change type to</div>
            {["TEXT", "INTEGER", "DOUBLE", "DATE", "TIMESTAMP", "BOOLEAN"].map(
              (ty) => (
                <button
                  key={ty}
                  disabled={(colMenu.type || "").toUpperCase() === ty}
                  onClick={() => {
                    onChangeType(
                      colMenu.engine,
                      colMenu.table,
                      colMenu.col,
                      ty,
                    );
                    setColMenu(null);
                  }}
                >
                  {ty.charAt(0) + ty.slice(1).toLowerCase()}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </>
  );
};

const HistoryPanel: React.FC<Props> = ({
  history,
  onLoadSql,
  onClearHistory,
}) => (
  <>
    <div className="side-head">
      <span className="title">History</span>
      <span className="spacer" />
      {history.length > 0 && (
        <button className="btn ghost sm" onClick={onClearHistory}>
          Clear
        </button>
      )}
    </div>
    <div className="side-body">
      {history.length === 0 ? (
        <div className="empty" style={{ padding: "30px 18px" }}>
          <div className="inner">
            <Icon.Clock size={24} className="faint" />
            <p>Queries you run will appear here.</p>
          </div>
        </div>
      ) : (
        history.map((h, i) => (
          <div
            key={i}
            className="list-item"
            onClick={() => onLoadSql(h.sql)}
            title="Load into editor"
          >
            <div className="sql">{h.sql}</div>
            <div className="meta">
              {h.row_count != null && <span>{h.row_count} rows</span>}
              {h.elapsed_sec != null && (
                <span>{(h.elapsed_sec * 1000).toFixed(0)} ms</span>
              )}
              {h.target && <span className="faint">{h.target}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  </>
);

const WF_SECTIONS: { kind: WorkflowKind; label: string }[] = [
  { kind: "ide", label: "SQL editor" },
  { kind: "journal", label: "Journal" },
  { kind: "node", label: "Node" },
  { kind: "dashboard", label: "Dashboard" },
];

const WF_VIEW_LABEL: Record<Props["activeView"], string> = {
  ide: "SQL editor",
  notebook: "Journal",
  nodeflow: "NodeFlow",
  dashboard: "Dashboard",
};

const WF_DRAG_MIME = "application/x-samql-workflow";

function WorkflowItemRow({
  kind,
  w,
  onLoadWorkflow,
  onDeleteWorkflow,
}: {
  kind: WorkflowKind;
  w: WorkflowSummary;
  onLoadWorkflow: (kind: WorkflowKind, name: string) => void;
  onDeleteWorkflow: (kind: WorkflowKind, name: string) => void;
}) {
  return (
    <div
      className="list-item wf-item"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          WF_DRAG_MIME,
          JSON.stringify({ kind, name: w.name }),
        );
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div
        className="wf-item-row"
        onClick={() => onLoadWorkflow(kind, w.name)}
        title="Open"
      >
        <span className="name" style={{ flex: 1 }}>
          {w.name}
        </span>
        <button
          className="btn ghost icon danger"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteWorkflow(kind, w.name);
          }}
        >
          <span className="icon-trash">
            <Icon.Trash size={14} />
          </span>
        </button>
      </div>
      {kind === "ide" && w.preview ? (
        <div className="sql" onClick={() => onLoadWorkflow(kind, w.name)}>
          {w.preview}
        </div>
      ) : null}
      <div className="meta wf-meta">
        {kind === "node" && typeof w.nodes === "number"
          ? `${w.nodes} node${w.nodes === 1 ? "" : "s"}`
          : kind === "journal" && typeof w.cells === "number"
            ? `${w.cells} cell${w.cells === 1 ? "" : "s"}`
            : ""}
      </div>
    </div>
  );
}

const WorkflowsPanel: React.FC<Props> = ({
  workflows,
  onLoadWorkflow,
  onDeleteWorkflow,
  onActiveSave,
  onActiveSaveAs,
  onActiveOpen,
  activeView,
}) => {
  const [groupState, setGroupState] = useState(() => loadWorkflowGroups());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const persist = (next: ReturnType<typeof loadWorkflowGroups>) => {
    setGroupState(next);
    saveWorkflowGroups(next);
  };

  return (
    <>
      <div className="side-head">
        <span className="title">Saved Workflows</span>
      </div>
      <div className="wf-actions">
        <div className="wf-actions-row">
          <button
            className="btn sm"
            onClick={onActiveSave}
            title={`Save the current ${WF_VIEW_LABEL[activeView]} here`}
          >
            <Icon.Save size={13} /> Save
          </button>
          <button
            className="btn sm"
            onClick={onActiveSaveAs}
            title="Save to a file on your computer"
          >
            Save As
          </button>
          <button
            className="btn sm"
            onClick={onActiveOpen}
            title="Open a workflow file from your computer"
          >
            <Icon.Folder size={13} /> Open
          </button>
        </div>
        <div className="wf-actions-hint">
          Acting on: <strong>{WF_VIEW_LABEL[activeView]}</strong>
        </div>
      </div>
      <div className="side-body">
        {workflows.length === 0 ? (
          <div className="empty" style={{ padding: "30px 18px" }}>
            <div className="inner">
              <Icon.Bookmark size={24} className="faint" />
              <p>
                Use Save in the SQL editor, Journal or Node and your work is kept
                here, grouped by where it came from.
              </p>
            </div>
          </div>
        ) : (
          WF_SECTIONS.map(({ kind, label }) => {
            const items = workflows.filter((w) => w.kind === kind);
            const groups = groupsForKind(groupState, kind);
            const inGroup = groupedNames(groupState, kind);
            const ungrouped = items.filter((w) => !inGroup.has(w.name));
            return (
              <div className="wf-section" key={kind}>
                <div className="wf-section-head">
                  <span>{label}</span>
                  <span className="wf-section-actions">
                    <button
                      type="button"
                      className="btn ghost icon"
                      title="Add group"
                      onClick={() =>
                        persist(addWorkflowGroup(groupState, kind))
                      }
                    >
                      <Icon.Folder size={13} />
                    </button>
                    <span className="wf-count">{items.length}</span>
                  </span>
                </div>
                {items.length === 0 ? (
                  <div className="wf-empty">No saves yet.</div>
                ) : (
                  <>
                    {groups.map((g) => {
                      const members = items.filter((w) =>
                        g.members.includes(w.name),
                      );
                      const isDrop = dropTarget === g.id;
                      return (
                        <div
                          key={g.id}
                          className={
                            "wf-group" + (isDrop ? " drop-target" : "")
                          }
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDropTarget(g.id);
                          }}
                          onDragLeave={() =>
                            setDropTarget((cur) => (cur === g.id ? null : cur))
                          }
                          onDrop={(e) => {
                            e.preventDefault();
                            setDropTarget(null);
                            try {
                              const raw = e.dataTransfer.getData(WF_DRAG_MIME);
                              const payload = JSON.parse(raw || "{}") as {
                                kind?: WorkflowKind;
                                name?: string;
                              };
                              if (
                                payload.kind === kind &&
                                typeof payload.name === "string"
                              ) {
                                persist(
                                  moveWorkflowToGroup(
                                    groupState,
                                    kind,
                                    payload.name,
                                    g.id,
                                  ),
                                );
                              }
                            } catch {
                              /* ignore bad drag payloads */
                            }
                          }}
                        >
                          <div className="wf-group-head">
                            <button
                              type="button"
                              className="btn ghost icon"
                              title={g.collapsed ? "Expand" : "Minimize"}
                              onClick={() =>
                                persist(
                                  toggleWorkflowGroupCollapsed(
                                    groupState,
                                    g.id,
                                  ),
                                )
                              }
                            >
                              <span
                                className={
                                  "wf-group-chevron" +
                                  (g.collapsed ? " collapsed" : "")
                                }
                              >
                                <Icon.Chevron size={13} />
                              </span>
                            </button>
                            {renamingId === g.id ? (
                              <input
                                className="wf-group-rename"
                                autoFocus
                                value={renameDraft}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onBlur={() => {
                                  persist(
                                    renameWorkflowGroup(
                                      groupState,
                                      g.id,
                                      renameDraft,
                                    ),
                                  );
                                  setRenamingId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    (e.target as HTMLInputElement).blur();
                                  } else if (e.key === "Escape") {
                                    setRenamingId(null);
                                  }
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="wf-group-name"
                                title="Rename group"
                                onDoubleClick={() => {
                                  setRenamingId(g.id);
                                  setRenameDraft(g.name);
                                }}
                                onClick={() => {
                                  setRenamingId(g.id);
                                  setRenameDraft(g.name);
                                }}
                              >
                                {g.name}
                              </button>
                            )}
                            <span className="wf-count">{members.length}</span>
                            <button
                              type="button"
                              className="btn ghost icon danger"
                              title="Delete group"
                              onClick={() =>
                                persist(deleteWorkflowGroup(groupState, g.id))
                              }
                            >
                              <Icon.Trash size={12} />
                            </button>
                          </div>
                          {!g.collapsed ? (
                            members.length ? (
                              members.map((w) => (
                                <WorkflowItemRow
                                  key={kind + ":" + w.name}
                                  kind={kind}
                                  w={w}
                                  onLoadWorkflow={onLoadWorkflow}
                                  onDeleteWorkflow={onDeleteWorkflow}
                                />
                              ))
                            ) : (
                              <div className="wf-empty">
                                Drop workflows here.
                              </div>
                            )
                          ) : null}
                        </div>
                      );
                    })}
                    <div
                      className={
                        "wf-ungrouped" +
                        (dropTarget === `ungrouped:${kind}`
                          ? " drop-target"
                          : "")
                      }
                      onDragOver={(e) => {
                        if (!groups.length) return;
                        e.preventDefault();
                        setDropTarget(`ungrouped:${kind}`);
                      }}
                      onDragLeave={() =>
                        setDropTarget((cur) =>
                          cur === `ungrouped:${kind}` ? null : cur,
                        )
                      }
                      onDrop={(e) => {
                        e.preventDefault();
                        setDropTarget(null);
                        try {
                          const raw = e.dataTransfer.getData(WF_DRAG_MIME);
                          const payload = JSON.parse(raw || "{}") as {
                            kind?: WorkflowKind;
                            name?: string;
                          };
                          if (
                            payload.kind === kind &&
                            typeof payload.name === "string"
                          ) {
                            persist(
                              moveWorkflowToGroup(
                                groupState,
                                kind,
                                payload.name,
                                null,
                              ),
                            );
                          }
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      {ungrouped.map((w) => (
                        <WorkflowItemRow
                          key={kind + ":" + w.name}
                          kind={kind}
                          w={w}
                          onLoadWorkflow={onLoadWorkflow}
                          onDeleteWorkflow={onDeleteWorkflow}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

// Skip re-render when the data props are unchanged (e.g. while typing in the
// editor). The callbacks are stale-safe — they act on arguments or read live
// refs (activeIdRef / edTabsRef) — so their identity is ignored.
function sidebarPropsEqual(a: Props, b: Props): boolean {
  return (
    a.tables === b.tables &&
    a.history === b.history &&
    a.saved === b.saved &&
    a.workflows === b.workflows &&
    a.activeView === b.activeView
  );
}
export const Sidebar = React.memo(SidebarImpl, sidebarPropsEqual);
