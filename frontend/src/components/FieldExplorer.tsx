import React, { useEffect, useMemo, useRef, useState } from "react";
import { useWinDrag } from "./ActivityShared";
import { api, copyText } from "../lib/api";
import type { RootIdChoice } from "../lib/api";
import type { TableInfo } from "../lib/types";
import { Icon } from "./Icon";
import {
  composeMultiFieldSql,
  formatFieldSql,
} from "../lib/fieldExplorerSql";
import {
  abortTableFieldsDiscovery,
  startTableFieldsDiscovery,
} from "../lib/fieldTreeDiscovery";
import { runAfterPaint } from "../lib/prettyStruct";
import { FlattenUidModal } from "./FlattenUidModal";

// A floating, draggable JSON Field Explorer. Stays open across the IDE,
// Journal and Node views (it is rendered at the App root, outside the view
// switch). Open from Settings → Tools, Tools & Tables (NodeFlow), or Ctrl+K.
// Pick a loaded table (flatten-off = one table with nested fields),
// multi-select fields for a combined query, and Flatten to tables prompts
// for a Unique Identifier from any level of that table.

export const FIELD_EXPLORER_STORE_KEY = "samql.fieldExplorer.v1";

type FieldRow = {
  depth: number;
  name: string;
  type: string;
  kind: string;
  path?: string | null;
  /** Owning top-level column (table-rooted tree). */
  column?: string;
  access?: {
    first?: string;
    sel?: string;
    unnests?: string[];
    recursive?: string;
    note?: string;
  };
};

interface Props {
  open: boolean;
  onClose: () => void;
  tables: TableInfo[];
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  onTablesChanged?: () => void;
  onShred?: (
    engine: string,
    table: string,
    column: string,
    shredTables: string[],
  ) => Promise<{
    ok?: boolean;
    error?: string;
    created?: number;
    cancelled?: boolean;
  }>;
  onFlatten?: (
    engine: string,
    table: string,
    rootId?: RootIdChoice | null,
    column?: string | null,
    path?: string | null,
  ) => Promise<{
    ok?: boolean;
    error?: string;
    created?: number;
    cancelled?: boolean;
  }>;
}

type ShredInfo = {
  tables: { name: string }[];
  notes?: string[];
  error?: string;
};

type StoredChrome = {
  x?: number;
  y?: number;
  minimized?: boolean;
};

function loadChrome(): StoredChrome {
  try {
    const raw = localStorage.getItem(FIELD_EXPLORER_STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredChrome) : {};
  } catch {
    return {};
  }
}

