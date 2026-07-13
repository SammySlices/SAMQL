import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface RunProgress {
  value: number | null; // 0..1 when the op reports a real fraction, else null
  rows: number | null;
  unit: string | null;
  done: number | null;
  total: number | null;
}

const EMPTY: RunProgress = {
  value: null,
  rows: null,
  unit: null,
  done: null,
  total: null,
};

// While `active`, poll /api/status and surface the running operation's
// progress for the Run bar. Prefer the op whose id matches this run (`opId`);
// otherwise fall back to the busiest in-flight op (lowest idle time). The poll
// is bounded (api.status carries a timeout) and single-flighted, so it can
// neither stack up nor hang the surface, and it stops the moment the run ends.
export function useRunProgress(
  active: boolean,
  opId?: string | null,
): RunProgress {
  const [prog, setProg] = useState<RunProgress>(EMPTY);
  const inflight = useRef(false);

  useEffect(() => {
    if (!active) {
      setProg(EMPTY);
      return;
    }
    let stopped = false;
    const tick = async () => {
      if (inflight.current || stopped) return;
      inflight.current = true;
      try {
        const s = await api.status();
        const ops = (s && s.operations) || [];
        let op = opId ? ops.find((o) => o.id === opId) : undefined;
        if (!op && ops.length) {
          op = ops.slice().sort((a, b) => a.idle_s - b.idle_s)[0];
        }
        if (!op) {
          setProg(EMPTY);
        } else {
          const pct = typeof op.percent === "number" ? op.percent : null;
          setProg({
            value: pct != null ? Math.max(0, Math.min(1, pct / 100)) : null,
            rows: typeof op.rows === "number" ? op.rows : null,
            unit: op.unit ?? null,
            done: op.done ?? null,
            total: op.total ?? null,
          });
        }
      } catch {
        /* transient — keep the last reading until the next poll */
      } finally {
        inflight.current = false;
      }
    };
    void tick();
    const iv = window.setInterval(tick, 750);
    return () => {
      stopped = true;
      window.clearInterval(iv);
    };
  }, [active, opId]);

  return prog;
}
