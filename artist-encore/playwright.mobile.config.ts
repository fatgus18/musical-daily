import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile",
  timeout: 300000,
  expect: { timeout: 15000 },
  workers: 2,
  use: { baseURL: process.env.MOBILE_BASE_URL || "https://localhost:3100", ignoreHTTPSErrors: true, viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, actionTimeout: 20000, screenshot: "only-on-failure", trace: "off" },
  projects: [
    { name: "phone-chromium", use: { browserName: "chromium", channel: process.platform === "win32" ? "chrome" : undefined } },
    { name: "phone-webkit", use: { browserName: "webkit" } },
  ],
});
