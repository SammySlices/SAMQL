import React, { useRef, useState } from "react";
import { abortInflight } from "../lib/api";
import type { RootIdChoice } from "../lib/api";
import type { Features, LoadResult } from "../lib/types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { ApiLoadTab } from "./load/ApiLoadTab";
import { FileLoadTab } from "./load/FileLoadTab";
import { FlattenLoadTab } from "./load/FlattenLoadTab";
import { HdfsLoadTab } from "./load/HdfsLoadTab";
import { SqlServerLoadTab } from "./load/SqlServerLoadTab";

export { FileBrowser } from "./load/FileBrowser";
export { RootIdPicker } from "./load/RootIdPicker";

interface Props {
  features: Features | null;
  onClose: () => void;
  onBeginLoad: (
    path: string,
    destination: string,
    delimiter?: string,
    mode?: string,
    sheet?: string,
    headerRow?: number,
    exclude?: string,
    opts?: { flatten?: boolean; shred?: boolean; root_id?: RootIdChoice },
  ) => void;
  onBeginLoadFolder: (
    dir: string,
    destination: string,
    delimiter?: string,
  ) => void;
  onLoaded: (res: LoadResult, label: string) => void;
  onError: (msg: string) => void;
  onBeginHdfsFileLoad?: (path: string) => void;
}

type Tab = "file" | "api" | "mssql" | "hdfs" | "flatten";

/**
 * Load-data composition shell.
 *
 * Each source owns its own form, state, validation, and API calls under
 * components/load/. This component owns only tab selection and the one shared
 * close/cancellation contract, so adding or changing one source cannot disturb
 * the other load paths.
 */
export const LoadDataModal: React.FC<Props> = ({
  features,
  onClose,
  onBeginLoad,
  onBeginLoadFolder,
  onLoaded,
  onError,
  onBeginHdfsFileLoad,
}) => {
  const [tab, setTab] = useState<Tab>("file");
  const [busy, setBusy] = useState(false);
  const closingRef = useRef(false);
  const activeCancelRef = useRef<(() => void) | null>(null);

  const guardedError = (message: string) => {
    if (!closingRef.current) onError(message);
  };

  const handleClose = () => {
    closingRef.current = true;
    try {
      activeCancelRef.current?.();
    } catch {
      /* best-effort */
    }
    if (busy) {
      try {
        abortInflight();
      } catch {
        /* best-effort */
      }
    }
    onClose();
  };

  return (
    <Modal title="Load a Table" onClose={handleClose} wide testId="load-data-modal">
      <div className="tabs" style={{ borderRadius: 7, marginBottom: 16 }}>
        <button
          className={"tab" + (tab === "file" ? " active" : "")}
          onClick={() => setTab("file")}
        >
          <Icon.Folder size={14} /> From a file
        </button>
        <button
          className={"tab" + (tab === "api" ? " active" : "")}
          onClick={() => setTab("api")}
        >
          <Icon.Globe size={14} /> REST API
        </button>
        <button
          className={"tab" + (tab === "mssql" ? " active" : "")}
          onClick={() => setTab("mssql")}
        >
          <Icon.Database size={14} /> SQL Server
        </button>
        <button
          className={"tab" + (tab === "hdfs" ? " active" : "")}
          onClick={() => setTab("hdfs")}
        >
          <Icon.Folder size={14} /> HDFS
        </button>
        <button
          className={"tab" + (tab === "flatten" ? " active" : "")}
          onClick={() => setTab("flatten")}
        >
          <Icon.Download size={14} /> Flatten JSON and Export
        </button>
      </div>

      {tab === "file" && (
        <FileLoadTab
          onBeginLoad={onBeginLoad}
          onBeginLoadFolder={onBeginLoadFolder}
          duck={!!features?.duckdb}
        />
      )}
      {tab === "api" && (
        <ApiLoadTab
          busy={busy}
          setBusy={setBusy}
          onLoaded={onLoaded}
          onError={guardedError}
          duck={!!features?.duckdb}
          secretsOk={!!features?.secrets}
          cancelRef={activeCancelRef}
        />
      )}
      {tab === "mssql" && (
        <SqlServerLoadTab
          busy={busy}
          setBusy={setBusy}
          onLoaded={onLoaded}
          onError={guardedError}
          duck={!!features?.duckdb}
          secretsOk={!!features?.secrets}
          cancelRef={activeCancelRef}
        />
      )}
      {tab === "hdfs" && (
        <HdfsLoadTab
          busy={busy}
          setBusy={setBusy}
          onError={guardedError}
          onBeginHdfsFileLoad={onBeginHdfsFileLoad}
          duck={!!features?.duckdb}
        />
      )}
      {tab === "flatten" && (
        <FlattenLoadTab
          busy={busy}
          setBusy={setBusy}
          onError={guardedError}
          cancelRef={activeCancelRef}
        />
      )}
    </Modal>
  );
};
