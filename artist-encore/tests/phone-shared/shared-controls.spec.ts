import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// UI transport fixtures, never real sign-ins or writes to a user's account.
const user = { id: "phone-ui-only", name: "AlexandriaVeryLongFirstName Music Listener", email: "long.mobile.test.account@example.invalid", picture: null };
const recent = [{ eventId: "mobile-ui-result", date: "2026-11-11", mode: "unlimited", status: "incomplete", incompleteReason: "replaced", score: 7, maxScore: 10, correct: 7, rounds: 9, won: false, bankedPoints: 1000000000000, artist: { id: "fixture", name: "Florence + The Machine and the Midnight Orchestra" } }];
const stats = { played: 12, completed: 10, incomplete: 2, wins: 3, totalScore: 15000, bestScore: 100, averageScore: 3200, averagePercent: 79, totalCorrect: 43, totalRounds: 58, totalBanked: 1000000000000, bestBanked: 1000000000000, currentStreak: 2, bestStreak: 5, lastPlayed: "2026-11-11", recent };
const games = Object.fromEntries(["blackjack", "tempo", "encore", "double-drop"].map(id => [id, stats]));
const sizes = [{ width: 320, height: 740 }, { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }];
const gamePaths = ["/", "/blackjack/", "/tempo-trap/", "/encore/", "/double-or-drop/", "/rhythm-lab"];

async function fits(page: Page, selector: string) {
  const issues = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    return box.left < -1 || box.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 2
      ? [{ text: element.textContent?.slice(0, 70), left: box.left, right: box.right, overflow: element.scrollWidth - element.clientWidth }] : [];
  }));
  expect(issues, selector).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("touch account menus and sound controls work across all apps and phone orientations", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/account/session", route => route.fulfill({ json: { configured: true, user } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
  for (const path of gamePaths) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".md-account-trigger.is-signed-in")).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.locator(".md-account-trigger").tap();
      const menu = page.locator(".md-account-panel");
      await expect(menu).toBeVisible();
      await fits(page, ".md-account-panel,.md-account-identity-detail");
      for (const action of [menu.getByRole("link", { name: "My stats" }), menu.getByRole("button", { name: "Sign out" })]) {
        const rect = await action.boundingBox();
        expect(rect!.width).toBeGreaterThanOrEqual(44);
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(rect!.y).toBeGreaterThanOrEqual(0);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(size.height);
        await action.tap({ trial: true });
      }
      // Outside tap is the phone dismissal; Escape also retains laptop support.
      await page.touchscreen.tap(2, 2);
      await expect(menu).toHaveCount(0);
      // The studio intentionally hides game sound effects and has its own
      // live volume/recording controls, covered by the studio suite.
      if (path === "/rhythm-lab") continue;
      await page.getByRole("button", { name: "Sound settings", exact: true }).tap();
      const popup = page.getByRole("region", { name: "Sound settings" });
      await fits(page, ".md-sound-popover");
      const effects = popup.getByRole("slider", { name: "Effects volume" });
      await effects.scrollIntoViewIfNeeded();
      const range = await effects.boundingBox();
      expect(range!.height).toBeGreaterThanOrEqual(44);
      const previous = await effects.inputValue();
      await page.touchscreen.tap(range!.x + range!.width * (Number(previous) > 50 ? .2 : .8), range!.y + range!.height / 2);
      await expect(effects).not.toHaveValue(previous);
      const done = popup.getByRole("button", { name: "Done", exact: true });
      expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await done.tap();
      await expect(popup).toHaveCount(0);
    }
  }
  await page.goto("/");
  await page.getByRole("button", { name: "High contrast", exact: true }).tap();
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  const mute = page.locator(".md-sound-toggle");
  if (await mute.getAttribute("aria-pressed") === "true") await mute.tap();
  await page.goto("/stats");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await expect(page.locator(".md-sound-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
});

test("populated and guest stats stay readable and navigable on phones", async ({ page }) => {
  let signedIn = true;
  await page.route("**/api/account/session", route => route.fulfill({ json: { configured: true, user: signedIn ? user : null } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user, games } }));
  for (const path of ["/stats", "/blackjack/stats", "/tempo-trap/stats", "/encore/stats", "/double-or-drop/stats"]) {
    await page.goto(path);
    await expect(page.locator(".md-stats-value-loading")).toHaveCount(0);
    await expect(page.locator(".md-account-trigger.is-signed-in")).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      await fits(page, ".md-stats-metric,.md-stats-game-title,.md-stats-history li,.md-stats-header");
      const card = page.locator(".md-stats-game-card").first();
      expect(await card.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
      await card.getByRole("link").tap({ trial: true });
    }
  }
  signedIn = false;
  await page.setViewportSize({ width: 320, height: 740 });
  await page.reload();
  const signIn = page.getByRole("link", { name: "Continue with Google", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.tap({ trial: true });
  await expect(signIn).toHaveAttribute("href", "/api/account/login?returnTo=%2Fdouble-or-drop%2Fstats");
  await fits(page, ".md-stats-sign-in,.md-stats-header");
});

test("a real central test session survives phone navigation without game sign-ins", async ({ page, context, baseURL }) => {
  test.skip(baseURL !== "https://localhost:3100", "Private test identity is only created in the disposable local fixture.");
  const { user: identity, session } = JSON.parse(execFileSync(process.execPath, [resolve("tests/account-services/seed-local.mjs"), "identity"], { encoding: "utf8", windowsHide: true }));
  await context.addCookies([{ name: "md_hub_session", value: session.token, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  for (const path of gamePaths) {
    await page.goto(path);
    await expect(page.locator(".md-account-trigger.is-signed-in")).toBeVisible();
    await page.locator(".md-account-trigger").tap();
    await expect(page.locator(".md-account-identity-detail")).toContainText(identity.email);
    await page.keyboard.press("Escape");
  }
  await page.goto("/stats");
  await page.locator(".md-account-trigger").tap();
  await page.getByRole("button", { name: "Sign out", exact: true }).tap();
  await expect(page.getByRole("link", { name: "Continue with Google", exact: true })).toBeVisible();
  await page.goto("/tempo-trap/");
  await expect(page.locator(".md-account-trigger")).toHaveText("Sign in");
});
