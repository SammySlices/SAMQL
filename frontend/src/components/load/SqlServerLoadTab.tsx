import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { LoadResult } from "../../lib/types";
import { isCancelledError, registerRun, unregisterRun, cancelOne } from "../../lib/runController";
import { Icon } from "../Icon";
import {
  type SqlProfile,
  SQL_PROFILES_KEY,
  bestOdbcDriver,
  parseSqlProfiles,
  lastProfileName,
  sanitizeProfileName,
} from "../../lib/sqlProfiles";
import {
  MsSqlConnectForm,
  type MsSqlConnectValues,
  deleteMsSqlProfile,
  persistMsSqlProfile,
  sqlProfileToConnectValues,
} from "./MsSqlConnectForm";

const defaultConnect = (): MsSqlConnectValues => ({
  driver: "",
  server: "",
  port: "",
  auth: "windows",
  user: "",
  encrypt: true,
  trust: true,
  multi_subnet: false,
  login_timeout: "15",
  stmt_timeout: "0",
  read_only: true,
  save_password: false,
  profile_name: "",
  profile_sel: "(new)",
  secret_saved: false,
});

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
  const [connectVals, setConnectVals] = useState<MsSqlConnectValues>(defaultConnect);
  const [pwd, setPwd] = useState("");
  const [destination, setDestination] = useState(duck ? "auto" : "sqlite");

  const [profiles, setProfiles] = useState<Record<string, SqlProfile>>({});

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

  const patchConnect = (patch: Partial<MsSqlConnectValues>) => {
    setConnectVals((prev) => ({ ...prev, ...patch }));
  };

  const applyProfile = (p: SqlProfile, name: string, avail: string[]) => {
    const next = sqlProfileToConnectValues(p, name);
    if (next.driver && avail.length && !avail.includes(next.driver)) {
      next.driver = bestOdbcDriver(avail) || next.driver;
    }
    setConnectVals((prev) => ({ ...prev, ...next }));
    setPwd("");
  };

  const onSelectProfile = (name: string) => {
    if (name === "(new)") {
      patchConnect({ profile_sel: "(new)", profile_name: "" });
      return;
    }
    const p = profiles[name];
    if (p) applyProfile(p, name, drivers);
  };

  const saveProfile = async () => {
    const r = await persistMsSqlProfile(
      connectVals.profile_name || connectVals.profile_sel,
      connectVals,
      profiles,
      pwd,
    );
    if (!r.ok) {
      onError(r.error || "Could not save profile.");
      return;
    }
    setProfiles(r.profiles);
    const nm = sanitizeProfileName(
      connectVals.profile_name || connectVals.profile_sel,
    );
    patchConnect({
      profile_sel: nm,
      profile_name: nm,
      secret_saved: r.secretSaved,
    });
  };

  const deleteProfile = async () => {
    const next = await deleteMsSqlProfile(connectVals.profile_sel, profiles);
    setProfiles(next);
    setConnectVals(defaultConnect());
    setPwd("");
  };

  useEffect(() => {
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
        if (ds.length) {
          setConnectVals((prev) =>
            prev.driver ? prev : { ...prev, driver: bestOdbcDriver(ds) },
          );
        }
        try {
          const raw = localStorage.getItem(SQL_PROFILES_KEY);
          const profs = parseSqlProfiles(raw);
          setProfiles(profs);
          const last = lastProfileName(raw);
          if (last && profs[last]) {
            applyProfile(profs[last], last, ds);
          }
        } catch {
          /* ignore unreadable profile store */
        }
      })
      .catch(() => setAvailable(false));
  }, []);

  const profileForKey =
    connectVals.profile_sel !== "(new)"
      ? connectVals.profile_sel
      : sanitizeProfileName(connectVals.profile_name);
  const secretKey = profileForKey ? "mssql:" + profileForKey : "";

  const connect = async () => {
    if (!connectVals.server.trim()) {
      onError("Server is required.");
      return;
    }
    setBusy(true);
    try {
      const auth = connectVals.auth || "windows";
      const res = await api.mssqlConnect({
        name: connectVals.server.trim(),
        driver: connectVals.driver,
        server: connectVals.server.trim(),
        port: connectVals.port.trim(),
        auth,
        user: auth === "windows" ? "" : connectVals.user,
        pwd: auth === "windows" ? "" : pwd,
        secret_key: auth === "windows" ? undefined : secretKey || undefined,
        encrypt: connectVals.encrypt !== false,
        trust: connectVals.trust !== false,
        multi_subnet: !!connectVals.multi_subnet,
        login_timeout: Number(connectVals.login_timeout) || 15,
        stmt_timeout: Number(connectVals.stmt_timeout) || 0,
        read_only: connectVals.read_only !== false,
      });
      if (res.error || !res.ok) {
        onError(res.error || "Connection failed.");
        return;
      }
      if (
        auth !== "windows" &&
        connectVals.save_password &&
        pwd &&
        secretKey
      ) {
        try {
          await api.secretSet(secretKey, pwd);
          patchConnect({ secret_saved: true });
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
      <MsSqlConnectForm
        values={connectVals}
        onChange={patchConnect}
        drivers={drivers}
        profiles={profiles}
        secretsOk={secretsOk}
        pwd={pwd}
        onPwdChange={setPwd}
        onSaveProfile={saveProfile}
        onDeleteProfile={deleteProfile}
        onSelectProfile={onSelectProfile}
        variant="load"
        footer={
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy} onClick={connect}>
              {busy ? <span className="spin" /> : <Icon.Database size={15} />}{" "}
              Connect
            </button>
          </div>
        }
      />
    );
  }

  const readOnly = connectVals.read_only !== false;

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
