import { defineConfig } from "@playwright/test";

// Start the isolated HTTPS services fixture before this suite. No real account or
// production game state is used, and recordings never leave the browser.
export default defineConfig({
  testDir: "./tests/mobile",
  outputDir: "./test-results-mobile",
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.MOBILE_BASE_URL || "https://localhost:3100",
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [
    { name: "android-chromium", use: { browserName: "chromium", channel: process.platform === "win32" ? "chrome" : undefined } },
    { name: "iphone-webkit", use: { browserName: "webkit" } },
  ],
});
