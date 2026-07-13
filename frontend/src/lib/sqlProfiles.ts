// Saved SQL Server connection profiles + ODBC-driver selection.
//
// Profiles persist every connection field EXCEPT the password (passwords are
// never written to disk by the web client; you re-enter it on connect). The
// pure functions here are unit-tested; the React component owns the
// localStorage read/write so this module stays environment-free and testable
// under node.

import {
  dumpNamedProfiles,
  parseNamedProfiles,
  readLastProfileName,
} from "./namedProfiles";

export type SqlAuth = "windows" | "sql" | "windows_alt";

export interface SqlProfile {
  driver: string;
  server: string;
  port: string;
  auth: SqlAuth;
  user: string;
  encrypt: boolean;
  trust: boolean;
  multiSubnet: boolean;
  loginTimeout: string;
  stmtTimeout: string;
  readOnly: boolean;
  savePassword: boolean; // opt-in: store the password encrypted (DPAPI)
}

export const SQL_PROFILES_KEY = "samql.sql.profiles.v1";

// Prefer the newest "ODBC Driver NN for SQL Server" (18 > 17 > 13 > 11), then
// any driver mentioning SQL Server, else the first. Mirrors the backend
// best_odbc_driver so the UI's default matches whatever is installed -- which
// varies machine to machine.
export function bestOdbcDriver(drivers: string[]): string {
  const list = (drivers || []).filter(Boolean);
  if (list.length === 0) return "";
  const rank = (d: string): number => {
    for (const i of [18, 17, 13, 11]) if (d.includes(String(i))) return i;
    return /sql server/i.test(d) ? 1 : 0;
  };
  return list.reduce((best, d) => (rank(d) > rank(best) ? d : best), list[0]);
}

const AUTHS: SqlAuth[] = ["windows", "sql", "windows_alt"];

function coerceProfile(o: unknown): SqlProfile | null {
  const value = o as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const authValue = value.auth;
  const auth: SqlAuth = AUTHS.includes(authValue as SqlAuth)
    ? (authValue as SqlAuth)
    : "windows";
  return {
    driver: String(value.driver || ""),
    server: String(value.server || ""),
    port: String(value.port || ""),
    auth,
    user: String(value.user || ""),
    encrypt: value.encrypt !== false,
    trust: value.trust !== false,
    multiSubnet: !!value.multiSubnet,
    loginTimeout: String(value.loginTimeout ?? "15"),
    stmtTimeout: String(value.stmtTimeout ?? "0"),
    readOnly: value.readOnly !== false,
    savePassword: !!value.savePassword,
  };
}

// Parse the persisted blob into a clean name->profile map, dropping anything
// malformed (a hand-edited or older store can't break the UI).
export function parseSqlProfiles(raw: string | null): Record<string, SqlProfile> {
  return parseNamedProfiles(raw, coerceProfile);
}

export function dumpSqlProfiles(
  profiles: Record<string, SqlProfile>,
  lastProfile?: string,
): string {
  return dumpNamedProfiles(profiles, lastProfile);
}

export function lastProfileName(raw: string | null): string {
  return readLastProfileName(raw);
}

// Trim a user-supplied profile name; empty -> "".
export function sanitizeProfileName(raw: string): string {
  return (raw || "").trim().slice(0, 80);
}
