/**
 * Client-side cache for NodeFlow inspector column probes.
 * Keys include graphSig so Select/rename/formula upstream changes miss the cache.
 */

export type ColumnsByPort = Record<string, string[]>;

const cache = new Map<string, ColumnsByPort>();

export function nodeflowColsCacheKey(
  graphSig: string,
  selId: string,
  kind: "canvas" | "group-child",
  fingerprint: string,
): string {
  return `${graphSig}\n${selId}\n${kind}\n${fingerprint}`;
}

export function fingerprintColumnReqs(
  reqs: { port: string; node: string; fromPort: string }[],
  extra = "",
): string {
  const body = reqs
    .map((r) => `${r.port}:${r.node}.${r.fromPort}`)
    .sort()
    .join("|");
  return extra ? `${body}#${extra}` : body;
}

export function getNodeflowColsCache(key: string): ColumnsByPort | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Return a shallow copy so callers cannot mutate the cache entry.
  const out: ColumnsByPort = {};
  for (const [port, cols] of Object.entries(hit)) out[port] = cols.slice();
  return out;
}

export function setNodeflowColsCache(key: string, cols: ColumnsByPort): void {
  const stored: ColumnsByPort = {};
  for (const [port, list] of Object.entries(cols)) stored[port] = list.slice();
  cache.set(key, stored);
  // Drop entries from older graph signatures so the map cannot grow forever.
  const sig = key.split("\n", 1)[0] ?? "";
  if (sig) {
    for (const k of [...cache.keys()]) {
      if (k !== key && !k.startsWith(`${sig}\n`)) cache.delete(k);
    }
  }
}

export function clearNodeflowColsCache(): void {
  cache.clear();
}

export function nodeflowColsCacheSizeForTests(): number {
  return cache.size;
}
