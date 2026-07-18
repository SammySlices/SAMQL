// Own the window-level listener lifecycle for pointer-driven drags/resizes.
// Callers provide behavior only; this helper guarantees pointerup,
// pointercancel, explicit cleanup, and duplicate-finish protection.

export interface PointerDragOptions {
  onMove: (event: PointerEvent) => void;
  onEnd?: (event: PointerEvent) => void;
  onCancel?: (event: PointerEvent) => void;
  target?: EventTarget;
}

export function startPointerDrag(options: PointerDragOptions): () => void {
  const target = options.target ?? window;
  let active = true;

  const move = (event: Event) => {
    if (active) options.onMove(event as PointerEvent);
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", cancel);
  };
  const end = (event: Event) => {
    if (!active) return;
    cleanup();
    options.onEnd?.(event as PointerEvent);
  };
  const cancel = (event: Event) => {
    if (!active) return;
    cleanup();
    (options.onCancel ?? options.onEnd)?.(event as PointerEvent);
  };

  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", cancel);
  return cleanup;
}

/**
 * Like ``startPointerDrag``, but coalesces ``onMove`` to one call per
 * animation frame (preview/inspector resize, etc.).
 */
export function startPointerDragRaf(options: PointerDragOptions): () => void {
  let raf = 0;
  let last: PointerEvent | null = null;
  const flush = () => {
    raf = 0;
    if (last) options.onMove(last);
    last = null;
  };
  return startPointerDrag({
    ...options,
    onMove: (event) => {
      last = event;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    onEnd: (event) => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (last) {
        options.onMove(last);
        last = null;
      }
      options.onEnd?.(event);
    },
    onCancel: (event) => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      last = null;
      (options.onCancel ?? options.onEnd)?.(event);
    },
  });
}
