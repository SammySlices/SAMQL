import { useRef } from "react";

// Lightweight render instrumentation for profiling re-renders. It is a no-op
// unless `window.__SAMQL_RENDER_DEBUG__` is truthy, so it costs nothing in
// normal use (even in the packaged production build). To use it, open the
// devtools console and run:
//
//     window.__SAMQL_RENDER_DEBUG__ = true
//
// then interact with the app. Each instrumented component logs every render
// and keeps a running tally on `window.__samqlRenders`, e.g.
//
//     window.__samqlRenders        // { Sidebar: 42, DataGrid: 42, ... }
//
// Type a few characters in the SQL editor and watch which components tick up:
// anything other than SqlEditor that climbs on every keystroke is re-rendering
// without needing to, and is a candidate for memoisation.
interface RenderDebugWindow {
  __SAMQL_RENDER_DEBUG__?: boolean;
  __samqlRenders?: Record<string, number>;
}

export function useRenderCount(name: string): void {
  const n = useRef(0);
  n.current += 1;
  if (typeof window === "undefined") return;
  const w = window as unknown as RenderDebugWindow;
  if (!w.__SAMQL_RENDER_DEBUG__) return;
  w.__samqlRenders = w.__samqlRenders || {};
  w.__samqlRenders[name] = n.current;
   
  console.debug(`[samql render] ${name} #${n.current}`);
}
