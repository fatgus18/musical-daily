import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("WebKit phone discovery and lobby fit and unsupported audio has an actionable message", async ({ browser }) => {
  execFileSync(process.execPath, [resolve("tests/rooms-browser/fixture.mjs"), "catalog"], { windowsHide: true });
  const context = await browser.newContext({ baseURL: "https://localhost:3100", ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto("/encore/rooms");
    await expect(page.getByLabel("Your room name")).toBeEnabled();
    await page.getByRole("button", { name: "Join a room", exact: true }).tap();
    await expect(page.getByLabel("Room code", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Host a room", exact: true }).tap();
    await page.getByRole("button", { name: "Surprise us", exact: true }).tap();
    await expect(page.getByLabel("Find an artist")).toBeHidden();
    await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeDisabled();
    await page.getByLabel("Your room name").fill("WebKit Listener");
    await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Choose an artist", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Create room", exact: true })).toBeDisabled();
    await page.getByLabel("Find an artist").fill("Adele");
    await page.getByRole("button", { name: "Choose Adele", exact: true }).tap();
    await page.getByRole("button", { name: "Create room", exact: true }).tap();
    await expect(page.locator(".er-site")).toHaveAttribute("data-room-phase", "lobby");
    for (const [width, height] of [[320, 740], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Windows Playwright WebKit currently omits Web Audio. This intentionally
    // checks graceful fallback, not iOS Safari audio compatibility.
    const supported = await page.evaluate(() => Boolean(window.AudioContext || (window as unknown as {webkitAudioContext?:unknown}).webkitAudioContext));
    await page.getByRole("button", { name: "Ready up", exact: true }).tap();
    if (supported) await expect(page.getByRole("button", { name: "Not ready", exact: true })).toBeVisible();
    else {
      await expect(page.locator(".er-audio-error[role=alert]")).toContainText("This browser cannot play room audio");
      await expect(page.getByRole("button", { name: "Ready up", exact: true })).toBeVisible();
    }
    await page.screenshot({ path: "test-results-rooms/room-webkit-phone.png", fullPage: true });
  } finally { await context.close(); }
});
