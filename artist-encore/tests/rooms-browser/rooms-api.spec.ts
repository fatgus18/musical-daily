import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { PublicRoom, RoomState } from "../../src/lib/rooms/types";

const origin = "https://localhost:3100";
const artistId = "apple:262836961";
const path = (code: string) => `/encore/api/rooms/${code}`;
function seed(operation: string, code?: string): RoomState {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/rooms-browser/fixture.mjs"), operation, ...(code ? [code] : [])], { encoding: "utf8", windowsHide: true }));
}
async function json(response: APIResponse) {
  expect(response.ok(), `${response.url()} ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
async function room(context: APIRequestContext, code: string): Promise<PublicRoom> { return (await json(await context.get(path(code)))).room; }
async function post(context: APIRequestContext, code: string, data: object): Promise<PublicRoom> { return (await json(await context.post(path(code), { headers: { origin }, data }))).room; }
async function command(context: APIRequestContext, state: PublicRoom, action: string, fields: object = {}) { return post(context, state.code, { action, matchId: state.matchId, round: state.round, audioRevision: state.audioRevision, ...fields }); }
async function create(context: APIRequestContext, nickname = "Host") {
  return (await json(await context.post("/encore/api/rooms", { headers: { origin }, data: { action: "create", artistId, nickname, requestId: randomUUID() } }))).room as PublicRoom;
}
function hidden(state: PublicRoom) {
  expect(state).not.toHaveProperty("picks");
  expect(state).not.toHaveProperty("history");
  expect(state).not.toHaveProperty("createdBy");
  expect(state.players.every(player => !("answer" in player))).toBe(true);
  expect(JSON.stringify(state)).not.toMatch(/room-fixture-|correctChoiceId/);
}

test.beforeAll(() => { seed("catalog"); });

test("room creation rejects unknown artist modes and conflicting random-artist inputs", async ({ playwright }) => {
  const client = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    for (const fields of [
      { artistMode: "shuffle", artistId },
      { artistMode: null, artistId },
      { artistMode: "random", artistId },
      { artistMode: "chosen" },
    ]) {
      const response = await client.post("/encore/api/rooms", { headers: { origin }, data: { action: "create", nickname: "Mode validation", requestId: randomUUID(), ...fields } });
      expect(response.status(), await response.text()).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
  } finally { await client.dispose(); }
});

test("a random room shares one eligible artist and its rematch picks a different artist without rerolling retries", async ({ playwright }) => {
  seed("random-catalog");
  const host = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const friend = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const input = { action: "create", artistMode: "random", nickname: "Surprise Host", requestId: randomUUID() };
    let state = (await json(await host.post("/encore/api/rooms", { headers: { origin }, data: input }))).room as PublicRoom;
    expect(state.artistMode).toBe("random");
    expect(["apple:262836961", "apple:342260741"]).toContain(state.artist.id);
    const duplicate = (await json(await host.post("/encore/api/rooms", { headers: { origin }, data: input }))).room as PublicRoom;
    expect(duplicate.code).toBe(state.code);
    expect(duplicate.matchId).toBe(state.matchId);
    expect(duplicate.artist).toEqual(state.artist);
    const joined = await post(friend, state.code, { action: "join", nickname: "Surprise Friend" });
    expect(joined.artistMode).toBe("random");
    expect(joined.artist).toEqual(state.artist);
    hidden(joined);
    const privateState = seed("inspect", state.code);
    expect(privateState.picks).toHaveLength(10);
    expect(privateState.picks.every(pick => pick.track.artistId === state.artist.id)).toBe(true);
    await command(host, state, "ready", { ready: true });
    await command(friend, joined, "ready", { ready: true });
    state = await command(host, state, "start");
    // Real host skip commands finish an unscored match; the private fixture
    // only shortens reveal clocks. Scores and match transitions stay server-owned.
    for (let round = 0; round < 10; round++) {
      expect(state.phase).toBe("loading");
      state = await command(host, state, "skip");
      expect(state.reveals.at(-1)?.voided).toBe(true);
      seed("expire-reveal", state.code);
      state = await room(host, state.code);
    }
    expect(state.phase).toBe("complete");
    const requestId = randomUUID();
    const next = await command(host, state, "rematch", { requestId });
    expect(next.artistMode).toBe("random");
    expect(next.artist.id).not.toBe(state.artist.id);
    expect(next.phase).toBe("lobby");
    expect(next.matchId).not.toBe(state.matchId);
    const retry = await command(host, state, "rematch", { requestId });
    expect(retry.matchId).toBe(next.matchId);
    expect(retry.artist).toEqual(next.artist);
    expect((await room(friend, state.code)).artist).toEqual(next.artist);
  } finally { await Promise.all([host.dispose(), friend.dispose()]); }
});

test("two guest players get one authoritative ten-song match, private answers, persistent membership and accuracy-first ranking", async ({ playwright, browser }) => {
  const host = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const friend = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const stranger = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    let state = await create(host);
    expect(state.artistMode).toBe("chosen");
    const code = state.code;
    const hostId = state.youId;
    const joined = await post(friend, code, { action: "join", nickname: "Friend", avatar: "guitar" });
    const friendId = joined.youId;
    expect(friendId).not.toBe(hostId);
    expect(joined.players).toHaveLength(2);
    hidden(state); hidden(joined);
    expect((await stranger.get(path(code))).status()).toBe(401);
    const spoof = await friend.post(path(code), { headers: { origin }, data: { action: "start", matchId: state.matchId, round: state.round, playerId: hostId, hostId, youId: hostId } });
    expect(spoof.status()).toBe(400);
    expect((await friend.post(path(code), { headers: { origin }, data: { action: "start", matchId: state.matchId, round: state.round } })).status()).toBe(403);
    expect((await friend.post(path(code), { headers: { origin: "https://untrusted.invalid" }, data: { action: "ready", matchId: state.matchId, round: state.round, ready: true } })).status()).toBe(403);
    state = await command(host, state, "ready", { ready: true });
    await command(friend, joined, "ready", { ready: true });
    state = await command(host, state, "start");
    expect(state.phase).toBe("loading");
    expect((await stranger.post(path(code), { headers: { origin }, data: { action: "join", nickname: "Late" } })).status()).toBe(409);
    const beforeSolo = await json(await host.get("/encore/api/game"));
    expect(beforeSolo.game).toBeNull();

    for (let round = 0; round < 10; round++) {
      expect(state.phase).toBe("loading");
      expect(state.round).toBe(round);
      await command(host, state, "loaded");
      state = await command(friend, state, "loaded");
      expect(state.phase).toBe("playing");
      const shared = await room(host, code);
      expect(shared.startAt).toBe(state.startAt);
      expect(shared.roundEnd).toBe(state.roundEnd);
      expect(shared.clipSeconds).toBe(15);
      expect(shared.guessSeconds).toBe(15);
      // Private clock fixture shortens countdown only. Answers still use real
      // commands and are scored by the same production engine.
      seed("play-now", code);
      state = await room(host, code);
      expect(state.choices).toBeUndefined();
      const guess = await command(host, state, "guess");
      expect(guess.choices).toHaveLength(4);
      expect(guess.you.guessDeadline! - guess.you.guessAt!).toBe(15000);
      expect(guess.audioUrl).toBeUndefined();
      const other = await room(friend, code);
      expect(other.choices).toBeUndefined();
      expect(other.you.guessAt).toBeNull();
      expect(other.audioUrl).toBeTruthy();
      const privateRoom = seed("inspect", code);
      const correct = privateRoom.picks[round].correctChoiceId!;
      const request = { action: "answer", matchId: guess.matchId, round, choiceId: correct };
      const submitted = await post(host, code, request);
      const duplicated = await post(host, code, request);
      expect(submitted.you.answered).toBe(true);
      expect(duplicated.you.choiceId).toBe(correct);
      expect(submitted.phase).toBe("playing");
      expect(submitted.reveals).toHaveLength(round);
      expect((await room(friend, code)).reveals).toHaveLength(round);
      if (round === 0) { hidden(submitted); hidden(await room(friend, code)); }
      const storage = await host.storageState();
      expect(storage.cookies.find(cookie => cookie.name === "encore_room_player")).toMatchObject({ secure: true, httpOnly: true });
      const reconnect = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true, storageState: storage });
      try {
        const restored = await room(reconnect, code);
        expect(restored.youId).toBe(hostId);
        expect(restored.you.choiceId).toBe(correct);
      } finally { await reconnect.dispose(); }
      const friendGuess = await command(friend, await room(friend, code), "guess");
      const wrong = friendGuess.choices!.find(choice => choice.id !== correct)!.id;
      state = await command(friend, friendGuess, "answer", { choiceId: round === 9 ? wrong : correct });
      expect(state.phase).toBe("reveal");
      expect(state.reveals.at(-1)?.correctChoiceId).toBe(correct);
      expect(state.leaderboard.find(player => player.id === hostId)?.score).toBe((round + 1) * 1000);
      seed("expire-reveal", code);
      state = await room(host, code);
    }
    expect(state.phase).toBe("complete");
    expect(state.reveals).toHaveLength(10);
    expect(state.leaderboard[0]).toMatchObject({ id: hostId, score: 10000, correct: 10, winner: true });
    expect(state.leaderboard[1]).toMatchObject({ id: friendId, score: 9000, correct: 9, winner: false });
    expect((await json(await host.get("/encore/api/game"))).game).toBeNull();
    const result = await room(friend, code);
    expect(result.leaderboard).toEqual(state.leaderboard);
    const finalContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, storageState: await host.storageState(), viewport: { width: 320, height: 740 } });
    try {
      const page = await finalContext.newPage();
      await page.goto(`/encore/rooms/${code}`);
      await expect(page.getByRole("heading", { name: "You owned the encore." })).toBeVisible();
      await expect(page.getByRole("region", { name: "Final standings" }).locator("li")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.getByText("The setlist · 10 scored songs", { exact: true }).click();
      await expect(page.locator(".er-round-history li")).toHaveCount(10);
      await page.screenshot({ path: "test-results-rooms/room-final-phone.png", fullPage: true });
      await page.getByRole("button", { name: "Run it back", exact: true }).click();
      await expect(page.locator(".er-site")).toHaveAttribute("data-room-phase", "lobby");
      const rematch = await room(host, code);
      expect(rematch.matchId).not.toBe(state.matchId);
      expect(rematch.leaderboard.every(player => player.score === 0)).toBe(true);
    } finally { await finalContext.close(); }
  } finally { await Promise.all([host.dispose(), friend.dispose(), stranger.dispose()]); }
});

test("rooms cap at eight, enforce host permissions, promote a remaining host and expire safely", async ({ playwright }) => {
  const contexts = await Promise.all(Array.from({ length: 9 }, () => playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true })));
  try {
    let state = await create(contexts[0], "Captain");
    for (let index = 1; index < 8; index++) await post(contexts[index], state.code, { action: "join", nickname: `Listener ${index}` });
    state = await room(contexts[0], state.code);
    expect(state.players.filter(player => !player.left)).toHaveLength(8);
    expect((await contexts[8].post(path(state.code), { headers: { origin }, data: { action: "join", nickname: "Overflow" } })).status()).toBe(409);
    await command(contexts[0], state, "leave");
    const promoted = await room(contexts[1], state.code);
    expect(promoted.hostId).toBe(promoted.youId);
    expect(promoted.players.find(player => player.id === state.youId)?.left).toBe(true);
    seed("expire-room", state.code);
    expect((await contexts[1].get(path(state.code))).status()).toBe(410);
  } finally { await Promise.all(contexts.map(context => context.dispose())); }
});

test("a missing preview voids a round for everyone, and early guessing has its own enforced deadline", async ({ playwright }) => {
  const host = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const friend = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    let state = await create(host);
    await post(friend, state.code, { action: "join", nickname: "Listener" });
    await command(host, state, "ready", { ready: true });
    await command(friend, state, "ready", { ready: true });
    state = await command(host, state, "start");
    await command(host, state, "loaded");
    seed("expire-loading", state.code);
    state = await room(host, state.code);
    expect(state.phase).toBe("reveal");
    expect(state.reveals[0]).toMatchObject({ voided: true, reason: "preview_unavailable" });
    expect(state.leaderboard.every(player => player.score === 0)).toBe(true);
    seed("expire-reveal", state.code);
    state = await room(host, state.code);
    await command(host, state, "loaded");
    state = await command(friend, state, "loaded");
    seed("play-now", state.code);
    state = await command(host, await room(host, state.code), "guess");
    const correct = seed("inspect", state.code).picks[state.round].correctChoiceId!;
    seed("expire-round", state.code);
    const late = await host.post(path(state.code), { headers: { origin }, data: { action: "answer", matchId: state.matchId, round: state.round, choiceId: correct } });
    // Delivery after timeout is idempotent: the stored timeout is returned;
    // a late correct option must never replace it or award points.
    expect(late.ok()).toBe(true);
    const lateRoom = (await late.json()).room as PublicRoom;
    expect(lateRoom.you.choiceId).toBeNull();
    const settled = await room(friend, state.code);
    expect(settled.phase).toBe("reveal");
    expect(settled.reveals.at(-1)?.answers.every(answer => answer.timedOut && !answer.correct)).toBe(true);
    expect(settled.leaderboard.every(player => player.score === 0)).toBe(true);
  } finally { await Promise.all([host.dispose(), friend.dispose()]); }
});
