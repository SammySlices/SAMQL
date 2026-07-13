import type { CSSProperties } from "react";

/**
 * Position a context (right-click) menu at the click point while keeping it
 * fully inside the viewport.
 *
 * - clamps horizontally so the menu's right edge never leaves the screen
 *   (pass the menu's approximate width),
 * - pulls the top up when the click lands low on the screen so there's always
 *   a usable amount of menu visible, and
 * - caps the height to the space left below that top and turns on vertical
 *   scrolling, so a tall menu scrolls instead of running off the bottom.
 *
 * Every context menu in the app uses this so they all behave identically. The
 * caller keeps ownership of z-index (spread the result and add `zIndex` when a
 * menu needs to sit above a higher backdrop).
 */
export function menuPos(x: number, y: number, width = 220): CSSProperties {
  const M = 8; // viewport margin
  const left = Math.max(M, Math.min(x, window.innerWidth - width - M));
  const top = Math.max(M, Math.min(y, window.innerHeight - 220));
  return {
    position: "fixed",
    left,
    top,
    maxHeight: window.innerHeight - top - M,
    overflowY: "auto",
  };
}
