// Saved REST API request profiles + query-string composition.
//
// Profiles persist the endpoint, query params, basic-auth username, JSON path,
// table name, and destination engine -- but NEVER the secret (password/token),
// matching the SQL Server tab. The component owns localStorage; these pure
// functions stay environment-free and unit-tested under node.

import {
  dumpNamedProfiles,
  parseNamedProfiles,
  readLastProfileName,
} from "./namedProfiles";

export interface ApiKV {
  key: string;
  value: string;
}

export interface ApiProfile {
  url: string;
  params: ApiKV[];
  user: string; // basic-auth username (the secret is re-entered, never saved)
  jsonPath: string;
  tableName: string;
  destination: string;
  savePassword: boolean; // opt-in: store the password encrypted (DPAPI)
}

export const API_PROFILES_KEY = "samql.api.profiles.v1";

// Compose a request URL from a base + key/value pairs, appended as a query
// string. Empty keys are skipped; both key and value are percent-encoded. If
// the base already has a query ("?..."), pairs are joined with "&".
export function buildApiUrl(base: string, params: ApiKV[]): string {
  const b = (base || "").trim();
  const pairs = (params || [])
    .filter((p) => (p.key || "").trim())
    .map(
      (p) =>
        encodeURIComponent((p.key || "").trim()) +
        "=" +
        encodeURIComponent(p.value ?? ""),
    );
  if (!pairs.length) return b;
  const sep = b.includes("?") ? "&" : "?";
  return b + sep + pairs.join("&");
}

function coerceKVs(o: any): ApiKV[] {
  if (!Array.isArray(o)) return [];
  const out: ApiKV[] = [];
  for (const kv of o) {
    if (kv && typeof kv === "object") {
      out.push({ key: String(kv.key ?? ""), value: String(kv.value ?? "") });
    }
  }
  return out;
}

function coerceProfile(o: unknown): ApiProfile | null {
  const value = o as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return {
    url: String(value.url || ""),
    params: coerceKVs(value.params),
    user: String(value.user || ""),
    jsonPath: String(value.jsonPath || ""),
    tableName: String(value.tableName || "api_data"),
    destination: String(value.destination || "auto"),
    savePassword: !!value.savePassword,
  };
}

export function parseApiProfiles(
  raw: string | null,
): Record<string, ApiProfile> {
  return parseNamedProfiles(raw, coerceProfile);
}

export function dumpApiProfiles(
  profiles: Record<string, ApiProfile>,
  lastProfile?: string,
): string {
  return dumpNamedProfiles(profiles, lastProfile);
}

export function lastApiProfileName(raw: string | null): string {
  return readLastProfileName(raw);
}
