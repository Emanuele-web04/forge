import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["visibleBrowserMcp.e2e.ts", "browserAnnotations.e2e.ts"],
  globalSetup: "./e2e/globalSetup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list", { printSteps: true }]],
  use: {
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
