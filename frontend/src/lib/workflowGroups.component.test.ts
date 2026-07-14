import { describe, expect, it } from "vitest";
import {
  addWorkflowGroup,
  emptyWorkflowGroups,
  groupedNames,
  moveWorkflowToGroup,
  renameWorkflowGroup,
  toggleWorkflowGroupCollapsed,
} from "./workflowGroups";

describe("workflowGroups", () => {
  it("creates groups per kind and moves workflows between them", () => {
    let state = emptyWorkflowGroups();
    state = addWorkflowGroup(state, "node", "Sales");
    const gid = state.groups[0].id;
    state = moveWorkflowToGroup(state, "node", "Flow A", gid);
    expect(state.groups[0].members).toEqual(["Flow A"]);
    expect([...groupedNames(state, "node")]).toEqual(["Flow A"]);

    state = addWorkflowGroup(state, "node", "Ops");
    const gid2 = state.groups[1].id;
    state = moveWorkflowToGroup(state, "node", "Flow A", gid2);
    expect(state.groups[0].members).toEqual([]);
    expect(state.groups[1].members).toEqual(["Flow A"]);

    state = moveWorkflowToGroup(state, "node", "Flow A", null);
    expect(state.groups.every((g) => g.members.length === 0)).toBe(true);
  });

  it("renames and collapses groups", () => {
    let state = addWorkflowGroup(emptyWorkflowGroups(), "ide", "Drafts");
    const id = state.groups[0].id;
    state = renameWorkflowGroup(state, id, "  Ready  ");
    expect(state.groups[0].name).toBe("Ready");
    state = toggleWorkflowGroupCollapsed(state, id);
    expect(state.groups[0].collapsed).toBe(true);
  });
});
