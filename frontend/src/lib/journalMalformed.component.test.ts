import { describe, expect, it } from "vitest";
import { parseNotebookFile, parseNotebookDocument } from "./notebook";

// Hostile / malformed journal documents must never crash the
// parser with an unexpected exception — either a clean human-readable Error or
// a sanitized cell list.
describe("journal malformed-data probe", () => {
  const hostile: Array<[string, string]> = [
    ["not json", "{not json at all"],
    ["json null", "null"],
    ["json number", "42"],
    ["json string", '"hello"'],
    ["empty array", "[]"],
    ["empty object", "{}"],
    ["cells not array", JSON.stringify({ format: "samql-notebook", version: 2, cells: 5 })],
    ["cells of primitives", JSON.stringify({ format: "samql-notebook", version: 2, cells: [1, "x", null, true] })],
    ["cell null type", JSON.stringify({ cells: [{ type: null }] })],
    ["cell unknown type", JSON.stringify({ cells: [{ type: "weird" }] })],
    ["sql cell no name/id", JSON.stringify({ cells: [{ type: "sql" }] })],
    ["sql cell numeric code", JSON.stringify({ cells: [{ type: "sql", code: 123 }] })],
    ["boxW NaN", JSON.stringify({ cells: [{ type: "sql", code: "x", boxW: Number.NaN, boxH: -5 }] })],
    ["recon is string", JSON.stringify({ cells: [{ type: "reconcile", recon: "oops" }] })],
    ["recon keys mixed", JSON.stringify({ cells: [{ type: "reconcile", recon: { keys: [1, "a", null], compare: "no", balance: 7 } }] })],
    ["group non-string", JSON.stringify({ cells: [{ type: "sql", code: "x", group: 99 }] })],
    ["deeply nested junk", JSON.stringify({ cells: [{ type: "note", text: { a: { b: [1, 2] } } }] })],
    ["huge cell count", JSON.stringify({ cells: Array.from({ length: 5000 }, (_, i) => ({ type: "note", text: "n" + i })) })],
  ];

  for (const [label, text] of hostile) {
    it(`survives: ${label}`, () => {
      let threw: unknown = null;
      let cells: unknown = null;
      try {
        cells = parseNotebookFile(text);
      } catch (e) {
        threw = e;
      }
      // Must be EITHER a clean Error OR a valid array — never a TypeError etc.
      if (threw !== null) {
        expect(threw).toBeInstanceOf(Error);
        // The intended errors are human-readable, not "cannot read properties".
        expect(String((threw as Error).message)).not.toMatch(
          /is not a function|cannot read propert|undefined is not|reading '/i,
        );
      } else {
        expect(Array.isArray(cells)).toBe(true);
      }
    });
  }

  it("also never crashes parseNotebookDocument on the same inputs", () => {
    for (const [, text] of hostile) {
      try {
        parseNotebookDocument(text);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});
