// A self-describing, explicitly versioned envelope for workflows written to
// disk via Save As. Kind payloads can evolve independently while the outer
// envelope remains recognisable and migratable.
import type { WorkflowKind } from "./types";
import { runMigrations } from "./migrations";

export const WF_FILE_VERSION = 2;
export const WF_PAYLOAD_VERSION = 1;

export interface WfEnvelope {
  samql: "workflow";
  version: number;
  payloadVersion: number;
  kind: WorkflowKind;
  name?: string;
  savedAt?: string;
  payload: any;
  migratedFrom?: number;
}

const ENVELOPE_MIGRATIONS = {
  0: (o: any) => ({ ...o, version: 1 }),
  1: (o: any) => ({
    ...o,
    version: 2,
    payloadVersion: Number.isInteger(o?.payloadVersion) ? o.payloadVersion : 1,
  }),
};

export function wfEnvelope(
  kind: WorkflowKind,
  name: string,
  payload: any,
): string {
  return JSON.stringify(
    {
      samql: "workflow",
      version: WF_FILE_VERSION,
      payloadVersion: WF_PAYLOAD_VERSION,
      kind,
      name,
      savedAt: new Date().toISOString(),
      payload,
    },
    null,
    2,
  );
}

export function parseWfFile(content: string): WfEnvelope | null {
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    return null; // raw SQL or a legacy notebook file
  }
  if (!raw || raw.samql !== "workflow") return null;
  if (!(["ide", "journal", "node"] as string[]).includes(raw.kind))
    throw new Error("This SamQL workflow has an unknown kind.");
  if (!("payload" in raw))
    throw new Error("This SamQL workflow is missing its payload.");
  const migrated = runMigrations<WfEnvelope>(
    raw,
    WF_FILE_VERSION,
    ENVELOPE_MIGRATIONS,
    "This SamQL workflow",
  );
  if (
    !Number.isInteger(migrated.value.payloadVersion) ||
    migrated.value.payloadVersion < 1
  )
    throw new Error("This SamQL workflow has an invalid payload version.");
  if (migrated.value.payloadVersion > WF_PAYLOAD_VERSION)
    throw new Error(
      `This workflow payload was created by a newer SamQL version (payload ${migrated.value.payloadVersion}; supported ${WF_PAYLOAD_VERSION}).`,
    );
  return {
    ...migrated.value,
    migratedFrom: migrated.migrated ? migrated.fromVersion : undefined,
  };
}

// a filesystem-friendly default file name for a workflow
export function wfFileName(name: string): string {
  const slug =
    (name || "workflow")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workflow";
  return slug + ".samql.json";
}
