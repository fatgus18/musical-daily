import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as reveal } from "../src/app/api/reveal/route";
import { POST as finish } from "../src/app/api/finish/route";
import { GET as daily } from "../src/app/api/daily/route";
import { freshHand, pickHand, finishHand, handEvent } from "../src/lib/account-game";
import { generateDailyPuzzle } from "../src/lib/puzzle";

test("guest and account daily entry use the same UTC songs and cap around India's midnight", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T00:30:00+05:30") });
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.MUSICAL_DAILY_SERVICE_SECRET;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = "test-only-service-key-for-account-routes";
  const actions: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const operation = JSON.parse(String(init?.body));
    actions.push(operation.action);
    if (operation.action === "account-progress") return Response.json({ user: { id: "alice", name: "Alice", email: "alice@example.test", picture: null }, progress: null });
    if (operation.action === "save-progress") return Response.json({ saved: true, revision: 1 });
    throw new Error(`Unexpected operation ${operation.action}`);
  };
  try {
    const guestResponse = await daily(new NextRequest("http://localhost:3000/api/daily"));
    const accountResponse = await daily(new NextRequest("http://localhost:3000/api/daily", { headers: { cookie: "md_blackjack_session=test-session" } }));
    assert.equal(guestResponse.status, 200);
    assert.equal(accountResponse.status, 200);
    const guest = await guestResponse.json();
    const account = await accountResponse.json();
    assert.equal(guest.date, "2026-11-10");
    assert.equal(account.date, guest.date);
    assert.equal(account.catalogVersion, guest.catalogVersion);
    assert.equal(account.rulesVersion, guest.rulesVersion);
    assert.equal(account.targetStreams, guest.targetStreams);
    assert.deepEqual(account.tracks.map((track: { id: string }) => track.id), guest.tracks.map((track: { id: string }) => track.id));
    assert.ok(account.accountState);
    assert.equal(guest.accountState, undefined);
    assert.equal(guest.optimalHandIds, undefined);
    assert.deepEqual(actions, ["account-progress", "save-progress"], "one identity/progress read plus the first-hand write");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.MUSICAL_DAILY_SERVICE_SECRET; else process.env.MUSICAL_DAILY_SERVICE_SECRET = originalSecret;
    context.mock.timers.reset();
  }
});

test("account completion is derived from server picks, saved atomically and cannot be overwritten", async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.MUSICAL_DAILY_SERVICE_SECRET;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = "test-only-service-key-for-account-routes";
  const puzzle = generateDailyPuzzle("2026-11-01");
  let hand = freshHand(puzzle);
  let revision = 1;
  const events: unknown[] = [];
  let unavailable = false;
  globalThis.fetch = async (_input, init) => {
    if (unavailable) throw new Error("network unavailable");
    const request = JSON.parse(String(init?.body));
    if (request.action === "account-progress") return Response.json({ user: { id: "alice", name: "Alice", email: "alice@example.test", picture: null }, progress: { value: hand, revision } });
    if (request.action === "save-progress") {
      if (request.revision !== revision) return Response.json({ saved: false, revision, conflict: true, value: hand });
      hand = request.value; revision++;
      if (request.event) events.push(request.event);
      return Response.json({ saved: true, revision });
    }
    throw new Error(`Unexpected operation ${request.action}`);
  };
  const request = (path: string, data: unknown, origin = "http://localhost:3000") => new NextRequest(`http://localhost:3000/api/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: "md_blackjack_session=test-session", origin }, body: JSON.stringify(data),
  });
  try {
    assert.equal((await finish(request("finish", { date: puzzle.date, pickedIds: puzzle.optimalHandIds, accountRevision: revision }))).status, 409, "forged optimal picks are rejected");
    for (const trackId of puzzle.optimalHandIds) {
      assert.equal((await reveal(request("reveal", { date: puzzle.date, trackId, accountRevision: revision }))).status, 200);
    }
    assert.equal(hand.gameOver, true);
    assert.equal(events.length, 1, "an automatic finish is saved before the client can close or lose its response");
    const result = await finish(request("finish", { date: puzzle.date, pickedIds: hand.pickedIds, accountRevision: revision }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).rank, "BLACKJACK");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { eventId: `daily:${puzzle.date}`, mode: "daily", date: puzzle.date, score: 100, maxScore: 100, won: true, correct: 1, rounds: 1 });
    const replay = await finish(request("finish", { date: puzzle.date, pickedIds: [puzzle.tracks[0].id], accountRevision: 0 }));
    assert.equal((await replay.json()).rank, "BLACKJACK", "first completed hand wins across devices");
    assert.equal(events.length, 1, "a lost finish response can be retried without duplicate events");
    assert.equal((await reveal(request("reveal", { date: puzzle.date, trackId: "other", accountRevision: 0 }))).status, 409);
    assert.equal((await finish(request("finish", {}, "https://other.example"))).status, 403);
    unavailable = true;
    assert.equal((await finish(request("finish", { date: puzzle.date, pickedIds: hand.pickedIds }))).status, 503, "signed-in requests never fall back to guest on account outage");
  } finally { globalThis.fetch = originalFetch; if (originalSecret === undefined) delete process.env.MUSICAL_DAILY_SERVICE_SECRET; else process.env.MUSICAL_DAILY_SERVICE_SECRET = originalSecret; }
});

test("server shield burns the first over-cap pick and records a second bust as zero", () => {
  const puzzle = generateDailyPuzzle("2026-11-01");
  let hand = freshHand(puzzle);
  const ordered = [...puzzle.tracks].sort((a, b) => b.streams - a.streams);
  for (const track of ordered) {
    hand = pickHand(hand, track.id);
    const sum = hand.pickedIds.reduce((sum, id) => sum + hand.revealedStreams[id], 0);
    if (sum > puzzle.targetStreams) break;
  }
  assert.equal(hand.burnedIds.length, 1);
  assert.equal(hand.shieldAvailable, false);
  hand = { ...hand, gameOver: true, finishData: finishHand(puzzle, hand.pickedIds) };
  assert.equal(hand.finishData!.rank, "BUST");
  assert.equal(handEvent(hand)!.score, 0);
  assert.equal(handEvent(hand)!.won, false);
});
