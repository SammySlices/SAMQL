import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { api } from "../lib/api";
import {
  flattenFamilyOrderAfterReorder,
  groupRelationalFamilies,
} from "../lib/notebook";
import type { TableInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    reorderTables: vi.fn(() => Promise.resolve({ ok: true })),
    catalogColumns: vi.fn(() => Promise.resolve({ columns: [] })),
    columnFields: vi.fn(() => Promise.resolve({ fields: [] })),
  },
}));

function tbl(name: string, extra?: Partial<TableInfo>): TableInfo {
  return {
    engine: "duckdb",
    name,
    source: `${name}.csv`,
    row_count: 1,
    columns: [{ name: "id", type: "INTEGER" }],
    ...extra,
  };
}

const noop = () => {};

function renderSidebar(
  tables: TableInfo[],
  onRefresh = vi.fn(),
  extra: Record<string, unknown> = {},
) {
  return render(
    <Sidebar
      tables={tables}
      history={[]}
      saved={[]}
      workflows={[]}
      onInsertTable={noop}
      onInsertColumn={noop}
      onLoadSql={noop}
      onProfile={noop}
      onReconcile={noop}
      onChangeType={noop}
      onRename={noop}
      onDrop={noop}
      onDropMany={noop}
      onOptimize={noop}
      onImport={noop}
      onDisconnect={noop}
      onDeleteSaved={noop}
      onLoadWorkflow={noop}
      onDeleteWorkflow={noop}
      onActiveSave={noop}
      onActiveSaveAs={noop}
      onActiveOpen={noop}
      activeView="ide"
      onRefresh={onRefresh}
      onClearHistory={noop}
      onOpenLoad={noop}
      {...extra}
    />,
  );
}

describe("flattenFamilyOrderAfterReorder", () => {
  it("keeps children under their root when roots move", () => {
    const families = groupRelationalFamilies([
      tbl("hub"),
      tbl("legs", { parent: "hub", columns: [{ name: "_rid", type: "BIGINT" }] }),
      tbl("other"),
    ]);
    expect(families.map((f) => f.table.name)).toEqual(["hub", "other"]);
    const order = flattenFamilyOrderAfterReorder(families, 0, 1);
    expect(order.map((o) => o.name)).toEqual(["other", "hub", "legs"]);
  });
});

