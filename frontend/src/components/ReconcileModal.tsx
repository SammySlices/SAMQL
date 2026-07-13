import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { api, saveToDownloads } from "../lib/api";
import {
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
} from "../lib/runController";
import type { TableInfo, ReconcileResult } from "../lib/types";
import {
  resolveReconFields,
  colmapsFor,
  mappingTemplateCsv,
  parseMappingCsv,
  type ReconMapping,
} from "../lib/reconMapping";
import { MultiSelect, type Opt } from "./MultiSelect";

export interface ReconSpec {
  left: string;
  right: string;
  keys: string[];
  compare: string[];
  balance: string | null;
  colmap_a: Record<string, string>;
  colmap_b: Record<string, string>;
}

interface Props {
  tables: TableInfo[];
  onClose: () => void;
  onRun: (report: ReconcileResult, spec: ReconSpec) => void;
  onToast: (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;
  initialLeft?: string;
}

export const ReconcileModal: React.FC<Props> = ({
  tables,
  onClose,
  onRun,
  onToast,
  initialLeft,
}) => {
  const names = useMemo(() => tables.map((t) => t.name), [tables]);
  const [left, setLeft] = useState(
    (initialLeft && names.includes(initialLeft) ? initialLeft : names[0]) || "",
  );
  const [right, setRight] = useState(() => {
    const l =
      (initialLeft && names.includes(initialLeft) ? initialLeft : names[0]) ||
      "";
    return names.find((n) => n !== l) || l;
  });
  const [keys, setKeys] = useState<string[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [balance, setBalance] = useState<string>("");
  const [mapping, setMapping] = useState<ReconMapping | null>(null);
  const [openSel, setOpenSel] = useState<"keys" | "compare" | null>(null);
  const [running, setRunning] = useState(false);
  // .469: a determinate progress bar while the reconcile runs. The
  // backend reports four honest milestones (validate, row counts,
  // bucket totals, the per-field aggregate) against the query_id we
  // send; poll the same registry the activity pill reads.
  const [progress, setProgress] = useState<number | null>(null);
  const pollTimer = React.useRef<number | null>(null);
  const runQid = React.useRef<string | null>(null);
  const runCtrl = React.useRef<AbortController | null>(null);
  const stopPoll = () => {
    if (pollTimer.current != null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setProgress(null);
  };
  React.useEffect(() => stopPoll, []);
  const startPoll = (qid: string) => {
    setProgress(0);
    pollTimer.current = window.setInterval(async () => {
      try {
        const st = await api.status();
        const op = (st.operations || []).find((o) => o.id === qid);
        if (op && typeof op.percent === "number") setProgress(op.percent);
      } catch {
        /* best-effort */
      }
    }, 350);
  };
  const fileRef = useRef<HTMLInputElement>(null);

  const colsOf = (name: string) =>
    (tables.find((t) => t.name === name)?.columns || []).map((c) => c.name);
  const engineOf = (name: string) =>
    tables.find((t) => t.name === name)?.engine;

  // Comparable fields: A's and B's columns lined up under a canonical name
  // (with the mapping's renames applied when present). Each carries a
  // composite label and the real column on each side.
  const fields = useMemo(
    () =>
      left && right
        ? resolveReconFields(colsOf(left), colsOf(right), mapping)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, tables, mapping],
  );
  const fieldVals = useMemo(() => new Set(fields.map((f) => f.value)), [fields]);
  const keyOpts: Opt[] = fields.map((f) => ({ value: f.value, label: f.label }));
  const nonKey = fields.filter((f) => !keys.includes(f.value));
  const compareOpts: Opt[] = nonKey.map((f) => ({
    value: f.value,
    label: f.label,
  }));

  // Available fields changed (table or mapping) -> prune stale picks.
  useEffect(() => {
    setKeys((ks) => ks.filter((k) => fieldVals.has(k)));
    setCompare((cs) => cs.filter((c) => fieldVals.has(c)));
    setBalance((b) => (b && fieldVals.has(b) ? b : ""));
  }, [fieldVals]);

  const engineMismatch =
    !!left && !!right && left !== right && engineOf(left) !== engineOf(right);
  const sameTable = !!left && left === right;
  const canRun =
    !!left && !!right && !sameTable && keys.length > 0 && !engineMismatch;
  const renameCount = mapping
    ? Object.keys(mapping.renameA).length + Object.keys(mapping.renameB).length
    : 0;

  const swap = () => {
    setLeft(right);
    setRight(left);
  };

  const makeMapping = async () => {
    if (!left || !right) return;
    const csv = mappingTemplateCsv(colsOf(left), colsOf(right));
    try {
      // .539: server-side into Downloads -- the blob anchor never
      // reached disk in the native window.
      const r = await saveToDownloads(
        `recon_mapping_${left}_vs_${right}.csv`,
        { text: csv },
      );
      onToast(
        "ok",
        "Mapping template saved",
        `${r.path} — fill the rename columns, then upload it.`,
      );
    } catch (e: any) {
      onToast("error", "Template save failed", e?.message || String(e));
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const m = parseMappingCsv(String(reader.result || ""), f.name);
        if (
          Object.keys(m.renameA).length === 0 &&
          Object.keys(m.renameB).length === 0
        ) {
          onToast(
            "warn",
            "No renames found",
            "Fill the rename columns and try again, or clear to line up by name.",
          );
          return;
        }
        setMapping(m);
      } catch (err: any) {
        onToast("error", "Could not read mapping file", err?.message);
      }
    };
    reader.onerror = () =>
      onToast("error", "Could not read mapping file", "Read failed.");
    reader.readAsText(f);
  };

  const run = async () => {
    if (!canRun || running) return;
    setRunning(true);
    const qid = "recon-" + Math.random().toString(36).slice(2, 12);
    const ctrl = new AbortController();
    runQid.current = qid;
    runCtrl.current = ctrl;
    registerRun(qid, ctrl);
    startPoll(qid);
    const used = fields.filter(
      (f) =>
        keys.includes(f.value) ||
        compare.includes(f.value) ||
        balance === f.value,
    );
    const { colmapA, colmapB } = colmapsFor(used);
    const spec: ReconSpec = {
      left,
      right,
      keys,
      compare,
      balance: balance || null,
      colmap_a: colmapA,
      colmap_b: colmapB,
    };
    try {
      const report = await api.reconcile({ ...spec, query_id: qid }, ctrl.signal);
      stopPoll();
      runQid.current = null;
      runCtrl.current = null;
      if (report.error) {
        if (/interrupt|cancel/i.test(report.error) || report.cancelled) {
          onToast("warn", "Reconcile cancelled", "Stopped at your request.");
        } else {
          onToast("error", "Reconcile failed", report.error);
        }
        setRunning(false);
        return;
      }
      onRun(report, spec);
    } catch (e: any) {
      stopPoll();
      runQid.current = null;
      runCtrl.current = null;
      if (isCancelledError(e, qid)) {
        onToast("warn", "Reconcile cancelled", "Stopped at your request.");
        setRunning(false);
        return;
      }
      onToast("error", "Reconcile failed", e?.message);
      setRunning(false);
    } finally {
      unregisterRun(qid, ctrl);
    }
  };

  return (
    <Modal
      title="Reconcile / compare tables"
      onClose={onClose}
      wide
      footer={
        <div className="rc-foot">
          {engineMismatch && (
            <span className="rc-warn">
              Tables are on different engines — load both into the same engine
              to compare.
            </span>
          )}
          {sameTable && (
            <span className="rc-warn">Pick two different tables.</span>
          )}
          {running && (
            <button
              className="btn ghost sm"
              title="Cancel this reconcile (interrupts the backend run)"
              onClick={() => {
                if (runQid.current)
                  cancelOne(runQid.current, runCtrl.current);
              }}
            >
              ■ Cancel
            </button>
          )}
          {running && progress != null && (
            <span
              className="rc-progress"
              title={`Reconciling… ${Math.round(progress)}%`}
            >
              <span className="rc-progress-bar">
                <span
                  className="rc-progress-fill"
                  style={{ width: `${Math.max(4, progress)}%` }}
                />
              </span>
              <span className="rc-progress-pct">
                {Math.round(progress)}%
              </span>
            </span>
          )}
          <span className="spacer" />
          {/* .473: exactly one Cancel -- the "■ Cancel" above stops a
              running reconcile; the modal's own X closes it. The old
              footer dismiss-"Cancel" next to Run was the redundant
              second button. */}
          <button
            className="btn primary"
            disabled={!canRun || running}
            onClick={run}
          >
            {running ? <span className="spin" /> : <Icon.Compare size={15} />}{" "}
            Run reconcile
          </button>
        </div>
      }
    >
      <div className="rc-config">
        <div className="rc-ab">
          <div className="field">
            <label>Left table (A)</label>
            <select value={left} onChange={(e) => setLeft(e.target.value)}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn ghost icon rc-swap"
            title="Swap A and B"
            onClick={swap}
          >
            <Icon.Swap size={16} />
          </button>
          <div className="field">
            <label>Right table (B)</label>
            <select value={right} onChange={(e) => setRight(e.target.value)}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="rc-maprow">
          <span className="rc-map-title">Field mapping</span>
          <button
            className="btn sm"
            onClick={makeMapping}
            disabled={!left || !right || sameTable}
            title="Download a CSV template of both tables' columns"
          >
            <Icon.Download size={13} /> Create mapping file
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            <Icon.Upload size={13} /> Upload mapping file
          </button>
          {mapping && (
            <button className="btn ghost sm" onClick={() => setMapping(null)}>
              Clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={onFile}
          />
          <span className={"rc-map-status" + (mapping ? " on" : "")}>
            {mapping
              ? `Mapping active: ${mapping.name || "file"} — ${renameCount} rename(s).`
              : "No mapping (fields lined up by name, ignoring case/whitespace)."}
          </span>
        </div>

        <div className="rc-row">
          <MultiSelect
            label="Key columns"
            placeholder="Select keys…"
            options={keyOpts}
            selected={keys}
            open={openSel === "keys"}
            onToggleOpen={() =>
              setOpenSel((o) => (o === "keys" ? null : "keys"))
            }
            onClose={() => setOpenSel(null)}
            onChange={setKeys}
          />
          <MultiSelect
            label="Compare fields"
            placeholder="Select fields…"
            options={compareOpts}
            selected={compare}
            open={openSel === "compare"}
            onToggleOpen={() =>
              setOpenSel((o) => (o === "compare" ? null : "compare"))
            }
            onClose={() => setOpenSel(null)}
            onChange={setCompare}
            showAllNone
          />
          <div className="field">
            <label>Balance field (optional)</label>
            <select
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            >
              <option value="">(none)</option>
              {nonKey.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="hint">
          Counts and balance sums are computed in the engine
          {left && right && !engineMismatch
            ? ` (${engineOf(left) === "duckdb" ? "DuckDB" : "SQLite"})`
            : ""}
          . Fields are compared as text so results match across engines; the
          balance is summed from the left table. A mapping file lines up
          differently-named columns (case/whitespace-insensitive, renames need
          not be 1:1, and either side may rename independently); the report
          shows both the original and mapped names. Right-click any count to
          profile or drill into the underlying rows.
        </div>
      </div>
    </Modal>
  );
};
