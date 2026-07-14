/** Client-side Saved Workflows grouping (per kind section). */

import type { WorkflowKind } from "./types";

export const WORKFLOW_GROUPS_KEY = "samql.workflow.groups.v1";

export interface WorkflowGroup {
  id: string;
  kind: WorkflowKind;
  name: string;
  collapsed?: boolean;
  /** Workflow names that belong to this group. */
  members: string[];
}

export interface WorkflowGroupsState {
  version: 1;
  groups: WorkflowGroup[];
}

function newGroupId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyWorkflowGroups(): WorkflowGroupsState {
  return { version: 1, groups: [] };
}

export function loadWorkflowGroups(): WorkflowGroupsState {
  try {
    const raw = window.localStorage?.getItem(WORKFLOW_GROUPS_KEY);
    if (!raw) return emptyWorkflowGroups();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.groups)) {
      return emptyWorkflowGroups();
    }
    const groups: WorkflowGroup[] = [];
    for (const g of parsed.groups) {
      if (!g || typeof g.id !== "string" || typeof g.kind !== "string") continue;
      if (!["ide", "journal", "node", "dashboard"].includes(g.kind)) continue;
      groups.push({
        id: g.id,
        kind: g.kind as WorkflowKind,
        name:
          typeof g.name === "string" && g.name.trim() ? g.name.trim() : "Group",
        collapsed: !!g.collapsed,
        members: Array.isArray(g.members)
          ? g.members.filter((m: unknown) => typeof m === "string")
          : [],
      });
    }
    return { version: 1, groups };
  } catch {
    return emptyWorkflowGroups();
  }
}

export function saveWorkflowGroups(state: WorkflowGroupsState): void {
  try {
    window.localStorage?.setItem(WORKFLOW_GROUPS_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

export function addWorkflowGroup(
  state: WorkflowGroupsState,
  kind: WorkflowKind,
  name = "New group",
): WorkflowGroupsState {
  const group: WorkflowGroup = {
    id: newGroupId(),
    kind,
    name,
    collapsed: false,
    members: [],
  };
  return { version: 1, groups: [...state.groups, group] };
}

export function renameWorkflowGroup(
  state: WorkflowGroupsState,
  id: string,
  name: string,
): WorkflowGroupsState {
  const trimmed = name.trim() || "Group";
  return {
    version: 1,
    groups: state.groups.map((g) =>
      g.id === id ? { ...g, name: trimmed } : g,
    ),
  };
}

export function toggleWorkflowGroupCollapsed(
  state: WorkflowGroupsState,
  id: string,
): WorkflowGroupsState {
  return {
    version: 1,
    groups: state.groups.map((g) =>
      g.id === id ? { ...g, collapsed: !g.collapsed } : g,
    ),
  };
}

export function deleteWorkflowGroup(
  state: WorkflowGroupsState,
  id: string,
): WorkflowGroupsState {
  return {
    version: 1,
    groups: state.groups.filter((g) => g.id !== id),
  };
}

/** Move a workflow into a group (removes it from any other group of same kind). */
export function moveWorkflowToGroup(
  state: WorkflowGroupsState,
  kind: WorkflowKind,
  workflowName: string,
  groupId: string | null,
): WorkflowGroupsState {
  return {
    version: 1,
    groups: state.groups.map((g) => {
      if (g.kind !== kind) return g;
      const without = g.members.filter((m) => m !== workflowName);
      if (groupId && g.id === groupId) {
        return { ...g, members: [...without, workflowName] };
      }
      return { ...g, members: without };
    }),
  };
}

export function groupsForKind(
  state: WorkflowGroupsState,
  kind: WorkflowKind,
): WorkflowGroup[] {
  return state.groups.filter((g) => g.kind === kind);
}

export function groupedNames(
  state: WorkflowGroupsState,
  kind: WorkflowKind,
): Set<string> {
  const set = new Set<string>();
  for (const g of groupsForKind(state, kind)) {
    for (const m of g.members) set.add(m);
  }
  return set;
}
