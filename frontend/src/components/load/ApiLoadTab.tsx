import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { LoadResult } from "../../lib/types";
import { isCancelledError } from "../../lib/runController";
import { sanitizeProfileName } from "../../lib/sqlProfiles";
import { Icon } from "../Icon";
import {
  type ApiKV,
  type ApiProfile,
  API_PROFILES_KEY,
  buildApiUrl,
  parseApiProfiles,
  dumpApiProfiles,
  lastApiProfileName,
} from "../../lib/apiProfiles";

export const ApiLoadTab: React.FC<{
  busy: boolean;
  setBusy: (b: boolean) => void;
  onLoaded: (r: LoadResult, l: string) => void;
  onError: (m: string) => void;
  duck: boolean;
  secretsOk: boolean;
  cancelRef?: React.MutableRefObject<(() => void) | null>;
}> = ({ busy, setBusy, onLoaded, onError, duck, secretsOk, cancelRef }) => {
  const [url, setUrl] = useState("");
  const [params, setParams] = useState<ApiKV[]>([]);
  const [name, setName] = useState("api_data");
  const [jsonPath, setJsonPath] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [destination, setDestination] = useState(duck ? "auto" : "sqlite");
  const [savePass, setSavePass] = useState(false);

  const [profiles, setProfiles] = useState<Record<string, ApiProfile>>({});
  const [profileSel, setProfileSel] = useState("(new)");
  const [profileName, setProfileName] = useState("");

  const [sample, setSample] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    count: number;
    shown: number;
    truncated: boolean;
  } | null>(null);

  const composedUrl = buildApiUrl(url, params);
  // A saved password is keyed by the profile name (only meaningful once named).
  const profileForKey =
    profileSel !== "(new)" ? profileSel : sanitizeProfileName(profileName);
  const secretKey = profileForKey ? "api:" + profileForKey : "";

  const applyProfile = (p: ApiProfile) => {
    setUrl(p.url);
    setParams(p.params || []);
    setUser(p.user);
    setPass(""); // the secret is re-entered, never restored
    setJsonPath(p.jsonPath);
    setName(p.tableName || "api_data");
    setDestination(p.destination || (duck ? "auto" : "sqlite"));
    setSavePass(!!p.savePassword);
    setSample(null);
    setMeta(null);
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(API_PROFILES_KEY);
      const parsed = parseApiProfiles(raw);
      setProfiles(parsed);
      const last = lastApiProfileName(raw);
      if (last && parsed[last]) {
        setProfileSel(last);
        setProfileName(last);
        applyProfile(parsed[last]);
      }
    } catch {
      /* storage may be unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setParam = (i: number, patch: Partial<ApiKV>) =>
    setParams((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addParam = () => setParams((ps) => [...ps, { key: "", value: "" }]);
  const removeParam = (i: number) =>
    setParams((ps) => ps.filter((_, j) => j !== i));

  const currentProfile = (): ApiProfile => ({
    url: url.trim(),
    params: params.filter((p) => p.key.trim()),
    user,
    jsonPath: jsonPath.trim(),
    tableName: name.trim() || "api_data",
    destination,
    savePassword: savePass,
  });

  const persistProfiles = (
    next: Record<string, ApiProfile>,
    last?: string,
  ) => {
    setProfiles(next);
    try {
      localStorage.setItem(API_PROFILES_KEY, dumpApiProfiles(next, last));
    } catch {
      /* storage may be unavailable */
    }
  };

  const onSelectProfile = (nm: string) => {
    setProfileSel(nm);
    if (nm === "(new)") {
      setProfileName("");
      return;
    }
    const p = profiles[nm];
    if (p) {
      applyProfile(p);
      setProfileName(nm);
    }
  };

  const saveProfile = async () => {
    const nm = sanitizeProfileName(
      profileName || (profileSel !== "(new)" ? profileSel : ""),
    );
    if (!nm) {
      onError("Enter a profile name to save.");
      return;
    }
    const next = { ...profiles, [nm]: currentProfile() };
    persistProfiles(next, nm);
    setProfileSel(nm);
    setProfileName(nm);
    // Sync the encrypted secret: store it when "save password" is on and a
    // password is typed; otherwise clear any previously saved secret.
    const key = "api:" + nm;
    try {
      if (savePass && pass) await api.secretSet(key, pass);
      else await api.secretDelete(key);
    } catch {
      /* non-fatal: the profile still saved */
    }
  };

  const deleteProfile = async () => {
    if (profileSel === "(new)" || !profiles[profileSel]) return;
    const key = "api:" + profileSel;
    const next = { ...profiles };
    delete next[profileSel];
    persistProfiles(next);
    setProfileSel("(new)");
    setProfileName("");
    try {
      await api.secretDelete(key);
    } catch {
      /* ignore */
    }
  };

  const doFetch = async () => {
    if (!url.trim()) {
      onError("Enter an endpoint URL.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.apiPreview({
        url: composedUrl,
        auth_user: user || undefined,
        auth_pass: pass || undefined,
        json_path: jsonPath.trim() || undefined,
        secret_key: secretKey || undefined,
      });
      if (!r.ok) {
        onError(r.error || "Fetch failed.");
        setSample(null);
        setMeta(null);
        return;
      }
      setSample(r.sample || "");
      setMeta({
        count: r.count ?? 0,
        shown: r.shown ?? 0,
        truncated: !!r.truncated,
      });
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const doLoad = async () => {
    if (!url.trim()) {
      onError("Enter an endpoint URL.");
      return;
    }
    setBusy(true);
    const queryId =
      "apifetch_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
    const ctrl = new AbortController();
    if (cancelRef)
      cancelRef.current = () => {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
        void api.cancelQuery(queryId).catch(() => {});
      };
    try {
      const res = await api.apiFetch(
        {
          url: composedUrl,
          base_name: name.trim() || "api_data",
          json_path: jsonPath.trim() || undefined,
          auth_user: user || undefined,
          auth_pass: pass || undefined,
          destination,
          secret_key: secretKey || undefined,
        },
        queryId,
        ctrl.signal,
      );
      if ((res as any).cancelled) return;
      if ((res as any).error) {
        onError((res as any).error);
        return;
      }
      // Persist the password (encrypted) when requested and one was typed.
      if (savePass && pass && secretKey) {
        try {
          await api.secretSet(secretKey, pass);
        } catch {
          /* non-fatal */
        }
      }
      onLoaded(res as unknown as LoadResult, composedUrl);
    } catch (e: any) {
      if (isCancelledError(e)) return;
      onError(e.message || String(e));
    } finally {
      if (cancelRef) cancelRef.current = null;
      setBusy(false);
    }
  };

  const profileNames = Object.keys(profiles).sort();

  return (
    <div className="api-tab">
      <div className="api-left">
        <div className="form-row">
          <label>Profile</label>
          <div className="api-prof-row">
            <select
              value={profileSel}
              onChange={(e) => onSelectProfile(e.target.value)}
            >
              <option value="(new)">(new)</option>
              {profileNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              placeholder="name to save"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <button
              className="btn sm"
              onClick={saveProfile}
              title="Save profile (settings only — no secret)"
            >
              <Icon.Save size={13} />
            </button>
            <button
              className="btn sm"
              onClick={deleteProfile}
              disabled={profileSel === "(new)"}
              title="Delete profile"
            >
              <Icon.Trash size={13} />
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>Endpoint URL</label>
          <input
            placeholder="https://api.example.com/v1/records"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>Query parameters</label>
          <div className="api-kv">
            {params.length === 0 && (
              <div className="hint" style={{ margin: 0 }}>
                No parameters. Add key/value pairs to append to the URL.
              </div>
            )}
            {params.map((p, i) => (
              <div className="api-kv-row" key={i}>
                <input
                  placeholder="key"
                  value={p.key}
                  onChange={(e) => setParam(i, { key: e.target.value })}
                />
                <input
                  placeholder="value"
                  value={p.value}
                  onChange={(e) => setParam(i, { value: e.target.value })}
                />
                <button
                  className="btn sm icon xbtn"
                  onClick={() => removeParam(i)}
                  title="Remove parameter"
                >
                  <Icon.X size={12} />
                </button>
              </div>
            ))}
            <button className="btn sm" onClick={addParam}>
              <Icon.Plus size={12} /> Add parameter
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>Composed URL</label>
          <div className="api-url-preview mono" title={composedUrl}>
            {composedUrl || "—"}
          </div>
        </div>

        <div className="form-grid">
          <div className="form-row">
            <label>Table name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label>JSON path (optional)</label>
            <input
              placeholder="data.items"
              value={jsonPath}
              onChange={(e) => setJsonPath(e.target.value)}
            />
          </div>
        </div>

        <div className="form-grid">
          <div className="form-row">
            <label>Basic auth user (optional)</label>
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Basic auth password (optional)</label>
            <input
              type="password"
              value={pass}
              placeholder={
                secretKey && savePass && !pass
                  ? "using saved password (encrypted)"
                  : "re-enter each session"
              }
              onChange={(e) => setPass(e.target.value)}
            />
          </div>
        </div>

        <label
          className="save-pass"
          title={
            secretsOk
              ? "Encrypt and store this password with Windows DPAPI (tied to your Windows login). Saved when you Save the profile."
              : "Encrypted password storage needs Windows (DPAPI) — unavailable here, so the password is re-entered each session."
          }
        >
          <input
            type="checkbox"
            checked={savePass}
            disabled={!secretsOk}
            onChange={(e) => setSavePass(e.target.checked)}
          />
          Save password (encrypted){secretsOk ? "" : " — Windows only"}
        </label>

        <div className="form-row">
          <label>Load into</label>
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="auto">Auto — DuckDB</option>
            <option value="duckdb">DuckDB</option>
            <option value="sqlite">SQLite</option>
          </select>
          <div className="hint" style={{ margin: "4px 0 0" }}>
            DuckDB ingests the JSON natively (nested types, one table); SQLite
            flattens it into related tables.
          </div>
        </div>

        <div className="api-actions">
          <button className="btn" disabled={busy} onClick={doFetch}>
            {busy ? <span className="spin" /> : <Icon.Globe size={15} />} Fetch
          </button>
          <button className="btn primary" disabled={busy} onClick={doLoad}>
            <Icon.Database size={15} /> Load
          </button>
        </div>
        <div className="hint">
          Profiles keep the URL, parameters, and username. The password is only
          stored if you tick “Save password” — then it’s encrypted with Windows
          DPAPI (your Windows login). Otherwise it’s re-entered each session.
        </div>
      </div>

      <div className="api-right">
        <div className="api-right-head">
          <span>Sample</span>
          {meta && (
            <span className="api-right-meta">
              {meta.shown} of {meta.count} record{meta.count === 1 ? "" : "s"}
              {meta.truncated ? " · truncated" : ""}
            </span>
          )}
        </div>
        <pre className="api-sample">
          {sample == null
            ? "Click Fetch to preview the JSON response."
            : sample || "(empty)"}
        </pre>
      </div>
    </div>
  );
};
