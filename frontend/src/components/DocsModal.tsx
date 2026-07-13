import React, { useEffect, useMemo, useState } from "react";
import { TableInfo } from "../lib/types";
import { api } from "../lib/api";
import { useWinDrag } from "./ActivityShared";
import { Icon } from "./Icon";

/** .433: Settings -> Tools -> "Documentation". Tabs: Joins (the .432
 * live-templated join guide), Journal, JSON querying, NodeFlow (every
 * node explained), and SQL functions (LIVE from both engines via
 * /api/docs/functions -- including SamQL-registered UDFs). */

const ord = (name: string, base: string) => {
  // .515: the ordinal column is the child's FULL (path) name + "_ord" --
  // e.g. cashflows_payingleg_ord. Legacy base-prefixed families strip the
  // base first, which lands on the same answer for them too.
  const tail = name.startsWith(base + "_")
    ? name.slice(base.length + 1)
    : name;
  return (tail || "x") + "_ord";
};

/** Every NodeFlow node, one honest line each. The battery asserts this
 * dictionary covers the full palette in NodeFlow.tsx. */
const NODE_DOCS: Record<string, string> = {
  input: "Brings a loaded table (or a typed table name) into the flow.",
  shred: "Flattens a nested table into the full relational set — one table per array level (nested arrays included), each with a single-column _sk / _parent_sk to join on.",
  select: "Keeps, drops, and reorders columns.",
  filter: "Keeps rows matching a condition (SQL WHERE).",
  formula: "Adds or replaces a column from a SQL expression.",
  summarize: "GROUP BY with aggregates (sum, count, avg, min, max…).",
  sort: "Orders rows by one or more columns.",
  sample: "Takes a random or first-N sample of rows.",
  unique: "Distinct rows (optionally over a subset of columns).",
  unpivot: "Wide to long: folds chosen columns into name/value pairs.",
  window: "Window functions (running totals, lag/lead, moving averages) over a partition + order.",
  perioddelta: "Computes previous-period values, absolute or percentage change, or a running total by an ordered period (optionally partitioned).",
  bin: "Buckets a numeric column into ranges (equal width or custom edges).",
  rank: "Ranks rows within a partition (rank / dense_rank / row_number).",
  dedupe: "Keeps one row per key (first/last by an order you choose).",
  split: "Splits one column into several by a delimiter or pattern.",
  jsonextract: "Pulls values out of a JSON string column by path.",
  explode: "UNNESTs an array column into one row per element.",
  textclean: "Trim, case, collapse whitespace, strip characters.",
  date: "Parses, formats, truncates, and offsets date/time columns.",
  groupconcat: "Aggregates a column into a delimited string per group.",
  maprecode: "Maps values to new values from a lookup you type in.",
  parse: "Casts columns to explicit types (with error handling).",
  topn: "Keeps the top N rows per group by a metric.",
  coalesce: "First non-null across chosen columns into one column.",
  renamecols: "Renames columns (single or bulk pattern).",
  validate: "Checks rules (not null, unique, ranges) and reports violations.",
  pivot: "Long to wide: spreads a category column into columns.",
  join: "Joins two inputs on key columns (inner/left/right/full).",
  multijoin: "Chains several inputs through one shared key set.",
  crossjoin: "Cartesian product of two inputs (every pair).",
  union: "Stacks inputs with matching columns (ALL or distinct).",
  chart: "Renders a chart from its input (bar/line/scatter…).",
  dashboard: "Pins several charts/tables into one view.",
  browse: "A results grid checkpoint — inspect the flow mid-stream.",
  profile: "Column statistics: types, nulls, distincts, min/max.",
  reconcile: "Compares two inputs (matched / left-only / right-only, per-field).",
  group: "A visual container that groups nodes on the canvas.",
  sql: "Free-form SQL over the node's inputs (each input is a named relation).",
  output: "Exports the upstream result to a file. Leave the folder blank to write into your Downloads folder, or browse to another location.",
  createtable: "Materializes its input as a permanent table you name.",
  write: "Exports its input to a file (CSV / Parquet / Excel).",
  text: "A text / markdown annotation on the canvas.",
  png: "Renders an upstream chart to a PNG image file (Downloads when no folder is set).",
  variable: "A named value other nodes can reference in expressions.",
  iterator: "Repeats its subflow once per row/value of its input.",
  while: "Loops its subflow while a condition stays true.",
  filebrowser: "Picks a file path interactively for downstream loads.",
  directory: "Lists a folder's files as a table (name, size, dates).",
  appendfolder: "Loads and stacks every matching file in a folder.",
  apinode: "Fetches an HTTP API response into a table.",
  dyn_input: "Marks an entry port when authoring a Created Node from a tab.",
  dyn_output: "Marks an exit port when authoring a Created Node from a tab.",
  usernode: "A reusable Created Node — expand, Open Node to edit, or Export/Load the definition as JSON into Downloads.",
};

