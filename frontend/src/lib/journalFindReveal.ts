/**
 * Select a find match inside one Journal cell's editor.
 *
 * The Journal renders one editor per cell, so rather than threading a
 * "selection" prop down to whichever of N cells owns the match, this walks to
 * the cell by its `data-cellid` and drives the textarea directly. Every cell
 * carries that attribute and SqlEditor is a plain textarea, so this stays
 * within the DOM contract both already publish.
 *
 * Returns true when a textarea was found and selected, so callers (and tests)
 * can tell a real reveal from a no-op.
 */
export function revealJournalMatch(
  cellId: string,
  start: number,
  end: number,
  root: ParentNode = document,
): boolean {
  const selector = `[data-cellid="${cssEscape(cellId)}"]`;
  const host = root.querySelector<HTMLElement>(selector);
  if (!host) return false;
  host.scrollIntoView?.({ block: "nearest" });
  const ta = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!ta) return false;
  ta.focus({ preventScroll: true });
  const len = ta.value.length;
  const from = Math.max(0, Math.min(start, len));
  const to = Math.max(from, Math.min(end, len));
  ta.setSelectionRange(from, to);
  return true;
}

/** `CSS.escape` with a fallback for environments that lack it. */
function cssEscape(value: string): string {
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS?.escape === "function") return g.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
