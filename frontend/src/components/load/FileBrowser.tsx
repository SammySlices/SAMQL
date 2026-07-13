import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { FsListing } from "../../lib/types";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";
import { Modal } from "../Modal";

export const FileBrowser: React.FC<{
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
  pickFolder?: boolean;
  // save mode: navigate to a folder + type a filename, then confirm
  saveMode?: boolean;
  defaultFileName?: string;
}> = ({ initialPath, onPick, onClose, pickFolder, saveMode, defaultFileName }) => {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState(defaultFileName || "");
  const requestSeqRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const joinPath = (dir: string, name: string) => {
    const sep = listing?.sep || "/";
    const base = dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir;
    return base + sep + name;
  };

  const load = useCallback((path?: string) => {
    const sequence = ++requestSeqRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    void api
      .fsList(path, controller.signal)
      .then((next) => {
        if (
          !mountedRef.current ||
          sequence !== requestSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setListing(next);
      })
      .catch((error) => {
        if (
          !mountedRef.current ||
          sequence !== requestSeqRef.current ||
          controller.signal.aborted ||
          error?.name === "AbortError"
        ) {
          return;
        }
        setListing({
          path: path || "",
          parent: null,
          sep: "/",
          drives: [],
          entries: [],
          error: error?.message || String(error),
        });
      })
      .finally(() => {
        if (mountedRef.current && sequence === requestSeqRef.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load(initialPath);
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, [initialPath, load]);

  return (
    <Modal
      title={saveMode ? "Save to a folder" : pickFolder ? "Select a folder" : "Select a file"}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {pickFolder && !saveMode && (
            <button
              className="btn primary"
              disabled={!listing?.path}
              onClick={() => listing?.path && onPick(listing.path)}
            >
              <Icon.Folder size={14} /> Use this folder
            </button>
          )}
          {saveMode && (
            <>
              <input
                className="stp-input fb-savename"
                placeholder="file name"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    listing?.path &&
                    fileName.trim()
                  ) {
                    onPick(joinPath(listing.path, fileName.trim()));
                  }
                }}
              />
              <button
                className="btn primary"
                disabled={!listing?.path || !fileName.trim()}
                onClick={() =>
                  listing?.path &&
                  fileName.trim() &&
                  onPick(joinPath(listing.path, fileName.trim()))
                }
              >
                <Icon.Save size={14} /> Save here
              </button>
            </>
          )}
        </>
      }
    >
      <div className="fb-bar">
        <button
          className="btn sm"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && load(listing.parent)}
          title="Up one folder"
        >
          ↑ Up
        </button>
        <button
          className="btn sm ghost"
          onClick={() => load(listing?.path)}
          title="Refresh"
        >
          <Icon.Refresh size={14} />
        </button>
        <span className="fb-path mono" title={listing?.path}>
          {listing?.path || "…"}
        </span>
      </div>

      {listing?.shortcuts && listing.shortcuts.length > 0 && (
        <div className="fb-shortcuts">
          {listing.shortcuts.map((sc) => (
            <button
              key={sc.path}
              className={"fb-chip" + (listing.path === sc.path ? " on" : "")}
              onClick={() => load(sc.path)}
              title={sc.path}
            >
              {sc.label === "Home" ? (
                <Icon.Database size={12} />
              ) : (
                <Icon.Folder size={12} />
              )}{" "}
              {sc.label}
            </button>
          ))}
        </div>
      )}

      {listing?.drives && listing.drives.length > 0 && (
        <div className="fb-drives">
          {listing.drives.map((d) => (
            <button key={d} className="btn sm" onClick={() => load(d)}>
              {d}
            </button>
          ))}
        </div>
      )}

      <div className="fb-list">
        {loading && (
          <div className="faint" style={{ padding: 14 }}>
            <span className="spin" /> reading…
          </div>
        )}
        {listing?.error && (
          <div className="error-box" style={{ margin: 8 }}>
            {listing.error}
          </div>
        )}
        {!loading &&
          listing?.entries.map((e) => (
            <div
              key={e.path}
              className={
                "fb-row" +
                (e.is_dir ? " dir" : pickFolder ? " disabled" : "")
              }
              onClick={() => {
                if (e.is_dir) load(e.path);
                else if (saveMode) setFileName(e.name);
                else if (!pickFolder) onPick(e.path);
              }}
              title={e.path}
            >
              {e.is_dir ? (
                <Icon.Folder size={15} className="fb-ic dir" />
              ) : (
                <Icon.File size={15} className="fb-ic" />
              )}
              <span className="fb-name">{e.name}</span>
              {!e.is_dir && (
                <span className="fb-size faint">{formatBytes(e.size)}</span>
              )}
            </div>
          ))}
        {!loading &&
          listing &&
          listing.entries.length === 0 &&
          !listing.error && (
            <div className="faint" style={{ padding: 14 }}>
              This folder is empty.
            </div>
          )}
      </div>
      <div className="hint">
        {pickFolder
          ? "Open the folder you want to export into, then click Use this folder."
          : "Click a folder to open it; click a file to choose it."}
      </div>
    </Modal>
  );
};
