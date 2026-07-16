import React, { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlAssistant, assistantModelBadge } from "./SqlAssistant";

const copyTextMock = vi.fn(async () => undefined);

vi.mock("../lib/api", () => ({
  api: {
    assistantStatus: vi.fn(),
    assistantChat: vi.fn(),
    assistantCancel: vi.fn(),
  },
  copyText: (...args: unknown[]) => copyTextMock(...args),
}));

import { api } from "../lib/api";

function Harness(props: {
  dialect?: string;
  onInsertSql?: (sql: string) => void;
  onLoadSql?: (sql: string) => void;
  allowInsert?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="sql-assistant-fab"
        onClick={() => setOpen((v) => !v)}
      >
        Open
      </button>
      <SqlAssistant
        dialect={props.dialect ?? "native"}
        open={open}
        onOpenChange={setOpen}
        allowInsert={props.allowInsert}
        onInsertSql={props.onInsertSql ?? (() => {})}
        onLoadSql={props.onLoadSql ?? (() => {})}
      />
    </>
  );
}

describe("assistantModelBadge", () => {
  it("derives a size hint from the real model name", () => {
    expect(assistantModelBadge("Qwen3-4B-Instruct-2507-Q4_K_M")).toBe(" · 4B");
    expect(
      assistantModelBadge("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"),
    ).toBe(" · 1.5B");
    expect(assistantModelBadge("Phi-4-mini-instruct-Q3_K_M")).toMatch(/Phi-4-mini/i);
  });

  it("does not hardcode 1.5B when status has no model yet", () => {
    expect(assistantModelBadge(null)).toBe("");
    expect(assistantModelBadge(undefined)).toBe("");
  });
});

