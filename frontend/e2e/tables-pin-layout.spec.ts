import { currentSession, expect, openApp, test } from "./fixtures";

test("pinning the tables drawer shifts IDE and NodeFlow content right", async ({
  page,
}) => {
  await openApp(page, { "samql.session.v1": currentSession() });

  const main = page.locator(".main");
  const editor = page.getByTestId("ide-sql-editor");
  const drawer = page.getByTestId("tables-sidebar-drawer");

  const leftOf = (locator: typeof main) =>
    locator.evaluate((el) => el.getBoundingClientRect().left);

  const closedMainLeft = await leftOf(main);
  const closedEditorLeft = await leftOf(editor);

  await page.getByTestId("tables-sidebar-edge").hover();
  await page.getByTestId("tables-sidebar-peek-menu").click();
  await expect(drawer).toHaveAttribute("data-open", "1");

  // Overlay open: workspace stays put so SQL remains full-width under the panel.
  expect(await leftOf(main)).toBeCloseTo(closedMainLeft, 0);
  expect(await leftOf(editor)).toBeCloseTo(closedEditorLeft, 0);

  await page.getByTestId("tables-panel-pin-tab").click();
  await expect(drawer).toHaveAttribute("data-pinned", "1");

  const pinnedMainLeft = await leftOf(main);
  const pinnedEditorLeft = await leftOf(editor);
  expect(pinnedMainLeft - closedMainLeft).toBeGreaterThan(200);
  expect(pinnedEditorLeft - closedEditorLeft).toBeGreaterThan(200);

  await page.getByTestId("view-nodeflow").click();
  const nodeFlow = page.getByTestId("nodeflow-view");
  await expect(nodeFlow).toBeVisible();
  expect((await leftOf(nodeFlow)) - closedMainLeft).toBeGreaterThan(200);
});
