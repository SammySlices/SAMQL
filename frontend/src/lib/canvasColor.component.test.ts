import { describe, expect, it, beforeEach } from "vitest";
import {
  applyNodeDotStyle,
  normalizeOpacityPercent,
  readPersistedNodeDotStyle,
  persistNodeDotStyle,
  DEFAULT_NODE_DOT_COLOR,
  DEFAULT_NODE_DOT_OPACITY,
  HAS_USER_CANVAS_DOT_CLASS,
  USER_CANVAS_DOT_COLOR_VAR,
  USER_CANVAS_DOT_OPACITY_VAR,
} from "./canvasColor";

describe("canvasColor node dots", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(HAS_USER_CANVAS_DOT_CLASS);
    document.documentElement.style.removeProperty(USER_CANVAS_DOT_COLOR_VAR);
    document.documentElement.style.removeProperty(USER_CANVAS_DOT_OPACITY_VAR);
  });

  it("clamps opacity percent to 0..100", () => {
    expect(normalizeOpacityPercent(-5)).toBe(0);
    expect(normalizeOpacityPercent(140)).toBe(100);
    expect(normalizeOpacityPercent("42")).toBe(42);
    expect(normalizeOpacityPercent(null)).toBeNull();
  });

  it("persists and applies custom dot color + opacity", () => {
    persistNodeDotStyle({ color: "#112233", opacity: 60 });
    expect(localStorage.getItem("samql.canvasDotColor.node")).toBe("#112233");
    expect(localStorage.getItem("samql.canvasDotOpacity.node")).toBe("60");
    applyNodeDotStyle({ color: "#112233", opacity: 60 });
    expect(
      document.documentElement.classList.contains(HAS_USER_CANVAS_DOT_CLASS),
    ).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue(USER_CANVAS_DOT_COLOR_VAR),
    ).toBe("#112233");
    expect(
      document.documentElement.style.getPropertyValue(
        USER_CANVAS_DOT_OPACITY_VAR,
      ),
    ).toBe("60");
  });

  it("fills defaults when only one of color/opacity is set", () => {
    applyNodeDotStyle({ color: "#abcdef", opacity: null });
    expect(
      document.documentElement.style.getPropertyValue(USER_CANVAS_DOT_COLOR_VAR),
    ).toBe("#abcdef");
    expect(
      document.documentElement.style.getPropertyValue(
        USER_CANVAS_DOT_OPACITY_VAR,
      ),
    ).toBe(String(DEFAULT_NODE_DOT_OPACITY));

    applyNodeDotStyle({ color: null, opacity: 10 });
    expect(
      document.documentElement.style.getPropertyValue(USER_CANVAS_DOT_COLOR_VAR),
    ).toBe(DEFAULT_NODE_DOT_COLOR);
    expect(
      document.documentElement.style.getPropertyValue(
        USER_CANVAS_DOT_OPACITY_VAR,
      ),
    ).toBe("10");
  });

  it("clears custom dots when both null", () => {
    applyNodeDotStyle({ color: "#112233", opacity: 50 });
    applyNodeDotStyle({ color: null, opacity: null });
    expect(
      document.documentElement.classList.contains(HAS_USER_CANVAS_DOT_CLASS),
    ).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue(USER_CANVAS_DOT_COLOR_VAR),
    ).toBe("");
  });

  it("reads persisted node dot style", () => {
    localStorage.setItem("samql.canvasDotColor.node", "#010203");
    localStorage.setItem("samql.canvasDotOpacity.node", "33");
    expect(readPersistedNodeDotStyle()).toEqual({
      color: "#010203",
      opacity: 33,
    });
  });
});
