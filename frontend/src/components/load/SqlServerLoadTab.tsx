import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { LoadResult } from "../../lib/types";
import { isCancelledError, registerRun, unregisterRun, cancelOne } from "../../lib/runController";
import { Icon } from "../Icon";
import {
  type SqlProfile,
  type SqlAuth,
  SQL_PROFILES_KEY,
  bestOdbcDriver,
  parseSqlProfiles,
  dumpSqlProfiles,
  lastProfileName,
  sanitizeProfileName,
} from "../../lib/sqlProfiles";

export const SqlServerLoadTab: React.FC<{
  busy: boolean;
  setBusy: (b: boolean) => void;
  onLoaded: (r: LoadResult, l: string) => void;
  onError: (m: string) => void;
  duck: boolean;
  secretsOk: boolean;
  cancelRef?: React.MutableRefObject<(() => void) | null>;
}> = ({ busy, setBusy, onLoaded, onError, duck, secretsOk, cancelRef }) => {
  const [drivers, setDrivers] = useState<string[]>([]);
  const [available, setAvailable] = useState(true);
  const [driver, setDriver] = useState("");
  const [server, setServer] = useState("");
  const [port, setPort] = useState("");
  const [auth, setAuth] = useState<SqlAuth>("windows");
  const [user, setUser] = useState("");
  const [pwd, setPwd] = useState("");
  const [savePass, setSavePass] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [trust, setTrust] = useState(true);
  const [multiSubnet, setMultiSubnet] = useState(false);
  const [loginTimeout, setLoginTimeout] = useState("15");
  const [stmtTimeout, setStmtTimeout] = useState("0");
  const [readOnly, setReadOnly] = useState(true);
  const [destination, setDestination] = useState(duck ? "auto" : "sqlite");

  const [profiles, setProfiles] = useState<Record<string, SqlProfile>>({});
  const [profileSel, setProfileSel] = useState("(new)");
  const [profileName, setProfileName] = useState("");

  const [conn, setConn] = useState<{
    name: string;
    spid?: number | null;
    databases: string[];
  } | null>(null);
  const [database, setDatabase] = useState("");
  const [tables, setTables] = useState<{ schema: string; name: string }[]>([]);
  const [listing, setListing] = useState(false);
  const [query, setQuery] = useState("");
  const [tableName, setTableName] = useState("sql_server_data");

  // A saved password is keyed by the profile name (only once it has one).
  const profileForKey =
    profileSel !== "(new)" ? profileSel : sanitizeProfileName(profileName);
  const secretKey = profileForKey ? "mssql:" + profileForKey : "";

  const applyProfile = (p: SqlProfile, avail: string[]) => {
    if (p.driver && avail.includes(p.driver)) setDriver(p.driver);
    setServer(p.server);
    setPort(p.port);
    setAuth(p.auth);
    setUser(p.user);
    setPwd(""); // password is re-entered (or pulled from the encrypted store)
    setSavePass(!!p.savePassword);
    setEncrypt(p.encrypt);
    setTrust(p.trust);
    setMultiSubnet(p.multiSubnet);
    setLoginTimeout(p.loginTimeout);
    setStmtTimeout(p.stmtTimeout);
    setReadOnly(p.readOnly);
  };

  const currentProfile = (): SqlProfile => ({
    driver,
    server: server.trim(),
    port: port.trim(),
    auth,
    user,
    encrypt,
    trust,
    multiSubnet,
    loginTimeout,
    stmtTimeout,
    readOnly,
    savePassword: savePass,
  });

  const persistProfiles = (
    next: Record<string, SqlProfile>,
    last?: string,
  ) => {
    setProfiles(next);
    try {
      localStorage.setItem(SQL_PROFILES_KEY, dumpSqlProfiles(next, last));
    } catch {
      /* storage may be unavailable */
    }
  };

  const onSelectProfile = (name: string) => {
    setProfileSel(name);
    if (name === "(new)") {
      setProfileName("");
      return;
    }
    const p = profiles[name];
    if (p) {
      applyProfile(p, drivers);
      setProfileName(name);
    }
  };

  const saveProfile = async () => {
    const nm = sanitizeProfileName(profileName || profileSel);
    if (!nm || nm === "(new)") {
      onError("Enter a profile name to save.");
      return;
    }
    const next = { ...profiles, [nm]: currentProfile() };
    persistProfiles(next, nm);
    setProfileSel(nm);
    setProfileName(nm);
    // Store the password encrypted when requested + typed; else clear it.
    const key = "mssql:" + nm;
    try {
      if (savePass && pwd) await api.secretSet(key, pwd);
      else await api.secretDelete(key);
    } catch {
      /* non-fatal: the profile still saved */
    }
    // Also persist as a first-class connection profile so NodeFlow / reconnect
    // can resolve fields + secret by key (mssql:Name).
    try {
      const p = currentProfile();
      await api.connectionProfilesUpsert({
        kind: "mssql",
        name: nm,
        fields: {
          driver: p.driver,
          server: p.server,
          port: p.port,
          auth: p.auth,
          user: p.user,
          encrypt: p.encrypt,
          trust: p.trust,
          multi_subnet: p.multiSubnet,
          login_timeout: p.loginTimeout,
          stmt_timeout: p.stmtTimeout,
          read_only: p.readOnly,
        },
        password: savePass && pwd ? pwd : undefined,
      });
    } catch {
      /* non-fatal */
    }
  };

  const deleteProfile = async () => {
    if (profileSel === "(new)" || !profiles[profileSel]) return;
    const key = "mssql:" + profileSel;
    const next = { ...profiles };
    delete next[profileSel];
    persistProfiles(next, "");
    setProfileSel("(new)");
    setProfileName("");
    try {
      await api.secretDelete(key);
    } catch {
      /* ignore */
    }
    try {
      await api.connectionProfilesDelete(key);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    // Saved profiles live in localStorage, not on the backend, so load them
    // up front -- independent of the pyodbc/driver probe -- so a saved profile
    // is never hidden just because pyodbc isn't detected on the server.
    try {
      setProfiles(parseSqlProfiles(localStorage.getItem(SQL_PROFILES_KEY)));
    } catch {
      /* ignore unreadable profile store */
    }
  }, []);

  useEffect(() => {
    api
      .mssqlDrivers()
      .then((r) => {
        setAvailable(r.available);
        const ds = r.drivers || [];
        setDrivers(ds);
        if (ds.length) setDriver(bestOdbcDriver(ds));
        try {
          const raw = localStorage.getItem(SQL_PROFILES_KEY);
          const profs = parseSqlProfiles(raw);
          setProfiles(profs);
          const last = lastProfileName(raw);
          if (last && profs[last]) {
            applyProfile(profs[last], ds);
            setProfileSel(last);
            setProfileName(last);
          }
        } catch {
          /* ignore unreadable profile store */
        }
      })
      .catch(() => setAvailable(false));
  }, []);

  const connect = async () => {
    if (!server.trim()) {
      onError("Server is required.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.mssqlConnect({
        name: server.trim(),
        driver,
        server: server.trim(),
        port: port.trim(),
        auth,
        user: auth === "windows" ? "" : user,
        pwd: auth === "windows" ? "" : pwd,
        secret_key: auth === "windows" ? undefined : secretKey || undefined,
        encrypt,
        trust,
        multi_subnet: multiSubnet,
        login_timeout: Number(loginTimeout) || 15,
        stmt_timeout: Number(stmtTimeout) || 0,
        read_only: readOnly,
      });
      if (res.error || !res.ok) {
        onError(res.error || "Connection failed.");
        return;
      }
      // Persist the password (encrypted) on a successful connect when asked.
      if (auth !== "windows" && savePass && pwd && secretKey) {
        try {
          await api.secretSet(secretKey, pwd);
        } catch {
          /* non-fatal */
        }
      }
      setConn({
        name: res.name,
        spid: res.spid,
        databases: res.databases || [],
      });
      setDatabase(res.databases?.[0] || "");
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!conn) return;
    try {
      await api.mssqlDisconnect(conn.name);
    } catch {
      /* ignore */
    }
    setConn(null);
    setTables([]);
    setQuery("");
  };

  const listTables = async () => {
    if (!conn) return;
    setListing(true);
    try {
      const r = await api.mssqlTables(conn.name, database || undefined);
      if (r.error) {
        onError(r.error);
        return;
      }
      setTables(r.tables || []);
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setListing(false);
    }
  };

  const pickTable = (v: string) => {
    if (!v) return;
    let schema = "";
    let name = v;
    try {
      [schema, name] = JSON.parse(v);
    } catch {
      /* leave as-is */
    }
    const qualified =
      (database ? `[${database}].` : "") +
      (schema ? `[${schema}].` : "") +
      `[${name}]`;
    setQuery(`SELECT TOP 100 * FROM ${qualified};`);
    setTableName(name);
  };

  const doLoadCatalog = async () => {
    if (!conn) return;
    setBusy(true);
    try {
      const r = await api.mssqlCatalog(conn.name, database || undefined);
      if (r.error || !r.ok) {
        onError(r.error || "Couldn't load the table catalog.");
        return;
      }
      onLoaded(
        {
          loaded: [
            { file: conn.name, tables: Array.from({ length: r.count || 0 }) },
          ],
        } as unknown as LoadResult,
        `${conn.name} (schema only)`,
      );
    } catch (e: any) {
      onError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!conn || !query.trim()) return;
    setBusy(true);
    const queryId =
      "mssqlimp_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
    const ctrl = new AbortController();
    registerRun(queryId, ctrl);
    if (cancelRef)
      cancelRef.current = () => {
        cancelOne(queryId, ctrl);
      };
    try {
      const res = await api.mssqlImport(
        {
          name: conn.name,
          query: query.trim(),
          base_name: tableName.trim() || "sql_server_data",
          destination,
        },
        queryId,
        ctrl.signal,
      );
      if ((res as any).cancelled) return;
      if (res.error || !res.ok) {
        onError(res.error || "Import failed.");
        return;
      }
      onLoaded(
        res as unknown as LoadResult,
        `${conn.name} \u2192 ${tableName.trim()}`,
      );
    } catch (e: any) {
      if (isCancelledError(e, queryId)) return;
      onError(e.message || String(e));
    } finally {
      unregisterRun(queryId, ctrl);
      if (cancelRef) cancelRef.current = null;
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <div className="hint" style={{ marginTop: 4 }}>
        <b>pyodbc is not installed on the backend.</b> SQL Server connectivity
        needs the optional <code>pyodbc</code> package and an ODBC driver (such
        as “ODBC Driver 18 for SQL Server”). Install it on the machine running
        SamQL, then reopen this window.
        {Object.keys(profiles).length > 0 && (
          <div style={{ marginTop: 8 }}>
            Your saved{" "}
            {Object.keys(profiles).length === 1 ? "profile is" : "profiles are"}{" "}
            safe and will load once pyodbc is detected:{" "}
            <b>{Object.keys(profiles).sort().join(", ")}</b>.
          </div>
        )}
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="mssql-connect-form">
        <div className="form-row mssql-profile-row">
          <label>Saved profile</label>
          <div className="mssql-profile-ctl">
            <select
              value={profileSel}
              onChange={(e) => onSelectProfile(e.target.value)}
            >
              <option value="(new)">(new)</option>
              {Object.keys(profiles)
                .sort()
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
            <input
              placeholder="Profile name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <button className="btn sm" type="button" onClick={saveProfile}>
              Save
            </button>
            <button
              className="btn sm ghost"
              type="button"
              disabled={profileSel === "(new)"}
              onClick={deleteProfile}
            >
              Delete
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-row">
            <label>ODBC driver</label>
            <select value={driver} onChange={(e) => setDriver(e.target.value)}>
              {drivers.length === 0 && <option value="">(none found)</option>}
              {drivers.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Authentication</label>
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value as SqlAuth)}
            >
              <option value="windows">Windows (Trusted)</option>
              <option value="windows_alt">
                Alternate Windows account (runas /netonly)
              </option>
              <option value="sql">SQL Login</option>
            </select>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-row">
            <label>Server / instance</label>
            <input
              placeholder="HOST\SQLEXPRESS or 10.0.0.5"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Port (optional)</label>
            <input
              placeholder="1433"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>
        {auth !== "windows" && (
          <>
            <div className="form-grid">
              <div className="form-row">
                <label>
                  {auth === "windows_alt" ? "Windows account" : "Username"}
                </label>
                <input
                  placeholder={
                    auth === "windows_alt" ? "DOMAIN\\user (e.g. tdbfg\\laurs72)" : ""
                  }
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Password</label>
                <input
                  type="password"
                  value={pwd}
                  placeholder={
                    secretKey && savePass && !pwd
                      ? "using saved password (encrypted)"
                      : ""
                  }
                  onChange={(e) => setPwd(e.target.value)}
                />
              </div>
            </div>
            <label
              className="save-pass"
              title={
                secretsOk
                  ? "Encrypt and store this password with Windows DPAPI (tied to your Windows login). Saved when you Save the profile or connect."
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
            {auth === "windows_alt" && (
              <div className="hint" style={{ marginTop: 2 }}>
                Connects with this domain account's network credentials via
                Windows <code>runas /netonly</code> impersonation (LogonUser).
                Requires <code>pywin32</code> on the machine running SamQL; the
                password is used only to open the connection and is never
                stored.
              </div>
            )}
            {auth === "sql" && user.includes("\\") && (
              <div className="hint mssql-credwarn" style={{ marginTop: 2 }}>
                “{user}” looks like a Windows account (<code>DOMAIN\user</code>).
                SQL Login sends it as a SQL Server login, which the server
                rejects (error 18456). For a domain account, switch
                Authentication to{" "}
                <b>Alternate Windows account (runas /netonly)</b>.
              </div>
            )}
          </>
        )}
        <div className="form-grid">
          <div className="form-row">
            <label>Login timeout (s)</label>
            <input
              value={loginTimeout}
              onChange={(e) => setLoginTimeout(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Statement timeout (s, 0 = none)</label>
            <input
              value={stmtTimeout}
              onChange={(e) => setStmtTimeout(e.target.value)}
            />
          </div>
        </div>
        <div className="mssql-toggles">
          <label>
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            Read-only (block writes)
          </label>
          <label>
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => setEncrypt(e.target.checked)}
            />
            Encrypt
          </label>
          <label>
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => setTrust(e.target.checked)}
            />
            Trust server cert
          </label>
          <label>
            <input
              type="checkbox"
              checked={multiSubnet}
              onChange={(e) => setMultiSubnet(e.target.checked)}
            />
            MultiSubnetFailover
          </label>
        </div>
        <div className="hint" style={{ marginTop: 12 }}>
          Connections are <b>read-only by default</b> — only SELECT/SET/USE
          batches are allowed; untick to permit writes. Statements are GO-aware
          and run serialized, and results stream to disk so large pulls stay
          memory-bounded. Credentials go to the local backend only. A password
          is stored only if you tick “Save password” — then it’s encrypted with
          Windows DPAPI (your Windows login); otherwise profiles keep just the
          connection settings.
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={connect}>
            {busy ? <span className="spin" /> : <Icon.Database size={15} />}{" "}
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mssql-conn-bar">
        <span className="mssql-dot" />
        Connected to <b>{conn.name}</b>
        {conn.spid ? <span className="mssql-spid">SPID {conn.spid}</span> : null}
        {readOnly ? <span className="mssql-ro">read-only</span> : null}
        <button className="btn sm ghost" onClick={disconnect}>
          Disconnect
        </button>
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="form-row">
          <label>Database</label>
          <select
            value={database}
            onChange={(e) => {
              setDatabase(e.target.value);
              setTables([]);
            }}
          >
            {conn.databases.length === 0 && <option value="">(default)</option>}
            {conn.databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Browse tables</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" disabled={listing} onClick={listTables}>
              {listing ? <span className="spin" /> : null} List
            </button>
            <select
              style={{ flex: 1 }}
              disabled={tables.length === 0}
              onChange={(e) => pickTable(e.target.value)}
              defaultValue=""
            >
              <option value="">
                {tables.length
                  ? `${tables.length} tables…`
                  : "— none loaded —"}
              </option>
              {tables.map((t) => (
                <option
                  key={`${t.schema}.${t.name}`}
                  value={JSON.stringify([t.schema, t.name])}
                >
                  {t.schema ? `${t.schema}.` : ""}
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="mssql-catalog-row">
        <button className="btn" disabled={busy} onClick={doLoadCatalog}>
          {busy ? <span className="spin" /> : null} Load all tables (schema
          only)
        </button>
        <span className="hint" style={{ margin: 0 }}>
          Lists every table and its columns in the panel — no rows are read.
          Query them in the editor and they run on SQL Server.
        </span>
      </div>
      <div className="mssql-or">or import a specific query result</div>
      <div className="form-row">
        <label>Query (optional)</label>
        <textarea
          className="mssql-query"
          rows={4}
          placeholder="SELECT TOP 100 * FROM [dbo].[Customers];"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>Import as table</label>
        <input value={tableName} onChange={(e) => setTableName(e.target.value)} />
      </div>
      {duck && (
        <div className="form-row">
          <label>Target engine</label>
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="auto">Auto — DuckDB (falls back to SQLite)</option>
            <option value="sqlite">SQLite</option>
          </select>
        </div>
      )}
      <div className="hint">
        Two ways to use a connection: load all tables (above) to browse names
        and columns and query them live on SQL Server, or run a query here to
        stream its result into a local table. With read-only on, non-SELECT
        statements are blocked.{" "}
        {duck
          ? "Imports go to DuckDB by default for faster analytics, falling back to SQLite if a value doesn’t fit a column’s type."
          : "Imports load into SQLite (DuckDB isn’t available on this backend)."}
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          disabled={busy || !query.trim()}
          onClick={doImport}
        >
          {busy ? <span className="spin" /> : <Icon.Database size={15} />} Import
        </button>
      </div>
    </div>
  );
};

// ---- HDFS (WebHDFS) connector tab ---------------------------------------
// Connect to a WebHDFS URL, navigate the directory tree, then scan a folder
// that holds the dated partitions. The scan regroups <date>/<feed>/<file>
// feed-first; loading pulls only the selected dates of each selected feed into
// <root>__<feed>__<file> tables (each with a typed partition_date column).
