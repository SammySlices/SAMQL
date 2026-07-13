// Shared display formatters, so byte sizes and compact counts are formatted one
// way across the app instead of re-implemented per component.

// Human-readable byte size: GB / MB / KB / B. Returns "" for null/undefined.
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Compact count: 1.2B / 3.4M / 5.6k / 42 (trailing ".0" trimmed).
export function formatCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
