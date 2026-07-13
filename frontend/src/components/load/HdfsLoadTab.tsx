import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { FsListing } from "../../lib/types";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";

const hdfsJoin = (base: string, name: string) =>
  base === "/" ? "/" + name : base.replace(/\/+$/, "") + "/" + name;
const hdfsCrumbs = (p: string) => {
  const segs = p.split("/").filter(Boolean);
  return segs.map((seg, i) => ({ seg, path: "/" + segs.slice(0, i + 1).join("/") }));
};

const HDFS_URL_KEY = "samql.hdfs.url";
const HDFS_USER_KEY = "samql.hdfs.user";
// We load tabular files: CSV, TSV, JSON, and Parquet. Marker / other files
// (.csv.ok, .crc, ...) are listed as hidden so the picker stays focused.
const isHdfsLoadable = (name: string) =>
  /\.(csv|tsv|json|ndjson|jsonl|parquet|pq)$/i.test(name);

export const HdfsLoadTab: React.FC<{
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (msg: string) => void;
  onBeginHdfsFileLoad?: (path: string) => void;
  duck: boolean;
}> = ({ busy, setBusy, onError, onBeginHdfsFileLoad, duck }) => {
  // The URL (and optional user) persist across closing the window so you don't
  // retype the cluster every time.
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(HDFS_URL_KEY) || "";
    } catch {
      return "";
    }
  });
  const [user, setUser] = useState(() => {
    try {
      return localStorage.getItem(HDFS_USER_KEY) || "";
    } catch {
      return "";
    }
  });
  const [connected, setConnected] = useState(false);
  const [path, setPath] = useState("/");
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);

  const saveUrl = (v: string) => {
    setUrl(v);
    try {
      localStorage.setItem(HDFS_URL_KEY, v);
    } catch {
      /* storage unavailable -- non-fatal */
    }
  };
  const saveUser = (v: string) => {
    setUser(v);
    try {
      localStorage.setItem(HDFS_USER_KEY, v);
    } catch {
      /* storage unavailable -- non-fatal */
    }
  };

  const doConnect = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.hdfsConnect(url.trim(), user.trim() || undefined);
      if (r.error || !r.ok) {
        onError(r.error || "Couldn't connect to HDFS.");
        return;
      }
      setConnected(true);
      setPath(r.path || "/");
      setDirs(r.folders || []);
      setFiles(r.files || []);
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const browseTo = async (p: string) => {
    setBusy(true);
    try {
      const r = await api.hdfsBrowse(p);
      if (r.error || !r.ok) {
        onError(r.error || "Couldn't open that folder.");
        return;
      }
      setPath(r.path || p);
      setDirs(r.dirs || []);
      setFiles(r.files || []);
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // Hand off to the job rail: the progress window streams the download and its
  // Cancel / X stop it server-side. Default load is a zero-copy DuckDB view.
  const loadFile = (file: string) => onBeginHdfsFileLoad?.(hdfsJoin(path, file));

  const crumbs = hdfsCrumbs(path);
  const loadables = files.filter(isHdfsLoadable);
  const hidden = files.length - loadables.length;

  return (
    <div className="hdfs-tab">
      <label className="field-label">WebHDFS URL</label>
      <input
        className="input mono"
        style={{ width: "100%" }}
        placeholder="https://host:14000/webhdfs/v1  (or an explorer.html link)"
        value={url}
        onChange={(e) => saveUrl(e.target.value)}
        disabled={busy}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <label className="field-label">
            User <span style={{ opacity: 0.6 }}>— optional</span>
          </label>
          <input
            className="input mono"
            placeholder="(blank for unsecured / gateway auth)"
            value={user}
            onChange={(e) => saveUser(e.target.value)}
            disabled={busy}
          />
        </div>
        <button className="btn primary" onClick={doConnect} disabled={busy || !url.trim()}>
          <Icon.Globe size={14} /> Connect
        </button>
      </div>

      {connected && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <label className="field-label" style={{ margin: 0 }}>
              Location
            </label>
            <button className="chip" onClick={() => browseTo("/")} disabled={busy} title="HDFS root">
              /
            </button>
            {crumbs.map((c) => (
              <React.Fragment key={c.path}>
                <span style={{ opacity: 0.4 }}>/</span>
                <button className="chip" onClick={() => browseTo(c.path)} disabled={busy}>
                  {c.seg}
                </button>
              </React.Fragment>
            ))}
          </div>

          <div style={{ fontSize: 12, opacity: 0.65, margin: "10px 0 8px" }}>
            Open folders to drill down, then click a file (CSV, TSV, JSON, or
            Parquet) to load it. Big files are read in place via a DuckDB
            view — not copied into memory.
          </div>

          {dirs.length === 0 && files.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 13 }}>This folder is empty.</div>
          ) : (
            <div
              style={{
                maxHeight: 320,
                overflowY: "auto",
                border: "1px solid var(--line, #2a323d)",
                borderRadius: 8,
                padding: 8,
              }}
            >
              {dirs.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: loadables.length ? 10 : 0,
                  }}
                >
                  {dirs.map((d) => (
                    <button
                      key={d}
                      className="chip"
                      onClick={() => browseTo(hdfsJoin(path, d))}
                      disabled={busy}
                      title="Open folder"
                    >
                      <Icon.Folder size={13} /> {d}
                    </button>
                  ))}
                </div>
              )}

              {loadables.length === 0 ? (
                <div style={{ opacity: 0.7, fontSize: 13 }}>
                  No loadable files here (CSV, TSV, JSON, Parquet) — open a sub-folder
                  to keep looking.
                </div>
              ) : (
                loadables.map((f) => (
                  <button
                    key={f}
                    className="btn"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      justifyContent: "flex-start",
                      marginBottom: 4,
                    }}
                    onClick={() => loadFile(f)}
                    disabled={busy}
                    title="Load this file (queried in place via DuckDB)"
                  >
                    <Icon.Download size={13} /> {f}
                  </button>
                ))
              )}

              {hidden > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.5 }}>
                  {hidden} other file{hidden === 1 ? "" : "s"} hidden
                </div>
              )}
            </div>
          )}

          {!duck && (
            <div className="hint" style={{ marginTop: 10 }}>
              DuckDB isn't available on this server, so CSV / TSV / JSON are copied
              into SQLite instead of queried in place; Parquet needs DuckDB.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
