import type { Dispatch, SetStateAction } from "react";
import { api } from "./api";
import { uid } from "./ids";
import {
  cancelOne,
  isCancelledError,
  registerRun,
  unregisterRun,
  wasCancelled,
} from "./runController";
import {
  buildReconcileRequest,
  type ReconcileSourceSpec,
} from "./reconcileRequest";
import type { ReconBucket, ResultPage, TableProfile } from "./types";

export type ResTabPatch = {
  id: string;
  kind: string;
  title?: string;
  resultId?: string | null;
  pinned?: boolean;
  page?: ResultPage | null;
  sortCol?: string | null;
  descending?: boolean;
  view?: string;
  profileTable?: string;
  profileEngine?: string;
  profileLoading?: boolean;
  profile?: TableProfile | null;
  [key: string]: unknown;
};

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  detail?: string,
) => void;

/**
 * Soft-cancellable reconcile drill-down / profile fetches. A new request
 * aborts any in-flight detail call so a stale response cannot patch tabs.
 * Each call registers under a query_id so Activity Stop interrupts both
 * the fetch and the backend statement.
 */
export function createReconDetailController(opts: {
  toast: ToastFn;
  setResTabs: Dispatch<SetStateAction<ResTabPatch[]>>;
  setActiveResId: (id: string) => void;
  patchRes: (id: string, patch: Partial<ResTabPatch>) => void;
  pageLimit: number;
}) {
  let abortCtrl: AbortController | null = null;
  let activeQid: string | null = null;

  const abortReconDetail = () => {
    if (activeQid && abortCtrl) cancelOne(activeQid, abortCtrl);
    else {
      try {
        abortCtrl?.abort();
      } catch {
        /* ignore */
      }
    }
    if (activeQid) unregisterRun(activeQid, abortCtrl || undefined);
    abortCtrl = null;
    activeQid = null;
  };

  const beginDetail = () => {
    abortReconDetail();
    const ctrl = new AbortController();
    const qid = "recon-d-" + uid();
    abortCtrl = ctrl;
    activeQid = qid;
    registerRun(qid, ctrl);
    return { ctrl, qid };
  };

  const endDetail = (qid: string, ctrl: AbortController) => {
    unregisterRun(qid, ctrl);
    if (activeQid === qid) {
      activeQid = null;
      abortCtrl = null;
    }
  };

  const openResultFromId = async (
    resultId: string,
    title: string,
    signal?: AbortSignal,
    queryId?: string,
  ) => {
    const id = uid();
    opts.setResTabs((rs) => [
      ...rs,
      {
        id,
        kind: "result",
        title,
        resultId,
        pinned: true,
        page: null,
        sortCol: null,
        descending: false,
        view: "grid",
      },
    ]);
    opts.setActiveResId(id);
    try {
      const pg = await api.page(
        resultId,
        {
          offset: 0,
          limit: opts.pageLimit,
          ...(queryId ? { query_id: queryId } : {}),
        },
        signal,
      );
      if (signal?.aborted) return;
      opts.patchRes(id, { page: pg });
    } catch (e: any) {
      if (isCancelledError(e, queryId)) return;
      opts.toast("error", "Could not open rows", e?.message);
    }
  };

  const reconDrill = async (
    spec: ReconcileSourceSpec,
    bucket: ReconBucket,
    field: string | null,
  ) => {
    const { ctrl, qid } = beginDetail();
    try {
      const d = await api.reconcileDrilldown(
        buildReconcileRequest(spec, bucket, field, qid),
        ctrl.signal,
      );
      if (ctrl.signal.aborted || wasCancelled(qid) || d.cancelled) return;
      if (d.error) {
        if (/interrupt|cancel/i.test(d.error) || wasCancelled(qid)) {
          opts.toast("warn", "Drill-down cancelled", "Stopped at your request.");
          return;
        }
        opts.toast("error", "Drill-down failed", d.error);
        return;
      }
      if (d.result_id == null || d.count === 0) {
        opts.toast("warn", "No rows", "That bucket is empty.");
        return;
      }
      const fld =
        field && (bucket === "matching" || bucket === "non_matching")
          ? ` · ${field}`
          : "";
      void openResultFromId(
        d.result_id,
        `${bucket.replace("_", " ")}${fld}`,
        ctrl.signal,
        qid,
      );
    } catch (e: any) {
      if (isCancelledError(e, qid) || wasCancelled(qid)) return;
      opts.toast("error", "Drill-down failed", e?.message);
    } finally {
      endDetail(qid, ctrl);
    }
  };

  const reconProfile = async (
    spec: ReconcileSourceSpec & { engine?: string },
    bucket: ReconBucket,
    field: string | null,
  ) => {
    const { ctrl, qid } = beginDetail();
    const id = uid();
    opts.setResTabs((rs) => [
      ...rs,
      {
        id,
        kind: "profile",
        title: bucket.replace("_", " "),
        profileTable: bucket.replace("_", " "),
        profileEngine: spec.engine || "sqlite",
        profileLoading: true,
        profile: null,
      },
    ]);
    opts.setActiveResId(id);
    try {
      const p = await api.reconcileProfile(
        buildReconcileRequest(spec, bucket, field, qid),
        ctrl.signal,
      );
      if (ctrl.signal.aborted || wasCancelled(qid) || (p as any).cancelled) {
        opts.patchRes(id, { profileLoading: false });
        return;
      }
      if ((p as any).error && /interrupt|cancel/i.test(String((p as any).error))) {
        opts.toast("warn", "Profile cancelled", "Stopped at your request.");
        opts.patchRes(id, { profileLoading: false });
        return;
      }
      opts.patchRes(id, {
        profile: p,
        profileLoading: false,
        title: p.table || bucket.replace("_", " "),
        profileTable: p.table || bucket.replace("_", " "),
      });
    } catch (e: any) {
      if (isCancelledError(e, qid) || wasCancelled(qid)) {
        opts.patchRes(id, { profileLoading: false });
        return;
      }
      opts.toast("error", "Profile failed", e?.message);
      opts.patchRes(id, { profileLoading: false });
    } finally {
      endDetail(qid, ctrl);
    }
  };

  return { abortReconDetail, openResultFromId, reconDrill, reconProfile };
}
