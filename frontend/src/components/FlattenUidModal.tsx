import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import type { RootIdCand, RootIdChoice } from "../lib/api";

/** Field Explorer: pick a Unique Identifier before Confirm Flatten. */
export const FlattenUidModal: React.FC<{
  open: boolean;
  engine: string;
  table: string;
  onCancel: () => void;
  onConfirm: (rootId: RootIdChoice) => void;
}> = ({ open, engine, table, onCancel, onConfirm }) => {
  const [cands, setCands] = useState<RootIdCand[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState("");
  const [choice, setChoice] = useState<RootIdChoice | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [stats, setStats] = useState<{
    unique?: boolean;
    duplicated?: number;
    nulls?: number;
    records?: number;
    distinct?: number;
    nonnull?: number;
    label?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setCands(null);
    setErr("");
    setPick("");
    setChoice(null);
    setStats(null);
    let alive = true;
    setBusy(true);
    api
      .tableRootIdOptions(engine, table)
      .then((r) => {
        if (!alive) return;
        if (r.error) setErr(r.error);
        else setCands(r.candidates || []);
      })
      .catch((e: any) => {
        if (alive) setErr(e?.message || String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [open, engine, table]);

  useEffect(() => {
    if (!open || !choice) {
      setStats(null);
      return;
    }
    let alive = true;
    setStatsBusy(true);
    setStats(null);
    api
      .tableRootIdStats(engine, table, choice)
      .then((r) => {
        if (!alive) return;
        if (r.error) setStats({ error: r.error });
        else
          setStats({
            unique: r.unique,
            duplicated: r.duplicated,
            nulls: r.nulls,
            records: r.records,
            distinct: r.distinct,
            nonnull: r.nonnull,
            label: r.label,
          });
      })
      .catch((e: any) => {
        if (alive) setStats({ error: e?.message || String(e) });
      })
      .finally(() => {
        if (alive) setStatsBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [open, engine, table, choice]);

  if (!open) return null;

  const applyPick = (v: string) => {
    setPick(v);
    if (!v || !cands) {
      setChoice(null);
      return;
    }
    const sep = v.indexOf("::");
    const idx = Number(sep >= 0 ? v.slice(0, sep) : v);
    const c = cands[idx];
    if (!c) {
      setChoice(null);
      return;
    }
    if (c.map) {
      const key = v.slice(sep + 2);
      setChoice({
        steps: c.steps,
        in_list: c.in_list || null,
        map: true,
        map_key: key,
        label: (c.label || "").replace("[<key>]", `['${key}']`),
      });
    } else {
      setChoice({
        steps: c.steps,
        in_list: c.in_list || null,
        map: false,
        label: c.label,
      });
    }
  };

  // Prefer a finished uniqueness probe so the user sees the warning, but do
  // not block Confirm when the identifier is not unique (warn-only).
  const canConfirm = !!choice && !statsBusy && !!stats;

  return (
    <Modal
      title="Pick a Unique Identifier"
      onClose={onCancel}
      testId="fx-flatten-uid-modal"
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Pick a field that identifies each source record (any level of this
        table). Prefer a unique field when possible. It is carried onto every
        flattened table as <code>root_id</code>, aligned to each flattened row.
        A <code>Master_Keys</code> table lists the distinct values, and a{" "}
        <code>Join_Keys</code> table maps <code>_sk</code>, <code>_rid</code>,
        and <code>root_id</code> per record.
      </p>
      {busy && (
        <div className="hint">
          <span className="spin" /> Scanning fields…
        </div>
      )}
      {err && (
        <div className="hint" style={{ color: "var(--error, #c44)" }}>
          {err}
        </div>
      )}
      {!busy && !err && cands && cands.length === 0 && (
        <div className="hint">No identifier-shaped fields found on this table.</div>
      )}
      {!busy && !err && cands && cands.length > 0 && (
        <div className="form-row">
          <label htmlFor="fx-uid-select">Field</label>
          <select
            id="fx-uid-select"
            data-testid="fx-uid-select"
            value={pick}
            onChange={(e) => applyPick(e.target.value)}
          >
            <option value="">— pick a unique identifier —</option>
            {cands.map((c, i) =>
              c.map ? (
                c.keys && c.keys.length ? (
                  c.keys.map((k) => (
                    <option key={`${i}::${k}`} value={`${i}::${k}`}>
                      {(c.label || "").replace("[<key>]", `['${k}']`)}
                    </option>
                  ))
                ) : (
                  <option key={`d${i}`} value="" disabled>
                    {c.label} — no keys found
                  </option>
                )
              ) : (
                <option key={i} value={String(i)}>
                  {c.label}
                  {c.in_list ? " (first element)" : ""}
                </option>
              ),
            )}
          </select>
        </div>
      )}
      {choice && statsBusy && (
        <div className="hint" data-testid="fx-uid-stats-busy">
          <span className="spin" /> Checking uniqueness…
        </div>
      )}
      {choice && stats && !statsBusy && stats.error && (
        <div
          className="hint"
          style={{ color: "var(--error, #c44)" }}
          data-testid="fx-uid-stats-error"
        >
          {stats.error}
        </div>
      )}
      {choice && stats && !statsBusy && !stats.error && (
        <div
          className="fx-uid-verdict"
          data-testid="fx-uid-verdict"
          style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: stats.unique
              ? "color-mix(in srgb, var(--accent) 12%, transparent)"
              : "color-mix(in srgb, #c44 12%, transparent)",
          }}
        >
          {stats.unique ? (
            <div>
              <b>Unique.</b> {stats.records?.toLocaleString()} records, all
              distinct non-null values.
            </div>
          ) : (
            <div data-testid="fx-uid-not-unique-warn">
              <b>May not be unique.</b>{" "}
              {(stats.duplicated || 0) > 0 && (
                <span>
                  {(stats.duplicated || 0).toLocaleString()} duplicate value
                  {(stats.duplicated || 0) === 1 ? "" : "s"}
                  {". "}
                </span>
              )}
              {(stats.nulls || 0) > 0 && (
                <span>
                  {(stats.nulls || 0).toLocaleString()} null
                  {(stats.nulls || 0) === 1 ? "" : "s"}
                  {". "}
                </span>
              )}
              Flatten can still proceed, but the same <code>root_id</code> may
              appear on more than one source record (and thus on flattened
              rows). Prefer a different field if you need a true key.
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            {stats.distinct?.toLocaleString()} distinct /{" "}
            {stats.nonnull?.toLocaleString()} non-null /{" "}
            {stats.records?.toLocaleString()} records
          </div>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 16,
        }}
      >
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          data-testid="fx-uid-confirm"
          disabled={!canConfirm}
          title={
            !choice
              ? "Pick an identifier field first"
              : statsBusy || !stats
                ? "Checking uniqueness…"
                : stats.unique
                  ? "Flatten with this unique identifier"
                  : "Flatten anyway — identifier may not be unique"
          }
          onClick={() => choice && canConfirm && onConfirm(choice)}
        >
          Confirm Flatten
        </button>
      </div>
    </Modal>
  );
};
