import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal accessibility and lifecycle", () => {
  it("labels the dialog and moves focus inside on mount", () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    outside.focus();

    render(
      <Modal title="Settings" onClose={vi.fn()} testId="settings-modal">
        <button>First action</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: /Close Settings/ })).toHaveFocus();
  });

  it("traps forward and backward Tab navigation inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Confirm" onClose={vi.fn()}>
        <button>First</button>
        <button>Last</button>
      </Modal>,
    );

    const close = screen.getByRole("button", { name: /Close Confirm/ });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(last).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    first.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(close).toHaveFocus();
  });

  it("closes with Escape and prevents duplicate close scheduling", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Modal title="Delete" onClose={onClose}>body</Modal>);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes immediately for reduced motion", () => {
    document.body.classList.add("motion-reduced");
    const onClose = vi.fn();
    render(<Modal title="About" onClose={onClose}>body</Modal>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the launching control after unmount", () => {
    const launch = document.createElement("button");
    launch.textContent = "launch";
    document.body.appendChild(launch);
    launch.focus();
    const { unmount } = render(
      <Modal title="Open" onClose={vi.fn()}>
        <input aria-label="Name" />
      </Modal>,
    );

    expect(launch).not.toHaveFocus();
    unmount();
    expect(launch).toHaveFocus();
  });
});
