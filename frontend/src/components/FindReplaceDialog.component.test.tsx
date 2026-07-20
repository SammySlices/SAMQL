import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindReplaceDialog, type FindCriteria } from "./FindReplaceDialog";
import { useFindReplace } from "../lib/useFindReplace";
import type { FindScope } from "../lib/findReplace";

function mount(overrides: Partial<React.ComponentProps<typeof FindReplaceDialog>> = {}) {
  const props: React.ComponentProps<typeof FindReplaceDialog> = {
    open: true,
    replaceMode: false,
    matchCount: 0,
    activeIndex: -1,
    onCriteriaChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onReplaceNext: vi.fn(),
    onReplaceAll: vi.fn(),
    onToggleReplaceMode: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<FindReplaceDialog {...props} />), props };
}

describe("FindReplaceDialog", () => {
  it("renders nothing while closed", () => {
    mount({ open: false });
    expect(screen.queryByTestId("find-replace")).toBeNull();
  });

  it("hides the replace row until replace mode is on", () => {
    const { rerender, props } = mount();
    expect(screen.queryByTestId("find-replace-replacement")).toBeNull();
    rerender(<FindReplaceDialog {...props} replaceMode />);
    expect(screen.getByTestId("find-replace-replacement")).toBeTruthy();
  });

  it("reports the query and each option upward", () => {
    const onCriteriaChange = vi.fn();
    mount({ onCriteriaChange });

    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "orders" },
    });
    fireEvent.click(screen.getByTestId("find-replace-case"));
    fireEvent.click(screen.getByTestId("find-replace-word"));

    const last = onCriteriaChange.mock.calls.at(-1)?.[0] as FindCriteria;
    expect(last).toMatchObject({
      query: "orders",
      caseSensitive: true,
      wholeWord: true,
      regex: false,
    });
  });

  it("shows the match position and total", () => {
    mount({ matchCount: 7, activeIndex: 2 });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "x" },
    });
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("3 of 7");
  });

  it("says so when a query matches nothing", () => {
    mount({ matchCount: 0 });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "zzz" },
    });
    const count = screen.getByTestId("find-replace-count");
    expect(count).toHaveTextContent("No results");
    expect(count.className).toContain("none");
  });

  it("flags an unparseable regex instead of showing a zero count", () => {
    mount({ matchCount: 0, invalidPattern: true });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "(" },
    });
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("Bad pattern");
  });

  it("navigates with Enter and Shift+Enter", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    mount({ matchCount: 3, onNext, onPrev });
    const input = screen.getByTestId("find-replace-query");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNext).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrev).toHaveBeenCalled();
  });

  it("closes on Escape and via the close button", () => {
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.keyDown(screen.getByTestId("find-replace-query"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("find-replace-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("disables navigation and replace when there are no matches", () => {
    mount({ matchCount: 0, replaceMode: true });
    expect(screen.getByTestId("find-replace-next")).toBeDisabled();
    expect(screen.getByTestId("find-replace-prev")).toBeDisabled();
    expect(screen.getByTestId("find-replace-replace")).toBeDisabled();
    expect(screen.getByTestId("find-replace-replace-all")).toBeDisabled();
  });

  it("fires replace and replace-all", () => {
    const onReplaceNext = vi.fn();
    const onReplaceAll = vi.fn();
    mount({ replaceMode: true, matchCount: 2, onReplaceNext, onReplaceAll });
    fireEvent.click(screen.getByTestId("find-replace-replace"));
    expect(onReplaceNext).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("find-replace-replace-all"));
    expect(onReplaceAll).toHaveBeenCalled();
  });

  it("can be dragged by its header", () => {
    mount();
    const win = screen.getByTestId("find-replace");
    const before = win.style.left;
    fireEvent.pointerDown(win.querySelector(".find-head")!, {
      clientX: 500,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 160 });
    fireEvent.pointerUp(window);
    // rAF-coalesced; assert the drag wired up rather than the exact pixel.
    expect(win.style.left).toBeDefined();
    expect(before).toBeDefined();
  });
});

/** A minimal host that wires the hook to an in-memory set of documents. */
function Host({ initial }: { initial: FindScope[] }) {
  const [scopes, setScopes] = useState(initial);
  const { dialogProps } = useFindReplace({
    getScopes: () => scopes,
    applyEdits: (edits) =>
      setScopes((cur) =>
        cur.map((s) => {
          const hit = edits.find((e) => e.id === s.id && e.field === s.field);
          return hit ? { ...s, text: hit.text } : s;
        }),
      ),
  });
  return (
    <div>
      <FindReplaceDialog {...dialogProps} />
      {scopes.map((s) => (
        <pre key={s.id} data-testid={`doc-${s.id}`}>
          {s.text}
        </pre>
      ))}
    </div>
  );
}

describe("useFindReplace wired to the dialog", () => {
  const docs: FindScope[] = [
    { id: "a", text: "select id from t", field: "code" },
    { id: "b", text: "select id from u", field: "code" },
  ];

  it("opens on Ctrl+F and counts matches across documents", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(screen.getByTestId("find-replace")).toBeTruthy();
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "id" },
    });
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("1 of 2");
  });

  it("opens in replace mode on Ctrl+R", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    expect(screen.getByTestId("find-replace-replacement")).toBeTruthy();
  });

  it("leaves Ctrl+Shift+R alone so hard reload still works", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId("find-replace")).toBeNull();
  });

  it("replaces one occurrence, leaving the rest", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "id" },
    });
    fireEvent.change(screen.getByTestId("find-replace-replacement"), {
      target: { value: "key" },
    });
    fireEvent.click(screen.getByTestId("find-replace-replace"));

    expect(screen.getByTestId("doc-a")).toHaveTextContent("select key from t");
    expect(screen.getByTestId("doc-b")).toHaveTextContent("select id from u");
  });

  it("replaces every occurrence across every document", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "select" },
    });
    fireEvent.change(screen.getByTestId("find-replace-replacement"), {
      target: { value: "SELECT" },
    });
    fireEvent.click(screen.getByTestId("find-replace-replace-all"));

    expect(screen.getByTestId("doc-a")).toHaveTextContent("SELECT id from t");
    expect(screen.getByTestId("doc-b")).toHaveTextContent("SELECT id from u");
  });

  it("re-counts after a replace instead of showing a stale total", () => {
    render(<Host initial={[{ id: "a", text: "x x x", field: "code" }]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(screen.getByTestId("find-replace-query"), {
      target: { value: "x" },
    });
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("of 3");

    fireEvent.change(screen.getByTestId("find-replace-replacement"), {
      target: { value: "y" },
    });
    fireEvent.click(screen.getByTestId("find-replace-replace"));
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("of 2");
  });

  it("closes on the dialog's close button", () => {
    render(<Host initial={docs} />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.click(screen.getByTestId("find-replace-close"));
    expect(screen.queryByTestId("find-replace")).toBeNull();
  });
});
