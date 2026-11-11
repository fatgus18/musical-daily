import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareScore } from "../src/lib/share-score";

const daily = {
  mode: "daily" as const,
  puzzleNumber: 42,
  finalSum: 7_000_000_000,
  targetStreams: 7_000_000_000,
  rank: "BLACKJACK" as const,
  picks: 5,
  shieldAvailable: true,
  streak: 1,
  origin: "https://musical-daily.vercel.app",
  gamePath: "/blackjack/",
};

test("daily share includes a plain public game link and no positional board", () => {
  const share = buildShareScore(daily);
  assert.equal(share, [
    "🎧 Stream Blackjack — Day #42",
    "🎯 7.00B / 7.00B (100.0%) — BLACKJACK",
    "🎵 Picks: 5 · 🛡️ Shield: unused",
    "🔥 Streak: 1",
    "",
    "Can you beat my score?",
    "https://musical-daily.vercel.app/blackjack/",
  ].join("\n"));
  assert.doesNotMatch(share, /🟩|⬛|⭐|optimal|Best hand/);
});

test("different selected or optimal song positions cannot change a shared score", () => {
  const firstHand = { ...daily, pickedIds: ["song-a", "song-b"], optimalHandIds: ["song-c"], tracks: [{ id: "song-a", title: "Spoiler title" }] };
  const otherHand = { ...daily, pickedIds: ["song-c", "song-d"], optimalHandIds: ["song-a"], tracks: [{ id: "song-b", title: "Another spoiler" }] };
  assert.equal(buildShareScore(firstHand), buildShareScore(otherHand));
  assert.doesNotMatch(buildShareScore(firstHand), /song-|Spoiler|spoiler/);
});

test("share links use the deployed service prefix, standalone root, or a new custom domain", () => {
  for (const [origin, gamePath, link] of [
    ["https://musicaldaily.game", "/blackjack/", "https://musicaldaily.game/blackjack/"],
    ["https://blackjack.example", "/", "https://blackjack.example/"],
    ["http://localhost:3000", "/", "http://localhost:3000/"],
    ["http://localhost:3100/blackjack/?session=private#result", "/blackjack/", "http://localhost:3100/blackjack/"],
  ]) {
    const share = buildShareScore({ ...daily, origin, gamePath });
    assert.equal(share.split("\n").at(-1), link);
    assert.doesNotMatch(share, /session=|#result/);
  }
});

test("practice share labels its mode and does not claim a daily streak or replayable seed", () => {
  const share = buildShareScore({ ...daily, mode: "practice", shieldAvailable: false, picks: 6 });
  assert.match(share, /Stream Blackjack \(Practice\)/);
  assert.match(share, /Picks: 6 · 🛡️ Shield: used/);
  assert.match(share, /Try your own mix:\nhttps:\/\/musical-daily\.vercel\.app\/blackjack\/$/);
  assert.doesNotMatch(share, /Streak|Day #|seed|\?/);
});

test("a busted score retains its rank and shield outcome without disclosing the losing card", () => {
  const share = buildShareScore({ ...daily, finalSum: 7_700_000_000, rank: "BUST", shieldAvailable: false });
  assert.match(share, /7\.70B \/ 7\.00B \(110\.0%\) — BUST/);
  assert.match(share, /Shield: used/);
});
