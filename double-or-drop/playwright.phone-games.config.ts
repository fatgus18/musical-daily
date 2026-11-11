import { defineConfig, devices } from "@playwright/test";

// Fresh browser identities only. This suite never imports a real user's login.
export default defineConfig({
  testDir: "./tests/phone",
  testMatch: "blackjack-drop.spec.ts",
  outputDir: "./test-results-phone/games",
  timeout: 150000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: process.env.MOBILE_BASE_URL || "https://localhost:3100", ignoreHTTPSErrors: true, actionTimeout: 15000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "phone-chromium", use: { ...devices["Pixel 7"], browserName: "chromium", channel: process.platform === "win32" ? "chrome" : undefined } },
    { name: "phone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
