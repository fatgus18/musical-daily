import { defineConfig } from "@playwright/test";

// Deliberately local-only. Start tests/services/local-gateway.mjs in the DoD
// app with ACCOUNTS_TEST_FIXTURE=1 after account-enabled service builds.
export default defineConfig({
  testDir: "./tests/account-services",
  outputDir: "./test-results-accounts",
  timeout: 180000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "https://localhost:3100",
    ignoreHTTPSErrors: true,
    headless: true,
    channel: process.platform === "win32" ? "chrome" : undefined,
    viewport: { width: 1440, height: 1000 },
    // Session cookies are test-only, but traces are still unnecessary.
    trace: "off",
    screenshot: "only-on-failure",
  },
});
