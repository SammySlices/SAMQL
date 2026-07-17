import {
  currentSession,
  expect,
  openApp,
  test,
} from "./fixtures";

const tabId = "dense-flow";
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
      tabs: [{ id: tabId, name: "Dense Flow" }],
      activeTabId: tabId,
    }),
    [`samql.nodeflow.tab.${tabId}`]: JSON.stringify(graph),
    ...extra,
  };
}

test("Dense NodeFlow shrinks nodes and restores on toggle off", async ({
  page,
}) => {
  await openApp(page, flowStorage(), "nodeflow");

  const app = page.getByTestId("samql-app");
  await expect(app).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/nb-dense/);

  const node = page.locator(".nb2-node").first();
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  expect(before, "node box before Dense NodeFlow").toBeTruthy();

  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-visual-toggles").click();
  const toggle = page.getByTestId("nodeflow-dense-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();

  await expect(page.locator("html")).toHaveClass(/nb-dense/);
  await expect(page.locator("html")).toHaveAttribute("data-nb-dense", "on");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("Condensed NodeFlow: on");

  const after = await node.boundingBox();
  expect(after, "node box with Dense NodeFlow").toBeTruthy();
  expect(after!.width).toBeLessThan(before!.width * 0.95);

  await toggle.click();
  await expect(page.locator("html")).not.toHaveClass(/nb-dense/);
  await expect(page.locator("html")).toHaveAttribute("data-nb-dense", "off");
});

test("Dense NodeFlow restores from localStorage on boot", async ({ page }) => {
  await openApp(
    page,
    flowStorage({
      "samql.nodeFlowDense": "1",
    }),
    "nodeflow",
  );
  await expect(page.locator("html")).toHaveClass(/nb-dense/);
  await expect(page.locator("html")).toHaveAttribute("data-nb-dense", "on");
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-visual-toggles").click();
  await expect(page.getByTestId("nodeflow-dense-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
