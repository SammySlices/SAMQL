import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test";

export type StorageEntries = Record<string, string>;

type Allowance = {
  pattern: RegExp;
  remaining: number;
};

export type RuntimeGuard = {
  allowRequestFailure(pattern: RegExp, count?: number): void;
  allowConsoleError(pattern: RegExp, count?: number): void;
  allowHttpError(pattern: RegExp, status: number, count?: number): void;
};

type GuardState = {
  requestFailures: Allowance[];
  consoleErrors: Allowance[];
  httpErrors: Array<Allowance & { status: number }>;
  errors: string[];
};

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function consume(allowances: Allowance[], value: string): boolean {
  const hit = allowances.find(
    (item) => item.remaining > 0 && matches(item.pattern, value),
  );
  if (!hit) return false;
  hit.remaining -= 1;
  return true;
}

function requestLabel(request: Request): string {
  const failure = request.failure()?.errorText || "unknown network failure";
  return `${request.method()} ${request.url()} — ${failure}`;
}

async function attachGuardErrors(
  testInfo: TestInfo,
  errors: string[],
): Promise<void> {
  if (!errors.length) return;
  await testInfo.attach("runtime-guard-errors.txt", {
    body: errors.join("\n"),
    contentType: "text/plain",
  });
}

export const test = base.extend<{ runtimeGuard: RuntimeGuard }>({
  runtimeGuard: [
    async ({ page }, use, testInfo) => {
      const state: GuardState = {
        requestFailures: [],
        consoleErrors: [],
        httpErrors: [],
        errors: [],
      };

      page.on("pageerror", (error) => {
        state.errors.push(`pageerror: ${error.stack || error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (!consume(state.consoleErrors, text))
          state.errors.push(`console.error: ${text}`);
      });
      page.on("requestfailed", (request) => {
        const label = requestLabel(request);
        if (!consume(state.requestFailures, label))
          state.errors.push(`requestfailed: ${label}`);
      });
      page.on("response", (response) => {
        if (response.status() < 500) return;
        const label = `${response.status()} ${response.request().method()} ${response.url()}`;
        const hit = state.httpErrors.find(
          (item) =>
            item.remaining > 0 &&
            item.status === response.status() &&
            matches(item.pattern, label),
        );
        if (hit) hit.remaining -= 1;
        else state.errors.push(`http-error: ${label}`);
      });

      const guard: RuntimeGuard = {
        allowRequestFailure(pattern, count = 1) {
          state.requestFailures.push({ pattern, remaining: count });
        },
        allowConsoleError(pattern, count = 1) {
          state.consoleErrors.push({ pattern, remaining: count });
        },
        allowHttpError(pattern, status, count = 1) {
          state.httpErrors.push({ pattern, status, remaining: count });
        },
      };

      await use(guard);
      await attachGuardErrors(testInfo, state.errors);
      expect(
        state.errors,
        "Unexpected browser exception, console error, failed request, or HTTP 5xx",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function seedStorageBeforeBoot(
  page: Page,
  entries: StorageEntries = {},
): Promise<void> {
  await page.addInitScript((fixture: StorageEntries) => {
    // Init scripts also execute in transient/blocked documents where Web
    // Storage may throw SecurityError. Seed only a real http(s) application
    // document, and only once per tab so reloads exercise SamQL persistence.
    try {
      if (!/^https?:$/.test(window.location.protocol)) return;
      const marker = "__samql_e2e_storage_seeded_v1";
      if (window.sessionStorage.getItem(marker) === "1") return;
      window.localStorage.clear();
      for (const [key, value] of Object.entries(fixture))
        window.localStorage.setItem(key, value);
      window.sessionStorage.setItem(marker, "1");
    } catch {
      // The navigation itself will surface a useful error; storage seeding
      // must never create a second, misleading pageerror.
    }
  }, entries);
}

export async function openApp(
  page: Page,
  entries: StorageEntries = {},
  expectedView: "ide" | "notebook" | "nodeflow" | "dashboard" = "ide",
): Promise<void> {
  await seedStorageBeforeBoot(page, entries);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const app = page.getByTestId("samql-app");
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute("data-ready", "true");

  if (expectedView === "ide") {
    await expect(page.getByTestId("ide-sql-editor")).toBeVisible();
    const journalEditor = page.getByTestId("notebook-sql-editor");
    if (await journalEditor.count()) await expect(journalEditor.first()).toBeHidden();
  } else if (expectedView === "notebook") {
    await expect(page.getByTestId("journal-view")).toBeVisible();
    await expect(page.getByTestId("ide-sql-editor")).toBeHidden();
  } else if (expectedView === "dashboard") {
    await expect(page.getByTestId("dashboard-root")).toBeVisible();
    await expect(page.getByTestId("ide-sql-editor")).toBeHidden();
  } else {
    await expect(page.getByTestId("nodeflow-view")).toBeVisible();
    await expect(page.getByTestId("ide-sql-editor")).toBeHidden();
  }
}

export async function waitForJsonResponse(
  page: Page,
  path: string,
  method = "GET",
): Promise<Response> {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === path && response.request().method() === method;
  });
}

export async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function apiToken(page: Page): Promise<string> {
  // Capability is HttpOnly; read it from the browser cookie jar, not HTML.
  await expect
    .poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.find((c) => c.name === "samql_api_token")?.value || "";
    })
    .not.toEqual("");
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === "samql_api_token")?.value;
  expect(token).toBeTruthy();
  return token!;
}

export async function apiJson<T = Record<string, unknown>>(
  page: Page,
  request: APIRequestContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  data?: unknown,
): Promise<{ response: import("@playwright/test").APIResponse; body: T }> {
  const token = await apiToken(page);
  const response = await request.fetch(path, {
    method,
    headers: {
      "X-SamQL-Token": token,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { response, body };
}

export async function resetBackendAndReload(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const { response, body } = await apiJson<Record<string, unknown>>(
    page,
    request,
    "POST",
    "/api/nuke",
    {},
  );
  expect(response.ok(), `nuclear reset failed: ${JSON.stringify(body)}`).toBeTruthy();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("samql-app")).toHaveAttribute(
    "data-ready",
    "true",
  );
}

export async function waitForLoadJob(
  page: Page,
  request: APIRequestContext,
  jobId: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const { response, body } = await apiJson<Record<string, unknown>>(
          page,
          request,
          "GET",
          `/api/load/progress/${encodeURIComponent(jobId)}`,
        );
        expect(response.ok(), JSON.stringify(body)).toBeTruthy();
        last = body;
        return String(body.state || "");
      },
      { timeout: 45_000, intervals: [100, 200, 400, 800] },
    )
    .toMatch(/^(done|error|cancelled)$/);
  expect(last.state, `load job failed: ${JSON.stringify(last)}`).toBe("done");
  return last;
}

export function currentSession(
  sql = "SELECT 1;",
  target = "__local__",
): string {
  return JSON.stringify({
    version: 2,
    edTabs: [{ id: "wave1-tab", title: "Wave 1", sql }],
    activeId: "wave1-tab",
    target,
    readOnly: false,
    dialect: "native",
    sidebarW: 260,
    showTables: true,
    showNodeSearch: true,
    resultsH: 340,
  });
}
