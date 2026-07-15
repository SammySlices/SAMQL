import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlAssistant } from "./SqlAssistant";

vi.mock("../lib/api", () => ({
  api: {
    assistantStatus: vi.fn(),
    assistantChat: vi.fn(),
    assistantCancel: vi.fn(),
  },
}));

import { api } from "../lib/api";

describe("SqlAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.assistantStatus as any).mockResolvedValue({
      available: false,
      pack_ok: false,
      hint: "Copy an offline assistant pack to ./assistant/",
      duckdb_busy: false,
    });
  });

  it("opens from the bottom-right FAB and shows pack hint", async () => {
    render(
      <SqlAssistant
        dialect="native"
        onInsertSql={() => {}}
        onLoadSql={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("sql-assistant-fab"));
    expect(screen.getByTestId("sql-assistant-panel")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByText(/Copy an offline assistant pack/i),
      ).toBeTruthy();
    });
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
    render(
      <SqlAssistant
        dialect="native"
        onInsertSql={onInsert}
        onLoadSql={onLoad}
      />,
    );
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
});
