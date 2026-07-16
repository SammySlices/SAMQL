import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      expect(api.assistantChat).toHaveBeenCalledWith("select one", "native");
    });
    const insertBtn = await screen.findByRole("button", {
      name: "Insert into IDE",
    });
    fireEvent.click(insertBtn);
    expect(onInsert).toHaveBeenCalledWith("SELECT 1;");
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
