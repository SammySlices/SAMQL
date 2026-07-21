export type CreateTablePaste = {
  columns: string[];
  rows: string[][];
  delimiter: "\t" | ",";
};

/** Count candidate delimiters in the first record, ignoring quoted text. */
function firstRecordDelimiters(text: string): { tabs: number; commas: number } {
  let tabs = 0;
  let commas = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted && char === "\t") {
      tabs++;
    } else if (!quoted && char === ",") {
      commas++;
    }
  }
  return { tabs, commas };
}

/** Parse RFC-4180-style CSV, including escaped quotes and quoted newlines. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  const pushRecord = () => {
    record.push(field);
    // Match the old paste behavior: ignore physically blank lines, but keep
    // delimiter-only rows such as `,,` because those are intentional cells.
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
    field = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length) pushRecord();
  return records;
}

function parseTsv(text: string): string[][] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.length)
    .map((line) => line.split("\t"));
}

/**
 * Parse data pasted into a Create Table node. Tabs win when both candidates
 * occur outside quotes, matching spreadsheet clipboard data whose cells may
 * legitimately contain commas. Returns null for ordinary single-cell text so
 * the browser can perform a normal textarea paste.
 */
export function parseCreateTablePaste(text: string): CreateTablePaste | null {
  if (!text) return null;
  const counts = firstRecordDelimiters(text);
  const delimiter = counts.tabs > 0 ? "\t" : counts.commas > 0 ? "," : null;
  if (!delimiter) return null;

  const records = delimiter === "\t" ? parseTsv(text) : parseCsv(text);
  if (!records.length) return null;
  const columns = records[0].map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim(),
  );
  const rows = records.slice(1);
  return { columns, rows, delimiter };
}
