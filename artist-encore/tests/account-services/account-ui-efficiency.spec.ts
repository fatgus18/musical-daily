import { expect, test, type Page } from "@playwright/test";

// Browser transport fixtures only: these never create server sessions or write
// scores. Run against the local account-enabled services gateway.
const user = { id: "browser-account-a", name: "Avery Listener", email: "avery@example.test", picture: null };
const staleUser = { id: "browser-account-b", name: "Stale Listener", email: "stale@example.test", picture: null };
const empty = { played: 0, completed: 0, incomplete: 0, wins: 0, totalScore: 0, bestScore: 0, averageScore: 0, averagePercent: 0, totalCorrect: 0, totalRounds: 0, totalBanked: 0, bestBanked: 0, currentStreak: 0, bestStreak: 0, lastPlayed: null, recent: [] };
const games = { blackjack: empty, tempo: empty, encore: empty, "double-drop": empty };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function focusBurst(page: Page) {
  await page.evaluate(() => {
    for (let count = 0; count < 3; count++) {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
}

test("every services stats page reads the central root account endpoints", async ({ page }) => {
  const paths: string[] = [];
  await page.route("**/api/account/session", async route => {
    paths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { user, configured: true } });
  });
  await page.route("**/api/account/stats", async route => {
    paths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { user, games } });
  });
  for (const prefix of ["", "/blackjack", "/tempo-trap", "/encore", "/double-or-drop"]) {
    paths.length = 0;
    await page.goto(`${prefix}/stats`);
    await expect(page.getByText("Hey Avery.", { exact: false })).toBeVisible();
    await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
    expect(paths).toContain("/api/account/session");
    expect(paths).toContain("/api/account/stats");
    expect(paths.every(path => path === "/api/account/session" || path === "/api/account/stats")).toBe(true);
  }
});

test("focus, pageshow and visibility bursts share pending session and stats requests", async ({ page }) => {
  const held = gate();
  let hold = false;
  let sessions = 0;
  let stats = 0;
  await page.route("**/api/account/session", async route => {
    sessions++;
    if (hold) await held.promise;
    await route.fulfill({ json: { user, configured: true } });
  });
  await page.route("**/api/account/stats", async route => {
    stats++;
    if (hold) await held.promise;
    await route.fulfill({ json: { user, games } });
  });
  await page.goto("/encore/stats");
  await expect(page.getByText("Hey Avery.", { exact: false })).toBeVisible();
  await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
  const initial = { sessions, stats };
  hold = true;
  await focusBurst(page);
  await expect.poll(() => ({ sessions, stats })).toEqual({ sessions: initial.sessions + 1, stats: initial.stats + 1 });
  await focusBurst(page);
  // Allow a second browser task so aborted/restarted effect requests would surface.
  await page.waitForTimeout(150);
  expect({ sessions, stats }).toEqual({ sessions: initial.sessions + 1, stats: initial.stats + 1 });
  held.release();
});

test("logout blocks refreshes until cookie revocation and ignores a stale in-flight account", async ({ page }) => {
  const heldSession = gate();
  const heldLogout = gate();
  let holdSession = false;
  let signedIn = true;
  let sessions = 0;
  let logoutStarted = false;
  await page.route("**/api/account/session", async route => {
    sessions++;
    const stale = holdSession;
    if (stale) await heldSession.promise;
    await route.fulfill({ json: { user: stale ? staleUser : signedIn ? user : null, configured: true } }).catch(() => {});
  });
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
  await page.route("**/api/account/logout", async route => {
    expect(new URL(route.request().url()).pathname).toBe("/api/account/logout");
    expect(route.request().method()).toBe("POST");
    logoutStarted = true;
    await heldLogout.promise;
    signedIn = false;
    holdSession = false;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/encore/stats");
  await expect(page.getByText("Hey Avery.", { exact: false })).toBeVisible();
  await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
  const initial = sessions;
  holdSession = true;
  await focusBurst(page);
  await expect.poll(() => sessions).toBe(initial + 1);
  await page.getByRole("button", { name: /Avery/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => logoutStarted).toBe(true);
  const duringLogout = sessions;
  await focusBurst(page);
  heldSession.release();
  await page.waitForTimeout(150);
  expect(sessions).toBe(duringLogout);
  await expect(page.getByText("Hey Stale.", { exact: false })).toHaveCount(0);
  heldLogout.release();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
  await expect(page.getByText("Hey Avery.", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Hey Stale.", { exact: false })).toHaveCount(0);
  expect(sessions).toBe(duringLogout + 1);
});
