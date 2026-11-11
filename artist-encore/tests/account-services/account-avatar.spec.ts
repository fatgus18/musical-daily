import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const origin = "https://localhost:3100";
const changeKey = "musical-daily:account-change";
const surfaces = ["/stats", "/blackjack/stats", "/tempo-trap/stats", "/encore/stats", "/double-or-drop/stats", "/rhythm-lab"];
const choices = ["Headphones", "Microphone", "Guitar", "Piano", "Drums", "Trumpet", "Saxophone", "Violin", "Music note", "Music score"];
const defaultName = "Default — Google photo";
const picture = "https://avatar.example.test/google.png";
const user = { id: "avatar-browser-a", name: "Avery Listener", email: "avery@example.test", picture, avatar: null as string | null };
const otherUser = { ...user, id: "avatar-browser-b", name: "Blair Listener", email: "blair@example.test", avatar: null };
const empty = { played: 0, completed: 0, incomplete: 0, wins: 0, totalScore: 0, bestScore: 0, averageScore: 0, averagePercent: 0, totalCorrect: 0, totalRounds: 0, totalBanked: 0, bestBanked: 0, currentStreak: 0, bestStreak: 0, lastPlayed: null, recent: [] };
const games = { blackjack: empty, tempo: empty, encore: empty, "double-drop": empty };

test.beforeEach(({ page }) => page.setDefaultTimeout(15000));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function seed(action: string, userId?: string) {
  const fixture = JSON.parse(readFileSync(resolve("../test-results-accounts/fixture.json"), "utf8"));
  const directory = relative(tmpdir(), fixture.temporary);
  if (fixture.localFixture !== true || fixture.origin !== origin || isAbsolute(directory) || directory.startsWith("..") || !directory.startsWith("musical-daily-services-smoke-")) throw new Error("Avatar tests require the disposable local HTTPS account fixture.");
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/account-services/seed-local.mjs"), action, ...(userId ? [userId] : [])], { encoding: "utf8", windowsHide: true }));
}

