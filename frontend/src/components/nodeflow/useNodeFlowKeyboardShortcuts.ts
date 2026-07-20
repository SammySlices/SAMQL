import { useEffect, useRef } from "react";

interface NodeFlowKeyboardActions {
  /** When false, shortcuts are registered but ignored (hidden keep-mounted view). */
  enabled?: boolean;
  selectedId: string | null;
  selectedEdgeRef: React.RefObject<string | null>;
  selectedIdsRef: React.RefObject<string[]>;
  undo: () => void;
  redo: () => void;
  copy: () => void;
  paste: () => void;
  deleteEdge: (id: string) => void;
  deleteMany: (ids: string[]) => void;
  deleteNode: (id: string) => void;
}

export function useNodeFlowKeyboardShortcuts(actions: NodeFlowKeyboardActions) {
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = actionsRef.current;
      if (current.enabled === false) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && /INPUT|TEXTAREA|SELECT/.test(target.tagName);

      if ((event.ctrlKey || event.metaKey) && !typing) {
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          current.undo();
          return;
        }
        if ((key === "z" && event.shiftKey) || key === "y") {
          event.preventDefault();
          current.redo();
          return;
        }
        if (key === "c") {
          event.preventDefault();
          current.copy();
          return;
        }
        if (key === "v") {
          event.preventDefault();
          current.paste();
          return;
        }
      }

      if ((event.key === "Delete" || event.key === "Backspace") && !typing) {
        const edge = current.selectedEdgeRef.current;
        if (edge) {
          event.preventDefault();
          current.deleteEdge(edge);
          return;
        }
        const selected = current.selectedIdsRef.current || [];
        if (selected.length > 1) {
          event.preventDefault();
          current.deleteMany(selected.slice());
        } else if (current.selectedId) {
          current.deleteNode(current.selectedId);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
