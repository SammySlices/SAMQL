export interface MigrationResult<T> {
  value: T;
  fromVersion: number;
  migrated: boolean;
}

export type Migration = (value: any) => any;

function cloneMigrationInput<T>(input: T, label: string): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(input);
    return JSON.parse(JSON.stringify(input)) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not serializable migration data: ${detail}`);
  }
}

/**
 * Run an explicit one-version-at-a-time JSON migration chain.
 *
 * Saved files are untrusted input. Each migration receives a clone so a failed
 * step cannot partially mutate the caller's recovery copy. Plans must contain
 * every required step, every step must return an object with exactly the next
 * integer version, and future data is rejected before any migration runs.
 */
export function runMigrations<T>(
  input: any,
  currentVersion: number,
  migrations: Record<number, Migration>,
  label: string,
): MigrationResult<T> {
  if (!Number.isInteger(currentVersion) || currentVersion < 0)
    throw new Error(`${label} has an invalid current migration version.`);

  const hasRawVersion =
    input != null &&
    (typeof input === "object" || typeof input === "function") &&
    Object.prototype.hasOwnProperty.call(input, "version");
  if (hasRawVersion && !Number.isInteger(input.version))
    throw new Error(`${label} has an invalid version.`);
  const rawVersion = hasRawVersion ? input.version : 0;
  if (rawVersion < 0) throw new Error(`${label} has an invalid version.`);
  if (rawVersion > currentVersion)
    throw new Error(
      `${label} was created by a newer SamQL version (file version ${rawVersion}; this build supports ${currentVersion}).`,
    );

  for (let version = rawVersion; version < currentVersion; version += 1) {
    if (typeof migrations[version] !== "function")
      throw new Error(
        `${label} migration plan is incomplete at version ${version}.`,
      );
  }

  let value = cloneMigrationInput(input, label);
  let version = rawVersion;
  while (version < currentVersion) {
    const migrate = migrations[version];
    let nextValue: any;
    try {
      nextValue = migrate(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} migration ${version} failed: ${detail}`);
    }
    if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue))
      throw new Error(`${label} migration output must be an object at version ${version}.`);

    const next = nextValue.version;
    if (!Number.isInteger(next))
      throw new Error(`${label} migration ${version} did not declare an integer version.`);
    if (next !== version + 1)
      throw new Error(
        `${label} migration ${version} must advance exactly one version (received ${next}).`,
      );

    value = nextValue;
    version = next;
  }
  if (version !== currentVersion)
    throw new Error(
      `${label} migration ended at version ${version}; expected ${currentVersion}.`,
    );
  return {
    value: value as T,
    fromVersion: rawVersion,
    migrated: rawVersion !== currentVersion,
  };
}

/** Keep one recovery copy before replacing a localStorage value during migration. */
export function backupLocalStorageValue(key: string, raw: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(`${key}.pre-migration-backup`, raw);
    window.localStorage.setItem(
      `${key}.pre-migration-backup-at`,
      new Date().toISOString(),
    );
  } catch {
    // Private browsing / quota errors must never block the application.
  }
}
