import { describe, expect, it } from "vitest";
import { TAB_KEY, type NbNode } from "./nodeFlowModel";
import { persistNodeFlowSnapshot } from "./nodeFlowPersistence";

const node: NbNode = {
  id: "filter",
  type: "filter",
  x: 10,
  y: 20,
  config: { field: "amount", op: ">=", value: "20", condition: "[amount] >= 20" },
};

describe("NodeFlow persistence", () => {
  it("writes the latest graph in the current file format", () => {
    expect(persistNodeFlowSnapshot(localStorage, "tab-1", { nodes: [node], edges: [] })).toBe(true);
    const raw = localStorage.getItem(TAB_KEY("tab-1"));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.format).toBe("samql-nodeflow");
    expect(parsed.version).toBe(4);
    expect(parsed.nodes[0].config.value).toBe("20");
    expect(parsed.nodes[0].config.condition).toBe("[amount] >= 20");
  });

  it("fails closed when storage rejects a lifecycle flush", () => {
    const blocked = { setItem() { throw new DOMException("blocked"); } } as unknown as Storage;
    expect(persistNodeFlowSnapshot(blocked, "tab-1", { nodes: [node], edges: [] })).toBe(false);
  });
});
