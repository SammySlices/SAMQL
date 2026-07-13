// Shared persistence envelope for named connection/request profiles.
//
// Profile modules own their domain-specific coercion rules. This module owns
// the malformed-JSON handling, legacy bare-map support, blank-name filtering,
// last-profile marker, and stable serialization used by every profile kind.

export type ProfileCoercer<T> = (value: unknown) => T | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseNamedProfiles<T>(
  raw: string | null,
  coerce: ProfileCoercer<T>,
): Record<string, T> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const hasEnvelope = Object.prototype.hasOwnProperty.call(parsed, "profiles");
  const source = hasEnvelope
    ? isRecord(parsed.profiles)
      ? parsed.profiles
      : {}
    : parsed;
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!name.trim()) continue;
    const profile = coerce(value);
    if (profile != null) out[name] = profile;
  }
  return out;
}

export function dumpNamedProfiles<T>(
  profiles: Record<string, T>,
  lastProfile?: string,
): string {
  return JSON.stringify({ profiles, lastProfile: lastProfile || "" });
}

export function readLastProfileName(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.lastProfile === "string"
      ? parsed.lastProfile
      : "";
  } catch {
    return "";
  }
}
