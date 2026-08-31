import { defineConfig, devices } from "@playwright/test";

const applicationOrigin = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  outputDir: ".artifacts/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL: applicationOrigin,
    actionTimeout: 5_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node test/browser/conformance-server.mjs",
    url: `${applicationOrigin}/__health`,
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
