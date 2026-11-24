import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const python = process.env.SAMQL_TEST_PYTHON || "python";
const port = Number(process.env.SAMQL_TEST_PORT || "8765");
const baseURL = `http://127.0.0.1:${port}`;
// C-1: the server only hands its HttpOnly cookie to a launch URL carrying
// the token (/?t=...). Fix the token here so the server (webServer env) and
// openApp() (workers inherit this env) agree on it.
if (!process.env.SAMQL_API_TOKEN) {
  process.env.SAMQL_API_TOKEN = randomBytes(24).toString("hex");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
          args: ["--no-sandbox"],
        }
      : undefined,
  },
  webServer: {
    command: `npm run build && "${python}" ../backend/server.py --no-browser --port ${port}`,
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SAMQL_JSON_BODY_MB: "1",
    },
  },
});
