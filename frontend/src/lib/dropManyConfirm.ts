/** Confirm copy for sidebar bulk table drop. */
export function dropManyConfirmMessage(
  items: { engine: string; name: string }[],
  allLocal: { engine: string; name: string }[],
): string {
  if (!items.length) return "";
  const key = (engine: string, name: string) => `${engine}:${name}`;
  const selected = new Set(items.map((i) => key(i.engine, i.name)));
  const deletingAll =
    allLocal.length > 0 &&
    selected.size === allLocal.length &&
    allLocal.every((t) => selected.has(key(t.engine, t.name)));
  if (deletingAll) return "Drop All Tables?";
  const list = items.map((i) => i.name).join(", ");
  return (
    `Drop ${items.length} table${items.length === 1 ? "" : "s"}? ` +
    `This cannot be undone. (${list})`
  );
}
