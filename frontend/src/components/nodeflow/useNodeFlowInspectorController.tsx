import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  applySelectColumnsReconcile,
  collectSelectFieldPatches,
  fieldsDiffer,
  listWiredSelectUpstreams,
  reconcileSelectFields,
} from "../../lib/selectFields";
import {
  clearNodeflowColsCache,
  fingerprintColumnReqs,
  getNodeflowColsCache,
  nodeflowColsCacheKey,
  setNodeflowColsCache,
  tablesSchemaSig,
} from "../../lib/nodeflowColumnsCache";
import { runAfterPaint } from "../../lib/prettyStruct";
import { buildNodeflowFilterCond } from "../../lib/sql";
import { staleNodeflowColumnRefs } from "../../lib/staleNodeflowColumnRefs";
import { PORTS, type NbEdge, type NbNode } from "../../lib/nodeFlowModel";
import type { NodeFlowInspectorContext } from "./NodeFlowInspector";

const EMPTY_INSP_COLS: Record<string, string[]> = {};

export type ManagedInspectorKey =
  | "buildFilterCond"
  | "childSelCtx"
  | "edges"
  | "filterFx"
  | "filterHint"
  | "filterInsertFunc"
  | "filterPickField"
  | "filterRecompute"
  | "filterRef"
  | "FX_FUNCS"
  | "fxField"
  | "fxFocus"
  | "fxHint"
  | "fxInsertFunc"
  | "fxPickField"
  | "fxRecompute"
  | "fxRefs"
  | "fxSetExpr"
  | "inspCols"
  | "inspColsProbing"
  | "inspectorDocked"
  | "inspectorHost"
  | "nodes"
  | "patch"
  | "renderReduceControls"
  | "seedSelectFields"
  | "sel"
  | "setAggs"
  | "setAllFieldsKept"
  | "setFilterCond"
  | "setFilterFx"
  | "setFilterHint"
  | "setFormulas"
  | "setFxField"
  | "setFxHint"
  | "setKeys"
  | "setSorts"
  | "setWindows"
  | "showTables"
  | "staleColRefs"
  | "toggleInArray"
  | "updateField";

export type NodeFlowInspectorRuntime = Omit<
  NodeFlowInspectorContext,
  ManagedInspectorKey
>;

interface UseNodeFlowInspectorControllerOptions {
  scopeKey: string;
  nodes: NbNode[];
  edges: NbEdge[];
  selectedId: string | null;
  selectedNode: NbNode | null;
  childSelection: { groupId: string; index: number; child: NbNode } | null;
  graphSig: string;
  graphForApi: () => any;
  partialGroupGraph: (groupId: string, count: number) => any;
  patch: (id: string, config: Record<string, any>) => void;
  showTables?: boolean;
  inspectorHost?: HTMLElement | null;
  runtime: NodeFlowInspectorRuntime;
}

