import { defineConfig } from "@playwright/test";
import { previewAuth } from "../scripts/preview-auth";

const baseURL = process.env.SERVICES_TEST_URL || "http://localhost:3100";

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
    baseURL,
    storageState: previewAuth(baseURL),
    headless: true,
    channel: process.platform === "win32" ? "chrome" : undefined,
    viewport: { width: 1440, height: 1000 },
    trace: process.env.VERCEL_TEST_COOKIE_FILE ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
