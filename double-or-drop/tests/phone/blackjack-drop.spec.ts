import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicGame } from "../../src/lib/types";
import type { CatalogTrack } from "../../src/lib/catalog-types";

const api = "/double-or-drop/api/game";
async function state(request: APIRequestContext, mode = "unlimited"): Promise<PublicGame> {
  return (await (await request.get(`${api}?mode=${mode}`)).json()).game;
}
function winner(game: PublicGame): "left" | "right" {
  const catalog = JSON.parse(readFileSync(resolve("data/catalog-releases", `${game.catalogVersion}.json`), "utf8"));
  const tracks = new Map<string, CatalogTrack>(catalog.tracks.map((track: CatalogTrack) => [track.id, track]));
  const left = tracks.get(game.pair.left.id)!.metrics[game.pair.metric]!.value;
  const right = tracks.get(game.pair.right.id)!.metrics[game.pair.metric]!.value;
  return (game.pair.metric === "year" ? left < right : left > right) ? "left" : "right";
}
async function pick(page: Page, game: PublicGame, correct: boolean) {
  const side = winner(game), index = (side === "left") === correct ? 0 : 1;
  const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === api);
  await page.locator(".song-pick").nth(index).tap();
  const result = await response;
  expect(result.ok()).toBe(true);
  return (await result.json()).game as PublicGame;
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function visiblePair(page: Page) {
  await expect.poll(() => page.locator(".pick-clock, .song-pick").evaluateAll(nodes => nodes.every(node => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  }))).toBe(true);
}

test("Blackjack touch preview cannot pick a card; bust, share, remix and dialogs work on a phone", async ({ page, baseURL }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width: 320, height: 740 });
  const loaded = page.waitForResponse(r => new URL(r.url()).pathname === "/blackjack/api/daily");
  await page.goto("/blackjack/");
  const board = await (await loaded).json();
  await expect(page.locator(".bj-track-card")).toHaveCount(9);
  await page.getByRole("button", { name: "How to Play", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "How to play Stream Blackjack" })).toBeVisible();
  await page.getByRole("button", { name: "Close instructions" }).tap();
  await page.getByRole("button", { name: "View streak and career stats" }).tap();
  await expect(page.getByRole("dialog", { name: "Your career stats" })).toBeVisible();
  await fits(page); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const preview = page.getByRole("button", { name: /^Play preview of/ }).first();
  const bounds = await preview.boundingBox(); expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await preview.tap();
  await expect(page.locator('.bj-track-card[data-state="picked"]')).toHaveCount(0);
  await page.waitForTimeout(200);
  const stop = page.getByRole("button", { name: /^(Cancel loading|Pause) preview of/ });
  if (await stop.count()) await stop.first().tap();
  // API response is test-only evidence used to deliberately exercise the bust
  // shield. It neither mutates the guest hand nor reveals values in the UI.
  const evidenceResponse = await page.request.post("/blackjack/api/finish", { headers: { origin: new URL(baseURL!).origin }, data: { date: board.date, catalogVersion: board.catalogVersion, rulesVersion: board.rulesVersion, pickedIds: board.tracks.map((t: { id: string }) => t.id) } });
  expect(evidenceResponse.ok()).toBe(true);
  const evidence = await evidenceResponse.json();
  const ordered = [...board.tracks].sort((a, b) => evidence.allStreams[b.id] - evidence.allStreams[a.id]);
  for (const track of ordered) {
    if (await page.locator(".bj-results").count()) break;
    const card = page.locator(".bj-track-card").filter({ has: page.getByRole("heading", { name: track.title, exact: true }) });
    await card.tap();
    await expect(card).not.toHaveAttribute("data-state", "ready");
    await expect(page.getByRole("button", { name: /Free Play/ })).toBeEnabled();
  }
  await expect(page.locator(".bj-results")).toHaveAttribute("data-result", "bust");
  await expect(page.locator(".bj-result-badge")).toContainText("over cap");
  await expect(page.locator(".bj-result-badge")).not.toContainText("Accuracy");
  await expect(page.locator('.bj-track-card[data-state="burned"]')).toHaveCount(1);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("sbj_daily_")));
  await page.locator(".hand-remix > summary").tap();
  await expect(page.locator(".remix-body")).toBeVisible();
  await expect(page.locator(".remix-icon svg")).toBeVisible();
  await page.getByRole("button", { name: /Give me a nudge/ }).tap(); await expect(page.locator(".remix-hint")).toContainText("Try adding");
  await page.getByRole("button", { name: "Show a best hand" }).tap(); await expect(page.locator(".remix-console")).toHaveClass(/is-perfect/);
  await page.getByRole("button", { name: "My original hand" }).tap(); await expect(page.locator(".remix-console")).toHaveClass(/is-over/);
  await page.getByRole("button", { name: "Clear", exact: true }).tap(); await expect(page.locator('.remix-records [aria-pressed="true"]')).toHaveCount(0);
  await page.locator(".remix-records button").first().tap(); await expect(page.locator('.remix-records [aria-pressed="true"]')).toHaveCount(1);
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 }); await fits(page);
    expect(await page.locator(".hand-remix").evaluate(panel => {
      const outer = panel.getBoundingClientRect();
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest('[aria-hidden="true"]')) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < outer.left || rect.right > outer.right))) return false;
      }
      return true;
    })).toBe(true);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.locator(".hand-remix").screenshot({ path: testInfo.outputPath(`blackjack-remix-${width}.png`) });
  }
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("sbj_daily_")))).toEqual(saved);
  // Clipboard permissions vary between browser engines. Verify the actual text
  // passed to the OS clipboard while retaining the real button interaction.
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedScore: string }).copiedScore = text; } } }); });
  await page.getByRole("button", { name: /Share Score/ }).tap(); await expect(page.getByRole("button", { name: /Score \+ link copied/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copiedScore: string }).copiedScore)).toContain(`${new URL(baseURL!).origin}/blackjack`);
  await page.getByRole("button", { name: /Free Play/ }).tap(); await expect(page.locator(".edition-badge")).toHaveText("FREE PLAY");
  await page.locator(".bj-track-card").first().tap(); await expect(page.locator('.bj-track-card[data-state="picked"]')).toHaveCount(1);
  await page.getByRole("button", { name: /Stand/i }).tap(); await expect(page.locator(".bj-results")).toBeVisible();
  await page.getByRole("button", { name: "Back to Daily" }).tap(); await expect(page.locator(".bj-results")).toHaveAttribute("data-result", "bust");
  await expect(page.locator(".bj-results")).toContainText("Next Daily Drop");
  await fits(page); expect(errors).toEqual([]);
});

