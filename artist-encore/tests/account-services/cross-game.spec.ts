import { test, expect, type APIResponse, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import type { PublicGame } from "../../../double-or-drop/src/lib/types";
import type { CatalogTrack } from "../../../double-or-drop/src/lib/catalog-types";

const origin = "https://localhost:3100";
const apps = [
  { name: "blackjack", path: "/blackjack" },
  { name: "tempo", path: "/tempo-trap" },
  { name: "encore", path: "/encore" },
  { name: "double-drop", path: "/double-or-drop" },
] as const;

function fixture() {
  const value = JSON.parse(readFileSync(resolve("../test-results-accounts/fixture.json"), "utf8"));
  if (value.localFixture !== true || value.origin !== origin) throw new Error("Run the isolated local HTTPS auth fixture first.");
  const relativeDirectory = relative(tmpdir(), value.temporary);
  if (isAbsolute(relativeDirectory) || relativeDirectory.startsWith("..") || !relativeDirectory.startsWith("musical-daily-services-smoke-")) throw new Error("Account tests may only use their disposable temporary database.");
  for (const key of ["accounts", "encore", "doubleDrop"]) {
    const path = relative(value.temporary, value[key]);
    if (isAbsolute(path) || path.startsWith("..")) throw new Error("Fixture database escaped its temporary directory.");
  }
  return value as { accounts: string; encore: string; doubleDrop: string };
}

async function json(response: APIResponse) {
  expect(response.ok(), `${response.url()} ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function signIntoGames(context: BrowserContext) {
  // The only seeded cookie is the central session. Actual public login,
  // authorization and one-use PKCE handoff routes issue all four game cookies.
  for (const app of apps) {
    const response = await context.request.get(`${app.path}/api/account/login?returnTo=${encodeURIComponent(`${app.path}/stats`)}`);
    expect(response.ok()).toBe(true);
    expect(new URL(response.url()).pathname).toBe(`${app.path}/stats`);
    expect((await context.cookies()).find(cookie => cookie.name === `md_${app.name}_session`)?.secure).toBe(true);
  }
}

function hubCookie(token: string) {
  return { name: "md_hub_session", value: token, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
}

function seed(action: string, userId?: string) {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/account-services/seed-local.mjs"), action, ...(userId ? [userId] : [])], { encoding: "utf8", windowsHide: true }));
}

test("one account persists four real game results across devices, handoffs and family logout", async ({ browser }) => {
  fixture();
  const { user, session: firstSession } = seed("identity");
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const second = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const stranger = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    await context.addCookies([hubCookie(firstSession.token)]);
    await signIntoGames(context);
    for (const app of [{ name: "hub", path: "" }, ...apps]) {
      const state = await json(await context.request.get(`${app.path}/api/account/session`));
      expect(state.user.id).toBe(user.id);
      expect(state.configured).toBe(true);
    }

    // Complete one Blackjack hand through real server validation.
    let hand = await json(await context.request.get("/blackjack/api/daily"));
    const blackjackDate = hand.date;
    expect(hand.accountState).toBeTruthy();
    await json(await context.request.post("/blackjack/api/reveal", { headers: { origin }, data: { date: blackjackDate, trackId: hand.tracks[0].id, accountRevision: hand.accountRevision } }));
    hand = await json(await context.request.get("/blackjack/api/daily"));
    const finish = { date: blackjackDate, pickedIds: hand.accountState.pickedIds, accountRevision: hand.accountRevision };
    await json(await context.request.post("/blackjack/api/finish", { headers: { origin }, data: finish }));
    await json(await context.request.post("/blackjack/api/finish", { headers: { origin }, data: finish }));

    // Answers come from the same immutable local release as the built service;
    // no answers, account identity or scores are injected into a public endpoint.
    const mix = await json(await context.request.get("/tempo-trap/api/daily"));
    const tempoCatalog = JSON.parse(readFileSync(resolve(`../tempo-trap/data/catalog-releases/${mix.version}.json`), "utf8"));
    const bpm = new Map<string, number>(tempoCatalog.tracks.map((track: { id: string; bpm: number }) => [track.id, track.bpm]));
    let token = mix.token;
    for (const track of mix.tracks) {
      await json(await context.request.post("/tempo-trap/api/round", { headers: { origin }, data: { token } }));
      const result = await json(await context.request.post("/tempo-trap/api/guess", { headers: { origin }, data: { token, guess: Math.round(bpm.get(track.id)!) } }));
      expect(result.result.score).toBe(1000);
      token = result.token;
    }

    // Private local fixture: the engine derives an Encore result, then the
    // ordinary game endpoint drains its durable outbox into the account service.
    const game = seed("encore", user.id);
    const encore = await json(await context.request.get("/encore/api/game"));
    expect(encore.game.correct).toBe(7);
    expect(encore.statsSynced).toBe(true);
    await json(await context.request.get("/encore/api/game"));

    // A correct DoD pick + cashout exercises server-produced banked results.
    const move = async (data: object): Promise<PublicGame> => (await json(await context.request.post("/double-or-drop/api/game", { headers: { origin }, data }))).game;
    let drop = await move({ action: "create", requestId: randomUUID(), metricFilter: "duration" });
    const dropCatalog = JSON.parse(readFileSync(resolve(`../double-or-drop/data/catalog-releases/${drop.catalogVersion}.json`), "utf8"));
    const tracks = new Map<string, CatalogTrack>(dropCatalog.tracks.map((track: CatalogTrack) => [track.id, track]));
    const choice = tracks.get(drop.pair.left.id)!.metrics.duration!.value > tracks.get(drop.pair.right.id)!.metrics.duration!.value ? "left" : "right";
    drop = await move({ action: "guess", gameId: drop.id, round: drop.round, revision: drop.revision, choice });
    drop = await move({ action: "cashout", gameId: drop.id, round: drop.round, revision: drop.revision });
    expect(drop.phase).toBe("complete");
    expect(drop.banked).toBeGreaterThan(0);
    await json(await context.request.get("/double-or-drop/api/game"));

    const stats = await json(await context.request.get("/api/account/stats"));
    for (const app of apps) expect(stats.games[app.name].completed).toBe(1);
    expect(stats.games.tempo.bestScore).toBe(5000);
    expect(stats.games.encore.totalCorrect).toBe(7);
    expect(stats.games["double-drop"].totalBanked).toBe(drop.banked);
    for (const app of apps) {
      expect((await json(await context.request.get(`${app.path}/api/account/stats`))).games).toEqual(stats.games);
    }

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/stats");
    await expect(page.locator(".md-stats-game-card")).toHaveCount(4);
    await expect(page.getByText("QA Fixture Artist", { exact: true })).toBeVisible();
    for (const app of apps) {
      await page.goto(`${app.path}/stats`);
      await expect(page.locator(`.md-stats-${app.name}`)).toBeVisible();
      await expect(page.getByRole("button", { name: /Local QA Listener|Local QA|Local/ }).first()).toBeVisible();
    }
    expect(errors).toEqual([]);

    const secondSession = seed("session", user.id);
    await second.addCookies([hubCookie(secondSession.token)]);
    await signIntoGames(second);
    expect((await json(await second.request.get("/api/account/stats"))).games).toEqual(stats.games);
    expect((await json(await second.request.get("/blackjack/api/daily"))).accountState.gameOver).toBe(true);
    expect((await json(await second.request.get("/tempo-trap/api/daily"))).accountProgress.phase).toBe("complete");
    expect((await json(await second.request.get("/encore/api/game"))).game.id).toBe(game.id);
    expect((await json(await second.request.get("/double-or-drop/api/game"))).game.id).toBe(drop.id);

    expect((await json(await stranger.request.get("/api/account/stats"))).user).toBeNull();
    expect((await json(await stranger.request.get("/encore/api/game"))).game).toBeNull();
    expect((await json(await stranger.request.get("/double-or-drop/api/game"))).game).toBeNull();
    expect((await context.request.post("/api/account/service", { headers: { origin }, data: { app: "tempo", action: "stats" } })).status()).toBe(401);
    expect((await context.request.post("/encore/api/account/logout", { headers: { origin: "https://untrusted.invalid" } })).status()).toBe(403);
    await json(await context.request.post("/encore/api/account/logout", { headers: { origin } }));
    for (const app of [{ name: "hub", path: "" }, ...apps]) expect((await json(await context.request.get(`${app.path}/api/account/session`))).user).toBeNull();
    // A logout revokes this browser's family; another signed-in device survives.
    expect((await json(await second.request.get("/api/account/session"))).user.id).toBe(user.id);
    await json(await second.request.post("/api/account/logout", { headers: { origin } }));
  } finally {
    await Promise.all([context.close(), second.close(), stranger.close()]);
    // This disposable fixture is retained for inspection; it never touches the
    // working copy's databases or any production account.
  }
});
