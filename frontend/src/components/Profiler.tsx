import React from "react";
import type { TableProfile } from "../lib/types";
import { useRenderCount } from "../lib/renderDebug";

interface Props {
  profile: TableProfile | null;
  loading: boolean;
  tableName?: string;
}

function num(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(v);
}

const PROF_COLS = [
  "Column", "Type", "Nulls", "Distinct",
  "Min", "Max", "Mean", "Std", "Top values",
] as const;
const PROF_DEFAULT_W = [170, 120, 130, 130, 100, 100, 100, 100, 280];

const ProfilerImpl: React.FC<Props> = ({ profile, loading, tableName }) => {
  useRenderCount("Profiler");
  // .471: resizable columns. Widths live in state so they persist
  // across re-renders; DURING a drag the <col> element is written
  // directly (the useWinDrag lesson -- no per-mousemove renders) and
  // the state commits once on release.
  const [colW, setColW] = React.useState<number[]>(
    () => [...PROF_DEFAULT_W],
  );
  const colRefs = React.useRef<(HTMLTableColElement | null)[]>([]);
  const dragRz = React.useRef<{
    i: number;
    startX: number;
    startW: number;
    last: number;
  } | null>(null);
  const [rzActive, setRzActive] = React.useState<number | null>(null);
  React.useEffect(() => {
    const mv = (e: MouseEvent) => {
      const d = dragRz.current;
      if (!d) return;
      d.last = Math.max(56, d.startW + (e.clientX - d.startX));
      const el = colRefs.current[d.i];
      if (el) el.style.width = d.last + "px";
    };
    const up = () => {
      const d = dragRz.current;
      if (!d) return;
      dragRz.current = null;
      setRzActive(null);
      setColW((w) => w.map((x, k) => (k === d.i ? d.last : x)));
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  const startRz = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRz.current = {
      i,
      startX: e.clientX,
      startW: colW[i],
      last: colW[i],
    };
    setRzActive(i);
  };
  if (loading) {
    return (
      <div className="empty">
        <div className="inner">
          <span className="spin" /> <span> profiling {tableName}…</span>
        </div>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="empty">
        <div className="inner">
          <h3>Column profiler</h3>
          <p>
            Select a table in the sidebar and choose <b>Profile</b>, or open
            the Profiler from a table's row menu. You'll get types, null and
            distinct ratios, ranges, and the most common values per column.
          </p>
        </div>
      </div>
    );
  }
  if (profile.error) {
    return (
      <div className="error-box">
        <div className="etitle">Could not profile {profile.table}</div>
        {profile.error}
      </div>
    );
  }

  return (
    <div className="profiler">
      <div className="result-status" style={{ borderRadius: 7, marginBottom: 10 }}>
        <span className="mono">
          <b>{profile.table}</b>
        </span>
        <span className="stat">
          <b>{profile.total_rows.toLocaleString()}</b> rows ·{" "}
          <b>{profile.columns.length}</b> columns
        </span>
      </div>
      <table className="prof-table">
        <colgroup>
          {PROF_COLS.map((_, i) => (
            <col
              key={i}
              ref={(el) => {
                colRefs.current[i] = el;
              }}
              style={{ width: colW[i] }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {PROF_COLS.map((label, i) => (
              <th key={label}>
                {label}
                <span
                  className={
                    "col-rz" + (rzActive === i ? " active" : "")
                  }
                  title="Drag to resize this column"
                  onMouseDown={startRz(i)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profile.columns.map((c) => (
            <tr key={c.column}>
              <td style={{ color: "var(--accent-hi)" }}>{c.column}</td>
              <td className="faint">
                {c.type}
                {c.date_fmt ? ` · ${c.date_fmt}` : ""}
              </td>
              <td>
                <span className="bar-track">
                  <span
                    className="bar-mini"
                    style={{
                      width: `${Math.min(100, c.null_pct)}%`,
                      background: "var(--error)",
                    }}
                  />
                </span>{" "}
                <span className="faint">{c.null_pct.toFixed(1)}%</span>
              </td>
              <td>
                <span className="bar-track">
                  <span
                    className="bar-mini"
                    style={{ width: `${Math.min(100, c.distinct_pct)}%` }}
                  />
                </span>{" "}
                <span className="faint">{num(c.distinct)}</span>
              </td>
              <td>{num(c.min)}</td>
              <td>{num(c.max)}</td>
              <td>{num(c.mean)}</td>
              <td>{num(c.std)}</td>
              <td className="faint" style={{ whiteSpace: "normal" }}>
                {(c.top_values || [])
                  .slice(0, 4)
                  .map(
                    (t) =>
                      `${t.value === null ? "NULL" : t.value} (${t.count})`,
                  )
                  .join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// All props are stable values (profile object, loading flag, table name), so a
// shallow comparison is sufficient.
export const Profiler = React.memo(ProfilerImpl);
