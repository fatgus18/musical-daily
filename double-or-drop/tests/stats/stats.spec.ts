import { test, expect, type Page } from "@playwright/test";
import type { AccountUser, GameId, GameStats } from "@musical-daily/accounts";

const alice: AccountUser = { id: "account-alice", name: "Alice Music", email: "alice@example.test", picture: null };
const bob: AccountUser = { id: "account-bob", name: "Bob Music", email: "bob@example.test", picture: null };
const base: GameStats = { played: 3, completed: 3, wins: 2, totalScore: 240, bestScore: 90, averageScore: 80, averagePercent: 80, totalCorrect: 24, totalRounds: 30, currentStreak: 2, bestStreak: 3, lastPlayed: "2026-11-02", recent: [{ eventId: "test-result-1", date: "2026-11-02", score: 8, maxScore: 10, won: false }] };
const games: Record<GameId, GameStats> = {
  blackjack: { ...base, recent: [{ ...base.recent[0], score: 90, maxScore: 100 }] },
  tempo: { ...base, bestScore: 4800, averageScore: 4000, recent: [{ ...base.recent[0], score: 4500, maxScore: 5000 }] },
  encore: { ...base, recent: [{ ...base.recent[0], artist: { id: "test-artist", name: "Hozier" } }] },
  "double-drop": { ...base, totalBanked: 3500, bestBanked: 2400, recent: [{ ...base.recent[0], bankedPoints: 2400 }] },
};
const apps = [
  { port: 3000, game: "blackjack", name: "Blackjack Music" },
  { port: 3001, game: null, name: "Musical Daily" },
  { port: 3002, game: "tempo", name: "Tempo Trap" },
  { port: 3004, game: "encore", name: "Encore" },
  { port: 3005, game: "double-drop", name: "Double or Drop" },
] as const;

async function account(page: Page, user: AccountUser | null = alice) {
  await page.route("**/api/account/session", route => route.fulfill({ json: { user, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
}

for (const app of apps) {
  test(`${app.name} has the same stats UI with the correct account scope`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await account(page);
    await page.goto(`http://localhost:${app.port}/stats`);
    await expect(page.getByText("Hey Alice.", { exact: false })).toBeVisible();
    await expect(page.locator(".md-stats-game-card")).toHaveCount(app.game ? 1 : 4);
    await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
    if (app.game) {
      await expect(page.getByRole("heading", { name: app.name + "." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your recent plays." })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to game", exact: false })).toHaveAttribute("href", "/");
      await expect(page.getByRole("link", { name: "All game stats", exact: false })).toHaveAttribute("href", "http://localhost:3001/stats");
    } else {
      await expect(page.getByText("12 games finished.", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "Make my call", exact: false })).toHaveAttribute("href", "http://localhost:3005/api/account/login?returnTo=%2F");
    }
    if (app.game === "double-drop") {
      await expect(page.locator(".md-stats-metric").filter({ has: page.locator("dt", { hasText: "Banked points" }) }).locator("dd")).toHaveText("3,500");
      await expect(page.getByText("2,400 banked", { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: `test-results/stats-${app.port}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/stats-${app.port}-mobile.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("guest stats show honest empty cards and sign in returns to the stats page", async ({ page }) => {
  await account(page, null);
  for (const app of apps) {
    await page.goto(`http://localhost:${app.port}/stats`);
    await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/api/account/login?returnTo=%2Fstats");
    await expect(page.locator(".md-stats-game-card")).toHaveCount(app.game ? 1 : 4);
    await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
    await expect(page.locator(".md-stats-history")).toHaveCount(0);
  }
});

test("a response for another account is rejected instead of rendering their scores", async ({ page }) => {
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: alice, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user: bob, games } }));
  await page.goto("http://localhost:3005/stats");
  await expect(page.locator(".md-stats-error[role=alert]")).toContainText("Your account changed");
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
  await expect(page.locator(".md-stats-history")).toHaveCount(0);
});

test("switching account clears previous scores while the new account is loading", async ({ page }) => {
  let user: AccountUser | null = alice;
  let release: (() => void) | undefined;
  await page.route("**/api/account/session", route => route.fulfill({ json: { user, configured: true } }));
  await page.route("**/api/account/stats", async route => {
    const identity = user;
    if (identity?.id === bob.id) await new Promise<void>(resolve => { release = resolve; });
    const stats = identity?.id === bob.id ? Object.fromEntries(Object.entries(games).map(([id, game]) => [id, { ...game, completed: 0, played: 0, totalBanked: 0, bestBanked: 0, recent: [] }])) : games;
    await route.fulfill({ json: { user: identity, games: stats } }).catch(() => {});
  });
  await page.goto("http://localhost:3005/stats");
  await expect(page.locator(".md-stats-metric").filter({ has: page.locator("dt", { hasText: "Banked points" }) }).locator("dd")).toHaveText("3,500");
  user = bob;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Hey Bob.", { exact: false })).toBeVisible();
  await expect(page.locator(".md-stats-history")).toHaveCount(0);
  await expect(page.locator(".md-stats-metric").filter({ has: page.locator("dt", { hasText: "Banked points" }) }).locator("dd")).not.toHaveText("3,500");
  await expect.poll(() => typeof release).toBe("function");
  release!();
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("0");
  user = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
});

test("a stats outage offers retry without substituting fabricated zero totals", async ({ page }) => {
  let fail = true;
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: alice, configured: true } }));
  await page.route("**/api/account/stats", route => fail ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fulfill({ json: { user: alice, games } }));
  await page.goto("http://localhost:3005/stats");
  await expect(page.locator(".md-stats-error[role=alert]")).toContainText("Your stats could not be loaded");
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: false }).click();
  await expect(page.locator(".md-stats-metric").filter({ has: page.locator("dt", { hasText: "Banked points" }) }).locator("dd")).toHaveText("3,500");
  await expect(page.locator(".md-stats-error[role=alert]")).toHaveCount(0);
});