function saveChrome(patch: StoredChrome) {
  try {
    const next = { ...loadChrome(), ...patch };
    localStorage.setItem(FIELD_EXPLORER_STORE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

const KIND_COLOR: Record<string, string> = {
  array: "#c98a2b",
  "array-scalar": "#c98a2b",
  struct: "#5b8def",
  map: "#8a6ad6",
};

/** Normalize opaque JSON extract paths to dotted nest paths for flatten.
 *  ``json ->> '$._embedded.items'`` → ``json._embedded.items`` so the
 *  backend does not mangle ``->>`` / ``$.`` on ``.`` splits. */
export function normalizeFlattenNestPath(path: string, col: string): string {
  const s = String(path || "").trim();
  if (!s) return col;
  const m = s.match(
    /^((?:"[^"]+")|(?:[A-Za-z_][A-Za-z0-9_]*))(?:\s*::\s*JSON)?\s*(?:->>|->)\s*'\$\.?([^']*)'\s*$/i,
  );
  if (!m) return s;
  let base = m[1];
  if (base.startsWith('"') && base.endsWith('"')) {
    base = base.slice(1, -1).replace(/""/g, '"');
  }
  const rest = (m[2] || "").replace(/\[["']?\d+["']?\]/g, "");
  if (!rest) return base || col;
  return `${base}.${rest}`;
}

/** Nest path for Flatten: prefer the row's path; inside ``(element)`` leaves
 *  often have ``path: null``, so walk up to the nearest ancestor with a path
 *  (e.g. phones → counterparty.contacts). Never send a bare leaf name that
 *  invents a wrong STRUCT path (phones → counterparty.phones). */
export function flattenNestPath(
  fields: FieldRow[],
  selIdx: number,
  col: string,
): string {
  const sel = fields[selIdx];
  let path: string | null | undefined = sel?.path;
  if (!path) {
    const depth = sel?.depth ?? 0;
    for (let i = selIdx - 1; i >= 0; i--) {
      const row = fields[i];
      if (row.depth < depth && row.path) {
        path = row.path;
        break;
      }
    }
  }
  return normalizeFlattenNestPath(path || col, col);
}

export const FieldExplorer: React.FC<Props> = ({
  open,
  onClose,
  tables,
  onToast,
  onTablesChanged,
  onShred,
  onFlatten,
}) => {
  // One source per loaded table that has nested content (not one per column).
  // Flatten-off JSON is a single catalog table with several nested columns —
  // listing each column as its own source looked like separate loaded tables.
  const sources = useMemo(() => {
    const out: { key: string; label: string; engine: string; table: string }[] =
      [];
    for (const t of tables) {
      if (t.remote) continue;
      const nested = (t.columns || []).some((c) => !!c.hint);
      if (!nested) continue;
      out.push({
        key: `${t.engine}\u0000${t.name}`,
        label: t.name,
        engine: t.engine,
        table: t.name,
      });
    }
    return out;
  }, [tables]);

  const saved = useMemo(() => loadChrome(), []);
  const [minimized, setMinimized] = useState(() => !!saved.minimized);
  const [srcKey, setSrcKey] = useState("");
  const [fields, setFields] = useState<FieldRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  // Multi-select via checkboxes. Order is check order; last checked / click
  // is the "primary" field used for preview / shred CTAs.
  const [selIdxs, setSelIdxs] = useState<number[]>([]);
  // Nested field-tree collapse (match Sidebar): structs/arrays default
  // COLLAPSED for a compact top level; "(element)" wrappers default OPEN.
  const [openFields, setOpenFields] = useState<Set<string>>(new Set());
  const [closedEls, setClosedEls] = useState<Set<string>>(new Set());
  // Shred eligibility for the primary field's owning column.
  const [shredInfo, setShredInfo] = useState<ShredInfo | null>(null);
  const [shredBusy, setShredBusy] = useState(false);
  const [flattenUidOpen, setFlattenUidOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewSample, setPreviewSample] = useState<string | null>(null);
  const [validatedAccess, setValidatedAccess] = useState<FieldRow["access"] | null>(
    null,
  );
  const [validatedFirstSql, setValidatedFirstSql] = useState<string | null>(null);
  const [validatedAllSql, setValidatedAllSql] = useState<string | null>(null);
  const src = sources.find((s) => s.key === srcKey) || null;
  // Avoid stale closures when a slow tableFields response arrives after the
  // user already switched sources (or tables refreshed under the same key).
  const srcKeyRef = useRef(srcKey);
  srcKeyRef.current = srcKey;
  const openRef = useRef(open);
  openRef.current = open;
  // Monotonic fetch id so an older in-flight tableFields cannot overwrite a
  // newer result (same srcKey) — that looked like nested keys "reverting"
  // to a hollow JSON/(element) placeholder.
  const fieldsFetchGen = useRef(0);
  // Backend query_id for the in-flight nested discovery chunk loop.
  const discoveryQidRef = useRef<string | null>(null);

  const primaryColumn = (row: FieldRow | null | undefined) =>
    row?.column || row?.name || "";

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

  const stopDiscovery = (engine?: string, table?: string) => {
    const qid = discoveryQidRef.current;
    discoveryQidRef.current = null;
    if (engine && table) abortTableFieldsDiscovery(engine, table);
    if (qid) void api.cancelQuery(qid).catch(() => {});
  };

  const reloadFields = (engine: string, table: string, key: string) => {
    const gen = ++fieldsFetchGen.current;
    setBusy(true);
    setSelIdx(null);
    setSelIdxs([]);
    setOpenFields(new Set());
    setClosedEls(new Set());
    setValidatedAccess(null);
    setValidatedFirstSql(null);
    setValidatedAllSql(null);
    setPreviewErr(null);
    setPreviewSample(null);
    setShredInfo(null);
    // Abort competing Sidebar column samples for this table, then own the slot.
    const ctrl = startTableFieldsDiscovery(engine, table);
    const discoveryId = `fe-fields-${Date.now().toString(36)}-${gen}`;
    discoveryQidRef.current = discoveryId;
    // Defer fetch until after paint so opening FE shows loading, not a dead UI.
    // Soft budget chunks resume via after/next_after so nested keys already
    // found are kept; closing the modal cancels further search.
    const cancelPaint = runAfterPaint(() => {
      void (async () => {
        let after: string | null | undefined = null;
        let acc: FieldRow[] = [];
        try {
          while (
            !ctrl.signal.aborted &&
            gen === fieldsFetchGen.current &&
            key === srcKeyRef.current &&
            openRef.current
          ) {
            const r = await api.tableFields(engine, table, ctrl.signal, {
              after: after || undefined,
              query_id: discoveryId,
            });
            if (
              gen !== fieldsFetchGen.current ||
              key !== srcKeyRef.current ||
              ctrl.signal.aborted ||
              !openRef.current
            ) {
              return;
            }
            const chunk = (r.fields || []) as FieldRow[];
            acc = after ? acc.concat(chunk) : chunk;
            setFields(acc);
            if (r.cancelled || !r.partial || !r.next_after) break;
            after = r.next_after;
          }
        } catch {
          if (
            gen !== fieldsFetchGen.current ||
            key !== srcKeyRef.current ||
            ctrl.signal.aborted
          ) {
            return;
          }
          if (!acc.length) setFields([]);
        } finally {
          if (discoveryQidRef.current === discoveryId) {
            discoveryQidRef.current = null;
          }
          if (gen === fieldsFetchGen.current && key === srcKeyRef.current) {
            setBusy(false);
          }
        }
      })();
    });
    return () => {
      cancelPaint();
      stopDiscovery(engine, table);
    };
  };
  const initPos = {
    x: typeof saved.x === "number" ? saved.x : 120,
    y: typeof saved.y === "number" ? saved.y : 90,
  };
  const { pos, startDrag, dragging, settled, winRef } = useWinDrag(initPos);

  // auto-pick the only source
  useEffect(() => {
    if (!srcKey && sources.length === 1) setSrcKey(sources[0].key);
  }, [sources, srcKey]);

  useEffect(() => {
    if (!open || !src) {
      setFields(null);
      setShredInfo(null);
      return;
    }
    return reloadFields(src.engine, src.table, src.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, open]);

  // Closing the Field Explorer modal cancels in-flight nested discovery
  // (AbortController + backend query_id), matching Stop semantics.
  useEffect(() => {
    if (open) return;
    const eng = src?.engine;
    const tbl = src?.table;
    stopDiscovery(eng, tbl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Clear stale fields if the selected source disappears without srcKey
  // changing (e.g. its table was removed/renamed on a tables refresh), so
  // the "no table selected" state never leaves the previous list on screen.
  useEffect(() => {
    if (!src) {
      setFields(null);
      setShredInfo(null);
    }
  }, [src]);

  // Validate Field Explorer SQL when a field is selected (primary → alt → rewrite).
  useEffect(() => {
    if (!src || selIdx == null || !fields || !fields[selIdx]) {
      setValidatedAccess(null);
      setValidatedFirstSql(null);
      setValidatedAllSql(null);
      setPreviewErr(null);
      setPreviewSample(null);
      return;
    }
    const forKey = src.key;
    const idx = selIdx;
    const row = fields[idx];
    const col = primaryColumn(row);
    // Scalars already have a simple quoted-ident recipe — skip the nested preview.
    if (row.kind === "scalar" && (!row.access?.unnests || !row.access.unnests.length)) {
      setValidatedAccess(row.access || null);
      setValidatedFirstSql(null);
      setValidatedAllSql(null);
      setPreviewErr(null);
      setPreviewSample(null);
      setPreviewBusy(false);
      return;
    }
    setPreviewBusy(true);
    setPreviewErr(null);
    setPreviewSample(null);
    // field_idx is within the *column* tree; use path so table-rooted indices work.
    api
      .columnAccessPreview(src.engine, src.table, col, {
        field_path: row.path || row.name,
      })
      .then((r) => {
        if (forKey !== srcKeyRef.current || idx !== selIdx) return;
        if (r.ok && r.access) {
          setValidatedAccess(r.access);
          setValidatedFirstSql(r.sql || null);
          setValidatedAllSql(r.all_sql || null);
          setPreviewSample(
            r.sample == null ? null : String(r.sample).slice(0, 200),
          );
          setPreviewErr(null);
          setFields((prev) => {
            if (!prev || !prev[idx]) return prev;
            const next = prev.slice();
            next[idx] = { ...next[idx], access: r.access };
            return next;
          });
        } else {
          setValidatedAccess(fields[idx]?.access || null);
          setValidatedFirstSql(null);
          setValidatedAllSql(null);
          setPreviewErr(r.error || "Preview returned NULL");
        }
      })
      .catch((e) => {
        if (forKey !== srcKeyRef.current || idx !== selIdx) return;
        setPreviewErr(String(e?.message || e || "Preview failed"));
        setValidatedAccess(fields[idx]?.access || null);
      })
      .finally(() => {
        if (forKey === srcKeyRef.current && idx === selIdx) setPreviewBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, srcKey]);

  // Shred plan follows the primary field's owning column.
  const shredCol =
    selIdx != null && fields?.[selIdx]
      ? primaryColumn(fields[selIdx])
      : "";
  useEffect(() => {
    if (!src || src.engine !== "duckdb" || !shredCol) {
      setShredInfo(null);
      return;
    }
    const forKey = src.key;
    const forCol = shredCol;
    api
      .shredPlan(src.engine, src.table, shredCol)
      .then((r) => {
        if (forKey !== srcKey || forCol !== shredCol) return;
        setShredInfo({
          tables: (r.tables || []).map((t) => ({ name: t.name })),
          notes: r.notes,
          error: r.error,
        });
      })
      .catch(() => {
        if (forKey === srcKey) setShredInfo(null);
      });
  }, [src, srcKey, shredCol]);

  // ---- close: X button, and Esc anywhere while the panel is open (not mini) ----
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !minimized) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, minimized, onClose]);

  useEffect(() => {
    if (!open) return;
    saveChrome({ x: pos.x, y: pos.y, minimized });
  }, [open, pos.x, pos.y, minimized]);

  // .460's clipboard-morph state. .468: these hooks MUST sit above the
  // open guard -- they were added below `if (!open) return null`, so the
  // moment the panel opened React saw MORE hooks than the previous
  // render and unmounted the entire tree (the "whole app goes blank"
  // report). Rules of Hooks: every hook, every render, same order.
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current != null)
        window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  if (!open) return null;

  if (minimized) {
    return (
      <button
        ref={winRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className={
          "tt-mini win-float" +
          (dragging ? " dragging" : "") +
          (settled ? " settle" : "")
        }
        style={{ left: pos.x, top: pos.y }}
        data-testid="field-explorer-mini"
        title="JSON Field Explorer — drag to move; click to expand"
        onMouseDown={(event) => {
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          const onMove = (ev: MouseEvent) => {
            if (
              Math.abs(ev.clientX - startX) > 4 ||
              Math.abs(ev.clientY - startY) > 4
            ) {
              moved = true;
            }
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            if (!moved) {
              setMinimized(false);
              saveChrome({ minimized: false });
            }
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          startDrag(event);
        }}
      >
        <Icon.ListTree size={14} />
        <span>JSON Fields</span>
      </button>
    );
  }

  const sel = selIdx != null && fields ? fields[selIdx] : null;
  const selectedFields =
    fields && selIdxs.length
      ? selIdxs.map((i) => fields[i]).filter(Boolean)
      : sel
        ? [sel]
        : [];
  const multiCompose =
    selectedFields.length > 1 && src
      ? composeMultiFieldSql(
          src.table,
          selectedFields.map((f) => ({ name: f.name, access: f.access })),
        )
      : null;
  const acc = validatedAccess || sel?.access;
  // Prefer server-validated SQL (survives NULL / wrong from_json schema).
  // Fall back to locally formatted multi-line recipes for readability.
  const firstSql =
    multiCompose?.firstSql ||
    validatedFirstSql ||
    (acc ? formatFieldSql(src?.table || "table", acc, "first") : null);
  const allSql =
    multiCompose?.sql ||
    validatedAllSql ||
    (acc ? formatFieldSql(src?.table || "table", acc, "all") : null);
  const recSql =
    !multiCompose && acc
      ? formatFieldSql(src?.table || "table", acc, "recursive")
      : null;

  const toggleField = (i: number, opts?: { exclusive?: boolean }) => {
    if (opts?.exclusive) {
      setSelIdx(i);
      setSelIdxs([i]);
      return;
    }
    // Default: toggle into the selection set so multiple fields compose
    // into one query (no Ctrl required). Last toggled-on field is primary.
    setSelIdxs((prev) => {
      const has = prev.includes(i);
      const next = has ? prev.filter((x) => x !== i) : [...prev, i];
      setSelIdx(next.length ? next[next.length - 1] : null);
      return next;
    });
  };

  const clearSelection = () => {
    setSelIdx(null);
    setSelIdxs([]);
  };

  const isArray = !!sel && (sel.kind === "array" || sel.kind === "array-scalar");
  const shredTables = shredInfo?.tables || [];
  const shredEligible = shredTables.length > 0;

  // A deep OPAQUE-JSON column the shred planner can't see as an array (its
  // declared type is shallow) can still be built into the relational family by
  // flatten, which re-reads the source deeply. Offer that on DuckDB.
  const flattenEligible = !!src && src.engine === "duckdb" && !!onFlatten;

  const runShred = () => {
    if (!src || !onShred || !shredEligible || shredBusy || !sel) return;
    const col = primaryColumn(sel);
    if (!col) return;
    setShredBusy(true);
    const key = src.key;
    onShred(
      src.engine,
      src.table,
      col,
      shredTables.map((t) => t.name),
    )
      .then((r) => {
        if (!r?.ok) return;
        onTablesChanged?.();
        reloadFields(src.engine, src.table, key);
      })
      .catch(() => {
        /* onShred surfaces its own error toast */
      })
      .finally(() => setShredBusy(false));
  };

  const runFlatten = () => {
    if (!src || !onFlatten || shredBusy) return;
    setFlattenUidOpen(true);
  };

  const confirmFlatten = (rootId: RootIdChoice) => {
    if (!src || !onFlatten || shredBusy || !sel || selIdx == null || !fields)
      return;
    const col = primaryColumn(sel);
    if (!col) return;
    setFlattenUidOpen(false);
    setShredBusy(true);
    const key = src.key;
    const fieldPath = flattenNestPath(fields, selIdx, col);
    onFlatten(src.engine, src.table, rootId, col, fieldPath)
      .then((r) => {
        if (!r?.ok) return;
        onTablesChanged?.();
        reloadFields(src.engine, src.table, key);
      })
      .catch(() => {
        /* onFlatten surfaces its own error toast */
      })
      .finally(() => setShredBusy(false));
  };

  const copy = (label: string, text: string) => {
    copyText(text)
      .then(() => {
        onToast("ok", "Copied", label);
        setCopiedKey(label);
        if (copiedTimer.current != null)
          window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => {
          setCopiedKey(null);
          copiedTimer.current = null;
        }, 900);
      })
      .catch(() => onToast("error", "Copy failed"));
  };

  const block = (label: string, sql: string) => (
    <div className="fx-block">
      <div className="fx-block-head">
        <span className="fx-block-label">{label}</span>
        <button
          className="btn sm ghost"
          title="Copy SQL"
          onClick={() => copy(label, sql)}
        >
          {copiedKey === label ? (
            <span className="copy-ok">
              <Icon.Check size={12} />
            </span>
          ) : (
            <Icon.Copy size={12} />
          )}
        </button>
      </div>
      <pre className="fx-sql">{sql}</pre>
    </div>
  );

  return (
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className={
        "fx-panel win-float" +
        (dragging ? " dragging" : "") +
        (settled ? " settle" : "")
      }
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="JSON Field Explorer"
      data-testid="field-explorer-panel"
    >
      <div
        className="fx-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <Icon.ListTree size={14} />
        <span className="fx-title">JSON Field Explorer</span>
        <span className="spacer" />
        <button
          className="btn sm ghost"
          title="Minimize"
          data-testid="field-explorer-minimize"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            setMinimized(true);
            saveChrome({ minimized: true, x: pos.x, y: pos.y });
          }}
        >
          <Icon.SquareMinus size={14} />
        </button>
        <button
          className="btn sm ghost"
          title="Close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <Icon.X size={14} />
        </button>
      </div>
      <div className="fx-body">
        <div className="fx-left">
          <select
            className="fx-src"
            value={srcKey}
            onChange={(e) => setSrcKey(e.target.value)}
            title="Pick a loaded table to explore"
          >
            <option value="">
              {sources.length ? "Pick a table…" : "No nested tables loaded"}
            </option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="fx-tree">
            {!src ? (
              <div className="faint" style={{ padding: 8 }} data-testid="fx-no-table">
                Pick a table above.
              </div>
            ) : busy ? (
              <div className="faint" style={{ padding: 8 }}>
                <span className="spin" /> loading fields…
              </div>
            ) : !fields ? (
              <div className="faint" style={{ padding: 8 }}>
                Pick a table above.
              </div>
            ) : fields.length === 0 ? (
              <div className="faint" style={{ padding: 8 }}>
                No fields on this table.
              </div>
            ) : (
              <>
                <div className="fx-sel-bar" data-testid="fx-sel-bar">
                  <span className="faint">
                    {selIdxs.length
                      ? `${selIdxs.length} selected`
                      : "Check fields to combine (e.g. id + nested array)"}
                  </span>
                  {selIdxs.length > 0 && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      data-testid="fx-sel-clear"
                      onClick={clearSelection}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {(() => {
                  const nodes: React.ReactNode[] = [];
                  let skipDeeper: number | null = null;
                  for (let i = 0; i < fields.length; i++) {
                    const f = fields[i];
                    if (skipDeeper !== null) {
                      if (f.depth > skipDeeper) continue;
                      skipDeeper = null;
                    }
                    const hasKids =
                      i + 1 < fields.length && fields[i + 1].depth > f.depth;
                    const nid = `${srcKey}\u0000${i}`;
                    const isEl = f.name === "(element)";
                    // Structs/arrays load COLLAPSED; "(element)" loads open.
                    const collapsed =
                      hasKids &&
                      (isEl ? closedEls.has(nid) : !openFields.has(nid));
                    const checked = selIdxs.includes(i);
                    nodes.push(
                      <div
                        key={i}
                        className={"fx-row" + (checked ? " sel" : "")}
                        style={{ paddingLeft: 6 + (f.depth - 1) * 12 }}
                        onClick={() => toggleField(i, { exclusive: true })}
                        title={
                          f.type +
                          " — click to view; use the checkbox to add more fields to one query" +
                          (hasKids ? "; ▸ to expand nested fields" : "")
                        }
                        data-testid={`fx-field-${f.name}`}
                      >
                        {hasKids ? (
                          <span
                            className="fx-caret"
                            data-testid={`fx-caret-${f.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFieldNode(nid, isEl);
                            }}
                            title={collapsed ? "Expand" : "Collapse"}
                            style={{
                              cursor: "pointer",
                              width: 12,
                              flex: "0 0 auto",
                              display: "inline-block",
                              textAlign: "center",
                              opacity: 0.7,
                            }}
                          >
                            {collapsed ? "▸" : "▾"}
                          </span>
                        ) : (
                          <span
                            className="fx-caret-spacer"
                            style={{
                              width: 12,
                              flex: "0 0 auto",
                              display: "inline-block",
                            }}
                          />
                        )}
                        <input
                          type="checkbox"
                          className="fx-check"
                          checked={checked}
                          tabIndex={0}
                          aria-label={`Add ${f.name} to query`}
                          data-testid={`fx-check-${f.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleField(i);
                          }}
                          onChange={() => {
                            /* click handler owns the toggle */
                          }}
                        />
                        <span
                          style={{
                            color: KIND_COLOR[f.kind] || undefined,
                            fontStyle: isEl ? "italic" : undefined,
                            opacity: isEl ? 0.7 : 1,
                          }}
                        >
                          {f.name}
                        </span>
                        {(f.kind === "array" || f.kind === "array-scalar") && (
                          <span style={{ color: "#c98a2b" }}> ⇗</span>
                        )}
                      </div>,
                    );
                    if (hasKids && collapsed) skipDeeper = f.depth;
                  }
                  return nodes;
                })()}
              </>
            )}
          </div>
        </div>
        <div className="fx-right">
          {!sel && selectedFields.length === 0 ? (
            <div className="faint" style={{ padding: 10 }}>
              Click a field to see how to query it. Check multiple fields to
              build one combined query (e.g. top-level Id plus a nested array
              field).
            </div>
          ) : (
            <>
              <div className="fx-field-name">
                {selectedFields.length > 1
                  ? `${selectedFields.length} fields`
                  : sel?.name}
                {selectedFields.length <= 1 && sel && (
                  <span className="ctype" style={{ marginLeft: 8 }}>
                    {sel.kind}
                  </span>
                )}
              </div>
              {isArray && selectedFields.length <= 1 && (
                <div className="fx-shred" data-testid="fx-shred">
                  {shredEligible ? (
                    <>
                      <button
                        className="btn sm"
                        disabled={shredBusy || !onShred}
                        data-testid="fx-shred-run"
                        title="Build the relational family for this column"
                        onClick={runShred}
                      >
                        {shredBusy ? (
                          <span className="spin" />
                        ) : (
                          <Icon.Grid size={12} />
                        )}
                        <span style={{ marginLeft: 6 }}>Shred to tables</span>
                      </button>
                      <div className="fx-note faint">
                        Memory-safe: builds the relational family (
                        {shredTables.length} table
                        {shredTables.length === 1 ? "" : "s"}) joined on{" "}
                        <code>_sk</code>/<code>_parent_sk</code>. Recommended for
                        large data — a full UNNEST loads the whole column into
                        memory and can exhaust it.
                      </div>
                    </>
                  ) : flattenEligible ? (
                    <>
                      <button
                        className="btn sm"
                        disabled={shredBusy}
                        data-testid="fx-flatten-run"
                        title="Build a relational family for this nest; keep the source table"
                        onClick={runFlatten}
                      >
                        {shredBusy ? (
                          <span className="spin" />
                        ) : (
                          <Icon.Grid size={12} />
                        )}
                        <span style={{ marginLeft: 6 }}>Flatten to tables</span>
                      </button>
                      <div className="fx-note faint">
                        Builds a relational family for this nest only (plus{" "}
                        <code>Master_Keys</code> / <code>Join_Keys</code> when
                        you pick a unique id). The source table stays loaded
                        with its original nested columns. Preferred over a full
                        UNNEST, which loads the whole column into memory and can
                        exhaust it on big files.
                      </div>
                    </>
                  ) : (
                    <div
                      className="fx-note faint"
                      data-testid="fx-shred-guide"
                    >
                      This column can’t shred in place (deep opaque JSON has no
                      relational backing yet). For large data, reload it with{" "}
                      <b>Flatten into relational tables</b> at load time, or
                      convert to <code>.ndjson</code>. The full UNNEST below
                      loads the whole column into memory and can exhaust it on
                      big files.
                    </div>
                  )}
                </div>
              )}
              {selectedFields.length > 1 && (
                <div className="fx-note faint" data-testid="fx-multi-hint">
                  Combined query: outer scalars repeat on each exploded nested
                  row. {multiCompose?.error || ""}
                </div>
              )}
              {previewBusy && selectedFields.length <= 1 && (
                <div className="faint" style={{ padding: "4px 0" }}>
                  <span className="spin" /> validating SQL…
                </div>
              )}
              {!previewBusy && previewSample != null && selectedFields.length <= 1 && (
                <div className="fx-note faint" data-testid="fx-preview-sample">
                  Sample: <code>{previewSample}</code>
                </div>
              )}
              {!previewBusy && previewErr && selectedFields.length <= 1 && (
                <div className="fx-note" style={{ color: "#c44" }} data-testid="fx-preview-error">
                  Preview: {previewErr}
                </div>
              )}
              {firstSql &&
                !multiCompose?.error &&
                block(
                  selectedFields.length > 1
                    ? "Peek one row (all selected fields)"
                    : "Peek one value",
                  firstSql,
                )}
              {allSql &&
                !multiCompose?.error &&
                block(
                  selectedFields.length > 1
                    ? "All rows (combined fields)"
                    : isArray
                      ? "All rows (explode array — small data)"
                      : "All rows",
                  allSql,
                )}
              {multiCompose?.error && (
                <div
                  className="fx-note"
                  style={{ color: "#c44" }}
                  data-testid="fx-multi-error"
                >
                  {multiCompose.error}
                </div>
              )}
              {recSql && block("Explode everything under it", recSql)}
              {acc?.note && selectedFields.length <= 1 && (
                <div className="fx-note faint">{acc.note}</div>
              )}
            </>
          )}
        </div>
      </div>
      {flattenUidOpen && src && (
        <FlattenUidModal
          open
          engine={src.engine}
          table={src.table}
          onConfirm={confirmFlatten}
          onCancel={() => setFlattenUidOpen(false)}
        />
      )}
    </div>
  );
};
