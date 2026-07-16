import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";
import { buildLongOneLineSql } from "../lib/fieldExplorerSql";

describe("SqlEditor content reachability", () => {
  it("soft-wraps a >100-statement one-liner so content is not clipped to a mega min-width", async () => {
    const sql = buildLongOneLineSql(120);
    expect(sql.includes("\n")).toBe(false);
    expect((sql.match(/SELECT/g) || []).length).toBeGreaterThan(100);

    const { container } = render(
      <div style={{ width: 480, height: 240 }}>
        <SqlEditor
          value={sql}
          onChange={vi.fn()}
          onRunAll={vi.fn()}
          onRunStatement={vi.fn()}
          testId="long-sql-editor"
        />
      </div>,
    );

    const ta = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="long-sql-editor"]',
      ) as HTMLTextAreaElement | null;
      expect(el).toBeTruthy();
      return el!;
    });

    await waitFor(() => {
      // Soft-wrap mode must NOT invent a multi-million-px min-width (that is
      // what browsers clip). jsdom often reports scrollHeight=0, so we assert
      // wrap style + no mega min-width; real browsers grow minHeight.
      const minW = parseFloat(ta.style.minWidth || "0") || 0;
      expect(minW).toBeLessThan(2000);
    });

    const cs = getComputedStyle(ta);
    expect(cs.whiteSpace).toMatch(/pre-wrap/);
    expect(ta.value.length).toBe(sql.length);
    expect(ta.value.includes("\n")).toBe(false);
  });

  it("sizes the textarea so 1000+ logical lines remain reachable via scroll (no ~12-line clip)", async () => {
    const lines = Array.from(
      { length: 1000 },
      (_, i) => `SELECT ${i} AS n;`,
    );
    const sql = lines.join("\n");

    const { container } = render(
      <div style={{ width: 480, height: 240 }}>
        <SqlEditor
          value={sql}
          onChange={vi.fn()}
          onRunAll={vi.fn()}
          onRunStatement={vi.fn()}
          testId="tall-sql-editor"
        />
      </div>,
    );

    const ta = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="tall-sql-editor"]',
      ) as HTMLTextAreaElement | null;
      expect(el).toBeTruthy();
      return el!;
    });

    expect(ta.value.split("\n").length).toBe(1000);
    expect(ta.value.endsWith("SELECT 999 AS n;")).toBe(true);

    await waitFor(() => {
      // Logical-line floor: 1000 * 20px line-height (+ padding) — must not
      // stay stuck near a single viewport (~240px / ~12 lines).
      const minH = parseFloat(ta.style.minHeight || "0") || 0;
      expect(minH).toBeGreaterThanOrEqual(1000 * 20);
    });

    const gutterLines = container.querySelectorAll(".code .gutter .ln");
    expect(gutterLines.length).toBe(1000);

    const hl = container.querySelector(".code pre.hl") as HTMLElement | null;
    expect(hl).toBeTruthy();
    // Must not be viewport-locked via inset:0 (that clipped past ~12 lines).
    expect(getComputedStyle(hl!).bottom).not.toBe("0px");
  });
});
