/**
 * Nested field-tree discovery (Sidebar column expand + Field Explorer table
 * sample) shares DuckDB session work. Keep at most one in-flight discovery per
 * table so expands / FE open do not stack samples. Discovery-only — never mutates loads.
 *
 * Cancel mantra: supersede / collapse / Activity Stop must abort the fetch AND
 * interrupt the backend. Slots carry an optional query_id; abort uses cancelOne.
 */

import { cancelOne } from "./runController";

type Slot = { ctrl: AbortController; queryId: string | null };

const inflight = new Map<string, Slot>();

function tableKey(engine: string, table: string): string {
  return `${engine}\u0000${table}`;
}

function columnKey(engine: string, table: string, column: string): string {
  return `${tableKey(engine, table)}\u0000col\u0000${column}`;
}

function tableDiscoveryKey(engine: string, table: string): string {
  return `${tableKey(engine, table)}\u0000table`;
}

function abortKey(key: string): void {
  const prev = inflight.get(key);
  if (!prev) return;
  inflight.delete(key);
  if (prev.queryId) {
    // End-to-end: abort registered fetch + POST cancel_query.
    cancelOne(prev.queryId, prev.ctrl);
    return;
  }
  try {
    prev.ctrl.abort();
  } catch {
    /* ignore */
  }
}

function track(
  key: string,
  ctrl: AbortController,
  queryId: string | null,
): AbortController {
  abortKey(key);
  inflight.set(key, { ctrl, queryId });
  const onAbort = () => {
    if (inflight.get(key)?.ctrl === ctrl) inflight.delete(key);
  };
  ctrl.signal.addEventListener("abort", onAbort, { once: true });
  return ctrl;
}

/** Abort every in-flight nested discovery for one table (Sidebar + FE). */
export function abortFieldTreeDiscoveriesForTable(
  engine: string,
  table: string,
): void {
  const prefix = `${tableKey(engine, table)}\u0000`;
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix) || key === tableKey(engine, table)) {
      abortKey(key);
    }
  }
}

/** Start a Sidebar per-column field-tree fetch; aborts other in-flight discoveries for that table (no stacking). */
export function startColumnFieldsDiscovery(
  engine: string,
  table: string,
  column: string,
  queryId?: string | null,
): AbortController {
  abortFieldTreeDiscoveriesForTable(engine, table);
  return track(
    columnKey(engine, table, column),
    new AbortController(),
    queryId || null,
  );
}

export function abortColumnFieldsDiscovery(
  engine: string,
  table: string,
  column: string,
): void {
  abortKey(columnKey(engine, table, column));
}

/** Field Explorer table-wide sample; aborts competing Sidebar column discoveries for the same table. */
export function startTableFieldsDiscovery(
  engine: string,
  table: string,
  queryId?: string | null,
): AbortController {
  abortFieldTreeDiscoveriesForTable(engine, table);
  return track(
    tableDiscoveryKey(engine, table),
    new AbortController(),
    queryId || null,
  );
}

export function abortTableFieldsDiscovery(engine: string, table: string): void {
  abortKey(tableDiscoveryKey(engine, table));
}

/** Test helper — clear registry between cases (abort only; no cancelQuery). */
export function resetFieldTreeDiscoveryForTests(): void {
  for (const key of [...inflight.keys()]) {
    const slot = inflight.get(key);
    inflight.delete(key);
    try {
      slot?.ctrl.abort();
    } catch {
      /* ignore */
    }
  }
  inflight.clear();
}

export function fieldTreeDiscoveryInflightCountForTests(): number {
  return inflight.size;
}

/** Test helper — query id bound to a slot, if any. */
export function fieldTreeDiscoveryQueryIdForTests(
  engine: string,
  table: string,
  column?: string,
): string | null {
  const key =
    column != null
      ? columnKey(engine, table, column)
      : tableDiscoveryKey(engine, table);
  return inflight.get(key)?.queryId ?? null;
}
