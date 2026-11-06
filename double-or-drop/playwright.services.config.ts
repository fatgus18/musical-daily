import { defineConfig } from "@playwright/test";

// Start the real Vercel Services gateway separately: this suite never starts or
// substitutes individual services. It exercises the same public origin as users.
export default defineConfig({
  testDir: "./tests/services",
  outputDir: "./test-results-services",
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.SERVICES_TEST_URL || "http://localhost:3100",
    headless: true,
    channel: process.platform === "win32" ? "chrome" : undefined,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
