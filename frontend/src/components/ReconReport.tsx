import React, { useState } from "react";
import type { ReconcileResult, ReconBucket } from "../lib/types";
import type { ReconSpec } from "./ReconcileModal";
import { reconReportCsv, reconCsvFilename } from "../lib/reconExport";
import { menuPos } from "../lib/menuPos";

interface Props {
  report: ReconcileResult;
  spec: ReconSpec;
  onProfile: (bucket: ReconBucket, field: string | null) => void;
  onDrill: (bucket: ReconBucket, field: string | null) => void;
  onExport: (filename: string, csv: string) => void;
  // .540: the full failed-values CSV (every mismatching key + field)
  onExportFailures?: () => void;
}

const fmtInt = (n: number) => n.toLocaleString();
const fmtBal = (n: number | null) =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const TILES: {
  key: keyof ReconcileResult["totals"];
  label: string;
  cls: string;
}[] = [
  { key: "a_only", label: "Only in A", cls: "t-a" },
  { key: "b_only", label: "Only in B", cls: "t-b" },
  { key: "non_matching", label: "Not matching", cls: "t-nm" },
  { key: "matching", label: "Matching", cls: "t-m" },
  { key: "total", label: "Total records", cls: "t-tot" },
];


// .463: a ~420ms ease-out count from 0 to `value`, restarted whenever
// runKey changes. The rAF loop cancels on unmount and on restart;
// prefers-reduced-motion skips the ride and shows the number.
const CountUp: React.FC<{ value: number; runKey: number }> = ({
  value,
  runKey,
}) => {
  const [shown, setShown] = React.useState(value);
  const raf = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    const rm =
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
      document.body.classList.contains("motion-reduced");
    if (rm || !isFinite(value) || value <= 0) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const dur = 420;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - (1 - p) * (1 - p);
      setShown(Math.round(value * eased));
      if (p < 1) raf.current = requestAnimationFrame(step);
      else raf.current = null;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [value, runKey]);
  return <>{fmtInt(shown)}</>;
};

export const ReconReport: React.FC<Props> = ({
  report,
  spec,
  onProfile,
  onDrill,
  onExport,
  onExportFailures,
}) => {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    bucket: ReconBucket;
    field: string | null;
  } | null>(null);
  // Hooks must run in the same order even when a report changes between an
  // error and a successful result.
  const runTick = React.useRef(0);
  const lastReport = React.useRef<unknown>(null);

  if (report.error) {
    return (
      <div className="error-pane">
        <div className="etitle">Reconcile failed</div>
        {report.error}
      </div>
    );
  }

  const hasBal = !!report.balance_field;
  const totals = report.totals;
  // .463: tiles COUNT UP from zero when a report lands. Keyed by the
  // report object's identity so a re-run replays; reduced-motion (or
  // an unmount mid-flight) jumps straight to the final number.
  if (lastReport.current !== report) {
    lastReport.current = report;
    runTick.current += 1;
  }

  const openMenu = (
    e: React.MouseEvent,
    bucket: ReconBucket,
    field: string | null,
  ) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, bucket, field });
  };

  // A count cell: shows the number and is right-clickable to profile / drill.
  const CountCell: React.FC<{
    value: number;
    bucket: ReconBucket;
    field: string | null;
  }> = ({ value, bucket, field }) => (
    <td
      className={"rr-count" + (value > 0 ? " hot" : "")}
      title="Right-click to profile or drill down"
      onContextMenu={(e) => openMenu(e, bucket, field)}
    >
      {fmtInt(value)}
    </td>
  );

  return (
    <div className="recon-report">
      <div className="rr-head">
        <b>{spec.left}</b>
        <span className="rr-vs">vs</span>
        <b>{spec.right}</b>
        <span className="rr-keys">
          on {report.keys.join(", ")}
          {report.engine ? ` · ${report.engine}` : ""}
          {report.balance_field ? ` · balance: ${report.balance_field}` : ""}
        </span>
        <span
          className="rr-export-group"
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            gap: 8,
            flexWrap: "nowrap",
          }}
        >
          {/* .543: ONE flex group so both exports always share a row --
              the failed-values button used to wrap under the title when
              long table names squeezed the header */}
          {onExportFailures && totals.non_matching > 0 && (
            <button
              className="btn sm"
              title="One CSV of EVERY failed value: each mismatching key + field with its left/right values -- the full drill-down list"
              onClick={onExportFailures}
            >
              Export failed values
            </button>
          )}
          <button
            className="btn sm"
            title="Export this reconcile report (totals + per-field breakdown) as CSV"
            onClick={() =>
              onExport(reconCsvFilename(spec), reconReportCsv(report, spec))
            }
          >
            Export CSV
          </button>
        </span>
      </div>

      {totals.total > 0 &&
        totals.non_matching === 0 &&
        totals.a_only === 0 &&
        totals.b_only === 0 && (
          <div className="rr-seal" title="Every key matched on every field">
            ALL MATCHED
          </div>
        )}
      <div className="rr-tiles">
        {TILES.map((t) => (
          <div key={t.key} className={"rr-tile " + t.cls}>
            <div className="rr-tile-n">
              <CountUp
                value={Number(totals[t.key]) || 0}
                runKey={runTick.current}
              />
            </div>
            <div className="rr-tile-l">{t.label}</div>
          </div>
        ))}
      </div>

      {report.fields.length === 0 ? (
        <div className="rr-empty">
          No fields compared. Re-open the reconciler and pick one or more
          compare fields to see the per-field breakdown.
        </div>
      ) : (
        <div className="rr-grid-wrap">
          <table className="rr-grid">
            <colgroup>
              <col className="rr-col-field" />
              <col />
              <col />
              <col />
              <col />
              {hasBal && <col />}
              {hasBal && <col />}
            </colgroup>
            <thead>
              <tr>
                <th>Field</th>
                <th className="rr-num">A only</th>
                <th className="rr-num">B only</th>
                <th className="rr-num">Not matching</th>
                <th className="rr-num">Matching</th>
                {hasBal && <th className="rr-num">Σ Matching bal</th>}
                {hasBal && <th className="rr-num">Σ Not-match bal</th>}
              </tr>
            </thead>
            <tbody>
              {report.fields.map((f) => (
                <tr key={f.field}>
                  <td className="rr-field" title={f.label || f.field}>
                    {f.label || f.field}
                  </td>
                  <CountCell value={f.a_only} bucket="a_only" field={f.field} />
                  <CountCell value={f.b_only} bucket="b_only" field={f.field} />
                  <CountCell
                    value={f.non_matching}
                    bucket="non_matching"
                    field={f.field}
                  />
                  <CountCell
                    value={f.matching}
                    bucket="matching"
                    field={f.field}
                  />
                  {hasBal && (
                    <td className="rr-bal">
                      {fmtBal(f.sum_matching_balance)}
                    </td>
                  )}
                  {hasBal && (
                    <td className="rr-bal">
                      {fmtBal(f.sum_non_matching_balance)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {menu && (
        <>
          <div
            className="rc-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={menuPos(menu.x, menu.y, 200)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">
              {menu.field ? `${menu.field} · ` : ""}
              {menu.bucket.replace("_", " ")}
            </div>
            <button
              className="btn ghost"
              onClick={() => {
                onProfile(menu.bucket, menu.field);
                setMenu(null);
              }}
            >
              Profile underlying rows
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                onDrill(menu.bucket, menu.field);
                setMenu(null);
              }}
            >
              Drill down to rows
            </button>
          </div>
        </>
      )}
    </div>
  );
};
