import { useEffect, useRef } from "react";

/**
 * Global Ctrl+S / Cmd+S handler. Prevents the browser "Save page" dialog and
 * routes the keystroke to the same workspace Save handler as the toolbar Save
 * button, so whatever surface the user is on (IDE, Journal, NodeFlow,
 * Dashboard) saves/overwrites through its existing identity logic.
 *
 * The handler is intentionally app-level and view-agnostic: routing by surface
 * lives in the caller's save function. Shift is left alone so Ctrl+Shift+S can
 * remain available for "Save as", and Alt combos are ignored.
 */
export function useSaveShortcut(onSave: () => void, enabled = true) {
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.shiftKey) return;
      if (event.key !== "s" && event.key !== "S") return;
      event.preventDefault();
      onSaveRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
