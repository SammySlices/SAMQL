import { describe, expect, it, beforeEach } from "vitest";
import {
  applyNodeDotStyle,
  applyCanvasTextColor,
  applyAllCanvasTextColors,
  applyAllCanvasColors,
  clearAllUserCanvasColors,
  normalizeOpacityPercent,
  readPersistedNodeDotStyle,
  readPersistedCanvasColors,
  readPersistedCanvasTextColors,
  persistNodeDotStyle,
  persistCanvasColor,
  persistCanvasTextColor,
  defaultCanvasTextColor,
  DEFAULT_NODE_DOT_COLOR,
  DEFAULT_NODE_DOT_OPACITY,
  DEFAULT_CANVAS_TEXT_COLOR_DARK,
  DEFAULT_CANVAS_TEXT_COLOR_LIGHT,
  HAS_USER_CANVAS_DOT_CLASS,
  HAS_USER_CANVAS_BG_CLASSES,
  HAS_USER_CANVAS_TEXT_CLASSES,
  USER_CANVAS_DOT_COLOR_VAR,
  USER_CANVAS_DOT_OPACITY_VAR,
  USER_CANVAS_BG_VARS,
  USER_CANVAS_TEXT_VARS,
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

describe("canvasColor text ink", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(
      HAS_USER_CANVAS_TEXT_CLASSES.ide,
      HAS_USER_CANVAS_TEXT_CLASSES.journal,
      HAS_USER_CANVAS_TEXT_CLASSES.node,
      "theme-light",
    );
    document.documentElement.removeAttribute("data-theme");
    for (const v of Object.values(USER_CANVAS_TEXT_VARS)) {
      document.documentElement.style.removeProperty(v);
    }
  });

  it("defaults text wheel to dark or light theme ink", () => {
    expect(defaultCanvasTextColor()).toBe(DEFAULT_CANVAS_TEXT_COLOR_DARK);
    document.documentElement.classList.add("theme-light");
    expect(defaultCanvasTextColor()).toBe(DEFAULT_CANVAS_TEXT_COLOR_LIGHT);
  });

  it("persists and applies per-surface text colors", () => {
    persistCanvasTextColor("ide", "#ffffff");
    persistCanvasTextColor("journal", "#111111");
    persistCanvasTextColor("node", "#54b949");
    expect(localStorage.getItem("samql.canvasTextColor.ide")).toBe("#ffffff");
    expect(localStorage.getItem("samql.canvasTextColor.journal")).toBe(
      "#111111",
    );
    expect(localStorage.getItem("samql.canvasTextColor.node")).toBe("#54b949");
    expect(readPersistedCanvasTextColors()).toEqual({
      ide: "#ffffff",
      journal: "#111111",
      node: "#54b949",
    });
    applyAllCanvasTextColors(readPersistedCanvasTextColors());
    expect(
      document.documentElement.classList.contains(
        HAS_USER_CANVAS_TEXT_CLASSES.ide,
      ),
    ).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue(USER_CANVAS_TEXT_VARS.ide),
    ).toBe("#ffffff");
    expect(
      document.documentElement.style.getPropertyValue(
        USER_CANVAS_TEXT_VARS.node,
      ),
    ).toBe("#54b949");
  });

  it("clears text ink when null", () => {
    applyCanvasTextColor("node", "#abcdef");
    applyCanvasTextColor("node", null);
    expect(
      document.documentElement.classList.contains(
        HAS_USER_CANVAS_TEXT_CLASSES.node,
      ),
    ).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue(
        USER_CANVAS_TEXT_VARS.node,
      ),
    ).toBe("");
  });

  it("clearAllUserCanvasColors removes bg/text overrides for all surfaces", () => {
    persistCanvasColor("ide", "#ffffff");
    persistCanvasColor("journal", "#ececec");
    persistCanvasColor("node", "#e4ebe4");
    persistCanvasTextColor("ide", "#111111");
    persistCanvasTextColor("journal", "#222222");
    persistCanvasTextColor("node", "#54b949");
    localStorage.setItem("samql.canvasColor", "#d8d8d8");
    persistNodeDotStyle({ color: "#aabbcc", opacity: 40 });
    applyAllCanvasColors(readPersistedCanvasColors());
    applyAllCanvasTextColors(readPersistedCanvasTextColors());
    applyNodeDotStyle(readPersistedNodeDotStyle());

    const cleared = clearAllUserCanvasColors();
    expect(cleared.colors).toEqual({ ide: null, journal: null, node: null });
    expect(cleared.textColors).toEqual({
      ide: null,
      journal: null,
      node: null,
    });
    expect(localStorage.getItem("samql.canvasColor.ide")).toBeNull();
    expect(localStorage.getItem("samql.canvasColor.journal")).toBeNull();
    expect(localStorage.getItem("samql.canvasColor.node")).toBeNull();
    expect(localStorage.getItem("samql.canvasTextColor.ide")).toBeNull();
    expect(localStorage.getItem("samql.canvasTextColor.journal")).toBeNull();
    expect(localStorage.getItem("samql.canvasTextColor.node")).toBeNull();
    expect(localStorage.getItem("samql.canvasColor")).toBeNull();
    // Dot overrides are independent of theme canvas bg/text reset.
    expect(localStorage.getItem("samql.canvasDotColor.node")).toBe("#aabbcc");
    expect(localStorage.getItem("samql.canvasDotOpacity.node")).toBe("40");
    for (const surface of ["ide", "journal", "node"] as const) {
      expect(
        document.documentElement.classList.contains(
          HAS_USER_CANVAS_BG_CLASSES[surface],
        ),
      ).toBe(false);
      expect(
        document.documentElement.classList.contains(
          HAS_USER_CANVAS_TEXT_CLASSES[surface],
        ),
      ).toBe(false);
      expect(
        document.documentElement.style.getPropertyValue(
          USER_CANVAS_BG_VARS[surface],
        ),
      ).toBe("");
      expect(
        document.documentElement.style.getPropertyValue(
          USER_CANVAS_TEXT_VARS[surface],
        ),
      ).toBe("");
    }
  });
});
