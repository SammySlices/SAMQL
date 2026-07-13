import {
  apiJson,
  currentSession,
  expect,
  openApp,
  readJsonOrText,
  resetBackendAndReload,
  test,
  waitForJsonResponse,
} from "./fixtures";

test("cancels a long query and immediately recovers without a refresh", async ({
  page,
  request,
  runtimeGuard,
}) => {
  await openApp(page, {
    "samql.session.v1": currentSession("", "__duckdb__"),
  });
  const health = await apiJson<Record<string, any>>(
    page,
    request,
    "GET",
    "/api/health",
  );
  test.skip(!health.body?.features?.duckdb, "DuckDB is required for this cancellation rail");
  await resetBackendAndReload(page, request);
  await page.getByTestId("ide-engine").selectOption("__duckdb__");

  runtimeGuard.allowRequestFailure(/POST .*\/api\/query.*(aborted|canceled|ERR_)/i, 2);
  const editor = page.getByTestId("ide-sql-editor");
  await editor.fill("SELECT sum(random()) AS total FROM range(1000000000)");
  await page.getByTestId("run-query").click();
  await expect(page.getByTestId("stop-query")).toBeVisible();
  await page.getByTestId("stop-query").click();
  await expect(page.getByTestId("run-query")).toBeVisible({ timeout: 20_000 });

  await editor.fill("SELECT 1 AS recovered, 'ready' AS state");
  const [response] = await Promise.all([
    waitForJsonResponse(page, "/api/query", "POST"),
    page.getByTestId("run-query").click(),
  ]);
  const body = (await readJsonOrText(response)) as Record<string, unknown>;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  await expect(page.getByTestId("result-grid")).toContainText("recovered");
  await expect(page.getByTestId("result-grid")).toContainText("ready");
});