function hubCookie(token: string) {
  return { name: "md_hub_session", value: token, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
}

async function openPicker(page: Page, touch = false) {
  const trigger = page.locator(".md-account-trigger");
  await expect(trigger).toBeEnabled();
  if (await trigger.getAttribute("aria-expanded") !== "true") {
    if (touch) await trigger.tap({ timeout: 15000 });
    else await trigger.click({ timeout: 15000 });
  }
  await expect(page.locator(".md-avatar-picker")).toBeVisible();
}

function option(page: Page, name: string) {
  return page.locator(".md-avatar-picker").getByRole("button", { name, exact: true });
}

async function expectAvatar(page: Page, avatar: string) {
  await expect(page.locator(".md-account-trigger .md-account-avatar")).toHaveAttribute("data-avatar", avatar);
}

async function mockPhoto(page: Page) {
  await page.route(picture, route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLXkAAAAASUVORK5CYII=", "base64") }));
}

test("a chosen avatar persists centrally across every app, devices and tabs, with account isolation and Default reset", async ({ browser }) => {
  const identity = seed("identity");
  const secondSession = seed("session", identity.user.id);
  const stranger = seed("identity");
  const first = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const second = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const isolated = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  for (const context of [first, second, isolated]) context.setDefaultTimeout(15000);
  try {
    await first.addCookies([hubCookie(identity.session.token)]);
    await second.addCookies([hubCookie(secondSession.token)]);
    await isolated.addCookies([hubCookie(stranger.session.token)]);
    const page = await first.newPage();
    const sibling = await first.newPage();
    await page.goto("/stats");
    await sibling.goto("/encore/stats");
    await expectAvatar(sibling, "default");
    await openPicker(page);
    await expect(page.locator(".md-avatar-picker button")).toHaveCount(11);
    for (const label of choices) await expect(option(page, label)).toHaveCount(1);
    await expect(option(page, defaultName)).toHaveAttribute("aria-pressed", "true");
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/account/avatar" && response.request().method() === "POST");
    await option(page, "Guitar").click();
    expect((await saved).ok()).toBe(true);
    await expectAvatar(page, "guitar");
    // A second open tab updates immediately from the storage notification, not
    // from a minute-long refresh timer or a navigation that hides stale state.
    await expect(sibling.locator(".md-account-trigger .md-account-avatar")).toHaveAttribute("data-avatar", "guitar", { timeout: 5000 });
    await expect(option(page, "Guitar")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.md-avatar-picker [aria-pressed="true"]')).toHaveCount(1);
    for (const path of surfaces) {
      await page.goto(path);
      await expectAvatar(page, "guitar");
    }
    await page.reload();
    await expectAvatar(page, "guitar");
    const remoteDevice = await second.newPage();
    await remoteDevice.goto("/double-or-drop/stats");
    await expectAvatar(remoteDevice, "guitar");
    const strangerPage = await isolated.newPage();
    await strangerPage.goto("/stats");
    await expectAvatar(strangerPage, "default");
    expect((await (await isolated.request.get("/api/account/session")).json()).user.avatar).toBeNull();
    await openPicker(page);
    await option(page, defaultName).click();
    await expectAvatar(page, "default");
    const current = (await (await first.request.get("/api/account/session")).json()).user;
    expect(current.id).toBe(identity.user.id);
    expect(current.avatar).toBeNull();
    expect(current.picture).toBe(identity.user.picture);
    await remoteDevice.reload();
    await expectAvatar(remoteDevice, "default");
  } finally { await Promise.all([first.close(), second.close(), isolated.close()]); }
});

test("a failed avatar save preserves the Google photo and can be retried, then reset to Default", async ({ page }) => {
  let current = { ...user };
  let fail = true;
  let saves = 0;
  await mockPhoto(page);
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: current, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user: current, games } }));
  await page.route("**/api/account/avatar", async route => {
    expect(new URL(route.request().url()).pathname).toBe("/api/account/avatar");
    expect(route.request().method()).toBe("POST");
    saves++;
    if (fail) { await route.fulfill({ status: 503, json: { error: "Temporary outage" } }); return; }
    current = { ...current, avatar: route.request().postDataJSON().avatar };
    await route.fulfill({ json: { user: current } });
  });
  await page.goto("/stats");
  await openPicker(page);
  await option(page, "Piano").click();
  await expect(page.locator(".md-avatar-error")).toBeVisible();
  await expectAvatar(page, "default");
  await expect(option(page, defaultName)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-account-trigger .md-account-avatar img")).toHaveAttribute("src", picture);
  fail = false;
  await option(page, "Piano").focus();
  await page.keyboard.press("Enter");
  await expectAvatar(page, "piano");
  await expect(page.locator(".md-avatar-error")).toHaveCount(0);
  await expect(option(page, "Piano")).toHaveAttribute("aria-pressed", "true");
  await option(page, defaultName).click();
  await expectAvatar(page, "default");
  await expect(page.locator(".md-account-trigger .md-account-avatar img")).toHaveAttribute("src", picture);
  expect(saves).toBe(3);
  expect(current.picture).toBe(picture);
});

test("a late avatar response cannot restore an account after sign out", async ({ page }) => {
  const held = gate();
  let signedIn = true;
  let started = false;
  await mockPhoto(page);
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: signedIn ? user : null, configured: true } }));
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user: signedIn ? user : null, games } }));
  await page.route("**/api/account/avatar", async route => {
    started = true;
    await held.promise;
    await route.fulfill({ json: { user: { ...user, avatar: "drums" } } }).catch(() => {});
  });
  await page.route("**/api/account/logout", async route => { signedIn = false; await route.fulfill({ json: { ok: true } }); });
  await page.goto("/stats");
  await openPicker(page);
  await option(page, "Drums").click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator(".md-account-trigger")).toContainText("Sign in");
  held.release();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".md-account-trigger")).toContainText("Sign in");
  await expect(page.locator(".md-account-avatar")).toHaveCount(0);
  await expect(page.getByText("Hey Avery.", { exact: false })).toHaveCount(0);
});

