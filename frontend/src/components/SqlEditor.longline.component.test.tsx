import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";
import { buildLongOneLineSql } from "../lib/fieldExplorerSql";

describe("SqlEditor long one-line SQL", () => {
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
});
