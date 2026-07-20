import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadDataModal } from "./LoadDataModal";

const mocks = vi.hoisted(() => ({
  abortInflight: vi.fn(),
  mssqlDrivers: vi.fn().mockResolvedValue({
    available: true,
    drivers: ["ODBC Driver 18 for SQL Server"],
  }),
  // FileLoadTab seeds Fresh load from the session setting on mount.
  getFreshLoad: vi.fn().mockResolvedValue({ fresh_load: false }),
  setFreshLoad: vi.fn().mockResolvedValue({ fresh_load: false }),
}));

vi.mock("../lib/api", () => ({
  abortInflight: mocks.abortInflight,
  api: {
    mssqlDrivers: mocks.mssqlDrivers,
    getFreshLoad: mocks.getFreshLoad,
    setFreshLoad: mocks.setFreshLoad,
  },
}));

function mount() {
  return render(
    <LoadDataModal
      features={{ duckdb: true, secrets: true } as any}
      onClose={vi.fn()}
      onBeginLoad={vi.fn()}
      onBeginLoadFolder={vi.fn()}
      onLoaded={vi.fn()}
      onError={vi.fn()}
      onBeginHdfsFileLoad={vi.fn()}
    />,
  );
}

describe("LoadDataModal source tabs", () => {
  it("opens with the fast surface (cheaper paint / opacity-only motion)", () => {
    mount();
    const dialog = screen.getByTestId("load-data-modal");
    expect(dialog.className).toMatch(/\bfast\b/);
    expect(dialog.closest(".modal-backdrop")?.className).toMatch(/\bfast\b/);
  });

  it("renders each extracted source form through the shared shell", async () => {
    mount();
    expect(screen.getByText("Choose a file on this computer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /REST API/ }));
    expect(screen.getByText("Endpoint URL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /SQL Server/ }));
    await waitFor(() => expect(mocks.mssqlDrivers).toHaveBeenCalled());
    expect(screen.getByText("Saved profile")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^HDFS$/ }));
    expect(screen.getByText("WebHDFS URL")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Flatten JSON and Export/ }),
    );
    expect(screen.getByText("JSON file")).toBeInTheDocument();
    expect(screen.getByText("Output folder")).toBeInTheDocument();
  });
});
