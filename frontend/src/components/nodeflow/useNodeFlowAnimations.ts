import { useCallback, useEffect, useRef, useState } from "react";

interface ImplosionOperation {
  timer: number;
  ids: string[];
}

/**
 * Owns the short-lived canvas animation state and every timer/frame that can
 * update it. The bookkeeping is deliberately isolated from NodeFlow so React
 * StrictMode effect replay and editor unmounts cannot leave stale callbacks
 * mutating a later workflow.
 */
export function useNodeFlowAnimations() {
  const [ripple, setRipple] = useState(false);
  const [dyingIds, setDyingIds] = useState<Set<string>>(() => new Set());
  const [dyingEdgeIds, setDyingEdgeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [bornId, setBornId] = useState<string | null>(null);
  /** Lineage-modal highlight — white glow, distinct from green selection / born. */
  const [lineageFlashId, setLineageFlashId] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const rippleTimer = useRef<number | null>(null);
  const rippleFrame = useRef<number | null>(null);
  const bornTimer = useRef<number | null>(null);
  const bornFrame = useRef<number | null>(null);
  const bornIdRef = useRef<string | null>(null);
  const lineageFlashTimer = useRef<number | null>(null);
  const lineageFlashFrame = useRef<number | null>(null);
  const lineageFlashIdRef = useRef<string | null>(null);
  const dyingCounts = useRef<Map<string, number>>(new Map());
  const implosions = useRef<Map<string, ImplosionOperation>>(new Map());
  const edgeRetracts = useRef<Map<string, number>>(new Map());
  const edgeCommitters = useRef<Map<string, () => void>>(new Map());

  const fireRipple = useCallback(() => {
    if (rippleTimer.current != null) {
      window.clearTimeout(rippleTimer.current);
      rippleTimer.current = null;
    }
    if (rippleFrame.current != null) {
      window.cancelAnimationFrame(rippleFrame.current);
      rippleFrame.current = null;
    }
    setRipple(false);
    rippleFrame.current = window.requestAnimationFrame(() => {
      rippleFrame.current = null;
      if (mountedRef.current) setRipple(true);
    });
    rippleTimer.current = window.setTimeout(() => {
      rippleTimer.current = null;
      if (mountedRef.current) setRipple(false);
    }, 1300);
  }, []);

  const fireBorn = useCallback((id: string) => {
    if (bornTimer.current != null) {
      window.clearTimeout(bornTimer.current);
      bornTimer.current = null;
    }
    if (bornFrame.current != null) {
      window.cancelAnimationFrame(bornFrame.current);
      bornFrame.current = null;
    }

    if (bornIdRef.current !== id) {
      bornIdRef.current = id;
      setBornId(id);
    } else {
      bornIdRef.current = null;
      setBornId(null);
      bornFrame.current = window.requestAnimationFrame(() => {
        bornFrame.current = null;
        if (!mountedRef.current) return;
        bornIdRef.current = id;
        setBornId(id);
      });
    }

    bornTimer.current = window.setTimeout(() => {
      bornTimer.current = null;
      bornIdRef.current = null;
      if (mountedRef.current) setBornId(null);
    }, 320);
  }, []);

  const fireLineageFlash = useCallback((id: string) => {
    if (lineageFlashTimer.current != null) {
      window.clearTimeout(lineageFlashTimer.current);
      lineageFlashTimer.current = null;
    }
    if (lineageFlashFrame.current != null) {
      window.cancelAnimationFrame(lineageFlashFrame.current);
      lineageFlashFrame.current = null;
    }

    if (lineageFlashIdRef.current !== id) {
      lineageFlashIdRef.current = id;
      setLineageFlashId(id);
    } else {
      lineageFlashIdRef.current = null;
      setLineageFlashId(null);
      lineageFlashFrame.current = window.requestAnimationFrame(() => {
        lineageFlashFrame.current = null;
        if (!mountedRef.current) return;
        lineageFlashIdRef.current = id;
        setLineageFlashId(id);
      });
    }

    lineageFlashTimer.current = window.setTimeout(() => {
      lineageFlashTimer.current = null;
      lineageFlashIdRef.current = null;
      if (mountedRef.current) setLineageFlashId(null);
    }, 900);
  }, []);

  const withImplosion = useCallback((ids: string[], commit: () => void) => {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) {
      commit();
      return;
    }

    // The document mutation must happen in the document that initiated it.
    // Delaying the commit until the animation ended let a tab switch redirect
    // the callback through current refs into a different workflow. Keep the
    // 230 ms dying state as a visual effect only and commit synchronously.
    // Exact duplicate requests are coalesced until the effect finishes, so a
    // double click cannot create a second history mutation.
    const key = [...uniqueIds].sort().join("\u001f");
    if (implosions.current.has(key)) return;

    for (const id of uniqueIds) {
      dyingCounts.current.set(id, (dyingCounts.current.get(id) || 0) + 1);
    }
    if (mountedRef.current) {
      setDyingIds((current) => new Set([...current, ...uniqueIds]));
    }

    const finish = () => {
      const active = implosions.current.get(key);
      if (!active) return;
      implosions.current.delete(key);
      const finished = new Set<string>();
      for (const id of active.ids) {
        const remaining = Math.max(0, (dyingCounts.current.get(id) || 1) - 1);
        if (remaining === 0) {
          dyingCounts.current.delete(id);
          finished.add(id);
        } else {
          dyingCounts.current.set(id, remaining);
        }
      }
      if (mountedRef.current && finished.size) {
        setDyingIds((current) => {
          const next = new Set(current);
          for (const id of finished) next.delete(id);
          return next;
        });
      }
    };

    // Register before calling commit so a re-entrant duplicate is suppressed.
    implosions.current.set(key, { timer: 0, ids: uniqueIds });
    try {
      commit();
    } catch (error) {
      finish();
      throw error;
    }

    const timer = window.setTimeout(finish, 230);
    implosions.current.set(key, { timer, ids: uniqueIds });
  }, []);

  /**
   * Retract a connector wire, then commit its removal. The edge stays in the
   * graph (with `.retract`) until the animation finishes so the stroke can
   * play. Pending commits flush on unmount so a tab switch never leaves a
   * "zombie" connector behind.
   */
  const withEdgeRetract = useCallback((edgeId: string, commit: () => void) => {
    const id = String(edgeId || "").trim();
    if (!id) {
      commit();
      return;
    }
    if (edgeCommitters.current.has(id)) return;
    if (mountedRef.current) {
      setDyingEdgeIds((current) => new Set([...current, id]));
    }
    const finish = () => {
      if (!edgeCommitters.current.has(id)) return;
      edgeCommitters.current.delete(id);
      const timer = edgeRetracts.current.get(id);
      if (timer != null) {
        window.clearTimeout(timer);
        edgeRetracts.current.delete(id);
      }
      try {
        commit();
      } finally {
        if (mountedRef.current) {
          setDyingEdgeIds((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      }
    };
    edgeCommitters.current.set(id, finish);
    const timer = window.setTimeout(finish, 220);
    edgeRetracts.current.set(id, timer);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const activeImplosions = implosions.current;
    const activeCounts = dyingCounts.current;
    const activeEdges = edgeRetracts.current;
    const activeCommits = edgeCommitters.current;
    return () => {
      mountedRef.current = false;
      if (rippleTimer.current != null) {
        window.clearTimeout(rippleTimer.current);
        rippleTimer.current = null;
      }
      if (rippleFrame.current != null) {
        window.cancelAnimationFrame(rippleFrame.current);
        rippleFrame.current = null;
      }
      if (bornTimer.current != null) {
        window.clearTimeout(bornTimer.current);
        bornTimer.current = null;
      }
      if (bornFrame.current != null) {
        window.cancelAnimationFrame(bornFrame.current);
        bornFrame.current = null;
      }
      if (lineageFlashTimer.current != null) {
        window.clearTimeout(lineageFlashTimer.current);
        lineageFlashTimer.current = null;
      }
      if (lineageFlashFrame.current != null) {
        window.cancelAnimationFrame(lineageFlashFrame.current);
        lineageFlashFrame.current = null;
      }
      for (const operation of activeImplosions.values()) {
        window.clearTimeout(operation.timer);
      }
      activeImplosions.clear();
      activeCounts.clear();
      for (const timer of activeEdges.values()) {
        window.clearTimeout(timer);
      }
      activeEdges.clear();
      for (const finish of [...activeCommits.values()]) {
        try {
          finish();
        } catch {
          /* ignore */
        }
      }
      activeCommits.clear();
    };
  }, []);

  return {
    ripple,
    dyingIds,
    dyingEdgeIds,
    bornId,
    lineageFlashId,
    fireRipple,
    fireBorn,
    fireLineageFlash,
    withImplosion,
    withEdgeRetract,
  };
}
