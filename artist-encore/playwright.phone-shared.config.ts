import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phone-shared",
  outputDir: "./test-results-phone-shared",
  timeout: 180000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: process.env.MOBILE_BASE_URL || "https://localhost:3100",
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
    actionTimeout: 20000,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "android-chromium", use: { browserName: "chromium", channel: process.platform === "win32" ? "chrome" : undefined } },
    { name: "ios-webkit", use: { browserName: "webkit" } },
  ],
});