describe("SqlAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyTextMock.mockResolvedValue(undefined);
    (api.assistantStatus as any).mockResolvedValue({
      available: false,
      pack_ok: false,
      hint: "Copy an offline assistant pack to ./assistant/",
      duckdb_busy: false,
    });
  });

  it("shows a badge from status.model_name not a hardcoded 1.5B", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
      model_name: "Qwen3-4B-Instruct-2507-Q4_K_M",
    });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    await waitFor(() => {
      expect(screen.getByText(/DuckDB\s*·\s*4B/i)).toBeTruthy();
    });
    expect(screen.queryByText(/·\s*1\.5B/i)).toBeNull();
  });

  it("opens from the toolbar launcher and shows pack hint", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    expect(screen.getByTestId("sql-assistant-panel")).toBeTruthy();
    // Portaled to document.body (not trapped in App flex stacking).
    expect(screen.getByTestId("sql-assistant-panel").parentElement).toBe(
      document.body,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Copy an offline assistant pack/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/Prefer DuckDB functions/i),
    ).toBeTruthy();
  });

  it("asks the API and offers Insert into IDE for returned SQL", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    (api.assistantChat as any).mockResolvedValue({
      ok: true,
      reply: "Here you go.\n```sql\nSELECT 1;\n```",
      sql: "SELECT 1;",
      dialect: "duckdb",
    });
    const onInsert = vi.fn();
    const onLoad = vi.fn();
    render(<Harness onInsertSql={onInsert} onLoadSql={onLoad} />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));
    await waitFor(() => {
      expect(api.assistantChat).toHaveBeenCalledWith(
        "select one",
        "native",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    const insertBtn = await screen.findByRole("button", {
      name: "Insert into IDE",
    });
    fireEvent.click(insertBtn);
    expect(onInsert).toHaveBeenCalledWith("SELECT 1;");
  });

  it("clears the conversation without calling cancel when idle", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    (api.assistantChat as any).mockResolvedValue({
      ok: true,
      reply: "Here you go.\n```sql\nSELECT 1;\n```",
      sql: "SELECT 1;",
      dialect: "duckdb",
    });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    const clearBtn = screen.getByTestId("sql-assistant-clear");
    expect(clearBtn).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));
    await screen.findByRole("button", { name: "Insert into IDE" });
    expect(screen.getByText("select one")).toBeTruthy();
    expect(clearBtn).toHaveProperty("disabled", false);
    fireEvent.click(clearBtn);
    expect(screen.queryByText("select one")).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert into IDE" })).toBeNull();
    expect(screen.getByText(/Prefer DuckDB functions/i)).toBeTruthy();
    expect(api.assistantCancel).not.toHaveBeenCalled();
    expect(clearBtn).toHaveProperty("disabled", true);
  });

  it("Clear aborts the in-flight request and interrupts the backend while busy", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    let capturedSignal: AbortSignal | undefined;
    (api.assistantChat as any).mockImplementation(
      (_q: string, _d: string, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        // Never resolves on its own — only Stop/Clear ends it.
        return new Promise(() => {});
      },
    );
    (api.assistantCancel as any).mockResolvedValue({ ok: true });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));
    await screen.findByText(/Thinking/i);
    fireEvent.click(screen.getByTestId("sql-assistant-clear"));
    expect(capturedSignal?.aborted).toBe(true);
    expect(api.assistantCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("select one")).toBeNull();
    expect(screen.queryByText(/Thinking/i)).toBeNull();
    expect(screen.getByText(/Prefer DuckDB functions/i)).toBeTruthy();
  });

  it("Stop x next to Thinking aborts the request and interrupts the backend, keeping the thread", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    let capturedSignal: AbortSignal | undefined;
    (api.assistantChat as any).mockImplementation(
      (_q: string, _d: string, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return new Promise(() => {});
      },
    );
    (api.assistantCancel as any).mockResolvedValue({ ok: true });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));
    // The Stop "x" renders in the same row as the "Thinking…" indicator.
    const thinking = await screen.findByText(/Thinking/i);
    const stopBtn = within(thinking.closest(".sql-asst-msg-body") as HTMLElement)
      .getByTestId("sql-assistant-stop");
    expect(stopBtn.getAttribute("aria-label")).toBe("Stop generating");
    // Old footer Stop control is gone (only the inline x cancels now).
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(stopBtn);
    expect(capturedSignal?.aborted).toBe(true);
    expect(api.assistantCancel).toHaveBeenCalledTimes(1);
    // Stop keeps the conversation (the user's question stays).
    expect(screen.getByText("select one")).toBeTruthy();
    expect(screen.queryByText(/Thinking/i)).toBeNull();
  });

  it("copies a chat bubble's full text via the per-message copy control", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    (api.assistantChat as any).mockResolvedValue({
      ok: true,
      reply: "Here is the full assistant answer.",
      dialect: "duckdb",
    });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));

    // Copy the user's own bubble text.
    const userBubble = (await screen.findByText("select one")).closest(
      ".sql-asst-msg",
    ) as HTMLElement;
    fireEvent.click(within(userBubble).getByTestId("sql-assistant-copy-msg"));
    await waitFor(() => {
      expect(copyTextMock).toHaveBeenCalledWith("select one");
    });
    await waitFor(() => {
      expect(
        within(userBubble)
          .getByTestId("sql-assistant-copy-msg")
          .getAttribute("data-copied"),
      ).toBe("1");
    });

    // Copy the assistant reply bubble text.
    const asstBubble = (
      await screen.findByText("Here is the full assistant answer.")
    ).closest(".sql-asst-msg") as HTMLElement;
    fireEvent.click(within(asstBubble).getByTestId("sql-assistant-copy-msg"));
    await waitFor(() => {
      expect(copyTextMock).toHaveBeenCalledWith(
        "Here is the full assistant answer.",
      );
    });
  });

  it("copy-only mode offers Copy SQL and hides Insert / Open in tab", async () => {
    (api.assistantStatus as any).mockResolvedValue({
      available: true,
      pack_ok: true,
      duckdb_busy: false,
    });
    (api.assistantChat as any).mockResolvedValue({
      ok: true,
      reply: "Here you go.\n```sql\nSELECT 1;\n```",
      sql: "SELECT 1;",
      dialect: "duckdb",
    });
    const onInsert = vi.fn();
    const onLoad = vi.fn();
    render(
      <Harness
        allowInsert={false}
        onInsertSql={onInsert}
        onLoadSql={onLoad}
      />,
    );
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    expect(
      screen.getByText(/copy it and paste into a Journal cell/i),
    ).toBeTruthy();
    fireEvent.change(screen.getByTestId("sql-assistant-input"), {
      target: { value: "select one" },
    });
    fireEvent.click(screen.getByTestId("sql-assistant-send"));
    const copyBtn = await screen.findByTestId("sql-assistant-copy");
    expect(screen.queryByRole("button", { name: "Insert into IDE" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in tab" })).toBeNull();
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(copyTextMock).toHaveBeenCalledWith("SELECT 1;");
    });
    expect(onInsert).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
  });
});
