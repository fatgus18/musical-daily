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

test("account bootstrap starts while animation frames are suspended", async ({ page }) => {
  await page.addInitScript(() => {
    // Deterministically model a background tab whose animation frames never run.
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  let sessions = 0;
  await page.route("**/api/account/session", route => {
    sessions++;
    return route.fulfill({ json: { user, configured: true } });
  });
  await page.goto("/");
  await expect.poll(() => sessions).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /Avery/ })).toBeVisible();
});

const tempoPuzzle = {
  date: "2026-11-14", number: 1, mode: "daily", seed: "test", version: "test", token: "test-round",
  serverNow: Date.UTC(2026, 10, 14, 12),
  accountProgress: { round: 0, phase: "ready", guess: "", deadline: null, results: [], token: "test-round" },
  tracks: Array.from({ length: 5 }, (_, index) => ({ id: `test-${index}`, title: `Song ${index}`, artist: `Artist ${index}`, album: "Album", year: 2026, artworkUrl: "", previewUrl: "/api/test-preview", spotifyUrl: "", appleMusicUrl: "", clipStartSeconds: 0, clipSeconds: 15 })),
};

test("Tempo is playable while central account statistics are still pending", async ({ page }) => {
  const held = gate();
  const paths: string[] = [];
  await page.route("**/api/account/session", route => route.fulfill({ json: { user, configured: true } }));
  await page.route("**/api/daily?*", route => route.fulfill({ json: tempoPuzzle }));
  await page.route("**/api/test-preview", route => route.fulfill({ body: "", contentType: "audio/mpeg" }));
  await page.route("**/api/account/stats", async route => {
    paths.push(new URL(route.request().url()).pathname);
    await held.promise;
    await route.fulfill({ json: { user, games } }).catch(() => {});
  });
  try {
    await page.goto("/tempo-trap");
    await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible({ timeout: 5000 });
    await expect.poll(() => paths).toEqual(["/api/account/stats"]);
  } finally { held.release(); }
});

test("account timeouts keep the verified profile, stop gameplay, and allow a fresh retry", async ({ page }) => {
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => timeout(Math.min(milliseconds, 750));
  });
  const held = gate();
  let stalled = false;
  let sessions = 0;
  await page.route("**/api/account/session", async route => {
    sessions++;
    if (stalled) await held.promise;
    await route.fulfill({ json: { user, configured: true } }).catch(() => {});
  });
  await page.route("**/api/daily?*", route => route.fulfill({ json: tempoPuzzle }));
  await page.route("**/api/test-preview", route => route.fulfill({ body: "", contentType: "audio/mpeg" }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
  try {
    await page.goto("/tempo-trap");
    await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
    stalled = true;
    await focusBurst(page);
    await expect(page.getByRole("button", { name: "Retry account connection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Let’s hear it" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Avery/ })).toBeVisible();
    const timedOutReads = sessions;
    stalled = false;
    await page.getByRole("button", { name: "Retry account connection" }).click();
    await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
    expect(sessions).toBeGreaterThan(timedOutReads);
  } finally { held.release(); }
});

test("Encore restore errors offer retry before an existing mix can be replaced", async ({ page }) => {
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: null, configured: true } }));
  let reads = 0;
  await page.route("**/encore/api/game", route => {
    reads++;
    return reads === 1
      ? route.fulfill({ status: 503, json: { error: "Your saved mix could not be loaded. Please retry." } })
      : route.fulfill({ json: { game: null, audioEnabled: true, statsSynced: true } });
  });
  await page.goto("/encore");
  await expect(page.getByRole("button", { name: "Retry saved mix" })).toBeVisible();
  await expect(page.getByLabel("Who's on repeat?")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry saved mix" }).click();
  await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
  expect(reads).toBe(2);
});

test("a statistics timeout releases loading and retry reads fresh scores", async ({ page }) => {
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => timeout(Math.min(milliseconds, 750));
  });
  const held = gate();
  let reads = 0;
  await page.route("**/api/account/session", route => route.fulfill({ json: { user, configured: true } }));
  await page.route("**/api/account/stats", async route => {
    reads++;
    if (reads === 1) await held.promise;
    await route.fulfill({ json: { user, games } }).catch(() => {});
  });
  try {
    await page.goto("/encore/stats");
    await expect(page.getByText("Your stats took too long to load. Your saved scores are still safe. Please retry.")).toBeVisible();
    await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
    await page.getByRole("button", { name: "Try again ↻", exact: true }).click();
    await expect(page.getByText("Your stats took too long to load. Your saved scores are still safe. Please retry.")).toHaveCount(0);
    await expect(page.locator(".md-stats-metric dd").first()).toHaveText("0");
    expect(reads).toBe(2);
  } finally { held.release(); }
});

test("an account verification error ends stats loading without losing the verified profile", async ({ page }) => {
  let failed = false;
  await page.route("**/api/account/session", route => failed
    ? route.fulfill({ status: 503, json: { error: "Temporary account outage" } })
    : route.fulfill({ json: { user, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
  await page.goto("/encore/stats");
  await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("0");
  failed = true;
  await focusBurst(page);
  await expect(page.locator(".md-stats-error")).toContainText("Your account could not be loaded. Please try again.");
  await expect(page.getByRole("button", { name: /Avery/ })).toBeVisible();
  await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
  failed = false;
  await page.getByRole("button", { name: "Try again ↻", exact: true }).click();
  await expect(page.locator(".md-stats-error")).toHaveCount(0);
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("0");
});

test("a failed account-change refresh removes the invalidated profile and retry loads only the new account", async ({ page }) => {
  let current = user;
  let failed = false;
  await page.route("**/api/account/session", route => failed
    ? route.fulfill({ status: 503, json: { error: "Temporary account outage" } })
    : route.fulfill({ json: { user: current, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: {
    user: current,
    games: { ...games, encore: { ...empty, played: current.id === user.id ? 7 : 2, completed: current.id === user.id ? 7 : 2 } },
  } }));
  await page.goto("/encore/stats");
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("7");
  await page.getByRole("button", { name: /Avery/ }).click();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
  failed = true;
  current = staleUser;
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "musical-daily:account-change", newValue: "test-account-change",
  })));
  await expect(page.locator(".md-stats-error")).toContainText("Your account could not be loaded. Please try again.");
  await expect(page.getByRole("button", { name: /Avery/ })).toHaveCount(0);
  await expect(page.getByText(user.email, { exact: true })).toHaveCount(0);
  await expect(page.locator(".md-avatar-picker")).toHaveCount(0);
  await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("—");
  failed = false;
  await page.getByRole("button", { name: "Try again ↻", exact: true }).click();
  await expect(page.getByRole("button", { name: /Stale/ })).toBeVisible();
  await expect(page.locator(".md-stats-metric dd").first()).toHaveText("2");
  await expect(page.locator(".md-stats-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Avery/ })).toHaveCount(0);
});
