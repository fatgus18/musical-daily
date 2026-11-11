import { test, expect, type APIResponse } from "@playwright/test";
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

function hubCookie(token: string) {
  return { name: "md_hub_session", value: token, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
}

function seed(action: string, userId?: string) {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/account-services/seed-local.mjs"), action, ...(userId ? [userId] : [])], { encoding: "utf8", windowsHide: true }));
}

test("a central login loads every game directly and persists four results across devices and family logout", async ({ browser }) => {
  fixture();
  const { user, session: firstSession } = seed("identity");
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const second = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const stranger = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    await context.addCookies([hubCookie(firstSession.token)]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // No /game/api/account/login calls, synthetic per-game cookies or handoffs:
    // this is the exact hub-login -> direct-game navigation that previously failed.
    for (const app of [{ name: "hub", path: "" }, ...apps]) {
      const response = await page.goto(app.path || "/");
      expect(response?.ok(), `${app.name} page must render signed in`).toBe(true);
      expect(new URL(page.url()).origin).toBe(origin);
      await expect(page.getByRole("button", { name: /Local QA Listener|Local QA|Local/ }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /^Sign in$/ })).toHaveCount(0);
    }
    expect((await context.cookies()).filter(cookie => /^md_(blackjack|tempo|encore|double-drop)_session$/.test(cookie.name))).toEqual([]);
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
    for (const app of apps) expect((await json(await second.request.get(`${app.path}/api/account/session`))).user.id).toBe(user.id);
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
    expect((await context.cookies()).some(cookie => cookie.name === "md_hub_session")).toBe(false);
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

test("switching the central account ignores old per-game cookies and one game logout signs out the whole site", async ({ browser }) => {
  fixture();
  const first = seed("identity");
  const current = seed("identity");
  const legacy = seed("legacy-sessions", first.user.id);
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    await context.addCookies([hubCookie(first.session.token), ...apps.map(app => ({ ...hubCookie(legacy[app.name].token), name: `md_${app.name}_session` }))]);
    for (const app of apps) expect((await json(await context.request.get(`${app.path}/api/account/session`))).user.id).toBe(first.user.id);
    await context.addCookies([hubCookie(current.session.token)]);
    for (const app of [{ name: "hub", path: "" }, ...apps]) {
      expect((await json(await context.request.get(`${app.path}/api/account/session`))).user.id).toBe(current.user.id);
      expect((await json(await context.request.get(`${app.path}/api/account/stats`))).user.id).toBe(current.user.id);
    }
    for (const app of apps) {
      const login = await context.request.get(`${app.path}/api/account/login?returnTo=${encodeURIComponent(`${app.path}/stats`)}`, { maxRedirects: 0 });
      expect(login.status()).toBe(303);
      const target = new URL(login.headers().location);
      expect(target.origin).toBe(origin);
      expect(target.pathname).toBe("/api/account/login");
      expect(target.searchParams.get("returnTo")).toBe(`${app.path}/stats`);
      const returned = await context.request.get(target.toString());
      expect(returned.ok()).toBe(true);
      expect(new URL(returned.url()).origin + new URL(returned.url()).pathname).toBe(`${origin}${app.path}/stats`);
    }
    await json(await context.request.post("/double-or-drop/api/account/logout", { headers: { origin } }));
    for (const app of [{ name: "hub", path: "" }, ...apps]) {
      expect((await json(await context.request.get(`${app.path}/api/account/session`))).user).toBeNull();
      expect((await json(await context.request.get(`${app.path}/api/account/stats`))).user).toBeNull();
    }
    // Even a delayed old tab restoring a game cookie cannot resurrect identity.
    await context.addCookies(apps.map(app => ({ ...hubCookie(legacy[app.name].token), name: `md_${app.name}_session` })));
    for (const app of apps) expect((await json(await context.request.get(`${app.path}/api/account/session`))).user).toBeNull();
  } finally { await context.close(); }
});

test("guest Encore and Double or Drop runs join the first central account exactly once", async ({ browser }) => {
  fixture();
  const first = seed("identity");
  const other = seed("identity");
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    // Create actual anonymous browser identities through public game endpoints.
    expect((await json(await context.request.get("/encore/api/game"))).game).toBeNull();
    const encoreCookie = (await context.cookies()).find(cookie => cookie.name === "encore_player")!;
    expect(encoreCookie.value).toMatch(/^[a-f0-9]{64}$/);
    const encore = seed("guest-encore", encoreCookie.value);
    expect((await json(await context.request.get("/encore/api/game"))).game.id).toBe(encore.id);

    const move = async (data: object): Promise<PublicGame> => (await json(await context.request.post("/double-or-drop/api/game", { headers: { origin }, data }))).game;
    let drop = await move({ action: "create", requestId: randomUUID(), metricFilter: "duration" });
    const dropCatalog = JSON.parse(readFileSync(resolve(`../double-or-drop/data/catalog-releases/${drop.catalogVersion}.json`), "utf8"));
    const tracks = new Map<string, CatalogTrack>(dropCatalog.tracks.map((track: CatalogTrack) => [track.id, track]));
    const choice = tracks.get(drop.pair.left.id)!.metrics.duration!.value > tracks.get(drop.pair.right.id)!.metrics.duration!.value ? "left" : "right";
    drop = await move({ action: "guess", gameId: drop.id, round: drop.round, revision: drop.revision, choice });
    drop = await move({ action: "cashout", gameId: drop.id, round: drop.round, revision: drop.revision });
    expect(drop.banked).toBeGreaterThan(0);
    const dropCookie = (await context.cookies()).find(cookie => cookie.name === "double_drop_player")!;

    // A hub login alone must merge before the first authenticated game API call.
    await context.addCookies([hubCookie(first.session.token)]);
    expect((await json(await context.request.get("/encore/api/game"))).game.id).toBe(encore.id);
    expect((await json(await context.request.get("/double-or-drop/api/game"))).game.id).toBe(drop.id);
    const claimed = await json(await context.request.get("/api/account/stats"));
    expect(claimed.games.encore.completed).toBe(1);
    expect(claimed.games.encore.totalCorrect).toBe(7);
    expect(claimed.games["double-drop"].completed).toBe(1);
    expect(claimed.games["double-drop"].totalBanked).toBe(drop.banked);
    expect((await context.cookies()).find(cookie => cookie.name === "encore_player")!.value).not.toBe(encoreCookie.value);
    expect((await context.cookies()).find(cookie => cookie.name === "double_drop_player")!.value).not.toBe(dropCookie.value);
    await json(await context.request.get("/encore/api/game"));
    await json(await context.request.get("/double-or-drop/api/game"));
    expect((await json(await context.request.get("/api/account/stats"))).games).toEqual(claimed.games);

    // Replay the consumed anonymous identities under a different real account.
    await context.addCookies([hubCookie(other.session.token), encoreCookie, dropCookie]);
    expect((await json(await context.request.get("/encore/api/game"))).game).toBeNull();
    expect((await json(await context.request.get("/double-or-drop/api/game"))).game).toBeNull();
    const strangerStats = await json(await context.request.get("/api/account/stats"));
    expect(strangerStats.user.id).toBe(other.user.id);
    expect(strangerStats.games.encore.played).toBe(0);
    expect(strangerStats.games["double-drop"].played).toBe(0);
    await context.addCookies([hubCookie(first.session.token)]);
    expect((await json(await context.request.get("/api/account/stats"))).games).toEqual(claimed.games);
  } finally { await context.close(); }
});
