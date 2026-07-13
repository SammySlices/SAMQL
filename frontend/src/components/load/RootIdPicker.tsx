import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { RootIdChoice, RootIdCand } from "../../lib/api";

export const RootIdPicker: React.FC<{
  enabled: boolean;
  path?: string;
  file?: File | null;
  value: RootIdChoice | null;
  onChange: (v: RootIdChoice | null) => void;
}> = ({ enabled, path, file, value, onChange }) => {
  const [cands, setCands] = useState<RootIdCand[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setCands(null);
    setErr("");
    if (!enabled || (!path && !file)) return;
    let alive = true;
    setBusy(true);
    (async () => {
      try {
        const r = file
          ? await api.loadSniff({
              sample: file.slice(0, 512 * 1024),
              name: file.name,
            })
          : await api.loadSniff({ path });
        if (!alive) return;
        if (r.error) setErr(r.error);
        else setCands(r.candidates || []);
      } catch (e: any) {
        if (alive) setErr(e?.message || String(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, path, file]);
  if (!enabled) return null;
  const cur = (() => {
    if (!value || !cands) return "";
    const i = cands.findIndex(
      (c) =>
        JSON.stringify(c.steps) === JSON.stringify(value.steps) &&
        JSON.stringify(c.in_list || null) ===
          JSON.stringify(value.in_list || null) &&
        !!c.map === !!value.map,
    );
    if (i < 0) return "";
    return value.map ? `${i}::${value.map_key}` : String(i);
  })();
  const pick = (v: string) => {
    if (!v || !cands) {
      onChange(null);
      return;
    }
    const sep = v.indexOf("::");
    const idx = Number(sep >= 0 ? v.slice(0, sep) : v);
    const c = cands[idx];
    if (!c) {
      onChange(null);
      return;
    }
    if (c.map) {
      const key = v.slice(sep + 2);
      onChange({
        steps: c.steps,
        in_list: c.in_list || null,
        map: true,
        map_key: key,
        label: (c.label || "").replace("[<key>]", `['${key}']`),
      });
    } else {
      onChange({
        steps: c.steps,
        in_list: c.in_list || null,
        map: false,
        label: c.label,
      });
    }
  };
  return (
    <div className="form-row">
      <label title="Optional: a field that identifies each RECORD. It is carried onto every table in the family as root_id, and a Master_Keys table (the distinct, non-null identifier list) is created alongside. The load card reports whether the field was actually unique.">
        Unique identifier (optional)
        {busy && (
          <span
            className="spinner-sm"
            style={{ marginLeft: 8, verticalAlign: "middle" }}
            aria-label="scanning"
          />
        )}
      </label>
      {busy && (
        <div className="hint">Scanning the schema for identifier fields…</div>
      )}
      {err && <div className="hint">Identifier scan failed: {err}</div>}
      {!busy && !err && cands && cands.length === 0 && (
        <div className="hint">No identifier-shaped fields found.</div>
      )}
      {!busy && !err && cands && cands.length > 0 && (
        <select value={cur} onChange={(e) => pick(e.target.value)}>
          <option value="">— none —</option>
          {cands.map((c, i) =>
            c.map ? (
              c.keys && c.keys.length ? (
                c.keys.map((k) => (
                  <option key={`${i}::${k}`} value={`${i}::${k}`}>
                    {(c.label || "").replace("[<key>]", `['${k}']`)}
                  </option>
                ))
              ) : (
                <option key={`d${i}`} value="" disabled>
                  {c.label} — no keys found
                </option>
              )
            ) : (
              <option key={i} value={String(i)}>
                {c.label}
              </option>
            ),
          )}
        </select>
      )}
    </div>
  );
};
