import { test, expect, type Page } from "@playwright/test";

const hub = "http://localhost:3001";
const user = { id: "ui-test-a", name: "Avery Listener", email: "avery@example.test", picture: null };
const secondUser = { id: "ui-test-b", name: "Sam Listener", email: "sam@example.test", picture: null };
const empty = { played: 0, completed: 0, wins: 0, totalScore: 0, bestScore: 0, averageScore: 0, averagePercent: 0, totalCorrect: 0, totalRounds: 0, totalBanked: 0, bestBanked: 0, currentStreak: 0, bestStreak: 0, lastPlayed: null, recent: [] };
const games = {
  blackjack: { ...empty, played: 8, completed: 8, wins: 6, totalScore: 720, bestScore: 98, averageScore: 90, averagePercent: 90, currentStreak: 3, bestStreak: 5, recent: [{ eventId: "b1", date: "2026-11-01", score: 98, maxScore: 100, won: true }] },
  tempo: { ...empty, played: 4, completed: 4, totalScore: 14520, bestScore: 4310, averageScore: 3630, averagePercent: 72.6, currentStreak: 2, bestStreak: 3, recent: [{ eventId: "t1", date: "2026-11-01", score: 4310, maxScore: 5000, won: false }] },
  encore: { ...empty, played: 3, completed: 3, wins: 1, totalCorrect: 24, totalRounds: 30, bestScore: 10, averageScore: 8, averagePercent: 80, recent: [{ eventId: "e1", date: "2026-11-01", score: 10, maxScore: 10, won: true, artist: { id: "a1", name: "Hozier" } }] },
  "double-drop": { ...empty, played: 2, completed: 2, wins: 1, totalCorrect: 7, totalRounds: 12, averagePercent: 58, totalBanked: 700, bestBanked: 700, recent: [{ eventId: "d1", date: "2026-11-03", score: 6, maxScore: 8, won: true, bankedPoints: 700 }] },
};
async function stacked(page: Page) {
  const boxes = await page.locator(".md-stats-game-card").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, bottom: box.bottom }; }));
  expect(boxes).toHaveLength(4);
  expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(1);
  expect(Math.abs(boxes[1].x - boxes[2].x)).toBeLessThan(1);
  expect(boxes[1].y).toBeGreaterThan(boxes[0].bottom + 15);
  expect(boxes[2].y).toBeGreaterThan(boxes[1].bottom + 15);
  expect(boxes[3].y).toBeGreaterThan(boxes[2].bottom + 15);
  expect(Math.abs(boxes[3].width - boxes[0].width)).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("hub stats offers Google sign-in without inventing guest scores; cards stack on mobile", async ({ page }) => {
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user: null, configured: true } }));
  await page.goto(`${hub}/stats?accountError=sign-in-failed`);
  await expect(page.locator(".md-account-notice")).toHaveText(/Google sign-in did not finish/);
  await expect(page).toHaveURL(`${hub}/stats`);
  await page.getByRole("button", { name: "Dismiss sign-in message" }).click();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/api/account/login?returnTo=%2Fstats");
  await expect(page.locator(".md-stats-metric dd")).toHaveText(Array(16).fill("—"));
  await stacked(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "My stats" })).toBeVisible();
  await stacked(page);
  await page.screenshot({ path: "test-results/stats-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".md-account-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".md-account-panel")).toHaveCount(0);
});

