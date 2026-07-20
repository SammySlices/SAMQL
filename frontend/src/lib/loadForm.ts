// Canonical multipart payload builder for foreground and background file loads.
// Keeping every option in one place prevents the two API entry points from
// drifting when a new loader flag is introduced.

export interface LoadFormOptions {
  destination?: string;
  delimiter?: string;
  sheet?: string;
  headerRow?: number;
  mode?: string;
  exclude?: string;
  flatten?: boolean;
  shred?: boolean;
  rootId?: unknown;
  /** Skip persistent file→Parquet filecache for this upload. */
  fresh?: boolean;
}

export function buildLoadForm(
  files: FileList | File[],
  options: LoadFormOptions = {},
): FormData {
  const form = new FormData();
  if (options.flatten !== undefined) {
    form.append("flatten", options.flatten ? "1" : "0");
  }
  if (options.shred) form.append("shred", "1");
  if (options.fresh !== undefined) {
    form.append("fresh", options.fresh ? "1" : "0");
  }
  if (options.rootId != null) {
    form.append("root_id", JSON.stringify(options.rootId));
  }
  form.append("destination", options.destination || "auto");
  if (options.delimiter) form.append("delimiter", options.delimiter);
  if (options.sheet) form.append("sheet", options.sheet);
  if (options.headerRow && options.headerRow > 1) {
    form.append("header_row", String(options.headerRow));
  }
  if (options.mode && options.mode !== "materialize") {
    form.append("mode", options.mode);
  }
  const exclude = options.exclude?.trim();
  if (exclude) form.append("exclude", exclude);
  for (const file of Array.from(files)) form.append("files", file, file.name);
  return form;
}
