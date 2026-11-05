import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Catalog } from "../../src/lib/catalog-types";
import type { PublicGame, Side, Move } from "../../src/lib/types";

const gameState = async (request: APIRequestContext): Promise<PublicGame> => (await (await request.get("/api/game")).json()).game;
function correctSide(game: PublicGame): Side {
  const catalog = JSON.parse(readFileSync(resolve(`data/catalog-releases/${game.catalogVersion}.json`), "utf8")) as Catalog;
  const left = catalog.tracks.find(track => track.id === game.pair.left.id)!.metrics[game.pair.metric]!.value;
  const right = catalog.tracks.find(track => track.id === game.pair.right.id)!.metrics[game.pair.metric]!.value;
  return (game.pair.metric === "year" ? left < right : left > right) ? "left" : "right";
}
async function apiMove(request: APIRequestContext, game: PublicGame, action: Move, choice?: Side): Promise<PublicGame> {
  const response = await request.post("/api/game", { data: { action, gameId: game.id, round: game.round, revision: game.revision, ...(choice ? { choice } : {}) } });
  expect(response.ok()).toBe(true);
  return (await response.json()).game;
}
async function start(page: Page, metric = "Runtime") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: metric, exact: false }).click();
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".song-pick")).toHaveCount(2);
  return gameState(page.request);
}
async function choose(page: Page, game: PublicGame, correct = true) {
  const winner = correctSide(game);
  const side = correct ? winner : winner === "left" ? "right" : "left";
  await page.keyboard.press(side === "left" ? "1" : "2");
  await expect(page.locator(".decision-panel, .result-panel")).toBeVisible();
  return gameState(page.request);
}

