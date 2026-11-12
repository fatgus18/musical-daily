import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { act, correctChoice, create, fixture, hiddenValues, json, move, origin, post, privateDecision, read, roomPath, seedAccount } from "./helpers";
import type { PublicRoom } from "../../src/lib/rooms/types";

test("three teammates share the pot and bank, commit before seeing pairs, settle races once, and keep final misses visible", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })));
  const clients = contexts.map(context => context.request);
  try {
    const user = await seedAccount(contexts[0]);
    const beforeStats = await json(await clients[0].get("/api/account/stats"));
    expect(beforeStats.user.id).toBe(user.id);
    expect((await json(await clients[0].get("/double-or-drop/api/game"))).game).toBeNull();
    let { room: state, input, catalog } = await create(clients[0]);
    expect(catalog.tracks).toBeGreaterThan(1000);
    expect(state.catalogVersion).toBe(catalog.version);
    expect(state.phase).toBe("lobby");
    privateDecision(state);
    expect(JSON.stringify(state)).not.toContain(user.email);
    const duplicate = (await json(await clients[0].post("/double-or-drop/api/rooms", { headers: { origin }, data: input }))).room;
    expect(duplicate.code).toBe(state.code);
    const members = [state.youId];
    for (let index = 1; index < 3; index++) members.push((await post(clients[index], state.code, { action: "join", nickname: `Teammate ${index}` })).youId);
    expect(new Set(members).size).toBe(3);
    for (const client of clients) await act(client, state, "ready", { ready: true });
    const forbiddenStart = await clients[1].post(roomPath(state.code), { headers: { origin }, data: move(state, "start") });
    expect(forbiddenStart.status()).toBe(403);
    state = await act(clients[0], state, "start");
    expect(state.phase).toBe("decision");
    expect(state.activePlayerId).toBe(members[0]);
    privateDecision(state);

    for (let turn = 0; turn < 6; turn++) {
      const index = turn % 3;
      const active = clients[index];
      expect(state.turn).toBe(turn);
      expect(state.activePlayerId).toBe(members[index]);
      expect(state.phase).toBe("decision");
      privateDecision(state);
      const inactive = clients[(index + 1) % 3];
      expect((await inactive.post(roomPath(state.code), { headers: { origin }, data: move(state, "pick") })).status()).toBe(403);
      const decision = move(state, turn === 2 ? "bank" : state.team.pot > 0 ? "risk" : "pick");
      state = await post(active, state.code, decision);
      expect(state.phase).toBe("guess");
      hiddenValues(state);
      expect(state.guessDeadline! - state.serverNow).toBeGreaterThan(18500);
      expect(state.guessDeadline! - state.serverNow).toBeLessThanOrEqual(20000);
      if (turn === 2) {
        expect(state.team.banked).toBe(200);
        expect(state.team.pot).toBe(0);
        const bankRetry = await post(active, state.code, decision);
        expect(bankRetry.team.banked).toBe(200);
        expect(bankRetry.guessDeadline).toBe(state.guessDeadline);
        expect(bankRetry.pair).toEqual(state.pair);
      }
      const storage = await contexts[index].storageState();
      expect(storage.cookies.find(cookie => cookie.name === "double_drop_room_player")).toMatchObject({ httpOnly: true, secure: true });
      const reconnect = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, storageState: storage });
      try {
        const restored = await read(reconnect.request, state.code);
        expect(restored.youId).toBe(members[index]);
        expect(restored.guessDeadline).toBe(state.guessDeadline);
      } finally { await reconnect.close(); }
      const correct = correctChoice(state.code);
      const wrong = correct === "left" ? "right" : "left";
      if (turn === 4) {
        fixture("expire-pick", state.code);
        const expired = await Promise.all([read(active, state.code), read(inactive, state.code)]);
        state = expired[0];
        expect(expired[1].team.lives).toBe(1);
        expect(state.reveal?.timedOut).toBe(true);
      } else {
        const answer = move(state, "guess", { choice: turn < 3 ? correct : wrong });
        // Identical delivery races must never double-score or consume two lives.
        const answers = await Promise.all([post(active, state.code, answer), post(active, state.code, answer)]);
        state = answers[0];
        expect(answers[1].team).toEqual(state.team);
      }
      expect(state.phase).toBe("reveal");
      expect(state.team.answered).toBe(turn + 1);
      expect(state.team.banked).toBe(turn >= 2 ? 200 : 0);
      expect(state.team.pot).toBe([100, 200, 100, 0, 0, 0][turn]);
      expect(state.team.lives).toBe([3, 3, 3, 2, 1, 0][turn]);
      if (turn === 3) expect(state.reveal?.lostPot).toBe(100);
      const revealUntil = state.revealUntil!;
      expect(revealUntil - state.serverNow).toBeGreaterThan(4000);
      if (turn === 5) {
        expect((await read(clients[0], state.code)).phase).toBe("reveal");
        expect((await read(clients[2], state.code)).revealUntil).toBe(revealUntil);
      }
      fixture("expire-reveal", state.code);
      const previous = state;
      state = await read(clients[0], state.code);
      if (turn < 5) {
        const stale = await active.post(roomPath(state.code), { headers: { origin }, data: move(previous, "guess", { choice: correct }) });
        expect(stale.status()).toBe(409);
        expect((await read(active, state.code)).team.answered).toBe(turn + 1);
      }
    }
    expect(state.phase).toBe("complete");
    expect(state.completionStatus).toBe("completed");
    expect(state.team).toMatchObject({ banked: 200, pot: 0, lives: 0, correct: 3, answered: 6 });
    expect((await read(clients[2], state.code)).team).toEqual(state.team);
    expect((await json(await clients[0].get("/double-or-drop/api/game"))).game).toBeNull();
    expect((await json(await clients[0].get("/api/account/stats"))).games).toEqual(beforeStats.games);
    const request = move(state, "rematch");
    const next = await post(clients[0], state.code, request);
    expect(next.phase).toBe("lobby");
    expect(next.matchId).not.toBe(state.matchId);
    expect(next.team).toMatchObject({ banked: 0, pot: 0, lives: 3, answered: 0 });
    expect((await post(clients[0], state.code, request)).matchId).toBe(next.matchId);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("co-op rooms use the broad roster and immutable, eligible artist packs", async ({ browser }) => {
  fixture("catalog");
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const client = context.request;
    const baseline = await json(await client.get("/double-or-drop/api/rooms"));
    const collection = await json(await client.post("/double-or-drop/api/artists", { headers: { origin }, data: { artistId: "apple:262836961" } }));
    expect(collection.theme.id).toBe("artist:adele");
    expect(collection.theme.metrics).toContain("duration");
    expect(collection.catalogVersion).not.toBe(baseline.catalog.version);
    const { room } = await create(client, "Artist Captain", { theme: collection.theme.id, metricFilter: "duration", catalogVersion: collection.catalogVersion });
    expect(room.theme).toBe(collection.theme.id);
    expect(room.catalogVersion).toBe(collection.catalogVersion);
    const pin = fixture<{room_code:string;version:string;expires_at:number}>("inspect-pin", room.code);
    expect(pin.version).toBe(collection.catalogVersion);
    expect(pin.expires_at).toBeGreaterThan(Date.now());
    const saved = fixture("inspect", room.code);
    expect([saved.game.pair.left.artist, saved.game.pair.right.artist]).toEqual(["Adele", "Adele"]);
    expect((await json(await client.get("/double-or-drop/api/rooms"))).catalog.version).toBe(baseline.catalog.version);
    expect((await read(client, room.code)).catalogVersion).toBe(collection.catalogVersion);
    for (const settings of [{ theme: "missing:collection", metricFilter: "duration" }, { theme: "all", metricFilter: "tempo" }]) {
      const response = await client.post("/double-or-drop/api/rooms", { headers: { origin }, data: { action: "create", nickname: "Invalid settings", requestId: randomUUID(), catalogVersion: baseline.catalog.version, ...settings } });
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
    }
  } finally { await context.close(); }
});

