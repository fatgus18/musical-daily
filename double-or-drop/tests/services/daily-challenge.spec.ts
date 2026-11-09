import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";
import type { PublicGame } from "../../src/lib/types";
import type { CatalogTrack } from "../../src/lib/catalog-types";

const api = "/double-or-drop/api/game";
function answer(game: PublicGame): "left" | "right" {
  // Test-only fixture evidence. The public API must never return these values
  // before a pick. Catalogs are immutable and deployed from this same checkout.
  const catalog = JSON.parse(readFileSync(resolve("data/catalog-releases", `${game.catalogVersion}.json`), "utf8"));
  const tracks = new Map<string, CatalogTrack>(catalog.tracks.map((track: CatalogTrack) => [track.id, track]));
  const left = tracks.get(game.pair.left.id)!.metrics[game.pair.metric]!.value;
  const right = tracks.get(game.pair.right.id)!.metrics[game.pair.metric]!.value;
  return (game.pair.metric === "year" ? left < right : left > right) ? "left" : "right";
}
async function move(request: APIRequestContext, origin: string, data: object): Promise<PublicGame> {
  const response = await request.post(api, { headers: { origin }, data });
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()).game;
}

test("daily attempts are shared, resumable, bounded to ten and independent of unlimited", async ({ request, playwright, baseURL }) => {
  test.setTimeout(180000); // Real remote DB round trips; each pick still has its normal 20s clock.
  const origin = new URL(baseURL!).origin;
  const initial = await request.get(`${api}?mode=daily`);
  expect(initial.ok()).toBe(true); // Establish one guest identity before racing creates.
  const unlimited = await move(request, origin, { action: "create", mode: "unlimited", requestId: randomUUID(), metricFilter: "duration" });
  const forbidden = await request.post(api, { headers: { origin }, data: { action: "create", mode: "daily", requestId: randomUUID(), seed: "reroll" } });
  expect(forbidden.status()).toBe(400);
  const [first, raced] = await Promise.all([0, 1].map(() => move(request, origin, { action: "create", mode: "daily", requestId: randomUUID() })));
  expect(first.id).toBe(raced.id);
  expect(first.mode).toBe("daily"); expect(first.totalPicks).toBe(10);
  expect(first).not.toHaveProperty("dailyPairs"); expect(first.pair.left).not.toHaveProperty("metrics");
  expect(first.reveal).toBeUndefined(); expect(first.results).toEqual([]);

  expect(unlimited.id).not.toBe(first.id); expect(unlimited.mode).toBe("unlimited");
  expect((await (await request.get(`${api}?mode=daily`)).json()).game.id).toBe(first.id);

  let game = first;
  for (let index = 0; index < 10; index++) {
    expect(game.round).toBe(index); expect(game.phase).toBe("guess");
    game = await move(request, origin, { action: "guess", gameId: game.id, round: game.round, revision: game.revision, choice: answer(game) });
    expect(game.reveal?.correct).toBe(true);
    if (index < 9) game = await move(request, origin, { action: "bank", gameId: game.id, round: game.round, revision: game.revision });
  }
  expect(game.phase).toBe("complete"); expect(game.endReason).toBe("daily-complete");
  expect(game.banked).toBe(1000); expect(game.pot).toBe(0); expect(game.correct).toBe(10);
  const retry = await move(request, origin, { action: "create", mode: "daily", requestId: randomUUID() });
  expect(retry.id).toBe(game.id); expect(retry.banked).toBe(1000);
  // Verify another identity after finishing, so unrelated network checks cannot
  // consume the first player's live guessing window on a distant deployment.
  const state = await request.storageState();
  const other = await playwright.request.newContext({ baseURL, storageState: { cookies: state.cookies.filter(cookie => cookie.name === "_vercel_jwt"), origins: [] } });
  try {
    const same = await move(other, origin, { action: "create", mode: "daily", requestId: randomUUID() });
    expect(same.id).not.toBe(first.id); expect(same.pair).toEqual(first.pair);
    await move(other, origin, { action: "discard", gameId: same.id, round: same.round, revision: same.revision });
    const consumed = await move(other, origin, { action: "create", mode: "daily", requestId: randomUUID() });
    expect(consumed.id).toBe(same.id); expect(consumed.completionStatus).toBe("incomplete");
  } finally { await other.dispose(); }
  const savedUnlimited = (await (await request.get(`${api}?mode=unlimited`)).json()).game as PublicGame;
  expect(savedUnlimited.id).toBe(unlimited.id);
  await move(request, origin, { action: "discard", gameId: savedUnlimited.id, round: savedUnlimited.round, revision: savedUnlimited.revision });
});

test("daily lobby stays opt-in and a final miss remains visible before the result", async ({ page, baseURL }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/double-or-drop/?mode=daily");
  await expect(page.getByRole("button", { name: "Drop into today’s mix" })).toBeVisible();
  await expect(page.locator(".song-pick")).toHaveCount(0);
  const origin = new URL(baseURL!).origin;
  let game = await move(page.request, origin, { action: "create", mode: "daily", requestId: randomUUID() });
  for (let index = 0; index < 2; index++) {
    const wrong = answer(game) === "left" ? "right" : "left";
    game = await move(page.request, origin, { action: "guess", gameId: game.id, round: game.round, revision: game.revision, choice: wrong });
    game = await move(page.request, origin, { action: "next", gameId: game.id, round: game.round, revision: game.revision });
  }
  await page.reload(); await page.getByRole("button", { name: /Resume run/ }).click();
  await expect(page.locator(".daily-progress")).toBeVisible();
  const wrong = answer(game) === "left" ? 1 : 0;
  const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === api);
  await page.locator(".song-pick").nth(wrong).click(); await response;
  await expect(page.locator(".song-card.losing-card .your-pick")).toBeVisible();
  await expect(page.locator(".result-panel")).toHaveCount(0);
  await page.waitForTimeout(1800);
  await expect(page.locator(".song-card.losing-card .your-pick")).toBeVisible();
  await expect(page.locator(".result-panel")).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("heading", { name: "Today’s mix. Your mark." })).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: /View today’s result/ }).click();
  await expect(page.locator(".result-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("hub filters expose all three daily and all three anytime games on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
  await page.getByRole("button", { name: "Daily ritual", exact: true }).click();
  await expect(page.locator(".game-card:visible")).toHaveCount(3);
  await expect(page.locator(".double-drop-card")).toHaveAttribute("href", /double-or-drop\/\?mode=daily$/);
  await page.getByRole("button", { name: "Play anytime", exact: true }).click();
  await expect(page.locator(".game-card:visible")).toHaveCount(3);
  await expect(page.locator(".tempo-card")).toBeVisible();
  await page.getByRole("button", { name: "All games", exact: true }).click();
  await expect(page.locator(".game-card:visible")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
