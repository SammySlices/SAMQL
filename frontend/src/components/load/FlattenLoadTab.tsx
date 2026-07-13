import React, { useRef, useState } from "react";
import { api } from "../../lib/api";
import { isCancelledError } from "../../lib/runController";
import { Icon } from "../Icon";
import { FileBrowser } from "./FileBrowser";

export const FlattenLoadTab: React.FC<{
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (msg: string) => void;
  cancelRef?: React.MutableRefObject<(() => void) | null>;
}> = ({ busy, setBusy, onError, cancelRef }) => {
  const [jsonPath, setJsonPath] = useState("");
  const [outDir, setOutDir] = useState("");
  const [browse, setBrowse] = useState<null | "json" | "out">(null);
  const [result, setResult] = useState<{
    dir: string;
    files: { table: string; file: string; rows: number; columns: number }[];
  } | null>(null);
  const [prog, setProg] = useState<null | {
    stage: string;
    pct: number;
    detail: string;
    records: number;
  }>(null);

  const jobIdRef = useRef<string | null>(null);
  const cancelFlatten = () => {
    const j = jobIdRef.current;
    if (j) api.flattenCancel(j).catch(() => {});
  };

  const flatten = async () => {
    if (!jsonPath.trim() || !outDir.trim()) return;
    setBusy(true);
    setResult(null);
    setProg({ stage: "reading", pct: 0, detail: "", records: 0 });
    try {
      const start = await api.flattenStart(jsonPath.trim(), outDir.trim());
      const jobId = start.job_id;
      jobIdRef.current = jobId;
      // The window's X (handleClose), Esc/backdrop, and the in-tab Cancel
      // button all share ONE cancel function -- no duplicated flattenCancel
      // call site. It rolls back the CSVs the flatten had written.
      if (cancelRef) cancelRef.current = cancelFlatten;
      // Poll the job: reading maps to 0–70% (by bytes), writing 70–100%
      // (by tables written).
      for (;;) {
        await new Promise((r) => setTimeout(r, 250));
        let p;
        try {
          p = await api.flattenProgress(jobId);
        } catch (e) {
          if (isCancelledError(e)) break; // window closed -> stop polling
          continue; // transient; keep polling
        }
        let frac: number;
        if (p.stage === "writing" || p.stage === "done") {
          const tw = p.tables_total ? p.tables_done / p.tables_total : 1;
          frac = 0.7 + 0.3 * tw;
        } else {
          frac = p.bytes_total ? 0.7 * (p.bytes_done / p.bytes_total) : 0;
        }
        setProg({
          stage: p.stage,
          pct: Math.min(100, Math.max(0, Math.round(frac * 100))),
          detail: p.detail || "",
          records: p.records || 0,
        });
        if (p.state === "cancelled") {
          break; // server-side cancelled; the finally clears busy + prog
        }
        if (p.state === "error") {
          onError(p.error || "Flatten failed.");
          break;
        }
        if (p.state === "done") {
          const r = p.result || {};
          setResult({ dir: r.dir || "", files: r.files || [] });
          break;
        }
      }
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      jobIdRef.current = null;
      if (cancelRef) cancelRef.current = null;
      setBusy(false);
      setProg(null);
    }
  };

  return (
    <div>
      <div className="form-row">
        <label>JSON file</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Click Browse, or paste a full path…"
            value={jsonPath}
            onChange={(e) => setJsonPath(e.target.value)}
          />
          <button className="btn" onClick={() => setBrowse("json")}>
            <Icon.Folder size={15} /> Browse…
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Output folder</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Click Browse to choose where the CSVs go…"
            value={outDir}
            onChange={(e) => setOutDir(e.target.value)}
          />
          <button className="btn" onClick={() => setBrowse("out")}>
            <Icon.Folder size={15} /> Browse…
          </button>
        </div>
      </div>
      <div className="hint">
        The JSON is flattened into a set of related tables — a root table plus a
        child table for each nested array (linked by id) — and written as one
        CSV per table into a <code>&lt;name&gt;_flattened</code> folder inside
        your output folder. Large files stream to disk, and nothing is loaded
        into the app.
      </div>
      <div
        style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14 }}
      >
        <button
          className="btn primary"
          disabled={busy || !jsonPath.trim() || !outDir.trim()}
          onClick={flatten}
        >
          {busy ? <span className="spin" /> : <Icon.Download size={15} />} Flatten
        </button>
        {busy && (
          <button
            className="btn ghost"
            onClick={cancelFlatten}
            title="Cancel flatten"
          >
            <Icon.X size={14} /> Cancel
          </button>
        )}
        {prog && (
          <div className="flatten-progress">
            <div className="flatten-progress-bar">
              <div
                className="flatten-progress-fill"
                style={{ width: prog.pct + "%" }}
              />
            </div>
            <div className="flatten-progress-label">
              {prog.stage === "reading"
                ? `Reading JSON… ${prog.records.toLocaleString()} records`
                : prog.stage === "writing"
                ? `Writing CSVs… ${prog.detail || ""}`.trim()
                : "Finishing…"}
              <span className="flatten-progress-pct"> · {prog.pct}%</span>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="flatten-result">
          <div className="flatten-result-head">
            <span className="flatten-ok">✓</span> Wrote {result.files.length}{" "}
            CSV{result.files.length === 1 ? "" : "s"} to
            <span className="mono"> {result.dir}</span>
          </div>
          <div className="flatten-files">
            {result.files.map((f) => (
              <div key={f.file} className="flatten-file">
                <Icon.File size={13} className="faint" />
                <span className="mono">{f.file}</span>
                <span className="faint">
                  {f.rows.toLocaleString()} rows · {f.columns} cols
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {browse === "json" && (
        <FileBrowser
          initialPath={jsonPath.trim() || undefined}
          onClose={() => setBrowse(null)}
          onPick={(p) => {
            setJsonPath(p);
            setBrowse(null);
          }}
        />
      )}
      {browse === "out" && (
        <FileBrowser
          pickFolder
          initialPath={outDir.trim() || jsonPath.trim() || undefined}
          onClose={() => setBrowse(null)}
          onPick={(p) => {
            setOutDir(p);
            setBrowse(null);
          }}
        />
      )}
    </div>
  );
};
