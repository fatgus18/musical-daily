import { test } from "node:test";
import assert from "node:assert/strict";
import { presentBoard } from "../src/lib/board-presentation";
import { dailyDate, nextDailyReset } from "../src/lib/daily-clock";
import { generateDailyPuzzle, getTodayDateString } from "../src/lib/puzzle";
import { finishHand, freshHand, pickHand } from "../src/lib/account-game";

test("daily date and reset are identical across timezone representations and sign-in states", () => {
  for (const instant of ["2026-11-11T00:30:00+05:30", "2026-11-10T11:00:00-08:00", "2026-11-10T19:00:00Z"]) {
    const now = new Date(instant);
    assert.equal(dailyDate(now), "2026-11-10");
    assert.equal(getTodayDateString(now), "2026-11-10");
    assert.equal(nextDailyReset(now), Date.parse("2026-11-11T00:00:00Z"));
  }
  for (const [instant, expected] of [
    ["2026-11-10T23:59:59.999Z", "2026-11-10"],
    ["2026-11-11T00:00:00.000Z", "2026-11-11"],
    ["2026-12-31T23:59:59.999Z", "2026-12-31"],
    ["2027-01-01T00:00:00.000Z", "2027-01-01"],
  ]) assert.equal(dailyDate(new Date(instant)), expected);
});

test("player layouts differ while all nine songs, exact cap, and solution stay identical", () => {
  const puzzle = generateDailyPuzzle("2026-11-11");
  const original = structuredClone(puzzle);
  const canonicalIds = puzzle.tracks.map(track => track.id).sort();
  const layouts = new Set<string>();
  for (let player = 0; player < 30; player++) {
    const displayed = presentBoard(puzzle.tracks, puzzle, `account:player-${player}`);
    assert.deepEqual(displayed.map(track => track.id).sort(), canonicalIds);
    for (const track of displayed) assert.equal(track, puzzle.tracks.find(source => source.id === track.id));
    assert.equal(displayed.filter(track => puzzle.optimalHandIds.includes(track.id)).reduce((sum, track) => sum + track.streams, 0), puzzle.targetStreams);
    layouts.add(displayed.map(track => track.id).join(","));
  }
  assert.ok(layouts.size > 25, "presentation does not retain one universal positional answer key");
  assert.deepEqual(puzzle, original, "the canonical puzzle is untouched");
});

test("refreshes and another device preserve the account's order, independent of input order", () => {
  const puzzle = generateDailyPuzzle("2026-11-11");
  const first = presentBoard(puzzle.tracks, puzzle, "account:alice");
  assert.deepEqual(first, presentBoard(puzzle.tracks, puzzle, "account:alice"));
  assert.deepEqual(first, presentBoard([...puzzle.tracks].reverse(), { ...puzzle }, "account:alice"));
  assert.notDeepEqual(first, presentBoard(puzzle.tracks, { ...puzzle, seedKey: "2026-11-12" }, "account:alice"));
  assert.notDeepEqual(first, presentBoard(puzzle.tracks, puzzle, "guest:alice"));
});

test("saved ID-based picks restore and complete the same hand after presentation shuffling", () => {
  const puzzle = generateDailyPuzzle("2026-11-11");
  let hand = freshHand(puzzle);
  hand = pickHand(hand, puzzle.optimalHandIds[0]);
  const saved = structuredClone(hand);
  const displayed = presentBoard(puzzle.tracks, puzzle, "account:alice");
  assert.deepEqual(displayed.filter(track => saved.pickedIds.includes(track.id)).map(track => track.id), saved.pickedIds);
  for (const id of puzzle.optimalHandIds.slice(1)) hand = pickHand(hand, id);
  assert.equal(hand.gameOver, true);
  assert.equal(hand.finishData?.finalSum, puzzle.targetStreams);
  assert.equal(hand.finishData?.rank, "BLACKJACK");
  assert.deepEqual(hand.finishData, finishHand(puzzle, puzzle.optimalHandIds));
});
