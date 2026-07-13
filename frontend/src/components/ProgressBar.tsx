import React from "react";

// A *determinate* run-progress bar shown next to a Run/Stop button. It appears
// only when there is a real completion fraction to show -- an iterator over N
// rows, a bounded while-loop, "Run all" over M terminals/cells -- and fills to
// that fraction with "NN%". When the work has no knowable size (a single opaque
// query whose progress the engine cannot report), it renders *nothing* rather
// than an animated "running" indicator: the Stop button and the elapsed timer
// already show that something is running, so a spinning bar there would just be
// the old running indicator wearing a new name.

export const ProgressBar: React.FC<{
  value?: number | null;
  rows?: number | null;
  unit?: string | null;
  done?: number | null;
  total?: number | null;
}> = ({ value, unit, done, total }) => {
  if (typeof value !== "number" || !isFinite(value) || value < 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const label =
    done != null && total != null && unit
      ? `${pct}% · ${done}/${total} ${unit}${total === 1 ? "" : "s"}`
      : `${pct}%`;
  return (
    <>
      <span
        className="run-bar determinate"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        title={`${pct}% complete`}
      >
        <span style={{ left: 0, width: pct + "%" }} />
      </span>
      <span className="run-pct">{label}</span>
    </>
  );
};
