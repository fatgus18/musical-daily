import { defineConfig } from "@playwright/test";

const webkit = process.env.ROOMS_BROWSER === "webkit";

// Run against the isolated HTTPS services fixture; never use production data.
export default defineConfig({
  testDir: "./tests/rooms-browser",
  testMatch: webkit ? "**/rooms-webkit.spec.ts" : ["**/rooms-api.spec.ts", "**/rooms-ui.spec.ts"],
  outputDir: "./test-results-rooms/artifacts",
  timeout: 180000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "https://localhost:3100",
    ignoreHTTPSErrors: true,
    headless: true,
    browserName: webkit ? "webkit" : "chromium",
    channel: !webkit && process.platform === "win32" ? "chrome" : undefined,
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: "off",
    screenshot: "only-on-failure",
  },
});
