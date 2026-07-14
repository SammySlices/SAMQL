import React from "react";
import { api } from "../../lib/api";
import {
  type SqlAuth,
  type SqlProfile,
  SQL_PROFILES_KEY,
  dumpSqlProfiles,
  sanitizeProfileName,
} from "../../lib/sqlProfiles";

/** Connection settings shared by Load Data → SQL Server and the NodeFlow node. */
export type MsSqlConnectValues = {
  driver: string;
  server: string;
  port: string;
  auth: SqlAuth;
  user: string;
  encrypt: boolean;
  trust: boolean;
  multi_subnet: boolean;
  login_timeout: string;
  stmt_timeout: string;
  read_only: boolean;
  save_password: boolean;
  profile_name: string;
  profile_sel: string;
  /** Present when a password is stored under mssql:Name (never the password itself). */
  secret_saved?: boolean;
};

export function sqlProfileToConnectValues(
  p: SqlProfile,
  name = "",
): Partial<MsSqlConnectValues> {
  return {
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
    save_password: !!p.savePassword,
    profile_name: name,
    profile_sel: name || "(new)",
    secret_saved: !!p.savePassword,
  };
}

export function connectValuesToSqlProfile(v: MsSqlConnectValues): SqlProfile {
  return {
    driver: v.driver,
    server: (v.server || "").trim(),
    port: (v.port || "").trim(),
    auth: v.auth || "windows",
    user: v.user || "",
    encrypt: v.encrypt !== false,
    trust: v.trust !== false,
    multiSubnet: !!v.multi_subnet,
    loginTimeout: String(v.login_timeout ?? "15"),
    stmtTimeout: String(v.stmt_timeout ?? "0"),
    readOnly: v.read_only !== false,
    savePassword: !!v.save_password,
  };
}

export function mssqlSecretKey(profileName: string): string {
  const nm = sanitizeProfileName(profileName);
  return nm ? "mssql:" + nm : "";
}

/** Dual-write localStorage + server registry + optional DPAPI secret. */
export async function persistMsSqlProfile(
  name: string,
  values: MsSqlConnectValues,
  profiles: Record<string, SqlProfile>,
  pwd: string,
): Promise<{
  ok: boolean;
  error?: string;
  profiles: Record<string, SqlProfile>;
  secretKey: string;
  secretSaved: boolean;
}> {
  const nm = sanitizeProfileName(name);
  if (!nm || nm === "(new)") {
    return {
      ok: false,
      error: "Enter a profile name to save.",
      profiles,
      secretKey: "",
      secretSaved: false,
    };
  }
  const profile = connectValuesToSqlProfile(values);
  const next = { ...profiles, [nm]: profile };
  try {
    localStorage.setItem(SQL_PROFILES_KEY, dumpSqlProfiles(next, nm));
  } catch {
    /* storage may be unavailable */
  }
  const key = "mssql:" + nm;
  let secretSaved = !!values.secret_saved && !!values.save_password;
  try {
    if (values.save_password && pwd) {
      await api.secretSet(key, pwd);
      secretSaved = true;
    } else if (!values.save_password) {
      await api.secretDelete(key);
      secretSaved = false;
    }
  } catch {
    /* non-fatal: the profile still saved */
  }
  try {
    await api.connectionProfilesUpsert({
      kind: "mssql",
      name: nm,
      fields: {
        driver: profile.driver,
        server: profile.server,
        port: profile.port,
        auth: profile.auth,
        user: profile.user,
        encrypt: profile.encrypt,
        trust: profile.trust,
        multi_subnet: profile.multiSubnet,
        login_timeout: profile.loginTimeout,
        stmt_timeout: profile.stmtTimeout,
        read_only: profile.readOnly,
      },
      password: values.save_password && pwd ? pwd : undefined,
    });
  } catch {
    /* non-fatal */
  }
  return { ok: true, profiles: next, secretKey: key, secretSaved };
}

export async function deleteMsSqlProfile(
  name: string,
  profiles: Record<string, SqlProfile>,
): Promise<Record<string, SqlProfile>> {
  if (!name || name === "(new)" || !profiles[name]) return profiles;
  const key = "mssql:" + name;
  const next = { ...profiles };
  delete next[name];
  try {
    localStorage.setItem(SQL_PROFILES_KEY, dumpSqlProfiles(next, ""));
  } catch {
    /* ignore */
  }
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
  return next;
}

type Props = {
  values: MsSqlConnectValues;
  onChange: (patch: Partial<MsSqlConnectValues>) => void;
  drivers: string[];
  profiles: Record<string, SqlProfile>;
  secretsOk: boolean;
  /** Password draft (never persisted in workflow / profile JSON). */
  pwd: string;
  onPwdChange: (pwd: string) => void;
  onSaveProfile: () => void | Promise<void>;
  onDeleteProfile: () => void | Promise<void>;
  onSelectProfile: (name: string) => void;
  /** Compact NodeFlow inspector styling vs Load modal form classes. */
  variant?: "load" | "node";
  footer?: React.ReactNode;
  testIdPrefix?: string;
};

