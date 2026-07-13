import {
  currentSession,
  expect,
  openApp,
  readJsonOrText,
  resetBackendAndReload,
  test,
} from "./fixtures";

const tabId = "wave1-flow";
const graph = {
  format: "samql-nodeflow",
  version: 3,
  nodes: [
    {
      id: "source",
      type: "createtable",
      x: 80,
      y: 100,
      config: {
        label: "seed rows",
        columns: ["id", "amount"],
        rows: [
          ["1", "10"],
          ["2", "25"],
          ["3", "5"],
        ],
        dest: "sqlite",
      },
    },
    {
      id: "filter",
      type: "filter",
      x: 340,
      y: 100,
      config: {
        label: "kept rows",
        filterMode: "simple",
        field: "amount",
        op: ">=",
        value: "10",
        condition: "[amount] >= 10",
      },
    },
    {
      id: "formula",
      type: "formula",
      x: 600,
      y: 100,
      config: {
        label: "double amount",
        formulas: [
          { name: "double_amount", expr: "[amount] * 2", mode: "new" },
        ],
      },
    },
  ],
  edges: [
    {
      id: "e1",
      from: { node: "source", port: "out" },
      to: { node: "filter", port: "in" },
    },
    {
      id: "e2",
      from: { node: "filter", port: "true" },
      to: { node: "formula", port: "in" },
    },
  ],
};

function flowStorage(): Record<string, string> {
  return {
    "samql.view.v1": "nodeflow",
    "samql.session.v1": currentSession("", "__local__"),
    "samql.nodeflow.tabs.v3": JSON.stringify({
      version: 3,
      tabs: [{ id: tabId, name: "Wave 1 Flow" }],
      activeTabId: tabId,
    }),
    [`samql.nodeflow.tab.${tabId}`]: JSON.stringify(graph),
  };
}

async function runFlow(page: import("@playwright/test").Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return (
      response.request().method() === "POST" &&
      (path === "/api/nodeflow/run" || path === "/api/nodeflow/run-batch")
    );
  });
  await page.getByTestId("nodeflow-run").click();
  const response = await responsePromise;
  const body = (await readJsonOrText(response)) as Record<string, unknown>;
  expect(
    response.ok(),
    `NodeFlow run failed (${response.status()}): ${JSON.stringify(body)}`,
  ).toBeTruthy();
  expect(body.error, `NodeFlow returned an error: ${JSON.stringify(body)}`).toBeFalsy();
  expect(body.cancelled, `NodeFlow was unexpectedly cancelled: ${JSON.stringify(body)}`).toBeFalsy();
  await expect(page.getByTestId("nodeflow-run")).toBeVisible({ timeout: 30_000 });
  const preview = page.getByTestId("nodeflow-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("result-grid")).toBeVisible();
}

test("NodeFlow reruns after an upstream edit and persists the changed graph", async ({
  page,
  request,
}) => {
  await openApp(page, flowStorage(), "nodeflow");
  await resetBackendAndReload(page, request);
  await expect(page.getByTestId("nodeflow-view")).toBeVisible();
  await expect(page.getByTestId("nodeflow-node")).toHaveCount(3);

  await runFlow(page);
  let grid = page.getByTestId("nodeflow-preview").getByTestId("result-grid");
  const initialValues = grid.locator('.gc-cell[data-column="double_amount"]');
  await expect(initialValues).toHaveCount(2);
  await expect(initialValues.nth(0)).toHaveText("20");
  await expect(initialValues.nth(1)).toHaveText("50");

  await page
    .locator('[data-testid="nodeflow-node"][data-node-id="filter"]')
    .click();
  await expect(page.getByTestId("nodeflow-filter-value")).toHaveValue("10");
  await page.getByTestId("nodeflow-filter-value").fill("20");
  await expect
    .poll(async () =>
      page.evaluate((key) => localStorage.getItem(key) || "", `samql.nodeflow.tab.${tabId}`),
    )
    .toContain('"value":"20"');
  await expect
    .poll(async () =>
      page.evaluate((key) => localStorage.getItem(key) || "", `samql.nodeflow.tab.${tabId}`),
    )
    .toContain('"condition":"[amount] >= 20"');

  await runFlow(page);
  grid = page.getByTestId("nodeflow-preview").getByTestId("result-grid");
  await expect(grid.locator('.gc-cell[data-column="double_amount"]')).toHaveCount(1);
  await expect(grid.locator('.gc-cell[data-column="double_amount"]')).toHaveText("50");

  // Force the same lifecycle flush a real reload/close receives, then reload.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("samql-app")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("nodeflow-view")).toBeVisible();
  await page
    .locator('[data-testid="nodeflow-node"][data-node-id="filter"]')
    .click();
  await expect(page.getByTestId("nodeflow-filter-value")).toHaveValue("20");
  await runFlow(page);
  await expect(
    page
      .getByTestId("nodeflow-preview")
      .getByTestId("result-grid")
      .locator('.gc-cell[data-column="double_amount"]'),
  ).toHaveText("50");
});
