import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/stats", outputDir: "./test-results-stats", timeout: 90000, fullyParallel: false, workers: 1,
  use: { headless: true, channel: process.platform === "win32" ? "chrome" : undefined, trace: "retain-on-failure", viewport: { width: 1440, height: 1000 } },
  webServer: [
    { command: "npm --prefix ../blackjack-music run dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120000 },
    { command: "npm --prefix ../musical-daily run dev", url: "http://localhost:3001", reuseExistingServer: true, timeout: 120000 },
    { command: "npm --prefix ../tempo-trap run dev", url: "http://localhost:3002", reuseExistingServer: true, timeout: 120000 },
    { command: "npm --prefix ../artist-encore run dev", url: "http://localhost:3004", reuseExistingServer: true, timeout: 120000 },
    { command: "npm run dev", url: "http://localhost:3005", reuseExistingServer: true, timeout: 120000 },
  ],
});
