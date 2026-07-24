// Help shown by the "?" button in a node's inspector (configuration window).
// Each entry is a short, plain-language explanation of what the node does and
// how to wire it, plus -- for nodes that offer a fixed set of operations -- the
// functions it can handle. Kept as data so the inspector just renders it.

export type NodeHelp = {
  title: string;
  what: string;
  use: string;
  funcs?: { label: string; items: string[] };
};

export const NODE_HELP: Record<string, NodeHelp> = {
  input: {
    title: "Input",
    what: "Reads a loaded table (or a table another node wrote) as the starting point of a flow.",
    use: "Pick the table in the inspector. No inputs; one output — wire it into the next step.",
  },
  select: {
    title: "Select",
    what: "Keeps, drops, or reorders columns.",
    use: "Choose which columns flow downstream. Everything else is dropped.",
  },
  filter: {
    title: "Filter",
    what: "Keeps only the rows that match a condition.",
    use: "Add one or more conditions (match all, or any). Each compares a column to a value.",
    funcs: {
      label: "Comparisons",
      items: ["= equals", "≠ does not equal", "> / ≥ / < / ≤", "contains", "starts with", "ends with", "is empty (null)", "is not empty"],
    },
  },
  formula: {
    title: "Formula",
    what: "Adds or replaces a column from an expression.",
    use: "Name the column and write an expression over the input's columns, e.g. price * qty, or upper(name).",
    funcs: {
      label: "Expressions use your engine's SQL (DuckDB / SQLite)",
      items: ["math: + - * / %, round, abs, …", "text: upper, lower, trim, substr, concat (||)", "logic: CASE WHEN …, COALESCE, NULLIF", "any scalar function the engine supports"],
    },
  },
  summarize: {
    title: "Summarize",
    what: "Groups rows and aggregates them.",
    use: "Pick the group-by columns, then one aggregation per output column.",
    funcs: { label: "Aggregations", items: ["sum", "avg", "min", "max", "count", "count distinct"] },
  },
  sort: {
    title: "Sort",
    what: "Orders rows by one or more columns.",
    use: "Add sort keys; each can be ascending or descending (the first key wins ties first).",
  },
  sample: {
    title: "Sample",
    what: "Takes a subset of the rows.",
    use: "Choose how many rows to keep.",
    funcs: { label: "Modes", items: ["first N (head)", "random N"] },
  },
  unique: {
    title: "Unique",
    what: "Keeps only distinct rows, dropping exact duplicates.",
    use: "Wire in a table; identical rows are collapsed to one.",
  },
  unpivot: {
    title: "Unpivot",
    what: "Turns wide columns into rows (columns → name/value pairs). The opposite of Pivot.",
    use: "Pick the columns to fold; each becomes a row with a name column and a value column.",
  },
  window: {
    title: "Window",
    what: "Adds a column computed across a window of rows, without collapsing them.",
    use: "Choose a function, an optional partition (group), and an order. The result is added per row.",
    funcs: {
      label: "Functions",
      items: ["running sum / avg / min / max / count", "row number", "rank", "dense rank", "lag", "lead"],
    },
  },
  bin: {
    title: "Bin",
    what: "Buckets a numeric column into labelled ranges (e.g. age → 0–18, 19–35, …).",
    use: "Define the upper edge and label for each bucket; values fall into the first bucket they fit.",
  },
  rank: {
    title: "Rank",
    what: "Numbers rows within a group by a sort.",
    use: "Pick the partition + sort column and direction; a rank column is added.",
    funcs: { label: "Methods", items: ["row_number", "rank", "dense_rank", "ascending / descending"] },
  },
  dedupe: {
    title: "Dedupe",
    what: "Keeps one row per key, dropping later duplicates.",
    use: "Pick the key columns and which row to keep (first or last by a sort).",
  },
  split: {
    title: "Split column",
    what: "Splits one text column into several by a delimiter.",
    use: "Choose the column and delimiter (e.g. , or - or |); each piece becomes a new column.",
  },
  jsonextract: {
    title: "JSON extract",
    what: "Pulls values out of a JSON text column into new columns.",
    use: "Give a path per value you want to extract (e.g. $.user.id).",
  },
  explode: {
    title: "Explode",
    what: "Expands an array/list column so each element becomes its own row.",
    use: "Pick the list column; the other columns repeat for each element.",
  },
  textclean: {
    title: "Text clean",
    what: "Tidies text columns.",
    use: "Pick the column(s) and the cleanups to apply.",
    funcs: { label: "Cleanups", items: ["trim whitespace", "change case (upper / lower)", "collapse repeated spaces", "remove / replace characters"] },
  },
  date: {
    title: "Date / time",
    what: "Derives a value from a date or timestamp column.",
    use: "Pick the column and an operation; the result is added as a new column.",
    funcs: {
      label: "Operations",
      items: ["extract part: year, quarter, month, week, day, day-of-year, weekday, hour, minute, second", "truncate to a unit", "difference between two dates"],
    },
  },
  groupconcat: {
    title: "Group concat",
    what: "Joins a column's values within each group into one string.",
    use: "Pick the group-by + the column to join, and a separator (e.g. comma).",
  },
  maprecode: {
    title: "Map / recode",
    what: "Replaces values with new values (recode), with a default for anything unmatched.",
    use: "List the from → to pairs and an optional fallback.",
  },
  parse: {
    title: "Parse / cast",
    what: "Converts a column to another type.",
    use: "Pick the column and target type (e.g. text → number, text → date).",
  },
  topn: {
    title: "Top N per group",
    what: "Keeps the top N rows in each group by a sort.",
    use: "Pick the group, the sort column + direction, and N.",
  },
  coalesce: {
    title: "Coalesce columns",
    what: "Combines several columns into one, taking the first non-empty value per row.",
    use: "List the columns in priority order; the result column gets the first that isn't null.",
  },
  renamecols: {
    title: "Rename columns",
    what: "Renames columns.",
    use: "Rename one by one, or by a find/replace pattern across many.",
  },
  validate: {
    title: "Validate",
    what: "Checks data-quality rules; the run reports a problem if a rule is violated.",
    use: "Add the rules you expect to hold for the input.",
    funcs: { label: "Rules", items: ["column not null", "column unique", "minimum row count", "maximum row count"] },
  },
  fill: {
    title: "Fill",
    what: "Fills empty (null) cells.",
    use: "Pick the column(s) and what to fill with.",
    funcs: { label: "Fill with", items: ["a fixed value", "zero", "empty string", "the column's avg / min / max"] },
  },
  pivot: {
    title: "Pivot",
    what: "Turns row values into columns (long → wide), aggregating where needed.",
    use: "Pick the row keys, the column to spread across the top, and the value + aggregation.",
  },
  join: {
    title: "Join",
    what: "Combines two inputs (left + right) on matching keys.",
    use: "Wire both sides, pick the key column(s), and choose which rows to keep.",
    funcs: { label: "Kinds", items: ["inner (matches only)", "left", "right", "full outer"] },
  },
  multijoin: {
    title: "Multi-join",
    what: "Joins several inputs in one step on shared keys.",
    use: "Wire each input and pick the common key column(s).",
  },
  crossjoin: {
    title: "Cross join",
    what: "Pairs every left row with every right row (Cartesian product).",
    use: "Wire both sides — there are no keys; use it deliberately, it multiplies row counts.",
  },
  antijoin: {
    title: "Anti-join",
    what: "Keeps left rows that have NO match on the right (a key-based difference).",
    use: "Wire both sides and pick the key column(s); only unmatched left rows pass.",
  },
  union: {
    title: "Union",
    what: "Stacks inputs on top of each other (same / compatible columns).",
    use: "Wire two or more inputs; optionally keep or drop duplicate rows.",
  },
  chart: {
    title: "Chart",
    what: "Draws a chart from an input.",
    use: "Wire in a table, choose the chart type and axes/series; the chart previews in the node body.",
  },
  dashboard: {
    title: "Dashboard",
    what: "Combines several charts into one panel.",
    use: "Feed it the charts you want shown together.",
  },
  browse: {
    title: "Browse",
    what: "Previews an input's rows in a table.",
    use: "A quick look at the data — it doesn't change anything.",
  },
  profile: {
    title: "Profile",
    what: "Summarizes each column: type, nulls, distinct count, min/max.",
    use: "Wire in a table for a fast data-quality scan.",
  },
  reconcile: {
    title: "Reconcile",
    what: "Compares two inputs and reports matches, mismatches, and rows only on one side.",
    use: "Wire both sides, pick the key column(s) and the columns to compare.",
  },
  group: {
    title: "Group",
    what: "A mini-pipeline (container).",
    use: "Drag nodes inside on the canvas; they run top-to-bottom, each using the one above. The group's input feeds the first inner step; its output is the last step's result.",
  },
  createtable: {
    title: "Create table",
    what: "Builds a small table by hand.",
    use: "Type in the columns and rows — handy for lookups or test data. No inputs; one output.",
  },
  directory: {
    title: "Directory",
    what: "Lists the files in a folder as a table (names, sizes, dates).",
    use: "Point it at a folder — e.g. to drive an Iterator over files.",
  },
  appendfolder: {
    title: "Append folder",
    what: "Reads every matching file in a folder and stacks them into one table.",
    use: "Point it at a folder + file pattern; all matches are concatenated.",
  },
  filebrowser: {
    title: "File browser",
    what: "Reads files matching a glob pattern in place (DuckDB), resolved at run time.",
    use: "Give a pattern that can contain ${variables}; matching CSV / Parquet / JSON files are read without a copy.",
  },
  apinode: {
    title: "API",
    what: "Calls an HTTP endpoint and loads the JSON response as a table.",
    use: "Set the URL (${variables} are filled per run/pass). Two outputs: data and errors.",
  },
  sqlserver: {
    title: "SQL Server",
    what: "Runs a query against SQL Server with the same connection settings as Load a Table (Windows / alternate Windows / SQL login, ODBC driver, encrypt, timeouts). Saved passwords stay in the OS secret store — never in the workflow — so Dashboard widgets can re-run unattended.",
    use: "Fill the connection form (or pick a saved mssql profile), tick Save password when needed, enter a SELECT, then Fetch. NodeFlow Run / Dashboard auto-fetch using the stored profile + password.",
  },
  sharepoint: {
    title: "SharePoint",
    what: "Loads items from a SharePoint list or document library (Microsoft Graph or classic REST) into a table.",
    use: "Pick an auth mode: pasted bearer token, Sign in (device code or browser — uses your Microsoft account), or Windows Integrated for classic on-prem. Set the site URL + list/folder, then Fetch.",
  },
  webscrape: {
    title: "Web scrape",
    what: "Fetches a public page and extracts HTML tables, links, page text, or JSON objects into a relation.",
    use: "Set the URL and mode (tables / links / text / JSON), optional JSON path, then Fetch. Respects the same outbound URL safety rules as the API node.",
  },
  iterator: {
    title: "Iterator",
    what: "Loops a set of values and runs a body once per value, appending each pass into one accumulator table.",
    use: "Drive it from the configured driver, OR wire a table into the top \u201cvalues\u201d input. Reference each value in the body with ${var}. It's a terminal node — read its result with an Input node pointed at the accumulator table.",
    funcs: { label: "Drivers", items: ["a typed list", "a date range", "a table column (distinct values)", "rows of a table (each column → ${var})", "a wired table (top \u201cvalues\u201d input)"] },
  },
  while: {
    title: "Repeat until",
    what: "Repeats a body until a condition is met (or a max-pass cap), accumulating each pass.",
    use: "Set the stop condition + cap, and wire the body. Terminal, like the Iterator — read the accumulator with an Input node.",
  },
  sql: {
    title: "SQL",
    what: "Free-form read-only SQL: optional stacked table inputs, named JOINs/CTEs, or catalog queries with no wires.",
    use: "Wire Input (or transform) nodes into the stacked inputs and reference each by the Input node's table name — e.g. FROM orders LEFT JOIN customers ON …. Or use input / {{in}} for the first wire. Leave unwired to query loaded catalog tables. Autocomplete uses upstream field names. DDL/DML is blocked.",
    funcs: {
      label: "Uses your engine's full SQL (DuckDB / SQLite)",
      items: [
        "Up to 10 stacked table inputs (same cap as Union)",
        "Table names = Input node table names (fallback t1…tN)",
        "Legacy input / {{in}} for the first wired table",
        "SELECT / JOIN / WITH (CTE); catalog queries with no inputs",
        "Preview and Run-all on the out port",
      ],
    },
  },
  python: {
    title: "Python",
    what: "Runs a Python script inside SamQL's bundled runtime (pandas included in distribution builds — no separate install).",
    use:
      "Wire an upstream table into the node's input. The script sees that table as `df` (a pandas DataFrame), plus `columns` / `rows` / `records`. Assign `out` to emit a table — typically `out = df` or another DataFrame. Leave the input unwired to generate data from scratch.",
    funcs: {
      label: "Script bindings",
      items: [
        "df — pandas DataFrame of the input (None if unwired)",
        "columns / rows — column names + row tuples",
        "records — list of row dicts (same data as df)",
        "out — DataFrame, list of dicts, or {columns, rows}",
        "Example: out = df[df[\"score\"] > 50][[\"name\", \"score\"]]",
        "import pandas as pd is allowed when pandas is bundled",
      ],
    },
  },
  write: {
    title: "Write to table",
    what: "Writes the input into a named DuckDB table (SQLite optional) so other flows and cells can read it.",
    use: "Name the table, keep Store in as DuckDB unless you need SQLite, then choose overwrite or append.",
  },
  output: {
    title: "Output",
    what: "The end of a flow — exports the input to a file (or an image from a chart/dashboard).",
    use: "Pick the format. Leave the folder blank to write into Downloads, or browse to another folder, then run.",
  },
  samqldash: {
    title: "SamQL Dashboard",
    what: "Marks a NodeFlow workflow as eligible for the app Dashboard tab.",
    use: "Wire a chart, pivot, reconcile, or data node into this sink, save the workflow, then pick it from a Dashboard cell.",
  },
  variable: {
    title: "Variables",
    what: "Defines ${name} = value pairs other nodes can reference. A value can be literal text or an fx expression (DATE_TIME_NOW(), TODAY()) evaluated once per run.",
    use: "Use the names in expressions, table names, file globs, API URLs, or a SQL Server WHERE clause anywhere downstream. Tick “Ask at run” on a row to be prompted for its value before each Run all — the typed value overrides the stored one for that run only.",
  },
  text: {
    title: "Note",
    what: "A sticky note on the canvas.",
    use: "Documentation only — it isn't part of the data flow.",
  },
  dyn_input: {
    title: "Dynamic Input",
    what: "Marks an entry port for a Created Node you author from a tab.",
    use: "Place at the start of the tab graph. When you Create a node, each Dynamic Input becomes an input on the reusable node (ordered top-to-bottom).",
  },
  dyn_output: {
    title: "Dynamic Output",
    what: "Marks an exit port for a Created Node you author from a tab.",
    use: "Wire the final transform into this node. When you Create a node, each Dynamic Output becomes an output on the reusable node (ordered top-to-bottom).",
  },
  usernode: {
    title: "Created node",
    what: "A reusable macro built from a full NodeFlow tab graph.",
    use: "Wire its inputs and preview any output port. Export/Load from Settings writes a shareable JSON file into Downloads.",
  },
};

export function getNodeHelp(type: string): NodeHelp {
  return (
    NODE_HELP[type] || {
      title: type,
      what: "A node in your flow.",
      use: "Wire inputs on the left into this node and its output onward. Tick “Freeze output” in the inspector to pin its result — later runs reuse it until this node or its upstream config changes.",
    }
  );
}
