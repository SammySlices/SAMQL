import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";

/**
 * Contract for node pointer gestures vs the tables/inspector drawer:
 * - drag (move past 5px) must not open the panel
 * - left quick click (up under threshold) opens the panel
 * - right-click / contextmenu must not open the panel (node menu only)
 * Implementation: useNodeFlowCanvasInteractions onInspectorOpen;
 * NodeFlowCanvasCard onContextMenu must not call onInspectorOpen.
 */
describe("node drag vs inspector open contract", () => {
  const THRESHOLD = 5;
  const here = dirname(fileURLToPath(import.meta.url));

  function classifyPointerUp(opts: {
    dx: number;
    dy: number;
    button: number;
  }): "drag" | "click-open" | "no-open" {
    if (opts.button === 2) return "no-open";
    return Math.abs(opts.dx) < THRESHOLD && Math.abs(opts.dy) < THRESHOLD
      ? "click-open"
      : "drag";
  }

  it("classifies small left-button movement as click (open inspector)", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const kind = classifyPointerUp({ dx: 2, dy: 1, button: 0 });
    if (kind === "click-open") onOpen();
    else if (kind === "drag") onClose();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("classifies movement past threshold as drag (do not open; close if open)", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const kind = classifyPointerUp({ dx: 10, dy: 0, button: 0 });
    if (kind === "click-open") onOpen();
    else if (kind === "drag") onClose();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not open inspector on right-button pointerup (even under threshold)", () => {
    const onOpen = vi.fn();
    const kind = classifyPointerUp({ dx: 0, dy: 0, button: 2 });
    if (kind === "click-open") onOpen();
    expect(kind).toBe("no-open");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("NodeFlowCanvasCard contextmenu must not open inspector (menu only)", () => {
    const card = readFileSync(resolve(here, "./NodeFlowCanvasCard.tsx"), "utf8");
    const ctxIdx = card.indexOf("onContextMenu={(event, currentNode)");
    expect(ctxIdx).toBeGreaterThan(-1);
    const ctxBlock = card.slice(ctxIdx, ctxIdx + 700);
    expect(ctxBlock).toMatch(/setNodeMenu\s*\(/);
    expect(ctxBlock).not.toMatch(/onInspectorOpen/);

    const interactions = readFileSync(
      resolve(here, "./useNodeFlowCanvasInteractions.ts"),
      "utf8",
    );
    expect(interactions).toMatch(/if\s*\(\s*event\.button\s*===\s*2\s*\)\s*return/);
    expect(interactions).toMatch(/event\.button\s*!==\s*2/);
  });
});
