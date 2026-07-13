import {
  currentSession,
  expect,
  openApp,
  test,
} from "./fixtures";

const tabId = "eye-care-flow";
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
  ],
  edges: [
    {
      id: "e1",
      from: { node: "source", port: "out" },
      to: { node: "filter", port: "in" },
    },
  ],
};

function flowStorage(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "samql.view.v1": "nodeflow",
    "samql.session.v1": currentSession("", "__local__"),
    "samql.nodeflow.tabs.v3": JSON.stringify({
      version: 3,
      tabs: [{ id: tabId, name: "Eye Care Flow" }],
      activeTabId: tabId,
    }),
    [`samql.nodeflow.tab.${tabId}`]: JSON.stringify(graph),
    ...extra,
  };
}

test("Eye Care enlarges text, buttons, and restores on toggle off", async ({
  page,
}) => {
  await openApp(page, { "samql.session.v1": currentSession() });

  const app = page.getByTestId("samql-app");
  await expect(app).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-eye-care", "off");

  const runBtn = page.getByTestId("run-query");
  await expect(runBtn).toBeVisible();
  const before = await runBtn.boundingBox();
  expect(before, "run button box before Eye Care").toBeTruthy();

  const settingsBtn = page.getByTestId("settings-button");
  const chromeBefore = await settingsBtn.boundingBox();
  expect(chromeBefore, "settings button before Eye Care").toBeTruthy();

  await settingsBtn.click();
  const toggle = page.getByTestId("eye-care-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();

  await expect(page.locator("html")).toHaveClass(/eye-care/);
  await expect(page.locator("html")).toHaveAttribute("data-eye-care", "on");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("Eye Care: on");

  const after = await runBtn.boundingBox();
  expect(after, "run button box with Eye Care").toBeTruthy();
  expect(after!.width).toBeGreaterThan(before!.width * 1.1);
  expect(after!.height).toBeGreaterThan(before!.height * 1.1);

  const chromeAfter = await settingsBtn.boundingBox();
  expect(chromeAfter!.width).toBeGreaterThan(chromeBefore!.width * 1.1);
  expect(chromeAfter!.height).toBeGreaterThan(chromeBefore!.height * 1.1);

  // Aspect ratio of the button should stay roughly proportional under zoom.
  const ratioBefore = before!.width / before!.height;
  const ratioAfter = after!.width / after!.height;
  expect(Math.abs(ratioAfter - ratioBefore)).toBeLessThan(0.15);

  const scale = await page.locator("html").evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--eye-care-scale").trim(),
  );
  expect(Number.parseFloat(scale)).toBeCloseTo(1.25, 2);

  const menuItem = page.getByRole("button", { name: "Eye Care: on" });
  const menuBox = await menuItem.boundingBox();
  expect(menuBox!.height).toBeGreaterThan(18);

  await toggle.click();
  await expect(page.locator("html")).not.toHaveClass(/eye-care/);
  await expect(page.locator("html")).toHaveAttribute("data-eye-care", "off");

  const restored = await runBtn.boundingBox();
  expect(restored!.width).toBeCloseTo(before!.width, 0);
  expect(restored!.height).toBeCloseTo(before!.height, 0);
});

test("Eye Care enlarges NodeFlow nodes and run control together", async ({
  page,
}) => {
  await openApp(page, flowStorage(), "nodeflow");

  const node = page
    .locator('[data-testid="nodeflow-node"][data-node-id="filter"]')
    .first();
  const run = page.getByTestId("nodeflow-run");
  await expect(node).toBeVisible();
  await expect(run).toBeVisible();

  const nodeBefore = await node.boundingBox();
  const runBefore = await run.boundingBox();
  expect(nodeBefore).toBeTruthy();
  expect(runBefore).toBeTruthy();

  await page.getByTestId("settings-button").click();
  await page.getByTestId("eye-care-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-eye-care", "on");

  const nodeAfter = await node.boundingBox();
  const runAfter = await run.boundingBox();
  expect(nodeAfter!.width).toBeGreaterThan(nodeBefore!.width * 1.1);
  expect(nodeAfter!.height).toBeGreaterThan(nodeBefore!.height * 1.1);
  expect(runAfter!.width).toBeGreaterThan(runBefore!.width * 1.1);
  expect(runAfter!.height).toBeGreaterThan(runBefore!.height * 1.1);

  const nodeRatioBefore = nodeBefore!.width / nodeBefore!.height;
  const nodeRatioAfter = nodeAfter!.width / nodeAfter!.height;
  expect(Math.abs(nodeRatioAfter - nodeRatioBefore)).toBeLessThan(0.2);
});

test("Eye Care preference persists across reload", async ({ page }) => {
  await openApp(page, {
    "samql.session.v1": currentSession(),
    "samql.eyeCare": "1",
  });

  await expect(page.locator("html")).toHaveClass(/eye-care/);
  await expect(page.locator("html")).toHaveAttribute("data-eye-care", "on");

  const stored = await page.evaluate(() =>
    window.localStorage.getItem("samql.eyeCare"),
  );
  expect(stored).toBe("1");

  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("eye-care-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