type Tab = "joins" | "journal" | "json" | "nodeflow" | "functions";

const TAB_DEFS: { id: Tab; label: string }[] = [
  { id: "joins", label: "Joins" },
  { id: "journal", label: "Journal" },
  { id: "json", label: "JSON querying" },
  { id: "nodeflow", label: "NodeFlow" },
  { id: "functions", label: "SQL functions" },
];

// .485: the tab strip is its OWN module-scope, memoized component. It was
// an inline `TabBtn` defined INSIDE DocsModalInner, so every re-render of
// the window created a fresh component type -- React then unmounted and
// remounted all five tabs, and each remount re-fired the `tab-in` entrance
// animation (styles.css line ~6935). That re-fire WAS the reported "tabs
// flicker after I move the window / when I type in the SQL-function
// filter": moving the window flips useWinDrag's dragging/settled state (a
// re-render on grab, release, and settle), and every keystroke calls setQ
// (another re-render) -- each one remounted the strip. Hoisted and memoized
// on (active, onSelect) -- and onSelect is the stable useState setter -- the
// strip re-renders ONLY on a real tab change, so the buttons mount exactly
// once (one entrance animation, on open) and never flash on drag/typing.
const DocsTabs: React.FC<{
  active: Tab;
  onSelect: (t: Tab) => void;
}> = React.memo(({ active, onSelect }) => (
  <div className="docs-tabs">
    {TAB_DEFS.map((d) => (
      <button
        key={d.id}
        className={"tab" + (active === d.id ? " active" : "")}
        onClick={() => onSelect(d.id)}
      >
        {d.label}
      </button>
    ))}
  </div>
));
DocsTabs.displayName = "DocsTabs";

