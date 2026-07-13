// Field-mapping logic for reconcile: line up A's and B's columns under a
// canonical name so two tables whose columns are named differently (or only
// differ in case / surrounding whitespace) can still be compared. A mapping
// file may rename columns on either side independently (it need not be 1:1,
// and one side may need no renames while the other does). Two fields become
// comparable when their (renamed) names match case- and whitespace-
// insensitively; the canonical name is A's display name, and each side's real
// column is recorded so the backend can reference them inline.

export interface ReconField {
  value: string; // canonical name (selected for key/compare/balance)
  label: string; // composite display label (shows originals when renamed)
  aCol: string; // A's real column
  bCol: string; // B's real column
}

export interface ReconMapping {
  renameA: Record<string, string>; // A original column -> rename
  renameB: Record<string, string>; // B original column -> rename
  name: string | null; // uploaded file name (for the status line)
}

const norm = (s: string) => s.trim().toLowerCase();

function ciRenameMap(ren: Record<string, string>): Record<string, string> {
  // Index renames by a case/whitespace-normalized key so a rename written in
  // a different case (e.g. "new_feedcode" for an actual "new_FeedCode") still
  // applies to the real column.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ren)) out[norm(k)] = v;
  return out;
}

function displayName(col: string, renCi: Record<string, string>): string {
  const r = renCi[norm(col)];
  return r && r.trim() ? r : col;
}

function flabel(disp: string, oa: string, ob: string): string {
  // Show the canonical (renamed) name plus the underlying A/B originals only
  // when a mapping actually changed them; an unchanged name is shown bare.
  if (oa === disp && ob === disp) return disp;
  if (oa === ob) return `${disp} (${oa})`;
  return `${disp} (A: ${oa} / B: ${ob})`;
}

export function resolveReconFields(
  colsA: string[],
  colsB: string[],
  mapping: ReconMapping | null,
): ReconField[] {
  const renA = ciRenameMap(mapping?.renameA || {});
  const renB = ciRenameMap(mapping?.renameB || {});
  // A: canonical = display name; first wins on a collision; keep column order.
  const colmapA: Record<string, string> = {};
  const orderA: string[] = [];
  for (const c of colsA) {
    const d = displayName(c, renA);
    if (!(d in colmapA)) {
      colmapA[d] = c;
      orderA.push(d);
    }
  }
  // B: index displays by normalized form; first wins on a collision.
  const bByNorm: Record<string, string> = {}; // norm -> B original
  for (const c of colsB) {
    const d = displayName(c, renB);
    const k = norm(d);
    if (!(k in bByNorm)) bByNorm[k] = c;
  }
  const out: ReconField[] = [];
  const seen = new Set<string>();
  for (const d of orderA) {
    const k = norm(d);
    if (k in bByNorm && !seen.has(k)) {
      seen.add(k);
      const aCol = colmapA[d];
      const bCol = bByNorm[k];
      out.push({ value: d, label: flabel(d, aCol, bCol), aCol, bCol });
    }
  }
  return out;
}

export function colmapsFor(fields: ReconField[]): {
  colmapA: Record<string, string>;
  colmapB: Record<string, string>;
} {
  const colmapA: Record<string, string> = {};
  const colmapB: Record<string, string> = {};
  for (const f of fields) {
    colmapA[f.value] = f.aCol;
    colmapB[f.value] = f.bCol;
  }
  return { colmapA, colmapB };
}

// ---- CSV ----------------------------------------------------------------

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function mappingTemplateCsv(colsA: string[], colsB: string[]): string {
  const lines = ["Table A field,Table A rename,Table B field,Table B rename"];
  const n = Math.max(colsA.length, colsB.length);
  for (let i = 0; i < n; i++) {
    lines.push(`${csvCell(colsA[i] || "")},,${csvCell(colsB[i] || "")},`);
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inq = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inq) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inq = false;
      } else cur += ch;
    } else if (ch === '"') inq = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch === "\r") {
      /* row break handled by \n */
    } else cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function parseMappingCsv(text: string, name: string): ReconMapping {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const renameA: Record<string, string> = {};
  const renameB: Record<string, string> = {};
  let start = 0;
  if (
    rows.length &&
    rows[0][0] &&
    rows[0][0].toLowerCase().includes("field")
  ) {
    start = 1;
  }
  for (let i = start; i < rows.length; i++) {
    const cells = [...rows[i], "", "", "", ""].slice(0, 4).map((c) =>
      (c || "").trim(),
    );
    const [af, ar, bf, br] = cells;
    if (af && ar) renameA[af] = ar;
    if (bf && br) renameB[bf] = br;
  }
  return { renameA, renameB, name };
}
