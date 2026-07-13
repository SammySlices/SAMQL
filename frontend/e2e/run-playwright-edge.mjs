import { spawnSync } from "node:child_process";
import path from "node:path";

const bin = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "playwright.cmd" : "playwright",
);
const env = { ...process.env, PLAYWRIGHT_BROWSER_CHANNEL: "msedge" };
const result = spawnSync(bin, ["test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: false,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
