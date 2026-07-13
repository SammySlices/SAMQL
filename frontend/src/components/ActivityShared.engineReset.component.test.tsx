import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  engineReset: vi.fn(),
  nuke: vi.fn(),
  status: vi.fn(async () => ({
    operations: [],
    engines: { duckdb: { busy: false }, sqlite: { busy: false } },
    threads: 0,
  })),
}));

vi.mock("../lib/api", () => ({
  api: apiMock,
  abortInflight: vi.fn(),
  cancelAllBgOps: vi.fn(),
}));

import { useEngineReset } from "./ActivityShared";

describe("useEngineReset soft reset", () => {
  beforeEach(() => {
    apiMock.engineReset.mockReset();
    apiMock.nuke.mockReset();
  });

  it("calls /api/engine/reset without reloading or nuking", async () => {
    apiMock.engineReset.mockResolvedValue({
      ok: true,
      reset: ["sqlite", "duckdb"],
      rebuilding: true,
    });
    const onDone = vi.fn();
    const reload = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...loc, reload },
    });

    const { result } = renderHook(() => useEngineReset(onDone));

    act(() => {
      result.current.softResetEngines();
    });

    await waitFor(() => expect(apiMock.engineReset).toHaveBeenCalledTimes(1));
    expect(apiMock.nuke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(result.current.resetMsg).toMatch(/rebuilding tables/i);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: loc,
    });
  });
});
