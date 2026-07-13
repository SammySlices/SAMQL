import {
  currentSession,
  expect,
  openApp,
  readJsonOrText,
  test,
  waitForJsonResponse,
} from "./fixtures";

test("runs a query and opens live flow-cache telemetry", async ({ page }) => {
  await openApp(page, { "samql.session.v1": currentSession() });

  const editor = page.getByTestId("ide-sql-editor");
  await editor.fill("SELECT 42 AS answer, 'ok' AS status;");
  await expect(editor).toHaveValue("SELECT 42 AS answer, 'ok' AS status;");

  const [queryResponse] = await Promise.all([
    waitForJsonResponse(page, "/api/query", "POST"),
    page.getByTestId("run-query").click(),
  ]);
  const queryPayload = (await readJsonOrText(queryResponse)) as Record<
    string,
    unknown
  >;
  expect(
    queryResponse.ok(),
    `query failed (${queryResponse.status()}): ${JSON.stringify(queryPayload)}`,
  ).toBeTruthy();
  expect(String(queryPayload.error || "")).toBe("");
  expect(queryPayload.result_id).toBeTruthy();

  const grid = page.getByTestId("result-grid");
  await expect(grid).toBeVisible();
  await expect(grid.locator(".grid-head")).toContainText("answer");
  await expect(grid.locator(".grid-rows")).toContainText("42");
  await expect(grid.locator(".grid-rows")).toContainText("ok");

  await page.getByTestId("settings-button").click();
  await page.getByTestId("storage-memory-menu").click();
  await expect(page.getByTestId("storage-memory-modal")).toBeVisible();
  const [cacheResponse] = await Promise.all([
    waitForJsonResponse(page, "/api/settings/flow-cache", "GET"),
    page.getByTestId("flow-cache-tab").click(),
  ]);
  const cachePayload = await readJsonOrText(cacheResponse);
  expect(
    cacheResponse.ok(),
    `flow-cache request failed (${cacheResponse.status()}): ${JSON.stringify(cachePayload)}`,
  ).toBeTruthy();

  const modalBody = page.getByTestId("flow-cache-modal");
  await expect(modalBody).toBeVisible();
  const modal = page.locator(".modal").filter({ has: modalBody });
  await expect(modal).toContainText("hit rate");
  await expect(modal).toContainText("Largest cached intermediates");
});

test("migrates legacy browser session state and keeps a recovery copy", async ({
  page,
}) => {
  await openApp(page, {
    "samql.session.v1": JSON.stringify({
      edTabs: [
        { id: "legacy", title: "Legacy query", sql: "SELECT 7 AS migrated" },
      ],
      activeId: "legacy",
      target: "__local__",
      readOnly: false,
      dialect: "auto",
      sidebarW: 260,
      showTables: true,
      resultsH: 340,
    }),
  });

  const editor = page.getByTestId("ide-sql-editor");
  await expect(editor).toHaveValue("SELECT 7 AS migrated");

  const stored = await page.evaluate(() => ({
    current: JSON.parse(localStorage.getItem("samql.session.v1") || "{}"),
    backup: localStorage.getItem("samql.session.v1.pre-migration-backup"),
  }));
  expect(stored.current.version).toBe(2);
  expect(stored.current.activeId).toBe("legacy");
  expect(stored.current.target).toBe("__local__");
  expect(stored.backup).toContain("Legacy query");
});
