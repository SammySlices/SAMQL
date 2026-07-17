/** Settings → Visual → Change Canvas Color.
 *  Persists a workspace background for NodeFlow canvas, Journal, and SQL editor.
 *  When set, `--user-canvas-bg` on <html> wins over ivory / light hard-coded whites.
 */

export const CANVAS_COLOR_KEY = "samql.canvasColor";
export const USER_CANVAS_BG_VAR = "--user-canvas-bg";
export const HAS_USER_CANVAS_BG_CLASS = "has-user-canvas-bg";

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

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export function normalizeHex(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!HEX_RE.test(s)) return null;
  return s.toLowerCase();
}

export function readPersistedCanvasColor(): string | null {
  try {
    return normalizeHex(window.localStorage?.getItem(CANVAS_COLOR_KEY));
  } catch {
    return null;
  }
}

export function persistCanvasColor(color: string): void {
  const n = normalizeHex(color);
  if (!n) return;
  try {
    window.localStorage?.setItem(CANVAS_COLOR_KEY, n);
  } catch {
    /* ignore */
  }
}

/** Apply or clear the user canvas CSS variable + class on <html>. */
export function applyCanvasColor(color: string | null): void {
  const root = document.documentElement;
  const n = normalizeHex(color);
  if (n) {
    root.style.setProperty(USER_CANVAS_BG_VAR, n);
    root.classList.add(HAS_USER_CANVAS_BG_CLASS);
  } else {
    root.style.removeProperty(USER_CANVAS_BG_VAR);
    root.classList.remove(HAS_USER_CANVAS_BG_CLASS);
  }
}
