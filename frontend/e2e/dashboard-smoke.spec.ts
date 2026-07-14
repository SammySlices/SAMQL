import {
  currentSession,
  expect,
  openApp,
  test,
} from "./fixtures";

test("opens the App Dashboard view with board controls", async ({ page }) => {
  await openApp(
    page,
    {
      "samql.session.v1": currentSession(),
      "samql.view.v1": "dashboard",
    },
    "dashboard",
  );

  await expect(page.getByTestId("dashboard-root")).toBeVisible();
  await expect(page.getByTestId("dashboard-run")).toBeVisible();
  await expect(page.getByTestId("dashboard-select")).toBeVisible();
  await expect(page.getByTestId("dashboard-add-widget")).toBeVisible();
  await expect(page.getByRole("button", { name: /add widget/i })).toBeVisible();
  await expect(page.getByTestId("dashboard-export-pdf")).toBeVisible();
  // Board background customization was removed.
  await expect(page.getByTestId("dashboard-bg-menu")).toHaveCount(0);
});

test("configure opens only via chrome; float minimizes and closes", async ({
  page,
}) => {
  await openApp(
    page,
    {
      "samql.session.v1": currentSession(),
      "samql.view.v1": "dashboard",
    },
    "dashboard",
  );

  await page.getByTestId("dashboard-add-widget").click();
  await page.getByTestId("dashboard-add-text").click();
  await expect(page.locator(".dash-widget-text")).toBeVisible();
  // Adding / selecting a widget must not open configure.
  await expect(page.getByTestId("dashboard-config")).toHaveCount(0);

  const textWidget = page.locator(".dash-widget-text").first();
  const testId = await textWidget.getAttribute("data-testid");
  const id = (testId || "").replace("dashboard-widget-", "");
  expect(id).toBeTruthy();

  await page.locator(`.dash-resize-text`).click();
  await expect(page.getByTestId("dashboard-config")).toHaveCount(0);

  await page.getByTestId(`dashboard-widget-configure-${id}`).click();
  await expect(page.getByTestId("dashboard-config-panel")).toBeVisible();
  await expect(page.getByTestId("dashboard-config")).toBeVisible();
  await expect(page.getByText("Header color")).toBeVisible();
  await expect(page.getByText("Liquid glass")).toBeVisible();
  await expect(page.getByTestId("dashboard-config-panel")).toHaveClass(
    /win-float/,
  );

  await page.getByTestId("dashboard-config-minimize").click();
  await expect(page.getByTestId("dashboard-config-panel")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-config-mini")).toBeVisible();
  await expect(page.getByTestId("dashboard-config-mini")).toHaveClass(/tt-mini/);

  // Click-without-drag expands (Field Explore–style).
  await page.getByTestId("dashboard-config-mini").click();
  await expect(page.getByTestId("dashboard-config-panel")).toBeVisible();

  await page.getByTestId("dashboard-config-close").click();
  await expect(page.getByTestId("dashboard-config")).toHaveCount(0);

  await page.getByTestId("dashboard-title-configure").click();
  await expect(page.getByTestId("dashboard-title-config")).toBeVisible();
});

test("widget expand opens a resizable window and closes", async ({ page }) => {
  await openApp(
    page,
    {
      "samql.session.v1": currentSession(),
      "samql.view.v1": "dashboard",
    },
    "dashboard",
  );

  await page.getByTestId("dashboard-add-widget").click();
  await page.getByTestId("dashboard-add-text").click();
  const textWidget = page.locator(".dash-widget-text").first();
  await expect(textWidget).toBeVisible();
  const testId = await textWidget.getAttribute("data-testid");
  const id = (testId || "").replace("dashboard-widget-", "");
  expect(id).toBeTruthy();

  await page.getByTestId(`dashboard-widget-expand-${id}`).click();
  await expect(page.getByTestId(`dashboard-expand-${id}`)).toBeVisible();
  await expect(page.getByTestId("dashboard-expand-resize")).toBeVisible();
  await page.getByTestId("dashboard-expand-close").click();
  await expect(page.getByTestId(`dashboard-expand-${id}`)).toHaveCount(0);
});
