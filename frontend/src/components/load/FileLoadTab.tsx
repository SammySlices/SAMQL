import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { RootIdChoice } from "../../lib/api";
import { Icon } from "../Icon";
import { FileBrowser } from "./FileBrowser";
import { RootIdPicker } from "./RootIdPicker";

export const FileLoadTab: React.FC<{
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
  duck: boolean;
}> = ({ onBeginLoad, onBeginLoadFolder, duck }) => {
  const [path, setPath] = useState("");
  const [dest, setDest] = useState("auto");
  const [delim, setDelim] = useState("");
  const [loadMode, setLoadMode] = useState("materialize");
  // JSON + DuckDB: flatten into RELATIONAL tables (the shred engine) --
  // replaces the old global Settings toggle; the load itself stays a nested
  // query-in-place table either way.
  const [shredOn, setShredOn] = useState(false);
  // .521: the chosen unique identifier (root_id); reset when the source
  // path changes or the flatten toggle goes off.
  const [rootId, setRootId] = useState<RootIdChoice | null>(null);
  useEffect(() => {
    setRootId(null);
  }, [path]);
  useEffect(() => {
    if (!shredOn) setRootId(null);
  }, [shredOn]);
  const [browsing, setBrowsing] = useState(false);
  const [folderBrowsing, setFolderBrowsing] = useState(false);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState(""); // "" = all sheets
  const [headerRow, setHeaderRow] = useState(1);
  const [sheetsBusy, setSheetsBusy] = useState(false);
  // JSON selective flattening: discovered nested fields + the set to skip
  type NestedField = {
    key: string;
    kind: "array" | "object";
    depth: number;
    count: number;
    max_items: number;
  };
  const [fields, setFields] = useState<NestedField[] | null>(null);
  const [fieldsBusy, setFieldsBusy] = useState(false);
  const [fieldsMeta, setFieldsMeta] = useState<{
    complete: boolean;
    sampled: number;
    scan_s: number;
  } | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  // fallback / override: type extra field names to skip (union with checkboxes)
  const [manualSkip, setManualSkip] = useState("");
  const [preflight, setPreflight] = useState<{
    ok: boolean;
    size_mb: number;
    warnings: string[];
    blockers: string[];
  } | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);

  const isExcel = /\.(xlsx|xlsm|xls)$/i.test(path.trim());
  const isJson = /\.(json|ndjson|jsonl)$/i.test(path.trim());

  // Advise before large loads: DuckDB required, temp disk, Excel limits.
  useEffect(() => {
    const p = path.trim();
    setPreflight(null);
    if (!p) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreflightBusy(true);
      api
        .loadPreflight(p)
        .then((r) => {
          if (cancelled) return;
          setPreflight({
            ok: !!r.ok,
            size_mb: r.size_mb || 0,
            warnings: r.warnings || [],
            blockers: r.blockers || [],
          });
        })
        .catch(() => {
          if (!cancelled) setPreflight(null);
        })
        .finally(() => {
          if (!cancelled) setPreflightBusy(false);
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path]);

  // When the chosen file is an Excel workbook, fetch its sheet names so the
  // user can pick which sheet to load and which row the header starts on.
  useEffect(() => {
    const p = path.trim();
    if (!/\.(xlsx|xlsm|xls)$/i.test(p)) {
      setSheets(null);
      setSheet("");
      return;
    }
    let cancelled = false;
    setSheetsBusy(true);
    api
      .excelSheets(p)
      .then((r) => !cancelled && setSheets(r.sheets || []))
      .catch(() => !cancelled && setSheets(null))
      .finally(() => !cancelled && setSheetsBusy(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  // When the chosen file is JSON, discover its nested fields so we can offer a
  // skip checkbox for each. Time-boxed on the backend (a big swap-style file
  // hides the heavy arrays deep in), so the result may be partial -> we offer a
  // "scan deeper" retry.
  const scanFields = React.useCallback(
    (p: string, budget?: number) => {
      let cancelled = false;
      setFieldsBusy(true);
      api
        .jsonFields(p, budget)
        .then((r) => {
          if (cancelled) return;
          setFields(r.fields || []);
          setFieldsMeta({
            complete: r.complete,
            sampled: r.sampled,
            scan_s: r.scan_s,
          });
        })
        .catch(() => {
          if (!cancelled) {
            setFields(null);
            setFieldsMeta(null);
          }
        })
        .finally(() => !cancelled && setFieldsBusy(false));
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    const p = path.trim();
    setFields(null);
    setFieldsMeta(null);
    setSkip(new Set());
    setManualSkip("");
    if (!/\.(json|ndjson|jsonl)$/i.test(p)) return;
    const cancel = scanFields(p);
    return cancel;
  }, [path, scanFields]);

  const toggleSkip = (key: string) =>
    setSkip((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // the shred toggle applies when a JSON file will land in DuckDB
  const shredEligible = isJson && duck && dest !== "sqlite";

  const go = () => {
    if (!path.trim()) return;
    if (preflight?.blockers?.length) return;
    const merged = new Set(skip);
    for (const t of manualSkip.split(","))
      if (t.trim()) merged.add(t.trim());
    onBeginLoad(
      path.trim(),
      dest,
      delim.trim() || undefined,
      loadMode,
      isExcel && sheet ? sheet : undefined,
      isExcel ? headerRow : undefined,
      !shredEligible && isJson && merged.size
        ? Array.from(merged).join(",")
        : undefined,
      shredEligible
        ? {
            flatten: false,
            shred: shredOn,
            ...(rootId ? { root_id: rootId } : {}),
          }
        : undefined,
    );
  };

  return (
    <div>
      <div className="form-row">
        <label>Choose a file on this computer</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            data-testid="load-file-path"
            style={{ flex: 1 }}
            placeholder="Click Browse, or paste a full path…"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <button className="btn" onClick={() => setBrowsing(true)}>
            <Icon.Folder size={15} /> Browse…
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Load into engine</label>
        <select data-testid="load-destination" value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="auto">
            Auto {duck ? "— DuckDB (recommended)" : "— SQLite"}
          </option>
          <option value="duckdb" disabled={!duck}>
            DuckDB{duck ? "" : " (install duckdb to enable)"}
          </option>
          <option value="sqlite">SQLite</option>
        </select>
      </div>
      <div className="form-row">
        <label>How to load</label>
        <select
          data-testid="load-mode"
          value={loadMode}
          onChange={(e) => setLoadMode(e.target.value)}
        >
          <option value="materialize">Copy into a table (default)</option>
          <option value="view" disabled={!duck}>
            Query the file in place — don&apos;t copy
            {duck ? "" : " (needs DuckDB)"}
          </option>
        </select>
      </div>
      {isExcel && (
        <>
          <div className="form-row">
            <label>Excel sheet</label>
            <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
              <option value="">
                {sheetsBusy
                  ? "Reading sheets…"
                  : "All sheets (one table each)"}
              </option>
              {(sheets || []).map((sn) => (
                <option key={sn} value={sn}>
                  {sn}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Start at row (the header row)</label>
            <input
              type="number"
              min={1}
              value={headerRow}
              onChange={(e) =>
                setHeaderRow(Math.max(1, Number(e.target.value) || 1))
              }
              onKeyDown={(e) => e.key === "Enter" && go()}
            />
            <div className="hint" style={{ margin: "4px 0 0" }}>
              The row that holds the column names — rows above it are skipped.
              Use this when a sheet has a title or notes before the header.
            </div>
          </div>
        </>
      )}
      <div className="form-row">
        <label>Delimiter (CSV / text files)</label>
        <input
          placeholder={"auto-detect — e.g. ~  ;  |  or  \\t  for tab"}
          value={delim}
          onChange={(e) => setDelim(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </div>
      {shredEligible && (
        <div className="form-row">
          <label
            className="chk"
            title="One table per nested array (trades, trades_legs, trades_legs_cashflows, ...) with join keys (_rid + ordinals). Created right after the load, reading the Parquet cache — one vectorized pass per table. Off = a single nested table you can query in place."
          >
            <input
              type="checkbox"
              checked={shredOn}
              onChange={(e) => setShredOn(e.target.checked)}
            />{" "}
            Flatten into relational tables (off by default — slower on large
            nested files; leave off unless you need joinable child tables)
          </label>
        </div>
      )}
      <RootIdPicker
        enabled={
          shredEligible &&
          shredOn &&
          /\.(json|ndjson|jsonl)$/i.test(path)
        }
        path={path}
        value={rootId}
        onChange={setRootId}
      />
      {isJson && !shredEligible ? (
        <div className="form-row">
          <label>Fields to flatten (uncheck to skip)</label>
          {fieldsBusy && (
            <div className="hint">Scanning the file for nested fields…</div>
          )}
          {!fieldsBusy && fields && fields.length === 0 && (
            <div className="hint">
              No nested arrays or objects found in the sampled records — this
              file flattens to a single table.
            </div>
          )}
          {!fieldsBusy && fields && fields.length > 0 && (
            <>
              <div
                style={{
                  maxHeight: 220,
                  overflowY: "auto",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 6,
                  padding: "6px 8px",
                }}
              >
                {["array", "object"].map((kind) => {
                  const group = fields.filter((f) => f.kind === kind);
                  if (!group.length) return null;
                  return (
                    <div key={kind} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          fontSize: 11,
                          opacity: 0.6,
                          margin: "2px 0",
                        }}
                      >
                        {kind === "array"
                          ? "Arrays — each becomes a child table (rows)"
                          : "Objects — nested fields (columns)"}
                      </div>
                      {group.map((f) => {
                        const off = skip.has(f.key);
                        return (
                          <label
                            key={f.key}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "3px 0",
                              cursor: "pointer",
                              opacity: off ? 0.5 : 1,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={!off}
                              onChange={() => toggleSkip(f.key)}
                              style={{
                                width: "auto",
                                flex: "0 0 auto",
                                margin: 0,
                              }}
                            />
                            <span
                              style={{
                                fontFamily: "monospace",
                                fontSize: 12.5,
                              }}
                            >
                              {f.key}
                            </span>
                            <span style={{ fontSize: 11, opacity: 0.6 }}>
                              {f.kind === "array"
                                ? f.max_items
                                  ? `array · up to ${f.max_items.toLocaleString()} items`
                                  : "array"
                                : "object"}
                              {f.depth > 0 ? ` · nested` : ""}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div
                className="hint"
                style={{
                  marginTop: 4,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  Unchecking a field skips it wherever it appears — its column
                  and, for an array, the whole child table. Skipping a big array
                  can turn a very long load into a quick one.
                </span>
                {fieldsMeta && !fieldsMeta.complete && (
                  <span style={{ color: "#c98a2b" }}>
                    Scanned {fieldsMeta.sampled.toLocaleString()} records in{" "}
                    {fieldsMeta.scan_s}s (not the whole file — deeper fields may
                    be missing).{" "}
                    <button
                      className="btn"
                      style={{ padding: "1px 8px", fontSize: 11 }}
                      onClick={() => scanFields(path.trim(), 60)}
                    >
                      Scan deeper
                    </button>
                  </span>
                )}
                {skip.size > 0 && (
                  <span>
                    Skipping {skip.size} field{skip.size === 1 ? "" : "s"}.
                  </span>
                )}
              </div>
            </>
          )}
          <input
            style={{ marginTop: 8 }}
            placeholder={
              "or type field names to skip (comma-separated) — e.g. cashFlows, floatingFlowsList"
            }
            value={manualSkip}
            onChange={(e) => setManualSkip(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <div className="hint" style={{ marginTop: 4 }}>
            Manual fallback: type any field names to skip in addition to the
            boxes above — useful if a field isn&apos;t listed (e.g. the scan
            didn&apos;t reach it). Same rule: a name is skipped wherever it
            appears.
          </div>
        </div>
      ) : null}
      <div className="hint">
        The file is read directly by the local backend — nothing is uploaded.
        With DuckDB installed, big CSV/JSON/Parquet files are read natively, so
        multi-GB datasets load smoothly. A progress bar appears while loading.
        {loadMode === "view" ? (
          <>
            {" "}
            <b>Query in place</b> skips the copy and reads the file on each
            query (a DuckDB view): instant to load and light on memory.
            Parquet stays fast; a CSV is re-parsed per query, so convert hot
            CSVs to Parquet if you&apos;ll query them a lot.
          </>
        ) : null}
      </div>
      {(preflightBusy ||
        (preflight &&
          (preflight.warnings.length > 0 || preflight.blockers.length > 0))) && (
        <div
          data-testid="load-preflight"
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(0,0,0,0.18)",
          }}
        >
          {preflightBusy && !preflight ? (
            <div className="hint" style={{ margin: 0 }}>
              Checking file size, temp disk, and engine…
            </div>
          ) : null}
          {preflight && preflight.size_mb > 0 && (
            <div className="hint" style={{ margin: "0 0 6px" }}>
              About {preflight.size_mb.toLocaleString()} MB on disk.
            </div>
          )}
          {preflight?.blockers.map((msg) => (
            <div
              key={msg}
              style={{ color: "#e07070", fontSize: 12.5, marginBottom: 4 }}
            >
              {msg}
            </div>
          ))}
          {preflight?.warnings.map((msg) => (
            <div
              key={msg}
              style={{ color: "#c98a2b", fontSize: 12.5, marginBottom: 4 }}
            >
              {msg}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <button
          data-testid="load-submit"
          className="btn primary"
          disabled={!path.trim() || !!preflight?.blockers?.length}
          onClick={go}
        >
          <Icon.Database size={15} /> Load
        </button>
        <button
          className="btn"
          onClick={() => setFolderBrowsing(true)}
          title="Load every CSV/JSON/Parquet file in a folder, each as its own table"
        >
          <Icon.Folder size={15} /> Load a folder…
        </button>
      </div>

      {browsing && (
        <FileBrowser
          initialPath={path.trim() || undefined}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            setPath(p);
            setBrowsing(false);
          }}
        />
      )}
      {folderBrowsing && (
        <FileBrowser
          pickFolder
          initialPath={path.trim() || undefined}
          onClose={() => setFolderBrowsing(false)}
          onPick={(dir) => {
            setFolderBrowsing(false);
            onBeginLoadFolder(dir, dest, delim.trim() || undefined);
          }}
        />
      )}
    </div>
  );
};
