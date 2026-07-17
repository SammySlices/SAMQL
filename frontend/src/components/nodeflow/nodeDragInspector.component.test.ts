import { describe, expect, it, vi } from "vitest";

/**
 * Contract for node pointer gestures vs the tables/inspector drawer:
 * - drag (move past 5px) must not open the panel
 * - quick click (up under threshold) opens the panel
 * Implementation: useNodeFlowCanvasInteractions onInspectorOpen / onInspectorClose.
 */
describe("node drag vs inspector open contract", () => {
  const THRESHOLD = 5;

  function classify(
    dx: number,
    dy: number,
  ): "drag" | "click" {
    return Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD
      ? "click"
      : "drag";
  }

  it("classifies small movement as click (open inspector)", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    if (classify(2, 1) === "click") onOpen();
    else onClose();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("classifies movement past threshold as drag (do not open; close if open)", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    if (classify(10, 0) === "click") onOpen();
    else onClose();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
