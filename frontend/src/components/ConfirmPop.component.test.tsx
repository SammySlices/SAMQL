import React, { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConfirmPop } from "./ConfirmPop";

function ConfirmHarness({
  openMessage,
  confirmLabel = "Drop",
  onOk,
}: {
  openMessage: string;
  confirmLabel?: string;
  onOk?: () => void;
}) {
  const { ui, ask } = useConfirmPop();
  useEffect(() => {
    ask(
      { left: 40, top: 40, side: "right" },
      openMessage,
      onOk || (() => {}),
      confirmLabel,
    );
  }, [ask, openMessage, confirmLabel, onOk]);
  return <>{ui}</>;
}

describe("ConfirmPop delete confirmation", () => {
  it("shows a long drop message and dismisses on Cancel with exit pop", async () => {
    const longName =
      "very_long_table_name_without_spaces_that_used_to_spill_past_the_modal_edge";
    const msg = `Drop table "${longName}"? This cannot be undone.`;
    render(<ConfirmHarness openMessage={msg} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toMatch(/nb2-delconfirm/);
    expect(dialog.querySelector(".nb2-delconfirm-msg")?.textContent).toContain(
      longName,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog.className).toMatch(/\bclosing\b/));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("confirms and dismisses via the danger action", async () => {
    const onOk = vi.fn();
    render(
      <ConfirmHarness
        openMessage="Drop 2 tables? (a, b)"
        confirmLabel="Drop"
        onOk={onOk}
      />,
    );

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    await waitFor(() => expect(onOk).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
