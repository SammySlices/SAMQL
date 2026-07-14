// Pretty-print a struct / JSON-ish cell value for inspection.
//
// The backend renders a nested cell (a DuckDB struct, a JSON value) as a
// single-line string: single-quoted for a DuckDB/Python struct repr
// (`{'a': 1}`), double-quoted for JSON (`{"a": 1}`). Rather than parse and
// validate (the single-quoted form isn't valid JSON, and a preview value can
// be truncated), this reindents either style purely by structure -- tracking
// quoted spans so punctuation inside a string is left alone -- and is tolerant
// of unbalanced/truncated input (it never throws).

/** Cap sync pretty-print work so opening the viewer stays responsive. */
export const PRETTY_STRUCT_MAX_CHARS = 120_000;

export function looksStructy(text: string): boolean {
  const t = (text || "").trim();
  return t.length > 2 && (t[0] === "{" || t[0] === "[");
}

export function prettyStruct(text: string, indent = "  "): string {
  if (!looksStructy(text)) return text;
  const truncated = text.length > PRETTY_STRUCT_MAX_CHARS;
  const src = truncated ? text.slice(0, PRETTY_STRUCT_MAX_CHARS) : text;
  let out = "";
  let depth = 0;
  let inStr = false;
  let quote = "";
  const nl = (d: number) => "\n" + indent.repeat(Math.max(0, d));
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        // copy the escaped character verbatim so an escaped quote inside the
        // string doesn't look like the end of it
        i++;
        if (i < src.length) out += src[i];
      } else if (ch === quote) {
        inStr = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      // keep an empty container on one line: {} / []
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const close = ch === "{" ? "}" : "]";
      if (src[j] === close) {
        out += ch + close;
        i = j;
        continue;
      }
      depth++;
      out += ch + nl(depth);
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      out += nl(depth) + ch;
      continue;
    }
    if (ch === ",") {
      out += "," + nl(depth);
      continue;
    }
    if (ch === ":") {
      out += ": ";
      // swallow following spaces so the value isn't double-spaced
      while (i + 1 < src.length && src[i + 1] === " ") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      // collapse insignificant whitespace (we supply our own line breaks),
      // keeping a single separating space mid-token
      const prev = out[out.length - 1];
      if (prev && prev !== "\n" && prev !== " ") out += " ";
      continue;
    }
    out += ch;
  }
  if (truncated) {
    out +=
      "\n… [pretty-print capped at " +
      PRETTY_STRUCT_MAX_CHARS.toLocaleString() +
      " chars]";
  }
  return out;
}
