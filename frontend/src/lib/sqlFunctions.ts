// Catalog of DuckDB SQL snippets offered by the query IDE's right-click
// "SQL functions" submenu, plus the helper that splices a chosen snippet in at
// the caret. Kept dependency-free so it can be unit-tested under Node.
//
// In a snippet, the two-character marker "$0" (optional) marks where the caret
// should land after insertion; it is stripped before the text is inserted. If
// there is no marker the caret goes to the end of the inserted text.

export interface SqlFn {
  /** Text shown in the menu. */
  label: string;
  /** Inserted at the caret. "$0" marks the resulting caret position. */
  snippet: string;
  /** Optional one-line description (shown as a tooltip). */
  hint?: string;
}

export interface SqlFnGroup {
  title: string;
  items: SqlFn[];
}

export const SQL_FUNCTION_GROUPS: SqlFnGroup[] = [
  {
    title: "JSON & nested",
    items: [
      {
        label: "Explode list → rows (recursive)",
        snippet: "UNNEST($0, recursive := true)",
        hint: "Unnest a list and expand its structs into columns (one row per element)",
      },
      { label: "Unnest a list column", snippet: "UNNEST($0)" },
      {
        label: "Expand a STRUCT to columns",
        snippet: "$0.*",
        hint: "struct_column.* — one output column per struct field",
      },
      { label: "Struct field", snippet: "$0.field" },
      { label: "List element [1] (1-based)", snippet: "$0[1]" },
      {
        label: "json_extract (path)",
        snippet: "json_extract($0, '$.path')",
        hint: "Extract a nested JSON value by path",
      },
      {
        label: "json_extract_string (text)",
        snippet: "json_extract_string($0, '$.path')",
      },
      { label: "JSON path  ->  (value)", snippet: "$0 -> '$.path'" },
      { label: "JSON path  ->>  (text)", snippet: "$0 ->> '$.path'" },
      { label: "json_keys", snippet: "json_keys($0)" },
      { label: "Cast to JSON", snippet: "$0::JSON" },
      {
        label: "Read NDJSON file",
        snippet: "read_json('$0', format='newline_delimited')",
      },
    ],
  },
  {
    title: "Conditional & cast",
    items: [
      { label: "CASE WHEN … THEN … END", snippet: "CASE WHEN $0 THEN  ELSE  END" },
      { label: "IF(cond, a, b)", snippet: "IF($0, , )" },
      { label: "COALESCE", snippet: "COALESCE($0, )" },
      { label: "NULLIF", snippet: "NULLIF($0, )" },
      { label: "CAST(… AS type)", snippet: "CAST($0 AS VARCHAR)" },
      { label: "TRY_CAST (NULL on failure)", snippet: "TRY_CAST($0 AS VARCHAR)" },
      { label: "typeof", snippet: "typeof($0)" },
    ],
  },
  {
    title: "Strings",
    items: [
      {
        label: "substring(str, start, len)",
        snippet: "substring($0, 1, 10)",
        hint: "1-based start position",
      },
      { label: "length", snippet: "length($0)" },
      { label: "upper", snippet: "upper($0)" },
      { label: "lower", snippet: "lower($0)" },
      { label: "trim", snippet: "trim($0)" },
      { label: "replace", snippet: "replace($0, 'from', 'to')" },
      { label: "concat", snippet: "concat($0, )" },
      { label: "string_split → list", snippet: "string_split($0, ',')" },
      { label: "left", snippet: "left($0, 3)" },
      { label: "right", snippet: "right($0, 3)" },
      { label: "contains", snippet: "contains($0, 'sub')" },
      { label: "starts_with", snippet: "starts_with($0, 'pre')" },
    ],
  },
  {
    title: "Regular expressions",
    items: [
      { label: "regexp_matches (bool)", snippet: "regexp_matches($0, 'pattern')" },
      {
        label: "regexp_extract (group)",
        snippet: "regexp_extract($0, 'pattern', 1)",
      },
      {
        label: "regexp_extract_all → list",
        snippet: "regexp_extract_all($0, 'pattern')",
      },
      {
        label: "regexp_replace",
        snippet: "regexp_replace($0, 'pattern', 'replacement')",
      },
      {
        label: "regexp_split_to_array",
        snippet: "regexp_split_to_array($0, 'pattern')",
      },
    ],
  },
  {
    title: "Window",
    items: [
      {
        label: "lag()",
        snippet: "lag($0) OVER (PARTITION BY  ORDER BY )",
        hint: "Value from the previous row in the window",
      },
      {
        label: "lead()",
        snippet: "lead($0) OVER (PARTITION BY  ORDER BY )",
        hint: "Value from the next row in the window",
      },
      {
        label: "row_number()",
        snippet: "row_number() OVER (PARTITION BY $0 ORDER BY )",
      },
      { label: "rank()", snippet: "rank() OVER (PARTITION BY $0 ORDER BY )" },
      {
        label: "dense_rank()",
        snippet: "dense_rank() OVER (PARTITION BY $0 ORDER BY )",
      },
      {
        label: "sum() OVER",
        snippet: "sum($0) OVER (PARTITION BY  ORDER BY )",
      },
      {
        label: "first_value()",
        snippet: "first_value($0) OVER (PARTITION BY  ORDER BY )",
      },
      {
        label: "last_value()",
        snippet: "last_value($0) OVER (PARTITION BY  ORDER BY )",
      },
    ],
  },
  {
    title: "Aggregate",
    items: [
      { label: "count(*)", snippet: "count(*)" },
      { label: "count(DISTINCT …)", snippet: "count(DISTINCT $0)" },
      { label: "sum", snippet: "sum($0)" },
      { label: "avg", snippet: "avg($0)" },
      { label: "min", snippet: "min($0)" },
      { label: "max", snippet: "max($0)" },
      { label: "list (collect to array)", snippet: "list($0)" },
      { label: "string_agg", snippet: "string_agg($0, ', ')" },
    ],
  },
  {
    title: "Date & time",
    items: [
      { label: "date_trunc", snippet: "date_trunc('day', $0)" },
      { label: "date_part / extract", snippet: "date_part('year', $0)" },
      { label: "strftime (format)", snippet: "strftime($0, '%Y-%m-%d')" },
      { label: "strptime (parse)", snippet: "strptime($0, '%Y-%m-%d')" },
      { label: "cast to DATE", snippet: "$0::DATE" },
      { label: "current_date", snippet: "current_date" },
      { label: "now()", snippet: "now()" },
    ],
  },
];

/**
 * Splice ``snippet`` into ``value`` at the selection [selStart, selEnd),
 * replacing any selected text. Returns the new text and the caret position
 * (the "$0" marker in the snippet, or the end of the inserted text).
 */
export function applySnippet(
  value: string,
  selStart: number,
  selEnd: number,
  snippet: string,
): { text: string; caret: number } {
  const marker = snippet.indexOf("$0");
  const clean =
    marker >= 0 ? snippet.slice(0, marker) + snippet.slice(marker + 2) : snippet;
  const s = Math.max(0, Math.min(selStart, value.length));
  const e = Math.max(s, Math.min(selEnd, value.length));
  const before = value.slice(0, s);
  const after = value.slice(e);
  const caret = before.length + (marker >= 0 ? marker : clean.length);
  return { text: before + clean + after, caret };
}