test("Double or Drop touch setup, timed picks, bank, resume, timeout and discard", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/double-or-drop/");
  await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
  const collection = page.getByRole("combobox", { name: /Pick a collection/ });
  await collection.tap(); await page.getByRole("option", { name: /Pop party/ }).tap(); await expect(collection).toContainText("Pop party");
  await page.getByLabel("Or find an artist").fill("The Weeknd");
  const artist = page.locator(".artist-result").filter({ hasText: /songs to play with/ }).filter({ hasText: "The Weeknd" }).first();
  await artist.tap(); await expect(collection).toContainText("The Weeknd");
  await expect(page.getByLabel("Or find an artist")).toHaveCSS("font-size", "16px");
  await page.getByRole("button", { name: /Runtime/ }).tap();
  await page.getByRole("group", { name: "Bank goal" }).getByRole("button", { name: "500", exact: true }).tap();
  await page.getByRole("button", { name: "Let’s play", exact: true }).tap();
  await expect(page.locator(".song-pick")).toHaveCount(2); await visiblePair(page);
  await page.screenshot({ path: testInfo.outputPath("drop-guess-320.png") });
  let game = await state(page.request); expect(game.bankTarget).toBe(500);
  game = await pick(page, game, true); expect(game.pot).toBe(100);
  await page.getByRole("button", { name: /Bank & keep playing/ }).tap();
  await expect(page.locator(".pick-clock")).toBeVisible(); await visiblePair(page);
  game = await state(page.request); expect(game.banked).toBe(100);
  game = await pick(page, game, true);
  await page.getByRole("button", { name: /Risk for/ }).tap(); await expect(page.locator(".pick-clock")).toBeVisible();
  game = await state(page.request); game = await pick(page, game, false); expect(game.lives).toBe(2); expect(game.banked).toBe(100);
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).tap();
  await page.getByRole("button", { name: /Resume run/ }).tap(); await expect(page.getByText("2 lives left. Keep your groove.")).toBeVisible();
  await page.getByRole("button", { name: /Next pair/ }).tap();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload(); await expect(page.locator(".pick-clock")).toBeVisible(); await visiblePair(page); await fits(page);
  await page.screenshot({ path: testInfo.outputPath("drop-guess-landscape.png") });
  await expect(page.getByText("TIME’S UP", { exact: true })).toBeVisible({ timeout: 30000 });
  game = await state(page.request); expect(game.lives).toBe(1); expect(game.banked).toBe(100);
  await page.getByRole("button", { name: "How to play", exact: true }).tap(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close instructions", exact: true }).tap();
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).tap();
  await page.getByRole("button", { name: /Discard & start fresh/ }).tap();
  await expect(page.getByText("Ready for a fresh start.", { exact: true })).toBeVisible();
  game = await state(page.request); expect(game.completionStatus).toBe("incomplete"); expect(game.banked).toBe(100);
  await page.getByRole("button", { name: "Let’s play", exact: true }).tap();
  const fresh = await state(page.request); expect(fresh.id).not.toBe(game.id); expect(fresh.lives).toBe(3);
  await pick(page, fresh, true); await page.getByRole("button", { name: /Bank & finish run/ }).tap();
  await expect(page.getByRole("heading", { name: "That’s in the bank." })).toBeVisible();
  await page.locator(".run-history > summary").tap(); await expect(page.locator(".run-history li")).toHaveCount(1);
  await fits(page); expect(errors).toEqual([]);
});

