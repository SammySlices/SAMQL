/** Settings → Visual → Change Canvas Color.
 *  Per-surface workspace backgrounds: IDE (SQL editor), Journal, NodeFlow.
 *  When set, `--user-canvas-bg-*` on <html> wins over ivory / light hard-coded whites.
 */

export type CanvasSurface = "ide" | "journal" | "node";

export const CANVAS_SURFACES: CanvasSurface[] = ["ide", "journal", "node"];

/** Legacy single-color key; migrated into all three surfaces when present. */
export const CANVAS_COLOR_KEY_LEGACY = "samql.canvasColor";

export const CANVAS_COLOR_KEYS: Record<CanvasSurface, string> = {
  ide: "samql.canvasColor.ide",
  journal: "samql.canvasColor.journal",
  node: "samql.canvasColor.node",
};

export const USER_CANVAS_BG_VARS: Record<CanvasSurface, string> = {
  ide: "--user-canvas-bg-ide",
  journal: "--user-canvas-bg-journal",
  node: "--user-canvas-bg-node",
};

export const HAS_USER_CANVAS_BG_CLASSES: Record<CanvasSurface, string> = {
  ide: "has-user-canvas-bg-ide",
  journal: "has-user-canvas-bg-journal",
  node: "has-user-canvas-bg-node",
};

/** Cool gray matching light chrome-strip / workspace gray (picker default). */
export const DEFAULT_CANVAS_COLOR = "#d8d8d8";

export type CanvasColorPreset = { label: string; value: string };

/** SamQL cool gray / white / soft green-tint — avoid purple AI clichés. */
export const CANVAS_COLOR_PRESETS: CanvasColorPreset[] = [
  { label: "Cool gray", value: "#d8d8d8" },
  { label: "White", value: "#ffffff" },
  { label: "Light gray", value: "#ececec" },
  { label: "Eggshell cool", value: "#e8eae8" },
  { label: "Soft green tint", value: "#e4ebe4" },
  { label: "Dark charcoal", value: "#15171b" },
];

export type CanvasColors = Record<CanvasSurface, string | null>;

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export function normalizeHex(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!HEX_RE.test(s)) return null;
  return s.toLowerCase();
}

function readKey(key: string): string | null {
  try {
    return normalizeHex(window.localStorage?.getItem(key));
  } catch {
    return null;
  }
}

function writeKey(key: string, color: string | null): void {
  try {
    if (color) window.localStorage?.setItem(key, color);
    else window.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Read all surfaces; migrate legacy `samql.canvasColor` into missing keys. */
export function readPersistedCanvasColors(): CanvasColors {
  const legacy = readKey(CANVAS_COLOR_KEY_LEGACY);
  const out: CanvasColors = { ide: null, journal: null, node: null };
  let wroteMigration = false;
  for (const surface of CANVAS_SURFACES) {
    const key = CANVAS_COLOR_KEYS[surface];
    let v = readKey(key);
    if (!v && legacy) {
      v = legacy;
      writeKey(key, legacy);
      wroteMigration = true;
    }
    out[surface] = v;
  }
  if (wroteMigration) {
    try {
      window.localStorage?.removeItem(CANVAS_COLOR_KEY_LEGACY);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function persistCanvasColor(
  surface: CanvasSurface,
  color: string | null,
): void {
  const n = color == null ? null : normalizeHex(color);
  writeKey(CANVAS_COLOR_KEYS[surface], n);
}

/** Apply or clear one surface's CSS variable + class on <html>. */
export function applyCanvasColor(
  surface: CanvasSurface,
  color: string | null,
): void {
  const root = document.documentElement;
  const n = normalizeHex(color);
  const varName = USER_CANVAS_BG_VARS[surface];
  const cls = HAS_USER_CANVAS_BG_CLASSES[surface];
  if (n) {
    root.style.setProperty(varName, n);
    root.classList.add(cls);
  } else {
    root.style.removeProperty(varName);
    root.classList.remove(cls);
  }
}

export function applyAllCanvasColors(colors: CanvasColors): void {
  for (const surface of CANVAS_SURFACES) {
    applyCanvasColor(surface, colors[surface]);
  }
}

/** @deprecated Prefer readPersistedCanvasColors — kept for callers expecting a single value. */
export function readPersistedCanvasColor(): string | null {
  const all = readPersistedCanvasColors();
  return all.ide ?? all.journal ?? all.node;
}