const DocsModalInner: React.FC<{
  tables: TableInfo[];
  onClose: () => void;
}> = ({ tables, onClose }) => {
  const [tab, setTab] = useState<Tab>("joins");
  const live = useMemo(() => {
    const duck = tables.filter((t) => t.engine === "duckdb");
    const hub = duck.find((t) => t.name.endsWith("_joinkeys"));
    if (!hub) return null;
    const base = hub.name.slice(0, -"_joinkeys".length);
    // .515: children carry ELEMENT-PATH names (cashflows_payingleg) since
    // .504 -- find them by the explicit parent metadata (.501 family tree),
    // falling back to the legacy base_* prefix for families made by older
    // builds.
    const kidsOf = (p: string) =>
      duck.filter((x) => x.parent === p && x.name !== hub.name);
    let kids = kidsOf(base);
    if (!kids.length)
      kids = duck.filter(
        (x) => x.name.startsWith(base + "_") && x.name !== hub.name,
      );
    kids = kids.slice().sort((a, b) => a.name.length - b.name.length);
    const child = kids[0];
    let grands = child ? kidsOf(child.name) : [];
    if (child && !grands.length)
      grands = duck.filter((x) => x.name.startsWith(child.name + "_"));
    const grand = grands
      .slice()
      .sort((a, b) => a.name.length - b.name.length)[0];
    return { base, hub: hub.name, child, grand };
  }, [tables]);

  const t = live?.base || "myfile";
  // the root's ordinal is named after the SOURCE list column (json_ord for
  // a "json" top-level array) -- shown as the canonical example
  const rootOrd = "json_ord";
  const child = live?.child?.name || "cashflows";
  const childOrd = ord(child, t);
  const grand = live?.grand?.name || `${child}_legs`;
  const hub = live?.hub || `${t}_joinkeys`;

  // SQL functions: fetched once, filterable
  const [fns, setFns] = useState<Awaited<
    ReturnType<typeof api.docsFunctions>
  > | null>(null);
  const [fnErr, setFnErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    if (tab !== "functions" || fns) return;
    api
      .docsFunctions()
      .then(setFns)
      .catch((e: any) => setFnErr(e.message || String(e)));
  }, [tab, fns]);
  const flt = (name: string) =>
    !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());

  // .436: a FLOATING window (the value-inspector pattern -- drag by
  // the header, CSS resize from the corner, X to close, NO backdrop)
  // so the docs can sit beside the IDE while you write the query
  // they describe.
  const { pos, startDrag, dragging, winRef } = useWinDrag({
    x: 90,
    y: 70,
  });
  // .473: reflect the "being dragged" shadow on the element directly,
  // so the feedback costs no re-render (and never flashes geometry).
  React.useEffect(() => {
    const el = winRef.current;
    if (el) el.classList.toggle("dragging", dragging);
  }, [dragging, winRef]);
  // .470: the .459 rise-in used a scroll observer that added a
  // class via classList -- OUTSIDE React. Any re-render (a drag
  // commit, the settle flip, async data landing) rewrote className
  // and wiped it, so sections vanished after moving the window; and
  // children rendered after the observer ran -- the fetched SQL
  // function list -- were never observed at all: permanently
  // invisible. The reveal is now a React-owned one-shot pane
  // entrance, keyed by tab (see .docs-content in styles).
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  // .471/.473: default size AND position are set once on mount; the
  // resize handle and the drag hook own them imperatively afterwards.
  // Nothing about the window's geometry lives in the style prop, so a
  // keystroke (which re-renders the whole app) can't snap it back --
  // that snap, plus the settle-class flip re-rendering, WAS the flash
  // that survived .471.
  React.useEffect(() => {
    const el = winRef.current;
    if (el && !el.style.width) {
      el.style.width = "680px";
      el.style.height = "540px";
      el.style.left = pos.x + "px";
      el.style.top = pos.y + "px";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    // a fresh tab always starts at the top (the strip is sticky, but a
    // deep scroll from the previous tab shouldn't carry over)
    const host = bodyRef.current;
    if (!host) return;
    host.scrollTop = 0;
    const scroller = host.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, [tab]);
  return (
    <div
      ref={winRef as React.RefObject<HTMLDivElement>}
      className="docs-float win-float"
      style={{
        position: "fixed",
        zIndex: 220,
        resize: "both",
        overflow: "auto",
        // .473: NO left/top/width/height here -- all four are written
        // to the element imperatively (mount defaults + drag hook +
        // native resize), so a re-render never rewrites geometry and
        // never flashes.
        minWidth: 420,
        minHeight: 300,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="docs-float-head"
        onMouseDown={startDrag}
        title="Drag to move; resize from the corner"
      >
        <span className="label">Documentation</span>
        <span className="spacer" />
        <button
          className="btn ghost icon"
          onClick={onClose}
          title="Close"
        >
          <Icon.X size={16} />
        </button>
      </div>
      {/* .468: the tab strip lived INSIDE the scrolling, keyed body --
          open the guide with the body scrolled (or scroll any long tab)
          and the tabs were simply off-screen ("the tabs don't always
          show"). They are their own fixed row above the scroller now,
          and every tab switch resets the scroll. .485: the strip is a
          memoized module-scope component (DocsTabs), so a keystroke in the
          filter or a window move can't remount it and re-fire tab-in. */}
      <DocsTabs active={tab} onSelect={setTab} />
      <div className="docs-float-body">
      <div key={tab} className="docs-content tab-fade" ref={bodyRef}>

      {tab === "joins" && (
        <div className="join-guide">
          <p>
            <b>The rule.</b> Every table carries a single-column surrogate
            key <code>"_sk"</code> plus <code>"_parent_sk"</code> — its
            parent row's <code>"_sk"</code> — so a join is always one
            column: <code>child."_parent_sk" = parent."_sk"</code>. The
            same one line chains to any depth (grandchild → child → hub).
            {live ? (
              <> These examples use your live tables under <code>{t}</code>.</>
            ) : (
              <>
                {" "}
                (Load a JSON file with flatten on — or shred a nested
                table — and reopen this guide to see the examples
                templated with your real names.)
              </>
            )}
          </p>
          <h4>How the family is named</h4>
          <p>
            The family's anchor is <code>{hub}</code> — the record keys
            (<code>"_sk"</code>, <code>"_rid"</code>, ordinals) plus the
            record's <b>scalar fields</b>, one row per record. The bare
            file name is <b>intentionally unbound</b>: nothing answers to
            it, so a stale query fails loudly instead of showing old
            nested json. When the file is only a wrapper around a single
            list, the wrapper vanishes and each record is one hub row
            (925 wrapper rows in, 22,704 records out). Children are named
            by their <b>element path</b> (<code>{child}</code>, then{" "}
            <code>{grand}</code> a level deeper); single nested{" "}
            <i>objects</i> get their own one-row-per-record table; a
            heterogeneous object column (a DuckDB <code>MAP</code>, like
            an <code>identifier</code> block) becomes a{" "}
            <code>(key, value)</code> table — one row per entry. All of
            them join with the same rule.
          </p>
          <h4>Unique identifier (root_id) and Master_Keys</h4>
          <p>
            Picking a <b>unique identifier</b> in the Load dialog (any
            record-level field — nested paths, a first-element list path,
            or one key of a <code>MAP</code> column) stamps it onto{" "}
            <b>every table in the family</b> as a <code>root_id</code>{" "}
            column, evaluated once per record — a human-friendly
            alternative to <code>"_sk"</code> for joining any two family
            tables directly. A <code>Master_Keys</code> table is created
            alongside: the <b>distinct, non-null</b> identifier list, one
            row each. Duplicates are removed there but never silently —
            the load card reports whether the field was actually unique
            (records vs distinct, with the duplicated and null counts).
            The picker appears wherever a JSON load offers the flatten
            toggle — the Load dialog's file tab and the drag-drop
            prompt — and fills its candidates from a fast <b>sample
            scan</b> of the file's first couple of megabytes, so even a
            multi-GB file lists its fields instantly; each candidate
            notes whether it looked unique <i>in the sample</i>, and the
            load card's verdict over the full data is the authoritative
            one. Re-flattening the same file replaces its{" "}
            <code>Master_Keys</code> alongside the family.
          </p>
          <h4>Hub → child (one column)</h4>
          <pre className="code">{`SELECT r.*, c.*
FROM ${hub} AS r
JOIN ${child} AS c
  ON c."_parent_sk" = r."_sk"`}</pre>
          <h4>Child → grandchild (same shape at every depth)</h4>
          <pre className="code">{`FROM ${child} AS c
JOIN ${grand} AS s
  ON s."_parent_sk" = c."_sk"`}</pre>
          <h4>Map columns (key, value)</h4>
          <pre className="code">{`SELECT r.code, i."key", i."value"
FROM ${hub} AS r
JOIN identifier AS i
  ON i."_parent_sk" = r."_sk"`}</pre>
          <h4>Things to remember</h4>
          <ul>
            <li>
              <code>"_sk"</code> is a readable path like{" "}
              <code>"925/1/3"</code> (source row → record → element); the
              parent's is that path with the last segment dropped.
            </li>
            <li>
              The compound key is still there too — <code>"_rid"</code> is
              the source file row, and the ordinals (e.g.{" "}
              <code>{rootOrd}</code>, <code>{childOrd}</code>) give{" "}
              <code>ORDER BY</code> the original array position.
            </li>
            <li>
              Scalar-array children put their element in a{" "}
              <code>value</code> column.
            </li>
            <li>
              An array nested inside a list element breaks out into its own
              table with the full key carried down — it still joins by{" "}
              <code>"_parent_sk"</code> like every other level.
            </li>
            <li>
              Joining two <b>sibling</b> children directly is a cartesian
              per parent row — anchor each to the hub separately instead.
            </li>
          </ul>
        </div>
      )}

      {tab === "journal" && (
        <div className="join-guide">
          <p>
            The <b>Journal</b> is a notebook of cells that run against
            the same engines as the IDE. Each SQL cell's result is
            addressable by its <b>cell name</b> — write{" "}
            <code>FROM Cell1</code> in a later cell and the chips under
            the header show the lineage (<i>USES</i> what it reads,{" "}
            <i>FEEDS</i> what reads it). Chained cells run in dependency
            order.
          </p>
          <ul>
            <li>
              <b>Run</b> executes the selected statement (or the
              statement under the cursor); the whole chain re-runs when
              an upstream cell changes.
            </li>
            <li>
              Cell types from the toolbar: <b>+SQL</b>, <b>+Note</b>{" "}
              (markdown text), <b>Chart</b>, <b>Pivot</b>, and{" "}
              <b>Reconcile</b> — the last three consume the cell above
              them. Chart, Pivot, and Reconcile each expose <b>Stop</b>{" "}
              while they run (same cancel rail as the IDE).
            </li>
            <li>
              Drag the corner grip to resize a cell; long lines scroll
              horizontally inside the editor.
            </li>
            <li>
              Cell results are session-scoped working sets — export
              (Downloads folder) or <code>CREATE TABLE … AS</code> to keep
              one. Reconcile failure CSVs also land in Downloads and can be
              cancelled from the Activity tray.
            </li>
          </ul>
        </div>
      )}

      {tab === "json" && (
        <div className="join-guide">
          <p>
            Nested DuckDB tables (a query-in-place JSON load) are
            queried with <b>dot access</b> and <b>UNNEST</b>. The
            sidebar tree shows the shape; these patterns cover most of
            it:
          </p>
          <pre className="code">{`-- structs: dot into fields (quote mixed case)
SELECT json[1].code, json[1]."SwapHistory"."SwapHistory"."dayType"
FROM my_nested;

-- arrays: one row per element
SELECT code, UNNEST(json[1].cashflows) AS cf FROM my_nested;

-- everything at once (structs flattened, lists exploded)
SELECT UNNEST(json, recursive := true) FROM my_nested;

-- element position (1-based) alongside the element
SELECT generate_subscripts(json[1].cashflows, 1) AS i,
       UNNEST(json[1].cashflows) AS cf
FROM my_nested;

-- JSON *strings* (a MAP/VARCHAR column): -> keeps JSON, ->> extracts text
SELECT payload->'$.trade.legs[0].ccy',
       payload->>'$.trade.id'
FROM raw_events;`}</pre>
          <p>
            On <b>SQLite</b>, JSON lives in text columns via the json1
            functions: <code>json_extract(x, '$.a.b')</code>,{" "}
            <code>x -&gt; '$.a'</code> / <code>x -&gt;&gt; '$.a'</code>,
            and <code>json_each</code> / <code>json_tree</code> as
            table functions to explode arrays and walk objects. For
            heavy nested work, prefer the DuckDB engine or the Load
            checkbox that shreds into relational tables (see the Joins
            tab).
          </p>
        </div>
      )}

      {tab === "nodeflow" && (
        <div className="join-guide">
          <p>
            The <b>NodeFlow</b> is a visual flow: drag nodes from the
            palette, wire outputs to inputs, and <b>Run</b> — each node
            materializes as a table built from its upstream, in
            dependency order, cancellable mid-flow, with progress on
            the Activity panel. What each node does:
          </p>
          <ul>
            {Object.entries(NODE_DOCS).map(([k, v]) => (
              <li key={k}>
                <b>{k}</b> — {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "functions" && (
        <div className="join-guide">
          <p>
            Every function the <b>running engines</b> expose right now —
            live from <code>PRAGMA function_list</code> (SQLite,
            including SamQL's registered <code>regexp_*</code> helpers)
            and <code>duckdb_functions()</code> (DuckDB). Type to
            filter.
          </p>
          <input
            placeholder="Filter functions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          {fnErr && <p className="err">{fnErr}</p>}
          {!fns && !fnErr && <p>Loading…</p>}
          {fns?.note && <p className="faint">{fns.note}</p>}
          {fns && (
            <div style={{ display: "flex", gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4>
                  DuckDB (
                  {fns.duckdb.filter((f) => flt(f.name)).length}/
                  {fns.counts.duckdb})
                </h4>
                <div className="fn-list" style={{ maxHeight: 320, overflow: "auto" }}>
                  {fns.duckdb
                    .filter((f) => flt(f.name))
                    .map((f) => (
                      <div key={"d" + f.name + f.type}>
                        <code>{f.name}</code>{" "}
                        <span className="faint">{f.type}</span>
                      </div>
                    ))}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4>
                  SQLite (
                  {fns.sqlite.filter((f) => flt(f.name)).length}/
                  {fns.counts.sqlite})
                </h4>
                <div className="fn-list" style={{ maxHeight: 320, overflow: "auto" }}>
                  {fns.sqlite
                    .filter((f) => flt(f.name))
                    .map((f) => (
                      <div key={"s" + f.name}>
                        <code>{f.name}</code>
                        {f.args != null && f.args >= 0 && (
                          <span className="faint"> /{f.args}</span>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
      </div>
    </div>
  );
};

// .471: the docs window must not re-render on every keystroke in the
// editor (App re-renders; a fresh onClose identity rides along). The
// content depends only on the catalog; compare that and ignore the
// handler (its behaviour never changes).
export const DocsModal = React.memo(
  DocsModalInner,
  (prev, next) => prev.tables === next.tables,
);
