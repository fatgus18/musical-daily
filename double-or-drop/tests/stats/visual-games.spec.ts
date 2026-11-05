import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { PublicGame as EncoreGame } from "../../../artist-encore/src/lib/types";

// UI regression coverage, deliberately separate from scoring/audio integration.
// Each game gets a new, anonymous browser context. Date is fixed so resizing
// and screenshots cannot consume a round or modify the developer's saved games.
const viewports = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
];

async function isolatedPage(browser: Browser) {
  const context = await browser.newContext({ viewport: viewports[0], reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: null, configured: true } }));
  await page.addInitScript(() => {
    // Avoid autoplaying synthetic action music during purely visual assertions.
    localStorage.setItem("musical-daily:sound:v1", JSON.stringify({ enabled: false, effects: 0.45, music: 0.16 }));
  });
  // Leave scheduler timers/rAF running so React can hydrate. Countdown deadlines
  // still stay fixed while we inspect layouts without spending a real round.
  await page.clock.setFixedTime(new Date());
  return { context, page };
}

async function captureStates(page: Page, info: TestInfo, name: string, answerSelector: string, answerCount: number) {
  // Next's development-only "cache disabled" toast overlaps bottom controls on
  // narrow viewports when route interception is enabled in a test context.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  page.setDefaultTimeout(15000);
  const answers = page.locator(answerSelector);
  await expect(answers).toHaveCount(answerCount);
  const contrast = page.getByRole("button", { name: "High contrast", exact: true });
  await expect(contrast).toBeVisible();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const high of [false, true]) {
      if ((await contrast.getAttribute("aria-pressed")) !== String(high)) await contrast.click();
      await expect(page.locator("html")).toHaveAttribute("data-contrast", high ? "high" : "standard");
      await expect(contrast).toHaveAttribute("aria-pressed", String(high));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: overflow at ${viewport.width}px, high=${high}`).toBe(true);
      for (const answer of await answers.all()) {
        await expect(answer).toBeVisible();
        await expect(answer).toBeEnabled();
        const box = await answer.boundingBox();
        expect(box, `${name}: answer has no rendered box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box!.height).toBeGreaterThanOrEqual(40);
      }
      // Exercise browser hit testing without committing a real game answer.
      await answers.first().click({ trial: true });
      await answers.first().focus();
      await expect(answers.first()).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(answers.first()).toBeFocused();
      const outline = await answers.first().evaluate(el => {
        const style = getComputedStyle(el);
        return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      // Keyboard focus must stay visible, including over high-contrast surfaces.
      expect(outline.style !== "none" || outline.width > 0 || await answers.first().evaluate(el => getComputedStyle(el).boxShadow !== "none")).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`${name}-${viewport.width}-${high ? "high" : "standard"}.png`), fullPage: true, animations: "disabled" });
    }
  }
  const movingDecorations = await page.locator(".tempo-atmosphere *, .encore-atmosphere *, .bj-stage *, .arcade-atmosphere *").evaluateAll(elements => elements.filter(el => getComputedStyle(el).animationName !== "none").length);
  expect(movingDecorations, `${name}: decorative motion must stop under reduced-motion`).toBe(0);
}

test("Blackjack and Tempo gameplay stay usable at desktop and narrow phone sizes in both contrast modes", async ({ browser }, info) => {
  test.setTimeout(180000);
  {
    const { context, page } = await isolatedPage(browser);
    try {
      await page.goto("http://localhost:3000/");
      await expect(page.locator(".bj-track-card")).toHaveCount(9, { timeout: 30000 });
      await captureStates(page, info, "blackjack", ".bj-track-card", 9);
    } finally { await context.close(); }
  }
  {
    const { context, page } = await isolatedPage(browser);
    try {
      await page.goto("http://localhost:3002/");
      await expect(page.getByRole("button", { name: "Let’s hear it", exact: true })).toBeVisible({ timeout: 30000 });
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find(key => key.startsWith("tempo:daily:"));
        if (!key) throw new Error("The real daily mix was not saved");
        const saved = JSON.parse(localStorage.getItem(key)!);
        saved.progress.phase = "guessing";
        saved.progress.deadline = Date.now() + 15000;
        saved.progress.guess = "120";
        localStorage.setItem(key, JSON.stringify(saved));
      });
      await page.reload();
      await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveValue("120");
      await expect(page.getByRole("button", { name: "Lock in my guess", exact: true })).toBeEnabled();
      await captureStates(page, info, "tempo", ".guess-content .primary-button", 1);
      await page.getByLabel("YOUR GUESS", { exact: true }).fill("128");
      await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveValue("128");
      await expect(page.getByRole("timer")).toContainText("15 SECONDS LEFT");
    } finally { await context.close(); }
  }
});

