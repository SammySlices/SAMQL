// Shared id generator. The three surfaces each used to define their own `uid`,
// most of them random-only (which can collide on rapid successive calls). This
// one is collision-safe: a process-monotonic counter combined with the clock
// and randomness, so back-to-back ids never repeat. Ids stay opaque (used as
// React keys and backend query ids), so an optional prefix is purely cosmetic.

let _counter = 0;

export function uid(prefix = ""): string {
  _counter = (_counter + 1) >>> 0;
  return (
    prefix +
    Date.now().toString(36) +
    _counter.toString(36) +
    Math.random().toString(36).slice(2, 6)
  );
}
