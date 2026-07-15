import React, { useEffect, useMemo, useState } from "react";
import { useWinDrag } from "./ActivityShared";
import { api, copyText } from "../lib/api";
import type { TableInfo } from "../lib/types";
import { Icon } from "./Icon";

// A floating, draggable field-access explorer. Stays open across the IDE,
// Journal and Node views (it is rendered at the App root, outside the view
// switch). Pick a nested (JSON) source column, click any field in its tree,
// and the right pane shows the queries to access it: the first-record [1]
// path, the all-rows UNNEST chain, and (for arrays) the recursive one-shot.
// Minimize collapses to a draggable icon that expands on click.

export const FIELD_EXPLORER_STORE_KEY = "samql.fieldExplorer.v1";

type FieldRow = {
  depth: number;
  name: string;
  type: string;
  kind: string;
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

export const FieldExplorer: React.FC<Props> = ({
  open,
  onClose,
  tables,
  onToast,
  onTablesChanged,
  onShred,
  onFlatten,
}) => {
  // nested columns across loaded tables = the selectable "JSON files"
  const sources = useMemo(() => {
    const out: { key: string; label: string; engine: string; table: string; column: string }[] = [];
    for (const t of tables) {
      if (t.remote) continue;
      for (const c of t.columns || []) {
        if (!c.hint) continue; // nested columns only
        out.push({
          key: `${t.engine}\u0000${t.name}\u0000${c.name}`,
          label: `${t.name} › ${c.name}`,
          engine: t.engine,
          table: t.name,
          column: c.name,
        });
      }
    }
    return out;
  }, [tables]);

  const saved = useMemo(() => loadChrome(), []);
  const [minimized, setMinimized] = useState(() => !!saved.minimized);
  const [srcKey, setSrcKey] = useState("");
  const [fields, setFields] = useState<FieldRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  // Shred eligibility for the picked column: whether the relational-shred
  // planner can build tables from it (the memory-safe alternative to a
  // full-column UNNEST). null while unknown; an empty tables list = not
  // shreddable in place (e.g. deep opaque JSON with no relational backing).
  const [shredInfo, setShredInfo] = useState<ShredInfo | null>(null);
  const [shredBusy, setShredBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewSample, setPreviewSample] = useState<string | null>(null);
  const [validatedAccess, setValidatedAccess] = useState<FieldRow["access"] | null>(
    null,
  );
  const [validatedFirstSql, setValidatedFirstSql] = useState<string | null>(null);
  const [validatedAllSql, setValidatedAllSql] = useState<string | null>(null);
  const src = sources.find((s) => s.key === srcKey) || null;

  const reloadFields = (engine: string, table: string, column: string, key: string) => {
    setBusy(true);
    setSelIdx(null);
    setValidatedAccess(null);
    setValidatedFirstSql(null);
    setValidatedAllSql(null);
    setPreviewErr(null);
    setPreviewSample(null);
    api
      .columnFields(engine, table, column)
      .then((r) => {
        if (key !== srcKey) return;
        setFields((r.fields || []) as FieldRow[]);
      })
      .catch(() => {
        if (key === srcKey) setFields([]);
      })
      .finally(() => {
        if (key === srcKey) setBusy(false);
      });
    if (engine === "duckdb") {
      api
        .shredPlan(engine, table, column)
        .then((r) => {
          if (key !== srcKey) return;
          setShredInfo({
            tables: (r.tables || []).map((t) => ({ name: t.name })),
            notes: r.notes,
            error: r.error,
          });
        })
        .catch(() => {
          if (key === srcKey) setShredInfo(null);
        });
    }
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
    if (!src) {
      setFields(null);
      setShredInfo(null);
      return;
    }
    reloadFields(src.engine, src.table, src.column, src.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

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
    setPreviewBusy(true);
    setPreviewErr(null);
    setPreviewSample(null);
    api
      .columnAccessPreview(src.engine, src.table, src.column, {
        field_idx: idx,
      })
      .then((r) => {
        if (forKey !== srcKey || idx !== selIdx) return;
        if (r.ok && r.access) {
          setValidatedAccess(r.access);
          setValidatedFirstSql(r.sql || null);
          setValidatedAllSql(r.all_sql || null);
          setPreviewSample(
            r.sample == null ? null : String(r.sample).slice(0, 200),
          );
          setPreviewErr(null);
          // Keep the tree's recipe in sync with the validated one.
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
        if (forKey !== srcKey || idx !== selIdx) return;
        setPreviewErr(String(e?.message || e || "Preview failed"));
        setValidatedAccess(fields[idx]?.access || null);
      })
      .finally(() => {
        if (forKey === srcKey && idx === selIdx) setPreviewBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, srcKey]);

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
        title="Field explorer — drag to move; click to expand"
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
        <span>Fields</span>
      </button>
    );
  }

  const sel = selIdx != null && fields ? fields[selIdx] : null;
  const acc = validatedAccess || sel?.access;
  const tbl = src ? `"${src.table.replace(/"/g, '""')}"` : '"table"';
  // Prefer server-validated SQL (survives NULL / wrong from_json schema).
  const firstSql =
    validatedFirstSql ||
    (acc?.first ? `SELECT ${acc.first}\nFROM ${tbl}\nLIMIT 1;` : null);
  const allSql =
    validatedAllSql ||
    (acc?.sel
      ? `SELECT ${acc.sel}\nFROM ${tbl}${(acc.unnests || [])
          .map((u) => `,\n     ${u}`)
          .join("")};`
      : null);
  const recSql = acc?.recursive
    ? `SELECT ${acc.recursive}\nFROM ${tbl};`
    : null;

  const isArray = !!sel && (sel.kind === "array" || sel.kind === "array-scalar");
  const shredTables = shredInfo?.tables || [];
  const shredEligible = shredTables.length > 0;

  // A deep OPAQUE-JSON column the shred planner can't see as an array (its
  // declared type is shallow) can still be built into the relational family by
  // flatten, which re-reads the source deeply. Offer that on DuckDB.
  const flattenEligible = !!src && src.engine === "duckdb" && !!onFlatten;

  const runShred = () => {
    if (!src || !onShred || !shredEligible || shredBusy) return;
    setShredBusy(true);
    const key = src.key;
    onShred(
      src.engine,
      src.table,
      src.column,
      shredTables.map((t) => t.name),
    )
      .then((r) => {
        // onShred resolves on failure too ({error}). Reloading after an OOM
        // re-samples under a exhausted engine and replaces the rich tree
        // with DESCRIBE-only top-level fields — keep the tree on failure.
        if (!r?.ok) return;
        onTablesChanged?.();
        reloadFields(src.engine, src.table, src.column, key);
      })
      .catch(() => {
        /* onShred surfaces its own error toast */
      })
      .finally(() => setShredBusy(false));
  };

  const runFlatten = () => {
    if (!src || !onFlatten || shredBusy) return;
    setShredBusy(true);
    const key = src.key;
    onFlatten(src.engine, src.table)
      .then((r) => {
        // Same as shred: only refresh the tree after a successful flatten.
        // A failed flatten left the explorer on top-level fields until the
        // user re-picked the table (post-OOM sample fell back to DESCRIBE).
        if (!r?.ok) return;
        onTablesChanged?.();
        reloadFields(src.engine, src.table, src.column, key);
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
      aria-label="Field explorer"
      data-testid="field-explorer-panel"
    >
      <div
        className="fx-head"
        onMouseDown={startDrag}
        title="Drag to move"
      >
        <Icon.ListTree size={14} />
        <span className="fx-title">Field explorer</span>
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
            title="Pick a nested (JSON) column to explore"
          >
            <option value="">
              {sources.length ? "Pick a JSON source…" : "No nested columns loaded"}
            </option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="fx-tree">
            {busy ? (
              <div className="faint" style={{ padding: 8 }}>
                <span className="spin" /> loading fields…
              </div>
            ) : !fields ? (
              <div className="faint" style={{ padding: 8 }}>
                Pick a source above.
              </div>
            ) : fields.length === 0 ? (
              <div className="faint" style={{ padding: 8 }}>
                No nested fields.
              </div>
            ) : (
              fields.map((f, i) => (
                <div
                  key={i}
                  className={"fx-row" + (i === selIdx ? " sel" : "")}
                  style={{ paddingLeft: 6 + (f.depth - 1) * 12 }}
                  onClick={() => setSelIdx(i)}
                  title={f.type}
                >
                  <span
                    style={{
                      color: KIND_COLOR[f.kind] || undefined,
                      fontStyle: f.name === "(element)" ? "italic" : undefined,
                      opacity: f.name === "(element)" ? 0.7 : 1,
                    }}
                  >
                    {f.name}
                  </span>
                  {(f.kind === "array" || f.kind === "array-scalar") && (
                    <span style={{ color: "#c98a2b" }}> ⇗</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="fx-right">
          {!sel ? (
            <div className="faint" style={{ padding: 10 }}>
              Click a field on the left to see how to query it.
            </div>
          ) : (
            <>
              <div className="fx-field-name">
                {sel.name}
                <span className="ctype" style={{ marginLeft: 8 }}>
                  {sel.kind}
                </span>
              </div>
              {previewBusy && (
                <div className="faint" style={{ padding: "4px 0" }}>
                  <span className="spin" /> validating SQL…
                </div>
              )}
              {!previewBusy && previewSample != null && (
                <div className="fx-note faint" data-testid="fx-preview-sample">
                  Sample: <code>{previewSample}</code>
                </div>
              )}
              {!previewBusy && previewErr && (
                <div className="fx-note" style={{ color: "#c44" }} data-testid="fx-preview-error">
                  Preview: {previewErr}
                </div>
              )}
              {firstSql && block("First record ([1] path)", firstSql)}
              {isArray && (
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
                        title="Re-read the source deeply and build the relational family"
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
                        This column is deep/opaque JSON, so it builds via
                        Flatten: the source is re-read deeply into the full
                        relational family (memory-safe). Preferred over a full
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
              {allSql &&
                block(
                  isArray ? "All rows (UNNEST — small data)" : "All rows (UNNEST chain)",
                  allSql,
                )}
              {recSql && block("Explode everything under it (recursive)", recSql)}
              {acc?.note && <div className="fx-note faint">{acc.note}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
