import { test } from "node:test";
import assert from "node:assert/strict";
import { isGuess, scoreGuess, selectTracks, utcDate, puzzleNumber } from "../src/lib/game.ts";

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
test("daily identity uses UTC across time zones", () => {
  assert.equal(utcDate(new Date("2026-10-31T01:00:00+05:30")), "2026-10-30");
  assert.equal(puzzleNumber("2026-10-30"), 1);
  assert.equal(puzzleNumber("2026-10-31"), 2);
});
