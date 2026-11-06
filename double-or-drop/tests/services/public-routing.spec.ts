import { randomUUID } from "node:crypto";
import { test, expect, type APIResponse, type Page, type Response } from "@playwright/test";

const games = [
  { path: "/blackjack", title: /Blackjack/, stats: "blackjack", api: "/api/daily" },
  { path: "/tempo-trap", title: /Tempo Trap/, stats: "tempo", api: "/api/daily" },
  { path: "/encore", title: /Encore/, stats: "encore", api: "/api/game" },
  { path: "/double-or-drop", title: /Double or Drop/, stats: "double-drop", api: "/api/game" },
] as const;

async function json(response: APIResponse | Response) {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBe(true);
  expect(response.headers()["content-type"], response.url()).toContain("application/json");
  return response.json();
}

function observeGuest(page: Page) {
  const accountRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", request => {
    if (/\/api\/(?:account|auth)(?:\/|$)/.test(new URL(request.url()).pathname)) accountRequests.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  return { accountRequests, errors };
}

async function expectGuest(page: Page, probe: ReturnType<typeof observeGuest>) {
  await expect(page.getByRole("button", { name: /sign in|continue with google/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /sign in|continue with google/i })).toHaveCount(0);
  // These are the real events that ordinarily refresh the account session.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(150);
  expect(probe.accountRequests, "Guest mode must not poll account APIs").toEqual([]);
  expect(probe.errors, "No uncaught browser errors").toEqual([]);
}

async function expectServiceAssets(page: Page, prefix: string) {
  const assets = await page.locator('script[src], link[rel="stylesheet"][href]').evaluateAll(elements => elements.map(element => {
    const raw = element.getAttribute("src") || element.getAttribute("href")!;
    return { tag: element.tagName, url: new URL(raw, location.href).href };
  }));
  const localNext = assets.filter(asset => new URL(asset.url).origin === new URL(page.url()).origin && new URL(asset.url).pathname.includes("/_next/"));
  expect(localNext.filter(asset => asset.tag === "SCRIPT").length).toBeGreaterThan(0);
  expect(localNext.filter(asset => asset.tag === "LINK").length).toBeGreaterThan(0);
  for (const asset of localNext) {
    expect(new URL(asset.url).pathname, `${prefix || "hub"} must own its asset URLs`).toMatch(new RegExp(`^${prefix}/_next/`));
  }
  // Fetch one real script and stylesheet as well: a correctly spelled URL must
  // still reach that service rather than falling through to hub HTML.
  for (const tag of ["SCRIPT", "LINK"]) {
    const asset = localNext.find(item => item.tag === tag)!;
    const response = await page.request.get(asset.url);
    expect(response.ok(), asset.url).toBe(true);
    expect(response.headers()["content-type"], asset.url).toMatch(tag === "SCRIPT" ? /javascript/ : /text\/css/);
  }
}

test("the hub exposes four public game paths and Rhythm Lab keeps its root worklet", async ({ page }) => {
  const probe = observeGuest(page);
  await page.goto("/");
  await expect(page.locator(".game-card")).toHaveCount(4);
  const hrefs = await page.locator("a.game-card").evaluateAll(links => links.map(link => link.getAttribute("href")));
  expect(hrefs.sort()).toEqual(games.map(game => game.path).sort());
  await expectServiceAssets(page, "");
  await expectGuest(page, probe);

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Rhythm Lab", exact: true }).click();
  await expect(page).toHaveURL(/\/rhythm-lab$/);
  await expect(page.getByRole("button", { name: "C4 key", exact: true })).toBeEnabled();
  // AudioWorklet's fetch is not emitted as a Page response in every Chrome
  // build. Check its routed asset directly, then exercise the real recorder.
  const worklet = await page.request.get("/audio/studio-recorder.js");
  expect(worklet.ok()).toBe(true);
  expect(worklet.headers()["content-type"]).toMatch(/javascript/);
  expect(await worklet.text()).toContain("registerProcessor");
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled();
  await page.locator(".studio-intro h1").click();
  await page.keyboard.down("a");
  await page.waitForTimeout(200);
  await page.keyboard.up("a");
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download WAV", exact: true })).toHaveAttribute("href", /^blob:/);
  await page.getByRole("button", { name: /New recording/ }).click();
  await expectGuest(page, probe);
});

