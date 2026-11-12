import { test, expect } from "@playwright/test";
import { act, correctChoice, createOnPage, fits, origin, post, read } from "./helpers";

test("WebKit touch can create a room and answer a timed co-op pick without Web Audio support", async ({ browser, playwright }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  const friend = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    const code = await createOnPage(page, "WebKit Crew");
    const joined = await post(friend, code, { action: "join", nickname: "Partner" });
    await act(friend, joined, "ready", { ready: true });
    await page.getByRole("button", { name: "Ready up", exact: true }).tap();
    await page.getByRole("button", { name: "Start the run", exact: true }).tap();
    await page.getByRole("button", { name: "Pick for the team", exact: true }).tap();
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.locator(".dr-pair button")).toHaveCount(2);
    await fits(page);
    await page.locator(`.dr-pair button[data-side=${correctChoice(code)}]`).tap();
    await expect(page.locator(".dr-site")).toHaveAttribute("data-room-phase", "reveal");
    expect((await read(page.request, code)).team.pot).toBe(100);
    await page.screenshot({ path: "test-results-rooms/coop-webkit-phone.png", fullPage: true });
  } finally { await Promise.all([context.close(), friend.dispose()]); }
});
