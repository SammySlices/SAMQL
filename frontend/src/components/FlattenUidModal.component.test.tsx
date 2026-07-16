import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlattenUidModal } from "./FlattenUidModal";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: {
    tableRootIdOptions: vi.fn(),
    tableRootIdStats: vi.fn(),
  },
}));

describe("FlattenUidModal", () => {
  beforeEach(() => {
    vi.mocked(api.tableRootIdOptions).mockResolvedValue({
      ok: true,
      candidates: [
        { steps: ["id"], label: "id", map: false },
        { steps: ["code"], label: "code", map: false },
        // HAL _links scalars must not be the only options shown.
        {
          steps: ["href"],
          in_list: ["_links"],
          label: "_links[1].href -- first element",
          map: false,
        },
        {
          steps: ["rel"],
          in_list: ["_links"],
          label: "_links[1].rel -- first element",
          map: false,
        },
      ],
    } as any);
  });

  it("lists business keys alongside link fields, not href/rel only", async () => {
    render(
      <FlattenUidModal
        open
        engine="duckdb"
        table="orders"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const select = await screen.findByTestId("fx-uid-select");
    const texts = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent || "",
    );
    expect(texts.some((t) => t === "id")).toBe(true);
    expect(texts.some((t) => t === "code")).toBe(true);
    expect(texts.filter((t) => t === "href" || t === "rel")).toHaveLength(0);
  });

  it("warns when the pick is not unique but still allows Confirm Flatten", async () => {
    vi.mocked(api.tableRootIdStats).mockResolvedValue({
      ok: true,
      unique: false,
      records: 10,
      distinct: 8,
      nonnull: 10,
      duplicated: 2,
      nulls: 0,
      label: "code",
    } as any);
    const onConfirm = vi.fn();

    render(
      <FlattenUidModal
        open
        engine="duckdb"
        table="orders"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(await screen.findByTestId("fx-flatten-uid-modal")).toBeTruthy();
    const select = await screen.findByTestId("fx-uid-select");
    fireEvent.change(select, { target: { value: "1" } });

    const verdict = await screen.findByTestId("fx-uid-verdict");
    expect(verdict.textContent).toMatch(/May not be unique/i);
    expect(verdict.textContent).toMatch(/2 duplicate/);
    expect(verdict.textContent).toMatch(/can still proceed/i);
    expect(screen.getByTestId("fx-uid-not-unique-warn")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("fx-uid-confirm")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("fx-uid-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ steps: ["code"], label: "code" }),
    );
  });

  it("enables Confirm Flatten when the pick is unique", async () => {
    vi.mocked(api.tableRootIdStats).mockResolvedValue({
      ok: true,
      unique: true,
      records: 10,
      distinct: 10,
      nonnull: 10,
      duplicated: 0,
      nulls: 0,
      label: "id",
    } as any);
    const onConfirm = vi.fn();

    render(
      <FlattenUidModal
        open
        engine="duckdb"
        table="orders"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(await screen.findByTestId("fx-uid-select"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("fx-uid-confirm")).not.toBeDisabled(),
    );
    expect(screen.getByTestId("fx-uid-verdict").textContent).toMatch(/Unique/i);
    fireEvent.click(screen.getByTestId("fx-uid-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ steps: ["id"], label: "id" }),
    );
  });
});