test("offline decisions hand off, everyone-away pauses, and leaving a committed pick cannot dodge a life", async ({ browser }) => {
  const host = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const friend = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    let { room: state } = await create(host.request, "Offline Captain");
    const hostId = state.youId;
    const joined = await post(friend.request, state.code, { action: "join", nickname: "Still Here" });
    const friendId = joined.youId;
    await act(host.request, state, "ready", { ready: true });
    await act(friend.request, joined, "ready", { ready: true });
    state = await act(host.request, state, "start");
    const old = state;
    fixture("stale-active", state.code);
    state = await read(friend.request, state.code);
    expect(state.phase).toBe("decision");
    expect(state.activePlayerId).toBe(friendId);
    expect(state.hostId).toBe(friendId);
    expect(state.team.lives).toBe(3);
    expect(state.turn).toBeGreaterThan(old.turn);
    expect((await host.request.post(roomPath(state.code), { headers: { origin }, data: move(old, "pick") })).status()).toBe(409);
    fixture("stale-all", state.code);
    state = await read(friend.request, state.code);
    expect(state.phase).toBe("paused");
    expect(state.activePlayerId).toBeNull();
    privateDecision(state);
    state = await act(friend.request, state, "heartbeat");
    expect(state.phase).toBe("decision");
    expect(state.activePlayerId).toBe(friendId);
    state = await act(friend.request, state, "pick");
    const deadline = state.guessDeadline;
    const beforeLife = state.team.lives;
    state = await act(friend.request, state, "leave");
    expect(state.phase).toBe("guess");
    expect(state.activePlayerId).toBe(friendId);
    expect(state.guessDeadline).toBe(deadline);
    expect(state.team.lives).toBe(beforeLife);
    state = await act(host.request, state, "heartbeat");
    expect(state.hostId).toBe(hostId);
    expect((await host.request.post(roomPath(state.code), { headers: { origin }, data: move(state, "guess", { choice: correctChoice(state.code) }) })).status()).toBe(403);
    fixture("expire-pick", state.code);
    state = await read(host.request, state.code);
    expect(state.phase).toBe("reveal");
    expect(state.reveal).toMatchObject({ playerId: friendId, timedOut: true, correct: false });
    expect(state.team.lives).toBe(beforeLife - 1);
    fixture("expire-reveal", state.code);
    state = await read(host.request, state.code);
    expect(state.phase).toBe("decision");
    expect(state.activePlayerId).toBe(hostId);
    state = await act(host.request, state, "leave");
    expect(state.phase).toBe("complete");
    expect(state.completionStatus).toBe("incomplete");
  } finally { await Promise.all([host.close(), friend.close()]); }
});