test("Daily Drop retains the final wrong pick for three seconds before results on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/double-or-drop/?mode=daily");
  await page.getByRole("button", { name: "Drop into today’s mix" }).tap(); await visiblePair(page);
  let game = await state(page.request, "daily");
  for (let index = 0; index < 3; index++) {
    game = await pick(page, game, false);
    await expect(page.locator(".losing-card .your-pick")).toBeVisible();
    if (index < 2) { await page.getByRole("button", { name: /Next pair/ }).tap(); await expect(page.locator(".pick-clock")).toBeVisible(); game = await state(page.request, "daily"); }
  }
  await expect(page.locator(".result-panel")).toHaveCount(0);
  await page.waitForTimeout(1600); await expect(page.locator(".losing-card .your-pick")).toBeVisible();
  await expect(page.locator(".result-panel")).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("heading", { name: "Today’s mix. Your mark." })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("drop-daily-result.png"), fullPage: true });
  await page.reload(); await page.getByRole("button", { name: /View today’s result/ }).tap(); await expect(page.locator(".result-panel")).toBeVisible();
  await page.getByRole("button", { name: /Keep playing · Unlimited/ }).tap(); await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeVisible();
});

test("Phone collections and help remain readable at small widths and in landscape", async ({ page, browserName }, testInfo) => {
  await page.goto("/double-or-drop/"); await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
  for (const [width, height] of [[320, 740], [360, 800], [390, 844], [430, 932], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("combobox", { name: /Pick a collection/ }).tap();
    await fits(page);
    const menu = await page.locator(".collection-menu").boundingBox(); expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x + menu!.width).toBeLessThanOrEqual(width); expect(menu!.y).toBeGreaterThanOrEqual(0); expect(menu!.y + menu!.height).toBeLessThanOrEqual(height);
    if (width === 320) {
      const collection = page.getByRole("combobox", { name: /Pick a collection/ });
      const previous = await collection.innerText();
      const list = page.getByRole("listbox", { name: "Music collections" });
      if (browserName === "chromium") {
        // A real touch drag must scroll suggestions without selecting an option.
        const session = await page.context().newCDPSession(page);
        const box = (await list.boundingBox())!;
        const x = box.x + box.width / 2, startY = box.y + box.height - 25;
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
        for (let step = 1; step <= 5; step++) {
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - (box.height - 50) * step / 5 }] });
          await page.waitForTimeout(20);
        }
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      } else {
        // Playwright exposes native taps but no native swipe API for WebKit.
        // Verify scrolling preserves the menu and selection independently.
        await list.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
      }
      await expect(list).toBeVisible(); expect(await collection.innerText()).toBe(previous);
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await page.getByRole("button", { name: /Runtime/ }).tap(); await expect(list).toHaveCount(0);
      await collection.tap();
    }
    await page.locator(".collection-menu").screenshot({ path: testInfo.outputPath(`collections-${width}.png`) });
    await page.getByRole("option", { name: /Anything goes/ }).tap();
    await page.getByRole("button", { name: "How to play", exact: true }).tap(); await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = await page.getByRole("dialog").boundingBox(); expect(dialog!.height).toBeLessThanOrEqual(height - 30); await fits(page);
    await page.getByRole("button", { name: "Close instructions", exact: true }).tap();
  }
});
