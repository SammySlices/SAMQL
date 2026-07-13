import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Profiler } from "./Profiler";

describe("Profiler Stop", () => {
  it("shows Stop while loading and calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <Profiler
        profile={null}
        loading
        tableName="sales"
        onCancel={onCancel}
      />,
    );
    const stop = screen.getByTestId("profile-stop");
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides Stop when not loading", () => {
    render(
      <Profiler
        profile={{
          table: "sales",
          total_rows: 1,
          columns: [],
        }}
        loading={false}
        tableName="sales"
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("profile-stop")).toBeNull();
  });
});