export const MsSqlConnectForm: React.FC<Props> = ({
  values,
  onChange,
  drivers,
  profiles,
  secretsOk,
  pwd,
  onPwdChange,
  onSaveProfile,
  onDeleteProfile,
  onSelectProfile,
  variant = "load",
  footer,
  testIdPrefix = "mssql",
}) => {
  const profileSel = values.profile_sel || "(new)";
  const profileName = values.profile_name || "";
  const auth = values.auth || "windows";
  const profileForKey =
    profileSel !== "(new)" ? profileSel : sanitizeProfileName(profileName);
  const secretKey = profileForKey ? "mssql:" + profileForKey : "";
  const savePass = !!values.save_password;
  const hasStored = !!values.secret_saved || (savePass && !pwd && !!secretKey);

  const inp = variant === "node" ? "nb2-in" : undefined;
  const lbl = variant === "node" ? "nb2-lbl" : undefined;

  return (
    <div
      className={
        variant === "load" ? "mssql-connect-form" : "nb2-mssql-connect"
      }
      data-testid={`${testIdPrefix}-connect-form`}
    >
      <div className={variant === "load" ? "form-row mssql-profile-row" : undefined}>
        {variant === "node" ? (
          <label className={lbl}>Saved profile</label>
        ) : (
          <label>Saved profile</label>
        )}
        <div
          className={
            variant === "load" ? "mssql-profile-ctl" : "nb2-row2"
          }
          style={variant === "node" ? { flexWrap: "wrap", gap: 6 } : undefined}
        >
          <select
            className={inp}
            data-testid={`${testIdPrefix}-profile-select`}
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
            className={inp}
            data-testid={`${testIdPrefix}-profile-name`}
            placeholder="Profile name"
            value={profileName}
            onChange={(e) => onChange({ profile_name: e.target.value })}
          />
          <button
            className="btn sm"
            type="button"
            data-testid={`${testIdPrefix}-profile-save`}
            onClick={() => void onSaveProfile()}
          >
            Save
          </button>
          <button
            className="btn sm ghost"
            type="button"
            data-testid={`${testIdPrefix}-profile-delete`}
            disabled={profileSel === "(new)"}
            onClick={() => void onDeleteProfile()}
          >
            Delete
          </button>
        </div>
      </div>

      <div className={variant === "load" ? "form-grid" : undefined}>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>ODBC driver</label>
          ) : (
            <label>ODBC driver</label>
          )}
          <select
            className={inp}
            data-testid={`${testIdPrefix}-driver`}
            value={values.driver || ""}
            onChange={(e) => onChange({ driver: e.target.value })}
          >
            {drivers.length === 0 && <option value="">(none found)</option>}
            {drivers.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>Authentication</label>
          ) : (
            <label>Authentication</label>
          )}
          <select
            className={inp}
            data-testid={`${testIdPrefix}-auth`}
            value={auth}
            onChange={(e) => onChange({ auth: e.target.value as SqlAuth })}
          >
            <option value="windows">Windows (Trusted)</option>
            <option value="windows_alt">
              Alternate Windows account (runas /netonly)
            </option>
            <option value="sql">SQL Login</option>
          </select>
        </div>
      </div>

      <div className={variant === "load" ? "form-grid" : undefined}>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>Server / instance</label>
          ) : (
            <label>Server / instance</label>
          )}
          <input
            className={inp}
            data-testid={`${testIdPrefix}-server`}
            placeholder="HOST\SQLEXPRESS or 10.0.0.5"
            value={values.server || ""}
            onChange={(e) => onChange({ server: e.target.value })}
          />
        </div>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>Port (optional)</label>
          ) : (
            <label>Port (optional)</label>
          )}
          <input
            className={inp}
            data-testid={`${testIdPrefix}-port`}
            placeholder="1433"
            value={values.port || ""}
            onChange={(e) => onChange({ port: e.target.value })}
          />
        </div>
      </div>

      {auth !== "windows" && (
        <>
          <div className={variant === "load" ? "form-grid" : undefined}>
            <div className={variant === "load" ? "form-row" : undefined}>
              {variant === "node" ? (
                <label className={lbl}>
                  {auth === "windows_alt" ? "Windows account" : "Username"}
                </label>
              ) : (
                <label>
                  {auth === "windows_alt" ? "Windows account" : "Username"}
                </label>
              )}
              <input
                className={inp}
                data-testid={`${testIdPrefix}-user`}
                placeholder={
                  auth === "windows_alt"
                    ? "DOMAIN\\user (e.g. tdbfg\\laurs72)"
                    : ""
                }
                value={values.user || ""}
                onChange={(e) => onChange({ user: e.target.value })}
              />
            </div>
            <div className={variant === "load" ? "form-row" : undefined}>
              {variant === "node" ? (
                <label className={lbl}>Password</label>
              ) : (
                <label>Password</label>
              )}
              <input
                className={inp}
                data-testid={`${testIdPrefix}-password`}
                type="password"
                value={pwd}
                placeholder={
                  hasStored ? "using saved password (encrypted)" : ""
                }
                onChange={(e) => onPwdChange(e.target.value)}
              />
            </div>
          </div>
          <label
            className={variant === "load" ? "save-pass" : "nb2-check"}
            title={
              secretsOk
                ? "Encrypt and store this password with Windows DPAPI (tied to your Windows login). Saved when you Save the profile or connect."
                : "Encrypted password storage needs Windows (DPAPI) — unavailable here, so the password is re-entered each session."
            }
          >
            <input
              type="checkbox"
              data-testid={`${testIdPrefix}-save-password`}
              checked={savePass}
              disabled={!secretsOk}
              onChange={(e) => onChange({ save_password: e.target.checked })}
            />
            Save password (encrypted){secretsOk ? "" : " — Windows only"}
          </label>
          {auth === "windows_alt" && (
            <div className={variant === "node" ? "nb2-hint-sm" : "hint"} style={{ marginTop: 2 }}>
              Connects with this domain account&apos;s network credentials via
              Windows <code>runas /netonly</code> impersonation (LogonUser).
              Requires <code>pywin32</code> on the machine running SamQL. Tick
              Save password to reuse it for Dashboard / NodeFlow runs.
            </div>
          )}
          {auth === "sql" && (values.user || "").includes("\\") && (
            <div
              className={
                variant === "node"
                  ? "nb2-hint-sm mssql-credwarn"
                  : "hint mssql-credwarn"
              }
              style={{ marginTop: 2 }}
            >
              “{values.user}” looks like a Windows account (
              <code>DOMAIN\user</code>). SQL Login sends it as a SQL Server
              login, which the server rejects (error 18456). For a domain
              account, switch Authentication to{" "}
              <b>Alternate Windows account (runas /netonly)</b>.
            </div>
          )}
        </>
      )}

      <div className={variant === "load" ? "form-grid" : undefined}>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>Login timeout (s)</label>
          ) : (
            <label>Login timeout (s)</label>
          )}
          <input
            className={inp}
            data-testid={`${testIdPrefix}-login-timeout`}
            value={values.login_timeout ?? "15"}
            onChange={(e) => onChange({ login_timeout: e.target.value })}
          />
        </div>
        <div className={variant === "load" ? "form-row" : undefined}>
          {variant === "node" ? (
            <label className={lbl}>Statement timeout (s, 0 = none)</label>
          ) : (
            <label>Statement timeout (s, 0 = none)</label>
          )}
          <input
            className={inp}
            data-testid={`${testIdPrefix}-stmt-timeout`}
            value={values.stmt_timeout ?? "0"}
            onChange={(e) => onChange({ stmt_timeout: e.target.value })}
          />
        </div>
      </div>

      <div
        className={variant === "load" ? "mssql-toggles" : "nb2-mssql-toggles"}
        style={
          variant === "node"
            ? { display: "flex", flexWrap: "wrap", gap: "8px 14px", marginTop: 8 }
            : undefined
        }
      >
        <label>
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-read-only`}
            checked={values.read_only !== false}
            onChange={(e) => onChange({ read_only: e.target.checked })}
          />
          Read-only (block writes)
        </label>
        <label>
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-encrypt`}
            checked={values.encrypt !== false}
            onChange={(e) => onChange({ encrypt: e.target.checked })}
          />
          Encrypt
        </label>
        <label>
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-trust`}
            checked={values.trust !== false}
            onChange={(e) => onChange({ trust: e.target.checked })}
          />
          Trust server cert
        </label>
        <label>
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}-multi-subnet`}
            checked={!!values.multi_subnet}
            onChange={(e) => onChange({ multi_subnet: e.target.checked })}
          />
          MultiSubnetFailover
        </label>
      </div>

      <div
        className={variant === "node" ? "nb2-hint-sm" : "hint"}
        style={{ marginTop: 12 }}
      >
        Connections are <b>read-only by default</b> — only SELECT/SET/USE
        batches are allowed; untick to permit writes. A password is stored only
        if you tick “Save password” — then it’s encrypted with Windows DPAPI
        (your Windows login); otherwise profiles keep just the connection
        settings. Passwords are never saved in the workflow file.
      </div>

      {footer}
    </div>
  );
};
