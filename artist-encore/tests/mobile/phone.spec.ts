import { test, expect, type Page } from "@playwright/test";

async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
const sizes = [[320, 740], [360, 800], [390, 844], [430, 932], [844, 390], [1440, 1000]];

test("phone discovery, favorites, instructions and navigation fit narrow and short screens", async ({ page }) => {
  await page.goto("/encore/");
  await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await fits(page);
    await page.getByRole("button", { name: /^How to play/ }).tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    const rect = await page.getByRole("dialog").boundingBox();
    expect(rect!.height).toBeLessThanOrEqual(height - 16);
    await page.getByRole("button", { name: "Close instructions" }).tap();
    if (width === 390) {
      await page.screenshot({ path: `test-results-mobile/encore-logo-${test.info().project.name}-390.png` });
      await page.getByRole("button", { name: "High contrast", exact: true }).tap();
      await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
      await fits(page);
      await page.screenshot({ path: `test-results-mobile/encore-logo-contrast-${test.info().project.name}-390.png` });
      await page.getByRole("button", { name: "High contrast", exact: true }).tap();
    }
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByLabel("Who's on repeat?").tap();
  await page.getByLabel("Who's on repeat?").fill("Adele");
  const row = page.locator(".artist-result-row").filter({ has: page.getByText("Adele", { exact: true }) }).first();
  await expect(row).toBeVisible({ timeout: 45000 });
  await row.getByRole("button", { name: "Pin Adele as a favorite", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Play a mix by Adele" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Play a mix by Adele" })).toBeVisible();
  await page.locator(".favorite-card").getByRole("button", { name: "Unpin Adele", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Play a mix by Adele" })).toHaveCount(0);
  await page.getByRole("link", { name: "Musical Daily home", exact: true }).tap();
  await expect(page).toHaveURL(/\/$/);
});

test("touch play keeps all four options and timer together, supports lifeline, timeout, results and discard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/encore/");
  await page.getByRole("button", { name: "Adele", exact: true }).tap();
  await page.locator(".artist-option").filter({ has: page.getByText("Adele", { exact: true }) }).first().tap();
  await expect(page.getByRole("button", { name: "Play the clip" })).toBeVisible({ timeout: 90000 });
  await page.getByText("About this mix", { exact: true }).tap();
  await expect(page.locator(".mix-details-content")).toBeVisible();
  await page.getByText("About this mix", { exact: true }).tap();
  let correct = 0;
  for (let round = 0; round < 10; round++) {
    await page.setViewportSize({ width: round === 1 ? 844 : round % 2 ? 320 : 390, height: round === 1 ? 390 : round % 2 ? 740 : 844 });
    await page.getByRole("button", { name: "Play the clip" }).tap();
    await expect(page.locator(".answer-choices")).toBeVisible({ timeout: 35000 });
    await expect(page.locator(".song-choice")).toHaveCount(4);
    await fits(page);
    await expect(page.getByRole("timer")).toBeInViewport();
    if (round < 2) await page.screenshot({ path: `test-results-mobile/encore-guess-${test.info().project.name}-${round === 0 ? 390 : 844}.png`, fullPage: true });
    if (round === 0) {
      await page.getByRole("button", { name: /50\/50.*Use/ }).tap();
      await expect(page.locator(".song-choice")).toHaveCount(2);
      await expect(page.getByRole("timer")).toBeInViewport();
      await page.locator(".song-choice").first().tap();
    } else if (round === 1) {
      await page.getByRole("button", { name: "I don't know this one" }).tap();
    } else if (round === 2) {
      await expect(page.getByRole("timer")).toHaveClass(/urgent/, { timeout: 15000 });
      await page.getByRole("button", { name: "Encore home", exact: true }).tap();
      await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
      expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
      await page.getByRole("button", { name: "Back to your saved mix" }).tap();
    } else await page.locator(".song-choice").first().tap();
    await expect(page.locator(".reveal")).toBeVisible({ timeout: 20000 });
    if (await page.locator(".reveal").getAttribute("class").then(value => value?.includes("reveal-correct"))) correct++;
    await fits(page);
    await page.getByRole("button", { name: round === 9 ? "See my fan status" : "Next song" }).tap();
  }
  await expect(page.locator(".completed")).toBeVisible();
  await expect(page.locator(".final-score")).toHaveText(`${correct}/10`);
  await expect(page.locator(".result-list > a")).toHaveCount(10);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fits(page);
  await page.screenshot({ path: `test-results-mobile/encore-results-${test.info().project.name}-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { shared: string }).shared = value; } } }));
  await page.getByRole("button", { name: "Share your score" }).tap();
  expect(await page.evaluate(() => (window as unknown as { shared: string }).shared)).toContain("/encore/");
  await page.getByRole("button", { name: "One more encore" }).tap();
  await expect(page.getByRole("button", { name: "Play the clip" })).toBeVisible({ timeout: 45000 });
  await page.getByRole("button", { name: "Encore home", exact: true }).tap();
  await page.getByRole("button", { name: "Discard saved mix" }).tap();
  await expect(page.getByRole("status").filter({ hasText: "Your previous mix is recorded as incomplete" })).toBeVisible();
  expect(errors).toEqual([]);
});
