import { describe, expect, it } from "vitest";
import {
  applyReplacement,
  findAcrossScopes,
  findMatches,
  nextMatchIndex,
  prevMatchIndex,
  replaceAll,
  replaceAllAcrossScopes,
  replaceNext,
} from "./findReplace";

describe("findMatches", () => {
  it("finds every occurrence, case-insensitively by default", () => {
    expect(findMatches("Select a from SELECT", "select")).toEqual([
      { start: 0, end: 6 },
      { start: 14, end: 20 },
    ]);
  });

  it("honours case sensitivity", () => {
    expect(
      findMatches("Select a from SELECT", "SELECT", { caseSensitive: true }),
    ).toEqual([{ start: 14, end: 20 }]);
  });

  it("matches whole words only when asked", () => {
    const text = "id, user_id, id2, id";
    expect(findMatches(text, "id", { wholeWord: true })).toEqual([
      { start: 0, end: 2 },
      { start: 18, end: 20 },
    ]);
  });

  it("treats underscores and digits as word characters", () => {
    // `id` inside `user_id` is not a standalone word.
    expect(findMatches("user_id", "id", { wholeWord: true })).toEqual([]);
  });

  it("supports regex mode", () => {
    expect(findMatches("a1 b22 c333", "\\d+", { regex: true })).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 11 },
    ]);
  });

  it("returns nothing for an empty query or an unparseable regex", () => {
    expect(findMatches("abc", "")).toEqual([]);
    // A half-typed pattern is a normal state, not an error.
    expect(findMatches("abc", "(unclosed", { regex: true })).toEqual([]);
  });

  it("does not hang on a zero-width regex match", () => {
    // `a*` matches empty at every position; the scan must still terminate.
    expect(findMatches("bbb", "a*", { regex: true })).toEqual([]);
    expect(findMatches("aab", "a*", { regex: true })).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  it("finds an overlapping whole-word match after rejecting a candidate", () => {
    // The first `id` (in `idid`) is not a whole word, but scanning must resume
    // one char later rather than past the whole rejected candidate.
    expect(findMatches("idid id", "id", { wholeWord: true })).toEqual([
      { start: 5, end: 7 },
    ]);
  });
});

describe("match navigation", () => {
  const matches = [
    { start: 0, end: 2 },
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];

  it("finds the next match at or after a caret", () => {
    expect(nextMatchIndex(matches, 0)).toBe(0);
    expect(nextMatchIndex(matches, 1)).toBe(1);
    expect(nextMatchIndex(matches, 20)).toBe(2);
  });

  it("wraps to the top past the last match", () => {
    expect(nextMatchIndex(matches, 21)).toBe(0);
  });

  it("finds the previous match and wraps to the bottom", () => {
    expect(prevMatchIndex(matches, 11)).toBe(1);
    expect(prevMatchIndex(matches, 0)).toBe(2);
  });

  it("reports -1 when there is nothing to navigate", () => {
    expect(nextMatchIndex([], 0)).toBe(-1);
    expect(prevMatchIndex([], 0)).toBe(-1);
  });
});

describe("replaceNext", () => {
  it("replaces the first match at or after the caret", () => {
    const r = replaceNext("foo bar foo", "foo", "baz", 0);
    expect(r.text).toBe("baz bar foo");
    expect(r.replaced).toBe(true);
  });

  it("resumes from the caret rather than the top", () => {
    const r = replaceNext("foo bar foo", "foo", "baz", 4);
    expect(r.text).toBe("foo bar baz");
  });

  it("wraps around when the caret is past the last match", () => {
    const r = replaceNext("foo bar", "foo", "baz", 99);
    expect(r.text).toBe("baz bar");
  });

  it("leaves the text alone when nothing matches", () => {
    const r = replaceNext("foo", "zzz", "x", 0);
    expect(r).toEqual({ text: "foo", replaced: false, cursor: 0 });
  });

  it("advances past the insertion instead of re-matching what it just wrote", () => {
    // "foo" -> "foofoo" would loop on the spot if the cursor stayed put; it
    // must land after the insertion so the next call moves on to the second
    // occurrence rather than re-expanding the first.
    const r = replaceNext("foo bar foo", "foo", "foofoo", 0);
    expect(r.text).toBe("foofoo bar foo");
    expect(r.cursor).toBe(6);
    const again = replaceNext(r.text, "foo", "foofoo", r.cursor);
    expect(again.text).toBe("foofoo bar foofoo");
  });

  it("wraps back to the top once the caret passes the last match", () => {
    // Wrapping is intentional (same as an editor's Replace button): after the
    // final occurrence, the next press comes back around to the first.
    const r = replaceNext("a b", "a", "X", 2);
    expect(r.text).toBe("X b");
  });
});

describe("replaceAll", () => {
  it("replaces every occurrence and counts them", () => {
    expect(replaceAll("a b a b a", "a", "X")).toEqual({
      text: "X b X b X",
      count: 3,
    });
  });

  it("is correct when the replacement is longer or shorter than the match", () => {
    // Back-to-front splicing keeps later offsets valid.
    expect(replaceAll("xx-xx-xx", "xx", "yyyy").text).toBe("yyyy-yyyy-yyyy");
    expect(replaceAll("xxx-xxx", "xxx", "z").text).toBe("z-z");
  });

  it("does not loop when the replacement contains the query", () => {
    expect(replaceAll("a", "a", "aa")).toEqual({ text: "aa", count: 1 });
  });

  it("respects whole-word mode", () => {
    expect(replaceAll("id user_id id", "id", "key", { wholeWord: true })).toEqual(
      { text: "key user_id key", count: 2 },
    );
  });

  it("reports zero when nothing matches", () => {
    expect(replaceAll("abc", "zzz", "x")).toEqual({ text: "abc", count: 0 });
  });
});

describe("applyReplacement", () => {
  it("splices over exactly the matched range", () => {
    expect(applyReplacement("hello world", { start: 6, end: 11 }, "there")).toBe(
      "hello there",
    );
  });
});

describe("multi-scope search (Journal cells)", () => {
  const scopes = [
    { id: "c1", text: "select id from t", field: "code" },
    { id: "c2", text: "note about id", field: "text" },
    { id: "c3", text: "nothing here", field: "code" },
  ];

  it("flattens matches across scopes in order, with ordinals", () => {
    const found = findAcrossScopes(scopes, "id");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ scopeId: "c1", field: "code", ordinal: 0 });
    expect(found[1]).toMatchObject({ scopeId: "c2", field: "text", ordinal: 1 });
  });

  it("returns only the scopes a replace-all actually changed", () => {
    const r = replaceAllAcrossScopes(scopes, "id", "key");
    expect(r.count).toBe(2);
    expect(r.edits.map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(r.edits[0]).toMatchObject({ field: "code", text: "select key from t" });
    expect(r.edits[1]).toMatchObject({ field: "text", text: "note about key" });
  });

  it("carries the field through so the caller writes back the right property", () => {
    const r = replaceAllAcrossScopes(scopes, "note", "memo");
    expect(r.edits).toEqual([
      { id: "c2", field: "text", text: "memo about id" },
    ]);
  });
});
