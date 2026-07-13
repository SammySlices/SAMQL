import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { ServerWatchdog } from "./ServerWatchdog";

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ServerWatchdog", () => {
  it("ignores one dropped probe and alarms only after two consecutive misses", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "health").mockRejectedValue(new Error("offline"));
    render(<ServerWatchdog intervalMs={100} />);

    await advance(100);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(100);
    expect(screen.getByRole("alert")).toHaveTextContent("server stopped");
  });

  it("clears the alarm when a later scheduled probe succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "health")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({} as any);
    render(<ServerWatchdog intervalMs={100} />);

    await advance(100);
    await advance(100);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await advance(100);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Reconnected");
  });

  it("runs explicit reconnect retries and disables duplicate reconnect clicks", async () => {
    vi.useFakeTimers();
    const health = vi.spyOn(api, "health")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({} as any);
    render(<ServerWatchdog intervalMs={100} />);

    await advance(100);
    await advance(100);
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnect);
    expect(reconnect).toBeDisabled();
    await act(async () => { await Promise.resolve(); });

    expect(health).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnected");
  });

  it("cancels scheduled probes on unmount", async () => {
    vi.useFakeTimers();
    const health = vi.spyOn(api, "health").mockResolvedValue({} as any);
    const { unmount } = render(<ServerWatchdog intervalMs={100} />);
    unmount();

    await advance(1000);
    expect(health).not.toHaveBeenCalled();
  });
});
