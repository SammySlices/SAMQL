/**
 * Text search / replace used by the IDE and Journal find bars.
 *
 * Everything here is pure and offset-based: a match is a `[start, end)` slice of
 * the haystack, so callers can highlight it, select it in a textarea, or splice
 * a replacement in without re-deriving positions. The Journal searches many
 * cells, so it runs these per cell and tags the results with a cell id.
 */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Treat the query as a JS regular expression source. */
  regex?: boolean;
}

export interface FindMatch {
  start: number;
  end: number;
}

const WORD = /[A-Za-z0-9_]/;

/** A word boundary that also treats `_` and digits as word characters (SQL identifiers). */
function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !(before && WORD.test(before)) && !(after && WORD.test(after));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the query into a global RegExp, or null when it cannot match
 * anything (empty query, or a malformed pattern in regex mode).
 *
 * An invalid regex is a normal state while the user is still typing `(foo`, so
 * it returns null rather than throwing.
 */
export function compileQuery(
  query: string,
  opts: FindOptions = {},
): RegExp | null {
  if (!query) return null;
  const source = opts.regex ? query : escapeRegExp(query);
  const flags = opts.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * Every non-overlapping match of `query` in `text`, in document order.
 *
 * A zero-width match (`a*`, `^`) would spin the scan forever, so the cursor is
 * always advanced by at least one character.
 */
export function findMatches(
  text: string,
  query: string,
  opts: FindOptions = {},
): FindMatch[] {
  const re = compileQuery(query, opts);
  if (!re || !text) return [];
  const out: FindMatch[] = [];
  let m: RegExpExecArray | null;
  // A pathological pattern on a huge document should not lock the UI thread.
  const LIMIT = 100_000;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex = start + 1;
      continue;
    }
    if (!opts.wholeWord || isWordBoundary(text, start, end)) {
      out.push({ start, end });
      if (out.length >= LIMIT) break;
    } else {
      // Not a whole word: resume just past this candidate's start so an
      // overlapping valid match is still found.
      re.lastIndex = start + 1;
    }
  }
  return out;
}

/**
 * Index of the first match at or after `from`, wrapping to the top when there
 * is none. Returns -1 for an empty match list.
 */
export function nextMatchIndex(matches: FindMatch[], from: number): number {
  if (!matches.length) return -1;
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i].start >= from) return i;
  }
  return 0;
}

/**
 * Index of the last match starting strictly before `from`, wrapping to the
 * bottom. Returns -1 for an empty match list.
 */
export function prevMatchIndex(matches: FindMatch[], from: number): number {
  if (!matches.length) return -1;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].start < from) return i;
  }
  return matches.length - 1;
}

/** Splice `replacement` into `text` over one match. */
export function applyReplacement(
  text: string,
  match: FindMatch,
  replacement: string,
): string {
  return text.slice(0, match.start) + replacement + text.slice(match.end);
}

export interface ReplaceNextResult {
  text: string;
  /** True when a match was found and replaced. */
  replaced: boolean;
  /** Caret offset just past the inserted text, for chaining the next replace. */
  cursor: number;
}

/**
 * Replace the first match at or after `from` (wrapping once).
 *
 * `cursor` lands after the inserted text so repeated calls walk forward through
 * the document instead of re-replacing the text just written — which matters
 * when the replacement itself contains the query ("a" -> "aa").
 */
export function replaceNext(
  text: string,
  query: string,
  replacement: string,
  from: number,
  opts: FindOptions = {},
): ReplaceNextResult {
  const matches = findMatches(text, query, opts);
  const idx = nextMatchIndex(matches, from);
  if (idx < 0) return { text, replaced: false, cursor: from };
  const m = matches[idx];
  return {
    text: applyReplacement(text, m, replacement),
    replaced: true,
    cursor: m.start + replacement.length,
  };
}

export interface ReplaceAllResult {
  text: string;
  count: number;
}

/**
 * Replace every match in one pass.
 *
 * Built back-to-front so each splice cannot shift the offsets of the matches
 * still to be applied.
 */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions = {},
): ReplaceAllResult {
  const matches = findMatches(text, query, opts);
  if (!matches.length) return { text, count: 0 };
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    out = applyReplacement(out, matches[i], replacement);
  }
  return { text: out, count: matches.length };
}

/** One searchable document — a Journal cell, or the IDE's single buffer. */
export interface FindScope {
  id: string;
  text: string;
  /** Which field of the cell this text came from, so a replace writes it back. */
  field?: string;
  label?: string;
}

export interface ScopedMatch extends FindMatch {
  scopeId: string;
  field?: string;
  /** Position of this match within the flattened, document-ordered list. */
  ordinal: number;
}

/** Every match across an ordered list of documents, flattened in scope order. */
export function findAcrossScopes(
  scopes: FindScope[],
  query: string,
  opts: FindOptions = {},
): ScopedMatch[] {
  const out: ScopedMatch[] = [];
  for (const scope of scopes) {
    for (const m of findMatches(scope.text, query, opts)) {
      out.push({
        ...m,
        scopeId: scope.id,
        field: scope.field,
        ordinal: out.length,
      });
    }
  }
  return out;
}

/**
 * Replace every match in every scope, returning only the scopes that changed so
 * the caller can write back one batched state update.
 */
export function replaceAllAcrossScopes(
  scopes: FindScope[],
  query: string,
  replacement: string,
  opts: FindOptions = {},
): { edits: { id: string; field?: string; text: string }[]; count: number } {
  const edits: { id: string; field?: string; text: string }[] = [];
  let count = 0;
  for (const scope of scopes) {
    const r = replaceAll(scope.text, query, replacement, opts);
    if (r.count > 0) {
      edits.push({ id: scope.id, field: scope.field, text: r.text });
      count += r.count;
    }
  }
  return { edits, count };
}
