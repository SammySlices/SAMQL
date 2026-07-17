import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSaveShortcut } from "./useSaveShortcut";

function pressKey(
  key: string,
  mods: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useSaveShortcut", () => {
  it("routes Ctrl+S to the save handler and prevents the browser default", () => {
    const onSave = vi.fn();
    renderHook(() => useSaveShortcut(onSave));

    const event = pressKey("s", { ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes Cmd+S (metaKey) to the save handler for Mac users", () => {
    const onSave = vi.fn();
    renderHook(() => useSaveShortcut(onSave));

    const event = pressKey("S", { metaKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores plain 's' so typing is never treated as save", () => {
    const onSave = vi.fn();
    renderHook(() => useSaveShortcut(onSave));

    const event = pressKey("s");

    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+Shift+S (Save as) and Alt combos alone", () => {
    const onSave = vi.fn();
    renderHook(() => useSaveShortcut(onSave));

    pressKey("s", { ctrlKey: true, shiftKey: true });
    pressKey("s", { ctrlKey: true, altKey: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not bind while disabled", () => {
    const onSave = vi.fn();
    renderHook(() => useSaveShortcut(onSave, false));

    pressKey("s", { ctrlKey: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the latest handler without rebinding", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useSaveShortcut(fn), {
      initialProps: { fn: first },
    });

    rerender({ fn: second });
    pressKey("s", { ctrlKey: true });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("dispatches to the correct surface handler by view", () => {
    // Mirrors App wiring: the shortcut calls one view-routing save function
    // (as activeSave does), which fans out to per-surface save handlers.
    const saves = {
      ide: vi.fn(),
      notebook: vi.fn(),
      nodeflow: vi.fn(),
      dashboard: vi.fn(),
    };
    let view: keyof typeof saves = "ide";
    const activeSave = () => saves[view]();

    renderHook(() => useSaveShortcut(activeSave));

    pressKey("s", { ctrlKey: true });
    expect(saves.ide).toHaveBeenCalledTimes(1);

    view = "notebook";
    pressKey("s", { ctrlKey: true });
    expect(saves.notebook).toHaveBeenCalledTimes(1);

    view = "nodeflow";
    pressKey("s", { ctrlKey: true });
    expect(saves.nodeflow).toHaveBeenCalledTimes(1);

    view = "dashboard";
    pressKey("s", { ctrlKey: true });
    expect(saves.dashboard).toHaveBeenCalledTimes(1);

    expect(saves.ide).toHaveBeenCalledTimes(1);
  });
});
