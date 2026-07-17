import { describe, expect, it } from "vitest";
import {
  applySelectColumnsReconcile,
  collectSelectFieldPatches,
  filterSelectFields,
  listWiredSelectUpstreams,
  reconcileSelectFields,
  setFieldsKept,
  sortSelectFields,
  type SelField,
} from "./selectFields";

const sample: SelField[] = [
  { name: "amount", keep: true },
  { name: "region", keep: true, rename: "geo_area" },
  { name: "id", keep: false },
];

describe("selectFields search + sort", () => {
  it("filters by name and rename (case-insensitive)", () => {
    expect(filterSelectFields(sample, "").map((f) => f.name)).toEqual([
      "amount",
      "region",
      "id",
    ]);
    expect(filterSelectFields(sample, "am").map((f) => f.name)).toEqual([
      "amount",
    ]);
    expect(filterSelectFields(sample, "GEO").map((f) => f.name)).toEqual([
      "region",
    ]);
    expect(filterSelectFields(sample, "zzz")).toEqual([]);
  });

  it("sorts A→Z and Z→A without dropping settings", () => {
    expect(sortSelectFields(sample, "asc").map((f) => f.name)).toEqual([
      "amount",
      "id",
      "region",
    ]);
    expect(sortSelectFields(sample, "desc").map((f) => f.name)).toEqual([
      "region",
      "id",
      "amount",
    ]);
    expect(sortSelectFields(sample, "asc")[2].rename).toBe("geo_area");
    expect(sortSelectFields(sample, "asc")[1].keep).toBe(false);
  });

  it("All/None while filtered only touches visible names", () => {
    expect(
      setFieldsKept(sample, false, ["amount", "id"]).map((f) => f.keep),
    ).toEqual([false, true, false]);
    expect(setFieldsKept(sample, true).map((f) => f.keep)).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("reconcileSelectFields case-insensitive matching", () => {
  it("preserves keep/rename/type on a case-only upstream rename (Name -> name)", () => {
    const current: SelField[] = [
      { name: "Name", keep: false, rename: "label", type: "text" },
      { name: "amount", keep: true },
    ];
    // upstream renamed "Name" -> "name" (case only); the backend Select
    // matches names case-insensitively, so the user's field must survive.
    const next = reconcileSelectFields(["name", "amount"], current);
    expect(next).toEqual(current);
    // no reset: keep/rename/type kept, and no duplicate "name" appended
    expect(next.map((f) => f.name)).toEqual(["Name", "amount"]);
    expect(next[0].keep).toBe(false);
    expect(next[0].rename).toBe("label");
    expect(next[0].type).toBe("text");
  });

  it("still appends genuinely-new columns and drops removed ones", () => {
    const current: SelField[] = [
      { name: "Region", keep: true, rename: "geo" },
      { name: "gone", keep: true },
    ];
    const next = reconcileSelectFields(["region", "extra"], current);
    // "Region" matches "region" case-insensitively (kept, settings intact);
    // "gone" dropped; "extra" appended new.
    expect(next).toEqual([
      { name: "Region", keep: true, rename: "geo" },
      { name: "extra", keep: true },
    ]);
  });

  it("retains unchecked fields across a temporary upstream shrink/grow (run race)", () => {
    // Reproduce: deselect b, probe briefly returns only a+c (projection /
    // mid-run), then full columns return -- b must stay keep:false, not be
    // re-appended as keep:true.
    const selected: SelField[] = [
      { name: "a", keep: true },
      { name: "b", keep: false },
      { name: "c", keep: true },
    ];
    const shrunk = reconcileSelectFields(["a", "c"], selected);
    expect(shrunk).toEqual([
      { name: "a", keep: true },
      { name: "b", keep: false },
      { name: "c", keep: true },
    ]);
    const grown = reconcileSelectFields(["a", "b", "c"], shrunk);
    expect(grown).toEqual([
      { name: "a", keep: true },
      { name: "b", keep: false },
      { name: "c", keep: true },
    ]);
    expect(grown.find((f) => f.name === "b")?.keep).toBe(false);
  });

  it("still drops kept fields that permanently leave upstream", () => {
    const current: SelField[] = [
      { name: "a", keep: true },
      { name: "gone", keep: true },
      { name: "skip", keep: false },
    ];
    const next = reconcileSelectFields(["a"], current);
    expect(next).toEqual([
      { name: "a", keep: true },
      { name: "skip", keep: false },
    ]);
  });
});

describe("select fields follow upstream Input table changes", () => {
  it("lists only Selects wired on in", () => {
    expect(
      listWiredSelectUpstreams(
        [
          { id: "in1", type: "input" },
          { id: "sel", type: "select" },
          { id: "orphan", type: "select" },
          { id: "filt", type: "filter" },
        ],
        [
          {
            to: { node: "sel", port: "in" },
            from: { node: "in1", port: "out" },
          },
          {
            to: { node: "filt", port: "in" },
            from: { node: "sel", port: "out" },
          },
        ],
      ),
    ).toEqual([
      {
        selectId: "sel",
        kind: "canvas",
        upstreamNode: "in1",
        upstreamPort: "out",
      },
    ]);
  });

  it("lists Selects nested in a group (bound + step-above)", () => {
    expect(
      listWiredSelectUpstreams(
        [
          { id: "in1", type: "input" },
          {
            id: "g",
            type: "group",
            config: {
              children: [
                { id: "sel1", type: "select", config: { fields: [] } },
                { id: "sel2", type: "select", config: { fields: [] } },
              ],
              bindings: {},
            },
          },
        ],
        [
          {
            to: { node: "g", port: "in" },
            from: { node: "in1", port: "out" },
          },
        ],
      ),
    ).toEqual([
      {
        selectId: "sel1",
        kind: "group-input",
        upstreamNode: "in1",
        upstreamPort: "out",
        groupId: "g",
        groupPort: "in",
      },
      {
        selectId: "sel2",
        kind: "step-above",
        groupId: "g",
        childIndex: 1,
      },
    ]);
  });

  it("replaces Select fields when the upstream table schema changes", () => {
    const nodes = [
      {
        id: "in1",
        type: "input",
        config: { table: "orders" },
      },
      {
        id: "sel",
        type: "select",
        config: {
          fields: [
            { name: "order_id", keep: true },
            { name: "amount", keep: false },
          ],
        },
      },
    ];
    const next = applySelectColumnsReconcile(nodes, {
      sel: ["customer_id", "name"],
    });
    expect(next).not.toBe(nodes);
    // kept fields that left upstream are dropped; unchecked fields are
    // retained (tombstones) so a later reappearance cannot re-select them.
    expect(next[1].config.fields).toEqual([
      { name: "amount", keep: false },
      { name: "customer_id", keep: true },
      { name: "name", keep: true },
    ]);
  });

  it("reconciles nested group Selects and collects patches", () => {
    const nodes = [
      {
        id: "g",
        type: "group",
        config: {
          children: [
            {
              id: "nested",
              type: "select",
              config: {
                fields: [{ name: "old", keep: true }],
              },
            },
          ],
        },
      },
    ];
    const next = applySelectColumnsReconcile(nodes, {
      nested: ["a", "b"],
    });
    expect(next[0].config.children[0].config.fields).toEqual([
      { name: "a", keep: true },
      { name: "b", keep: true },
    ]);
    expect(collectSelectFieldPatches(nodes, next)).toEqual([
      {
        id: "nested",
        fields: [
          { name: "a", keep: true },
          { name: "b", keep: true },
        ],
      },
    ]);
  });

  it("returns the same nodes reference when fields already match", () => {
    const nodes = [
      {
        id: "sel",
        type: "select",
        config: {
          fields: reconcileSelectFields(["a", "b"], []),
        },
      },
    ];
    expect(applySelectColumnsReconcile(nodes, { sel: ["a", "b"] })).toBe(nodes);
  });
});
