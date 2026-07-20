import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyReplacement,
  compileQuery,
  findAcrossScopes,
  replaceAllAcrossScopes,
  type FindScope,
  type ScopedMatch,
} from "./findReplace";
import type { FindCriteria } from "../components/FindReplaceDialog";

export interface FindScopeEdit {
  id: string;
  field?: string;
  text: string;
}

interface Options {
  /**
   * The documents to search, read fresh on every search. A getter (rather than
   * an array prop) keeps the Journal's many cells off this hook's dependency
   * list and guarantees a replace always writes against current text.
   */
  getScopes: () => FindScope[];
  /** Write edited documents back to wherever they live. */
  applyEdits: (edits: FindScopeEdit[]) => void;
  /** Focus and select a match in its editor. */
  revealMatch?: (match: ScopedMatch) => void;
  /** Caret to start the first search from (IDE selection, say). */
  getCaret?: () => { scopeId?: string; offset: number } | null;
  enabled?: boolean;
}

const EMPTY: FindCriteria = {
  query: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/**
 * Ctrl+F / Ctrl+R find and replace, shared by the IDE and the Journal.
 *
 * The hook owns match state and navigation; the caller supplies the documents
 * and decides how an edit is written back and how a match is revealed. That
 * split is what lets one implementation serve a single SQL buffer and a list of
 * Journal cells.
 */
export function useFindReplace({
  getScopes,
  applyEdits,
  revealMatch,
  getCaret,
  enabled = true,
}: Options) {
  const [open, setOpen] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [criteria, setCriteria] = useState<FindCriteria>(EMPTY);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Bumped whenever the underlying documents change under us, to force a
  // re-search after a replace.
  const [revision, setRevision] = useState(0);

  const getScopesRef = useRef(getScopes);
  getScopesRef.current = getScopes;
  const applyEditsRef = useRef(applyEdits);
  applyEditsRef.current = applyEdits;
  const revealRef = useRef(revealMatch);
  revealRef.current = revealMatch;
  const caretRef = useRef(getCaret);
  caretRef.current = getCaret;

  const { query, replacement, caseSensitive, wholeWord, regex } = criteria;
  const findOpts = useMemo(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  const matches = useMemo(() => {
    if (!open || !query) return [] as ScopedMatch[];
    return findAcrossScopes(getScopesRef.current(), query, findOpts);
    // `revision` re-runs the search after the documents change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, findOpts, revision]);

  const invalidPattern = !!query && regex && compileQuery(query, findOpts) === null;

  // A new query restarts from the caret rather than from the top, so Ctrl+F on
  // a long script finds the occurrence you are looking at.
  useEffect(() => {
    if (!matches.length) {
      setActiveIndex(-1);
      return;
    }
    const caret = caretRef.current?.();
    if (!caret) {
      setActiveIndex(0);
      return;
    }
    const at = matches.findIndex(
      (m) =>
        (!caret.scopeId || m.scopeId === caret.scopeId) &&
        m.start >= caret.offset,
    );
    setActiveIndex(at >= 0 ? at : 0);
  }, [matches]);

  const reveal = useCallback((m: ScopedMatch | undefined) => {
    if (m) revealRef.current?.(m);
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (!matches.length) return;
      setActiveIndex((i) => {
        const base = i < 0 ? 0 : i;
        const next = (base + delta + matches.length) % matches.length;
        reveal(matches[next]);
        return next;
      });
    },
    [matches, reveal],
  );

  const onNext = useCallback(() => go(1), [go]);
  const onPrev = useCallback(() => go(-1), [go]);

  /** Replace the highlighted match only, then re-search in place. */
  const onReplaceNext = useCallback(() => {
    if (!matches.length) return;
    const idx = activeIndex < 0 ? 0 : activeIndex;
    const m = matches[idx];
    if (!m) return;
    const scope = getScopesRef.current().find(
      (s) => s.id === m.scopeId && s.field === m.field,
    );
    if (!scope) return;
    applyEditsRef.current([
      {
        id: scope.id,
        field: scope.field,
        text: applyReplacement(scope.text, m, replacement),
      },
    ]);
    // Stay on the same ordinal: after the splice that slot holds the following
    // occurrence, so repeated presses walk forward. Clamped on re-search.
    setRevision((r) => r + 1);
  }, [matches, activeIndex, replacement]);

  const onReplaceAll = useCallback(() => {
    if (!query) return;
    const { edits } = replaceAllAcrossScopes(
      getScopesRef.current(),
      query,
      replacement,
      findOpts,
    );
    if (!edits.length) return;
    applyEditsRef.current(edits);
    setRevision((r) => r + 1);
  }, [query, replacement, findOpts]);

  const onCriteriaChange = useCallback((c: FindCriteria) => {
    setCriteria(c);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const openWith = useCallback((withReplace: boolean) => {
    setReplaceMode(withReplace);
    setOpen(true);
    setRevision((r) => r + 1);
  }, []);

  // Ctrl+F / Ctrl+R. Registered in the capture phase so it beats the browser's
  // own find bar and reload binding, which are otherwise unpreventable once the
  // event reaches the default handler.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const k = event.key.toLowerCase();
      if (k !== "f" && k !== "r") return;
      // Ctrl+Shift+R stays the browser's hard reload.
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      openWith(k === "r");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, openWith]);

  return {
    open,
    replaceMode,
    matches,
    activeMatch: activeIndex >= 0 ? matches[activeIndex] : undefined,
    dialogProps: {
      open,
      replaceMode,
      matchCount: matches.length,
      activeIndex,
      invalidPattern,
      onCriteriaChange,
      onNext,
      onPrev,
      onReplaceNext,
      onReplaceAll,
      onToggleReplaceMode: setReplaceMode,
      onClose: close,
    },
  };
}