export function useNodeFlowInspectorController({
  scopeKey,
  nodes,
  edges,
  selectedId,
  selectedNode,
  childSelection,
  graphSig,
  graphForApi,
  partialGroupGraph,
  patch,
  showTables,
  inspectorHost,
  runtime,
}: UseNodeFlowInspectorControllerOptions): NodeFlowInspectorContext {
  const selId = selectedId;
  const sel = selectedNode;
  const childCtx = (_id: string | null) => childSelection;
  // upstream columns for the select / join inspectors -----------------------
  // Raw probe result + the node id they belong to. Derived `inspCols` is empty
  // whenever ownership does not match the current selection so a Select
  // reconcile never applies a sibling / previously-selected node's schema
  // (which used to seed false missing-field tombstones on switch/add).
  const [inspColsRaw, setInspColsRaw] = useState<Record<string, string[]>>({});
  const [inspColsOwnedBy, setInspColsOwnedBy] = useState<string | null>(null);
  const inspCols = useMemo(() => {
    if (inspColsOwnedBy != null && inspColsOwnedBy === selId) return inspColsRaw;
    return EMPTY_INSP_COLS;
  }, [inspColsOwnedBy, selId, inspColsRaw]);
  // True while a column probe is in flight after select/graph change. Distinguishes
  // "still loading fields" from "genuinely unwired / empty upstream".
  const [inspColsProbingRaw, setInspColsProbing] = useState(false);
  const selHasInputPorts = !!(
    selectedNode && (PORTS[selectedNode.type]?.inputs || []).length
  );
  // Ownership mismatch means we have not published columns for this selection
  // yet — treat as probing so the UI does not flash "Connect an input".
  const inspColsProbing =
    inspColsOwnedBy !== selId && selHasInputPorts
      ? true
      : inspColsProbingRaw;
  const publishInspCols = (nodeId: string, cols: Record<string, string[]>) => {
    setInspColsOwnedBy(nodeId);
    setInspColsRaw(cols);
  };
  const clearInspCols = () => {
    setInspColsOwnedBy(null);
    setInspColsRaw({});
  };
  // Defer column probes until a canvas drag/resize finishes so rearranging
  // nodes does not enqueue/cancel network work every selection flash.
  const afterDragIdle = (run: () => void): (() => void) => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = () => {
      if (cancelled) return;
      if (document.documentElement.dataset.samqlNfDrag === "1") {
        timer = window.setTimeout(tick, 80);
        return;
      }
      run();
    };
    tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  };
  // Loaded-table schema fingerprint: reload/reshape with the same graph must
  // miss the columns cache (backend flow fingerprints salt _data_epoch).
  const schemaSig = tablesSchemaSig(runtime.tables);
  useEffect(() => {
    clearNodeflowColsCache();
  }, [schemaSig]);
  // Resolve upstream columns for the selection. Ownership gating (inspCols)
  // already hides sibling schemas on selId change — do not clear-on-select
  // before paint (that raced cache hits and flashed empty inspectors).
  // Cache hits publish in useLayoutEffect so the first painted frame already
  // has the new node's columns when known.
  useLayoutEffect(() => {
    if (!sel) {
      setInspColsProbing(false);
      return;
    }
    // a child of a group: resolve EACH input port the way the backend group
    // does -- an explicit binding to one of the group's own inputs wins; the
    // first port otherwise comes from the step above it (or the group's primary
    // input for the first step); any other unbound port is left unfed. Without
    // this, a multi-input step like a join only got columns for its first port,
    // so the "right" key dropdown stayed empty even after the group inputs were
    // wired and bound.
    const cctx = childCtx(selId);
    if (cctx) {
      const inPorts = PORTS[sel.type]?.inputs || [];
      if (!inPorts.length) {
        setInspColsProbing(false);
        return;
      }
      const grp = nodes.find((n) => n.id === cctx.groupId);
      const binds = ((grp?.config.bindings || {}) as any)[sel.id] || {};
      const groupReqs: { port: string; node: string; fromPort: string }[] = [];
      let stepAbovePort: string | null = null;
      for (const port of inPorts) {
        const gp =
          binds[port] ||
          (port === inPorts[0] && cctx.index === 0 ? "in" : null);
        if (gp) {
          const e = edges.find(
            (x) => x.to.node === cctx.groupId && x.to.port === gp,
          );
          if (e)
            groupReqs.push({ port, node: e.from.node, fromPort: e.from.port });
        } else if (port === inPorts[0] && cctx.index > 0) {
          stepAbovePort = port;
        }
      }
      if (!groupReqs.length && !stepAbovePort) {
        clearInspCols();
        setInspColsProbing(false);
        return;
      }
      const fp = fingerprintColumnReqs(
        groupReqs,
        stepAbovePort ? `step:${stepAbovePort}@${cctx.index}` : "",
      );
      const cacheKey = nodeflowColsCacheKey(
        graphSig,
        sel.id,
        "group-child",
        fp,
        schemaSig,
      );
      const cached = getNodeflowColsCache(cacheKey);
      if (cached) {
        publishInspCols(sel.id, cached);
        setInspColsProbing(false);
        return;
      }
      setInspColsProbing(true);
      let cancelled = false;
      const probedId = sel.id;
      let stopWait: (() => void) | undefined;
      const cancelPaint = runAfterPaint(() => {
        stopWait = afterDragIdle(() => {
          if (cancelled) return;
          (async () => {
            const out: Record<string, string[]> = {};
            let ok = false;
            try {
              await Promise.all([
                (async () => {
                  if (!groupReqs.length) return;
                  const r = await api.nodeflowColumnsBatch(
                    graphForApi(),
                    groupReqs.map((q) => ({ node: q.node, port: q.fromPort })),
                  );
                  (r.results || []).forEach((res, i) => {
                    if (res && res.columns && groupReqs[i])
                      out[groupReqs[i].port] = res.columns;
                  });
                })(),
                (async () => {
                  if (!stepAbovePort) return;
                  const r = await api.nodeflowColumns(
                    partialGroupGraph(cctx.groupId, cctx.index),
                    cctx.groupId,
                    "out",
                  );
                  if (r.columns) out[stepAbovePort] = r.columns;
                })(),
              ]);
              ok = true;
            } catch {
              /* ignore — do not cache failures as empty schemas */
            }
            if (!cancelled) {
              // Always publish so ownership matches selection and probing can
              // end. Only successful responses are cached — failures must miss
              // on the next select so the probe retries.
              if (ok) setNodeflowColsCache(cacheKey, out);
              publishInspCols(probedId, out);
              setInspColsProbing(false);
            }
          })();
        });
      });
      return () => {
        cancelled = true;
        cancelPaint();
        stopWait?.();
      };
    }
    // every input port this node actually has, read straight from the port
    // table -- so no node type can be missed (filter was, before this) and the
    // fetched column keys always match what each inspector reads by port name.
    // Nodes with no inputs resolve to [] and skip the fetch below.
    const wantPorts = PORTS[sel.type]?.inputs || [];
    if (!wantPorts.length) {
      setInspColsProbing(false);
      return;
    }
    // resolve each wanted input port to the upstream (node, port) feeding it,
    // then fetch all their columns in a single batched request
    const reqs: { port: string; node: string; fromPort: string }[] = [];
    for (const port of wantPorts) {
      const e = edges.find((x) => x.to.node === sel.id && x.to.port === port);
      if (e) reqs.push({ port, node: e.from.node, fromPort: e.from.port });
    }
    if (!reqs.length) {
      clearInspCols();
      setInspColsProbing(false);
      return;
    }
    const fp = fingerprintColumnReqs(reqs);
    const cacheKey = nodeflowColsCacheKey(
      graphSig,
      sel.id,
      "canvas",
      fp,
      schemaSig,
    );
    const cached = getNodeflowColsCache(cacheKey);
    if (cached) {
      publishInspCols(sel.id, cached);
      setInspColsProbing(false);
      return;
    }
    setInspColsProbing(true);
    let cancelled = false;
    const probedId = sel.id;
    let stopWait: (() => void) | undefined;
    const cancelPaint = runAfterPaint(() => {
      stopWait = afterDragIdle(() => {
        if (cancelled) return;
        (async () => {
          const out: Record<string, string[]> = {};
          let ok = false;
          try {
            const r = await api.nodeflowColumnsBatch(
              graphForApi(),
              reqs.map((q) => ({ node: q.node, port: q.fromPort })),
            );
            (r.results || []).forEach((res, i) => {
              if (res && res.columns && reqs[i]) out[reqs[i].port] = res.columns;
            });
            ok = true;
          } catch {
            /* ignore — do not cache failures as empty schemas */
          }
          if (!cancelled) {
            // Always publish so ownership matches selection and probing can
            // end. Only successful responses are cached — failures must miss
            // on the next select so the probe retries.
            if (ok) setNodeflowColsCache(cacheKey, out);
            publishInspCols(probedId, out);
            setInspColsProbing(false);
          }
        })();
      });
    });
    return () => {
      cancelled = true;
      cancelPaint();
      stopWait?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, selId, graphSig, schemaSig]);

  // Keep EVERY wired Select node's field list in sync whenever the graph
  // structure/config changes -- top-level AND Selects inside group/iterator
  // children. Changing an Input table updates graphSig while the Input is
  // selected; without this pass nested Selects kept stale fields forever.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    const reqs = listWiredSelectUpstreams(nodes, edges);
    if (!reqs.length) return;
    let cancelled = false;
    (async () => {
      const columnsBySelectId: Record<string, string[]> = {};
      const batchReqs = reqs.filter(
        (q) =>
          (q.kind === "canvas" || q.kind === "group-input") &&
          q.upstreamNode &&
          q.upstreamPort,
      );
      try {
        await Promise.all([
          (async () => {
            if (!batchReqs.length) return;
            const r = await api.nodeflowColumnsBatch(
              graphForApi(),
              batchReqs.map((q) => ({
                node: q.upstreamNode!,
                port: q.upstreamPort!,
              })),
            );
            (r.results || []).forEach((res, i) => {
              if (res?.columns && batchReqs[i])
                columnsBySelectId[batchReqs[i].selectId] = res.columns;
            });
          })(),
          ...reqs
            .filter(
              (q) =>
                q.kind === "step-above" &&
                q.groupId &&
                typeof q.childIndex === "number",
            )
            .map(async (q) => {
              try {
                const r = await api.nodeflowColumns(
                  partialGroupGraph(q.groupId!, q.childIndex!),
                  q.groupId!,
                  "out",
                );
                if (r.columns) columnsBySelectId[q.selectId] = r.columns;
              } catch {
                /* ignore */
              }
            }),
        ]);
      } catch {
        /* ignore */
      }
      if (cancelled || !Object.keys(columnsBySelectId).length) return;
      const latest = nodesRef.current;
      const reconciled = applySelectColumnsReconcile(latest, columnsBySelectId);
      if (reconciled === latest) return;
      for (const p of collectSelectFieldPatches(latest, reconciled)) {
        patch(p.id, { fields: p.fields });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, graphSig]);

  // Same soft reconcile for the selected Select from its inspector column
  // cache (covers group-child Selects and the moment columns first arrive).
  // Only runs once upstream columns are known *for this node*, so a
  // momentarily-disconnected node doesn't get its fields wiped, and switching
  // selection never applies a sibling Select's upstream schema. Missing
  // sources stay as tombstones.
  useEffect(() => {
    if (
      !sel ||
      sel.type !== "select" ||
      inspColsOwnedBy !== sel.id ||
      !inspCols.in ||
      !inspCols.in.length
    )
      return;
    const cols = inspCols.in;
    const cur = sel.config.fields || [];
    const next = reconcileSelectFields(cols, cur);
    if (fieldsDiffer(next, cur)) patch(sel.id, { fields: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, inspCols, inspColsOwnedBy, selId]);

  // Pivot: do NOT auto-drop missing row/col/value refs on schema refresh.
  // Missing refs stay until the user edits them or a successful rerun prunes
  // via pruneNodeflowMissingAfterRun.

  const staleColRefs = useMemo(() => {
    if (!sel) return [];
    return staleNodeflowColumnRefs(sel.type, sel.config || {}, inspCols);
  }, [sel, inspCols]);

  // Schema refresh / inspCols settle must NOT auto-wipe column refs.
  // Missing refs stay visible (banner + strikethrough); Clear is user-only;
  // successful workflow rerun prunes via pruneNodeflowMissingAfterRun.
  const seedSelectFields = () => {
    if (sel && inspCols.in)
      patch(sel.id, {
        fields: inspCols.in.map((c) => ({ name: c, keep: true })),
      });
  };
  const updateField = (idx: number, p: Record<string, any>) => {
    if (!sel) return;
    const fields = (sel.config.fields || []).map((f: any, i: number) =>
      i === idx ? { ...f, ...p } : f,
    );
    patch(sel.id, { fields });
  };
  // tick / untick every field at once (select-all / select-none)
  const setAllFieldsKept = (keep: boolean) => {
    if (!sel) return;
    const fields = (sel.config.fields || []).map((f: any) => ({ ...f, keep }));
    patch(sel.id, { fields });
  };
  const setKeys = (keys: any[]) => sel && patch(sel.id, { keys });
  const setFormulas = (formulas: any[]) =>
    sel && patch(sel.id, { formulas });
  // formula editor: a resizable expression box with [field] autocomplete and
  // clickable function templates. fxField holds the active field-suggest popup.
  const fxRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const fxFocus = useRef<number>(-1);
  const [fxField, setFxField] = useState<
    { i: number; from: number; to: number; items: string[] } | null
  >(null);
  // signature of the function the cursor is on, shown under the palette so the
  // required parameters are always visible
  const [fxHint, setFxHint] = useState<string>("");
  const FX_FUNCS: { label: string; tpl: string; sig: string }[] = [
    { label: "UPPER", tpl: "UPPER([])", sig: "UPPER(text)" },
    { label: "LOWER", tpl: "LOWER([])", sig: "LOWER(text)" },
    { label: "TRIM", tpl: "TRIM([])", sig: "TRIM(text)" },
    { label: "LTRIM", tpl: "LTRIM([])", sig: "LTRIM(text)" },
    { label: "RTRIM", tpl: "RTRIM([])", sig: "RTRIM(text)" },
    { label: "LENGTH", tpl: "LENGTH([])", sig: "LENGTH(text)" },
    { label: "SUBSTR", tpl: "SUBSTR([], 1, 3)", sig: "SUBSTR(text, start, length)" },
    { label: "REPLACE", tpl: "REPLACE([], 'a', 'b')", sig: "REPLACE(text, find, replacement)" },
    { label: "INSTR", tpl: "INSTR([], 'x')", sig: "INSTR(text, search)" },
    { label: "concat ||", tpl: "[] || ''", sig: "value || value" },
    { label: "LIKE", tpl: "[] LIKE '%x%'", sig: "text LIKE pattern" },
    { label: "ROUND", tpl: "ROUND([], 2)", sig: "ROUND(number, decimals)" },
    { label: "ABS", tpl: "ABS([])", sig: "ABS(number)" },
    { label: "modulo %", tpl: "[] % 2", sig: "number % divisor" },
    { label: "COALESCE", tpl: "COALESCE([], 0)", sig: "COALESCE(value, fallback)" },
    { label: "NULLIF", tpl: "NULLIF([], 0)", sig: "NULLIF(value, equals)" },
    { label: "IFNULL", tpl: "IFNULL([], 0)", sig: "IFNULL(value, fallback)" },
    { label: "IF", tpl: "IF([], '', '')", sig: "IF(condition, then, else)" },
    { label: "CASE WHEN", tpl: "CASE WHEN [] THEN '' ELSE '' END", sig: "CASE WHEN cond THEN a ELSE b END" },
    { label: "CAST → int", tpl: "CAST([] AS INTEGER)", sig: "CAST(value AS INTEGER)" },
    { label: "CAST → decimal", tpl: "CAST([] AS REAL)", sig: "CAST(value AS REAL)" },
    { label: "CAST → text", tpl: "CAST([] AS TEXT)", sig: "CAST(value AS TEXT)" },
    { label: "regex match", tpl: "regexp_matches([], 'pattern')", sig: "regexp_matches(text, pattern) → 0 / 1" },
    { label: "regex replace", tpl: "regexp_replace([], 'pattern', 'replacement')", sig: "regexp_replace(text, pattern, replacement)" },
    { label: "regex extract", tpl: "regexp_extract([], '(pattern)')", sig: "regexp_extract(text, pattern) → first group" },
  ];
  const fxSetExpr = (i: number, expr: string) =>
    setFormulas(
      (sel!.config.formulas || []).map((x: any, j: number) =>
        j === i ? { ...x, expr } : x,
      ),
    );
  // recompute the field-suggest popup from the textarea caret (a partial
  // reference inside an unclosed [ ... )
  const fxRecompute = (i: number, el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? 0;
    const before = (el.value || "").slice(0, caret);
    const open = before.lastIndexOf("[");
    if (open === -1 || before.slice(open + 1).includes("]"))
      return setFxField(null);
    const q = before.slice(open + 1).toLowerCase();
    const items = (inspCols.in || []).filter((c) =>
      c.toLowerCase().includes(q),
    );
    setFxField(items.length ? { i, from: open, to: caret, items } : null);
  };
  // pick a field from the popup: replace the [partial with [Field]
  const fxPickField = (field: string) => {
    if (!fxField) return;
    const i = fxField.i;
    const cur = (sel!.config.formulas || [])[i]?.expr || "";
    const next =
      cur.slice(0, fxField.from) + "[" + field + "]" + cur.slice(fxField.to);
    fxSetExpr(i, next);
    setFxField(null);
    const pos = fxField.from + field.length + 2;
    requestAnimationFrame(() => {
      const el = fxRefs.current[i];
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };
  // insert a function template at the focused formula's caret; drop the caret
  // inside the first [] so the field popup can take over
  const fxInsertFunc = (tpl: string) => {
    const i = fxFocus.current;
    if (i < 0) return;
    const el = fxRefs.current[i];
    const cur = (sel!.config.formulas || [])[i]?.expr || "";
    const at = el ? el.selectionStart ?? cur.length : cur.length;
    const next = cur.slice(0, at) + tpl + cur.slice(at);
    fxSetExpr(i, next);
    const br = tpl.indexOf("[]");
    const pos = at + (br >= 0 ? br + 1 : tpl.length);
    requestAnimationFrame(() => {
      const e2 = fxRefs.current[i];
      if (e2) {
        e2.focus();
        e2.setSelectionRange(pos, pos);
      }
    });
  };
  const setAggs = (aggs: any[]) => sel && patch(sel.id, { aggs });
  const setSorts = (sorts: any[]) => sel && patch(sel.id, { sorts });
  const setWindows = (windows: any[]) => sel && patch(sel.id, { windows });
  // --- custom-filter editor: one textarea that behaves like the formula box
  // ([field] autocomplete + function templates). Parallel to the fx* helpers
  // but keyed to the filter's single condition string.
  const filterRef = useRef<HTMLTextAreaElement | null>(null);
  const [filterFx, setFilterFx] = useState<
    { from: number; to: number; items: string[] } | null
  >(null);
  const [filterHint, setFilterHint] = useState<string>("");
  const setFilterCond = (condition: string) =>
    sel && patch(sel.id, { condition, filterMode: "custom" });
  const filterRecompute = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? 0;
    const before = (el.value || "").slice(0, caret);
    const open = before.lastIndexOf("[");
    if (open === -1 || before.slice(open + 1).includes("]"))
      return setFilterFx(null);
    const q = before.slice(open + 1).toLowerCase();
    const items = (inspCols.in || []).filter((c) =>
      c.toLowerCase().includes(q),
    );
    setFilterFx(items.length ? { from: open, to: caret, items } : null);
  };
  const filterPickField = (field: string) => {
    if (!filterFx) return;
    const cur = sel?.config.condition || "";
    const next =
      cur.slice(0, filterFx.from) + "[" + field + "]" + cur.slice(filterFx.to);
    setFilterCond(next);
    setFilterFx(null);
    const pos = filterFx.from + field.length + 2;
    requestAnimationFrame(() => {
      const el = filterRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };
  const filterInsertFunc = (tpl: string) => {
    const el = filterRef.current;
    const cur = sel?.config.condition || "";
    const at = el ? el.selectionStart ?? cur.length : cur.length;
    const next = cur.slice(0, at) + tpl + cur.slice(at);
    setFilterCond(next);
    const br = tpl.indexOf("[]");
    const pos = at + (br >= 0 ? br + 1 : tpl.length);
    requestAnimationFrame(() => {
      const e2 = filterRef.current;
      if (e2) {
        e2.focus();
        e2.setSelectionRange(pos, pos);
      }
    });
  };
  // build a SQL condition from the simple field/operator/value controls
  // (shared helper unwraps SQL-quoted ISO dates so they are not double-quoted)
  const buildFilterCond = buildNodeflowFilterCond;
  const toggleInArray = (field: string, col: string) => {
    if (!sel) return;
    const cur: string[] = sel.config[field] || [];
    patch(sel.id, {
      [field]: cur.includes(col)
        ? cur.filter((c) => c !== col)
        : [...cur, col],
    });
  };

  const renderReduceControls = (sel: NbNode) => (
    <>
      <label className="nb2-lbl">Accumulate</label>
      <select
        className="nb2-in"
        value={sel.config.accumulate || "append"}
        onChange={(e) => patch(sel.id, { accumulate: e.target.value })}
      >
        <option value="append">Append rows</option>
        <option value="reduce">Reduce (fold by key)</option>
      </select>
      {(sel.config.accumulate || "append") === "reduce" && (
        <>
          <label className="nb2-lbl">Fold by key columns</label>
          <div className="nb2-checks">
            {(inspCols.in || []).map((c) => {
              const on = (sel.config.reduce_keys || []).includes(c);
              return (
                <label key={c} className="nb2-check">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const cur = sel.config.reduce_keys || [];
                      patch(sel.id, {
                        reduce_keys: on
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
          <label className="nb2-lbl">Measures to fold</label>
          {((sel.config.reduce_aggs as { col: string; fn: string }[]) || []).map(
            (m, idx) => (
              <div className="nb2-row2" key={idx}>
                <select
                  className="nb2-in"
                  value={m.col || ""}
                  onChange={(e) => {
                    const cur = [...(sel.config.reduce_aggs || [])];
                    cur[idx] = { ...cur[idx], col: e.target.value };
                    patch(sel.id, { reduce_aggs: cur });
                  }}
                >
                  <option value="">(column)</option>
                  {(inspCols.in || []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                  <select
                    className="nb2-in"
                    value={m.fn || "sum"}
                    onChange={(e) => {
                      const cur = [...(sel.config.reduce_aggs || [])];
                      cur[idx] = { ...cur[idx], fn: e.target.value };
                      patch(sel.id, { reduce_aggs: cur });
                    }}
                  >
                    <option value="sum">sum</option>
                    <option value="min">min</option>
                    <option value="max">max</option>
                    <option value="count">count</option>
                  </select>
                  <button
                    className="btn ghost icon xbtn"
                    title="Remove"
                    onClick={() => {
                      const cur = [...(sel.config.reduce_aggs || [])];
                      cur.splice(idx, 1);
                      patch(sel.id, { reduce_aggs: cur });
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ),
          )}
          <button
            className="btn sm"
            style={{ marginTop: 4 }}
            onClick={() =>
              patch(sel.id, {
                reduce_aggs: [
                  ...(sel.config.reduce_aggs || []),
                  { col: "", fn: "sum" },
                ],
              })
            }
          >
            + measure
          </button>
          <div className="nb2-hint-sm">
            Keeps one row per key, folding each measure across passes. Only
            sum/min/max/count fold correctly — average as sum/count yourself.
          </div>
        </>
      )}
    </>
  );

  const inspectorDocked = !!(showTables && inspectorHost && sel);
  return {
    ...runtime,
    buildFilterCond,
    childSelCtx: childSelection,
    edges,
    filterFx,
    filterHint,
    filterInsertFunc,
    filterPickField,
    filterRecompute,
    filterRef,
    FX_FUNCS,
    fxField,
    fxFocus,
    fxHint,
    fxInsertFunc,
    fxPickField,
    fxRecompute,
    fxRefs,
    fxSetExpr,
    inspCols,
    inspColsProbing,
    inspectorDocked,
    inspectorHost,
    nodes,
    patch,
    renderReduceControls,
    seedSelectFields,
    sel,
    setAggs,
    setAllFieldsKept,
    setFilterCond,
    setFilterFx,
    setFilterHint,
    setFormulas,
    setFxField,
    setFxHint,
    setKeys,
    setSorts,
    setWindows,
    showTables,
    staleColRefs,
    toggleInArray,
    updateField,
  };
}
