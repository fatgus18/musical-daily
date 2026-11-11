import { test, expect, type Page } from "@playwright/test";

const sizes = [[320, 740], [360, 800], [390, 844], [430, 932], [844, 390], [1440, 1000]];
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function restoreGuess(page: Page, seconds = 15) {
  await page.evaluate(seconds => {
    const key = Object.keys(localStorage).find(key => key.startsWith("tempo:daily:"))!;
    const state = JSON.parse(localStorage.getItem(key)!);
    state.progress.phase = "guessing";
    state.progress.deadline = Date.now() + seconds * 1000;
    state.progress.guess = "";
    localStorage.setItem(key, JSON.stringify(state));
  }, seconds);
  await page.reload();
}

test("phone controls, help, scoring, saved rounds, sharing and practice remain usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tempo-trap/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await fits(page);
    await page.getByRole("button", { name: "How to play", exact: true }).tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    const rect = await page.getByRole("dialog").boundingBox();
    expect(rect!.height).toBeLessThanOrEqual(height - 16);
    await page.getByRole("button", { name: "Sounds good" }).tap();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await page.setViewportSize({ width: 360, height: 800 });
  const strip = await page.locator(".playback-progress").boundingBox();
  const record = await page.locator(".record-panel").boundingBox();
  expect(strip!.width).toBeGreaterThan(record!.width * .8);

  // Only this fresh guest context is modified. Server scoring still validates
  // each signed round; restoring the phase avoids five long media waits here.
  // A fixed client clock keeps this layout test independent of screenshot/CI
  // latency. The separate real-audio case exercises the unmodified deadline.
  await page.clock.setFixedTime(new Date());
  for (let round = 0; round < 5; round++) {
    if (round === 1) await page.setViewportSize({ width: 844, height: 390 });
    await restoreGuess(page);
    await expect(page.getByLabel("YOUR GUESS", { exact: true })).toBeVisible();
    if (round === 0) {
      await page.screenshot({ path: `test-results-mobile/tempo-guess-${test.info().project.name}-360.png` });
      await page.setViewportSize({ width: 360, height: 460 });
      await page.getByLabel("YOUR GUESS", { exact: true }).tap();
      await page.getByLabel("YOUR GUESS", { exact: true }).fill("999");
      await expect(page.getByRole("button", { name: "Lock in my guess" })).toBeDisabled();
      await page.getByLabel("YOUR GUESS", { exact: true }).fill("100");
      await expect(page.getByRole("button", { name: "Lock in my guess" })).toBeInViewport();
    } else await page.getByLabel("YOUR GUESS", { exact: true }).fill("100");
    await expect(page.getByRole("timer")).toBeInViewport({ ratio: .95 });
    await expect(page.getByRole("button", { name: "Lock in my guess" })).toBeInViewport({ ratio: .95 });
    await page.getByRole("button", { name: "Lock in my guess" }).tap();
    await expect(page.locator(".reveal-content")).toBeVisible();
    await fits(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("button", { name: round === 4 ? "See my results" : "Next round" }).tap();
  }
  await expect(page.locator(".results-panel")).toBeVisible();
  await expect(page.locator(".result-tracks > div")).toHaveCount(5);
  for (const [width, height] of sizes) { await page.setViewportSize({ width, height }); await fits(page); }
  await page.screenshot({ path: `test-results-mobile/tempo-results-${test.info().project.name}-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { shared: string }).shared = value; } } }));
  await page.getByRole("button", { name: "Share your score" }).tap();
  expect(await page.evaluate(() => (window as unknown as { shared: string }).shared)).toContain("/tempo-trap/");
  await page.reload();
  await expect(page.locator(".results-panel")).toBeVisible();
  await page.getByRole("button", { name: "Play another mix" }).tap();
  await expect(page.getByRole("button", { name: "Practice" })).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await page.getByRole("button", { name: "Daily mix" }).tap();
  await expect(page.locator(".results-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a phone plays the real preview, highlights the final seconds and submits one timeout", async ({ page }) => {
  await page.goto("/tempo-trap/");
  test.skip(!await page.evaluate(() => typeof AudioContext !== "undefined"), "The Windows Playwright WebKit port has no Web Audio implementation; actual preview playback is covered in Chromium.");
  await page.getByRole("button", { name: "Let’s hear it" }).tap();
  await expect(page.getByText("JUST LISTEN", { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole("timer")).toContainText("SECONDS LEFT");
  await expect(page.getByRole("timer")).toHaveClass(/urgent/, { timeout: 15000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("timer")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".reveal-content")).toBeVisible({ timeout: 12000 });
  await expect(page.locator(".comparison")).toContainText("no answer");
  await page.reload();
  await expect(page.locator(".reveal-content")).toBeVisible();
  await expect(page.locator(".round-tracker .done")).toHaveCount(1);
});

test("an unsupported audio browser explains the problem without consuming the round", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: undefined });
  });
  await page.goto("/tempo-trap/");
  await page.getByRole("button", { name: "Let’s hear it" }).tap();
  await expect(page.getByRole("alert").filter({ hasText: "Audio playback isn't supported" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeEnabled();
  await expect(page.locator(".round-tracker .done")).toHaveCount(0);
});
