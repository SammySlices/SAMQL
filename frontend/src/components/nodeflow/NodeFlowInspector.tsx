import React, { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { api } from "../../lib/api";
import { paletteColors } from "../../lib/chartOption";
import {
  nodeShowsBody,
  PORT_LABEL,
  PORTS,
  type NbEdge,
  type NbNode,
  type NodeType,
} from "../../lib/nodeFlowModel";
import type { ChartData, TableInfo } from "../../lib/types";
import {
  getNodeDefinition,
  getNodeInspectorType,
  nodeInspectorIsResizable,
} from "./nodeDefinitions";
import { ColumnPicker, ReorderList } from "./InspectorControls";
import { InspectorShell } from "./InspectorShell";
import {
  filterSelectFields,
  setFieldsKept,
  sortSelectFields,
  type SelField,
} from "../../lib/selectFields";
import {
  MsSqlConnectForm,
  type MsSqlConnectValues,
  deleteMsSqlProfile,
  persistMsSqlProfile,
  sqlProfileToConnectValues,
} from "../load/MsSqlConnectForm";
import {
  type SqlProfile,
  SQL_PROFILES_KEY,
  bestOdbcDriver,
  parseSqlProfiles,
  sanitizeProfileName,
} from "../../lib/sqlProfiles";
import { clearStaleNodeflowColumnRefs } from "../../lib/staleNodeflowColumnRefs";

/** Empty-upstream note vs in-flight column probe (never show “Connect…” while probing). */
function InspColsHint({
  probing,
  ready,
  children,
}: {
  probing: boolean;
  ready: boolean;
  children: React.ReactNode;
}) {
  if (ready) return null;
  if (probing) {
    return (
      <div className="nb2-note" data-testid="insp-cols-loading">
        Loading fields…
      </div>
    );
  }
  return <div className="nb2-note">{children}</div>;
}

export interface NodeFlowInspectorContext {
  buildFilterCond: (field: string, op: string, value: string) => string;
  chartData: Record<string, { data?: ChartData; loading?: boolean; error?: string }>;
  childSelCtx: { groupId: string; index: number; child: NbNode } | null;
  DATA_FORMATS: string[];
  dirList: {
    folder: string;
    files: { name: string; path: string; ext: string }[];
    loading: boolean;
    error?: string;
  };
  dissolveContainer: (id: string) => void;
  doChart: (node: NbNode) => Promise<void>;
  doCreateTable: (node: NbNode) => Promise<void>;
  doExport: (node: NbNode) => Promise<any>;
  doFetchApi: (node: NbNode, configExtra?: Record<string, unknown>) => Promise<any>;
  doPreview: (node: NbNode, port: string, title: string) => Promise<void>;
  doProfile: (node: NbNode) => Promise<void>;
  doReadDirectory: (node: NbNode, path: string, file: string) => Promise<void>;
  doReadFolder: (node: NbNode, folder: string) => Promise<void>;
  doReconcile: (node: NbNode) => Promise<void>;
  doRunIterator: (node: NbNode) => Promise<any>;
  doRunWhile: (node: NbNode) => Promise<any>;
  doValidate: (node: NbNode) => Promise<void>;
  doWriteTable: (node: NbNode) => Promise<any>;
  edges: NbEdge[];
  ensureChartFor: (node: NbNode | null, force?: boolean) => Promise<void>;
  filterFx: { from: number; to: number; items: string[] } | null;
  filterHint: string;
  filterInsertFunc: (tpl: string) => void;
  filterPickField: (field: string) => void;
  filterRecompute: (el: HTMLTextAreaElement) => void;
  filterRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  FORMAT_LABELS: Record<string, string>;
  FX_FUNCS: { label: string; tpl: string; sig: string }[];
  fxField: { i: number; from: number; to: number; items: string[] } | null;
  fxFocus: React.MutableRefObject<number>;
  fxHint: string;
  fxInsertFunc: (tpl: string) => void;
  fxPickField: (field: string) => void;
  fxRecompute: (i: number, el: HTMLTextAreaElement) => void;
  fxRefs: React.MutableRefObject<Record<number, HTMLTextAreaElement | null>>;
  fxSetExpr: (i: number, expr: string) => void | null;
  IMAGE_FORMATS_CHART: string[];
  IMAGE_FORMATS_DASH: string[];
  inspCols: Record<string, string[]>;
  /** True while upstream column probe is in flight for the selected node. */
  inspColsProbing: boolean;
  inspectorDocked: boolean;
  inspectorHost: HTMLElement | null | undefined;
  loadDirList: (folder: string) => Promise<void>;
  nodes: NbNode[];
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  outputKind: (node: NbNode) => "chart" | "dashboard" | "data" | "none";
  patch: (id: string, cfg: Record<string, any>) => void;
  patchSeriesColor: (node: NbNode, name: string, color: string | null) => void;
  patchStyle: (node: NbNode, key: string, value: any) => void;
  removeNode: (id: string) => void;
  renderReduceControls: (sel: NbNode) => React.JSX.Element;
  running: boolean;
  seedSelectFields: () => void;
  sel: NbNode | null;
  setAggs: (aggs: any[]) => void | null;
  setAllFieldsKept: (keep: boolean) => void;
  setBrowseFolder: React.Dispatch<React.SetStateAction<boolean>>;
  setDashPane: (dash: NbNode, idx: number, port: string) => void;
  setFilterCond: (condition: string) => void | null;
  setFilterFx: React.Dispatch<
    React.SetStateAction<{ from: number; to: number; items: string[] } | null>
  >;
  setFilterHint: React.Dispatch<React.SetStateAction<string>>;
  setFormulas: (formulas: any[]) => void | null;
  setFxField: React.Dispatch<
    React.SetStateAction<{ i: number; from: number; to: number; items: string[] } | null>
  >;
  setFxHint: React.Dispatch<React.SetStateAction<string>>;
  setHelpFor: React.Dispatch<React.SetStateAction<string | null>>;
  setKeys: (keys: any[]) => void | null;
  setSorts: (sorts: any[]) => void | null;
  setWindows: (windows: any[]) => void | null;
  showTables: boolean | undefined;
  staleColRefs: { area: string; columns: string[] }[];
  tables: TableInfo[];
  toggleInArray: (field: string, col: string) => void;
  updateField: (idx: number, patch: Record<string, any>) => void;
  upstreamChartNode: (dash: NbNode, inPort: string) => NbNode | null;
  validateResults: Record<
    string,
    {
      ok?: boolean;
      total_rows?: number;
      results?: { type: string; target: string; pass: boolean; detail: string }[];
      error?: string;
      loading?: boolean;
    }
  >;
}

export const NodeFlowInspector: React.FC<{ context: NodeFlowInspectorContext }> = ({ context }) => {
  const {
    buildFilterCond,
    chartData,
    childSelCtx,
    DATA_FORMATS,
    dirList,
    dissolveContainer,
    doChart,
    doCreateTable,
    doExport,
    doFetchApi,
    doPreview,
    doProfile,
    doReadDirectory,
    doReadFolder,
    doReconcile,
    doRunIterator,
    doRunWhile,
    doValidate,
    doWriteTable,
    edges,
    ensureChartFor,
    filterFx,
    filterHint,
    filterInsertFunc,
    filterPickField,
    filterRecompute,
    filterRef,
    FORMAT_LABELS,
    FX_FUNCS,
    fxField,
    fxFocus,
    fxHint,
    fxInsertFunc,
    fxPickField,
    fxRecompute,
    fxRefs,
    fxSetExpr,
    IMAGE_FORMATS_CHART,
    IMAGE_FORMATS_DASH,
    inspCols,
    inspColsProbing,
    inspectorDocked,
    inspectorHost,
    loadDirList,
    nodes,
    onToast,
    outputKind,
    patch,
    patchSeriesColor,
    patchStyle,
    removeNode,
    renderReduceControls,
    running,
    seedSelectFields,
    sel,
    setAggs,
    setBrowseFolder,
    setDashPane,
    setFilterCond,
    setFilterFx,
    setFilterHint,
    setFormulas,
    setFxField,
    setFxHint,
    setHelpFor,
    setKeys,
    setSorts,
    setWindows,
    showTables,
    staleColRefs,
    tables,
    toggleInArray,
    updateField,
    upstreamChartNode,
    validateResults,
  } = context;
  const [apiPwDraft, setApiPwDraft] = useState("");
  const [inspW, setInspW] = useState<number | null>(null);
  // Select-node field list: search filters the visible rows; sort toggles
  // A→Z / Z→A on the underlying config.fields order.
  const [selectFieldSearch, setSelectFieldSearch] = useState("");
  const [selectFieldSortDir, setSelectFieldSortDir] = useState<"asc" | "desc">(
    "asc",
  );
  const [apiConnProfiles, setApiConnProfiles] = useState<
    { key: string; name: string; fields: Record<string, unknown> }[]
  >([]);
  const [mssqlDrivers, setMssqlDrivers] = useState<string[]>([]);
  const [mssqlProfiles, setMssqlProfiles] = useState<Record<string, SqlProfile>>(
    {},
  );
  const [mssqlSecretsOk, setMssqlSecretsOk] = useState(false);
  const [mssqlPwd, setMssqlPwd] = useState("");
  useEffect(() => setApiPwDraft(""), [sel?.id]);
  useEffect(() => setMssqlPwd(""), [sel?.id]);
  useEffect(() => {
    setSelectFieldSearch("");
    setSelectFieldSortDir("asc");
  }, [sel?.id]);
  useEffect(() => {
    const kind = sel ? getNodeInspectorType(sel.type) : null;
    if (!sel || (kind !== "apinode" && kind !== "sqlserver")) {
      setApiConnProfiles([]);
      return;
    }
    let cancelled = false;
    api
      .connectionProfilesList()
      .then((r) => {
        if (cancelled) return;
        setMssqlSecretsOk(!!r.secrets_available);
        if (kind === "apinode") {
          setApiConnProfiles(
            (r.profiles || [])
              .filter((p) => p.kind === "api")
              .map((p) => ({
                key: p.key,
                name: p.name,
                fields: p.fields || {},
              })),
          );
        } else {
          setApiConnProfiles([]);
          // Merge server mssql profiles into the local map (fields only).
          const fromServer: Record<string, SqlProfile> = {};
          for (const p of r.profiles || []) {
            if (p.kind !== "mssql") continue;
            const f = (p.fields || {}) as Record<string, unknown>;
            fromServer[p.name] = {
              driver: String(f.driver || ""),
              server: String(f.server || ""),
              port: String(f.port || ""),
              auth: (["windows", "sql", "windows_alt"].includes(
                String(f.auth),
              )
                ? String(f.auth)
                : "windows") as SqlProfile["auth"],
              user: String(f.user || ""),
              encrypt: f.encrypt !== false,
              trust: f.trust !== false,
              multiSubnet: !!f.multi_subnet,
              loginTimeout: String(f.login_timeout ?? "15"),
              stmtTimeout: String(f.stmt_timeout ?? "0"),
              readOnly: f.read_only !== false,
              savePassword: !!p.has_secret,
            };
          }
          let local: Record<string, SqlProfile> = {};
          try {
            local = parseSqlProfiles(localStorage.getItem(SQL_PROFILES_KEY));
          } catch {
            local = {};
          }
          setMssqlProfiles({ ...fromServer, ...local });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setApiConnProfiles([]);
          if (kind === "sqlserver") {
            try {
              setMssqlProfiles(
                parseSqlProfiles(localStorage.getItem(SQL_PROFILES_KEY)),
              );
            } catch {
              setMssqlProfiles({});
            }
          }
        }
      });
    return () => {
      cancelled = true;
    };
    // Reload when the selected API / SQL Server node changes; ignore config edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, sel?.type]);
  useEffect(() => {
    const kind = sel ? getNodeInspectorType(sel.type) : null;
    if (!sel || kind !== "sqlserver") {
      setMssqlDrivers([]);
      return;
    }
    let cancelled = false;
    api
      .mssqlDrivers()
      .then((r) => {
        if (cancelled) return;
        const ds = r.drivers || [];
        setMssqlDrivers(ds);
        if (ds.length && !(sel.config.driver || "").trim()) {
          patch(sel.id, { driver: bestOdbcDriver(ds) });
        }
      })
      .catch(() => {
        if (!cancelled) setMssqlDrivers([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, sel?.type]);

  const inspectorType = sel ? getNodeInspectorType(sel.type) : null;
  const inspectorDefinition = sel ? getNodeDefinition(sel.type) : null;

  return (
        <InspectorShell
          host={inspectorHost}
          docked={inspectorDocked}
          hidden={!!(showTables && sel && !inspectorHost)}
          empty={!sel}
          hasResize={!!sel && nodeInspectorIsResizable(sel.type)}
          width={inspW}
          onResize={setInspW}
        >
          {!sel && <div className="nb2-insp-empty">Select a node to configure it.</div>}
          {sel && (
            <div
              className="nb2-insp-swap"
              key={`${sel.id}:${sel.type}`}
              data-testid="insp-swap-body"
            >
              <div className="nb2-insp-head">
                <span className="nb2-insp-title">
                  {inspectorDefinition?.label || sel.type} node
                  <button
                    className="btn ghost icon nb2-insp-help"
                    onClick={() => setHelpFor(sel.type)}
                    title="How to use this node"
                  >
                    <Icon.Lightbulb size={14} />
                  </button>
                </span>
                <span className="nb2-insp-head-actions">
                  <button
                    className="btn ghost icon danger"
                    onClick={() => removeNode(sel.id)}
                    title="Delete"
                  >
                    <Icon.Trash size={13} />
                  </button>
                </span>
              </div>
              <label className="nb2-lbl">Label</label>
              <input
                className="nb2-in"
                value={sel.config.label || ""}
                onChange={(e) => patch(sel.id, { label: e.target.value })}
              />

              {childSelCtx && (
                <div className="nb2-note nb2-childcrumb">
                  Step {childSelCtx.index + 1} inside group “
                  {(nodes.find((g) => g.id === childSelCtx.groupId)?.config
                    .label as string) || "group"}
                  ”. Its input is the output of the step above it.
                </div>
              )}

              {staleColRefs.length > 0 && (
                <div className="nb2-warn-sm" data-testid="stale-col-refs-warn">
                  <strong>Stale column references.</strong> Saved fields below are
                  no longer in upstream data (after a rename or drop). Update them
                  before running — config is not auto-changed.
                  <ul className="nb2-stale-list">
                    {staleColRefs.map(({ area, columns }) => (
                      <li key={area}>
                        <span className="nb2-stale-area">{area}</span>:{" "}
                        {columns.map((c) => (
                          <code key={c} className="nb2-stale-col">
                            {c}
                          </code>
                        )).reduce<React.ReactNode[]>(
                          (acc, el, i) =>
                            i === 0 ? [el] : [...acc, ", ", el],
                          [],
                        )}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn xs"
                    data-testid="stale-col-refs-clear"
                    style={{ marginTop: 6 }}
                    onClick={() => {
                      if (!sel) return;
                      const next = clearStaleNodeflowColumnRefs(
                        sel.type,
                        sel.config || {},
                        staleColRefs,
                      );
                      if (next) patch(sel.id, next);
                    }}
                  >
                    Clear stale references
                  </button>
                </div>
              )}

              {inspectorType === "group" && (
                <>
                  <div className="nb2-note">
                    A group is a mini-pipeline. Drag nodes into it on the
                    canvas; they run top to bottom, each using the one above it,
                    and its output is the last node’s result. A group can take
                    several inputs — wire them to its input ports, then use
                    “Step inputs” below to feed a step (like a join) from a
                    chosen input. Drag to reorder.
                  </div>
                  <label className="nb2-lbl">Notes</label>
                  <textarea
                    className="nb2-in nb2-notes-area"
                    rows={3}
                    placeholder="What this pipeline does…"
                    value={sel.config.note || ""}
                    onChange={(e) => patch(sel.id, { note: e.target.value })}
                  />
                  <div className="nb2-note" style={{ marginTop: 8 }}>
                    {(sel.config.children || []).length} step(s):{" "}
                    {(sel.config.children || [])
                      .map((c: any) => c.type)
                      .join(" → ") || "(empty)"}
                  </div>
                  {(() => {
                    const kids = (sel.config.children || []) as any[];
                    const withIns = kids
                      .map((c, ci) => ({
                        c,
                        ci,
                        ins: PORTS[c.type as NodeType]?.inputs || [],
                      }))
                      .filter((x) => x.ins.length > 0);
                    if (!withIns.length) return null;
                    const grpInEdges = edges.filter(
                      (e) => e.to.node === sel.id,
                    );
                    const inLabel = (port: string) => {
                      const e = grpInEdges.find((x) => x.to.port === port);
                      if (!e) return "";
                      const src = nodes.find((n) => n.id === e.from.node);
                      return src
                        ? (src.config.label as string) || src.type
                        : "";
                    };
                    const bindings = (sel.config.bindings || {}) as Record<
                      string,
                      Record<string, string>
                    >;
                    const setBind = (cid: string, port: string, val: string) => {
                      const next: Record<
                        string,
                        Record<string, string>
                      > = { ...(sel.config.bindings || {}) };
                      const cm = { ...(next[cid] || {}) };
                      if (val) cm[port] = val;
                      else delete cm[port];
                      if (Object.keys(cm).length) next[cid] = cm;
                      else delete next[cid];
                      patch(sel.id, { bindings: next });
                    };
                    return (
                      <>
                        <label className="nb2-lbl" style={{ marginTop: 10 }}>
                          Step inputs
                        </label>
                        <div className="nb2-note">
                          Each step uses the step above it by default. To feed a
                          step from one of the group’s own inputs instead — e.g.
                          the two sides of a join — pick an input below. Leave as
                          “pipeline default” to keep the linear flow.
                        </div>
                        {withIns.map(({ c, ci, ins }) => (
                          <div key={c.id} className="nb2-grpbind">
                            <div className="nb2-grpbind-h">
                              Step {ci + 1}:{" "}
                              {(c.config?.label as string) || c.type}
                            </div>
                            {ins.map((ip: string) => (
                              <div key={ip} className="nb2-grpbind-row">
                                <span className="nb2-grpbind-port">{ip}</span>
                                <select
                                  className="nb2-in"
                                  value={(bindings[c.id] || {})[ip] || ""}
                                  onChange={(e) =>
                                    setBind(c.id, ip, e.target.value)
                                  }
                                >
                                  <option value="">
                                    pipeline default (step above)
                                  </option>
                                  {PORTS.group.inputs.map((gp, gi) => (
                                    <option key={gp} value={gp}>
                                      Group input {gi + 1}
                                      {inLabel(gp)
                                        ? ` — ${inLabel(gp)}`
                                        : " (not connected)"}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    );
                  })()}
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running || !(sel.config.children || []).length}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview group output
                  </button>
                  {(sel.config.children || []).length > 0 && (
                    <button
                      className="btn sm ghost"
                      style={{ marginTop: 6 }}
                      onClick={() => patch(sel.id, { children: [] })}
                    >
                      Clear all steps
                    </button>
                  )}
                </>
              )}

              {inspectorType === "shred" && (
                <>
                  <label className="nb2-lbl">Loaded (nested) table</label>
                  <select
                    className="nb2-in"
                    value={sel.config.table || ""}
                    onChange={(e) =>
                      patch(sel.id, {
                        table: e.target.value,
                        label: "shred " + e.target.value,
                      })
                    }
                  >
                    <option value="">(pick a table)</option>
                    {tables
                      .filter((t) => !t.remote && t.engine === "duckdb")
                      .map((t) => (
                        <option key={t.engine + ":" + t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                  <label className="nb2-lbl">Family name (optional)</label>
                  <input
                    className="nb2-in"
                    value={sel.config.base || ""}
                    placeholder={sel.config.table || "root table name"}
                    onChange={(e) => patch(sel.id, { base: e.target.value })}
                  />
                  {/* .475: the shred node flattens the WHOLE table (base +
                      joinkeys + one table per nested list). This picker
                      chooses which family table the OUT port emits -- the
                      base by default (its _rid joins to every child). */}
                  <label className="nb2-lbl">Output table</label>
                  <select
                    className="nb2-in"
                    value={sel.config.output || ""}
                    onChange={(e) => patch(sel.id, { output: e.target.value })}
                  >
                    {(() => {
                      const fam = (sel.config.base || sel.config.table || "")
                        .trim()
                        .toLowerCase();
                      const opts = tables
                        .filter(
                          (t) =>
                            t.engine === "duckdb" &&
                            fam &&
                            (t.name.toLowerCase() === fam ||
                              t.name.toLowerCase().startsWith(fam + "_")),
                        )
                        .map((t) => t.name);
                      // base first, then records hub (*_flattened), then lists
                      opts.sort((a, b) => {
                        const rank = (n: string) =>
                          n.toLowerCase() === fam
                            ? 0
                            : /_flattened$/i.test(n)
                              ? 1
                              : /_joinkeys$/i.test(n)
                                ? 1
                                : 2;
                        return rank(a) - rank(b) || a.localeCompare(b);
                      });
                      return (
                        <>
                          <option value="">
                            (base — joins to every child on _rid)
                          </option>
                          {opts.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </>
                      );
                    })()}
                  </select>
                  <label className="nb2-chk">
                    <input
                      type="checkbox"
                      checked={!!sel.config.refresh}
                      onChange={(e) =>
                        patch(sel.id, { refresh: e.target.checked })
                      }
                    />{" "}
                    Re-flatten on every run (off = reuse the existing tables)
                  </label>
                  <div className="hint">
                    Flattens the table into a base (top-level fields, with
                    single structs inlined), a <code>_flattened</code> records
                    hub, and one <code>_flattened</code> table per nested list.
                    Join a list table to the hub on <code>_rid</code> +{" "}
                    the list ordinal, then to the base on <code>_rid</code>.
                    The OUT port emits the table picked above.
                  </div>
                </>
              )}
              {inspectorType === "input" && (
                <>
                  <label className="nb2-lbl">Table</label>
                  <select
                    className="nb2-in"
                    value={sel.config.table || ""}
                    onChange={(e) =>
                      patch(sel.id, {
                        table: e.target.value,
                        label: e.target.value,
                      })
                    }
                  >
                    <option value="">(pick a table)</option>
                    {tables
                      .filter((t) => !t.remote)
                      .map((t) => (
                        <option key={t.engine + ":" + t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "select" && (
                <>
                  <div className="nb2-row-between">
                    <label className="nb2-lbl" style={{ margin: "10px 0 4px" }}>
                      Fields to keep
                    </label>
                    <div className="nb2-field-acts">
                      <button
                        className="btn ghost sm"
                        title="Keep every visible field"
                        disabled={!(sel.config.fields || []).length}
                        data-testid="select-fields-all"
                        onClick={() => {
                          const all = (sel.config.fields || []) as SelField[];
                          const visible = filterSelectFields(
                            all,
                            selectFieldSearch,
                          );
                          patch(
                            sel.id,
                            {
                              fields: setFieldsKept(
                                all,
                                true,
                                selectFieldSearch.trim()
                                  ? visible.map((f) => f.name)
                                  : null,
                              ),
                            },
                          );
                        }}
                      >
                        All
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Untick every visible field"
                        disabled={!(sel.config.fields || []).length}
                        data-testid="select-fields-none"
                        onClick={() => {
                          const all = (sel.config.fields || []) as SelField[];
                          const visible = filterSelectFields(
                            all,
                            selectFieldSearch,
                          );
                          patch(
                            sel.id,
                            {
                              fields: setFieldsKept(
                                all,
                                false,
                                selectFieldSearch.trim()
                                  ? visible.map((f) => f.name)
                                  : null,
                              ),
                            },
                          );
                        }}
                      >
                        None
                      </button>
                      <button
                        className="btn ghost sm"
                        title={
                          selectFieldSortDir === "asc"
                            ? "Sort fields A→Z"
                            : "Sort fields Z→A"
                        }
                        disabled={!(sel.config.fields || []).length}
                        data-testid="select-fields-sort"
                        onClick={() => {
                          const all = (sel.config.fields || []) as SelField[];
                          patch(sel.id, {
                            fields: sortSelectFields(all, selectFieldSortDir),
                          });
                          setSelectFieldSortDir((d) =>
                            d === "asc" ? "desc" : "asc",
                          );
                        }}
                      >
                        <Icon.SortArrows size={12} /> Sort
                      </button>
                      <button
                        className="btn ghost icon"
                        title="Reload fields from the input"
                        onClick={seedSelectFields}
                      >
                        <Icon.Refresh size={12} />
                      </button>
                    </div>
                  </div>
                  <input
                    className="nb2-in"
                    type="search"
                    data-testid="select-fields-search"
                    placeholder="Search fields…"
                    value={selectFieldSearch}
                    onChange={(e) => setSelectFieldSearch(e.target.value)}
                    disabled={!(sel.config.fields || []).length}
                    title="Filter the field list by name or rename"
                    style={{ marginBottom: 6 }}
                  />
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields and types.
                  </InspColsHint>
                  <div className="nb2-fields">
                    {(() => {
                      const allFields = (sel.config.fields || []) as SelField[];
                      const visible = filterSelectFields(
                        allFields,
                        selectFieldSearch,
                      );
                      const filtering = !!selectFieldSearch.trim();
                      const renderField = (f: SelField, i: number) => (
                        <div className="nb2-field" key={f.name}>
                          <input
                            type="checkbox"
                            checked={f.keep !== false}
                            onChange={(e) =>
                              updateField(i, { keep: e.target.checked })
                            }
                            title="Keep this field"
                          />
                          <span className="nb2-field-name" title={f.name}>
                            {f.name}
                          </span>
                          <select
                            className="nb2-field-type"
                            value={f.type || ""}
                            onChange={(e) =>
                              updateField(i, { type: e.target.value })
                            }
                            title="Change data type"
                          >
                            <option value="">(keep)</option>
                            <option value="text">Text</option>
                            <option value="integer">Integer</option>
                            <option value="decimal">Decimal</option>
                            <option value="date">Date</option>
                            <option value="boolean">Boolean</option>
                          </select>
                          <input
                            className="nb2-field-rename"
                            placeholder="rename…"
                            value={f.rename || ""}
                            onChange={(e) =>
                              updateField(i, { rename: e.target.value })
                            }
                            title="Rename this field (header) — moves with the field when reordered"
                          />
                        </div>
                      );
                      if (filtering) {
                        if (!visible.length) {
                          return (
                            <div className="nb2-note">
                              No fields match “{selectFieldSearch.trim()}”.
                            </div>
                          );
                        }
                        return visible.map((f) => {
                          const i = allFields.findIndex(
                            (x) => x.name === f.name,
                          );
                          return renderField(f, i);
                        });
                      }
                      return (
                        <ReorderList
                          items={allFields as any[]}
                          keyOf={(f: any) => f.name}
                          onChange={(next) => patch(sel.id, { fields: next })}
                          renderItem={(f: any, i: number) =>
                            renderField(f, i)
                          }
                        />
                      );
                    })()}
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "filter" && (() => {
                const cols = inspCols.in || [];
                const fld = sel.config.field || "";
                const op = sel.config.op || ">";
                const val = sel.config.value || "";
                const fmode = sel.config.filterMode
                  ? sel.config.filterMode
                  : sel.config.condition && !fld
                    ? "custom"
                    : "simple";
                const noVal = op === "is null" || op === "is not null";
                const applySimple = (next: {
                  field?: string;
                  op?: string;
                  value?: string;
                }) => {
                  const field = next.field ?? fld;
                  const o = next.op ?? op;
                  const value = next.value ?? val;
                  patch(sel.id, {
                    ...next,
                    filterMode: "simple",
                    condition: buildFilterCond(field, o, value),
                  });
                };
                return (
                  <>
                    <label className="nb2-lbl">Field</label>
                    <select
                      className="nb2-in"
                      data-testid="nodeflow-filter-field"
                      value={fld}
                      disabled={fmode === "custom"}
                      onChange={(e) => applySimple({ field: e.target.value })}
                    >
                      <option value="">(choose a field)</option>
                      {cols.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <label className="nb2-lbl">Filter</label>
                    <select
                      className="nb2-in"
                      data-testid="nodeflow-filter-op"
                      value={op}
                      disabled={fmode === "custom"}
                      onChange={(e) => applySimple({ op: e.target.value })}
                    >
                      <option value="=">equals</option>
                      <option value="!=">does not equal</option>
                      <option value=">">greater than</option>
                      <option value=">=">greater than or equal</option>
                      <option value="<">less than</option>
                      <option value="<=">less than or equal</option>
                      <option value="contains">contains</option>
                      <option value="starts">starts with</option>
                      <option value="ends">ends with</option>
                      <option value="is null">is empty (null)</option>
                      <option value="is not null">is not empty</option>
                    </select>
                    {!noVal && (
                      <input
                        className="nb2-in"
                        data-testid="nodeflow-filter-value"
                        placeholder="value"
                        value={val}
                        disabled={fmode === "custom"}
                        onChange={(e) => applySimple({ value: e.target.value })}
                      />
                    )}
                    <div
                      className={
                        "nb2-filter-toggle" + (fmode === "custom" ? " active" : "")
                      }
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        patch(sel.id, {
                          filterMode: fmode === "custom" ? "simple" : "custom",
                          condition:
                            fmode === "custom"
                              ? buildFilterCond(fld, op, val)
                              : sel.config.condition ||
                                buildFilterCond(fld, op, val),
                        })
                      }
                    >
                      {fmode === "custom"
                        ? "✓ Custom filter logic — click to use the simple filter"
                        : "✎ Write custom filter logic instead…"}
                    </div>
                    {fmode === "custom" && (
                      <div className="nb2-fx-wrap">
                        <textarea
                          ref={(el) => (filterRef.current = el)}
                          className="nb2-in mono nb2-filter-area"
                          rows={3}
                          spellCheck={false}
                          placeholder={"[score] > 50 AND [region] = 'EMEA'"}
                          value={sel.config.condition || ""}
                          onFocus={(e) => filterRecompute(e.currentTarget)}
                          onBlur={() =>
                            window.setTimeout(() => setFilterFx(null), 150)
                          }
                          onClick={(e) => filterRecompute(e.currentTarget)}
                          onKeyUp={(e) => filterRecompute(e.currentTarget)}
                          onChange={(e) => {
                            setFilterCond(e.target.value);
                            filterRecompute(e.currentTarget);
                          }}
                        />
                        {filterFx && (
                          <div className="nb2-fx-suggest">
                            {filterFx.items.slice(0, 8).map((c) => (
                              <button
                                key={c}
                                className="nb2-fx-sg"
                                onMouseDown={(ev) => {
                                  ev.preventDefault();
                                  filterPickField(c);
                                }}
                              >
                                [{c}]
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {fmode === "custom" && (
                      <>
                        <div className="nb2-fx-funcs">
                          {FX_FUNCS.map((fn) => (
                            <button
                              key={fn.label}
                              className="nb2-fx-fn"
                              title={fn.sig}
                              onMouseEnter={() => setFilterHint(fn.sig)}
                              onFocus={() => setFilterHint(fn.sig)}
                              onMouseLeave={() => setFilterHint("")}
                              onMouseDown={(ev) => {
                                ev.preventDefault();
                                filterInsertFunc(fn.tpl);
                                setFilterHint(fn.sig);
                              }}
                            >
                              {fn.label}
                            </button>
                          ))}
                        </div>
                        <div className="nb2-fx-sig">
                          {filterHint ||
                            "Refer to a field as [name]; a workflow variable as {{name}} (text, auto-quoted) or ${name} (raw number)."}
                        </div>
                      </>
                    )}
                    <div className="nb2-note">
                      Rows where this is true go out the <b>True</b> port; the
                      rest (including nulls) go out <b>False</b>.
                      {sel.config.condition ? (
                        <>
                          {" "}
                          SQL: <code>{sel.config.condition}</code>
                        </>
                      ) : null}
                    </div>
                    <div className="nb2-prev-row">
                      <button
                        className="btn sm primary"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "true", `${sel.config.label} · True`)
                        }
                      >
                        Preview True
                      </button>
                      <button
                        className="btn sm"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "false", `${sel.config.label} · False`)
                        }
                      >
                        Preview False
                      </button>
                    </div>
                  </>
                );
              })()}

              {inspectorType === "formula" && (
                <>
                  <label className="nb2-lbl">New / replaced columns</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to overwrite an existing column, or add a
                    new one.
                  </InspColsHint>
                  {(sel.config.formulas || []).map((f: any, i: number) => {
                    const cols = inspCols.in || [];
                    const newMode =
                      f.mode === "new" || (!!f.name && !cols.includes(f.name));
                    const selVal =
                      !newMode && f.name && cols.includes(f.name)
                        ? f.name
                        : newMode
                          ? "__new__"
                          : "";
                    return (
                    <div className="nb2-formula" key={i}>
                      <select
                        className="nb2-in"
                        value={selVal}
                        onChange={(e) => {
                          const v = e.target.value;
                          setFormulas(
                            (sel.config.formulas || []).map(
                              (x: any, j: number) =>
                                j === i
                                  ? v === "__new__"
                                    ? { ...x, mode: "new" }
                                    : { ...x, name: v, mode: undefined }
                                  : x,
                            ),
                          );
                        }}
                      >
                        <option value="">Overwrite a column…</option>
                        {cols.map((c) => (
                          <option key={c} value={c}>
                            Overwrite “{c}”
                          </option>
                        ))}
                        <option value="__new__">+ Add a new column…</option>
                      </select>
                      {newMode && (
                        <input
                          className="nb2-in"
                          placeholder="new column name"
                          value={f.name || ""}
                          onChange={(e) =>
                            setFormulas(
                              (sel.config.formulas || []).map(
                                (x: any, j: number) =>
                                  j === i
                                    ? { ...x, name: e.target.value, mode: "new" }
                                    : x,
                              ),
                            )
                          }
                        />
                      )}
                      <div className="nb2-fx-wrap">
                        <textarea
                          ref={(el) => {
                            // .455: delete on unmount so the ref map
                            // never accumulates dead rows.
                            if (el) fxRefs.current[i] = el;
                            else delete fxRefs.current[i];
                          }}
                          className="nb2-in mono nb2-fx-area"
                          rows={3}
                          spellCheck={false}
                          placeholder={'IF [field] > 0 …  or  UPPER([City])'}
                          value={f.expr || ""}
                          onFocus={(e) => {
                            fxFocus.current = i;
                            fxRecompute(i, e.currentTarget);
                          }}
                          onBlur={() =>
                            window.setTimeout(() => setFxField(null), 150)
                          }
                          onClick={(e) => fxRecompute(i, e.currentTarget)}
                          onKeyUp={(e) => fxRecompute(i, e.currentTarget)}
                          onChange={(e) => {
                            fxSetExpr(i, e.target.value);
                            fxRecompute(i, e.currentTarget);
                          }}
                        />
                        {fxField && fxField.i === i && (
                          <div className="nb2-fx-suggest">
                            {fxField.items.slice(0, 8).map((c) => (
                              <button
                                key={c}
                                className="nb2-fx-sg"
                                // mousedown fires before the textarea blur
                                onMouseDown={(ev) => {
                                  ev.preventDefault();
                                  fxPickField(c);
                                }}
                              >
                                [{c}]
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          className="btn ghost icon nb2-fx-del xbtn"
                          title="Remove formula"
                          onClick={() =>
                            setFormulas(
                              (sel.config.formulas || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      setFormulas([
                        ...(sel.config.formulas || []),
                        { name: "", expr: "", mode: "new" },
                      ])
                    }
                  >
                    <Icon.Plus size={12} /> Add formula
                  </button>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Functions
                  </label>
                  <div className="nb2-fx-funcs">
                    {FX_FUNCS.map((fn) => (
                      <button
                        key={fn.label}
                        className="nb2-fx-fn"
                        title={fn.sig}
                        onMouseEnter={() => setFxHint(fn.sig)}
                        onFocus={() => setFxHint(fn.sig)}
                        onMouseLeave={() => setFxHint("")}
                        onMouseDown={(ev) => {
                          ev.preventDefault();
                          fxInsertFunc(fn.tpl);
                          setFxHint(fn.sig);
                        }}
                      >
                        {fn.label}
                      </button>
                    ))}
                  </div>
                  <div className="nb2-fx-sig" aria-live="polite">
                    {fxHint || "Hover a function to see the parameters it needs."}
                  </div>
                  <div className="nb2-note">
                    Write SQL expressions; refer to a field as{" "}
                    <code>[Field]</code>. Type <code>[</code> for field
                    suggestions; a name matching an existing column replaces it.
                    {inspColsProbing && !inspCols.in
                      ? " Loading fields…"
                      : inspCols.in
                        ? ` Fields: ${inspCols.in.join(", ")}`
                        : " Connect an input to see available fields."}
                  </div>
                  {(() => {
                    // When this formula sits inside an iterator, its loop
                    // variables substitute a value per pass. A text value used
                    // bare (${col1}) becomes a column name -- the #1 confusion
                    // here -- so spell out the variables and the quoting rule.
                    const owner = childSelCtx
                      ? nodes.find((g) => g.id === childSelCtx.groupId)
                      : null;
                    if (!owner || owner.type !== "iterator") return null;
                    const ren =
                      (owner.config.var_rename as Record<string, string>) || {};
                    const vars = Object.entries(ren)
                      .map(([k, v]) => (v || "").trim() || k)
                      .filter(Boolean);
                    if (!vars.length) return null;
                    const tok = (v: string) => "${" + v + "}";
                    const qtok = (v: string) => "{{" + v + "}}";
                    return (
                      <div className="nb2-note">
                        Iterator variables (one per pass):{" "}
                        {vars.map(qtok).join(", ")}. Use{" "}
                        <code>{qtok(vars[0])}</code> for a text value (it
                        auto-quotes); <code>{tok(vars[0])}</code> inserts the raw
                        value (e.g. a number).
                      </div>
                    );
                  })()}
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "summarize" && (
                <>
                  <label className="nb2-lbl">Group by (drag to reorder)</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields.
                  </InspColsHint>
                  <ColumnPicker
                    chosen={(sel.config.group_by || []) as string[]}
                    available={inspCols.in || []}
                    onChange={(next) => patch(sel.id, { group_by: next })}
                    addLabel="+ Add group field…"
                  />
                  <label className="nb2-lbl">Aggregations (drag to reorder)</label>
                  <ReorderList
                    items={(sel.config.aggs || []) as any[]}
                    keyOf={(_a, i) => i}
                    onChange={(next) => setAggs(next)}
                    renderItem={(a: any, i: number) => (
                      <>
                        <select
                          className="nb2-agg-func"
                          value={a.func || "sum"}
                          onChange={(e) =>
                            setAggs(
                              (sel.config.aggs || []).map((x: any, j: number) =>
                                j === i ? { ...x, func: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="sum">Sum</option>
                          <option value="avg">Avg</option>
                          <option value="min">Min</option>
                          <option value="max">Max</option>
                          <option value="count">Count</option>
                          <option value="countd">Count distinct</option>
                        </select>
                        <select
                          className="nb2-agg-col"
                          value={a.col || ""}
                          onChange={(e) =>
                            setAggs(
                              (sel.config.aggs || []).map((x: any, j: number) =>
                                j === i ? { ...x, col: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="">field…</option>
                          {(inspCols.in || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove aggregation"
                          onClick={() =>
                            setAggs(
                              (sel.config.aggs || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      </>
                    )}
                  />
                  <button
                    className="btn sm"
                    onClick={() =>
                      setAggs([...(sel.config.aggs || []), { col: "", func: "sum" }])
                    }
                  >
                    <Icon.Plus size={12} /> Add aggregation
                  </button>
                  <div className="nb2-note">
                    No group-by → a single summary row over all data.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "join" && (
                <>
                  <div className="nb2-note">
                    This join has three outputs. <b>only L</b> = left rows with
                    no match, <b>inner</b> = rows that match (columns from both
                    sides), <b>only R</b> = right rows with no match. Feed
                    <b> inner</b> + <b>only L</b> into a Union for a full left
                    outer join, or <b>inner</b> + <b>only R</b> for a full right
                    outer.
                  </div>
                  <label className="nb2-lbl">Join keys (left = right)</label>
                  <InspColsHint
                    probing={inspColsProbing}
                    ready={!!(inspCols.left && inspCols.right)}
                  >
                    Connect both <b>left</b> and <b>right</b> inputs to pick keys.
                  </InspColsHint>
                  {(sel.config.keys || []).map((k: any, i: number) => (
                    <div className="nb2-keyrow" key={i}>
                      <select
                        className="nb2-key"
                        value={k.left || ""}
                        onChange={(e) =>
                          setKeys(
                            (sel.config.keys || []).map((x: any, j: number) =>
                              j === i ? { ...x, left: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        <option value="">left…</option>
                        {(inspCols.left || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <span className="nb2-eq">=</span>
                      <select
                        className="nb2-key"
                        value={k.right || ""}
                        onChange={(e) =>
                          setKeys(
                            (sel.config.keys || []).map((x: any, j: number) =>
                              j === i ? { ...x, right: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        <option value="">right…</option>
                        {(inspCols.right || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn ghost icon xbtn"
                        title="Remove key"
                        onClick={() =>
                          setKeys(
                            (sel.config.keys || []).filter(
                              (_: any, j: number) => j !== i,
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm"
                    onClick={() =>
                      setKeys([...(sel.config.keys || []), { left: "", right: "" }])
                    }
                  >
                    <Icon.Plus size={12} /> Add key
                  </button>
                  <div className="nb2-note">
                    Inner keeps rows whose keys match in both inputs (columns
                    from both sides); only L / only R are the unmatched rows
                    from each side (that side's columns only).
                  </div>
                  <div className="nb2-prev-row">
                    <button
                      className="btn sm"
                      disabled={running}
                      onClick={() => doPreview(sel, "left_only", `${sel.config.label} · only L`)}
                    >
                      <Icon.Play size={12} /> only L
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={running}
                      onClick={() => doPreview(sel, "inner", `${sel.config.label} · inner`)}
                    >
                      <Icon.Play size={12} /> inner
                    </button>
                    <button
                      className="btn sm"
                      disabled={running}
                      onClick={() => doPreview(sel, "right_only", `${sel.config.label} · only R`)}
                    >
                      <Icon.Play size={12} /> only R
                    </button>
                  </div>
                </>
              )}

              {inspectorType === "multijoin" &&
                (() => {
                  const conn = PORTS.multijoin.inputs.filter((p) =>
                    edges.some(
                      (e) => e.to.node === sel.id && e.to.port === p,
                    ),
                  );
                  const base = conn.includes(sel.config.base)
                    ? sel.config.base
                    : conn[0];
                  const joins = (sel.config.joins || []) as any[];
                  const setJoins = (js: any[]) => patch(sel.id, { joins: js });
                  const portName = (p: string) => PORT_LABEL[p] || p;
                  return (
                    <>
                      <div className="nb2-note">
                        Inner-joins up to 5 inputs. Each added input joins to one
                        already-joined input on its own key(s); different inputs
                        can join on different fields.
                      </div>
                      {conn.length < 2 ? (
                        <div className="nb2-note">
                          Connect at least two inputs (in 1 … in 5) to set up the
                          join.
                        </div>
                      ) : (
                        <>
                          <label className="nb2-lbl">Base input</label>
                          <select
                            className="nb2-in"
                            value={base || ""}
                            onChange={(e) =>
                              patch(sel.id, { base: e.target.value })
                            }
                          >
                            {conn.map((p) => (
                              <option key={p} value={p}>
                                {portName(p)}
                              </option>
                            ))}
                          </select>

                          {joins.map((j: any, i: number) => {
                            const against =
                              j.against ||
                              (i === 0
                                ? base
                                : joins[i - 1] && joins[i - 1].input) ||
                              base;
                            // inputs already placed before this join
                            const placed = [
                              base,
                              ...joins.slice(0, i).map((x: any) => x.input),
                            ].filter(Boolean);
                            const inputOpts = conn.filter(
                              (p) =>
                                p !== base &&
                                (p === j.input ||
                                  !joins.some(
                                    (x: any, k: number) =>
                                      k !== i && x.input === p,
                                  )),
                            );
                            const setJoin = (po: any) =>
                              setJoins(
                                joins.map((x: any, k: number) =>
                                  k === i ? { ...x, ...po } : x,
                                ),
                              );
                            const leftCols = inspCols[against] || [];
                            const rightCols = inspCols[j.input] || [];
                            return (
                              <div className="nb2-mj-join" key={i}>
                                <div className="nb2-mj-head">
                                  <span>Join</span>
                                  <select
                                    className="nb2-key"
                                    value={j.input || ""}
                                    onChange={(e) =>
                                      setJoin({ input: e.target.value })
                                    }
                                  >
                                    <option value="">input…</option>
                                    {inputOpts.map((p) => (
                                      <option key={p} value={p}>
                                        {portName(p)}
                                      </option>
                                    ))}
                                  </select>
                                  <span>to</span>
                                  <select
                                    className="nb2-key"
                                    value={against}
                                    onChange={(e) =>
                                      setJoin({ against: e.target.value })
                                    }
                                  >
                                    {placed.map((p) => (
                                      <option key={p} value={p}>
                                        {portName(p)}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    className="btn ghost icon xbtn"
                                    title="Remove join"
                                    onClick={() =>
                                      setJoins(
                                        joins.filter(
                                          (_: any, k: number) => k !== i,
                                        ),
                                      )
                                    }
                                  >
                                    ×
                                  </button>
                                </div>
                                {(j.on || []).map((pair: any, p: number) => (
                                  <div className="nb2-keyrow" key={p}>
                                    <select
                                      className="nb2-key"
                                      value={pair.left || ""}
                                      onChange={(e) =>
                                        setJoin({
                                          on: (j.on || []).map(
                                            (q: any, m: number) =>
                                              m === p
                                                ? { ...q, left: e.target.value }
                                                : q,
                                          ),
                                        })
                                      }
                                    >
                                      <option value="">
                                        {portName(against)}…
                                      </option>
                                      {leftCols.map((c) => (
                                        <option key={c} value={c}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="nb2-eq">=</span>
                                    <select
                                      className="nb2-key"
                                      value={pair.right || ""}
                                      onChange={(e) =>
                                        setJoin({
                                          on: (j.on || []).map(
                                            (q: any, m: number) =>
                                              m === p
                                                ? { ...q, right: e.target.value }
                                                : q,
                                          ),
                                        })
                                      }
                                    >
                                      <option value="">
                                        {j.input ? portName(j.input) : "input"}…
                                      </option>
                                      {rightCols.map((c) => (
                                        <option key={c} value={c}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                    <button
                                      className="btn ghost icon xbtn"
                                      title="Remove key"
                                      onClick={() =>
                                        setJoin({
                                          on: (j.on || []).filter(
                                            (_: any, m: number) => m !== p,
                                          ),
                                        })
                                      }
                                    >
                                      ×
                                    </button>
                                  </div>
                                ))}
                                <button
                                  className="btn sm ghost"
                                  onClick={() =>
                                    setJoin({
                                      on: [
                                        ...(j.on || []),
                                        { left: "", right: "" },
                                      ],
                                    })
                                  }
                                >
                                  <Icon.Plus size={12} /> Add key
                                </button>
                              </div>
                            );
                          })}

                          <button
                            className="btn sm"
                            style={{ marginTop: 6 }}
                            disabled={joins.length >= conn.length - 1}
                            onClick={() => {
                              const usedInputs = [
                                base,
                                ...joins.map((x: any) => x.input),
                              ];
                              const next = conn.find(
                                (p) => !usedInputs.includes(p),
                              );
                              setJoins([
                                ...joins,
                                {
                                  input: next || "",
                                  against: base,
                                  on: [{ left: "", right: "" }],
                                },
                              ]);
                            }}
                          >
                            <Icon.Plus size={12} /> Add input to join
                          </button>
                          <button
                            className="btn sm primary nb2-prev"
                            disabled={running || !joins.length}
                            onClick={() =>
                              doPreview(
                                sel,
                                "out",
                                `${sel.config.label} · joined`,
                              )
                            }
                          >
                            <Icon.Table size={13} /> Preview output
                          </button>
                        </>
                      )}
                    </>
                  );
                })()}

              {inspectorType === "union" && (
                <>
                  <div className="nb2-note">
                    Stacks all connected inputs (matched up by column name).
                    For an outer join, union a Join (inner matches) with the
                    unmatched rows from an Anti-join on each side.
                  </div>
                  <label className="nb2-lbl">Inputs connected</label>
                  <div className="nb2-note">
                    {PORTS.union.inputs.filter((p) =>
                      edges.some((e) => e.to.node === sel.id && e.to.port === p),
                    ).length || 0}{" "}
                    of 10
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "sort" && (
                <>
                  <label className="nb2-lbl">Sort by (drag to set priority)</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields.
                  </InspColsHint>
                  <ReorderList
                    items={(sel.config.sorts || []) as any[]}
                    keyOf={(_s, i) => i}
                    onChange={(next) => setSorts(next)}
                    renderItem={(srt: any, i: number) => (
                      <>
                        <select
                          className="nb2-agg-col"
                          value={srt.col || ""}
                          onChange={(e) =>
                            setSorts(
                              (sel.config.sorts || []).map((x: any, j: number) =>
                                j === i ? { ...x, col: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="">field…</option>
                          {(inspCols.in || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <select
                          className="nb2-agg-func"
                          value={srt.dir || "asc"}
                          onChange={(e) =>
                            setSorts(
                              (sel.config.sorts || []).map((x: any, j: number) =>
                                j === i ? { ...x, dir: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="asc">Asc ↑</option>
                          <option value="desc">Desc ↓</option>
                        </select>
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            setSorts(
                              (sel.config.sorts || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      </>
                    )}
                  />
                  <button
                    className="btn sm"
                    onClick={() =>
                      setSorts([
                        ...(sel.config.sorts || []),
                        { col: "", dir: "asc" },
                      ])
                    }
                  >
                    <Icon.Plus size={12} /> Add sort field
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "sample" && (
                <>
                  <label className="nb2-lbl">Mode</label>
                  <select
                    className="nb2-in"
                    value={sel.config.mode || "head"}
                    onChange={(e) => patch(sel.id, { mode: e.target.value })}
                  >
                    <option value="head">First N rows</option>
                    <option value="random">Random N rows</option>
                  </select>
                  <label className="nb2-lbl">Number of rows</label>
                  <input
                    className="nb2-in"
                    type="number"
                    min={1}
                    value={sel.config.n ?? 100}
                    onChange={(e) =>
                      patch(sel.id, { n: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "unique" && (
                <>
                  <label className="nb2-lbl">Unique by</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields.
                  </InspColsHint>
                  <div className="nb2-groupby">
                    {(inspCols.in || []).map((c) => (
                      <label className="nb2-gb" key={c}>
                        <input
                          type="checkbox"
                          checked={(sel.config.by || []).includes(c)}
                          onChange={() => toggleInArray("by", c)}
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                  <div className="nb2-note">
                    Keeps one row per distinct combination of the ticked fields.
                    Tick nothing to drop fully-duplicate rows.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "unpivot" && (
                <>
                  <label className="nb2-lbl">Keep as-is (id columns)</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields.
                  </InspColsHint>
                  <div className="nb2-groupby">
                    {(inspCols.in || [])
                      .filter((c) => !(sel.config.unpivot || []).includes(c))
                      .map((c) => (
                        <label className="nb2-gb" key={c}>
                          <input
                            type="checkbox"
                            checked={(sel.config.keep || []).includes(c)}
                            onChange={() => toggleInArray("keep", c)}
                          />
                          {c}
                        </label>
                      ))}
                  </div>
                  <label className="nb2-lbl">Unpivot into rows (value columns)</label>
                  <div className="nb2-groupby">
                    {(inspCols.in || [])
                      .filter((c) => !(sel.config.keep || []).includes(c))
                      .map((c) => (
                        <label className="nb2-gb" key={c}>
                          <input
                            type="checkbox"
                            checked={(sel.config.unpivot || []).includes(c)}
                            onChange={() => toggleInArray("unpivot", c)}
                          />
                          {c}
                        </label>
                      ))}
                  </div>
                  <div className="nb2-prev-row">
                    <input
                      className="nb2-in"
                      placeholder="name column (field)"
                      value={sel.config.name_field || "field"}
                      onChange={(e) => patch(sel.id, { name_field: e.target.value })}
                    />
                    <input
                      className="nb2-in"
                      placeholder="value column (value)"
                      value={sel.config.value_field || "value"}
                      onChange={(e) => patch(sel.id, { value_field: e.target.value })}
                    />
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "window" && (
                <>
                  <label className="nb2-lbl">Window calculations</label>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose fields.
                  </InspColsHint>
                  {(sel.config.windows || []).map((w: any, i: number) => {
                    const upd = (patchw: any) =>
                      setWindows(
                        (sel.config.windows || []).map((x: any, j: number) =>
                          j === i ? { ...x, ...patchw } : x,
                        ),
                      );
                    const needsCol = !["row_number", "rank", "dense_rank"].includes(
                      w.func || "running_sum",
                    );
                    return (
                      <div className="nb2-window" key={i}>
                        <div className="nb2-prev-row">
                          <input
                            className="nb2-in"
                            placeholder="new column name"
                            value={w.name || ""}
                            onChange={(e) => upd({ name: e.target.value })}
                          />
                          <button
                            className="btn ghost icon xbtn"
                            title="Remove calculation"
                            onClick={() =>
                              setWindows(
                                (sel.config.windows || []).filter(
                                  (_: any, j: number) => j !== i,
                                ),
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                        <div className="nb2-prev-row">
                          <select
                            className="nb2-agg-func"
                            value={w.func || "running_sum"}
                            onChange={(e) => upd({ func: e.target.value })}
                          >
                            <option value="running_sum">Running sum</option>
                            <option value="running_avg">Running avg</option>
                            <option value="running_min">Running min</option>
                            <option value="running_max">Running max</option>
                            <option value="running_count">Running count</option>
                            <option value="row_number">Row number</option>
                            <option value="rank">Rank</option>
                            <option value="dense_rank">Dense rank</option>
                            <option value="lag">Lag</option>
                            <option value="lead">Lead</option>
                          </select>
                          <select
                            className="nb2-agg-col"
                            value={w.col || ""}
                            disabled={!needsCol}
                            onChange={(e) => upd({ col: e.target.value })}
                          >
                            <option value="">{needsCol ? "field…" : "—"}</option>
                            {(inspCols.in || []).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="nb2-win-lbl">Partition by</div>
                        <div className="nb2-groupby">
                          {(inspCols.in || []).map((c) => (
                            <label className="nb2-gb" key={c}>
                              <input
                                type="checkbox"
                                checked={(w.partition_by || []).includes(c)}
                                onChange={() =>
                                  upd({
                                    partition_by: (w.partition_by || []).includes(c)
                                      ? (w.partition_by || []).filter(
                                          (x: string) => x !== c,
                                        )
                                      : [...(w.partition_by || []), c],
                                  })
                                }
                              />
                              {c}
                            </label>
                          ))}
                        </div>
                        <div className="nb2-win-lbl">Order by</div>
                        <div className="nb2-prev-row">
                          <select
                            className="nb2-agg-col"
                            value={(w.order_by && w.order_by[0]?.col) || ""}
                            onChange={(e) =>
                              upd({
                                order_by: [
                                  {
                                    col: e.target.value,
                                    dir:
                                      (w.order_by && w.order_by[0]?.dir) || "asc",
                                  },
                                ],
                              })
                            }
                          >
                            <option value="">(none)</option>
                            {(inspCols.in || []).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select
                            className="nb2-agg-func"
                            value={(w.order_by && w.order_by[0]?.dir) || "asc"}
                            onChange={(e) =>
                              upd({
                                order_by: [
                                  {
                                    col: (w.order_by && w.order_by[0]?.col) || "",
                                    dir: e.target.value,
                                  },
                                ],
                              })
                            }
                          >
                            <option value="asc">Asc ↑</option>
                            <option value="desc">Desc ↓</option>
                          </select>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      setWindows([
                        ...(sel.config.windows || []),
                        {
                          func: "running_sum",
                          col: "",
                          name: "",
                          partition_by: [],
                          order_by: [{ col: "", dir: "asc" }],
                        },
                      ])
                    }
                  >
                    <Icon.Plus size={12} /> Add calculation
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "perioddelta" && (
                <>
                  <div className="nb2-note">
                    Compare each value with an earlier period, optionally within
                    groups. The input remains intact and the result is added as
                    a new column.
                  </div>
                  <label className="nb2-lbl">Value field</label>
                  <select
                    className="nb2-in"
                    value={sel.config.value || ""}
                    onChange={(e) => patch(sel.id, { value: e.target.value })}
                  >
                    <option value="">(pick value)</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <label className="nb2-lbl">Period / order field</label>
                  <select
                    className="nb2-in"
                    value={sel.config.order || ""}
                    onChange={(e) => patch(sel.id, { order: e.target.value })}
                  >
                    <option value="">(pick period)</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div className="nb2-row2">
                    <div>
                      <label className="nb2-lbl">Calculation</label>
                      <select
                        className="nb2-in"
                        value={sel.config.mode || "absolute"}
                        onChange={(e) => {
                          const mode = e.target.value;
                          const defaults: Record<string, string> = {
                            absolute: "period_change",
                            percent: "period_change_pct",
                            previous: "previous_value",
                            running_total: "running_total",
                          };
                          patch(sel.id, { mode, out: defaults[mode] || sel.config.out });
                        }}
                      >
                        <option value="absolute">Absolute change</option>
                        <option value="percent">Percent change</option>
                        <option value="previous">Previous value</option>
                        <option value="running_total">Running total</option>
                      </select>
                    </div>
                    <div>
                      <label className="nb2-lbl">Direction</label>
                      <select
                        className="nb2-in"
                        value={sel.config.dir || "asc"}
                        onChange={(e) => patch(sel.id, { dir: e.target.value })}
                      >
                        <option value="asc">Ascending</option>
                        <option value="desc">Descending</option>
                      </select>
                    </div>
                  </div>
                  <div className="nb2-row2">
                    <div>
                      <label className="nb2-lbl">Periods back</label>
                      <input
                        className="nb2-in"
                        type="number"
                        min={1}
                        value={sel.config.offset ?? 1}
                        onChange={(e) => patch(sel.id, { offset: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </div>
                    <div>
                      <label className="nb2-lbl">Output column</label>
                      <input
                        className="nb2-in"
                        value={sel.config.out || ""}
                        onChange={(e) => patch(sel.id, { out: e.target.value })}
                      />
                    </div>
                  </div>
                  <label className="nb2-lbl">Restart for each (optional)</label>
                  <div className="nb2-groupby">
                    {(inspCols.in || []).map((c) => {
                      const on = (sel.config.partition || []).includes(c);
                      return (
                        <label key={c} className="nb2-gb">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleInArray("partition", c)}
                          />
                          {c}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doPreview(sel, "out", `${sel.config.label} · output`)}
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "pivot" &&
                (() => {
                  const prows = sel.config.rows || [];
                  const pcols =
                    sel.config.cols !== undefined
                      ? sel.config.cols
                      : sel.config.col
                      ? [sel.config.col]
                      : [];
                  const measures =
                    sel.config.values !== undefined
                      ? sel.config.values
                      : [
                          {
                            field: sel.config.value || "",
                            agg: sel.config.agg || "sum",
                          },
                        ];
                  const avail = inspCols.in || [];
                  const addable = (chosen: string[]) =>
                    avail.filter((c) => !chosen.includes(c));
                  const setMeasures = (vs: any[]) =>
                    patch(sel.id, { values: vs });
                  return (
                    <>
                      <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                        Connect an input to choose fields.
                      </InspColsHint>
                      <label className="nb2-lbl">Rows (drag to reorder)</label>
                      {prows.length > 0 && (
                        <ReorderList
                          items={prows as string[]}
                          keyOf={(c) => c}
                          onChange={(next) => patch(sel.id, { rows: next })}
                          renderItem={(c) => (
                            <>
                              <span className="nb2-reorder-name">{c}</span>
                              <button
                                className="btn ghost icon xbtn"
                                title="Remove"
                                onClick={() =>
                                  patch(sel.id, {
                                    rows: prows.filter((x: string) => x !== c),
                                  })
                                }
                              >
                                ×
                              </button>
                            </>
                          )}
                        />
                      )}
                      {addable(prows).length > 0 && (
                        <select
                          className="nb2-in nb2-addfield"
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              patch(sel.id, { rows: [...prows, e.target.value] });
                          }}
                        >
                          <option value="">+ Add row field…</option>
                          {addable(prows).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                      <label className="nb2-lbl">Columns (drag to reorder)</label>
                      {pcols.length > 0 && (
                        <ReorderList
                          items={pcols as string[]}
                          keyOf={(c) => c}
                          onChange={(next) => patch(sel.id, { cols: next })}
                          renderItem={(c) => (
                            <>
                              <span className="nb2-reorder-name">{c}</span>
                              <button
                                className="btn ghost icon xbtn"
                                title="Remove"
                                onClick={() =>
                                  patch(sel.id, {
                                    cols: pcols.filter((x: string) => x !== c),
                                  })
                                }
                              >
                                ×
                              </button>
                            </>
                          )}
                        />
                      )}
                      {addable(pcols).length > 0 && (
                        <select
                          className="nb2-in nb2-addfield"
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              patch(sel.id, { cols: [...pcols, e.target.value] });
                          }}
                        >
                          <option value="">+ Add column field…</option>
                          {addable(pcols).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                      <label className="nb2-lbl">Measures (drag to reorder)</label>
                      <ReorderList
                        items={measures}
                        keyOf={(_m, i) => i}
                        onChange={(next) => setMeasures(next)}
                        renderItem={(mv: any, i: number) => (
                          <>
                            <select
                              className="nb2-agg-func"
                              value={mv.agg || "sum"}
                              onChange={(e) => {
                                const vs = measures.map((x: any) => ({ ...x }));
                                vs[i].agg = e.target.value;
                                setMeasures(vs);
                              }}
                            >
                              <option value="sum">Sum</option>
                              <option value="avg">Avg</option>
                              <option value="min">Min</option>
                              <option value="max">Max</option>
                              <option value="count">Count</option>
                            </select>
                            <select
                              className="nb2-agg-col"
                              value={mv.field || ""}
                              onChange={(e) => {
                                const vs = measures.map((x: any) => ({ ...x }));
                                vs[i].field = e.target.value;
                                setMeasures(vs);
                              }}
                            >
                              <option value="">(count rows)</option>
                              {avail.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            {measures.length > 1 && (
                              <button
                                className="btn ghost icon xbtn"
                                title="Remove measure"
                                onClick={() =>
                                  setMeasures(
                                    measures.filter(
                                      (_: any, j: number) => j !== i,
                                    ),
                                  )
                                }
                              >
                                ×
                              </button>
                            )}
                          </>
                        )}
                      />
                      <button
                        className="btn sm ghost"
                        onClick={() =>
                          setMeasures([...measures, { field: "", agg: "sum" }])
                        }
                      >
                        <Icon.Plus size={13} /> Add measure
                      </button>
                      <label className="nb2-check" style={{ marginTop: 8 }}>
                        <input
                          type="checkbox"
                          checked={!!sel.config.subtotals}
                          onChange={(e) =>
                            patch(sel.id, { subtotals: e.target.checked })
                          }
                        />{" "}
                        Subtotals &amp; grand totals
                      </label>
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!sel.config.outline}
                          onChange={(e) =>
                            patch(sel.id, { outline: e.target.checked })
                          }
                        />{" "}
                        Indented sub-rows (outline)
                      </label>
                      <button
                        className="btn sm primary nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "out", `${sel.config.label} · output`)
                        }
                      >
                        <Icon.Table size={13} /> Preview output
                      </button>
                    </>
                  );
                })()}

              {inspectorType === "dedupe" && (
                <>
                  <div className="nb2-note">
                    Keep one row per key. Choose a tiebreaker field and whether to
                    keep the first or last by it.
                  </div>
                  <label className="nb2-lbl">Key columns (one row per…)</label>
                  <div className="nb2-checks">
                    {(inspCols.in || []).map((c) => {
                      const on = (sel.config.keys || []).includes(c);
                      return (
                        <label key={c} className="nb2-check">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = sel.config.keys || [];
                              patch(sel.id, {
                                keys: on
                                  ? cur.filter((x: string) => x !== c)
                                  : [...cur, c],
                              });
                            }}
                          />{" "}
                          {c}
                        </label>
                      );
                    })}
                  </div>
                  <div className="nb2-row2">
                    <div>
                      <label className="nb2-lbl">Tiebreaker (optional)</label>
                      <select
                        className="nb2-in"
                        value={sel.config.sort || ""}
                        onChange={(e) => patch(sel.id, { sort: e.target.value })}
                      >
                        <option value="">(any row)</option>
                        {(inspCols.in || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="nb2-lbl">Keep</label>
                      <select
                        className="nb2-in"
                        value={sel.config.keep || "first"}
                        onChange={(e) => patch(sel.id, { keep: e.target.value })}
                      >
                        <option value="first">First</option>
                        <option value="last">Last</option>
                      </select>
                    </div>
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "split" && (
                <>
                  <label className="nb2-lbl">Column to split</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl">Delimiter</label>
                  <input
                    className="nb2-in"
                    value={sel.config.delim ?? ""}
                    placeholder=", or - or |"
                    onChange={(e) => patch(sel.id, { delim: e.target.value })}
                  />
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    New column names (in order)
                  </label>
                  {(sel.config.names || []).map((nm: string, i: number) => (
                    <div key={i} className="nb2-row2">
                      <input
                        className="nb2-in"
                        value={nm}
                        onChange={(e) => {
                          const names = [...(sel.config.names || [])];
                          names[i] = e.target.value;
                          patch(sel.id, { names });
                        }}
                      />
                      <button
                        className="btn ghost icon xbtn"
                        title="Remove"
                        onClick={() =>
                          patch(sel.id, {
                            names: (sel.config.names || []).filter(
                              (_: any, j: number) => j !== i,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      patch(sel.id, {
                        names: [
                          ...(sel.config.names || []),
                          `part_${(sel.config.names || []).length + 1}`,
                        ],
                      })
                    }
                  >
                    + Add part
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "validate" && (
                <>
                  <div className="nb2-note">
                    Checks the incoming data and reports pass/fail. Data passes
                    through unchanged, so you can keep wiring downstream.
                  </div>
                  {(sel.config.checks || []).map((chk: any, i: number) => {
                    const setChk = (patchObj: any) => {
                      const checks = [...(sel.config.checks || [])];
                      checks[i] = { ...checks[i], ...patchObj };
                      patch(sel.id, { checks });
                    };
                    return (
                      <div key={i} className="nb2-fill-row">
                        <div className="nb2-row2">
                          <select
                            className="nb2-in"
                            value={chk.type || "not_null"}
                            onChange={(e) => setChk({ type: e.target.value })}
                          >
                            <option value="not_null">No nulls in</option>
                            <option value="unique">Unique values in</option>
                            <option value="rows_min">At least N rows</option>
                            <option value="rows_max">At most N rows</option>
                          </select>
                          <button
                            className="btn ghost icon xbtn"
                            title="Remove"
                            onClick={() =>
                              patch(sel.id, {
                                checks: (sel.config.checks || []).filter(
                                  (_: any, j: number) => j !== i,
                                ),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                        {chk.type === "rows_min" || chk.type === "rows_max" ? (
                          <input
                            className="nb2-in"
                            type="number"
                            placeholder="N"
                            value={chk.n ?? ""}
                            onChange={(e) => setChk({ n: e.target.value })}
                          />
                        ) : (
                          <select
                            className="nb2-in"
                            value={chk.col || ""}
                            onChange={(e) => setChk({ col: e.target.value })}
                          >
                            <option value="">Pick a column…</option>
                            {(inspCols.in || []).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      patch(sel.id, {
                        checks: [
                          ...(sel.config.checks || []),
                          { type: "not_null", col: "" },
                        ],
                      })
                    }
                  >
                    + Add check
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doValidate(sel)}
                  >
                    <Icon.Bookmark size={13} /> Run checks
                  </button>
                  {(() => {
                    const vr = validateResults[sel.id];
                    if (!vr) return null;
                    if (vr.loading)
                      return <div className="nb2-note">Running checks…</div>;
                    if (vr.error)
                      return <div className="nb2-note">{vr.error}</div>;
                    return (
                      <div className="nb2-vresults">
                        <div className="nb2-note">
                          {(vr.total_rows ?? 0).toLocaleString()} rows ·{" "}
                          {vr.ok ? "all checks passed" : "some checks failed"}
                        </div>
                        {(vr.results || []).map((r, i) => (
                          <div
                            key={i}
                            className={"nb2-vrow " + (r.pass ? "ok" : "bad")}
                          >
                            <span>{r.pass ? "✓" : "✗"}</span>
                            <span className="nb2-vrow-t">
                              {r.type} {r.target}
                            </span>
                            <span className="nb2-vrow-d">{r.detail}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </>
              )}

              {inspectorType === "jsonextract" && (
                <>
                  <div className="nb2-note">
                    Pulls fields out of a JSON text column into new columns. Use
                    a path like <code>user.name</code> or{" "}
                    <code>items[0].id</code> (a leading <code>$.</code> is added
                    for you).
                  </div>
                  <label className="nb2-lbl">JSON column</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Extract (path → new column)
                  </label>
                  {(sel.config.extracts || []).map((ex: any, i: number) => {
                    const setEx = (po: any) =>
                      patch(sel.id, {
                        extracts: (sel.config.extracts || []).map(
                          (x: any, j: number) => (j === i ? { ...x, ...po } : x),
                        ),
                      });
                    return (
                      <div className="nb2-keyrow" key={i}>
                        <input
                          className="nb2-key"
                          placeholder="user.name"
                          value={ex.path || ""}
                          onChange={(e) => setEx({ path: e.target.value })}
                        />
                        <span className="nb2-eq">→</span>
                        <input
                          className="nb2-key"
                          placeholder="column name"
                          value={ex.name || ""}
                          onChange={(e) => setEx({ name: e.target.value })}
                        />
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            patch(sel.id, {
                              extracts: (sel.config.extracts || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        extracts: [
                          ...(sel.config.extracts || []),
                          { path: "", name: "" },
                        ],
                      })
                    }
                  >
                    <Icon.Plus size={12} /> Add field
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "explode" && (
                <>
                  <div className="nb2-note">
                    Turns one row into many — one per element of an array or list
                    in the chosen column. The other columns are repeated on each
                    new row. (Empty arrays/lists drop the row.)
                  </div>
                  <label className="nb2-lbl">Column to explode</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {sel.config.mode === "nested" && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        …or a nested field path
                      </label>
                      <input
                        className="nb2-in"
                        value={sel.config.col || ""}
                        placeholder="e.g. json[1].receivingLeg"
                        onChange={(e) =>
                          patch(sel.id, { col: e.target.value })
                        }
                        spellCheck={false}
                      />
                      <div className="nb2-note" style={{ marginTop: 6 }}>
                        UNNEST(…, recursive := true): explodes the list into
                        rows and every nested list/struct inside each element
                        into columns, all the way down. DuckDB only. The
                        path's base column is dropped from the output.
                      </div>
                    </>
                  )}
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Source format
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.mode || "json"}
                    onChange={(e) => patch(sel.id, { mode: e.target.value })}
                  >
                    <option value="json">JSON array — e.g. ["a","b","c"]</option>
                    <option value="delim">Delimited text — e.g. a,b,c</option>
                    <option value="nested">
                      Nested list (recursive) — native LIST/STRUCT, DuckDB
                    </option>
                  </select>
                  {sel.config.mode === "delim" && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Delimiter
                      </label>
                      <input
                        className="nb2-in"
                        value={sel.config.delim ?? ","}
                        placeholder=","
                        onChange={(e) => patch(sel.id, { delim: e.target.value })}
                      />
                    </>
                  )}
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Output column (optional)
                  </label>
                  <input
                    className="nb2-in"
                    placeholder={sel.config.col || "same as source column"}
                    value={sel.config.name || ""}
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "textclean" && (
                <>
                  <div className="nb2-note">
                    Cleans the selected text columns in place by applying the
                    steps below, in order — including filling blanks (nulls)
                    with a value or a column statistic.
                  </div>
                  <div className="nb2-row-between">
                    <label className="nb2-lbl" style={{ margin: "10px 0 4px" }}>
                      Columns to clean
                    </label>
                    <div className="nb2-field-acts">
                      <button
                        className="btn ghost sm"
                        title="Clean every column"
                        disabled={!(inspCols.in || []).length}
                        onClick={() =>
                          patch(sel.id, { cols: [...(inspCols.in || [])] })
                        }
                      >
                        All
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Clear the selection"
                        disabled={!(sel.config.cols || []).length}
                        onClick={() => patch(sel.id, { cols: [] })}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose columns.
                  </InspColsHint>
                  <div className="nb2-groupby">
                    {(inspCols.in || []).map((c) => (
                      <label className="nb2-gb" key={c}>
                        <input
                          type="checkbox"
                          checked={(sel.config.cols || []).includes(c)}
                          onChange={() =>
                            patch(sel.id, {
                              cols: (sel.config.cols || []).includes(c)
                                ? (sel.config.cols || []).filter(
                                    (x: string) => x !== c,
                                  )
                                : [...(sel.config.cols || []), c],
                            })
                          }
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Cleaning steps
                  </label>
                  {(sel.config.ops || []).map((op: any, i: number) => {
                    const setOp = (po: any) =>
                      patch(sel.id, {
                        ops: (sel.config.ops || []).map((x: any, j: number) =>
                          j === i ? { ...x, ...po } : x,
                        ),
                      });
                    const kind = op.op || "trim";
                    return (
                      <div className="nb2-tc-op" key={i}>
                        <div className="nb2-tc-oprow">
                          <select
                            className="nb2-in"
                            value={kind}
                            onChange={(e) => setOp({ op: e.target.value })}
                          >
                            <option value="trim">Trim spaces</option>
                            <option value="ltrim">Trim left</option>
                            <option value="rtrim">Trim right</option>
                            <option value="upper">UPPERCASE</option>
                            <option value="lower">lowercase</option>
                            <option value="fillnull">Fill blanks (nulls)</option>
                            <option value="replace">Replace text</option>
                            <option value="substring">Substring</option>
                            <option value="padleft">Pad left</option>
                            <option value="padright">Pad right</option>
                          </select>
                          <button
                            className="btn ghost icon xbtn"
                            title="Remove step"
                            onClick={() =>
                              patch(sel.id, {
                                ops: (sel.config.ops || []).filter(
                                  (_: any, j: number) => j !== i,
                                ),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                        {kind === "replace" && (
                          <div className="nb2-keyrow">
                            <input
                              className="nb2-key"
                              placeholder="find"
                              value={op.find || ""}
                              onChange={(e) => setOp({ find: e.target.value })}
                            />
                            <span className="nb2-eq">→</span>
                            <input
                              className="nb2-key"
                              placeholder="replace with"
                              value={op.replace || ""}
                              onChange={(e) => setOp({ replace: e.target.value })}
                            />
                          </div>
                        )}
                        {kind === "substring" && (
                          <div className="nb2-keyrow">
                            <input
                              className="nb2-key"
                              type="number"
                              placeholder="start (1-based)"
                              value={op.start ?? ""}
                              onChange={(e) => setOp({ start: e.target.value })}
                            />
                            <span className="nb2-eq">len</span>
                            <input
                              className="nb2-key"
                              type="number"
                              placeholder="(to end)"
                              value={op.length ?? ""}
                              onChange={(e) => setOp({ length: e.target.value })}
                            />
                          </div>
                        )}
                        {(kind === "padleft" || kind === "padright") && (
                          <div className="nb2-keyrow">
                            <input
                              className="nb2-key"
                              type="number"
                              placeholder="width"
                              value={op.n ?? ""}
                              onChange={(e) => setOp({ n: e.target.value })}
                            />
                            <span className="nb2-eq">with</span>
                            <input
                              className="nb2-key"
                              maxLength={1}
                              placeholder="(space)"
                              value={op.char || ""}
                              onChange={(e) => setOp({ char: e.target.value })}
                            />
                          </div>
                        )}
                        {kind === "fillnull" && (
                          <div className="nb2-keyrow">
                            <select
                              className="nb2-key"
                              value={op.method || "value"}
                              onChange={(e) => setOp({ method: e.target.value })}
                            >
                              <option value="value">A value</option>
                              <option value="zero">Zero</option>
                              <option value="empty">Empty text</option>
                              <option value="avg">Average</option>
                              <option value="min">Minimum</option>
                              <option value="max">Maximum</option>
                            </select>
                            {(op.method || "value") === "value" && (
                              <input
                                className="nb2-key"
                                placeholder="fill value"
                                value={op.value || ""}
                                onChange={(e) => setOp({ value: e.target.value })}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        ops: [...(sel.config.ops || []), { op: "trim" }],
                      })
                    }
                  >
                    <Icon.Plus size={12} /> Add step
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "antijoin" && (
                <>
                  <div className="nb2-note">
                    Keeps rows from the <b>left</b> input based on matches in the{" "}
                    <b>right</b> — <b>anti</b> = rows with no match, <b>semi</b> =
                    rows that have one. Only the left columns come through.
                  </div>
                  <label className="nb2-lbl">Mode</label>
                  <select
                    className="nb2-in"
                    value={sel.config.mode || "anti"}
                    onChange={(e) => patch(sel.id, { mode: e.target.value })}
                  >
                    <option value="anti">Anti — left rows NOT in right</option>
                    <option value="semi">Semi — left rows that ARE in right</option>
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Key pairs (left = right)
                  </label>
                  {(sel.config.keys || []).map((k: any, i: number) => {
                    const setK = (po: any) =>
                      patch(sel.id, {
                        keys: (sel.config.keys || []).map((x: any, j: number) =>
                          j === i ? { ...x, ...po } : x,
                        ),
                      });
                    return (
                      <div className="nb2-keyrow" key={i}>
                        <select
                          className="nb2-key"
                          value={k.left || ""}
                          onChange={(e) => setK({ left: e.target.value })}
                        >
                          <option value="">left…</option>
                          {(inspCols.left || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <span className="nb2-eq">=</span>
                        <select
                          className="nb2-key"
                          value={k.right || ""}
                          onChange={(e) => setK({ right: e.target.value })}
                        >
                          <option value="">right…</option>
                          {(inspCols.right || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            patch(sel.id, {
                              keys: (sel.config.keys || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        keys: [...(sel.config.keys || []), { left: "", right: "" }],
                      })
                    }
                  >
                    <Icon.Plus size={12} /> Add key pair
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "groupconcat" && (
                <>
                  <div className="nb2-note">
                    Collapses rows into one delimited value per group — the
                    inverse of Explode. Leave the group empty to roll the whole
                    table into a single value.
                  </div>
                  <label className="nb2-lbl">
                    Group by (optional, drag to reorder)
                  </label>
                  <ColumnPicker
                    chosen={(sel.config.group || []) as string[]}
                    available={inspCols.in || []}
                    onChange={(next) => patch(sel.id, { group: next })}
                    addLabel="+ Add group field…"
                  />
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Column to concatenate
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Separator
                  </label>
                  <input
                    className="nb2-in"
                    value={sel.config.delim ?? ", "}
                    placeholder=", "
                    onChange={(e) => patch(sel.id, { delim: e.target.value })}
                  />
                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={!!sel.config.distinct}
                      onChange={(e) =>
                        patch(sel.id, { distinct: e.target.checked })
                      }
                    />{" "}
                    Distinct values only
                  </label>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Output column (optional)
                  </label>
                  <input
                    className="nb2-in"
                    placeholder={sel.config.col ? sel.config.col + "_list" : "list"}
                    value={sel.config.name || ""}
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "date" && (
                <>
                  <div className="nb2-note">
                    Pull a part out of a date/time column, truncate it to a
                    period, or get the difference from another date.
                  </div>
                  <label className="nb2-lbl">Date / time column</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Operation
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.op || "part"}
                    onChange={(e) => patch(sel.id, { op: e.target.value })}
                  >
                    <option value="part">Extract part</option>
                    <option value="trunc">Truncate to</option>
                    <option value="diff">Difference (in units)</option>
                  </select>
                  {(sel.config.op || "part") === "part" && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Part
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.part || "year"}
                        onChange={(e) => patch(sel.id, { part: e.target.value })}
                      >
                        <option value="year">Year</option>
                        <option value="quarter">Quarter</option>
                        <option value="month">Month</option>
                        <option value="week">Week of year</option>
                        <option value="day">Day</option>
                        <option value="dayofyear">Day of year</option>
                        <option value="weekday">Weekday (0 = Sun)</option>
                        <option value="hour">Hour</option>
                        <option value="minute">Minute</option>
                        <option value="second">Second</option>
                      </select>
                    </>
                  )}
                  {sel.config.op === "trunc" && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Truncate to
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.unit || "month"}
                        onChange={(e) => patch(sel.id, { unit: e.target.value })}
                      >
                        <option value="year">Year</option>
                        <option value="month">Month</option>
                        <option value="day">Day</option>
                        <option value="hour">Hour</option>
                      </select>
                    </>
                  )}
                  {sel.config.op === "diff" && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Units
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.unit || "day"}
                        onChange={(e) => patch(sel.id, { unit: e.target.value })}
                      >
                        <option value="day">Days</option>
                        <option value="hour">Hours</option>
                        <option value="minute">Minutes</option>
                        <option value="second">Seconds</option>
                      </select>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Compared to
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.other || ""}
                        onChange={(e) => patch(sel.id, { other: e.target.value })}
                      >
                        <option value="">Now (current time)</option>
                        {(inspCols.in || [])
                          .filter((c) => c !== sel.config.col)
                          .map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                      </select>
                    </>
                  )}
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Output column (optional)
                  </label>
                  <input
                    className="nb2-in"
                    placeholder="auto"
                    value={sel.config.name || ""}
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "maprecode" && (
                <>
                  <div className="nb2-note">
                    Remaps values in a column (e.g. NY → New York). Unmapped
                    values pass through unchanged, or fall back to a default.
                  </div>
                  <label className="nb2-lbl">Column to remap</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Rules (value → new value)
                  </label>
                  {(sel.config.mappings || []).map((m: any, i: number) => {
                    const setM = (po: any) =>
                      patch(sel.id, {
                        mappings: (sel.config.mappings || []).map(
                          (x: any, j: number) => (j === i ? { ...x, ...po } : x),
                        ),
                      });
                    return (
                      <div className="nb2-keyrow" key={i}>
                        <input
                          className="nb2-key"
                          placeholder="value"
                          value={m.from ?? ""}
                          onChange={(e) => setM({ from: e.target.value })}
                        />
                        <span className="nb2-eq">→</span>
                        <input
                          className="nb2-key"
                          placeholder="new value"
                          value={m.to ?? ""}
                          onChange={(e) => setM({ to: e.target.value })}
                        />
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            patch(sel.id, {
                              mappings: (sel.config.mappings || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        mappings: [
                          ...(sel.config.mappings || []),
                          { from: "", to: "" },
                        ],
                      })
                    }
                  >
                    <Icon.Plus size={12} /> Add rule
                  </button>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Unmatched values
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.default || "passthrough"}
                    onChange={(e) => patch(sel.id, { default: e.target.value })}
                  >
                    <option value="passthrough">Keep original</option>
                    <option value="value">Replace with…</option>
                  </select>
                  {sel.config.default === "value" && (
                    <input
                      className="nb2-in"
                      style={{ marginTop: 6 }}
                      placeholder="default value"
                      value={sel.config.default_value || ""}
                      onChange={(e) =>
                        patch(sel.id, { default_value: e.target.value })
                      }
                    />
                  )}
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Output column (optional)
                  </label>
                  <input
                    className="nb2-in"
                    placeholder={sel.config.col || "same as source column"}
                    value={sel.config.name || ""}
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "parse" && (
                <>
                  <div className="nb2-note">
                    Parses the selected text columns into a number or date, in
                    place. Numbers strip the grouping separator first.
                  </div>
                  <div className="nb2-row-between">
                    <label className="nb2-lbl" style={{ margin: "10px 0 4px" }}>
                      Columns to parse
                    </label>
                    <div className="nb2-field-acts">
                      <button
                        className="btn ghost sm"
                        title="Parse every column"
                        disabled={!(inspCols.in || []).length}
                        onClick={() =>
                          patch(sel.id, { cols: [...(inspCols.in || [])] })
                        }
                      >
                        All
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Clear the selection"
                        disabled={!(sel.config.cols || []).length}
                        onClick={() => patch(sel.id, { cols: [] })}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <InspColsHint probing={inspColsProbing} ready={!!inspCols.in}>
                    Connect an input to choose columns.
                  </InspColsHint>
                  <div className="nb2-groupby">
                    {(inspCols.in || []).map((c) => (
                      <label className="nb2-gb" key={c}>
                        <input
                          type="checkbox"
                          checked={(sel.config.cols || []).includes(c)}
                          onChange={() =>
                            patch(sel.id, {
                              cols: (sel.config.cols || []).includes(c)
                                ? (sel.config.cols || []).filter(
                                    (x: string) => x !== c,
                                  )
                                : [...(sel.config.cols || []), c],
                            })
                          }
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Parse to
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.to || "number"}
                    onChange={(e) => patch(sel.id, { to: e.target.value })}
                  >
                    <option value="number">Number (decimal)</option>
                    <option value="integer">Integer</option>
                    <option value="date">Date</option>
                    <option value="datetime">Date &amp; time</option>
                  </select>
                  {(sel.config.to === "number" ||
                    sel.config.to === "integer" ||
                    !sel.config.to) && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Thousands separator to strip
                      </label>
                      <input
                        className="nb2-in"
                        value={sel.config.group ?? ","}
                        placeholder=","
                        onChange={(e) => patch(sel.id, { group: e.target.value })}
                      />
                    </>
                  )}
                  {(sel.config.to === "date" ||
                    sel.config.to === "datetime") && (
                    <>
                      <label className="nb2-lbl" style={{ marginTop: 8 }}>
                        Format (DuckDB only; e.g. %d/%m/%Y)
                      </label>
                      <input
                        className="nb2-in"
                        value={sel.config.format || ""}
                        placeholder="%d/%m/%Y"
                        onChange={(e) =>
                          patch(sel.id, { format: e.target.value })
                        }
                      />
                      <div className="nb2-note">
                        On SQLite the column must already be ISO-ish
                        (YYYY-MM-DD); the format applies on DuckDB.
                      </div>
                    </>
                  )}
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "topn" && (
                <>
                  <div className="nb2-note">
                    Keeps the top N rows per group, ordered by a column (e.g. top
                    3 orders per customer). Leave the group empty for an overall
                    top N.
                  </div>
                  <label className="nb2-lbl">
                    Group by (optional, drag to reorder)
                  </label>
                  <ColumnPicker
                    chosen={(sel.config.group || []) as string[]}
                    available={inspCols.in || []}
                    onChange={(next) => patch(sel.id, { group: next })}
                    addLabel="+ Add group field…"
                  />
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Rank by
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.sort || ""}
                    onChange={(e) => patch(sel.id, { sort: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={sel.config.desc !== false}
                      onChange={(e) => patch(sel.id, { desc: e.target.checked })}
                    />{" "}
                    Highest first (descending)
                  </label>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Keep top
                  </label>
                  <input
                    className="nb2-in"
                    type="number"
                    min={1}
                    value={sel.config.n ?? 10}
                    onChange={(e) => patch(sel.id, { n: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "crossjoin" && (
                <>
                  <div className="nb2-note">
                    Pairs every row of the <b>left</b> input with every row of the{" "}
                    <b>right</b> (a cartesian product) — handy for building a
                    complete grid like calendar × store. No keys needed.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "coalesce" && (
                <>
                  <div className="nb2-note">
                    Combines several columns into the first non-null value (e.g.
                    phone_home, phone_work → phone). Priority follows the order
                    of the columns.
                  </div>
                  <label className="nb2-lbl">
                    Columns to coalesce (drag to set priority)
                  </label>
                  <ColumnPicker
                    chosen={(sel.config.cols || []) as string[]}
                    available={inspCols.in || []}
                    onChange={(next) => patch(sel.id, { cols: next })}
                    addLabel="+ Add column…"
                  />
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Output column
                  </label>
                  <input
                    className="nb2-in"
                    placeholder="coalesced"
                    value={sel.config.name || ""}
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "renamecols" && (
                <>
                  <div className="nb2-note">
                    Renames many columns at once. Transforms apply to every
                    column; explicit renames below override them for the named
                    columns.
                  </div>
                  <label className="nb2-lbl">Case</label>
                  <select
                    className="nb2-in"
                    value={sel.config.case || ""}
                    onChange={(e) => patch(sel.id, { case: e.target.value })}
                  >
                    <option value="">Leave as-is</option>
                    <option value="snake">snake_case</option>
                    <option value="lower">lowercase</option>
                    <option value="upper">UPPERCASE</option>
                  </select>
                  <div className="nb2-keyrow" style={{ marginTop: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label className="nb2-lbl">Find in names</label>
                      <input
                        className="nb2-in"
                        placeholder="(substring)"
                        value={sel.config.find || ""}
                        onChange={(e) => patch(sel.id, { find: e.target.value })}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="nb2-lbl">Replace with</label>
                      <input
                        className="nb2-in"
                        value={sel.config.replace || ""}
                        onChange={(e) =>
                          patch(sel.id, { replace: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="nb2-keyrow" style={{ marginTop: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label className="nb2-lbl">Prefix</label>
                      <input
                        className="nb2-in"
                        value={sel.config.prefix || ""}
                        onChange={(e) =>
                          patch(sel.id, { prefix: e.target.value })
                        }
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="nb2-lbl">Suffix</label>
                      <input
                        className="nb2-in"
                        value={sel.config.suffix || ""}
                        onChange={(e) =>
                          patch(sel.id, { suffix: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Explicit renames (override the above)
                  </label>
                  {(sel.config.mappings || []).map((m: any, i: number) => {
                    const setM = (po: any) =>
                      patch(sel.id, {
                        mappings: (sel.config.mappings || []).map(
                          (x: any, j: number) => (j === i ? { ...x, ...po } : x),
                        ),
                      });
                    return (
                      <div className="nb2-keyrow" key={i}>
                        <select
                          className="nb2-key"
                          value={m.from || ""}
                          onChange={(e) => setM({ from: e.target.value })}
                        >
                          <option value="">column…</option>
                          {(inspCols.in || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <span className="nb2-eq">→</span>
                        <input
                          className="nb2-key"
                          placeholder="new name"
                          value={m.to || ""}
                          onChange={(e) => setM({ to: e.target.value })}
                        />
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            patch(sel.id, {
                              mappings: (sel.config.mappings || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        mappings: [
                          ...(sel.config.mappings || []),
                          { from: "", to: "" },
                        ],
                      })
                    }
                  >
                    <Icon.Plus size={12} /> Add rename
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "bin" && (
                <>
                  <label className="nb2-lbl">Column to bin</label>
                  <select
                    className="nb2-in"
                    value={sel.config.col || ""}
                    onChange={(e) => patch(sel.id, { col: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Cut points (value ≤ → label)
                  </label>
                  {(sel.config.cuts || []).map((cut: any, i: number) => (
                    <div key={i} className="nb2-row2">
                      <input
                        className="nb2-in"
                        type="number"
                        placeholder="≤ value"
                        value={cut.le}
                        onChange={(e) => {
                          const cuts = [...(sel.config.cuts || [])];
                          cuts[i] = { ...cuts[i], le: e.target.value };
                          patch(sel.id, { cuts });
                        }}
                      />
                      <input
                        className="nb2-in"
                        placeholder="label"
                        value={cut.label}
                        onChange={(e) => {
                          const cuts = [...(sel.config.cuts || [])];
                          cuts[i] = { ...cuts[i], label: e.target.value };
                          patch(sel.id, { cuts });
                        }}
                      />
                      <button
                        className="btn ghost icon xbtn"
                        title="Remove"
                        onClick={() =>
                          patch(sel.id, {
                            cuts: (sel.config.cuts || []).filter(
                              (_: any, j: number) => j !== i,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      patch(sel.id, {
                        cuts: [...(sel.config.cuts || []), { le: "", label: "" }],
                      })
                    }
                  >
                    + Add cut
                  </button>
                  <label className="nb2-lbl" style={{ marginTop: 8 }}>
                    Everything else
                  </label>
                  <input
                    className="nb2-in"
                    value={sel.config.else_label || ""}
                    onChange={(e) => patch(sel.id, { else_label: e.target.value })}
                  />
                  <label className="nb2-lbl">New column name</label>
                  <input
                    className="nb2-in"
                    value={sel.config.out || ""}
                    onChange={(e) => patch(sel.id, { out: e.target.value })}
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "rank" && (
                <>
                  <label className="nb2-lbl">Rank by</label>
                  <div className="nb2-row2">
                    <select
                      className="nb2-in"
                      value={sel.config.order || ""}
                      onChange={(e) => patch(sel.id, { order: e.target.value })}
                    >
                      <option value="">Pick a field…</option>
                      {(inspCols.in || []).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <select
                      className="nb2-in"
                      value={sel.config.dir || "desc"}
                      onChange={(e) => patch(sel.id, { dir: e.target.value })}
                    >
                      <option value="desc">High → low</option>
                      <option value="asc">Low → high</option>
                    </select>
                  </div>
                  <label className="nb2-lbl">Method</label>
                  <select
                    className="nb2-in"
                    value={sel.config.method || "row_number"}
                    onChange={(e) => patch(sel.id, { method: e.target.value })}
                  >
                    <option value="row_number">Row number (1,2,3…)</option>
                    <option value="rank">Rank (ties skip: 1,1,3)</option>
                    <option value="dense_rank">Dense rank (1,1,2)</option>
                  </select>
                  <label className="nb2-lbl">Restart for each (optional)</label>
                  <div className="nb2-checks">
                    {(inspCols.in || []).map((c) => {
                      const on = (sel.config.partition || []).includes(c);
                      return (
                        <label key={c} className="nb2-check">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = sel.config.partition || [];
                              patch(sel.id, {
                                partition: on
                                  ? cur.filter((x: string) => x !== c)
                                  : [...cur, c],
                              });
                            }}
                          />{" "}
                          {c}
                        </label>
                      );
                    })}
                  </div>
                  <div className="nb2-row2">
                    <div>
                      <label className="nb2-lbl">Keep top N (blank = all)</label>
                      <input
                        className="nb2-in"
                        type="number"
                        placeholder="all"
                        value={sel.config.top_n}
                        onChange={(e) => patch(sel.id, { top_n: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="nb2-lbl">Rank column name</label>
                      <input
                        className="nb2-in"
                        value={sel.config.out || ""}
                        onChange={(e) => patch(sel.id, { out: e.target.value })}
                      />
                    </div>
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "fill" && (
                <>
                  <div className="nb2-note">
                    The Fill-nulls node has moved into <b>Text clean</b> (add a
                    “Fill blanks” step there). This node still works for older
                    workflows, but new ones should use Text clean.
                  </div>
                  <div className="nb2-note">
                    Replace nulls in chosen columns with a value or a statistic.
                  </div>
                  {(sel.config.fills || []).map((f: any, i: number) => (
                    <div key={i} className="nb2-fill-row">
                      <div className="nb2-row2">
                        <select
                          className="nb2-in"
                          value={f.col || ""}
                          onChange={(e) => {
                            const fills = [...(sel.config.fills || [])];
                            fills[i] = { ...fills[i], col: e.target.value };
                            patch(sel.id, { fills });
                          }}
                        >
                          <option value="">Column…</option>
                          {(inspCols.in || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <select
                          className="nb2-in"
                          value={f.method || "value"}
                          onChange={(e) => {
                            const fills = [...(sel.config.fills || [])];
                            fills[i] = { ...fills[i], method: e.target.value };
                            patch(sel.id, { fills });
                          }}
                        >
                          <option value="value">A value</option>
                          <option value="zero">Zero</option>
                          <option value="empty">Empty text</option>
                          <option value="avg">Average</option>
                          <option value="min">Minimum</option>
                          <option value="max">Maximum</option>
                        </select>
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove"
                          onClick={() =>
                            patch(sel.id, {
                              fills: (sel.config.fills || []).filter(
                                (_: any, j: number) => j !== i,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                      {(f.method || "value") === "value" && (
                        <input
                          className="nb2-in"
                          placeholder="fill value"
                          value={f.value || ""}
                          onChange={(e) => {
                            const fills = [...(sel.config.fills || [])];
                            fills[i] = { ...fills[i], value: e.target.value };
                            patch(sel.id, { fills });
                          }}
                        />
                      )}
                    </div>
                  ))}
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      patch(sel.id, {
                        fills: [
                          ...(sel.config.fills || []),
                          { col: "", method: "value", value: "" },
                        ],
                      })
                    }
                  >
                    + Add column
                  </button>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "chart" && (() => {
                const cstyle = sel.config.style || {};
                const ctype = sel.config.chart_type || "bar";
                const isCat = ctype === "bar" || ctype === "line" || ctype === "area";
                const isPieish = ctype === "pie" || ctype === "donut";
                const isDelta = ctype === "delta";
                const isWaterfall = ctype === "waterfall";
                const isCandle = ctype === "candlestick";
                const isTree = ctype === "treemap";
                const isTreeNode = ctype === "tree";
                const isMultiX = ctype === "multix";
                const isMultiY = ctype === "multiy";
                const cd = chartData[sel.id]?.data;
                const colorTargets: string[] = isDelta || isWaterfall
                  ? ["Increase", "Decrease"]
                  : isPieish || isTree
                    ? (cd?.labels || [])
                    : (cd?.series || []).map((s) => s.name).filter(Boolean);
                const pal = paletteColors(cstyle.palette);
                const seriesOn = !!sel.config.series;
                return (
                <>
                  <label className="nb2-lbl">Chart type</label>
                  <select
                    className="nb2-in"
                    value={ctype}
                    onChange={(e) => patch(sel.id, { chart_type: e.target.value })}
                  >
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="area">Area</option>
                    <option value="scatter">Scatter</option>
                    <option value="pie">Pie</option>
                    <option value="donut">Donut</option>
                    <option value="histogram">Histogram</option>
                    <option value="treemap">Treemap</option>
                    <option value="tree">Tree (gradient)</option>
                    <option value="candlestick">Candlestick (OHLC)</option>
                    <option value="multix">Multiple X axes</option>
                    <option value="multiy">Multiple Y axes</option>
                    <option value="delta">Period change (Δ)</option>
                    <option value="waterfall">Waterfall</option>
                  </select>
                  <label className="nb2-lbl">
                    {ctype === "scatter" ? "X field (value)"
                      : ctype === "histogram" ? "Value to bin"
                      : isMultiX ? "First X field (bottom axis)"
                      : "X field"}
                  </label>
                  <select
                    className="nb2-in"
                    value={sel.config.x || ""}
                    onChange={(e) => patch(sel.id, { x: e.target.value })}
                  >
                    <option value="">(pick X)</option>
                    {(inspCols.in || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {isCandle && (
                    <>
                      {(["open", "high", "low", "close"] as const).map((f) => (
                        <div key={f}>
                          <label className="nb2-lbl" style={{ textTransform: "capitalize" }}>
                            {f}
                          </label>
                          <select
                            className="nb2-in"
                            value={sel.config[f] || ""}
                            onChange={(e) => patch(sel.id, { [f]: e.target.value })}
                          >
                            <option value="">(pick {f})</option>
                            {(inspCols.in || []).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </>
                  )}
                  {ctype !== "histogram" && !isCandle && (
                    <>
                      <label className="nb2-lbl">
                        {ctype === "scatter" ? "Y field (value)" : isMultiX || isMultiY ? "First Y field" : "Y field"}
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.y || ""}
                        onChange={(e) => patch(sel.id, { y: e.target.value })}
                      >
                        <option value="">{ctype === "scatter" ? "(pick Y)" : "(count)"}</option>
                        {(inspCols.in || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  {isMultiX && (
                    <>
                      <label className="nb2-lbl">Second X field (top axis)</label>
                      <select
                        className="nb2-in"
                        value={sel.config.x2 || ""}
                        onChange={(e) => patch(sel.id, { x2: e.target.value })}
                      >
                        <option value="">(pick 2nd X)</option>
                        {(inspCols.in || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <label className="nb2-lbl">Second Y field</label>
                      <select
                        className="nb2-in"
                        value={sel.config.y2 || ""}
                        onChange={(e) => patch(sel.id, { y2: e.target.value })}
                      >
                        <option value="">(count)</option>
                        {(inspCols.in || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  {isMultiY && (
                    <>
                      <label className="nb2-lbl">Second Y field (right axis)</label>
                      <select
                        className="nb2-in"
                        value={sel.config.y2 || ""}
                        onChange={(e) => patch(sel.id, { y2: e.target.value })}
                      >
                        <option value="">(count)</option>
                        {(inspCols.in || []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  {ctype !== "scatter" && ctype !== "histogram" && !isCandle && (
                    <>
                      <label className="nb2-lbl">Aggregate Y by</label>
                      <select
                        className="nb2-in"
                        value={sel.config.agg || "sum"}
                        onChange={(e) => patch(sel.id, { agg: e.target.value })}
                      >
                        <option value="sum">Sum</option>
                        <option value="avg">Avg</option>
                        <option value="min">Min</option>
                        <option value="max">Max</option>
                        <option value="count">Count</option>
                      </select>
                    </>
                  )}
                  {(isCat || isTreeNode) && (
                    <>
                      <label className="nb2-lbl">
                        {isTreeNode
                          ? "Branch by (optional)"
                          : "Split into series by (optional)"}
                      </label>
                      <select
                        className="nb2-in"
                        value={sel.config.series || ""}
                        onChange={(e) => patch(sel.id, { series: e.target.value })}
                      >
                        <option value="">(single series)</option>
                        {(inspCols.in || [])
                          .filter((c) => c !== sel.config.x)
                          .map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                      </select>
                    </>
                  )}
                  {ctype === "histogram" && (
                    <>
                      <label className="nb2-lbl">Bins</label>
                      <input
                        className="nb2-in"
                        type="number"
                        min={1}
                        max={200}
                        value={sel.config.bins || 20}
                        onChange={(e) =>
                          patch(sel.id, { bins: Math.max(1, Math.min(200, +e.target.value || 20)) })
                        }
                      />
                    </>
                  )}

                  <details className="nb2-style">
                    <summary>Style &amp; colours</summary>
                    <label className="nb2-lbl">Colour palette</label>
                    <select
                      className="nb2-in"
                      value={cstyle.palette || "samql"}
                      onChange={(e) => patchStyle(sel, "palette", e.target.value)}
                    >
                      <option value="samql">SamQL</option>
                      <option value="vivid">Vivid</option>
                      <option value="cool">Cool</option>
                      <option value="warm">Warm</option>
                      <option value="mono">Mono</option>
                      <option value="pastel">Pastel</option>
                      <option value="earth">Earth</option>
                    </select>
                    <label className="nb2-lbl">Theme</label>
                    <select
                      className="nb2-in"
                      value={cstyle.theme || "dark"}
                      onChange={(e) => patchStyle(sel, "theme", e.target.value)}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                    {isDelta && (
                      <>
                        <label className="nb2-lbl">Change measure</label>
                        <select
                          className="nb2-in"
                          value={cstyle.deltaMode || "absolute"}
                          onChange={(e) => patchStyle(sel, "deltaMode", e.target.value)}
                        >
                          <option value="absolute">Absolute change</option>
                          <option value="percent">Percent change</option>
                        </select>
                      </>
                    )}
                    <label className="nb2-lbl">Title</label>
                    <input
                      className="nb2-in"
                      placeholder="(none)"
                      value={cstyle.title || ""}
                      onChange={(e) => patchStyle(sel, "title", e.target.value)}
                    />
                    {!isPieish && (
                      <div className="nb2-axis-labels">
                        <div>
                          <label className="nb2-lbl">X axis label</label>
                          <input
                            className="nb2-in"
                            placeholder="(none)"
                            value={cstyle.xLabel || ""}
                            onChange={(e) => patchStyle(sel, "xLabel", e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="nb2-lbl">Y axis label</label>
                          <input
                            className="nb2-in"
                            placeholder="(none)"
                            value={cstyle.yLabel || ""}
                            onChange={(e) => patchStyle(sel, "yLabel", e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                    <label className="nb2-check">
                      <input
                        type="checkbox"
                        checked={
                          cstyle.showLegend !== undefined
                            ? cstyle.showLegend
                            : isPieish || colorTargets.length > 1
                        }
                        onChange={(e) => patchStyle(sel, "showLegend", e.target.checked)}
                      />{" "}
                      Show legend
                    </label>
                    {!isPieish && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={cstyle.showGrid !== false}
                          onChange={(e) => patchStyle(sel, "showGrid", e.target.checked)}
                        />{" "}
                        Show gridlines
                      </label>
                    )}
                    {ctype === "bar" && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!cstyle.horizontal}
                          onChange={(e) => patchStyle(sel, "horizontal", e.target.checked)}
                        />{" "}
                        Horizontal bars
                      </label>
                    )}
                    {ctype === "bar" && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!cstyle.rounded}
                          onChange={(e) => patchStyle(sel, "rounded", e.target.checked)}
                        />{" "}
                        Rounded bar corners
                      </label>
                    )}
                    {(ctype === "bar" || ctype === "area" || ctype === "line") && seriesOn && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!cstyle.stacked}
                          onChange={(e) => patchStyle(sel, "stacked", e.target.checked)}
                        />{" "}
                        Stack series
                      </label>
                    )}
                    {(ctype === "line" || ctype === "area") && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={
                            cstyle.smooth !== undefined ? cstyle.smooth : ctype === "line"
                          }
                          onChange={(e) => patchStyle(sel, "smooth", e.target.checked)}
                        />{" "}
                        Smooth curve
                      </label>
                    )}
                    {(ctype === "line" || ctype === "area") && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!cstyle.large}
                          onChange={(e) => patchStyle(sel, "large", e.target.checked)}
                        />{" "}
                        Large-scale (downsample)
                      </label>
                    )}
                    {isPieish && (
                      <>
                        <label className="nb2-check">
                          <input
                            type="checkbox"
                            checked={!!cstyle.roseType}
                            onChange={(e) => patchStyle(sel, "roseType", e.target.checked)}
                          />{" "}
                          Rose / nightingale (radius by value)
                        </label>
                        <label className="nb2-lbl">Slice gap (pad angle°)</label>
                        <input
                          className="nb2-in"
                          type="number"
                          min={0}
                          max={30}
                          value={cstyle.padAngle ?? ""}
                          placeholder="0"
                          onChange={(e) =>
                            patchStyle(
                              sel,
                              "padAngle",
                              e.target.value === "" ? undefined : Number(e.target.value),
                            )
                          }
                        />
                      </>
                    )}
                    {(isTree || isTreeNode) && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={
                            isTreeNode
                              ? cstyle.gradient !== false
                              : !!cstyle.gradient
                          }
                          onChange={(e) => patchStyle(sel, "gradient", e.target.checked)}
                        />{" "}
                        Colour by value (gradient)
                      </label>
                    )}
                    {(isCat || isCandle) && (
                      <label className="nb2-check">
                        <input
                          type="checkbox"
                          checked={!!cstyle.dataZoom}
                          onChange={(e) => patchStyle(sel, "dataZoom", e.target.checked)}
                        />{" "}
                        Zoom + pan slider (large data)
                      </label>
                    )}
                    <label className="nb2-lbl" style={{ marginTop: 8 }}>
                      {isPieish ? "Slice colours" : "Series colours"}
                    </label>
                    {colorTargets.length === 0 ? (
                      <div className="nb2-note">
                        Preview the chart to fine-tune individual colours.
                      </div>
                    ) : (
                      colorTargets.map((name, i) => {
                        const cur =
                          (cstyle.seriesColors && cstyle.seriesColors[name]) ||
                          pal[i % pal.length];
                        const overridden = !!(
                          cstyle.seriesColors && cstyle.seriesColors[name]
                        );
                        return (
                          <div className="nb2-color-row" key={name + i}>
                            <input
                              type="color"
                              value={cur}
                              onChange={(e) =>
                                patchSeriesColor(sel, name, e.target.value)
                              }
                              title="Pick a colour"
                            />
                            <span className="nb2-color-name" title={name}>
                              {name || "(blank)"}
                            </span>
                            {overridden && (
                              <button
                                className="btn ghost icon xbtn"
                                title="Reset to palette"
                                onClick={() => patchSeriesColor(sel, name, null)}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </details>

                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doChart(sel)}
                  >
                    <Icon.Chart size={13} /> Preview chart
                  </button>
                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={nodeShowsBody(sel)}
                      onChange={(e) => {
                        patch(sel.id, { collapsed: !e.target.checked });
                        if (e.target.checked) void ensureChartFor(sel, true);
                      }}
                    />{" "}
                    Show chart under the node
                  </label>
                </>
                );
              })()}

              {inspectorType === "dashboard" && (
                <>
                  <div className="nb2-note">
                    A dashboard shows up to four charts in a 2×2 board under the
                    node. Wire chart nodes into its four inputs, then choose which
                    chart each pane displays. Drag a pane’s corner to resize it.
                  </div>
                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={nodeShowsBody(sel)}
                      onChange={(e) => {
                        patch(sel.id, { collapsed: !e.target.checked });
                        if (e.target.checked)
                          (sel.config.panes || ["in1", "in2", "in3", "in4"]).forEach(
                            (pt: string) => ensureChartFor(upstreamChartNode(sel, pt)),
                          );
                      }}
                    />{" "}
                    Show the board under the node
                  </label>
                  <label className="nb2-lbl" style={{ marginTop: 10 }}>
                    Panes
                  </label>
                  {[0, 1, 2, 3].map((i) => {
                    const panes =
                      sel.config.panes || ["in1", "in2", "in3", "in4"];
                    const port = panes[i] || `in${i + 1}`;
                    return (
                      <div key={i} className="nb2-dash-map">
                        <span className="nb2-dash-map-n">Pane {i + 1}</span>
                        <select
                          className="nb2-in"
                          value={port}
                          onChange={(e) => setDashPane(sel, i, e.target.value)}
                        >
                          {["in1", "in2", "in3", "in4"].map((pt) => {
                            const u = upstreamChartNode(sel, pt);
                            return (
                              <option key={pt} value={pt}>
                                {u
                                  ? u.config.label || "chart"
                                  : `in ${pt.slice(2)} (empty)`}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    );
                  })}
                  <div className="nb2-note" style={{ marginTop: 8 }}>
                    To save the board as an image, connect this dashboard’s output
                    to an Output node.
                  </div>
                </>
              )}

              {inspectorType === "profile" && (
                <>
                  <div className="nb2-note">
                    Profiles every column of the incoming data — types, nulls,
                    distinct counts, min/max and more. The data also passes
                    through unchanged.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doProfile(sel)}
                  >
                    <Icon.Info size={13} /> Profile data
                  </button>
                </>
              )}

              {inspectorType === "browse" && (
                <>
                  <div className="nb2-note">
                    A viewer: connect any output to its input, then show the data
                    in the results viewer below. It has no output of its own — it
                    just lets you inspect what's flowing through.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · data`)
                    }
                  >
                    <Icon.Table size={13} /> Show data
                  </button>
                </>
              )}

              {inspectorType === "reconcile" && (
                <>
                  <label className="nb2-lbl">Key fields (match on)</label>
                  <InspColsHint
                    probing={inspColsProbing}
                    ready={!!(inspCols.left && inspCols.right)}
                  >
                    Connect both <b>left</b> and <b>right</b> inputs.
                  </InspColsHint>
                  <div className="nb2-groupby">
                    {(inspCols.left || []).map((c) => (
                      <label className="nb2-gb" key={c}>
                        <input
                          type="checkbox"
                          checked={(sel.config.keys || []).includes(c)}
                          onChange={() => toggleInArray("keys", c)}
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                  <label className="nb2-lbl">Compare fields (optional)</label>
                  <div className="nb2-groupby">
                    {(inspCols.left || [])
                      .filter((c) => !(sel.config.keys || []).includes(c))
                      .map((c) => (
                        <label className="nb2-gb" key={c}>
                          <input
                            type="checkbox"
                            checked={(sel.config.compare || []).includes(c)}
                            onChange={() => toggleInArray("compare", c)}
                          />
                          {c}
                        </label>
                      ))}
                  </div>
                  <label className="nb2-lbl">Balance column (optional)</label>
                  <select
                    className="nb2-in"
                    value={sel.config.balance || ""}
                    onChange={(e) => patch(sel.id, { balance: e.target.value })}
                  >
                    <option value="">None</option>
                    {(inspCols.left || []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <div className="nb2-note">
                    A balance column is summed on each side (currency text is
                    parsed) so the report and the output show each side's total
                    and the difference per key.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doReconcile(sel)}
                  >
                    <Icon.Compare size={13} /> Run reconcile
                  </button>
                  <button
                    className="btn sm nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                  <div className="nb2-note">
                    The output is a per-key summary (status, each side's row
                    count{sel.config.balance ? ", balance totals + difference" : ""})
                    you can wire into other nodes.
                  </div>
                </>
              )}

              {inspectorType === "createtable" && (
                <>
                  <div className="nb2-hint-sm">
                    The label above is used as the table name.
                  </div>
                  <label className="nb2-lbl">Columns</label>
                  <div className="nb2-ct-cols">
                    {(sel.config.columns || []).map((c: string, ci: number) => (
                      <div className="nb2-ct-col" key={ci}>
                        <input
                          className="nb2-in"
                          value={c}
                          placeholder={`col${ci + 1}`}
                          onChange={(e) => {
                            const columns = [...(sel.config.columns || [])];
                            columns[ci] = e.target.value;
                            patch(sel.id, { columns });
                          }}
                        />
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove column"
                          onClick={() => {
                            const columns = (sel.config.columns || []).filter(
                              (_: any, i: number) => i !== ci,
                            );
                            const rows = (sel.config.rows || []).map((r: any[]) =>
                              r.filter((_: any, i: number) => i !== ci),
                            );
                            patch(sel.id, { columns, rows });
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn sm"
                      onClick={() => {
                        const columns = [
                          ...(sel.config.columns || []),
                          `col${(sel.config.columns || []).length + 1}`,
                        ];
                        const rows = (sel.config.rows || []).map((r: any[]) => [
                          ...r,
                          "",
                        ]);
                        patch(sel.id, { columns, rows });
                      }}
                    >
                      <Icon.Plus size={12} /> Column
                    </button>
                  </div>

                  <label className="nb2-lbl">Rows</label>
                  <div className="nb2-ct-grid">
                    {(sel.config.rows || []).map((row: any[], ri: number) => (
                      <div className="nb2-ct-row" key={ri}>
                        {(sel.config.columns || []).map(
                          (_: string, ci: number) => (
                            <input
                              key={ci}
                              className="nb2-in nb2-ct-cell"
                              value={row[ci] ?? ""}
                              onChange={(e) => {
                                const rows = (sel.config.rows || []).map(
                                  (r: any[]) => [...r],
                                );
                                while (rows[ri].length < (sel.config.columns || []).length)
                                  rows[ri].push("");
                                rows[ri][ci] = e.target.value;
                                patch(sel.id, { rows });
                              }}
                            />
                          ),
                        )}
                        <button
                          className="btn ghost icon xbtn"
                          title="Remove row"
                          onClick={() =>
                            patch(sel.id, {
                              rows: (sel.config.rows || []).filter(
                                (_: any, i: number) => i !== ri,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn sm"
                      onClick={() =>
                        patch(sel.id, {
                          rows: [
                            ...(sel.config.rows || []),
                            (sel.config.columns || []).map(() => ""),
                          ],
                        })
                      }
                    >
                      <Icon.Plus size={12} /> Row
                    </button>
                  </div>

                  <label className="nb2-lbl">Paste data (tab-separated, first row = headers)</label>
                  <textarea
                    className="nb2-in nb2-ct-paste"
                    rows={3}
                    placeholder={"id\tname\n1\tAlice\n2\tBob"}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (!text || text.indexOf("\t") < 0) return; // let normal paste happen for single cells
                      e.preventDefault();
                      const lines = text
                        .replace(/\r/g, "")
                        .split("\n")
                        .filter((l) => l.length);
                      if (!lines.length) return;
                      const columns = lines[0].split("\t").map((s) => s.trim());
                      const rows = lines
                        .slice(1)
                        .map((l) => l.split("\t"));
                      patch(sel.id, {
                        columns: columns.length ? columns : sel.config.columns,
                        rows: rows.length
                          ? rows
                          : [columns.map(() => "")],
                      });
                      onToast(
                        "ok",
                        "Pasted",
                        `${columns.length} columns · ${rows.length} rows`,
                      );
                    }}
                  />

                  <label className="nb2-lbl">Store in</label>
                  <select
                    className="nb2-in"
                    value={sel.config.dest || "duckdb"}
                    onChange={(e) => patch(sel.id, { dest: e.target.value })}
                  >
                    <option value="duckdb">DuckDB</option>
                    <option value="sqlite">SQLite</option>
                  </select>

                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doCreateTable(sel)}
                  >
                    <Icon.Table size={13} /> Create table in workspace
                  </button>
                  <button
                    className="btn sm nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview as flow output
                  </button>
                </>
              )}

              {inspectorType === "text" && (
                <>
                  <label className="nb2-lbl">Note</label>
                  <textarea
                    className="nb2-in nb2-text-area"
                    rows={6}
                    value={sel.config.text || ""}
                    placeholder="Type instructions or notes to show on the canvas…"
                    onChange={(e) => patch(sel.id, { text: e.target.value })}
                  />
                  <div className="nb2-hint-sm">
                    Text notes are just labels on the canvas — they don't run.
                  </div>
                </>
              )}

              {inspectorType === "variable" && (
                <>
                  <label className="nb2-lbl">Variables</label>
                  <div className="nb2-hint-sm">
                    Define name → value pairs, then reference them anywhere in
                    this workflow. Use <code>{"{{name}}"}</code> for a text
                    value (it auto-quotes, e.g. <code>{"{{as_of}}"}</code>), or{" "}
                    <code>{"${name}"}</code> for the raw value (a number or
                    identifier, inserted verbatim). An iterator can override
                    these per pass.
                  </div>
                  {(sel.config.vars || []).map((row: any, i: number) => (
                    <div key={i} className="nb2-var-row">
                      <input
                        className="nb2-in nb2-var-name"
                        placeholder="name"
                        value={row.name || ""}
                        onChange={(e) => {
                          const next = [...(sel.config.vars || [])];
                          next[i] = { ...next[i], name: e.target.value };
                          patch(sel.id, { vars: next });
                        }}
                      />
                      <span className="nb2-var-eq">=</span>
                      <input
                        className="nb2-in nb2-var-val"
                        placeholder="value"
                        value={row.value || ""}
                        onChange={(e) => {
                          const next = [...(sel.config.vars || [])];
                          next[i] = { ...next[i], value: e.target.value };
                          patch(sel.id, { vars: next });
                        }}
                      />
                      <button
                        className="btn ghost icon xbtn"
                        title="Remove variable"
                        onClick={() =>
                          patch(sel.id, {
                            vars: (sel.config.vars || []).filter(
                              (_: any, j: number) => j !== i,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm"
                    onClick={() =>
                      patch(sel.id, {
                        vars: [
                          ...(sel.config.vars || []),
                          { name: "", value: "" },
                        ],
                      })
                    }
                  >
                    <Icon.Plus size={13} /> Add variable
                  </button>
                </>
              )}

              {inspectorType === "directory" && (
                <>
                  <label className="nb2-lbl">Folder</label>
                  <div className="nb2-folder">
                    <input
                      className="nb2-in"
                      placeholder="Browse to a folder…"
                      value={sel.config.folder || ""}
                      readOnly
                    />
                    <button
                      className="btn sm"
                      onClick={() => setBrowseFolder(true)}
                      title="Browse for a folder"
                    >
                      <Icon.Folder size={13} />
                    </button>
                  </div>
                  {sel.config.folder && (
                    <>
                      <label className="nb2-lbl" style={{ margin: "10px 0 4px" }}>
                        File in folder
                      </label>
                      {dirList.loading && dirList.folder === sel.config.folder ? (
                        <div className="nb2-note">Listing files…</div>
                      ) : dirList.error ? (
                        <div className="nb2-note">{dirList.error}</div>
                      ) : dirList.files.length === 0 &&
                        dirList.folder === sel.config.folder ? (
                        <div className="nb2-note">
                          No readable files here (CSV, TSV, JSON, Parquet, Excel).
                        </div>
                      ) : (
                        <select
                          className="nb2-in"
                          value={sel.config.file || ""}
                          onChange={(e) => {
                            const f = dirList.files.find(
                              (x) => x.name === e.target.value,
                            );
                            if (f) void doReadDirectory(sel, f.path, f.name);
                          }}
                        >
                          <option value="">Choose a file…</option>
                          {dirList.files.map((f) => (
                            <option key={f.path} value={f.name}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        className="btn sm ghost"
                        style={{ marginTop: 6 }}
                        onClick={() => loadDirList(sel.config.folder)}
                        title="Refresh the file list"
                      >
                        <Icon.Refresh size={12} /> Refresh
                      </button>
                    </>
                  )}
                  {sel.config.table && (
                    <>
                      <div className="nb2-note" style={{ marginTop: 8 }}>
                        Reading <b>{sel.config.file}</b> ·{" "}
                        {(sel.config.columns || []).length} column(s)
                      </div>
                      <button
                        className="btn sm primary nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "out", `${sel.config.label} · output`)
                        }
                      >
                        <Icon.Table size={13} /> Preview output
                      </button>
                    </>
                  )}
                </>
              )}

              {inspectorType === "appendfolder" && (
                <>
                  <div className="nb2-note">
                    Reads every readable file in a folder (CSV, TSV, JSON,
                    Parquet, Excel) and stacks them into one table, lining up
                    columns by name. All files must be the same type.
                  </div>
                  <label className="nb2-lbl">Folder</label>
                  <div className="nb2-folder">
                    <input
                      className="nb2-in"
                      placeholder="Browse to a folder…"
                      value={sel.config.folder || ""}
                      readOnly
                    />
                    <button
                      className="btn sm"
                      onClick={() => setBrowseFolder(true)}
                      title="Browse for a folder"
                    >
                      <Icon.Folder size={13} />
                    </button>
                  </div>
                  {sel.config.folder && (
                    <button
                      className="btn sm ghost"
                      style={{ marginTop: 6 }}
                      onClick={() => doReadFolder(sel, sel.config.folder)}
                      title="Re-read the folder"
                    >
                      <Icon.Refresh size={12} /> Refresh
                    </button>
                  )}
                  {sel.config.table && (
                    <>
                      <div className="nb2-note" style={{ marginTop: 8 }}>
                        {sel.config.files || 0} file(s) ·{" "}
                        {(sel.config.columns || []).length} column(s)
                      </div>
                      <button
                        className="btn sm primary nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "out", `${sel.config.label} · output`)
                        }
                      >
                        <Icon.Table size={13} /> Preview output
                      </button>
                    </>
                  )}
                </>
              )}

              {inspectorType === "filebrowser" && (
                <>
                  <div className="nb2-note">
                    Loads files at run time by path or glob — and the path can
                    contain <code>{"${variables}"}</code>, so an iterator can
                    point it at a different file each pass. Reads many files at
                    once and lines columns up by name. Needs DuckDB.
                  </div>
                  <label className="nb2-lbl">Path or glob pattern</label>
                  <input
                    className="nb2-in"
                    value={sel.config.pattern || ""}
                    placeholder="/data/*_${as_of}.csv"
                    onChange={(e) => patch(sel.id, { pattern: e.target.value })}
                  />
                  <div className="nb2-hint-sm">
                    Examples: <code>/data/txns_${"${as_of}"}.parquet</code>,{" "}
                    <code>/exports/*_${"${region}"}.csv</code>. CSV/TSV, Parquet
                    and JSON are detected from the extension.
                  </div>
                  <label className="nb2-lbl">
                    Source-file column (optional)
                  </label>
                  <input
                    className="nb2-in"
                    value={sel.config.source_column || ""}
                    placeholder="e.g. _source_file"
                    onChange={(e) =>
                      patch(sel.id, { source_column: e.target.value })
                    }
                  />
                  <div className="nb2-hint-sm">
                    If set, each row is tagged with the file it came from — handy
                    when stacking many days.
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "apinode" && (
                <>
                  <div className="nb2-note">
                    Fetches JSON from an HTTP(S) endpoint and loads it as a
                    table. The URL, parameters and headers can use{" "}
                    <code>{"${variables}"}</code> (the raw value — use{" "}
                    <code>{"${name}"}</code> here, not <code>{"{{name}}"}</code>,
                    since a URL needs the value without SQL quotes), so an
                    iterator can call a different endpoint each pass. Press Fetch
                    to pull the data.
                  </div>
                  <label className="nb2-lbl">URL</label>
                  <input
                    className="nb2-in"
                    value={sel.config.url || ""}
                    placeholder="https://api.example.com/v1/items"
                    onChange={(e) => patch(sel.id, { url: e.target.value })}
                  />

                  <label className="nb2-lbl">Query parameters</label>
                  {(sel.config.params || []).map((p: any, i: number) => (
                    <div className="nb2-row2" key={i}>
                      <input
                        className="nb2-in"
                        placeholder="key"
                        value={p.key || ""}
                        onChange={(e) => {
                          const ps = [...(sel.config.params || [])];
                          ps[i] = { ...ps[i], key: e.target.value };
                          patch(sel.id, { params: ps });
                        }}
                      />
                      <input
                        className="nb2-in"
                        placeholder="value (can use ${var})"
                        value={p.value || ""}
                        onChange={(e) => {
                          const ps = [...(sel.config.params || [])];
                          ps[i] = { ...ps[i], value: e.target.value };
                          patch(sel.id, { params: ps });
                        }}
                      />
                      <button
                        className="btn ghost icon xbtn"
                        title="Remove"
                        onClick={() => {
                          const ps = [...(sel.config.params || [])];
                          ps.splice(i, 1);
                          patch(sel.id, { params: ps });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      patch(sel.id, {
                        params: [
                          ...(sel.config.params || []),
                          { key: "", value: "" },
                        ],
                      })
                    }
                  >
                    + parameter
                  </button>

                  <label className="nb2-lbl">Records path (optional)</label>
                  <input
                    className="nb2-in"
                    value={sel.config.json_path || ""}
                    placeholder="e.g. data.items"
                    onChange={(e) =>
                      patch(sel.id, { json_path: e.target.value })
                    }
                  />
                  <div className="nb2-hint-sm">
                    Dotted path to the array of records inside the response —
                    leave blank if the response is already a list.
                  </div>

                  <label className="nb2-lbl">Saved API profile</label>
                  <select
                    className="nb2-in"
                    data-testid="apinode-connection-profile"
                    value={
                      String(sel.config.secret_key || "").startsWith("api:")
                        ? sel.config.secret_key
                        : ""
                    }
                    onChange={(e) => {
                      const key = e.target.value;
                      if (!key) {
                        patch(sel.id, {
                          secret_key: "",
                          secret_saved: false,
                        });
                        return;
                      }
                      const p = apiConnProfiles.find((x) => x.key === key);
                      const fields = (p?.fields || {}) as Record<string, any>;
                      patch(sel.id, {
                        secret_key: key,
                        secret_saved: true,
                        url: fields.url ?? sel.config.url,
                        auth_user: fields.auth_user ?? sel.config.auth_user,
                        json_path: fields.json_path ?? sel.config.json_path,
                      });
                    }}
                  >
                    <option value="">(none — use fields below)</option>
                    {apiConnProfiles.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className="nb2-hint-sm">
                    Reuse a profile saved under Load a Table → REST API (password
                    stays in the OS secret store).
                  </div>

                  <label className="nb2-lbl">Basic auth (optional)</label>
                  <input
                    className="nb2-in"
                    placeholder="username"
                    value={sel.config.auth_user || ""}
                    onChange={(e) =>
                      patch(sel.id, { auth_user: e.target.value })
                    }
                  />
                  <div className="nb2-row2" style={{ marginTop: 6 }}>
                    <input
                      className="nb2-in"
                      type="password"
                      placeholder={
                        sel.config.secret_saved ? "•••••• (stored)" : "password"
                      }
                      value={apiPwDraft}
                      onChange={(e) => setApiPwDraft(e.target.value)}
                    />
                    <button
                      className="btn sm"
                      disabled={!apiPwDraft}
                      title="Store the password securely (never saved in the workflow)"
                      onClick={async () => {
                        const key = `apinode:${sel.id}`;
                        const r = await api.secretSet(key, apiPwDraft);
                        if (r.ok) {
                          patch(sel.id, {
                            secret_key: key,
                            secret_saved: true,
                          });
                          setApiPwDraft("");
                          onToast(
                            "ok",
                            "Password stored",
                            "Kept in the OS secret store, not the workflow.",
                          );
                        } else {
                          onToast(
                            "error",
                            "Couldn't store password",
                            r.available === false
                              ? "Secure storage isn't available on this machine."
                              : "Failed to store the password.",
                          );
                        }
                      }}
                    >
                      Save
                    </button>
                  </div>
                  <div className="nb2-hint-sm">
                    The password is stored in the OS secret store, never in the
                    saved workflow.
                    {sel.config.secret_saved ? " A password is stored." : ""}
                  </div>

                  <label className="nb2-lbl">Retries on 429 / 5xx</label>
                  <input
                    className="nb2-in"
                    type="number"
                    min={0}
                    max={10}
                    value={sel.config.retry?.retries ?? 0}
                    onChange={(e) =>
                      patch(sel.id, {
                        retry: {
                          ...(sel.config.retry || {}),
                          retries: Math.max(
                            0,
                            Math.min(10, parseInt(e.target.value, 10) || 0),
                          ),
                        },
                      })
                    }
                  />
                  <div className="nb2-hint-sm">
                    Retry transient failures (rate-limit and server errors) with
                    exponential backoff. 0 = don't retry.
                  </div>

                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={!!sel.config.continue_on_error}
                      onChange={(e) =>
                        patch(sel.id, {
                          continue_on_error: e.target.checked,
                        })
                      }
                    />
                    Continue on error
                  </label>
                  <div className="nb2-hint-sm">
                    When on, a failed fetch doesn't stop the run — its status
                    and message go to the node's <b>errors</b> output instead.
                  </div>

                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    style={{ marginTop: 8 }}
                    onClick={() => doFetchApi(sel)}
                  >
                    <Icon.Globe size={13} /> Fetch
                  </button>
                  {sel.config.table && (
                    <>
                      <div className="nb2-note" style={{ marginTop: 8 }}>
                        {(sel.config.rows ?? 0).toLocaleString()} row(s) ·{" "}
                        {(sel.config.columns || []).length} column(s) loaded
                        {sel.config.engine ? ` (${sel.config.engine})` : ""}.
                      </div>
                      <button
                        className="btn sm primary nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "out", `${sel.config.label} · output`)
                        }
                      >
                        <Icon.Table size={13} /> Preview output
                      </button>
                    </>
                  )}
                  {sel.config.err_rows ? (
                    <>
                      <div className="nb2-note" style={{ marginTop: 8 }}>
                        {(sel.config.err_rows as number).toLocaleString()}{" "}
                        error row(s) on the errors output.
                      </div>
                      <button
                        className="btn sm nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "err", `${sel.config.label} · errors`)
                        }
                      >
                        <Icon.Table size={13} /> Preview errors
                      </button>
                    </>
                  ) : null}
                </>
              )}

              {(inspectorType === "sqlserver" ||
                inspectorType === "sharepoint" ||
                inspectorType === "webscrape") && (
                <>
                  {inspectorType === "sqlserver" && (
                    <>
                      <div className="nb2-note">
                        Same connection settings as Load a Table → SQL Server.
                        Save a profile with “Save password” so Dashboard and
                        NodeFlow runs can reconnect without typing credentials
                        again. Passwords stay in the OS secret store — never in
                        the workflow.
                      </div>
                      <MsSqlConnectForm
                        variant="node"
                        testIdPrefix="sqlserver-node"
                        values={{
                          driver: sel.config.driver || "",
                          server: sel.config.server || "",
                          port: sel.config.port || "",
                          auth: (sel.config.auth || "windows") as MsSqlConnectValues["auth"],
                          user: sel.config.user || "",
                          encrypt: sel.config.encrypt !== false,
                          trust: sel.config.trust !== false,
                          multi_subnet: !!sel.config.multi_subnet,
                          login_timeout: String(sel.config.login_timeout ?? "15"),
                          stmt_timeout: String(sel.config.stmt_timeout ?? "0"),
                          read_only: sel.config.read_only !== false,
                          save_password: !!sel.config.save_password,
                          profile_name: sel.config.profile_name || "",
                          profile_sel: sel.config.profile_name
                            ? String(sel.config.profile_name)
                            : (sel.config.profile_key || "")
                                  .replace(/^mssql:/, "") || "(new)",
                          secret_saved: !!sel.config.secret_saved,
                        }}
                        onChange={(p) => {
                          const next: Record<string, unknown> = { ...p };
                          if (p.profile_name != null || p.profile_sel != null) {
                            const nm = sanitizeProfileName(
                              String(
                                p.profile_name ??
                                  sel.config.profile_name ??
                                  "",
                              ),
                            );
                            if (nm) {
                              next.profile_key = "mssql:" + nm;
                              next.connection = nm;
                            }
                          }
                          patch(sel.id, next);
                        }}
                        drivers={mssqlDrivers}
                        profiles={mssqlProfiles}
                        secretsOk={mssqlSecretsOk}
                        pwd={mssqlPwd}
                        onPwdChange={setMssqlPwd}
                        onSelectProfile={(name) => {
                          if (name === "(new)") {
                            patch(sel.id, {
                              profile_sel: "(new)",
                              profile_name: "",
                              profile_key: "",
                            });
                            return;
                          }
                          const p = mssqlProfiles[name];
                          if (!p) return;
                          const fields = sqlProfileToConnectValues(p, name);
                          patch(sel.id, {
                            ...fields,
                            profile_key: "mssql:" + name,
                            connection: name,
                            secret_saved: !!p.savePassword,
                          });
                          setMssqlPwd("");
                        }}
                        onSaveProfile={async () => {
                          const values: MsSqlConnectValues = {
                            driver: sel.config.driver || "",
                            server: sel.config.server || "",
                            port: sel.config.port || "",
                            auth: (sel.config.auth ||
                              "windows") as MsSqlConnectValues["auth"],
                            user: sel.config.user || "",
                            encrypt: sel.config.encrypt !== false,
                            trust: sel.config.trust !== false,
                            multi_subnet: !!sel.config.multi_subnet,
                            login_timeout: String(
                              sel.config.login_timeout ?? "15",
                            ),
                            stmt_timeout: String(
                              sel.config.stmt_timeout ?? "0",
                            ),
                            read_only: sel.config.read_only !== false,
                            save_password: !!sel.config.save_password,
                            profile_name: sel.config.profile_name || "",
                            profile_sel:
                              sel.config.profile_name ||
                              (sel.config.profile_key || "").replace(
                                /^mssql:/,
                                "",
                              ) ||
                              "(new)",
                            secret_saved: !!sel.config.secret_saved,
                          };
                          const r = await persistMsSqlProfile(
                            values.profile_name || values.profile_sel,
                            values,
                            mssqlProfiles,
                            mssqlPwd,
                          );
                          if (!r.ok) {
                            onToast(
                              "error",
                              "Could not save profile",
                              r.error || "",
                            );
                            return;
                          }
                          setMssqlProfiles(r.profiles);
                          const nm = sanitizeProfileName(
                            values.profile_name || values.profile_sel,
                          );
                          patch(sel.id, {
                            profile_name: nm,
                            profile_key: r.secretKey || "mssql:" + nm,
                            connection: nm,
                            secret_key: r.secretKey,
                            secret_saved: r.secretSaved,
                            save_password: !!values.save_password,
                          });
                          if (r.secretSaved) setMssqlPwd("");
                          onToast(
                            "ok",
                            "Profile saved",
                            r.secretSaved
                              ? "Connection settings + password stored."
                              : "Connection settings saved (no password).",
                          );
                        }}
                        onDeleteProfile={async () => {
                          const nm =
                            sel.config.profile_name ||
                            (sel.config.profile_key || "").replace(
                              /^mssql:/,
                              "",
                            );
                          const next = await deleteMsSqlProfile(
                            String(nm),
                            mssqlProfiles,
                          );
                          setMssqlProfiles(next);
                          patch(sel.id, {
                            profile_name: "",
                            profile_key: "",
                            connection: "",
                            secret_key: "",
                            secret_saved: false,
                          });
                        }}
                      />
                      <label className="nb2-lbl">Database (optional)</label>
                      <input
                        className="nb2-in"
                        data-testid="sqlserver-node-database"
                        value={sel.config.database || ""}
                        placeholder="USE this database before the query"
                        onChange={(e) =>
                          patch(sel.id, { database: e.target.value })
                        }
                      />
                      <label className="nb2-lbl">
                        Active connection name (optional)
                      </label>
                      <input
                        className="nb2-in"
                        data-testid="sqlserver-node-connection"
                        value={sel.config.connection || ""}
                        placeholder="reuse a Load a Table session connection"
                        onChange={(e) =>
                          patch(sel.id, { connection: e.target.value })
                        }
                      />
                      <label className="nb2-lbl">Query</label>
                      <textarea
                        className="nb2-in"
                        data-testid="sqlserver-node-query"
                        rows={5}
                        value={sel.config.query || ""}
                        onChange={(e) =>
                          patch(sel.id, { query: e.target.value })
                        }
                      />
                    </>
                  )}
                  {inspectorType === "sharepoint" && (
                    <>
                      <div className="nb2-note">
                        Browse a SharePoint list or a document library. Sign in
                        with Microsoft when you are already logged into work
                        accounts, use Windows Integrated for classic on-prem, or
                        paste a bearer token. Tokens stay in the OS secret store
                        — never in the workflow.
                      </div>
                      <label className="nb2-lbl">Site URL</label>
                      <input
                        className="nb2-in"
                        value={sel.config.site_url || ""}
                        placeholder="https://contoso.sharepoint.com/sites/Finance"
                        onChange={(e) =>
                          patch(sel.id, { site_url: e.target.value })
                        }
                      />
                      <label className="nb2-lbl">Auth</label>
                      <select
                        className="nb2-in"
                        data-testid="sharepoint-auth-mode"
                        value={sel.config.auth_mode || "bearer"}
                        onChange={(e) =>
                          patch(sel.id, { auth_mode: e.target.value })
                        }
                      >
                        <option value="bearer">Bearer token (secret key)</option>
                        <option value="device_code">
                          Sign in — device code (already logged into Microsoft)
                        </option>
                        <option value="interactive">
                          Sign in — browser / Microsoft account
                        </option>
                        <option value="windows">
                          Windows Integrated (classic on-prem)
                        </option>
                      </select>
                      {(sel.config.auth_mode || "bearer") !== "windows" && (
                        <>
                          <label className="nb2-lbl">Token secret key</label>
                          <input
                            className="nb2-in"
                            value={sel.config.secret_key || ""}
                            placeholder="sharepoint:Finance"
                            onChange={(e) =>
                              patch(sel.id, { secret_key: e.target.value })
                            }
                          />
                        </>
                      )}
                      {((sel.config.auth_mode || "bearer") === "device_code" ||
                        (sel.config.auth_mode || "bearer") ===
                          "interactive") && (
                        <>
                          <label className="nb2-lbl">
                            Tenant (optional)
                          </label>
                          <input
                            className="nb2-in"
                            value={sel.config.tenant_id || ""}
                            placeholder="organizations"
                            onChange={(e) =>
                              patch(sel.id, { tenant_id: e.target.value })
                            }
                          />
                          <label className="nb2-lbl">
                            App client id (optional)
                          </label>
                          <input
                            className="nb2-in"
                            value={sel.config.client_id || ""}
                            placeholder="Azure public client id (default built-in)"
                            onChange={(e) =>
                              patch(sel.id, { client_id: e.target.value })
                            }
                          />
                          {(sel.config.auth_mode || "") === "device_code" ? (
                            <div className="nb2-row" style={{ gap: 8 }}>
                              <button
                                type="button"
                                className="nb2-btn"
                                data-testid="sharepoint-device-start"
                                onClick={async () => {
                                  const caps =
                                    await api.sharepointAuthCapabilities();
                                  if (caps.msal === false) {
                                    onToast(
                                      "error",
                                      "Sign-in",
                                      "msal is not available in this SamQL build. Re-run the build to bundle it.",
                                    );
                                    return;
                                  }
                                  const r = await api.sharepointAuthDeviceStart({
                                    config: sel.config,
                                  });
                                  if (r.error || !r.ok) {
                                    onToast(
                                      "error",
                                      "Sign-in",
                                      r.error || "Could not start device code.",
                                    );
                                    return;
                                  }
                                  if (r.secret_key) {
                                    patch(sel.id, { secret_key: r.secret_key });
                                  }
                                  patch(sel.id, {
                                    _device_flow_id: r.flow_id,
                                    _device_user_code: r.user_code,
                                    _device_uri: r.verification_uri,
                                    _device_message: r.message,
                                  });
                                  onToast(
                                    "ok",
                                    "Enter this code",
                                    r.message ||
                                      `${r.verification_uri} → ${r.user_code}`,
                                  );
                                }}
                              >
                                Get device code
                              </button>
                              <button
                                type="button"
                                className="nb2-btn"
                                data-testid="sharepoint-device-poll"
                                disabled={!sel.config._device_flow_id}
                                onClick={async () => {
                                  const r = await api.sharepointAuthDevicePoll({
                                    flow_id: String(
                                      sel.config._device_flow_id || "",
                                    ),
                                    block: true,
                                  });
                                  if (r.error) {
                                    onToast("error", "Sign-in", r.error);
                                    return;
                                  }
                                  if (r.pending) {
                                    onToast(
                                      "warn",
                                      "Waiting",
                                      "Finish signing in at the device login page, then try again.",
                                    );
                                    return;
                                  }
                                  if (r.secret_key) {
                                    patch(sel.id, { secret_key: r.secret_key });
                                  }
                                  onToast(
                                    "ok",
                                    "Signed in",
                                    "Microsoft token saved under the secret key.",
                                  );
                                }}
                              >
                                I&apos;ve signed in
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="nb2-btn"
                              data-testid="sharepoint-interactive"
                              onClick={async () => {
                                const caps =
                                  await api.sharepointAuthCapabilities();
                                if (caps.msal === false) {
                                  onToast(
                                    "error",
                                    "Sign-in",
                                    "msal is not available in this SamQL build. Re-run the build to bundle it.",
                                  );
                                  return;
                                }
                                const r = await api.sharepointAuthInteractive({
                                  config: sel.config,
                                });
                                if (r.error || !r.ok) {
                                  onToast(
                                    "error",
                                    "Sign-in",
                                    r.error || "Interactive sign-in failed.",
                                  );
                                  return;
                                }
                                if (r.secret_key) {
                                  patch(sel.id, { secret_key: r.secret_key });
                                }
                                onToast(
                                  "ok",
                                  "Signed in",
                                  "Microsoft token saved under the secret key.",
                                );
                              }}
                            >
                              Sign in with Microsoft
                            </button>
                          )}
                          {sel.config._device_user_code ? (
                            <div className="nb2-hint-sm">
                              Code <code>{sel.config._device_user_code}</code> at{" "}
                              <code>{sel.config._device_uri}</code>
                            </div>
                          ) : null}
                        </>
                      )}
                      {(sel.config.auth_mode || "bearer") === "windows" && (
                        <div className="nb2-hint-sm">
                          Uses your Windows login (Negotiate/NTLM) against
                          classic on-prem <code>/_api</code> sites on the
                          corporate network. Not for sharepoint.com online.
                        </div>
                      )}
                      {(sel.config.auth_mode || "bearer") === "bearer" && (
                        <div className="nb2-hint-sm">
                          Store a Graph bearer token under the secret key via
                          Settings secrets / another tool, then Fetch.
                        </div>
                      )}
                      <label className="nb2-lbl">Mode</label>
                      <select
                        className="nb2-in"
                        value={sel.config.mode || "list"}
                        onChange={(e) => patch(sel.id, { mode: e.target.value })}
                      >
                        <option value="list">List items</option>
                        <option value="drive">Browse folders &amp; files</option>
                      </select>
                      {(sel.config.mode || "list") === "list" ? (
                        <>
                          <label className="nb2-lbl">List title</label>
                          <input
                            className="nb2-in"
                            value={sel.config.list_title || ""}
                            placeholder="Invoices"
                            onChange={(e) =>
                              patch(sel.id, { list_title: e.target.value })
                            }
                          />
                        </>
                      ) : (
                        <>
                          <label className="nb2-lbl">Folder path</label>
                          <input
                            className="nb2-in"
                            value={sel.config.folder_path || ""}
                            placeholder="Shared Documents/Reports (blank = root)"
                            onChange={(e) =>
                              patch(sel.id, { folder_path: e.target.value })
                            }
                          />
                          <label className="nb2-lbl">File id (for download)</label>
                          <input
                            className="nb2-in"
                            value={sel.config.item_id || ""}
                            placeholder="from the id column after Browse/Fetch"
                            onChange={(e) =>
                              patch(sel.id, { item_id: e.target.value })
                            }
                          />
                          <label className="nb2-lbl">Download URL (optional)</label>
                          <input
                            className="nb2-in"
                            value={sel.config.download_url || ""}
                            placeholder="from downloadUrl column"
                            onChange={(e) =>
                              patch(sel.id, { download_url: e.target.value })
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                  {inspectorType === "webscrape" && (
                    <>
                      <div className="nb2-note">
                        Fetches a public page and extracts HTML tables, links,
                        plain text, or JSON objects into a relation.
                        Private/local URLs follow the same SSRF policy as the API
                        node.
                      </div>
                      <label className="nb2-lbl">URL</label>
                      <input
                        className="nb2-in"
                        value={sel.config.url || ""}
                        placeholder="https://example.com/report"
                        onChange={(e) => patch(sel.id, { url: e.target.value })}
                      />
                      <label className="nb2-lbl">Mode</label>
                      <select
                        className="nb2-in"
                        value={sel.config.mode || "tables"}
                        onChange={(e) => patch(sel.id, { mode: e.target.value })}
                      >
                        <option value="tables">HTML tables</option>
                        <option value="links">Links</option>
                        <option value="text">Page text</option>
                        <option value="json">JSON objects</option>
                      </select>
                      {(sel.config.mode || "tables") === "tables" ? (
                        <>
                          <label className="nb2-lbl">Table index</label>
                          <input
                            className="nb2-in"
                            type="number"
                            min={0}
                            value={sel.config.table_index ?? 0}
                            onChange={(e) =>
                              patch(sel.id, {
                                table_index: Number(e.target.value) || 0,
                              })
                            }
                          />
                        </>
                      ) : null}
                      {(sel.config.mode || "tables") === "json" ||
                      (sel.config.mode || "tables") === "tables" ? (
                        <>
                          <label className="nb2-lbl">
                            JSON path (optional, e.g. data.items)
                          </label>
                          <input
                            className="nb2-in"
                            value={sel.config.json_path || ""}
                            placeholder="data.items"
                            onChange={(e) =>
                              patch(sel.id, { json_path: e.target.value })
                            }
                          />
                        </>
                      ) : null}
                    </>
                  )}
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    style={{ marginTop: 8 }}
                    data-testid={
                      inspectorType === "sqlserver"
                        ? "sqlserver-node-fetch"
                        : undefined
                    }
                    onClick={() =>
                      doFetchApi(
                        sel,
                        inspectorType === "sqlserver" && mssqlPwd
                          ? { pwd: mssqlPwd }
                          : undefined,
                      )
                    }
                  >
                    <Icon.Globe size={13} />{" "}
                    {inspectorType === "sharepoint" &&
                    (sel.config.mode || "list") === "drive"
                      ? "Browse / Fetch"
                      : "Fetch"}
                  </button>
                  {inspectorType === "sharepoint" &&
                    (sel.config.mode || "list") === "drive" && (
                      <button
                        type="button"
                        className="btn sm nb2-prev"
                        data-testid="sharepoint-download"
                        disabled={running}
                        style={{ marginTop: 6 }}
                        onClick={async () => {
                          if (
                            !(sel.config.item_id || "").trim() &&
                            !(sel.config.download_url || "").trim()
                          ) {
                            onToast(
                              "warn",
                              "Pick a file",
                              "Set File id or Download URL from the browse results.",
                            );
                            return;
                          }
                          try {
                            const r = await api.sharepointDownload({
                              config: sel.config,
                            });
                            if (r.error || !r.ok) {
                              onToast(
                                "error",
                                "Download failed",
                                r.error || "Failed.",
                              );
                              return;
                            }
                            onToast(
                              "ok",
                              "Downloaded",
                              r.path || r.filename || "Saved to Downloads.",
                            );
                          } catch (e: any) {
                            onToast(
                              "error",
                              "Download failed",
                              e?.message || String(e),
                            );
                          }
                        }}
                      >
                        <Icon.Download size={13} /> Download file
                      </button>
                    )}
                  {sel.config.table && (
                    <>
                      <div className="nb2-note" style={{ marginTop: 8 }}>
                        {(sel.config.rows ?? 0).toLocaleString()} row(s) ·{" "}
                        {(sel.config.columns || []).length} column(s) loaded
                        {sel.config.engine ? ` (${sel.config.engine})` : ""}.
                      </div>
                      <button
                        className="btn sm primary nb2-prev"
                        disabled={running}
                        onClick={() =>
                          doPreview(sel, "out", `${sel.config.label} · output`)
                        }
                      >
                        <Icon.Table size={13} /> Preview output
                      </button>
                    </>
                  )}
                </>
              )}

              {inspectorType === "iterator" && (
                <>
                  <div className="nb2-note">
                    A container loop. Build the body by dropping nodes onto the
                    iterator on the canvas; it runs that pipeline once per row
                    of the table wired to the top “values” port, with each
                    row’s columns available inside as{" "}
                    <code>{"{{variable}}"}</code> (auto-quoted text) or{" "}
                    <code>{"${variable}"}</code> (raw), and appends every pass
                    into one table. The <code>out</code> port reads that table.
                  </div>

                  <div className="nb2-hint-sm" style={{ marginTop: 2 }}>
                    {((sel.config.children as any[]) || []).length} step(s)
                    inside
                    {((sel.config.children as any[]) || []).length > 0
                      ? ": " +
                        ((sel.config.children as any[]) || [])
                          .map(
                            (c: any) =>
                              (c.config && c.config.label) || c.type,
                          )
                          .join(", ")
                      : " — drop nodes onto it on the canvas."}
                  </div>
                  {((sel.config.children as any[]) || []).length > 0 && (
                    <button
                      className="btn sm"
                      style={{ marginTop: 4 }}
                      onClick={() => patch(sel.id, { children: [] })}
                    >
                      Clear all steps
                    </button>
                  )}

                  <label className="nb2-lbl">Append into table</label>
                  <input
                    className="nb2-in"
                    value={sel.config.table || ""}
                    placeholder="iter_result"
                    onChange={(e) => patch(sel.id, { table: e.target.value })}
                  />
                  <label className="nb2-check" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={sel.config.reset_first !== false}
                      onChange={(e) =>
                        patch(sel.id, { reset_first: e.target.checked })
                      }
                    />{" "}
                    Clear the table at the start of each run
                  </label>
                  <div className="nb2-hint-sm">
                    On: each run rebuilds the table from this run’s passes only.
                    Off: each run adds its rows to whatever’s already there
                    (accumulate across runs).
                  </div>

                  <label className="nb2-lbl">
                    Rename columns → variables (optional)
                  </label>
                  {(inspCols.vars || []).length === 0 ? (
                    <div className="nb2-hint-sm">
                      Wire a table into the top “values” port to list its
                      columns here.
                    </div>
                  ) : (
                    <>
                      {(inspCols.vars || []).map((c) => {
                        const rn =
                          ((sel.config.var_rename as Record<string, string>) ||
                            {})[c] || "";
                        return (
                          <div
                            className="nb2-row2"
                            key={c}
                            style={{ alignItems: "center" }}
                          >
                            <code style={{ fontSize: 12, alignSelf: "center" }}>
                              {c}
                            </code>
                            <input
                              className="nb2-in"
                              placeholder={c}
                              value={rn}
                              onChange={(e) => {
                                const cur = {
                                  ...((sel.config.var_rename as Record<
                                    string,
                                    string
                                  >) || {}),
                                };
                                if (e.target.value.trim())
                                  cur[c] = e.target.value;
                                else delete cur[c];
                                patch(sel.id, { var_rename: cur });
                              }}
                            />
                          </div>
                        );
                      })}
                      <div className="nb2-hint-sm">
                        Each row becomes one pass; its columns are available
                        inside as <code>{"${name}"}</code> — the new name where
                        you set one, otherwise the original column. Names must
                        be letters, digits, _.
                      </div>
                    </>
                  )}

                  <label className="nb2-lbl">
                    Replace rows matching (optional, keeps re-runs idempotent)
                  </label>
                  {(() => {
                    // The replace keys must be columns of the accumulator table
                    // (the DELETE-before-insert matches on them), so list that
                    // table's own columns once it exists. Before the first run
                    // there's nothing to pick yet.
                    const accName = (sel.config.table || "").trim();
                    const accCols =
                      tables
                        .find((t) => t.name === accName)
                        ?.columns.map((c) => c.name) || [];
                    if (accCols.length === 0) {
                      return (
                        <div className="nb2-hint-sm">
                          Run the iterator once to build{" "}
                          <code>{accName || "the table"}</code>, then pick the
                          key column(s) here — matching rows are replaced
                          instead of duplicated on a re-run.
                        </div>
                      );
                    }
                    return (
                      <div className="nb2-checks">
                        {accCols.map((c) => {
                          const on = (
                            sel.config.replace_keys || []
                          ).includes(c);
                          return (
                            <label key={c} className="nb2-check">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => {
                                  const cur = sel.config.replace_keys || [];
                                  patch(sel.id, {
                                    replace_keys: on
                                      ? cur.filter((x: string) => x !== c)
                                      : [...cur, c],
                                  });
                                }}
                              />{" "}
                              {c}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {renderReduceControls(sel)}

                  <label className="nb2-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={!!sel.config.continue_on_error}
                      onChange={(e) =>
                        patch(sel.id, { continue_on_error: e.target.checked })
                      }
                    />{" "}
                    Keep going on errors
                  </label>

                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    style={{ marginTop: 8 }}
                    onClick={() => doRunIterator(sel)}
                  >
                    <Icon.Refresh size={13} /> Run iterator
                  </button>
                  {sel.config.it_passes != null && (
                    <div className="nb2-note" style={{ marginTop: 8 }}>
                      {sel.config.it_passes}/{sel.config.it_attempted} pass(es) ·{" "}
                      {(sel.config.it_rows ?? 0).toLocaleString()} row(s)
                      {sel.config.it_errors
                        ? ` · ${sel.config.it_errors} failed`
                        : ""}
                      .
                    </div>
                  )}

                  <button
                    className="btn sm"
                    style={{ marginTop: 10 }}
                    disabled={
                      ((sel.config.children as any[]) || []).length === 0
                    }
                    onClick={() => dissolveContainer(sel.id)}
                  >
                    <Icon.PopOut size={13} /> Expand to canvas (dissolve)
                  </button>
                  <div className="nb2-hint-sm">
                    Pops every step out as a standalone node on the canvas and
                    removes the iterator. The loop’s{" "}
                    <code>{"${variables}"}</code> are no longer bound once
                    expanded.
                  </div>
                </>
              )}

              {inspectorType === "while" && (
                <>
                  <div className="nb2-hint-sm" style={{ marginBottom: 6 }}>
                    Repeats the wired body until a pass adds no new rows (a
                    fixpoint) or the cap is hit. If the body reads the table it
                    is building, seed that table first and turn off “clear”.
                  </div>

                  <label className="nb2-lbl">Repeat into table</label>
                  <input
                    className="nb2-in"
                    value={sel.config.table || ""}
                    placeholder="closure"
                    onChange={(e) => patch(sel.id, { table: e.target.value })}
                  />

                  <label className="nb2-lbl">
                    Iteration variable (optional, bound to 1, 2, 3 …)
                  </label>
                  <input
                    className="nb2-in"
                    value={sel.config.var || ""}
                    placeholder="i"
                    onChange={(e) => patch(sel.id, { var: e.target.value })}
                  />

                  <label className="nb2-check" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={sel.config.reset_first !== false}
                      onChange={(e) =>
                        patch(sel.id, { reset_first: e.target.checked })
                      }
                    />{" "}
                    Clear the table at the start of each run
                  </label>
                  <div className="nb2-hint-sm">
                    On: each run rebuilds the table from this run’s passes only.
                    Off: each run keeps adding to whatever’s already there.
                  </div>

                  <label className="nb2-lbl">
                    Replace rows matching (set semantics; recommended for a
                    fixpoint so re-seen rows don’t keep the loop alive)
                  </label>
                  <div className="nb2-checks">
                    {(inspCols.in || []).map((c) => {
                      const on = (sel.config.replace_keys || []).includes(c);
                      return (
                        <label key={c} className="nb2-check">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = sel.config.replace_keys || [];
                              patch(sel.id, {
                                replace_keys: on
                                  ? cur.filter((x: string) => x !== c)
                                  : [...cur, c],
                              });
                            }}
                          />{" "}
                          {c}
                        </label>
                      );
                    })}
                  </div>

                  {renderReduceControls(sel)}

                  <label className="nb2-lbl">Max iterations</label>
                  <input
                    className="nb2-in"
                    type="number"
                    min={1}
                    value={sel.config.max_iters ?? 100}
                    onChange={(e) =>
                      patch(sel.id, {
                        max_iters: parseInt(e.target.value, 10) || 100,
                      })
                    }
                  />

                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    style={{ marginTop: 8 }}
                    onClick={() => doRunWhile(sel)}
                  >
                    <Icon.Refresh size={13} /> Run until done
                  </button>
                  {sel.config.wh_iters != null && (
                    <div className="nb2-note" style={{ marginTop: 8 }}>
                      {sel.config.wh_converged ? "Converged" : "Stopped"} after{" "}
                      {sel.config.wh_iters} iteration(s) ·{" "}
                      {(sel.config.wh_rows ?? 0).toLocaleString()} row(s).
                    </div>
                  )}
                </>
              )}

              {inspectorType === "sql" && (
                <>
                  <label className="nb2-lbl">Query</label>
                  <textarea
                    className="nb2-in nb2-sql-area"
                    rows={Math.max(
                      6,
                      Math.min(
                        80,
                        String(sel.config.sql || "").split("\n").length + 1,
                      ),
                    )}
                    spellCheck={false}
                    value={sel.config.sql || ""}
                    placeholder={"SELECT *\nFROM input\nWHERE ..."}
                    onChange={(e) => patch(sel.id, { sql: e.target.value })}
                  />
                  <div className="nb2-hint-sm">
                    A read-only SELECT. Use <code>input</code> to mean the data
                    wired into this node (e.g.{" "}
                    <code>SELECT * FROM input</code>), or <code>{"{{in}}"}</code>{" "}
                    to splice it in. Workflow variables work here too:{" "}
                    <code>{"{{name}}"}</code> for a text value (auto-quoted, no
                    quotes needed) or <code>{"${name}"}</code> for a raw number.
                  </div>
                  {edges.some(
                    (e) => e.to.node === sel.id && e.to.port === "in",
                  ) &&
                    !/\b(from|join)\s+input\b/i.test(sel.config.sql || "") &&
                    !/\{\{\s*in(put)?\s*\}\}/.test(sel.config.sql || "") && (
                      <div className="nb2-warn-sm">
                        This query doesn't read from <code>input</code>. Keep
                        <code> FROM input</code> so it uses the wired data
                        instead of a table that may not exist.
                      </div>
                    )}
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "python" && (
                <>
                  <label className="nb2-lbl">Python script</label>
                  <textarea
                    className="nb2-in nb2-sql-area"
                    rows={Math.max(
                      8,
                      Math.min(
                        80,
                        String(sel.config.code || "").split("\n").length + 1,
                      ),
                    )}
                    spellCheck={false}
                    value={sel.config.code || ""}
                    placeholder={
                      "# columns / rows / df from optional input\nout = df"
                    }
                    onChange={(e) => patch(sel.id, { code: e.target.value })}
                  />
                  <div className="nb2-hint-sm">
                    Runs inside SamQL&apos;s bundled Python (pandas included
                    in distribution builds). Wire an upstream table into the
                    input: the script sees{" "}
                    <code>df</code> (a pandas DataFrame),{" "}
                    <code>columns</code>, <code>rows</code>, and{" "}
                    <code>records</code> (list of dicts). Example:{" "}
                    <code>{`out = df[df["score"] > 50]`}</code>. Assign{" "}
                    <code>out</code> to a DataFrame, a list of dicts, or{" "}
                    <code>{`{"columns": [...], "rows": [...]}`}</code>.{" "}
                    <code>import pandas as pd</code> is allowed. Other allowed
                    imports: math, datetime, json, re, collections, itertools,
                    statistics, …
                  </div>
                  <label className="nb2-lbl">Timeout (seconds)</label>
                  <input
                    className="nb2-in"
                    type="number"
                    min={1}
                    max={300}
                    value={sel.config.timeout_s ?? 30}
                    onChange={(e) =>
                      patch(sel.id, {
                        timeout_s: Math.max(
                          1,
                          Math.min(300, Number(e.target.value) || 30),
                        ),
                      })
                    }
                  />
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() =>
                      doPreview(sel, "out", `${sel.config.label} · output`)
                    }
                  >
                    <Icon.Table size={13} /> Preview output
                  </button>
                </>
              )}

              {inspectorType === "write" && (
                <>
                  <label className="nb2-lbl">Table name</label>
                  <input
                    className="nb2-in"
                    value={sel.config.name || ""}
                    placeholder="flow_result"
                    onChange={(e) => patch(sel.id, { name: e.target.value })}
                  />
                  <label className="nb2-lbl">When the table exists</label>
                  <select
                    className="nb2-in"
                    value={sel.config.mode || "overwrite"}
                    onChange={(e) => patch(sel.id, { mode: e.target.value })}
                  >
                    <option value="overwrite">Overwrite (replace it)</option>
                    <option value="append">Append (add rows)</option>
                  </select>
                  {(sel.config.mode || "overwrite") === "append" && (
                    <>
                      <label className="nb2-lbl">
                        Replace rows matching (optional, keeps re-runs idempotent)
                      </label>
                      <div className="nb2-checks">
                        {(inspCols.in || []).map((c) => {
                          const on = (sel.config.replace_keys || []).includes(c);
                          return (
                            <label key={c} className="nb2-check">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => {
                                  const cur = sel.config.replace_keys || [];
                                  patch(sel.id, {
                                    replace_keys: on
                                      ? cur.filter((x: string) => x !== c)
                                      : [...cur, c],
                                  });
                                }}
                              />{" "}
                              {c}
                            </label>
                          );
                        })}
                      </div>
                      <div className="nb2-hint-sm">
                        With key columns chosen, rows already in the table that
                        share those keys are deleted before the new rows are
                        added — so re-running (or re-pulling a day) replaces
                        rather than duplicates. Columns are matched by name;
                        missing ones are filled with NULL.
                      </div>
                    </>
                  )}
                  <div className="nb2-hint-sm">
                    Writes the incoming rows to a loaded table you can query and
                    join.
                    {(sel.config.mode || "overwrite") === "append"
                      ? " Append adds to the table (creating it on the first write)."
                      : " Overwrite replaces a table of the same name."}
                  </div>
                  <button
                    className="btn sm primary nb2-prev"
                    disabled={running}
                    onClick={() => doWriteTable(sel)}
                  >
                    <Icon.Save size={13} /> Write to workspace
                  </button>
                </>
              )}

              {inspectorType === "output" && (
                <>
                  <label className="nb2-lbl">Output folder</label>
                  <div className="nb2-folder">
                    <input
                      className="nb2-in"
                      placeholder="Downloads (default) or browse…"
                      value={sel.config.folder || ""}
                      onChange={(e) => patch(sel.id, { folder: e.target.value })}
                    />
                    <button className="btn sm" onClick={() => setBrowseFolder(true)}>
                      <Icon.Folder size={13} />
                    </button>
                  </div>
                  <label className="nb2-lbl">File name</label>
                  <input
                    className="nb2-in"
                    value={sel.config.base_name || ""}
                    onChange={(e) => patch(sel.id, { base_name: e.target.value })}
                  />
                  {(() => {
                    const kind = outputKind(sel);
                    const isImage = kind === "chart" || kind === "dashboard";
                    const fmts =
                      kind === "chart"
                        ? IMAGE_FORMATS_CHART
                        : kind === "dashboard"
                          ? IMAGE_FORMATS_DASH
                          : DATA_FORMATS;
                    const cur = (sel.config.format || (isImage ? "png" : "csv")).toLowerCase();
                    const val = fmts.includes(cur) ? cur : fmts[0];
                    return (
                      <>
                        <div className="nb2-note">
                          {kind === "none"
                            ? "Connect a node to this Output. A chart or dashboard saves as an image; data saves as a file."
                            : isImage
                              ? `The ${kind} is saved as an image when you run the workflow (Run all).`
                              : "Saving the incoming data as a file."}
                        </div>
                        <label className="nb2-lbl">Format</label>
                        <select
                          className="nb2-in"
                          value={val}
                          onChange={(e) => patch(sel.id, { format: e.target.value })}
                        >
                          {fmts.map((f) => (
                            <option key={f} value={f}>
                              {FORMAT_LABELS[f] || f.toUpperCase()}
                            </option>
                          ))}
                        </select>
                        {!isImage && (
                          <div className="nb2-prev-row">
                            <button
                              className="btn sm"
                              disabled={running}
                              onClick={() =>
                                doPreview(sel, "out", `${sel.config.label} · input`)
                              }
                            >
                              Preview
                            </button>
                            <button
                              className="btn sm primary"
                              disabled={running || kind === "none"}
                              onClick={() => doExport(sel)}
                            >
                              <Icon.Download size={13} /> Run &amp; export
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}

              {inspectorType === "samqldash" && (
                <>
                  <div className="nb2-note">
                    Marks this workflow as Dashboard-ready. Wire a chart, pivot,
                    reconcile, or data node into this sink, then save the
                    workflow. It becomes selectable from the Dashboard tab’s +
                    button.
                  </div>
                  <div className="nb2-hint-sm">
                    The Dashboard Run button executes the upstream NodeFlow and
                    renders the result in a widget cell.
                  </div>
                </>
              )}

              {inspectorType === "dyn_input" && (
                <div className="nb2-note">
                  Entry port for a Created Node. Wire this into the start of your
                  tab graph, then use Settings → Create a node. Order on the
                  canvas (top to bottom) sets in1, in2, …
                </div>
              )}

              {inspectorType === "dyn_output" && (
                <div className="nb2-note">
                  Exit port for a Created Node. Wire the last transform into this
                  node. Top-to-bottom order sets out1, out2, …
                </div>
              )}

              {inspectorType === "usernode" && (
                <>
                  <div className="nb2-note">
                    Reusable node “
                    {sel.config.name || sel.config.label || "created"}” with{" "}
                    {sel.config.inputCount || 0} input
                    {(sel.config.inputCount || 0) === 1 ? "" : "s"} and{" "}
                    {sel.config.outputCount || 0} output
                    {(sel.config.outputCount || 0) === 1 ? "" : "s"}.
                  </div>
                  {(sel.config.outputs || []).map((out: any) => (
                    <button
                      key={out.port}
                      className="btn sm"
                      disabled={running}
                      onClick={() =>
                        doPreview(
                          sel,
                          out.port,
                          `${sel.config.label || sel.config.name} · ${out.port}`,
                        )
                      }
                    >
                      Preview {out.port}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </InspectorShell>
  );
};
