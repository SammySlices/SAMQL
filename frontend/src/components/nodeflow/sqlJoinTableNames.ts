import { PORTS, type NbEdge, type NbNode } from "../../lib/nodeFlowModel";
import type { ColumnInfo, TableInfo } from "../../lib/types";

/** Hard cap — same stacked multi-input limit as Union. */
export const SQLJOIN_INPUT_CAP = 10;

const DEFAULT_LABELS = new Set([
  "sql",
  "python",
  "select",
  "filter",
  "new_table",
  "input",
]);

/**
 * Walk upstream from ``startId`` to an Input-style table name.
 * Mirrors backend ``sqljoin_relation_name``.
 */
export function sqlJoinRelationName(
  nodesById: Map<string, NbNode>,
  edges: NbEdge[],
  startId: string | undefined,
): string | null {
  if (!startId) return null;
  let nid: string | undefined = startId;
  const seen = new Set<string>();
  while (nid && !seen.has(nid)) {
    seen.add(nid);
    const n = nodesById.get(nid);
    if (!n) break;
    const cfg = n.config || {};
    if (
      n.type === "input" ||
      n.type === "directory" ||
      n.type === "appendfolder" ||
      n.type === "shred"
    ) {
      const table = String(cfg.table || "").trim();
      if (table) return table;
    }
    const ins = PORTS[n.type]?.inputs || [];
    let next: string | undefined;
    for (const port of ins) {
      const edge = edges.find((e) => e.to.node === nid && e.to.port === port);
      if (edge) {
        next = edge.from.node;
        break;
      }
    }
    if (!next) {
      const lab = String(cfg.label || "").trim();
      if (lab && !DEFAULT_LABELS.has(lab.toLowerCase()) && lab.toLowerCase() !== n.type) {
        return lab;
      }
      break;
    }
    nid = next;
  }
  return null;
}

export interface SqlJoinWiredTable {
  port: string;
  name: string;
  columns: string[];
}

/** Resolve logical table names + columns for each wired SQL Join input. */
export function resolveSqlJoinWiredTables(
  node: NbNode,
  nodes: NbNode[],
  edges: NbEdge[],
  inspCols: Record<string, string[]>,
): SqlJoinWiredTable[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const ports = PORTS.sql?.inputs || [];
  const out: SqlJoinWiredTable[] = [];
  const used = new Set<string>();
  ports.forEach((port, i) => {
    const edge = edges.find((e) => e.to.node === node.id && e.to.port === port);
    if (!edge) return;
    let name = sqlJoinRelationName(nodesById, edges, edge.from.node);
    if (!name) name = `t${i + 1}`;
    const key = name.toLowerCase();
    if (used.has(key)) {
      name = `${name}_${port}`;
    }
    used.add(name.toLowerCase());
    out.push({
      port,
      name,
      columns: inspCols[port] || [],
    });
  });
  return out;
}

/** Build SqlEditor ``tables`` schema from wired SQL inputs.

 * Engine follows the loaded Input table when present in ``catalog`` so
 * DuckDB loads get DuckDB SQL autocomplete; defaults to duckdb (product
 * load default). Columns always come from the wired upstream port
 * (flowed Select/Filter output), never a fresh DESCRIBE of the catalog.
 */
export function sqlJoinEditorTables(
  wired: SqlJoinWiredTable[],
  catalog?: TableInfo[],
): TableInfo[] {
  return wired.map((t) => {
    const cat = (catalog || []).find(
      (c) => c.name.toLowerCase() === t.name.toLowerCase(),
    );
    const engine =
      cat?.engine === "sqlite" ? ("sqlite" as const) : ("duckdb" as const);
    return {
      engine,
      name: t.name,
      source: "nodeflow",
      row_count: null,
      columns: t.columns.map(
        (name): ColumnInfo => ({ name, type: "" }),
      ),
    };
  });
}