for (const game of games) {
  test(`${game.path} owns its page, assets, API and local stats while its logo returns to the hub`, async ({ page }) => {
    const probe = observeGuest(page);
    const initial = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `${game.path}${game.api}`);
    await page.goto(game.path);
    await expect(page).toHaveTitle(game.title);
    const state = await json(await initial);
    if (game.stats === "blackjack") {
      expect(state.tracks.length).toBeGreaterThan(0);
      expect(state.targetStreams).toBeGreaterThan(0);
    } else if (game.stats === "tempo") {
      expect(state.tracks).toHaveLength(5);
      expect(state.token).toEqual(expect.any(String));
      expect(state.tracks[0]).not.toHaveProperty("bpm");
    } else if (game.stats === "encore") {
      expect(state).toHaveProperty("game");
      expect(typeof state.audioEnabled).toBe("boolean");
    } else {
      expect(state).toHaveProperty("game");
      expect(state).toHaveProperty("catalog");
    }
    await expectServiceAssets(page, game.path);
    const brand = page.getByRole("link", { name: "Musical Daily home", exact: true });
    await expect(brand).toHaveAttribute("href", "/");
    const logo = brand.locator("img");
    await expect(logo).toHaveAttribute("src", `${game.path}/brand/musical-daily.svg`);
    await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await expectGuest(page, probe);

    const statsLink = page.locator(`a[href="${game.path}/stats"]`).first();
    await expect(statsLink).toHaveAttribute("href", `${game.path}/stats`);
    await statsLink.click();
    await expect(page).toHaveURL(new RegExp(`${game.path}/stats$`));
    await expect(page.locator(".md-stats-game-card")).toHaveCount(1);
    await expect(page.locator(`.md-stats-game-card.md-stats-${game.stats}`)).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to game/ })).toHaveAttribute("href", `${game.path}`);
    await expect(page.getByRole("link", { name: /All game stats/ })).toHaveAttribute("href", "/stats");
    await expectGuest(page, probe);

    await page.getByRole("link", { name: /All game stats/ }).click();
    await expect(page).toHaveURL(/\/stats$/);
    expect(new URL(page.url()).pathname).toBe("/stats");
    await expect(page.locator(".md-stats-game-card")).toHaveCount(4);
    await page.getByRole("link", { name: "Musical Daily home", exact: true }).click();
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator(".game-card")).toHaveCount(4);

    // Navigate from the actual game logo as well as the stats page's logo.
    await page.goto(game.path);
    await page.getByRole("link", { name: "Musical Daily home", exact: true }).click();
    await expect(page.locator(".game-card")).toHaveCount(4);
    expect(new URL(page.url()).pathname).toBe("/");
    await expectGuest(page, probe);
  });
}

test("Tempo guesses and Double or Drop moves use their real prefixed APIs on the public origin", async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const mix = await json(await request.get("/tempo-trap/api/daily?mode=practice"));
  expect(mix.mode).toBe("practice");
  expect(mix.tracks).toHaveLength(5);
  const answer = await json(await request.post("/tempo-trap/api/guess", {
    headers: { origin }, data: { token: mix.token, guess: 100 },
  }));
  expect(answer.result.round).toBe(0);
  expect(answer.result.trackId).toBe(mix.tracks[0].id);
  expect(answer.result.guess).toBe(100);
  expect(answer.results).toHaveLength(1);
  expect(answer.token).not.toBe(mix.token);

  const created = await json(await request.post("/double-or-drop/api/game", {
    headers: { origin }, data: { action: "create", requestId: randomUUID(), theme: "all", metricFilter: "duration" },
  }));
  expect(created.game.phase).toBe("guess");
  expect(created.game.pair.metric).toBe("duration");
  const guessed = await json(await request.post("/double-or-drop/api/game", {
    headers: { origin }, data: { action: "guess", gameId: created.game.id, round: created.game.round, revision: created.game.revision, choice: "left" },
  }));
  expect(guessed.game.answered).toBe(1);
  expect(guessed.game.id).toBe(created.game.id);
  const discarded = await json(await request.post("/double-or-drop/api/game", {
    headers: { origin }, data: { action: "discard", gameId: guessed.game.id, round: guessed.game.round, revision: guessed.game.revision },
  }));
  expect(discarded.game.phase).toBe("complete");
  expect(discarded.game.completionStatus).toBe("incomplete");
});
