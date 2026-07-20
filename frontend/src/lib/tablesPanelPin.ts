/** UI preference: keep the Tables / History / Workflows drawer open. */
export const TABLES_PANEL_PIN_KEY = "samql.tablesPanel.pinned";

export function readTablesPanelPinned(): boolean {
  try {
    return window.localStorage?.getItem(TABLES_PANEL_PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeTablesPanelPinned(pinned: boolean): void {
  try {
    if (pinned) window.localStorage?.setItem(TABLES_PANEL_PIN_KEY, "1");
    else window.localStorage?.removeItem(TABLES_PANEL_PIN_KEY);
  } catch {
    /* best-effort */
  }
}
