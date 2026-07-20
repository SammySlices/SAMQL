import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TablesSidebarDrawer } from "./TablesSidebarDrawer";

function Harness({
  enabled = true,
  initialOpen = false,
  inspectorMode = false,
  hoverOpenFull = false,
}: {
  enabled?: boolean;
  initialOpen?: boolean;
  inspectorMode?: boolean;
  hoverOpenFull?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState("tables");
  const [widths, setWidths] = useState<number[]>([]);
  return (
    <div>
      <button type="button" data-testid="outside">
        outside
      </button>
      <TablesSidebarDrawer
        enabled={enabled}
        open={open}
        onOpenChange={setOpen}
        width={280}
        onResizePointerDown={() => setWidths((w) => [...w, 1])}
        inspectorMode={inspectorMode}
        hoverOpenFull={hoverOpenFull}
      >
        <div data-testid="drawer-body">
          <span data-testid="active-tab-label">{tab}</span>
          <button
            type="button"
            data-testid="side-tab-tables"
            onClick={() => {
              setTab("tables");
              setOpen(true);
            }}
          >
            Tables
          </button>
          <button
            type="button"
            data-testid="side-tab-history"
            onClick={() => {
              setTab("history");
              setOpen(true);
            }}
          >
            History
          </button>
          <button
            type="button"
            data-testid="side-tab-saved"
            onClick={() => {
              setTab("saved");
              setOpen(true);
            }}
          >
            Workflows
          </button>
        </div>
      </TablesSidebarDrawer>
      <span data-testid="open-flag">{open ? "open" : "closed"}</span>
      <span data-testid="resize-count">{widths.length}</span>
    </div>
  );
}

describe("TablesSidebarDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed with a left-edge hit strip (panel hidden)", () => {
    render(<Harness />);
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-hover-open-full",
      "0",
    );
    expect(screen.getByTestId("tables-sidebar-drawer").className).toContain(
      "is-closed",
    );
    const edge = screen.getByTestId("tables-sidebar-edge");
    expect(edge).toBeInTheDocument();
    expect(edge).toHaveAttribute("aria-label", "Show tables panel handle");
    expect(edge).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("tables-sidebar-peek")).toBeInTheDocument();
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("edge hover peeks hamburger only (default; does not open panel)", () => {
    render(<Harness />);
    fireEvent.pointerEnter(screen.getByTestId("tables-sidebar-drawer"));
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    expect(drawer).toHaveAttribute("data-open", "0");
    expect(drawer).toHaveAttribute("data-peek", "1");
    expect(drawer.className).toContain("is-peek");
    expect(drawer.className).toContain("is-closed");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
    const menu = screen.getByTestId("tables-sidebar-peek-menu");
    expect(menu).toHaveAttribute("aria-label", "Open tables panel");
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from a click on the peeked hamburger", () => {
    render(<Harness />);
    fireEvent.pointerEnter(screen.getByTestId("tables-sidebar-drawer"));
    fireEvent.click(screen.getByTestId("tables-sidebar-peek-menu"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "1",
    );
    expect(screen.getByTestId("open-flag")).toHaveTextContent("open");
  });

  it("edge click peeks hamburger only (does not open panel)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("tables-sidebar-edge"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-peek",
      "1",
    );
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("hides peek after leave delay when the pointer leaves (panel stays closed)", () => {
    render(<Harness />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerEnter(drawer);
    expect(drawer).toHaveAttribute("data-peek", "1");
    fireEvent.pointerLeave(drawer);
    expect(drawer).toHaveAttribute("data-peek", "1");
    act(() => {
      vi.advanceTimersByTime(279);
    });
    expect(drawer).toHaveAttribute("data-peek", "1");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(drawer).toHaveAttribute("data-peek", "0");
    expect(drawer).toHaveAttribute("data-open", "0");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("does not auto-hide an open panel on pointer leave (default)", () => {
    render(<Harness initialOpen />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerLeave(drawer);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(drawer).toHaveAttribute("data-open", "1");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("open");
  });

  it("cancels peek-hide when the pointer re-enters before the delay", () => {
    render(<Harness />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerEnter(drawer);
    fireEvent.pointerLeave(drawer);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerEnter(drawer);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(drawer).toHaveAttribute("data-peek", "1");
    expect(drawer).toHaveAttribute("data-open", "0");
  });

  it("keeps the handle mounted on the panel while open", () => {
    render(<Harness initialOpen />);
    const peek = screen.getByTestId("tables-sidebar-peek");
    expect(peek).toBeInTheDocument();
    expect(screen.getByTestId("tables-sidebar-panel").contains(peek)).toBe(
      true,
    );
  });

  it("closes from a quick click on the hamburger while open (no drag)", () => {
    render(<Harness initialOpen />);
    const menu = screen.getByTestId("tables-sidebar-peek-menu");
    fireEvent.pointerDown(menu, { clientX: 100, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 101, clientY: 201 });
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    expect(menu).toHaveAttribute("aria-label", "Open tables panel");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("closes from a keyboard-style click while open", () => {
    render(<Harness initialOpen />);
    fireEvent.click(screen.getByTestId("tables-sidebar-peek-menu"));
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("starts resize from the open folder handle on pointerdown", () => {
    render(<Harness initialOpen />);
    expect(screen.getByTestId("resize-count")).toHaveTextContent("0");
    fireEvent.pointerDown(screen.getByTestId("tables-sidebar-peek-menu"), {
      clientX: 280,
      clientY: 200,
    });
    expect(screen.getByTestId("resize-count")).toHaveTextContent("1");
    // Drag past click slop — panel stays open (resize, not toggle).
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 200 });
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "1",
    );
    expect(screen.getByTestId("open-flag")).toHaveTextContent("open");
  });

  it("does not start resize from the closed edge strip", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("tables-sidebar-edge"), {
      clientX: 10,
      clientY: 200,
    });
    expect(screen.getByTestId("resize-count")).toHaveTextContent("0");
  });

  it("does not toggle open class when switching tabs while already open", () => {
    render(<Harness initialOpen />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    expect(drawer.className).toContain("is-open");
    fireEvent.click(screen.getByTestId("side-tab-history"));
    expect(drawer.className).toContain("is-open");
    expect(drawer).toHaveAttribute("data-open", "1");
    fireEvent.click(screen.getByTestId("side-tab-saved"));
    expect(drawer.className).toContain("is-open");
    expect(screen.getByTestId("active-tab-label")).toHaveTextContent("saved");
    // Still a single continuous open state — handle stays, no closed flash.
    expect(screen.getByTestId("tables-sidebar-peek")).toBeInTheDocument();
  });

  it("closes on outside pointerdown and keeps the edge strip", () => {
    render(<Harness initialOpen />);
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    expect(screen.getByTestId("tables-sidebar-edge")).toBeInTheDocument();
    expect(screen.getByTestId("tables-sidebar-peek")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Harness initialOpen />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("hoverOpenFull: edge hover opens the full panel", () => {
    render(<Harness hoverOpenFull />);
    fireEvent.pointerEnter(screen.getByTestId("tables-sidebar-drawer"));
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    expect(drawer).toHaveAttribute("data-open", "1");
    expect(drawer).toHaveAttribute("data-hover-open-full", "1");
    expect(drawer).toHaveAttribute("data-peek", "0");
    expect(drawer.className).toContain("is-open");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("open");
    const menu = screen.getByTestId("tables-sidebar-peek-menu");
    expect(menu).toHaveAttribute(
      "aria-label",
      "Drag to resize, click to close tables panel",
    );
    expect(menu).toHaveAttribute("aria-expanded", "true");
  });

  it("hoverOpenFull: edge click opens the full panel", () => {
    render(<Harness hoverOpenFull />);
    fireEvent.click(screen.getByTestId("tables-sidebar-edge"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "1",
    );
    expect(screen.getByTestId("open-flag")).toHaveTextContent("open");
  });

  it("hoverOpenFull: hides again after leave delay when the pointer leaves", () => {
    render(<Harness hoverOpenFull />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerEnter(drawer);
    expect(drawer).toHaveAttribute("data-open", "1");
    fireEvent.pointerLeave(drawer);
    expect(drawer).toHaveAttribute("data-open", "1");
    act(() => {
      vi.advanceTimersByTime(279);
    });
    expect(drawer).toHaveAttribute("data-open", "1");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(drawer).toHaveAttribute("data-open", "0");
    expect(screen.getByTestId("open-flag")).toHaveTextContent("closed");
  });

  it("hoverOpenFull: cancels leave-hide when the pointer re-enters before the delay", () => {
    render(<Harness hoverOpenFull />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerEnter(drawer);
    fireEvent.pointerLeave(drawer);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerEnter(drawer);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(drawer).toHaveAttribute("data-open", "1");
  });

  it("stays visually open in inspector mode even if open=false", () => {
    render(<Harness inspectorMode />);
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "1",
    );
    expect(screen.getByTestId("tables-sidebar-drawer").className).toContain(
      "is-inspector",
    );
    const peek = screen.getByTestId("tables-sidebar-peek");
    expect(peek).toBeInTheDocument();
    expect(screen.getByTestId("tables-sidebar-panel").contains(peek)).toBe(
      true,
    );
    const menu = screen.getByTestId("tables-sidebar-peek-menu");
    expect(menu).toHaveAttribute(
      "aria-label",
      "Drag to resize, click to close tables panel",
    );
    expect(menu).toHaveAttribute("aria-expanded", "true");
  });

  it("does not auto-hide on pointer leave while in inspector mode", () => {
    render(<Harness inspectorMode />);
    const drawer = screen.getByTestId("tables-sidebar-drawer");
    fireEvent.pointerLeave(drawer);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(drawer).toHaveAttribute("data-open", "1");
  });

  it("requests close from a quick handle click while in inspector mode", () => {
    const onOpenChange = vi.fn();
    const onResize = vi.fn();
    render(
      <TablesSidebarDrawer
        enabled
        open={false}
        onOpenChange={onOpenChange}
        width={280}
        onResizePointerDown={onResize}
        inspectorMode
      >
        <div>inspector</div>
      </TablesSidebarDrawer>,
    );
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "1",
    );
    const menu = screen.getByTestId("tables-sidebar-peek-menu");
    fireEvent.pointerDown(menu, { clientX: 100, clientY: 200 });
    expect(onResize).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { clientX: 100, clientY: 200 });
    // Same path as Escape / outside-click — App clears selection so the dock closes.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when the tables feature is disabled", () => {
    render(<Harness enabled={false} />);
    expect(
      screen.queryByTestId("tables-sidebar-drawer"),
    ).not.toBeInTheDocument();
  });

  it("does not treat modal chrome as outside", () => {
    const onOpenChange = vi.fn();
    render(
      <div>
        <div className="modal" data-testid="modal">
          modal
        </div>
        <TablesSidebarDrawer
          enabled
          open
          onOpenChange={onOpenChange}
          width={280}
          onResizePointerDown={() => {}}
        >
          <div>body</div>
        </TablesSidebarDrawer>
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("modal"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not close on NodeFlow node pointerdown", () => {
    const onOpenChange = vi.fn();
    render(
      <TablesSidebarDrawer
        enabled
        open
        onOpenChange={onOpenChange}
        width={280}
        onResizePointerDown={() => {}}
      >
        <div>tables</div>
      </TablesSidebarDrawer>,
    );
    const node = document.createElement("div");
    node.className = "nb2-node";
    document.body.appendChild(node);
    fireEvent.pointerDown(node);
    expect(onOpenChange).not.toHaveBeenCalled();
    node.remove();
  });

  it("does not close while samqlNfDrag is set", () => {
    const onOpenChange = vi.fn();
    document.documentElement.dataset.samqlNfDrag = "1";
    render(
      <TablesSidebarDrawer
        enabled
        open
        onOpenChange={onOpenChange}
        width={280}
        onResizePointerDown={() => {}}
      >
        <div>tables</div>
      </TablesSidebarDrawer>,
    );
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    delete document.documentElement.dataset.samqlNfDrag;
  });

  it("does not peek or open on pointer enter while samqlNfDrag is set", () => {
    document.documentElement.dataset.samqlNfDrag = "1";
    render(<Harness />);
    fireEvent.pointerEnter(screen.getByTestId("tables-sidebar-drawer"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-peek",
      "0",
    );
    delete document.documentElement.dataset.samqlNfDrag;
  });

  it("does not open on pointer enter while samqlNfDrag is set (hoverOpenFull)", () => {
    document.documentElement.dataset.samqlNfDrag = "1";
    render(<Harness hoverOpenFull />);
    fireEvent.pointerEnter(screen.getByTestId("tables-sidebar-drawer"));
    expect(screen.getByTestId("tables-sidebar-drawer")).toHaveAttribute(
      "data-open",
      "0",
    );
    delete document.documentElement.dataset.samqlNfDrag;
  });
});
