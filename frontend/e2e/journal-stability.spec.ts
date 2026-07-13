import {
  currentSession,
  expect,
  openApp,
  test,
} from "./fixtures";

const notebookId = "wave1-notebook";
const now = 1_700_000_000_000;
const initialCells = [
  { id: "cell-a", type: "sql", name: "cell1", code: "SELECT 3 AS n", group: "g1" },
  {
    id: "cell-b",
    type: "sql",
    name: "cell2",
    code: "SELECT n * 2 AS doubled FROM cell1",
    group: "g1",
  },
];

function journalStorage(): Record<string, string> {
  return {
    "samql.view.v1": "notebook",
    "samql.session.v1": currentSession("", "__local__"),
    "samql.nb.index": JSON.stringify({
      version: 2,
      notebooks: [
        { id: notebookId, name: "Wave 1 Journal", createdAt: now, updatedAt: now },
      ],
    }),
    "samql.nb.current": notebookId,
    [`samql.nb.doc.${notebookId}`]: JSON.stringify({
      format: "samql-notebook",
      version: 2,
      savedAt: new Date(now).toISOString(),
      cells: initialCells,
    }),
    [`samql.nb.groups.${notebookId}`]: JSON.stringify({
      version: 1,
      groups: [{ id: "g1", name: "Group 1" }],
    }),
  };
}

test("runs a chained Journal, survives view switches, persists edits, and reruns", async ({
  page,
}) => {
  await openApp(page, journalStorage(), "notebook");
  await expect(page.getByTestId("journal-engine")).toHaveValue("__local__");

  const cell1 = page.locator(
    '[data-testid="journal-cell"][data-cell-name="cell1"]',
  );
  const cells = page.getByTestId("journal-cell");
  await expect(cells).toHaveCount(2);

  await page.getByTestId("journal-run-all").click();
  await expect(cells.nth(0).locator(".nb-status")).toContainText("1 row");
  await expect(cells.nth(1).locator(".nb-status")).toContainText("1 row");
  await expect(cells.nth(1).getByTestId("result-grid")).toContainText("6");

  await page.getByTestId("view-ide").click();
  await expect(page.getByTestId("ide-sql-editor")).toBeVisible();
  await page.getByTestId("view-journal").click();
  await expect(cells.nth(1).getByTestId("result-grid")).toContainText("6");

  const secondEditor = cells.nth(1).getByTestId("notebook-sql-editor");
  await secondEditor.fill("SELECT n * 3 AS tripled FROM cell1");
  await expect
    .poll(async () =>
      page.evaluate((key) => localStorage.getItem(key) || "", `samql.nb.doc.${notebookId}`),
    )
    .toContain("n * 3");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("samql-app")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("journal-view")).toBeVisible();
  const reloadedCells = page.getByTestId("journal-cell");
  await expect(reloadedCells).toHaveCount(2);
  await expect(reloadedCells.nth(1).getByTestId("notebook-sql-editor")).toHaveValue(
    "SELECT n * 3 AS tripled FROM cell1",
  );
  await page.getByTestId("journal-run-all").click();
  await expect(reloadedCells.nth(1).getByTestId("result-grid")).toContainText("9");
  await expect(cell1).toHaveCount(1);
});
