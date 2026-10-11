import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReconcileModal } from "./ReconcileModal";
import { api } from "../lib/api";
import * as runController from "../lib/runController";

vi.mock("../lib/api", () => ({
  api: {
    reconcile: vi.fn(),
    status: vi.fn(() => Promise.resolve({ operations: [] })),
    cancelQuery: vi.fn(() => Promise.resolve({ ok: true })),
  },
  saveToDownloads: vi.fn(() => Promise.resolve({ path: "/tmp/out.csv" })),
}));

vi.mock("../lib/runController", () => ({
  registerRun: vi.fn(),
  unregisterRun: vi.fn(),
  cancelOne: vi.fn(),
  isCancelledError: vi.fn(() => false),
}));

// Icon stub — proxied so Icon.Compare and every namespace property work
vi.mock("./Icon", () => {
  const fn: any = () => null;
  const handler = { get: () => () => null };
  return { Icon: new Proxy(fn, handler) };
});

// Modal stub — renders children AND footer (footer holds the Run button)
// open===false returns null; undefined/true renders
vi.mock("./Modal", () => ({
  Modal: ({ children, footer, open }: any) =>
    open === false
      ? null
      : React.createElement("div", { "data-testid": "modal" }, children, footer),
}));

// MultiSelect stub — renders a toggle button with the label text, and when open
// renders checkboxes with aria-label per option so tests can select keys.
vi.mock("./MultiSelect", () => ({
  MultiSelect: ({ label, options, selected, onChange, open, onToggleOpen }: any) =>
    React.createElement(
      "div",
      null,
      React.createElement(
        "button",
        { type: "button", "data-multiselect": label, onClick: onToggleOpen },
        label,
      ),
      open === true &&
        React.createElement(
          "div",
          { role: "listbox" },
          (options || []).map((o: any) =>
            React.createElement("input", {
              key: o.value,
              type: "checkbox",
              "aria-label": o.label ?? o.value,
              checked: !!(selected || []).includes(o.value),
              readOnly: false,
              onChange: () => {
                const next = (selected || []).includes(o.value)
                  ? (selected || []).filter((v: string) => v !== o.value)
                  : [...(selected || []), o.value];
                onChange(next);
              },
            }),
          ),
        ),
    ),
}));

// ---- helpers ----------------------------------------------------------------

const sqliteTable = (name: string) => ({
  engine: "sqlite" as const,
  name,
  source: `${name}.csv`,
  row_count: 10,
  columns: [
    { name: "id", type: "INTEGER" },
    { name: "amount", type: "REAL" },
  ],
});

const duckdbTable = (name: string) => ({
  engine: "duckdb" as const,
  name,
  source: `${name}.csv`,
  row_count: 10,
  columns: [
    { name: "id", type: "INTEGER" },
    { name: "amount", type: "REAL" },
  ],
});

/** Open the "Key columns" multi-select and tick the "id" checkbox. */
async function selectKeyId() {
  const toggle = screen.getByRole("button", { name: "Key columns" });
  fireEvent.click(toggle); // open the dropdown
  const idCheckbox = await screen.findByRole("checkbox", { name: "id" });
  fireEvent.click(idCheckbox); // select id key
  fireEvent.click(toggle); // close (optional — toggles state away from open)
}

const twoSqliteTables = [sqliteTable("left_tbl"), sqliteTable("right_tbl")];

// ---- tests ------------------------------------------------------------------

