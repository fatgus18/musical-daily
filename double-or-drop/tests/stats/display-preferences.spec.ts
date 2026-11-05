import { test, expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

const HUB = "http://localhost:3001";
const COOKIE = "md_contrast";
const STORAGE = "musical-daily:contrast:v1";
const apps = [
  { port: 3001, name: "hub" },
  { port: 3000, name: "blackjack" },
  { port: 3002, name: "tempo" },
  { port: 3004, name: "encore" },
  { port: 3005, name: "double-drop" },
] as const;
const toggle = (page: Page) => page.getByRole("button", { name: "High contrast", exact: true });

// Only the preference and presentation are under test. All bootstrap APIs are
// local fixtures: these checks never start a run or ask a music provider for data.
async function isolatedLobby(context: BrowserContext) {
  const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#24202e"/><circle cx="50" cy="50" r="32" fill="#b9a3df"/><circle cx="50" cy="50" r="7" fill="#24202e"/></svg>')}`;
  const recordings = [
    ["Blinding Lights", "The Weeknd"], ["Take Me to Church", "Hozier"],
    ["Dreams", "Fleetwood Mac"], ["Levitating", "Dua Lipa"],
    ["Yellow", "Coldplay"], ["Bad Romance", "Lady Gaga"],
    ["As It Was", "Harry Styles"], ["Halo", "Beyoncé"], ["Somebody Else", "The 1975"],
  ];
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (url.hostname !== "localhost") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") return route.fulfill({ status: 405, json: { error: "Display checks do not submit game actions." } });
    if (url.pathname === "/api/account/session") return route.fulfill({ json: { user: null, configured: true } });
    if (url.pathname === "/api/game") return route.fulfill({ json: {
      game: null, audioEnabled: true, statsSynced: true,
      catalog: { version: "display-fixture", createdAt: "2026-11-03", tracks: 100, artists: 10, metrics: { streams: 100, duration: 100 }, themes: [{ id: "all", label: "All songs", trackCount: 100, metrics: ["streams", "duration"] }] },
    } });
    if (url.pathname === "/api/daily") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (url.port === "3000") return route.fulfill({ json: {
        rulesVersion: "v3-exact", catalogVersion: "display-fixture", date, seedKey: "display-fixture", puzzleNumber: 34, targetStreams: 4500000000,
        tracks: recordings.map(([title, artist], index) => ({ id: `display-${index}`, title, artist, releaseYear: 2020, albumArtUrl: artwork, previewStatus: "available" })),
      } });
      return route.fulfill({ json: { date, number: 34, mode: "daily", seed: "display-fixture", version: "display-fixture", token: "display-fixture", tracks: recordings.slice(0, 5).map(([title, artist], index) => ({ id: `display-${index}`, title, artist, album: "Display fixture", year: 2020, artworkUrl: artwork, previewUrl: "/display-test-audio.mp3", spotifyUrl: "", appleMusicUrl: "", clipStartSeconds: 0, clipSeconds: 15 })) } });
    }
    return route.fulfill({ json: { artists: [], themes: [] } });
  });
}

async function expectContrast(page: Page, high: boolean) {
  await expect(page.locator("html")).toHaveAttribute("data-contrast", high ? "high" : "standard");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", String(high));
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
}

test.beforeEach(async ({ context, page }) => {
  await isolatedLobby(context);
  await page.emulateMedia({ contrast: "no-preference" });
});

test("keyboard contrast preference persists and follows all five apps through the host cookie", async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  await page.goto(HUB);
  await expect(page.locator(".game-card")).toHaveCount(4);
  await expectContrast(page, false);
  await screenshot(page, testInfo, "hub-standard-desktop");
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toBeFocused();
  await expectContrast(page, true);
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE)).toBe("high");
  const preference = (await context.cookies(HUB)).find(cookie => cookie.name === COOKIE);
  expect(preference).toMatchObject({ value: "high", domain: "localhost", path: "/", sameSite: "Lax" });
  await page.reload();
  await expectContrast(page, true);
  await screenshot(page, testInfo, "hub-high-desktop");

  // An actual game link and subsequent direct game URLs all retain the preference.
  await page.locator(".double-drop-card").click();
  await expect(page).toHaveURL(/localhost:3005\/?$/);
  await expectContrast(page, true);
  for (const app of apps.filter(app => app.port !== 3001)) {
    await page.goto(`http://localhost:${app.port}/`);
    await expectContrast(page, true);
    // localStorage is per-port; this is genuinely supplied by the host cookie.
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE)).toBeNull();
    await expect(page.locator("main")).toBeVisible();
    if (app.port === 3000) await expect(page.locator(".bj-track-card")).toHaveCount(9);
    if (app.port === 3005) await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
    await screenshot(page, testInfo, `${app.name}-high-desktop`);
  }
  await toggle(page).focus();
  await page.keyboard.press("Space");
  await expectContrast(page, false);
  await page.goto(HUB);
  await expectContrast(page, false);
  // The newer host cookie beats this origin's previous high setting.
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE)).toBe("high");
});

