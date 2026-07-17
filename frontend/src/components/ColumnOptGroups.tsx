import React from "react";
import {
  groupColumnsByRole,
  roleLabel,
  shortFieldType,
  type FieldRole,
} from "../lib/fieldRoles";

/** `<select>` options grouped by measure / dimension; every column stays selectable. */
export function ColumnOptGroups({
  columns,
  types,
}: {
  columns: string[];
  types?: Record<string, string> | null;
}): React.ReactElement {
  const hasTypes = !!(types && Object.keys(types).length);
  if (!hasTypes) {
    return (
      <>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </>
    );
  }
  const g = groupColumnsByRole(columns, types);
  const sections: { role: FieldRole; items: string[] }[] = [
    { role: "dimension", items: g.dimensions },
    { role: "measure", items: g.measures },
    { role: "unknown", items: g.other },
  ];
  return (
    <>
      {sections.map(({ role, items }) =>
        items.length ? (
          <optgroup key={role} label={roleLabel(role)}>
            {items.map((c) => (
              <option key={c} value={c}>
                {c}
                {types?.[c] ? ` · ${shortFieldType(types[c])}` : ""}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </>
  );
}
