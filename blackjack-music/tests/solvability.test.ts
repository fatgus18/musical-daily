import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateDailyPuzzle, evaluateRank, type DailyPuzzleData } from "../src/lib/puzzle";

const releases = JSON.parse(readFileSync("data/catalog-releases.json", "utf8")).releases as { version: string }[];

// Independent enumeration: do not trust the generator's claimed optimal hand.
function exactHands(board: DailyPuzzleData): number[][] {
  const found: number[][] = [];
  function visit(indices: number[], next: number, total: number) {
    if (indices.length >= 3 && total === board.targetStreams) found.push(indices);
    if (indices.length === 5) return;
    for (let i = next; i < board.tracks.length; i++) visit([...indices, i], i + 1, total + board.tracks[i].streams);
  }
  visit([], 0, 0);
  return found;
}

function assertReachable(board: DailyPuzzleData) {
  const hands = exactHands(board);
  assert.ok(hands.length > 0, `Missing exact hand: ${board.date}/${board.seedKey}/${board.catalogVersion}`);
  assert.equal(board.optimalSum, board.targetStreams);
  assert.ok(board.optimalHandIds.length >= 3 && board.optimalHandIds.length <= 5);
  assert.equal(board.tracks.filter(t => board.optimalHandIds.includes(t.id)).reduce((n, t) => n + t.streams, 0), board.targetStreams);
  assert.equal(evaluateRank(board.targetStreams, board.targetStreams), "BLACKJACK");
  assert.equal(board.tracks.filter(t => t.streams >= 1_800_000_000).length, 2);
  assert.equal(board.tracks.filter(t => t.streams >= 850_000_000 && t.streams < 1_800_000_000).length, 4);
  assert.equal(board.tracks.filter(t => t.streams < 850_000_000).length, 3);
  // Every prefix is safe: a player can actually reach the witness without a shield.
  let sum = 0;
  for (const index of hands[0]) { sum += board.tracks[index].streams; assert.ok(sum <= board.targetStreams); }
  assert.equal(sum, board.targetStreams);
}

test("every published pool has exact-cap hands across a full four-year date cycle", () => {
  for (const release of releases) {
    for (let day = 0; day < 1461; day++) {
      const date = new Date(Date.UTC(2026, 10, 1) + day * 86_400_000).toISOString().slice(0, 10);
      assertReachable(generateDailyPuzzle(date, undefined, release.version));
    }
  }
});

test("practice seeds are exact, deterministic, and use unchanged observed counts", () => {
  for (const release of releases) {
    const catalog = JSON.parse(readFileSync(`data/catalog-releases/${release.version}.json`, "utf8"));
    const original = new Map<string, number>(catalog.tracks.map((t: { id: string; streams: number }) => [t.id, t.streams]));
    for (let index = 0; index < 100; index++) {
      const board = generateDailyPuzzle("2026-11-01", `practice-${index}`, release.version);
      assertReachable(board);
      assert.deepEqual(board, generateDailyPuzzle("2026-11-01", `practice-${index}`, release.version));
      for (const track of board.tracks) assert.equal(track.streams, original.get(track.id));
    }
  }
});

test("saved legacy rules keep the same board and clean target while exact rules upgrade only the cap", () => {
  const old = generateDailyPuzzle("2026-10-30", undefined, releases[0].version, "v2");
  const current = generateDailyPuzzle("2026-10-30", undefined, releases[0].version, "v3-exact");
  assert.deepEqual(old.tracks, current.tracks);
  assert.equal(old.targetStreams % 250_000_000, 0);
  assert.equal(old.rulesVersion, "v2");
  assert.equal(current.rulesVersion, "v3-exact");
  assert.deepEqual(old, generateDailyPuzzle("2026-10-30", undefined, releases[0].version, "v2"));
});

test("invalid date, seed, catalog and unknown rule versions fail closed", () => {
  for (const date of ["2026-02-30", "2026-1-01", "not-a-date", "2026-11-01junk"]) assert.throws(() => generateDailyPuzzle(date));
  assert.throws(() => generateDailyPuzzle("2026-11-01", "x".repeat(129)));
  assert.throws(() => generateDailyPuzzle("2026-11-01", undefined, "../../secrets"));
  // @ts-expect-error exercise untrusted runtime input
  assert.throws(() => generateDailyPuzzle("2026-11-01", undefined, undefined, "other"));
});
