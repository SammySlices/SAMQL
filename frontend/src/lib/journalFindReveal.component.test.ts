import { afterEach, describe, expect, it } from "vitest";
import { revealJournalMatch } from "./journalFindReveal";

function buildCells(cells: { id: string; code?: string }[]) {
  const root = document.createElement("div");
  for (const c of cells) {
    const host = document.createElement("div");
    host.setAttribute("data-cellid", c.id);
    if (c.code !== undefined) {
      const ta = document.createElement("textarea");
      ta.value = c.code;
      host.appendChild(ta);
    }
    root.appendChild(host);
  }
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("revealJournalMatch", () => {
  it("selects the range inside the matching cell's textarea", () => {
    buildCells([
      { id: "c1", code: "select id from t" },
      { id: "c2", code: "select name from u" },
    ]);

    expect(revealJournalMatch("c2", 7, 11)).toBe(true);

    const ta = document.querySelector<HTMLTextAreaElement>(
      '[data-cellid="c2"] textarea',
    )!;
    expect(ta.selectionStart).toBe(7);
    expect(ta.selectionEnd).toBe(11);
    expect(ta.value.slice(7, 11)).toBe("name");
    expect(document.activeElement).toBe(ta);
  });

  it("leaves other cells' selections alone", () => {
    buildCells([
      { id: "c1", code: "aaaa" },
      { id: "c2", code: "bbbb" },
    ]);
    revealJournalMatch("c2", 1, 3);

    const first = document.querySelector<HTMLTextAreaElement>(
      '[data-cellid="c1"] textarea',
    )!;
    const second = document.querySelector<HTMLTextAreaElement>(
      '[data-cellid="c2"] textarea',
    )!;
    // Only the matching cell gets the range, and only it takes focus.
    expect([second.selectionStart, second.selectionEnd]).toEqual([1, 3]);
    expect([first.selectionStart, first.selectionEnd]).not.toEqual([1, 3]);
    expect(document.activeElement).toBe(second);
  });

  it("clamps a range that runs past the end of the text", () => {
    buildCells([{ id: "c1", code: "short" }]);
    expect(revealJournalMatch("c1", 3, 999)).toBe(true);
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(ta.selectionStart).toBe(3);
    expect(ta.selectionEnd).toBe(5);
  });

  it("reports false for a cell that is not on screen", () => {
    buildCells([{ id: "c1", code: "x" }]);
    expect(revealJournalMatch("missing", 0, 1)).toBe(false);
  });

  it("reports false for a cell with no editor (a collapsed or note cell)", () => {
    buildCells([{ id: "c1" }]);
    expect(revealJournalMatch("c1", 0, 1)).toBe(false);
  });

  it("handles ids containing characters that are special in selectors", () => {
    // uid() ids are tame, but a quote would otherwise break the selector.
    buildCells([{ id: 'weird"id', code: "hello" }]);
    expect(revealJournalMatch('weird"id', 0, 5)).toBe(true);
  });
});
