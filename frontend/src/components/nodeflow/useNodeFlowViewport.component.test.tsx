import React, { useEffect, useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  useNodeFlowViewport,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./useNodeFlowViewport";

function ViewportHarness({
  onZoom,
}: {
  onZoom?: (zoom: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { zoom, zoomBy } = useNodeFlowViewport(wrapRef);

  useEffect(() => {
    onZoom?.(zoom);
  }, [zoom, onZoom]);

  return (
    <div>
      <div
        ref={wrapRef}
        data-testid="nb2-canvas-wrap"
        style={{ width: 400, height: 300, overflow: "auto" }}
      >
        <div
          data-testid="nb2-canvas-scaler"
          style={{ width: 2000 * zoom, height: 1500 * zoom }}
        />
      </div>
      <button type="button" data-testid="zoom-in" onClick={() => zoomBy(1.2)}>
        in
      </button>
      <span data-testid="zoom-value">{zoom}</span>
    </div>
  );
}

describe("useNodeFlowViewport ctrl+wheel zoom", () => {
  it("zooms in on Ctrl+scroll up and out on Ctrl+scroll down", () => {
    render(<ViewportHarness />);
    const wrap = screen.getByTestId("nb2-canvas-wrap");
    const value = () => Number(screen.getByTestId("zoom-value").textContent);

    expect(value()).toBe(1);

    act(() => {
      fireEvent.wheel(wrap, { deltaY: -120, ctrlKey: true });
    });
    // Typical mouse-wheel tick: per-event clamp at 1.35.
    expect(value()).toBeCloseTo(1.35, 5);

    const afterIn = value();
    act(() => {
      fireEvent.wheel(wrap, { deltaY: 120, ctrlKey: true });
    });
    expect(value()).toBeLessThan(afterIn);
    expect(value()).toBeCloseTo(1, 5);
  });

  it("applies a stronger step for modest trackpad-like deltas", () => {
    render(<ViewportHarness />);
    const wrap = screen.getByTestId("nb2-canvas-wrap");

    act(() => {
      fireEvent.wheel(wrap, { deltaY: -40, ctrlKey: true });
    });
    // exp(40 * 0.005) ≈ 1.221 (was ≈ 1.083 at the old 0.002 coefficient).
    expect(Number(screen.getByTestId("zoom-value").textContent)).toBeCloseTo(
      Math.exp(0.2),
      5,
    );
  });

  it("does not change zoom on plain wheel (pan/scroll path)", () => {
    render(<ViewportHarness />);
    const wrap = screen.getByTestId("nb2-canvas-wrap");

    act(() => {
      fireEvent.wheel(wrap, { deltaY: -120, ctrlKey: false });
    });
    expect(Number(screen.getByTestId("zoom-value").textContent)).toBe(1);
  });

  it("clamps zoom to ZOOM_MIN and ZOOM_MAX", () => {
    render(<ViewportHarness />);
    const wrap = screen.getByTestId("nb2-canvas-wrap");

    for (let i = 0; i < 40; i++) {
      act(() => {
        fireEvent.wheel(wrap, { deltaY: -200, ctrlKey: true });
      });
    }
    expect(Number(screen.getByTestId("zoom-value").textContent)).toBe(ZOOM_MAX);

    for (let i = 0; i < 60; i++) {
      act(() => {
        fireEvent.wheel(wrap, { deltaY: 200, ctrlKey: true });
      });
    }
    expect(Number(screen.getByTestId("zoom-value").textContent)).toBe(ZOOM_MIN);
  });
});
