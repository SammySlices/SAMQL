import { expect, openApp, test } from "./fixtures";

function session(activeId = "second"): string {
  return JSON.stringify({
    version: 2,
    edTabs: [
      { id: "first", title: "First", sql: "SELECT 1 AS first_value" },
      { id: "second", title: "Second", sql: "SELECT 2 AS second_value" },
    ],
    activeId,
    target: "__local__",
    readOnly: false,
    dialect: "native",
    sidebarW: 260,
    showTables: true,
    showNodeSearch: true,
    resultsH: 340,
  });
}

test("current session state persists through reload", async ({ page }) => {
  await openApp(page, { "samql.session.v1": session() });
  const editor = page.getByTestId("ide-sql-editor");
  await expect(editor).toHaveValue("SELECT 2 AS second_value");
  await expect(page.getByTestId("ide-engine")).toHaveValue("__local__");

  await editor.fill("SELECT 22 AS persisted_value");
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("samql.session.v1") || ""))
    .toContain("persisted_value");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("samql-app")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("ide-sql-editor")).toHaveValue(
    "SELECT 22 AS persisted_value",
  );
  await expect(page.getByTestId("ide-engine")).toHaveValue("__local__");
});

test("missing active tab recovers to the first real tab", async ({ page }) => {
  await openApp(page, { "samql.session.v1": session("missing-tab") });
  await expect(page.getByTestId("ide-sql-editor")).toHaveValue(
    "SELECT 1 AS first_value",
  );
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("samql.session.v1") || "{}";
        return JSON.parse(raw).activeId;
      }),
    )
    .toBe("first");
});

test("malformed session storage falls back to a usable workspace", async ({ page }) => {
  await openApp(page, { "samql.session.v1": "{" });
  await expect(page.getByTestId("ide-sql-editor")).toBeVisible();
  await expect(page.getByTestId("run-query")).toBeEnabled();
});
