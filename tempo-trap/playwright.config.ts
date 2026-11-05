import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser", timeout: 60000, fullyParallel: false, workers: 1,
  use: { baseURL: "http://localhost:3002", headless: true, channel: process.platform === "win32" ? "chrome" : undefined, trace: "retain-on-failure", viewport: { width: 1440, height: 1080 } },
  webServer: [
    { command: "npm run dev", url: "http://localhost:3002", reuseExistingServer: true, timeout: 120000 },
    { command: "npm --prefix ../musical-daily run dev", url: "http://localhost:3001", reuseExistingServer: true, timeout: 120000 },
  ],
});
