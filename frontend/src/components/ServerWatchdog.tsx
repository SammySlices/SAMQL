// .545: a calm, explicit banner for when the SamQL SERVER goes away
// underneath a still-open window -- the overnight-sleep case, where the
// backend process was reaped while the machine slept and the user came
// back to a raw PyInstaller "failed to remove temp dir" warning instead
// of an explanation. A watchdog pings /api/health on a timer; two
// consecutive failures (so a single dropped beat never flaps) surfaces
// this. Reconnect re-checks: if a server is back (the launcher's .544
// reattach means clicking SamQL again brought one up) it clears
// silently; if not, it tells the user exactly what to do. No raw error,
// no mystery -- "the server stopped; here's how to bring it back".
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Phase = "ok" | "down" | "checking";

export function ServerWatchdog({
  intervalMs = 5000,
}: {
  intervalMs?: number;
}): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>("ok");
  const [recovered, setRecovered] = useState(false);
  const phaseRef = useRef<Phase>("ok");
  const misses = useRef(0);
  const mounted = useRef(false);
  const timers = useRef<Set<number>>(new Set());

  const setSafePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }, []);

  const schedule = useCallback((fn: () => void, delay: number): number => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      if (mounted.current) fn();
    }, delay);
    timers.current.add(id);
    return id;
  }, []);

  const clearScheduled = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current.clear();
  }, []);

  // One health probe through the shared request layer, so timeout, token
  // injection and error behavior stay consistent with every other API call.
  const probe = useCallback(async (): Promise<boolean> => {
    try {
      await api.health();
      return true;
    } catch {
      return false;
    }
  }, []);

  const showRecovered = useCallback(() => {
    if (!mounted.current) return;
    setRecovered(true);
    schedule(() => setRecovered(false), 6000);
  }, [schedule]);

  useEffect(() => {
    mounted.current = true;
    let running = false;

    const tick = async () => {
      if (!mounted.current || running) return;
      running = true;
      const alive = await probe();
      running = false;
      if (!mounted.current) return;

      if (alive) {
        if (phaseRef.current !== "ok" && misses.current >= 2) {
          showRecovered();
        }
        misses.current = 0;
        setSafePhase("ok");
      } else {
        misses.current += 1;
        // Two misses before alarming, so one dropped beat never flaps.
        if (misses.current >= 2) setSafePhase("down");
      }
      schedule(tick, intervalMs);
    };

    schedule(tick, intervalMs);
    return () => {
      mounted.current = false;
      clearScheduled();
    };
  }, [clearScheduled, intervalMs, probe, schedule, setSafePhase, showRecovered]);

  const reconnect = async () => {
    if (phaseRef.current === "checking") return;
    setSafePhase("checking");
    // A few quick retries: a relaunched server may still be binding.
    for (let i = 0; i < 5; i++) {
      if (!mounted.current) return;
      if (await probe()) {
        misses.current = 0;
        setSafePhase("ok");
        showRecovered();
        // A full reload rebinds every panel to the recovered server and
        // triggers its session-restore path cleanly.
        schedule(() => window.location.reload(), 400);
        return;
      }
      await new Promise<void>((resolve) => schedule(resolve, 700));
    }
    if (mounted.current) setSafePhase("down");
  };

  if (recovered && phase === "ok") {
    return (
      <div className="server-watchdog reconnected" role="status">
        <span className="sw-dot ok" />
        Reconnected to the SamQL server.
      </div>
    );
  }
  if (phase === "ok") return null;

  return (
    <div className="server-watchdog" role="alert">
      <span className="sw-dot" />
      <div className="sw-text">
        <strong>The SamQL server stopped — reconnecting…</strong>
        <span>
          This can happen when your computer sleeps or an IT policy
          closes background apps — it isn’t an error in your work, and
          nothing loaded was lost from disk. SamQL is trying to bring the
          server back automatically; if it doesn’t return, click
          Reconnect or launch SamQL again.
        </span>
      </div>
      <button
        className="btn sm"
        onClick={reconnect}
        disabled={phase === "checking"}
      >
        {phase === "checking" ? "Reconnecting…" : "Reconnect"}
      </button>
    </div>
  );
}
