// .538: right-click a loaded table -> Properties. Format, counts, how
// SamQL stores it (engine, table vs query-in-place view, backing
// files), and WHERE it came from -- file, folder, full path.
import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../lib/api";

function fmtBytes(n?: number | null): string {
  if (n == null) return "unknown";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

export const TablePropsModal: React.FC<{
  engine: string;
  table: string;
  onClose: () => void;
}> = ({ engine, table, onClose }) => {
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .tableProperties(engine, table)
      .then((d) => live && setP(d))
      .catch((e) => live && setErr(e?.message || "Could not load"));
    return () => {
      live = false;
    };
  }, [engine, table]);

  const copyPath = () => {
    const path = p?.source?.path;
    if (!path) return;
    try {
      void navigator.clipboard?.writeText(path);
    } catch {
      /* ignore */
    }
  };

  return (
    <Modal title={`Properties — ${table}`} onClose={onClose}>
      <div className="props-body">
        {err && <div className="about-err">{err}</div>}
        {p && (
          <>
            <div className="about-sec">Data</div>
            <div className="about-row">
              <span>Format</span>
              <span>{p.format ? p.format.toUpperCase() : "—"}</span>
            </div>
            <div className="about-row">
              <span>Rows</span>
              <span>
                {p.rows == null ? "unknown" : p.rows.toLocaleString()}
              </span>
            </div>
            <div className="about-row">
              <span>Columns</span>
              <span>{p.columns ?? "unknown"}</span>
            </div>
            <div className="about-sec">Stored in SamQL</div>
            <div className="about-row">
              <span>Engine</span>
              <span>{p.stored?.engine}</span>
            </div>
            <div className="about-row">
              <span>Object</span>
              <span>{p.stored?.object}</span>
            </div>
            {p.stored?.database && (
              <div className="about-row">
                <span>Database</span>
                <span className="props-path">{p.stored.database}</span>
              </div>
            )}
            {p.stored?.backing_file && (
              <div className="about-row">
                <span>Backing cache</span>
                <span className="props-path">
                  {p.stored.backing_file}
                  {p.stored.backing_bytes != null &&
                    ` (${fmtBytes(p.stored.backing_bytes)})`}
                </span>
              </div>
            )}
            {p.stored?.note && (
              <div className="props-note faint">{p.stored.note}</div>
            )}
            <div className="about-sec">Source</div>
            {p.source?.note && !p.source?.path ? (
              <div className="props-note faint">{p.source.note}</div>
            ) : (
              <>
                {p.source?.file && (
                  <div className="about-row">
                    <span>File</span>
                    <span>{p.source.file}</span>
                  </div>
                )}
                {/* .550: the ORIGINAL source location, when known --
                    distinct from the loaded/converted copy below. */}
                {p.source?.original_path && (
                  <div className="about-row">
                    <span>Original path</span>
                    <span className="props-path">
                      {p.source.original_path}
                    </span>
                  </div>
                )}
                {!p.source?.original_path && p.source?.original_file && (
                  <div className="about-row">
                    <span>Original file</span>
                    <span>{p.source.original_file}</span>
                  </div>
                )}
                {p.source?.original_note && (
                  <div className="props-note faint">
                    {p.source.original_note}
                  </div>
                )}
                <div className="about-row">
                  <span>Folder</span>
                  <span className="props-path">{p.source?.folder}</span>
                </div>
                <div className="about-row">
                  <span>
                    {p.source?.original_path ? "Loaded copy" : "Full path"}
                  </span>
                  <span className="props-path">{p.source?.path}</span>
                </div>
                {p.source?.bytes != null && (
                  <div className="about-row">
                    <span>Size</span>
                    <span>{fmtBytes(p.source.bytes)}</span>
                  </div>
                )}
                {p.source?.modified && (
                  <div className="about-row">
                    <span>Modified</span>
                    <span>{p.source.modified.replace("T", " ")}</span>
                  </div>
                )}
                {p.source?.loaded_at && (
                  <div className="about-row">
                    <span>Loaded</span>
                    <span>{p.source.loaded_at.replace("T", " ")}</span>
                  </div>
                )}
                {p.source?.missing && (
                  <div className="props-note faint">
                    The source file no longer exists at this path.
                  </div>
                )}
                {p.source?.note && (
                  <div className="props-note faint">{p.source.note}</div>
                )}
                <div className="about-actions">
                  <button className="btn sm ghost" onClick={copyPath}>
                    Copy path
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