test("real catalog run banks, risks, restores and preserves protected points", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(page.locator(".catalog-count")).toHaveCount(0);
  const catalog = (await (await page.request.get("/api/game")).json()).catalog; expect(catalog.tracks).toBeGreaterThan(17000);
  await page.screenshot({ path: "test-results/lobby-desktop.png", fullPage: true });
  let game = await start(page);
  expect(game.pair.left).not.toHaveProperty("metrics"); expect(game.reveal).toBeUndefined();
  const original = game;
  game = await choose(page, game);
  expect(game.pot).toBe(100); expect(game.banked).toBe(0);
  await expect(page.getByRole("link", { name: "Recording details ↗" })).toHaveCount(2);
  const sourceVisible = await page.locator(".value-source").first().evaluate(el => {
    const source = el.getBoundingClientRect(); const card = el.closest(".song-card")!.getBoundingClientRect();
    return source.bottom <= card.bottom + 1;
  }); expect(sourceVisible).toBe(true);
  await page.screenshot({ path: "test-results/reveal-desktop.png", fullPage: true });
  const replay = await apiMove(page.request, original, "guess", correctSide(original)); expect(replay.correct).toBe(1); expect(replay.revision).toBe(game.revision);
  await page.keyboard.press("b"); await expect(page.locator(".comparison")).toHaveClass(/is-guessing/);
  game = await gameState(page.request); expect(game.banked).toBe(100); expect(game.pot).toBe(0);
  game = await choose(page, game);
  await page.keyboard.press("r"); await expect(page.locator(".comparison")).toHaveClass(/is-guessing/);
  game = await gameState(page.request); expect(game.pot).toBe(100); expect(game.nextReward).toBe(200);
  const invalid = await page.request.post("/api/game", { data: { action: "cashout", gameId: game.id, round: game.round, revision: game.revision } }); expect(invalid.status()).toBe(400);
  game = await choose(page, game, false); expect(game.lives).toBe(2); expect(game.banked).toBe(100); expect(game.pot).toBe(0);
  await page.reload(); await expect(page.getByText("2 lives left. Keep your groove.")).toBeVisible();
  expect((await gameState(page.request)).revision).toBe(game.revision);
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume run" })).toBeVisible();
  await page.getByRole("button", { name: "Resume run" }).click();
  await page.getByRole("button", { name: "Finish run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "That’s in the bank." })).toBeVisible();
  game = await gameState(page.request); expect(game.banked).toBe(100); expect(game.phase).toBe("complete");
  await page.getByText("Your last 3 picks", { exact: false }).click();
  await expect(page.getByText("100 pot", { exact: true })).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("six consecutive correct picks require banking; three misses never erase banked points", async ({ page }) => {
  let game = await start(page, "Streams");
  for (let i = 0; i < 6; i++) {
    game = await apiMove(page.request, game, "guess", correctSide(game));
    if (i < 5) game = await apiMove(page.request, game, "risk");
  }
  expect(game.pot).toBe(3200); expect(game.canRisk).toBe(false);
  await page.reload(); await expect(page.getByText("3,200. That deserves a bank.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Risk for/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Bank & keep playing" }).click();
  await expect(page.locator(".comparison")).toHaveClass(/is-guessing/);
  game = await gameState(page.request); expect(game.banked).toBe(3200);
  for (let i = 0; i < 3; i++) {
    game = await apiMove(page.request, game, "guess", correctSide(game) === "left" ? "right" : "left");
    if (i < 2) game = await apiMove(page.request, game, "next");
  }
  expect(game.phase).toBe("complete"); expect(game.lives).toBe(0); expect(game.banked).toBe(3200);
  await page.reload(); await expect(page.locator(".result-total")).toContainText("3,200");
  await page.getByRole("button", { name: "Play another run" }).click();
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".song-pick")).toHaveCount(2);
  const next = await gameState(page.request); expect(next.id).not.toBe(game.id); expect(next.banked).toBe(0); expect(next.lives).toBe(3);
});

test("artist collections, artwork fallback, mobile layout and accessible help", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(/https:\/\/(?:[^/]*\.)?(?:mzstatic\.com|scdn\.co)\//, route => route.abort());
  await page.goto("/"); await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
  await page.getByLabel("Or find an artist").fill("The Weeknd");
  await page.locator(".artist-results button").filter({ hasText: "The Weeknd" }).filter({ hasText: /\d+ songs/ }).first().click();
  await expect(page.getByRole("combobox", { name: "Pick a collection", exact: false })).toContainText("The Weeknd");
  await page.screenshot({ path: "test-results/lobby-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".song-pick")).toHaveCount(2);
  await page.getByRole("button", { name: "How to play", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  const before = await gameState(page.request); await page.keyboard.press("1"); expect((await gameState(page.request)).revision).toBe(before.revision);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await choose(page, before); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".decision-panel")).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: "test-results/reveal-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "Musical Daily home", exact: true }).click(); await expect(page).toHaveURL("http://localhost:3001/");
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Double or Drop", exact: true }) }).click(); await expect(page).toHaveURL("http://localhost:3005/");
});

test("lost response restores the committed guess without scoring twice", async ({ page }) => {
  let game = await start(page);
  let intercepted = false;
  await page.route("**/api/game", async route => {
    if (!intercepted && route.request().method() === "POST" && route.request().postDataJSON().action === "guess") {
      intercepted = true; await route.fetch(); await route.abort("connectionreset"); return;
    }
    await route.continue();
  });
  game = await choose(page, game);
  expect(game.correct).toBe(1); expect(game.pot).toBe(100); expect(intercepted).toBe(true);
  await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Retry" }) })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.locator(".error-banner")).toHaveCount(0);
  expect((await gameState(page.request)).correct).toBe(1);
});

test("API rejects cross-origin writes and another browser cannot access a run", async ({ page, playwright }) => {
  const game = await start(page);
  const body = { action: "guess", gameId: game.id, round: game.round, revision: game.revision, choice: "left" };
  const crossSite = await page.request.post("/api/game", { data: body, headers: { Origin: "https://unrelated.example" } }); expect(crossSite.status()).toBe(403);
  const outsider = await playwright.request.newContext({ baseURL: "http://localhost:3005" });
  expect((await outsider.post("/api/game", { data: body })).status()).toBe(404);
  expect((await outsider.get("/api/game")).headers()["cache-control"]).toBe("no-store");
  await outsider.dispose();
  await page.getByRole("button", { name: "Finish run", exact: false }).click();
  await expect(page.getByRole("heading", { name: "Run left incomplete." })).toBeVisible();
  expect((await gameState(page.request)).completionStatus).toBe("incomplete");
});
