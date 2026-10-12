import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReconReport } from "./ReconReport";
import type { ReconcileResult } from "../lib/types";
import type { ReconSpec } from "./ReconcileModal";

const spec: ReconSpec = {
  left: "ledger_a",
  right: "ledger_b",
  keys: ["id"],
  compare: [],
  balance: null,
  colmap_a: {},
  colmap_b: {},
};

function reportWithNullKeys(a: number, b: number): ReconcileResult {
  return {
    keys: ["id"],
    totals: {
      a_only: 0,
      b_only: 0,
      matching: 0,
      non_matching: 0,
      a_total: a,
      b_total: b,
      total: 0,
      null_keys: { a, b },
    },
    fields: [],
  };
}

function renderReport(report: ReconcileResult) {
  return render(
    <ReconReport
      report={report}
      spec={spec}
      onProfile={vi.fn()}
      onDrill={vi.fn()}
      onExport={vi.fn()}
    />,
  );
}

describe("ReconReport NULL-key visibility", () => {
  it("warns when NULL-key rows were excluded from match counts", () => {
    renderReport(reportWithNullKeys(3, 0));
    const note = screen.getByRole("alert");
    expect(note.textContent).toMatch(/NULL key rows/i);
    expect(note.textContent).toMatch(/3 in A, 0 in B/i);
    expect(note.textContent).toMatch(/non-match/i);
  });

  it("does not show the warning when neither side has NULL-key rows", () => {
    renderReport(reportWithNullKeys(0, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
