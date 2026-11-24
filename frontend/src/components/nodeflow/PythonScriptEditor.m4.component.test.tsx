import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { PythonScriptEditor } from "./PythonScriptEditor";

// M-4: Python nodes run only approved scripts. Code the user types in the
// editor is approved for them; code that arrived in someone else's workflow
// is approved with the explicit button after review.
function Harness({ initial, onToast }: { initial: string; onToast: any }) {
  const [code, setCode] = useState(initial);
  return <PythonScriptEditor code={code} onChange={setCode} onToast={onToast} />;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PythonScriptEditor (M-4)", () => {
  it("approves what the user types, once typing settles", async () => {
    vi.useFakeTimers();
    const trust = vi.spyOn(api, "pythonTrust").mockResolvedValue({ ok: true });
    render(<Harness initial="" onToast={vi.fn()} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "out = d" } });
    fireEvent.change(box, { target: { value: "out = df" } });
    expect(trust).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(trust).toHaveBeenCalledTimes(1);
    expect(trust).toHaveBeenCalledWith(["out = df"]);
  });

  it("does not approve a script it only loaded", async () => {
    vi.useFakeTimers();
    const trust = vi.spyOn(api, "pythonTrust").mockResolvedValue({ ok: true });
    render(<Harness initial={"import os  # from a colleague"} onToast={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(trust).not.toHaveBeenCalled();
  });

  it("Approve script approves the shown code and says so", async () => {
    const trust = vi.spyOn(api, "pythonTrust").mockResolvedValue({ ok: true });
    const toast = vi.fn();
    render(<Harness initial={"out = [{'a': 1}]"} onToast={toast} />);
    expect(screen.getByText(/isn.t sandboxed/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve script" }));
    });
    expect(trust).toHaveBeenCalledWith(["out = [{'a': 1}]"]);
    expect(toast).toHaveBeenCalledWith("ok", "Script approved", expect.any(String));
  });
});
