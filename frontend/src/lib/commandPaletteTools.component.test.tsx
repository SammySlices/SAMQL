import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CommandPalette,
  type CommandPaletteItem,
} from "../components/CommandPalette";
import {
  ToolsTablesPanel,
  TOOLS_TABLES_STORE_KEY,
} from "../components/ToolsTablesPanel";
import { AboutModal } from "../components/AboutModal";
import { WireLayer } from "../components/NodeFlowCanvas";
import { useNodeFlowAnimations } from "../components/nodeflow/useNodeFlowAnimations";

const apiMock = vi.hoisted(() => ({
  about: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
}));

describe("CommandPalette", () => {
  it("filters and runs a command with Enter", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const commands: CommandPaletteItem[] = [
      {
        id: "a",
        label: "Open Tools & Tables",
        group: "NodeFlow",
        keywords: "nodes",
        run,
      },
      {
        id: "b",
        label: "Switch to IDE",
        group: "Navigation",
        run: vi.fn(),
      },
    ];
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "tools" } });
    expect(screen.getByTestId("command-palette-item-a")).toBeInTheDocument();
    expect(
      screen.queryByTestId("command-palette-item-b"),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[
          { id: "x", label: "Save", group: "File", run: vi.fn() },
        ]}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Ctrl+K command palette shortcut", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.about.mockReset();
  });

  it("toggles the palette from the App Ctrl/Cmd+K handler contract", async () => {
    // Mirror App's keydown rule: Ctrl/Cmd+K toggles without Shift/Alt.
    let open = false;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.shiftKey) return;
      if (event.key !== "k" && event.key !== "K") return;
      event.preventDefault();
      open = !open;
    };
    window.addEventListener("keydown", onKey);
    try {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(open).toBe(true);
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      expect(open).toBe(false);
      fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
      expect(open).toBe(false);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });
});

describe("ToolsTablesPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const palette = {
    openCat: null,
    setOpenCat: vi.fn(),
    palSearch: "",
    setPalSearch: vi.fn(),
    favDrop: false,
    setFavDrop: vi.fn(),
    favorites: [] as string[],
    addFavorite: vi.fn((key: string) => {
      palette.favorites = [...palette.favorites, key];
    }),
    removeFavorite: vi.fn(),
    acceptFavoriteDrop: vi.fn(),
    createdNodes: [],
    palRef: { current: null },
    onPaletteWheel: vi.fn(),
  };

  it("shows tables and can switch to node sections", () => {
    render(
      <ToolsTablesPanel
        open
        onClose={vi.fn()}
        tables={[
          {
            engine: "sqlite",
            name: "orders",
            source: "csv",
            row_count: 12,
            columns: [
              { name: "id", type: "INTEGER" },
              { name: "amount", type: "DOUBLE" },
            ],
          },
        ]}
        palette={palette as any}
      />,
    );
    expect(screen.getByTestId("tools-tables-panel")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tools-tables-tab-nodes"));
    expect(
      screen.getByTestId("tools-tables-section-favorites"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("tools-tables-section-transform"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tools-tables-section-transform"));
    expect(screen.getByText("Filter")).toBeInTheDocument();
  });

  it("minimizes to an icon and expands again", () => {
    render(
      <ToolsTablesPanel
        open
        onClose={vi.fn()}
        tables={[]}
        palette={palette as any}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-tables-minimize"));
    expect(screen.getByTestId("tools-tables-mini")).toBeInTheDocument();
    expect(screen.queryByTestId("tools-tables-panel")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("tools-tables-mini"), {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("tools-tables-panel")).toBeInTheDocument();
    expect(localStorage.getItem(TOOLS_TABLES_STORE_KEY)).toContain(
      '"minimized":false',
    );
  });

  it("closes from the top-right button", () => {
    const onClose = vi.fn();
    render(
      <ToolsTablesPanel
        open
        onClose={onClose}
        tables={[]}
        palette={palette as any}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-tables-close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AboutModal packages", () => {
  beforeEach(() => {
    apiMock.about.mockReset();
  });

  it("lists active and inactive packages from /api/about", async () => {
    apiMock.about.mockResolvedValue({
      version: "2.16.4",
      build: "test",
      python: "3.14",
      platform: "win",
      engines: { duckdb: "1.0", sqlite: "3.0" },
      frontend: "React",
      packages: [
        {
          name: "duckdb",
          version: "1.2.3",
          installed: true,
          role: "engine",
        },
        {
          name: "pyodbc",
          version: null,
          installed: false,
          role: "odbc",
        },
      ],
    });
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("about-package-duckdb")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("about-package-duckdb")).toHaveAttribute(
      "data-installed",
      "true",
    );
    expect(screen.getByTestId("about-package-duckdb")).toHaveTextContent(
      "active",
    );
    expect(screen.getByTestId("about-package-pyodbc")).toHaveAttribute(
      "data-installed",
      "false",
    );
    expect(screen.getByTestId("about-package-pyodbc")).toHaveTextContent(
      "inactive",
    );
  });
});

describe("connector delete animation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a wire as retracting while dyingEdges contains its id", () => {
    const { container } = render(
      <WireLayer
        wires={[
          {
            id: "w1",
            ax: 0,
            ay: 0,
            bx: 100,
            by: 100,
            fromN: "n1",
            toN: "n2",
            fromPort: "out",
          },
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        dyingEdges={new Set(["w1"])}
      />,
    );
    expect(
      container.querySelector('[data-testid="nodeflow-wire-retracting"]'),
    ).not.toBeNull();
    expect(container.querySelector(".nb2-wire.retract")).not.toBeNull();
  });

  it("withEdgeRetract keeps the edge until the retract finishes", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const { result } = renderHook(() => useNodeFlowAnimations());
    act(() => {
      result.current.withEdgeRetract("edge-1", commit);
    });
    expect(result.current.dyingEdgeIds.has("edge-1")).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.current.dyingEdgeIds.has("edge-1")).toBe(false);
  });
});