describe("ReconcileModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----- 1. Engine mismatch disables Run even after a key is selected -----
  it("disables Run when tables are on different engines even after selecting a key", async () => {
    // duckdb + sqlite → engineMismatch = true → canRun = false
    const tables = [duckdbTable("a"), sqliteTable("b")];
    render(
      <ReconcileModal
        tables={tables}
        onClose={vi.fn()}
        onRun={vi.fn()}
        onToast={vi.fn()}
        dataEpoch={1}
      />,
    );

    // Select a key — this removes the keys.length===0 reason for disablement,
    // leaving only engineMismatch to keep Run disabled.
    await selectKeyId();

    const runBtn = screen.getByRole("button", { name: /run reconcile/i });
    // Must still be disabled: engineMismatch overrides keys being set
    expect(runBtn).toBeDisabled();
  });

  // ----- 2. Run calls onRun with the correct epochAtStart -----
  it("calls onRun with epochAtStart equal to the dataEpoch prop at run time", async () => {
    const mockReport = {
      ok: true,
      matched: 5,
      unmatched_left: 0,
      unmatched_right: 0,
      data_epoch: 42,
    };
    vi.mocked(api.reconcile).mockResolvedValue(mockReport as any);

    const onRun = vi.fn();
    render(
      <ReconcileModal
        tables={twoSqliteTables}
        onClose={vi.fn()}
        onRun={onRun}
        onToast={vi.fn()}
        dataEpoch={7}
      />,
    );

    // Select a key to enable Run
    await selectKeyId();

    const runBtn = screen.getByRole("button", { name: /run reconcile/i });
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    await waitFor(() => expect(onRun).toHaveBeenCalled(), { timeout: 3000 });
    // onRun(report, spec, epochAtStart) — third arg must be 7
    const [, , epochAtStart] = onRun.mock.calls[0];
    expect(epochAtStart).toBe(7);
  });

  // ----- 3. Failed run shows an error toast and re-enables Run -----
  it("calls onToast with 'error' and re-enables Run after a failed reconcile", async () => {
    vi.mocked(api.reconcile).mockResolvedValue({
      error: "reconcile failed: division by zero",
    } as any);

    const onToast = vi.fn();
    render(
      <ReconcileModal
        tables={twoSqliteTables}
        onClose={vi.fn()}
        onRun={vi.fn()}
        onToast={onToast}
        dataEpoch={1}
      />,
    );

    await selectKeyId();

    const runBtn = screen.getByRole("button", { name: /run reconcile/i });
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    // Toast must fire with "error" as the first argument
    await waitFor(() => expect(onToast).toHaveBeenCalled(), { timeout: 3000 });
    const [kind] = onToast.mock.calls[0];
    expect(kind).toBe("error");

    // Run button re-enabled after failure (running = false)
    await waitFor(
      () => expect(screen.getByRole("button", { name: /run reconcile/i })).not.toBeDisabled(),
      { timeout: 2000 },
    );
  });

  // ----- 4. Empty-columns tables render without crashing -----
  it("renders without crashing and keeps Run disabled when tables have no columns", async () => {
    const emptyTables = [
      { engine: "sqlite" as const, name: "a", source: "a.csv", row_count: 0, columns: [] },
      { engine: "sqlite" as const, name: "b", source: "b.csv", row_count: 0, columns: [] },
    ];
    render(
      <ReconcileModal
        tables={emptyTables}
        onClose={vi.fn()}
        onRun={vi.fn()}
        onToast={vi.fn()}
        dataEpoch={1}
      />,
    );

    const runBtn = await screen.findByRole("button", { name: /run reconcile/i });
    // No columns → no key options → keys.length===0 → canRun=false
    expect(runBtn).toBeDisabled();
  });

  // ----- 5. Cancel button appears mid-run and calls cancelOne -----
  it("shows a Cancel button during a run and calls cancelOne when clicked", async () => {
    // reconcile never resolves — simulates an in-flight run
    let resolveRun!: (v: any) => void;
    vi.mocked(api.reconcile).mockReturnValue(
      new Promise((res) => { resolveRun = res; }),
    );

    render(
      <ReconcileModal
        tables={twoSqliteTables}
        onClose={vi.fn()}
        onRun={vi.fn()}
        onToast={vi.fn()}
        dataEpoch={1}
      />,
    );

    await selectKeyId();

    const runBtn = screen.getByRole("button", { name: /run reconcile/i });
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    // Cancel / Stop button must appear while the run is in flight
    const cancelBtn = await screen.findByRole("button", { name: /cancel|stop/i }, { timeout: 3000 });
    fireEvent.click(cancelBtn);

    // cancelOne must have been called (abort the in-flight query)
    await waitFor(
      () => expect(vi.mocked(runController.cancelOne)).toHaveBeenCalled(),
      { timeout: 2000 },
    );

    // Settle the pending promise to avoid act() warnings
    resolveRun({ error: "cancelled", cancelled: true });
  });
});
