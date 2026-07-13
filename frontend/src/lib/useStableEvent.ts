import { useCallback, useLayoutEffect, useRef } from "react";

// A stable callback identity that always dispatches to the latest implementation.
// This is useful at memoized canvas boundaries: local inspector/palette renders
// do not invalidate the scene, while event handlers never retain stale graph or
// execution-controller closures.
export function useStableEvent<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