describe("Sidebar Tables pin button", () => {
  // Build every prop once so a re-render changes ONLY tablesPinned. Sidebar is
  // React.memo'd; the memo comparator must still let a pin-state change through,
  // which it only does if it compares tablesPinned. Passing fresh arrays/
  // callbacks would defeat the memo for unrelated reasons and hide the bug.
  const stableProps = {
    tables: [tbl("alpha")],
    history: [],
    saved: [],
    workflows: [],
    onInsertTable: noop,
    onInsertColumn: noop,
    onLoadSql: noop,
    onProfile: noop,
    onReconcile: noop,
    onChangeType: noop,
    onRename: noop,
    onDrop: noop,
    onDropMany: noop,
    onOptimize: noop,
    onImport: noop,
    onDisconnect: noop,
    onDeleteSaved: noop,
    onLoadWorkflow: noop,
    onDeleteWorkflow: noop,
    onActiveSave: noop,
    onActiveSaveAs: noop,
    onActiveOpen: noop,
    activeView: "ide" as const,
    onRefresh: noop,
    onClearHistory: noop,
    onOpenLoad: noop,
    onToggleTablesPin: noop,
  };

  it("reflects the active pin state through the memo comparator", () => {
    const { rerender } = render(
      <Sidebar {...stableProps} tablesPinned={false} />,
    );

    const pin = screen.getByTestId("tables-panel-pin-tab");
    expect(pin.className).not.toContain("pin-on");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveTextContent("Pin");

    // Only tablesPinned changes; every other prop keeps its identity, so this
    // isolates the memo comparator. Before the fix the comparator ignored
    // tablesPinned and React.memo swallowed this update — the button stayed
    // grey/"Pin".
    rerender(<Sidebar {...stableProps} tablesPinned />);

    const pinned = screen.getByTestId("tables-panel-pin-tab");
    expect(pinned.className).toContain("pin-on");
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    expect(pinned).toHaveTextContent("Pinned");
    // the icon carries the class CSS paints with the green accent
    expect(pinned.querySelector("svg")?.getAttribute("class")).toContain(
      "pin-on",
    );
  });

  it("fires the toggle handler on click", () => {
    const onToggleTablesPin = vi.fn();
    render(
      <Sidebar
        {...stableProps}
        tablesPinned={false}
        onToggleTablesPin={onToggleTablesPin}
      />,
    );
    fireEvent.click(screen.getByTestId("tables-panel-pin-tab"));
    expect(onToggleTablesPin).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar loaded-tables drag reorder", () => {
  beforeEach(() => {
    vi.mocked(api.reorderTables).mockClear();
  });

  it("exposes a drag grip on each local root when 2+ tables are loaded", () => {
    renderSidebar([tbl("alpha"), tbl("bravo")]);
    const grips = screen.getAllByLabelText("Drag to reorder tables");
    expect(grips).toHaveLength(2);
  });

  it("hides grips while the table filter is active", () => {
    renderSidebar([tbl("alpha"), tbl("bravo")]);
    fireEvent.change(screen.getByPlaceholderText("Filter tables…"), {
      target: { value: "alp" },
    });
    expect(screen.queryByLabelText("Drag to reorder tables")).toBeNull();
  });

  it("does not show a far-left family expand caret on relational roots", () => {
    renderSidebar([
      tbl("hub"),
      tbl("legs", { parent: "hub", columns: [{ name: "_rid", type: "BIGINT" }] }),
      tbl("other"),
    ]);
    expect(document.querySelector(".fam-caret")).toBeNull();
    // Child tables still render nested under the root.
    expect(document.querySelector(".fam-kids")?.textContent).toContain("legs");
    // Per-table column expand twists remain (not the removed family caret).
    expect(document.querySelectorAll(".tree-row .twist").length).toBeGreaterThan(0);
  });

  it("posts the flattened family order and refreshes on drop", async () => {
    const onRefresh = vi.fn();
    const tables = [
      tbl("hub"),
      tbl("legs", { parent: "hub", columns: [{ name: "_rid", type: "BIGINT" }] }),
      tbl("other"),
    ];
    renderSidebar(tables, onRefresh);

    const grips = screen.getAllByLabelText("Drag to reorder tables");
    expect(grips).toHaveLength(2); // roots only; child has no grip

    const blocks = document.querySelectorAll(".fam-block");
    expect(blocks.length).toBe(2);

    fireEvent.dragStart(grips[0], {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });
    fireEvent.dragOver(blocks[1], {
      dataTransfer: { dropEffect: "move" },
    });
    fireEvent.drop(blocks[1], {
      dataTransfer: { getData: () => "0" },
    });

    await waitFor(() => expect(api.reorderTables).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.reorderTables).mock.calls[0][0]).toEqual([
      { engine: "duckdb", name: "other" },
      { engine: "duckdb", name: "hub" },
      { engine: "duckdb", name: "legs" },
    ]);
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("keeps selection checkbox + insert click on the table name", () => {
    const onInsert = vi.fn();
    render(
      <Sidebar
        tables={[tbl("alpha"), tbl("bravo")]}
        history={[]}
        saved={[]}
        workflows={[]}
        onInsertTable={onInsert}
        onInsertColumn={noop}
        onLoadSql={noop}
        onProfile={noop}
        onReconcile={noop}
        onChangeType={noop}
        onRename={noop}
        onDrop={noop}
        onDropMany={noop}
        onOptimize={noop}
        onImport={noop}
        onDisconnect={noop}
        onDeleteSaved={noop}
        onLoadWorkflow={noop}
        onDeleteWorkflow={noop}
        onActiveSave={noop}
        onActiveSaveAs={noop}
        onActiveOpen={noop}
        activeView="ide"
        onRefresh={noop}
        onClearHistory={noop}
        onOpenLoad={noop}
      />,
    );
    fireEvent.click(screen.getByText("alpha"));
    expect(onInsert).toHaveBeenCalledWith("alpha");
    const boxes = screen.getAllByTitle("Select for bulk delete");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
  });

  it("lifts the row while dragging and pops on drop", async () => {
    renderSidebar([tbl("alpha"), tbl("bravo")]);
    const grips = screen.getAllByLabelText("Drag to reorder tables");
    const blocks = document.querySelectorAll(".fam-block");
    fireEvent.dragStart(grips[0], {
      dataTransfer: { setData: vi.fn(), effectAllowed: "move" },
    });
    await waitFor(() => expect(blocks[0].className).toMatch(/\bdragging\b/));
    fireEvent.drop(blocks[1], {
      dataTransfer: { getData: () => "0" },
    });
    await waitFor(() => expect(api.reorderTables).toHaveBeenCalled());
    await waitFor(() => {
      const popped = document.querySelector(".fam-block.drop-pop");
      expect(popped).toBeTruthy();
      expect(popped?.textContent).toContain("alpha");
    });
  });
});

describe("Sidebar source-changed badge copy", () => {
  it("shows Updating… for auto-reload and Reload failed on error", () => {
    renderSidebar([
      tbl("fresh"),
      tbl("pending", { source_changed: true }),
      tbl("broken", {
        source_changed: true,
        source_reload_error: "No reloadable source file",
      }),
    ]);
    expect(screen.getByTestId("source-changed-badge")).toHaveTextContent(
      "Updating…",
    );
    expect(screen.getByTestId("source-changed-badge").getAttribute("title")).toMatch(
      /Updating this table in place/i,
    );
    expect(screen.getByTestId("source-reload-error-badge")).toHaveTextContent(
      "Reload failed",
    );
    expect(
      screen.getByTestId("source-reload-error-badge").getAttribute("title"),
    ).toMatch(/Auto-reload failed/i);
  });
});

describe("Sidebar Open / Save section", () => {
  it("lists Open, Save, then Save As under Open / Save", () => {
    const onOpen = vi.fn();
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(
      <Sidebar
        tables={[]}
        history={[]}
        saved={[]}
        workflows={[]}
        onInsertTable={noop}
        onInsertColumn={noop}
        onLoadSql={noop}
        onProfile={noop}
        onReconcile={noop}
        onChangeType={noop}
        onRename={noop}
        onDrop={noop}
        onDropMany={noop}
        onOptimize={noop}
        onImport={noop}
        onDisconnect={noop}
        onDeleteSaved={noop}
        onLoadWorkflow={noop}
        onDeleteWorkflow={noop}
        onActiveSave={onSave}
        onActiveSaveAs={onSaveAs}
        onActiveOpen={onOpen}
        activeView="ide"
        onRefresh={noop}
        onClearHistory={noop}
        onOpenLoad={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Workflows/i }));
    const section = screen.getByTestId("open-save-section");
    expect(section).toHaveTextContent("Open / Save");
    const open = screen.getByTestId("workspace-open");
    const save = screen.getByTestId("workspace-save");
    const saveAs = screen.getByTestId("workspace-save-as");
    expect(
      open.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      save.compareDocumentPosition(saveAs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(open);
    fireEvent.click(save);
    fireEvent.click(saveAs);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSaveAs).toHaveBeenCalledTimes(1);
  });
});
