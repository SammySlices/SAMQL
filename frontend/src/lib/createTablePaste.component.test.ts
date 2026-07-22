import { describe, expect, it } from "vitest";
import { parseCreateTablePaste } from "./createTablePaste";

describe("parseCreateTablePaste", () => {
  it("preserves the existing tab-separated spreadsheet format", () => {
    expect(parseCreateTablePaste("id\tname\r\n1\tAlice\r\n2\tBob")).toEqual({
      columns: ["id", "name"],
      rows: [
        ["1", "Alice"],
        ["2", "Bob"],
      ],
      delimiter: "\t",
    });
  });

  it("accepts comma-separated headers and rows", () => {
    expect(parseCreateTablePaste("id,name\n1,Alice\n2,Bob")).toEqual({
      columns: ["id", "name"],
      rows: [
        ["1", "Alice"],
        ["2", "Bob"],
      ],
      delimiter: ",",
    });
  });

  it("keeps quoted commas, escaped quotes, and quoted newlines in CSV cells", () => {
    expect(
      parseCreateTablePaste(
        'id,description\n1,"Smith, Alice"\n2,"Said ""hello"""\n3,"two\nlines"',
      ),
    ).toEqual({
      columns: ["id", "description"],
      rows: [
        ["1", "Smith, Alice"],
        ["2", 'Said "hello"'],
        ["3", "two\nlines"],
      ],
      delimiter: ",",
    });
  });

  it("prefers tabs for spreadsheet rows whose values contain commas", () => {
    expect(parseCreateTablePaste("id\tname\n1\tSmith, Alice")?.delimiter).toBe(
      "\t",
    );
    expect(parseCreateTablePaste("id\tname\n1\tSmith, Alice")?.rows).toEqual([
      ["1", "Smith, Alice"],
    ]);
  });

  it("returns null for ordinary single-cell text", () => {
    expect(parseCreateTablePaste("Alice")).toBeNull();
  });
});