test("Encore choices and a real Double or Drop pair remain readable, focusable and unobscured", async ({ browser }, info) => {
  test.setTimeout(180000);
  {
    const { context, page } = await isolatedPage(browser);
    try {
      // A deterministic post-listening fixture tests the answer screen without
      // waiting on provider playback. Portrait fallback is intentionally covered.
      const game: EncoreGame = {
        id: "visual-encore", artist: { id: "apple:342260741", name: "Hozier", image: "", imageSourceUrl: "https://music.apple.com/us/artist/hozier/342260741", url: "https://music.apple.com/us/artist/hozier/342260741" },
        ranking: { kind: "streams", label: "Verified play counts", sourceUrl: "https://music.apple.com/us/artist/hozier/342260741", asOf: "2026-11-03" },
        round: 0, phase: "guessing", results: [], correct: 0, tier: "hit", listenAt: Date.now() - 10000,
        guessDeadline: Date.now() + 15000, serverNow: Date.now(), clipOffset: 7, clipSeconds: 10,
        mode: "ranked", mixCounts: { hit: 6, favorite: 3, deep: 1 }, poolSize: 89,
        choices: [{ id: "one", label: "Take Me to Church" }, { id: "two", label: "Someone New" }, { id: "three", label: "Work Song" }, { id: "four", label: "Cherry Wine (Live)" }],
      };
      await page.route("**/api/game", route => route.fulfill({ json: { game, audioEnabled: true } }));
      await page.goto("http://localhost:3004/");
      await expect(page.getByRole("group", { name: "WHICH SONG IS IT?" })).toBeVisible({ timeout: 30000 });
      await captureStates(page, info, "encore", ".song-choice", 4);
      await expect(page.getByRole("timer")).toBeVisible();
      await expect(page.locator(".guess-clock")).toHaveCSS("animation-name", "none");
      await page.getByText("About this mix", { exact: true }).click();
      await expect(page.getByRole("link", { name: "Photo: Apple Music" })).toBeVisible();
    } finally { await context.close(); }
  }
  {
    const { context, page } = await isolatedPage(browser);
    try {
      // Real server-created pair, then an immutable response for screenshot work.
      // The unique guest context owns this run; no user session is accessed.
      const created = await context.request.post("http://localhost:3005/api/game", {
        data: { action: "create", requestId: crypto.randomUUID(), theme: "all", metricFilter: "duration" },
      });
      expect(created.ok()).toBe(true);
      const payload = await created.json();
      expect(payload.game?.phase).toBe("guess");
      const live = await context.request.get("http://localhost:3005/api/game");
      expect(live.ok()).toBe(true);
      const snapshot = await live.json();
      snapshot.game = payload.game;
      // Keep server/guess clocks aligned with the test's frozen page clock.
      snapshot.game.serverNow = await page.evaluate(() => Date.now());
      snapshot.game.guessDeadline = snapshot.game.serverNow + 20000;
      await page.route("**/api/game", route => route.fulfill({ json: snapshot }));
      await page.goto("http://localhost:3005/");
      await expect(page.locator(".song-pick")).toHaveCount(2, { timeout: 30000 });
      await captureStates(page, info, "double-or-drop", ".song-pick", 2);
      await expect(page.locator(".comparison")).toHaveClass(/is-guessing/);
    } finally { await context.close(); }
  }
});
