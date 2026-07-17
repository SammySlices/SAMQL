import React, { useEffect, useState } from "react";
import { api, saveToDownloads } from "../lib/api";
import type { DiagnosticMeta, TableInfo } from "../lib/types";

// Error log -> Diagnostics tab. A generic front-end over /api/diagnostics: it
// lists whatever diagnostics the backend registers, renders each one's declared
// params (text / number / loaded-table picker), runs it, and shows the result.
// The JSON load profiler gets a purpose-built view; anything else falls back to
// a readable key/value + raw dump, so a future diagnostic needs no UI changes.

const feat = (v: unknown) => (v ? "\u2713" : "\u2717");
const featColor = (v: unknown) => (v ? "#2e8b57" : "#b04a4a");

const EnvStrip: React.FC<{ env: Record<string, any> }> = ({ env }) => {
  const features: Record<string, boolean> = env.features || {};
  return (
    <div
      style={{
        border: "1px solid var(--border, #ddd)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 12,
        marginBottom: 4,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 16px" }}>
        <span>
          <b>v{String(env.version)}</b> ({String(env.build)})
        </span>
        <span>Python {String(env.python)}</span>
        <span>{String(env.machine)}</span>
        {env.ram_gb != null && <span>{String(env.ram_gb)} GB RAM</span>}
        <span>JSON reader: {String(env.json_reader)}</span>
        {env.json_spill_rows != null && (
          <span>spill @ {String(env.json_spill_rows)} rows</span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 4 }}>
        {Object.keys(features).map((k) => (
          <span key={k} style={{ color: featColor(features[k]) }}>
            {feat(features[k])} {k}
          </span>
        ))}
      </div>
      {env.reader_note && (
        <div style={{ marginTop: 4, opacity: 0.8 }}>{String(env.reader_note)}</div>
      )}
    </div>
  );
};

const Row: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div style={{ display: "flex", gap: 8, fontSize: 12, padding: "1px 0" }}>
    <span style={{ minWidth: 150, opacity: 0.7 }}>{k}</span>
    <span style={{ fontFamily: "monospace" }}>{v}</span>
  </div>
);

const LoadResultView: React.FC<{ r: Record<string, any> }> = ({ r }) => {
  const w = r.write || {};
  const slower =
    r.reader === "ijson" &&
    r.read_stdlib_s > 0 &&
    r.read_prod_s / Math.max(r.read_stdlib_s, 1e-9) > 1.5;
  return (
    <div>
      <Row k="file" v={`${r.path} (${r.size_mb} MB)`} />
      <Row k="reader path" v={r.reader} />
      <Row
        k="sampled records"
        v={r.offset ? `${r.sampled} (after skipping ${r.offset})` : r.sampled}
      />
      <div style={{ height: 6 }} />
      <Row
        k="A) read (production)"
        v={`${r.read_prod_s}s · ${r.read_prod_n} recs`}
      />
      <Row
        k="   read (stdlib)"
        v={`${r.read_stdlib_s}s · ${r.read_stdlib_n} recs`}
      />
      {slower && (
        <div style={{ color: "#b04a4a", fontSize: 12, margin: "2px 0 2px 158px" }}>
          {r.hint || "ijson is slower here — try SAMQL_JSON_READER=stdlib"}
        </div>
      )}
      <Row k="B) read + flatten" v={`${r.flatten_s}s → ${r.total_rows} rows`} />
      <Row k="   flatten only" v={`${r.flatten_only_s}s`} />
      {w && w.seconds != null && (
        <>
          <Row
            k={`C) ${w.engine} write (cold)`}
            v={`${w.seconds}s · ${w.rows} rows`}
          />
          {w.warm_seconds != null && (
            <Row
              k={`   ${w.engine} write (warm)`}
              v={
                `${w.warm_seconds}s · ${w.rows} rows` +
                (w.warm_rows_per_s
                  ? ` · ~${Number(w.warm_rows_per_s).toLocaleString()} rows/sec`
                  : "")
              }
            />
          )}
          {w.fast != null && (
            <div
              style={{
                fontSize: 12,
                margin: "2px 0 2px 158px",
                opacity: 0.85,
                color: w.fast ? "#2e8b57" : "#b04a4a",
              }}
            >
              {w.fast
                ? "→ the write is fast" +
                  (w.warm_rows_per_s
                    ? ` (~${Number(w.warm_rows_per_s).toLocaleString()} rows/sec warm)`
                    : "") +
                  (w.cold_start
                    ? "; the cold number was one-time engine startup, which your live load reuses a warm engine to avoid"
                    : "") +
                  ". No write bottleneck."
                : `→ the write is genuinely slow even warm${
                    w.warm_rows_per_s
                      ? ` (~${Number(w.warm_rows_per_s).toLocaleString()} rows/sec)`
                      : ""
                  } — the profile below names the cost.`}
            </div>
          )}
        </>
      )}
      {w && w.error && (
        <Row k={`C) ${w.engine} write`} v={`FAILED: ${w.error}`} />
      )}
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        per-table write ({r.table_count} table
        {r.table_count === 1 ? "" : "s"})
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {(r.per_table || r.tables || []).map((t: any) => (
          <div
            key={t.name}
            style={{ color: t.error ? "#b04a4a" : undefined }}
          >
            {t.name} — {t.rows} rows, {t.cols} cols
            {t.error
              ? ` — WRITE FAILED: ${t.error}`
              : t.seconds != null
                ? ` — ${t.seconds}s${
                    t.rows_per_s
                      ? ` (~${Number(t.rows_per_s).toLocaleString()}/s)`
                      : ""
                  }`
                : ""}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        cProfile (read + flatten)
      </div>
      <pre
        style={{
          fontSize: 11,
          maxHeight: 220,
          overflow: "auto",
          background: "rgba(0,0,0,0.04)",
          padding: 8,
          borderRadius: 6,
          whiteSpace: "pre",
        }}
      >
        {r.profile}
      </pre>
      {w && w.profile && (
        <>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            cProfile (warm {w.engine} write)
          </div>
          <pre
            style={{
              fontSize: 11,
              maxHeight: 220,
              overflow: "auto",
              background: "rgba(0,0,0,0.04)",
              padding: 8,
              borderRadius: 6,
              whiteSpace: "pre",
            }}
          >
            {w.profile}
          </pre>
        </>
      )}
    </div>
  );
};

const bottleneckColor = (b: string) =>
  b && b !== "none" ? "#b04a4a" : "#2e8b57";

const FullAnalysisView: React.FC<{ r: Record<string, any> }> = ({ r }) => {
  const scan = r.scan || {};
  const rd = r.reader || {};
  const fl = r.flatten || {};
  const w = r.write || {};
  const proj = r.projection || {};
  const hv = r.heavy_record;
  const heavy = scan.heaviest || [];
  const perT = w.per_table || [];
  const errs = w.errors || [];
  return (
    <div>
      <div
        style={{
          border: `1px solid ${bottleneckColor(r.bottleneck)}`,
          borderRadius: 6,
          padding: "8px 10px",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            color: bottleneckColor(r.bottleneck),
            fontSize: 13,
          }}
        >
          Bottleneck: {r.bottleneck}
        </div>
        <div style={{ fontSize: 13, marginTop: 3 }}>{r.verdict}</div>
        {proj.est_total_human && (
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
            Projected full load: <b>{proj.est_total_human}</b> for ~
            {Number(proj.est_total_rows).toLocaleString()} rows (read ~
            {proj.est_read_s}s + write ~{proj.est_write_s}s)
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, opacity: 0.7 }}>file</div>
      <Row k="path" v={`${r.file?.path}`} />
      <Row k="size / reader" v={`${r.file?.size_mb} MB · ${r.file?.reader}`} />

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        whole-file scan
      </div>
      {scan.scan_error && (
        <div style={{ color: "#b04a4a", fontSize: 12 }}>
          scan error: {scan.scan_error}
        </div>
      )}
      {scan.complete === false && (
        <div style={{ color: "#b04a4a", fontSize: 12, marginBottom: 2 }}>
          scan hit the time budget — covered {scan.bytes_covered_mb} MB of{" "}
          {r.file?.size_mb} MB
          {scan.read_mbps ? ` (~${scan.read_mbps} MB/s)` : ""}; reading the whole
          file alone ≈{" "}
          {proj.est_read_s ? `${proj.est_read_s}s` : "unknown"}. Numbers below
          are extrapolated.
        </div>
      )}
      <Row
        k="records"
        v={
          `${Number(scan.records).toLocaleString()}${
            scan.complete === false ? "+" : ""
          } in ${scan.scan_s}s` +
          (scan.records_per_s
            ? ` (~${Number(scan.records_per_s).toLocaleString()}/s)`
            : "")
        }
      />
      {scan.read_mbps != null && (
        <Row k="read throughput" v={`~${scan.read_mbps} MB/s`} />
      )}
      <Row
        k="biggest array / depth"
        v={`${Number(scan.max_array_len).toLocaleString()} · depth ${scan.max_depth}`}
      />
      <Row
        k="projected total rows"
        v={Number(scan.est_total_rows).toLocaleString()}
      />
      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
        heaviest records
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {heavy.slice(0, 6).map((h: any) => (
          <div
            key={h.record_index}
            style={{ color: h.max_array_len >= 100000 ? "#b04a4a" : undefined }}
          >
            #{h.record_index} — array {Number(h.max_array_len).toLocaleString()},
            elements {Number(h.elements).toLocaleString()}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        read / flatten (sample {fl.sampled})
      </div>
      {rd.ratio && (
        <Row
          k="ijson vs stdlib"
          v={`${rd.ijson_s}s vs ${rd.stdlib_s}s (${rd.ratio}x)`}
        />
      )}
      <Row
        k="flatten"
        v={
          `${fl.rows} rows in ${fl.seconds}s` +
          (fl.rows_per_s
            ? ` (~${Number(fl.rows_per_s).toLocaleString()}/s)`
            : "") +
          ` · ${fl.table_count} tables, up to ${fl.max_cols} cols`
        }
      />

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        per-table write{w.engine ? ` (${w.engine})` : ""}
      </div>
      {w.cold_s != null && (
        <Row k="largest cold/warm" v={`${w.cold_s}s / ${w.warm_s}s`} />
      )}
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {perT.map((t: any) => (
          <div
            key={t.name}
            style={{ color: t.error ? "#b04a4a" : undefined }}
          >
            {t.name} — {t.rows} rows, {t.cols} cols
            {t.error
              ? ` — WRITE FAILED: ${t.error}`
              : t.seconds != null
                ? ` — ${t.seconds}s${
                    t.rows_per_s
                      ? ` (~${Number(t.rows_per_s).toLocaleString()}/s)`
                      : ""
                  }`
                : ""}
          </div>
        ))}
      </div>
      {errs.length > 0 && (
        <div style={{ color: "#b04a4a", fontSize: 12, marginTop: 4 }}>
          {errs.length} table(s) failed to write — the real load falls back to
          the slow nested path when this happens.
        </div>
      )}

      {hv && (
        <>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            heaviest record, flattened directly (#{hv.record_index})
          </div>
          {hv.error ? (
            <div style={{ color: "#b04a4a", fontSize: 12 }}>{hv.error}</div>
          ) : hv.skipped_flatten ? (
            <div style={{ color: "#b04a4a", fontSize: 12 }}>
              record #{hv.record_index} projects to ~
              {Number(hv.est_rows).toLocaleString()} rows (array{" "}
              {Number(hv.max_array_len).toLocaleString()}) — not flattened here
              to stay within the budget. This one record is the explosion.
            </div>
          ) : (
            <div style={{ fontFamily: "monospace", fontSize: 12 }}>
              {Number(hv.rows_produced).toLocaleString()} rows in {hv.flatten_s}s
              {hv.rows_per_s
                ? ` (~${Number(hv.rows_per_s).toLocaleString()}/s)`
                : ""}
              {(hv.tables || []).map((t: any) => (
                <div key={t.name}>
                  {t.name} — {t.rows} rows, {t.cols} cols
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const HeaviestResultView: React.FC<{ r: Record<string, any> }> = ({ r }) => {
  const heavy = r.heaviest || [];
  return (
    <div>
      <Row k="file" v={`${r.path} (${r.size_mb} MB)`} />
      <Row
        k="scanned"
        v={
          `${r.scanned} records in ${r.scan_s}s` +
          (r.records_per_s
            ? ` (~${Number(r.records_per_s).toLocaleString()}/s)`
            : "")
        }
      />
      <Row
        k="biggest nested array"
        v={Number(r.max_array_len).toLocaleString()}
      />
      {r.explosive && (
        <div style={{ color: "#b04a4a", fontSize: 12, margin: "4px 0" }}>
          → a record has a {Number(r.max_array_len).toLocaleString()}-element
          array; flattening it explodes into that many child rows in one step —
          which is what makes the load crawl while the byte progress sits still.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        heaviest records (by biggest nested array)
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {heavy.map((h: any) => (
          <div
            key={h.record_index}
            style={{
              color: h.max_array_len >= 100000 ? "#b04a4a" : undefined,
            }}
          >
            record #{h.record_index} — biggest array{" "}
            {Number(h.max_array_len).toLocaleString()}, total elements{" "}
            {Number(h.elements).toLocaleString()}
          </div>
        ))}
      </div>
    </div>
  );
};

const StructureView: React.FC<{ r: Record<string, any> }> = ({ r }) => {
  const columns = r.columns || [];
  const hints = r.hints || [];
  const ft = r.file_tree;
  const kindColor: Record<string, string> = {
    array: "#c98a2b",
    "array-scalar": "#c98a2b",
    struct: "#5b8def",
    map: "#8a6ad6",
    scalar: "",
  };
  const NodeRows = ({ nodes }: { nodes: any[] }) => (
    <div style={{ fontFamily: "monospace", fontSize: 12.5 }}>
      {(nodes || []).map((n: any, i: number) => (
        <div
          key={i}
          style={{
            paddingLeft: 8 + n.depth * 16,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={n.path || n.note || ""}
        >
          <span style={{ color: kindColor[n.kind] || undefined }}>
            {n.name}
          </span>
          <span style={{ opacity: 0.55 }}> : {n.type}</span>
          {(n.kind === "array" || n.kind === "array-scalar") && (
            <span style={{ color: "#c98a2b" }}> ⇗ array</span>
          )}
          {n.path && <span style={{ opacity: 0.5 }}> — {n.path}</span>}
          {n.note && !n.path && (
            <span style={{ opacity: 0.5, fontStyle: "italic" }}> — {n.note}</span>
          )}
        </div>
      ))}
    </div>
  );
  return (
    <div>
      {r.table && <Row k="table" v={`${r.table}`} />}
      {r.engine && (
        <Row
          k="engine / columns"
          v={`${r.engine} · ${r.column_count} column${
            r.column_count === 1 ? "" : "s"
          }${r.nested ? " · has nested fields" : " · flat"}`}
        />
      )}
      {r.engine && !r.nested && !ft && (
        <div style={{ fontSize: 12, opacity: 0.8, margin: "4px 0" }}>
          This table is flat — select any column directly.
        </div>
      )}
      {columns.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {columns.map((c: any) => (
            <div key={c.name} style={{ marginBottom: 10 }}>
              <NodeRows nodes={c.nodes} />
            </div>
          ))}
        </div>
      )}
      {ft && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 2 }}>
            fields sampled from the file — the ‘{ft.column}’ column holds the
            whole record{ft.access === "json" ? " as JSON" : ""}
          </div>
          {ft.complete === false && (
            <div style={{ color: "#c98a2b", fontSize: 11, marginBottom: 2 }}>
              sampled {Number(ft.sampled).toLocaleString()} records in {ft.scan_s}
              s (not the whole file — deeper fields may be missing)
            </div>
          )}
          <NodeRows nodes={ft.nodes} />
        </div>
      )}
      {hints.length > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ opacity: 0.7, marginBottom: 4 }}>how to query</div>
          {hints.map((h: string, i: number) => (
            <div key={i} style={{ marginBottom: 4 }}>
              {h}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const GenericResultView: React.FC<{ r: Record<string, any> }> = ({ r }) => {
  if (r && r.error) {
    return <div style={{ color: "#b04a4a", fontSize: 13 }}>{String(r.error)}</div>;
  }
  return (
    <div>
      {Object.keys(r || {}).map((k) => {
        const v = r[k];
        const disp =
          v && typeof v === "object" ? JSON.stringify(v) : String(v);
        return <Row key={k} k={k} v={disp} />;
      })}
    </div>
  );
};

/** Embeddable diagnostics UI (Error log → Diagnostics tab). */
export const DiagnosticsPanel: React.FC<{
  tables: TableInfo[];
}> = ({ tables }) => {
  const [metas, setMetas] = useState<DiagnosticMeta[]>([]);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [env, setEnv] = useState<Record<string, any> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const applyDefaults = (m?: DiagnosticMeta) => {
    const init: Record<string, string> = {};
    if (m) {
      for (const p of m.params) {
        if (p.default != null) init[p.name] = String(p.default);
      }
    }
    setParams(init);
  };

  useEffect(() => {
    api
      .diagnostics()
      .then((d) => {
        const list = d.diagnostics || [];
        setMetas(list);
        setEnv((d.environment as Record<string, any>) || null);
        const def = list.find((m) => m.name === "full_analysis") || list[0];
        if (def) {
          setSelected(def.name);
          applyDefaults(def);
        }
      })
      .catch((e) => setLoadErr(String(e?.message || e)));
  }, []);

  const meta = metas.find((m) => m.name === selected);
  const localTables = (tables || []).filter((t) => !t.remote);

  const pick = (name: string) => {
    setSelected(name);
    setResult(null);
    setErr(null);
    applyDefaults(metas.find((x) => x.name === name));
  };

  const run = () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    const payload: Record<string, unknown> = {};
    for (const p of meta?.params || []) {
      const v = params[p.name];
      if (v == null || v === "") continue;
      payload[p.name] = p.type === "int" ? Number(v) : v;
    }
    api
      .runDiagnostic(selected, payload)
      .then((r) => {
        if (r.ok) setResult((r.result as Record<string, any>) || {});
        else setErr(r.error || "Diagnostic failed");
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setRunning(false));
  };

  const exportResult = () => {
    const text = JSON.stringify(
      { env, diagnostic: selected, params, result },
      null,
      2,
    );
    saveToDownloads(`samql-diagnostic-${selected}-${Date.now()}.json`, {
      text,
    })
      .then((r) => setSavedPath(r.path))
      .catch((e: any) => setSavedPath("save failed: " + (e?.message || e)));
  };

  return (
    <div data-testid="diagnostics-panel">
      {env && <EnvStrip env={env} />}
      {loadErr && (
        <div style={{ color: "#b04a4a", fontSize: 13 }}>{loadErr}</div>
      )}

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 2 }}>Diagnostic</div>
        <select
          value={selected}
          onChange={(e) => pick(e.target.value)}
          style={{ width: "100%" }}
        >
          {metas.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </select>
        {meta && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            {meta.description}
          </div>
        )}
      </div>

      {meta && meta.params.length > 0 && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {meta.params.map((p) => (
            <div key={p.name}>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 2 }}>
                {p.label}
              </div>
              {p.type === "table" ? (
                <select
                  value={params[p.name] || ""}
                  onChange={(e) =>
                    setParams((q) => ({ ...q, [p.name]: e.target.value }))
                  }
                  style={{ width: "100%" }}
                >
                  <option value="">— none —</option>
                  {localTables.map((t) => (
                    <option key={t.engine + ":" + t.name} value={t.name}>
                      {t.name} ({t.engine})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={p.type === "int" ? "number" : "text"}
                  value={params[p.name] || ""}
                  onChange={(e) =>
                    setParams((q) => ({ ...q, [p.name]: e.target.value }))
                  }
                  placeholder={
                    p.type === "int" ? String(p.default ?? "") : "file path"
                  }
                  style={{ width: "100%" }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          disabled={running || !selected}
          onClick={run}
        >
          {running ? "Running…" : "Run"}
        </button>
        {result != null && (
          <button className="btn" onClick={exportResult}>
            Export JSON
          </button>
        )}
        {savedPath && (
          <span className="faint" style={{ fontSize: 11 }}>
            {savedPath}
          </span>
        )}
      </div>

      {err && (
        <div style={{ color: "#b04a4a", fontSize: 13, marginTop: 10 }}>{err}</div>
      )}

      {result != null && (
        <div style={{ marginTop: 12 }}>
          {selected === "full_analysis" ? (
            <FullAnalysisView r={result} />
          ) : selected === "json_load" ? (
            <LoadResultView r={result} />
          ) : selected === "json_heaviest" ? (
            <HeaviestResultView r={result} />
          ) : selected === "structure" ? (
            <StructureView r={result} />
          ) : (
            <GenericResultView r={result} />
          )}
        </div>
      )}
    </div>
  );
};
