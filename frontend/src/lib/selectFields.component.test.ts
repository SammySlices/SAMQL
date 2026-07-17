import { describe, expect, it } from "vitest";
import {
  applySelectColumnsReconcile,
  clearMissingSelectFields,
  collectSelectFieldPatches,
  filterSelectFields,
  isSelectFieldMissingUpstream,
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

  it("still appends genuinely-new columns and retains removed ones as missing", () => {
    const current: SelField[] = [
      { name: "Region", keep: true, rename: "geo" },
      { name: "gone", keep: true },
    ];
    const next = reconcileSelectFields(["region", "extra"], current);
    // "Region" matches "region" case-insensitively (kept, settings intact);
    // "gone" retained as missing tombstone; "extra" appended new.
    expect(next).toEqual([
      { name: "Region", keep: true, rename: "geo" },
      { name: "gone", keep: true },
      { name: "extra", keep: true },
    ]);
    expect(isSelectFieldMissingUpstream(next[1], ["region", "extra"])).toBe(
      true,
    );
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

  it("retains kept fields that leave upstream as missing tombstones (no rename)", () => {
    const current: SelField[] = [
      { name: "a", keep: true },
      { name: "gone", keep: true },
      { name: "skip", keep: false },
    ];
    const next = reconcileSelectFields(["a"], current);
    expect(next).toEqual([
      { name: "a", keep: true },
      { name: "gone", keep: true },
      { name: "skip", keep: false },
    ]);
    expect(isSelectFieldMissingUpstream(next[1], ["a"])).toBe(true);
  });

  it("Clear missing drops only fields whose source is absent upstream", () => {
    const current: SelField[] = [
      { name: "a", keep: true },
      { name: "gone", keep: true },
      { name: "skip", keep: false },
      { name: "renamed_gone", keep: true, rename: "was" },
    ];
    expect(clearMissingSelectFields(current, ["a"])).toEqual([
      { name: "a", keep: true },
    ]);
  });

  it("preserves renames when a join/upstream field is toggled off then on", () => {
    // Reproduce: Select after a join renames id_2; upstream Select turns the
    // duplicate-producing field off (id_2 leaves), then back on.
    const renamed: SelField[] = [
      { name: "id", keep: true, rename: "left_id" },
      { name: "id_2", keep: true, rename: "right_id" },
      { name: "amount", keep: true },
    ];
    const shrunk = reconcileSelectFields(["id", "amount"], renamed);
    expect(shrunk).toEqual([
      { name: "id", keep: true, rename: "left_id" },
      { name: "id_2", keep: true, rename: "right_id" },
      { name: "amount", keep: true },
    ]);
    expect(isSelectFieldMissingUpstream(shrunk[1], ["id", "amount"])).toBe(
      true,
    );
    const restored = reconcileSelectFields(["id", "id_2", "amount"], shrunk);
    expect(restored).toEqual(renamed);
    expect(restored.find((f) => f.name === "id_2")?.rename).toBe("right_id");
  });

  it("keeps a rename tombstone when its source leaves permanently", () => {
    const current: SelField[] = [
      { name: "a", keep: true },
      { name: "gone", keep: true, rename: "was_gone" },
    ];
    const next = reconcileSelectFields(["a"], current);
    expect(next).toEqual([
      { name: "a", keep: true },
      { name: "gone", keep: true, rename: "was_gone" },
    ]);
    expect(isSelectFieldMissingUpstream(next[1], ["a"])).toBe(true);
  });

  it("does not treat blank rename as special — blank rename still retained until Clear missing", () => {
    const current: SelField[] = [
      { name: "a", keep: true },
      { name: "gone", keep: true, rename: "   " },
    ];
    expect(reconcileSelectFields(["a"], current)).toEqual([
      { name: "a", keep: true },
      { name: "gone", keep: true, rename: "   " },
    ]);
    expect(clearMissingSelectFields(current, ["a"])).toEqual([
      { name: "a", keep: true },
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

  it("retains Select fields when the upstream table schema shrinks (missing tombstones)", () => {
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
    // Prior fields stay as missing tombstones; new upstream cols append.
    expect(next[1].config.fields).toEqual([
      { name: "order_id", keep: true },
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
      { name: "old", keep: true },
      { name: "a", keep: true },
      { name: "b", keep: true },
    ]);
    expect(collectSelectFieldPatches(nodes, next)).toEqual([
      {
        id: "nested",
        fields: [
          { name: "old", keep: true },
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

  it("reconciles disconnected Select chains independently (no cross-stream schema)", () => {
    const nodes = [
      {
        id: "sel-a",
        type: "select",
        config: {
          fields: [
            { name: "a1", keep: true },
            { name: "a2", keep: true },
          ],
        },
      },
      {
        id: "sel-b",
        type: "select",
        config: {
          fields: [
            { name: "b1", keep: true },
            { name: "b2", keep: true },
          ],
        },
      },
    ];
    // Only stream A’s upstream schema changed — B must be untouched.
    const next = applySelectColumnsReconcile(nodes, {
      "sel-a": ["a1", "a3"],
    });
    expect(next[0].config.fields).toEqual([
      { name: "a1", keep: true },
      { name: "a2", keep: true },
      { name: "a3", keep: true },
    ]);
    expect(next[1]).toBe(nodes[1]);
    expect(next[1].config.fields).toEqual([
      { name: "b1", keep: true },
      { name: "b2", keep: true },
    ]);
  });

  it("lists each wired Select against its own upstream only", () => {
    expect(
      listWiredSelectUpstreams(
        [
          { id: "in-a", type: "input" },
          { id: "in-b", type: "input" },
          { id: "sel-a", type: "select" },
          { id: "sel-b", type: "select" },
        ],
        [
          {
            to: { node: "sel-a", port: "in" },
            from: { node: "in-a", port: "out" },
          },
          {
            to: { node: "sel-b", port: "in" },
            from: { node: "in-b", port: "out" },
          },
        ],
      ),
    ).toEqual([
      {
        selectId: "sel-a",
        kind: "canvas",
        upstreamNode: "in-a",
        upstreamPort: "out",
      },
      {
        selectId: "sel-b",
        kind: "canvas",
        upstreamNode: "in-b",
        upstreamPort: "out",
      },
    ]);
  });
});
