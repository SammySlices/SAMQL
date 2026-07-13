import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import {
  NODEFLOW_FILE_FORMAT,
  NODEFLOW_FILE_VERSION,
  NODEFLOW_TABS_VERSION,
  parseNodeFlowGraph,
  parseNodeFlowTabs,
} from "./nodeFlowModel";
import { NB_FILE_VERSION, parseNotebookDocument } from "./notebook";
import {
  WF_FILE_VERSION,
  WF_PAYLOAD_VERSION,
  parseWfFile,
  wfEnvelope,
} from "./workflowFile";

describe("Phase 10 release compatibility", () => {
  it("runs migrations sequentially without mutating the recovery input", () => {
    const original = { version: 0, nested: { value: 7 } };
    const result = runMigrations<{ version: number; nested: { value: number }; done: boolean }>(
      original,
      2,
      {
        0: (value) => {
          value.nested.value = 9;
          return { ...value, version: 1 };
        },
        1: (value) => ({ ...value, version: 2, done: true }),
      },
      "fixture",
    );

    expect(result).toMatchObject({ fromVersion: 0, migrated: true });
    expect(result.value).toMatchObject({ version: 2, nested: { value: 9 }, done: true });
    expect(original).toEqual({ version: 0, nested: { value: 7 } });
  });

  it("rejects incomplete, skipping, and non-object migration steps", () => {
    expect(() =>
      runMigrations({ version: 0 }, 2, { 0: (value) => ({ ...value, version: 1 }) }, "fixture"),
    ).toThrow(/migration plan is incomplete at version 1/i);
    expect(() =>
      runMigrations({ version: 0 }, 1, { 0: () => ({ version: 2 }) }, "fixture"),
    ).toThrow(/advance exactly one version/i);
    expect(() =>
      runMigrations({ version: 0 }, 1, { 0: () => [] }, "fixture"),
    ).toThrow(/output must be an object/i);
    expect(() =>
      runMigrations(
        { version: "0" },
        1,
        { 0: () => ({ version: 1 }) },
        "fixture",
      ),
    ).toThrow(/invalid version/i);
  });

  it("round-trips every current workflow kind through the release envelope", () => {
    const payloads = {
      ide: { sql: "select 1" },
      journal: { doc: '{"format":"samql-notebook","version":2,"cells":[]}' },
      node: { nodes: [], edges: [] },
    } as const;

    for (const [kind, payload] of Object.entries(payloads)) {
      const parsed = parseWfFile(wfEnvelope(kind as keyof typeof payloads, "Release", payload));
      expect(parsed).toMatchObject({
        samql: "workflow",
        version: WF_FILE_VERSION,
        payloadVersion: WF_PAYLOAD_VERSION,
        kind,
        payload,
      });
    }
  });

  it("migrates legacy workflow envelopes and rejects future payloads", () => {
    const migrated = parseWfFile(
      JSON.stringify({ samql: "workflow", kind: "ide", payload: { sql: "select 2" } }),
    );
    expect(migrated).toMatchObject({
      version: WF_FILE_VERSION,
      payloadVersion: WF_PAYLOAD_VERSION,
      migratedFrom: 0,
    });

    expect(() =>
      parseWfFile(
        JSON.stringify({
          samql: "workflow",
          version: WF_FILE_VERSION,
          payloadVersion: WF_PAYLOAD_VERSION + 1,
          kind: "ide",
          payload: { sql: "select 3" },
        }),
      ),
    ).toThrow(/newer SamQL version/i);
  });

  it("migrates legacy NodeFlow graphs into a validated current document", () => {
    const graph = parseNodeFlowGraph({
      nodes: [
        { id: "input", type: "input", x: 1, y: 2, config: {} },
        { id: "output", type: "output", x: 20, y: 2, config: {} },
      ],
      edges: [
        {
          from: { node: "input", port: "out" },
          to: { node: "output", port: "in" },
        },
      ],
    });

    expect(graph).toMatchObject({
      format: NODEFLOW_FILE_FORMAT,
      version: NODEFLOW_FILE_VERSION,
      migratedFrom: 0,
    });
    expect(graph.edges[0].id).toBe("edge_0");
  });

  it("rejects malformed current NodeFlow graphs before they reach the canvas", () => {
    const node = { id: "same", type: "input", x: 0, y: 0, config: {} };
    expect(() =>
      parseNodeFlowGraph({
        format: NODEFLOW_FILE_FORMAT,
        version: NODEFLOW_FILE_VERSION,
        nodes: [node, { ...node }],
        edges: [],
      }),
    ).toThrow(/duplicate node id/i);
    expect(() =>
      parseNodeFlowGraph({
        format: NODEFLOW_FILE_FORMAT,
        version: NODEFLOW_FILE_VERSION,
        nodes: [{ ...node, x: Number.NaN }],
        edges: [],
      }),
    ).toThrow(/invalid node/i);
  });

  it("validates current tab indexes while retaining legacy missing-active recovery", () => {
    const migrated = parseNodeFlowTabs({
      tabs: [{ id: "tab-1", name: "Flow" }],
      activeTabId: "missing-tab",
    });
    expect(migrated).toMatchObject({ version: NODEFLOW_TABS_VERSION, migratedFrom: 0 });
    expect(migrated.activeTabId).toBe("missing-tab");

    expect(() =>
      parseNodeFlowTabs({
        version: NODEFLOW_TABS_VERSION,
        tabs: [
          { id: "tab-1", name: "One" },
          { id: "tab-1", name: "Two" },
        ],
        activeTabId: "tab-1",
      }),
    ).toThrow(/duplicate tab id/i);
  });

  it("keeps legacy notebooks readable and rejects future notebook files", () => {
    const notebook = parseNotebookDocument(
      JSON.stringify([{ id: "cell-1", type: "note", text: "release note" }]),
    );
    expect(notebook).toMatchObject({
      format: "samql-notebook",
      version: NB_FILE_VERSION,
      migratedFrom: 0,
    });

    expect(() =>
      parseNotebookDocument(
        JSON.stringify({
          format: "samql-notebook",
          version: NB_FILE_VERSION + 1,
          cells: [],
        }),
      ),
    ).toThrow(/newer SamQL version/i);
  });
});
