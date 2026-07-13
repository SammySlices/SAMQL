// Lightweight SQL tokenizer used by the editor's highlight overlay, plus
// a statement splitter that mirrors the backend so we can resolve the
// "statement at cursor" instantly (the backend remains the source of
// truth on Run; this is for highlighting the active statement).

const KEYWORDS = new Set(
  (
    "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER ON USING " +
    "GROUP BY HAVING ORDER LIMIT OFFSET AS AND OR NOT NULL IS " +
    "IN BETWEEN LIKE GLOB ESCAPE INSERT UPDATE DELETE REPLACE " +
    "INTO VALUES SET CREATE DROP ALTER TABLE INDEX VIEW TRIGGER " +
    "IF EXISTS TEMP TEMPORARY DEFAULT PRIMARY KEY FOREIGN " +
    "REFERENCES UNIQUE CHECK CONSTRAINT AUTOINCREMENT " +
    "CASE WHEN THEN ELSE END DISTINCT UNION ALL EXCEPT INTERSECT " +
    "WITH RECURSIVE EXISTS CAST COLLATE PRAGMA BEGIN COMMIT " +
    "ROLLBACK TRANSACTION SAVEPOINT RELEASE EXPLAIN VACUUM ANALYZE " +
    "ASC DESC TRUE FALSE QUALIFY WINDOW PIVOT UNPIVOT SAMPLE USING"
  )
    .split(/\s+/)
    .map((s) => s.toUpperCase()),
);

const FUNCTIONS = new Set(
  (
    "COUNT SUM AVG MIN MAX TOTAL GROUP_CONCAT STRING_AGG ARRAY_AGG " +
    "COALESCE NULLIF IFNULL ABS ROUND TRIM SUBSTR SUBSTRING LENGTH " +
    "UPPER LOWER STRFTIME DATE TIME DATETIME JULIANDAY ROW_NUMBER " +
    "RANK DENSE_RANK NTILE LAG LEAD OVER PARTITION CONCAT REPLACE " +
    "CONVERT TRY_CAST DATEADD DATEDIFF GETDATE NOW EXTRACT FLOOR " +
    "CEIL CEILING POWER SQRT MOD REGEXP_REPLACE SPLIT_PART"
  )
    .split(/\s+/)
    .map((s) => s.toUpperCase()),
);

export type TokenKind =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "punct"
  | "ident"
  | "ws";

export interface Token {
  kind: TokenKind;
  text: string;
}

const IDENT_START = /[A-Za-z_\u00c0-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u00c0-\uffff]/;
const DIGIT = /[0-9]/;

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];

    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ kind: "ws", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // line comment
    if (c === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // block comment
    if (c === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // single-quoted string (SQL escapes '' inside)
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // double-quoted / bracket / backtick identifier
    if (c === '"' || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n && sql[j] !== q) j++;
      j = Math.min(n, j + 1);
      out.push({ kind: "ident", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      while (j < n && sql[j] !== "]") j++;
      j = Math.min(n, j + 1);
      out.push({ kind: "ident", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // number
    if (DIGIT.test(c) || (c === "." && DIGIT.test(sql[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9.eE+\-x_a-fA-F]/.test(sql[j])) {
        // stop a trailing +/- that isn't part of an exponent
        if (
          (sql[j] === "+" || sql[j] === "-") &&
          !/[eE]/.test(sql[j - 1])
        )
          break;
        j++;
      }
      out.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    // identifier / keyword / function
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      // a word directly followed by "(" is treated as a function call
      let k = j;
      while (k < n && /\s/.test(sql[k])) k++;
      const isCall = sql[k] === "(";
      let kind: TokenKind = "ident";
      if (KEYWORDS.has(upper)) kind = "keyword";
      else if (isCall || FUNCTIONS.has(upper)) kind = "function";
      out.push({ kind, text: word });
      i = j;
      continue;
    }

    // punctuation / operators
    out.push({ kind: "punct", text: c });
    i++;
  }
  return out;
}

// --- statement splitting (mirror of the backend's literal-aware split) ---
export interface Span {
  start: number;
  end: number;
}

export function statementSpans(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let start = 0;
  const n = text.length;
  const pushSpan = (e: number) => {
    // trim whitespace-only spans
    const seg = text.slice(start, e);
    if (seg.trim().length > 0) spans.push({ start, end: e });
  };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < n && text[i] !== q) i++;
      i++;
      continue;
    }
    if (c === "[") {
      i++;
      while (i < n && text[i] !== "]") i++;
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ";") {
      pushSpan(i + 1);
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  if (start < n) pushSpan(n);
  return spans;
}

export function statementAt(
  text: string,
  pos: number,
): Span | null {
  const spans = statementSpans(text);
  // a cursor in the GAP after a semicolon belongs to the statement just
  // finished (the PRECEDING span), not the next or the last one
  let prev: Span | null = null;
  for (const s of spans) {
    if (pos >= s.start && pos <= s.end) return s;
    if (s.end <= pos) prev = s;
  }
  return prev ?? (spans.length ? spans[0] : null);
}


// .538: Ctrl+/ line-comment toggle for the SQL editors (IDE + journal).
// Uncomments when EVERY non-blank line in the selection already starts
// with "--"; otherwise comments each non-blank line at its first
// non-whitespace column. Returns the new text plus a selection covering
// the affected lines, so repeated Ctrl+/ keeps toggling the same block.
export function toggleLineComment(
  text: string,
  selStart: number,
  selEnd: number,
): { text: string; selStart: number; selEnd: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, selStart - 1)) + 1;
  // when a selection ENDS at column 0 of a line, that line is excluded
  // (the standard editor rule) -- unless the selection is a bare caret
  let end = selEnd;
  if (end > selStart && end > 0 && text[end - 1] === "\n") end -= 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  const allCommented =
    nonBlank.length > 0 && nonBlank.every((l) => l.trimStart().startsWith("--"));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    const ws = l.length - l.trimStart().length;
    if (allCommented) {
      const body = l.slice(ws);
      const stripped = body.startsWith("-- ")
        ? body.slice(3)
        : body.slice(2);
      return l.slice(0, ws) + stripped;
    }
    return l.slice(0, ws) + "-- " + l.slice(ws);
  });
  const next = out.join("\n");
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + next.length,
  };
}
