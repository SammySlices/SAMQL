// Named connection profiles backed by the server registry + DPAPI secrets.
// Workflows and NodeFlow nodes store only the profile key (mssql:Name / api:Name).

import { api } from "./api";

export type ConnectionProfileKind = "mssql" | "api";

export type ConnectionProfile = {
  key: string;
  kind: ConnectionProfileKind;
  name: string;
  fields: Record<string, unknown>;
  has_secret?: boolean;
};

export function profileKey(
  kind: ConnectionProfileKind,
  name: string,
): string {
  return `${kind}:${String(name || "").trim()}`;
}

export async function listConnectionProfiles(
  kind?: ConnectionProfileKind,
): Promise<ConnectionProfile[]> {
  const r = await api.connectionProfilesList();
  const all = (r.profiles || []) as ConnectionProfile[];
  if (!kind) return all;
  return all.filter((p) => p.kind === kind);
}

export async function upsertConnectionProfile(opts: {
  kind: ConnectionProfileKind;
  name: string;
  fields: Record<string, unknown>;
  password?: string;
}): Promise<ConnectionProfile> {
  const r = await api.connectionProfilesUpsert(opts);
  return (r.profile || {
    key: profileKey(opts.kind, opts.name),
    kind: opts.kind,
    name: opts.name,
    fields: opts.fields,
  }) as ConnectionProfile;
}

export async function deleteConnectionProfile(key: string): Promise<void> {
  await api.connectionProfilesDelete(key);
}