test("system contrast is the default until an explicit standard preference overrides it", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await page.goto(HUB);
  await expectContrast(page, true);
  await page.emulateMedia({ contrast: "no-preference" });
  await expectContrast(page, false);
  await page.emulateMedia({ contrast: "more" });
  await expectContrast(page, true);
  await toggle(page).click();
  await expectContrast(page, false);
  await page.reload();
  await expectContrast(page, false);
  await page.goto("http://localhost:3004/");
  await expectContrast(page, false);
  expect(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches)).toBe(true);
});

test("contrast still toggles when both local storage and cookies are blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Blocked for this display check", "SecurityError"); } });
    Object.defineProperty(document, "cookie", { configurable: true, get() { throw new DOMException("Blocked for this display check", "SecurityError"); }, set() { throw new DOMException("Blocked for this display check", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(HUB);
  await expectContrast(page, false);
  await toggle(page).click();
  await expectContrast(page, true);
  await toggle(page).click();
  await expectContrast(page, false);
  expect(errors).toEqual([]);
});

test("all display and sound controls fit at 320px and reduced motion stops decorative animation", async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const app of apps) {
    await page.goto(`http://localhost:${app.port}/`);
    await expect(toggle(page)).toBeVisible();
    await expect(page.locator("main")).toBeVisible();
    if (app.port === 3000) await expect(page.locator(".bj-track-card")).toHaveCount(9);
    if (app.port === 3005) await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled();
    const controls = page.locator(".md-sound-bar > button");
    await expect(controls).toHaveCount(3);
    const boxes = await controls.evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    }));
    for (const box of boxes) {
      expect(box.left, `${app.name} control left edge`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${app.name} control right edge`).toBeLessThanOrEqual(320);
      expect(box.bottom, `${app.name} control bottom edge`).toBeLessThanOrEqual(740);
      expect(box.width).toBeGreaterThan(20);
    }
    for (let index = 1; index < boxes.length; index++) expect(boxes[index].left).toBeGreaterThanOrEqual(boxes[index - 1].right - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${app.name} page overflow`).toBe(true);
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && Number(animation.effect?.getComputedTiming().duration) > 50).length)).toBe(0);
    if (app.port === 3001) {
      await screenshot(page, testInfo, "hub-standard-mobile");
      await toggle(page).click();
      await expectContrast(page, true);
      await screenshot(page, testInfo, "hub-high-mobile");
    }
    await page.getByRole("button", { name: "Sound settings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sound settings" })).toBeVisible();
    const panel = await page.locator(".md-sound-popover").boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Sound settings", exact: true })).toBeFocused();
  }
});

test("shared statistics retain high contrast on the hub and every game", async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  await context.addCookies([{ name: COOKIE, value: "high", domain: "localhost", path: "/", sameSite: "Lax" }]);
  for (const app of apps) {
    await page.goto(`http://localhost:${app.port}/stats`);
    await expectContrast(page, true);
    await expect(page.locator(".md-stats-game-card")).toHaveCount(app.port === 3001 ? 4 : 1);
    const colors = await page.locator(".md-stats-game-card").first().evaluate(card => {
      const panel = getComputedStyle(card);
      const label = getComputedStyle(card.querySelector(".md-stats-metric dt")!);
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const a = luminance(label.color), b = luminance(panel.backgroundColor);
      return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), image: panel.backgroundImage, border: panel.borderTopStyle };
    });
    expect(colors.ratio, `${app.name} stats label contrast`).toBeGreaterThanOrEqual(4.5);
    expect(colors.image).toBe("none");
    expect(colors.border).not.toBe("none");
    if (app.port === 3001) await screenshot(page, testInfo, "hub-stats-high");
  }
});
