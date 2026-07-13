import type { ReconBucket } from "./types";

export interface ReconcileSourceSpec {
  left: string;
  right: string;
  keys: string[];
  balance?: string | null;
  colmap_a?: Record<string, string>;
  colmap_b?: Record<string, string>;
}

export interface ReconcileDetailRequest {
  left: string;
  right: string;
  keys: string[];
  bucket: ReconBucket;
  field: string | null;
  balance: string | null;
  colmap_a: Record<string, string>;
  colmap_b: Record<string, string>;
}

export function buildReconcileRequest(
  spec: ReconcileSourceSpec,
  bucket: ReconBucket,
  field: string | null,
): ReconcileDetailRequest {
  return {
    left: spec.left,
    right: spec.right,
    keys: [...spec.keys],
    bucket,
    field,
    balance: spec.balance ?? null,
    colmap_a: { ...(spec.colmap_a || {}) },
    colmap_b: { ...(spec.colmap_b || {}) },
  };
}
