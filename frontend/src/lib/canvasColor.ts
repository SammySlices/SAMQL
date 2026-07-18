/** Settings → Visual → Change Canvas Color.
 *  Per-surface workspace backgrounds: IDE (SQL editor), Journal, NodeFlow.
 *  When set, `--user-canvas-bg-*` on <html> wins over ivory / light hard-coded whites.
 *
 *  NodeFlow snap-grid dots can also be customized (color + opacity) on the Node tab.
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

/** Default NodeFlow snap-grid dot color (matches CSS rgba(127,127,127,…)). */
export const DEFAULT_NODE_DOT_COLOR = "#7f7f7f";

/** Default NodeFlow snap-grid dot opacity percent (0–100). Matches ~0.28 alpha. */
export const DEFAULT_NODE_DOT_OPACITY = 28;

export const NODE_DOT_COLOR_KEY = "samql.canvasDotColor.node";
export const NODE_DOT_OPACITY_KEY = "samql.canvasDotOpacity.node";
export const USER_CANVAS_DOT_COLOR_VAR = "--user-canvas-dot-color-node";
export const USER_CANVAS_DOT_OPACITY_VAR = "--user-canvas-dot-opacity-node";
export const HAS_USER_CANVAS_DOT_CLASS = "has-user-canvas-dot-node";

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

/** NodeFlow snap-grid dot style. null color/opacity means theme auto defaults. */
export type NodeDotStyle = {
  color: string | null;
  /** 0–100; null = default */
  opacity: number | null;
};

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export function normalizeHex(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!HEX_RE.test(s)) return null;
  return s.toLowerCase();
}

export function normalizeOpacityPercent(
  raw: number | string | null | undefined,
): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
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

function readOpacityKey(key: string): number | null {
  try {
    return normalizeOpacityPercent(window.localStorage?.getItem(key));
  } catch {
    return null;
  }
}

function writeOpacityKey(key: string, opacity: number | null): void {
  try {
    if (opacity == null) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, String(opacity));
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

export function readPersistedNodeDotStyle(): NodeDotStyle {
  return {
    color: readKey(NODE_DOT_COLOR_KEY),
    opacity: readOpacityKey(NODE_DOT_OPACITY_KEY),
  };
}

export function persistNodeDotStyle(style: NodeDotStyle): void {
  writeKey(NODE_DOT_COLOR_KEY, normalizeHex(style.color));
  writeOpacityKey(NODE_DOT_OPACITY_KEY, normalizeOpacityPercent(style.opacity));
}

/** Relative luminance 0..1 for hex #rrggbb (sRGB). */
export function hexLuminance(hex: string): number | null {
  const n = normalizeHex(hex);
  if (!n) return null;
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
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
    if (surface === "node") {
      const lum = hexLuminance(n);
      root.classList.remove("canvas-node-luma-dark", "canvas-node-luma-light");
      if (lum != null) {
        root.classList.add(
          lum < 0.45 ? "canvas-node-luma-dark" : "canvas-node-luma-light",
        );
        root.setAttribute(
          "data-canvas-node-luma",
          lum < 0.45 ? "dark" : "light",
        );
      }
    }
  } else {
    root.style.removeProperty(varName);
    root.classList.remove(cls);
    if (surface === "node") {
      root.classList.remove("canvas-node-luma-dark", "canvas-node-luma-light");
      root.removeAttribute("data-canvas-node-luma");
    }
  }
}

/**
 * Apply NodeFlow snap-grid dot color/opacity. When either value is set,
 * `.has-user-canvas-dot-node` overrides luminance-auto / ivory dot colors.
 */
export function applyNodeDotStyle(style: NodeDotStyle): void {
  const root = document.documentElement;
  const color = normalizeHex(style.color);
  const opacity = normalizeOpacityPercent(style.opacity);
  const hasCustom = color != null || opacity != null;
  if (hasCustom) {
    root.style.setProperty(
      USER_CANVAS_DOT_COLOR_VAR,
      color ?? DEFAULT_NODE_DOT_COLOR,
    );
    root.style.setProperty(
      USER_CANVAS_DOT_OPACITY_VAR,
      String(opacity ?? DEFAULT_NODE_DOT_OPACITY),
    );
    root.classList.add(HAS_USER_CANVAS_DOT_CLASS);
  } else {
    root.style.removeProperty(USER_CANVAS_DOT_COLOR_VAR);
    root.style.removeProperty(USER_CANVAS_DOT_OPACITY_VAR);
    root.classList.remove(HAS_USER_CANVAS_DOT_CLASS);
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