test("switching accounts while an avatar save is pending ignores the old user's response", async ({ page }) => {
  const held = gate();
  const heldSession = gate();
  let current = { ...user };
  let started = false;
  let changingAccount = false;
  let refreshStarted = false;
  let saves = 0;
  await mockPhoto(page);
  await page.route("**/api/account/session", async route => {
    if (changingAccount) { refreshStarted = true; await heldSession.promise; }
    await route.fulfill({ json: { user: current, configured: true } });
  });
  await page.route("**/api/account/stats", route => route.fulfill({ json: { user: current, games } }));
  await page.route("**/api/account/avatar", async route => {
    started = true;
    saves++;
    await held.promise;
    await route.fulfill({ json: { user: { ...user, avatar: "guitar" } } }).catch(() => {});
  });
  await page.goto("/stats");
  await openPicker(page);
  await option(page, "Guitar").click();
  await expect.poll(() => started).toBe(true);
  current = { ...otherUser };
  changingAccount = true;
  // This is the same browser event a second tab emits after switching its
  // central cookie. Only transport is mocked; the actual provider handles it.
  await page.evaluate(key => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "another-account" })), changeKey);
  await expect.poll(() => refreshStarted).toBe(true);
  const previousAccountOption = option(page, "Violin");
  if (await previousAccountOption.count() && await previousAccountOption.isEnabled()) await previousAccountOption.click();
  // The old identity may remain visible during refresh, but must not be allowed
  // to mutate whichever account the changed central cookie now represents.
  await page.waitForTimeout(100);
  expect(saves).toBe(1);
  heldSession.release();
  await expect(page.locator(".md-account-trigger")).toContainText("Blair");
  held.release();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".md-account-trigger")).toContainText("Blair");
  await expectAvatar(page, "default");
  await expect(page.getByText("Hey Avery.", { exact: false })).toHaveCount(0);
  await openPicker(page);
  await expect(option(page, defaultName)).toHaveAttribute("aria-pressed", "true");
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
  test(`the avatar picker stays usable across all apps at ${viewport.width}×${viewport.height}`, async ({ browser }, testInfo) => {
    const touch = viewport.width < 1000;
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport, hasTouch: touch });
    context.setDefaultTimeout(15000);
    try {
      const page = await context.newPage();
      let current = { ...user };
      await mockPhoto(page);
      await page.route("**/api/account/session", route => route.fulfill({ json: { user: current, configured: true } }));
      await page.route("**/api/account/stats", route => route.fulfill({ json: { user: current, games } }));
      await page.route("**/api/account/avatar", async route => {
        current = { ...current, avatar: route.request().postDataJSON().avatar };
        await route.fulfill({ json: { user: current } });
      });
      for (const path of surfaces) {
        await page.goto(path);
        await openPicker(page, touch);
        const panel = page.locator(".md-account-panel");
        const bounds = await panel.boundingBox();
        expect(bounds, `${path}: menu bounds`).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
        for (const label of [defaultName, ...choices]) {
          const button = option(page, label);
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport();
          const box = await button.boundingBox();
          expect(box!.width, `${path}: ${label} target width`).toBeGreaterThanOrEqual(44);
          expect(box!.height, `${path}: ${label} target height`).toBeGreaterThanOrEqual(44);
        }
        for (const action of [panel.getByRole("link", { name: "My stats", exact: true }), panel.getByRole("button", { name: "Sign out", exact: true })]) {
          await action.scrollIntoViewIfNeeded();
          await expect(action).toBeInViewport();
          const box = await action.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
          expect(await action.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
          }), `${path}: account action must remain tappable`).toBe(true);
        }
        if (touch) await option(page, "Music note").tap(); else await option(page, "Music note").click();
        await expectAvatar(page, "music-note");
        if (path === "/stats" && [320, 1440].includes(viewport.width)) {
          // Capture the settled 140 ms color transition, not its intermediate frame.
          await page.waitForTimeout(180);
          await page.screenshot({ path: testInfo.outputPath(`avatar-${viewport.width}-custom.png`) });
        }
        if (touch) await option(page, defaultName).tap(); else await option(page, defaultName).click();
        await expectAvatar(page, "default");
        if (path === "/stats" && [320, 1440].includes(viewport.width)) {
          await page.waitForTimeout(180);
          await page.screenshot({ path: testInfo.outputPath(`avatar-${viewport.width}-default.png`) });
        }
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
      }
      const contrast = page.getByRole("button", { name: "High contrast", exact: true });
      if (touch) await contrast.tap(); else await contrast.click();
      await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
      await openPicker(page, touch);
      await expect(option(page, defaultName)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".md-avatar-picker button")).toHaveCount(11);
    } finally { await context.close(); }
  });
}
