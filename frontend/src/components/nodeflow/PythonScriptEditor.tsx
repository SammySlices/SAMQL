import React, { useEffect, useRef } from "react";
import { api } from "../../lib/api";

type Toast = (kind: "ok" | "error" | "warn", title: string, msg?: string) => void;

const APPROVE_TYPED_AFTER_MS = 800;

/**
 * The Python node's script box. M-4: a Python node runs only scripts that
 * were approved on this computer (the backend checks the code's hash).
 * What the user types here is theirs, so it is approved once typing settles;
 * a script that arrived in someone else's workflow is approved only with
 * the explicit button, after the user has read it.
 */
export function PythonScriptEditor({
  code,
  onChange,
  onToast,
}: {
  code: string;
  onChange: (code: string) => void;
  onToast: Toast;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    [],
  );
  const typed = (next: string) => {
    onChange(next);
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (next.trim()) void api.pythonTrust([next]).catch(() => {});
    }, APPROVE_TYPED_AFTER_MS);
  };
  const approve = async () => {
    if (!code.trim()) return;
    try {
      const r = await api.pythonTrust([code]);
      if (r.ok) {
        onToast("ok", "Script approved", "This Python node can run now.");
      } else {
        onToast("error", "Couldn't approve the script", r.error || "");
      }
    } catch (e: any) {
      onToast("error", "Couldn't approve the script", e?.message || String(e));
    }
  };
  return (
    <>
      <textarea
        className="nb2-in nb2-sql-area"
        rows={Math.max(8, Math.min(80, String(code || "").split("\n").length + 1))}
        spellCheck={false}
        value={code}
        placeholder={"# columns / rows / df from optional input\nout = df"}
        onChange={(e) => typed(e.target.value)}
      />
      <div className="nb2-hint-sm">
        Python runs with your permissions on this computer and isn&apos;t
        sandboxed. Scripts you type here are approved for you; a script from
        someone else&apos;s workflow runs only after you read it and approve it.
      </div>
      <button className="btn sm nb2-prev" type="button" onClick={() => void approve()}>
        Approve script
      </button>
    </>
  );
}
