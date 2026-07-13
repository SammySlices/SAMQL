import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  apiJson,
  currentSession,
  expect,
  openApp,
  readJsonOrText,
  resetBackendAndReload,
  test,
  waitForJsonResponse,
  waitForLoadJob,
} from "./fixtures";

const csvPath = fileURLToPath(new URL("./fixtures/wave1-load.csv", import.meta.url));
const nestedPath = fileURLToPath(
  new URL("./fixtures/wave1-nested.json", import.meta.url),
);

function loadedTable(progress: Record<string, unknown>): string {
  const loaded = Array.isArray(progress.loaded) ? progress.loaded : [];
  const first = loaded[0] as Record<string, unknown> | undefined;
  const name = String(first?.name || first?.table || "");
  expect(name, `load result has no table name: ${JSON.stringify(progress)}`).toBeTruthy();
  return name;
}

async function runSql(
  page: import("@playwright/test").Page,
  sql: string,
): Promise<Record<string, unknown>> {
  const editor = page.getByTestId("ide-sql-editor");
  await editor.fill(sql);
  const [response] = await Promise.all([
    waitForJsonResponse(page, "/api/query", "POST"),
    page.getByTestId("run-query").click(),
  ]);
  const body = (await readJsonOrText(response)) as Record<string, unknown>;
  expect(
    response.ok(),
    `query failed (${response.status()}): ${JSON.stringify(body)}`,
  ).toBeTruthy();
  expect(body.error).toBeFalsy();
  return body;
}

test("loads a file through the UI, queries, sorts, filters, and exports it", async ({
  page,
  request,
}) => {
  await openApp(page, { "samql.session.v1": currentSession("", "__local__") });
  await resetBackendAndReload(page, request);

  await page.getByTestId("settings-button").click();
  await page.getByTestId("load-data-menu").click();
  await expect(page.getByTestId("load-data-modal")).toBeVisible();
  await page.getByTestId("load-file-path").fill(csvPath);
  await page.getByTestId("load-destination").selectOption("sqlite");
  await page.getByTestId("load-mode").selectOption("materialize");

  const [startResponse] = await Promise.all([
    waitForJsonResponse(page, "/api/load/start", "POST"),
    page.getByTestId("load-submit").click(),
  ]);
  const start = (await readJsonOrText(startResponse)) as Record<string, unknown>;
  expect(startResponse.ok(), JSON.stringify(start)).toBeTruthy();
  const jobId = String(start.job_id || "");
  expect(jobId).toBeTruthy();
  const progress = await waitForLoadJob(page, request, jobId);
  const table = loadedTable(progress);

  await runSql(
    page,
    `SELECT id, name, amount, category FROM "${table}"`,
  );
  const grid = page.getByTestId("result-grid");
  await expect(grid).toBeVisible();
  await expect(grid.locator('.gh-cell[data-column="amount"]')).toBeVisible();
  await expect(grid.locator('.gc-cell[data-column="name"]')).toHaveCount(4);

  const sortResponse = page.waitForResponse((response) =>
    /\/api\/result\/[^/]+\/page$/.test(new URL(response.url()).pathname),
  );
  await grid.locator('.gh-cell[data-column="amount"]').click();
  await sortResponse;
  await expect(
    grid.locator('.gc-cell[data-column="amount"][data-row-index="0"]'),
  ).toHaveText("7.25");

  await grid.locator('.gh-cell[data-column="category"]').click({ button: "right" });
  await page.getByTestId("grid-filter-op").selectOption("equals");
  await page.getByTestId("grid-filter-value").fill("A");
  const filterResponse = page.waitForResponse((response) =>
    /\/api\/result\/[^/]+\/page$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("grid-filter-apply").click();
  await filterResponse;
  const categories = grid.locator('.gc-cell[data-column="category"]');
  await expect(categories).toHaveCount(2);
  await expect(categories.nth(0)).toHaveText("A");
  await expect(categories.nth(1)).toHaveText("A");
  await expect(grid.locator(".grid-rows")).not.toContainText("beta");
  await expect(grid.locator(".grid-rows")).not.toContainText("delta");

  await page.getByTestId("output-button").click();
  const exportResponsePromise = page.waitForResponse((response) =>
    /\/api\/result\/[^/]+\/export$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("export-csv").click();
  const exportResponse = await exportResponsePromise;
  const exportBody = (await readJsonOrText(exportResponse)) as Record<string, unknown>;
  expect(exportResponse.ok(), JSON.stringify(exportBody)).toBeTruthy();
  const exportedPath = String(exportBody.path || "");
  expect(exportedPath).toBeTruthy();
  const exported = await readFile(exportedPath, "utf8");
  expect(exported).toContain("id,name,amount,category");
  expect(exported).toContain("alpha");
  await unlink(exportedPath).catch(() => undefined);
});

test("loads nested JSON and opens a structured-cell viewer", async ({
  page,
  request,
}) => {
  await openApp(page, { "samql.session.v1": currentSession("", "__duckdb__") });
  const health = await apiJson<Record<string, any>>(
    page,
    request,
    "GET",
    "/api/health",
  );
  test.skip(!health.body?.features?.duckdb, "DuckDB is required for nested JSON");
  await resetBackendAndReload(page, request);

  const start = await apiJson<Record<string, unknown>>(
    page,
    request,
    "POST",
    "/api/load/start",
    {
      path: nestedPath,
      destination: "duckdb",
      mode: "materialize",
      // This scenario is specifically about a native STRUCT value.  SamQL's
      // normal JSON default is relational flattening, which deliberately
      // removes the parent ``meta`` struct; opt out explicitly so the test
      // exercises the structured-cell viewer rather than the flattener.
      flatten: false,
    },
  );
  expect(start.response.ok(), JSON.stringify(start.body)).toBeTruthy();
  const progress = await waitForLoadJob(
    page,
    request,
    String(start.body.job_id || ""),
  );
  const table = loadedTable(progress);

  await page.getByTestId("ide-engine").selectOption("__duckdb__");
  const query = await runSql(page, `SELECT id, meta FROM "${table}" ORDER BY id`);
  expect(query.columns).toEqual(["id", "meta"]);
  const grid = page.getByTestId("result-grid");
  // The button itself carries data-column, so use that stable hook rather than
  // a CSS class shared by every structured column.
  const metaExpand = grid.locator(
    '[data-testid="structured-cell-expand"][data-column="meta"][data-row-index="0"]',
  );
  await expect(metaExpand).toBeVisible();
  await metaExpand.click();
  const viewer = page.getByTestId("structured-value-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".gc-json-body")).toContainText("region");
  await expect(viewer.locator(".gc-json-body")).toContainText("priority");
});
