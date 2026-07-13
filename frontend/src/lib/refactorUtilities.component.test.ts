import { describe, expect, it, vi } from "vitest";
import {
  dumpNamedProfiles,
  parseNamedProfiles,
  readLastProfileName,
} from "./namedProfiles";
import { buildLoadForm } from "./loadForm";
import { startPointerDrag } from "./pointerDrag";
import { buildReconcileRequest } from "./reconcileRequest";

describe("phase-2 shared utilities", () => {
  it("round-trips named profiles and rejects malformed stores", () => {
    const coerce = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { value: String((value as { value?: unknown }).value ?? "") }
        : null;
    const blob = dumpNamedProfiles({ Prod: { value: "x" } }, "Prod");
    expect(parseNamedProfiles(blob, coerce)).toEqual({ Prod: { value: "x" } });
    expect(readLastProfileName(blob)).toBe("Prod");
    expect(parseNamedProfiles("not-json", coerce)).toEqual({});
    expect(parseNamedProfiles(JSON.stringify([]), coerce)).toEqual({});
    expect(parseNamedProfiles(JSON.stringify({ profiles: [] }), coerce)).toEqual({});
    expect(
      parseNamedProfiles(
        JSON.stringify({ profiles: { "": { value: "bad" }, QA: null } }),
        coerce,
      ),
    ).toEqual({});
  });

  it("builds the same canonical multipart payload for both load paths", () => {
    const files = [
      new File(["a"], "a.csv", { type: "text/csv" }),
      new File(["{}"], "b.json", { type: "application/json" }),
    ];
    const form = buildLoadForm(files, {
      destination: "duckdb",
      delimiter: "|",
      sheet: "Sheet 1",
      headerRow: 3,
      mode: "view",
      exclude: "  tmp_*  ",
      flatten: false,
      shred: true,
      rootId: { path: "$.id", name: "id" },
    });
    expect(form.get("destination")).toBe("duckdb");
    expect(form.get("delimiter")).toBe("|");
    expect(form.get("sheet")).toBe("Sheet 1");
    expect(form.get("header_row")).toBe("3");
    expect(form.get("mode")).toBe("view");
    expect(form.get("exclude")).toBe("tmp_*");
    expect(form.get("flatten")).toBe("0");
    expect(form.get("shred")).toBe("1");
    expect(form.get("root_id")).toBe('{"path":"$.id","name":"id"}');
    expect((form.getAll("files") as File[]).map((file) => file.name)).toEqual([
      "a.csv",
      "b.json",
    ]);
  });

  it("owns pointer move/end/cancel listeners and finishes only once", () => {
    const target = new EventTarget();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    startPointerDrag({ target, onMove, onEnd, onCancel });

    target.dispatchEvent(new Event("pointermove"));
    target.dispatchEvent(new Event("pointerup"));
    target.dispatchEvent(new Event("pointerup"));
    target.dispatchEvent(new Event("pointermove"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    const cancelTarget = new EventTarget();
    startPointerDrag({ target: cancelTarget, onMove, onEnd, onCancel });
    cancelTarget.dispatchEvent(new Event("pointercancel"));
    cancelTarget.dispatchEvent(new Event("pointerup"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("builds identical reconcile detail payloads for IDE and Journal", () => {
    const source = {
      left: "left_table",
      right: "right_table",
      keys: ["id"],
      balance: "amount",
      colmap_a: { amount: "left_amount" },
      colmap_b: { amount: "right_amount" },
    };
    const request = buildReconcileRequest(source, "non_matching", "amount");
    expect(request).toEqual({
      left: "left_table",
      right: "right_table",
      keys: ["id"],
      bucket: "non_matching",
      field: "amount",
      balance: "amount",
      colmap_a: { amount: "left_amount" },
      colmap_b: { amount: "right_amount" },
    });
    source.keys.push("mutated");
    source.colmap_a.amount = "changed";
    expect(request.keys).toEqual(["id"]);
    expect(request.colmap_a).toEqual({ amount: "left_amount" });
  });
});