test("rooms enforce membership, capacity and host permissions without trusting client identity", async ({ playwright }) => {
  const clients = await Promise.all(Array.from({ length: 9 }, () => playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true })));
  try {
    let { room: state } = await create(clients[0], "Capacity Captain");
    expect((await clients[8].get(roomPath(state.code))).status()).toBe(401);
    for (let index = 1; index < 8; index++) await post(clients[index], state.code, { action: "join", nickname: `Player ${index}` });
    state = await read(clients[0], state.code);
    expect(state.players.filter(player => !player.left)).toHaveLength(8);
    expect((await clients[8].post(roomPath(state.code), { headers: { origin }, data: { action: "join", nickname: "Overflow" } })).status()).toBe(409);
    expect((await clients[1].post(roomPath(state.code), { headers: { origin }, data: { ...move(state, "start"), playerId: state.hostId } })).status()).toBe(400);
    expect((await clients[1].post(roomPath(state.code), { headers: { origin }, data: move(state, "start") })).status()).toBe(403);
    expect((await clients[0].post(roomPath(state.code), { headers: { origin: "https://untrusted.invalid" }, data: move(state, "start") })).status()).toBe(403);
    expect((await clients[0].post(roomPath(state.code), { headers: { origin }, data: move(state, "cashout") })).status()).toBe(400);
    await act(clients[0], state, "leave");
    const promoted = await read(clients[1], state.code);
    expect(promoted.hostId).toBe(promoted.youId);
    fixture("expire-room", state.code);
    expect((await clients[1].get(roomPath(state.code))).status()).toBe(410);
  } finally { await Promise.all(clients.map(client => client.dispose())); }
});