test("account statistics render all four game histories and authenticated game links", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user, configured: true } }));
  await page.route(`${hub}/api/account/stats`, route => route.fulfill({ json: { user, games } }));
  await page.goto(`${hub}/stats`);
  await expect(page.getByText("17 games finished. Look at you go.")).toBeVisible();
  await expect(page.locator(".md-stats-blackjack .md-stats-metric dd")).toHaveText(["8", "6", "98%", "90%"]);
  await expect(page.locator(".md-stats-tempo .md-stats-metric dd")).toHaveText(["4", "4,310 / 5,000", "3,630", "2 days"]);
  await expect(page.locator(".md-stats-encore .md-stats-metric dd")).toHaveText(["3", "24", "80%", "1"]);
  await expect(page.locator(".md-stats-double-drop .md-stats-metric dd")).toHaveText(["700", "700", "58%", "1"]);
  await expect(page.getByRole("link", { name: "Make my call" })).toHaveAttribute("href", "http://localhost:3005/api/account/login?returnTo=%2F");
  await expect(page.getByText("Hozier", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Find my artist" })).toHaveAttribute("href", "http://localhost:3004/api/account/login?returnTo=%2F");
  await stacked(page);
  await page.screenshot({ path: "test-results/stats-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "All games", exact: true }).click();
  await expect(page.locator(".encore-card")).toHaveAttribute("href", "http://localhost:3004/api/account/login?returnTo=%2F");
  await expect(page.locator(".double-drop-card")).toHaveAttribute("href", "http://localhost:3005/api/account/login?returnTo=%2F");
  await expect(page.locator(".game-card")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("logout immediately removes prior account stats and restores guest links", async ({ page }) => {
  let signedIn = true;
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user: signedIn ? user : null, configured: true } }));
  await page.route(`${hub}/api/account/stats`, route => route.fulfill({ json: { user, games } }));
  await page.route(`${hub}/api/account/logout`, route => { expect(route.request().method()).toBe("POST"); signedIn = false; return route.fulfill({ json: { ok: true } }); });
  await page.goto(`${hub}/stats`);
  await expect(page.getByText("Hozier", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Avery/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("Hozier", { exact: true })).toHaveCount(0);
  await expect(page.locator(".md-stats-metric dd")).toHaveText(Array(16).fill("—"));
  await expect(page.getByRole("link", { name: "Find my artist" })).toHaveAttribute("href", "http://localhost:3004");
});

test("account changes discard previous person's history and empty accounts show honest empty states", async ({ page }) => {
  let identity = user;
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user: identity, configured: true } }));
  await page.route(`${hub}/api/account/stats`, route => route.fulfill({ json: { user: identity, games: identity.id === user.id ? games : { blackjack: empty, tempo: empty, encore: empty, "double-drop": empty } } }));
  await page.goto(`${hub}/stats`);
  await expect(page.getByText("Hozier", { exact: true })).toBeVisible();
  identity = secondUser;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/Hey Sam\./)).toBeVisible();
  await expect(page.getByText("Hozier", { exact: true })).toHaveCount(0);
  await expect(page.locator(".md-stats-blackjack .md-stats-metric dd")).toHaveText(["0", "0", "—", "—"]);
  await expect(page.getByText("Your first score will look lovely here.")).toHaveCount(4);
});

test("stats errors retry safely and unconfigured Google has a clear accessible state", async ({ page }) => {
  let fail = true;
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user, configured: true } }));
  await page.route(`${hub}/api/account/stats`, route => fail ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fulfill({ json: { user, games } }));
  await page.goto(`${hub}/stats`);
  await expect(page.locator(".md-stats-error[role=alert]")).toContainText("Your stats could not be loaded");
  await expect(page.locator(".md-stats-metric dd")).toHaveText(Array(16).fill("—"));
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Hozier", { exact: true })).toBeVisible();
  await page.unroute(`${hub}/api/account/session`);
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user: null, configured: false } }));
  await page.reload();
  await expect(page.getByText("Google sign-in is being set up. You can keep playing as a guest.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
});

test("four-game hub stays a balanced desktop grid and Double or Drop supports narrow screens", async ({ page }) => {
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user: null, configured: true } }));
  await page.goto(hub);
  await expect(page.locator(".game-count")).toContainText("4 games");
  await expect(page.locator(".double-drop-card")).toHaveAttribute("href", "http://localhost:3005");
  const boxes = await page.locator(".game-card").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width }; }));
  expect(boxes).toHaveLength(4);
  for (let index = 1; index < boxes.length; index++) { expect(boxes[index].y).toBe(boxes[0].y); expect(boxes[index].x).toBeGreaterThan(boxes[index - 1].x); }
  await page.screenshot({ path: "test-results/hub-four-games-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.locator(".double-drop-card h3").evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(800);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/hub-four-games-mobile.png", fullPage: true });
  await page.unroute(`${hub}/api/account/session`);
  await page.route(`${hub}/api/account/session`, route => route.fulfill({ json: { user, configured: true } }));
  await page.route(`${hub}/api/account/stats`, route => route.fulfill({ json: { user, games: { ...games, "double-drop": { ...games["double-drop"], totalBanked: 1234567890, bestBanked: 1000000000 } } } }));
  await page.goto(`${hub}/stats`);
  await expect(page.locator(".md-stats-double-drop .md-stats-metric dd")).toHaveText(["2", "0", "1.2B", "1B", "58%", "1"]);
  await expect(page.locator(".md-stats-double-drop .md-stats-metric").filter({ has: page.locator("dt", { hasText: "Banked points" }) }).locator("dd")).toHaveAttribute("title", "1,234,567,890 protected points, including incomplete runs");
  await stacked(page);
});
