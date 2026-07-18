/** Cached hint for Run-all concurrency (avoid await flowCacheInfo every run). */

let parallelHint: { value: boolean; at: number } | null = null;
const TTL_MS = 60_000;

export function clearRunAllParallelHint(): void {
  parallelHint = null;
}

/**
 * Return whether backend parallel NodeFlow workers are on. Cached briefly so
 * Run all does not pay a network RTT on every click. Cleared when Flow Cache
 * settings are saved.
 */
export async function getRunAllParallelNodeflows(
  fetchInfo: () => Promise<{ parallel_nodeflows?: boolean }>,
): Promise<boolean> {
  if (parallelHint && Date.now() - parallelHint.at < TTL_MS) {
    return parallelHint.value;
  }
  const info = await fetchInfo();
  parallelHint = {
    value: !!info.parallel_nodeflows,
    at: Date.now(),
  };
  return parallelHint.value;
}
