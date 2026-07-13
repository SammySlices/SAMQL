import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Node 25+/26 ships a global Web Storage API that returns an empty/undefined
// localStorage unless --localstorage-file is set. That shadows jsdom's Storage
// and breaks every component test that clears or writes session state.
// --no-webstorage restores jsdom ownership. The flag does not exist on Node 24.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
const execArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    execArgv,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.component.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: "threads",
    maxWorkers: 4,
    sequence: { concurrent: false },
  },
});
