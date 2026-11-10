import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyDate, isGuess, nextDailyReset, previousDailyDate, scoreGuess, selectTracks, shouldRefreshDaily, puzzleNumber } from "../src/lib/game.ts";

test("only whole BPM values in range are accepted", () => {
  for (const value of [40, 120, 220]) assert.equal(isGuess(value), true);
  for (const value of [39, 221, 120.5, NaN, Infinity, null, "120", undefined]) assert.equal(isGuess(value), false);
});
test("close guesses earn full points and distance reduces the score", () => {
  assert.equal(scoreGuess(103, 103).score, 1000);
  assert.equal(scoreGuess(105, 103).score, 1000);
  assert.ok(scoreGuess(110, 103).score < 1000);
  assert.ok(scoreGuess(110, 103).score > scoreGuess(120, 103).score);
  assert.equal(scoreGuess(null, 103).score, 0);
});
test("half and double time are valid, including fractional pulses", () => {
  assert.equal(scoreGuess(86, 171).score, 1000);
  assert.equal(scoreGuess(86, 171).matchedBpm, 85.5);
  assert.equal(scoreGuess(192, 96).score, 1000);
  assert.equal(scoreGuess(103, 103).matchedBpm, 103);
});
test("score stays bounded for every valid guess", () => {
  for (const bpm of [90, 95, 96, 97, 103, 110, 115, 124, 125, 135, 150, 170, 171, 174]) {
    for (let guess = 40; guess <= 220; guess++) { const { score } = scoreGuess(guess, bpm); assert.ok(Number.isInteger(score) && score >= 0 && score <= 1000); }
  }
});
test("daily selection is stable, varies by seed, and avoids repeated artists", () => {
  const tracks = Array.from({ length: 30 }, (_, i) => ({ id: i, artist: `Artist ${Math.floor(i / 2)}` }));
  const first = selectTracks(tracks, "2026-10-30");
  assert.deepEqual(first, selectTracks(tracks, "2026-10-30"));
  assert.notDeepEqual(first, selectTracks(tracks, "2026-10-31"));
  assert.equal(first.length, 5);
  assert.equal(new Set(first.map(t => t.artist)).size, 5);
  assert.equal(tracks[0].id, 0);
});
test("daily identity changes at midnight IST everywhere, not at UTC midnight", () => {
  assert.equal(dailyDate(new Date("2026-11-09T18:29:59.999Z")), "2026-11-09");
  assert.equal(dailyDate(new Date("2026-11-09T18:30:00.000Z")), "2026-11-10");
  assert.equal(dailyDate(new Date("2026-11-10T00:00:00+05:30")), "2026-11-10");
  assert.equal(dailyDate(new Date("2026-11-09T10:30:00-08:00")), "2026-11-10");
  assert.equal(dailyDate(new Date("2026-11-10T00:00:00Z")), "2026-11-10");
  assert.equal(puzzleNumber("2026-10-30"), 1);
  assert.equal(puzzleNumber("2026-10-31"), 2);
});

test("daily reset and previous-date arithmetic cross months, years, and leap days", () => {
  assert.equal(nextDailyReset(new Date("2026-11-09T18:29:59Z")), Date.parse("2026-11-09T18:30:00Z"));
  assert.equal(nextDailyReset(new Date("2026-11-09T18:30:00Z")), Date.parse("2026-11-10T18:30:00Z"));
  for (const [instant, date, previous] of [
    ["2026-10-31T18:30:00Z", "2026-11-01", "2026-10-31"],
    ["2026-12-31T18:30:00Z", "2027-01-01", "2026-12-31"],
    ["2028-02-29T18:30:00Z", "2028-03-01", "2028-02-29"],
  ]) {
    assert.equal(dailyDate(new Date(instant)), date);
    assert.equal(previousDailyDate(date), previous);
  }
});

test("rollover refreshes untouched/completed mixes but preserves active timers and partial progress", () => {
  const puzzle = { mode: "daily", date: "2026-11-09" };
  const ready = { phase: "ready", round: 0, results: [] };
  assert.equal(shouldRefreshDaily(puzzle, ready, "2026-11-10"), true);
  assert.equal(shouldRefreshDaily(puzzle, { phase: "complete", round: 4, results: [1, 2, 3, 4, 5] }, "2026-11-10"), true);
  assert.equal(shouldRefreshDaily(puzzle, { phase: "complete", round: 4, results: [1, 2, 3, 4, 5] }, "2026-11-10", true), false);
  for (const phase of ["loading", "listening", "guessing", "submitting", "reveal"]) {
    assert.equal(shouldRefreshDaily(puzzle, { ...ready, phase }, "2026-11-10"), false);
  }
  assert.equal(shouldRefreshDaily(puzzle, { phase: "ready", round: 1, results: [1] }, "2026-11-10"), false);
  assert.equal(shouldRefreshDaily(puzzle, ready, puzzle.date), false);
  assert.equal(shouldRefreshDaily({ ...puzzle, mode: "practice" }, ready, "2026-11-10"), false);
});
