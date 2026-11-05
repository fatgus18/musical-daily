import { test, expect, type Page } from "@playwright/test";
import type { PublicGame } from "../../../artist-encore/src/lib/types";

async function observeSounds(page: Page) {
  await page.route("**/api/account/session", route => route.fulfill({ json: { user: null, configured: true } }));
  await page.addInitScript(() => {
    const state = window as unknown as { scheduledNotes: number[] };
    state.scheduledNotes = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const node = create.call(this);
      const schedule = node.frequency.setValueAtTime.bind(node.frequency);
      node.frequency.setValueAtTime = (value, at) => { state.scheduledNotes.push(value); return schedule(value, at); };
      return node;
    };
  });
}
async function notes(page: Page) { return page.evaluate(() => (window as unknown as { scheduledNotes: number[] }).scheduledNotes); }
async function clearNotes(page: Page) { await page.evaluate(() => { (window as unknown as { scheduledNotes: number[] }).scheduledNotes = []; }); }

test("Blackjack confirms safe picks and banking with distinct cues, without replaying on reload", async ({ page }) => {
  await observeSounds(page);
  await page.route("**/api/daily?**", route => route.fulfill({ json: { date: new URL(route.request().url()).searchParams.get("date"), rulesVersion: "v3-exact", catalogVersion: "sound-fixture", seedKey: "sound-fixture", puzzleNumber: 1, targetStreams: 2000, tracks: Array.from({ length: 9 }, (_, index) => ({ id: `sound-${index}`, title: ["Take Me to Church", "Someone New", "Work Song"][index % 3], artist: "Hozier", releaseYear: 2014 })) } }));
  await page.route("**/api/reveal", route => route.fulfill({ json: { streams: 1000 } }));
  await page.route("**/api/finish", route => route.fulfill({ json: { rank: "GOLD RECORD", finalSum: 1000, targetStreams: 2000, optimalSum: 2000, optimalHandIds: [], allStreams: {} } }));
  await page.goto("http://localhost:3000/");
  const pick = page.getByRole("button", { name: /reveal stream count/ }).first();
  await expect(pick).toBeVisible();
  expect(await notes(page)).toEqual([]);
  await pick.click();
  await expect.poll(() => notes(page)).toContain(523);
  await clearNotes(page);
  await page.getByRole("button", { name: "STAND & LOCK IN", exact: true }).click();
  await expect.poll(() => notes(page)).toContain(1319);
  await page.reload();
  await expect(page.getByText("You locked in", { exact: false })).toBeVisible();
  expect(await notes(page)).toEqual([]);
});

test("Tempo scores a fresh submission with a cue but restored results stay quiet", async ({ page }) => {
  await observeSounds(page);
  await page.route("**/api/daily?**", route => route.fulfill({ json: { date: new Date().toISOString().slice(0, 10), number: 1, mode: "daily", seed: "sound-fixture", version: "sound-fixture", token: "sound-fixture", tracks: Array.from({ length: 5 }, (_, index) => ({ id: `sound-${index}`, title: "Take Me to Church", artist: "Hozier", album: "Hozier", year: 2014, artworkUrl: "/brand/musical-daily.svg", previewUrl: "https://example.invalid/audio.m4a", spotifyUrl: "https://open.spotify.com/", appleMusicUrl: "https://music.apple.com/", clipStartSeconds: 7, clipSeconds: 15 })) } }));
  await page.route("https://example.invalid/**", route => route.abort());
  await page.goto("http://localhost:3002/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("tempo:daily:"))!;
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.progress.phase = "guessing"; saved.progress.deadline = Date.now() + 15000;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toBeVisible();
  expect(await notes(page)).toEqual([]);
  await page.getByLabel("YOUR GUESS", { exact: true }).fill("120");
  await page.route("**/api/guess", route => route.fulfill({ json: { token: route.request().postDataJSON().token, result: { round: 0, trackId: "test-sound", guess: 120, bpm: 120, matchedBpm: 120, difference: 0, score: 1000, label: "Right on the beat." }, results: [{ round: 0, trackId: "test-sound", guess: 120, bpm: 120, matchedBpm: 120, difference: 0, score: 1000, label: "Right on the beat." }] } }));
  await page.getByRole("button", { name: "Lock in my guess" }).click();
  await expect(page.getByText("Right on the beat.", { exact: true })).toBeVisible();
  await expect.poll(() => notes(page)).toContain(523);
  await page.reload();
  await expect(page.getByText("Right on the beat.", { exact: true })).toBeVisible();
  expect(await notes(page)).toEqual([]);
});

test("Encore plays correct, wrong and completion cues only for newly confirmed actions", async ({ page }) => {
  await observeSounds(page);
  const now = Date.now();
  let game: PublicGame = {
    id: "sound-fixture", artist: { id: "artist-fixture", name: "Hozier", image: "", imageSourceUrl: "https://music.apple.com/us/artist/hozier/342260741", url: "https://music.apple.com/us/artist/hozier/342260741" },
    ranking: { kind: "streams", label: "Test fixture", sourceUrl: "https://example.invalid", asOf: "2026-11-03" },
    round: 0, phase: "guessing", results: [], correct: 0, tier: "hit", listenAt: now - 10000, guessDeadline: now + 15000, serverNow: now,
    choices: [{ id: "right", label: "Take Me to Church" }, { id: "wrong", label: "Someone New" }, { id: "other", label: "Work Song" }, { id: "fourth", label: "Cherry Wine" }],
    clipOffset: 7, clipSeconds: 10,
  };
  await page.route("**/api/game", route => {
    const action = route.request().method() === "POST" ? route.request().postDataJSON().action : null;
    if (action === "answer") {
      const correct = route.request().postDataJSON().choiceId === "right";
      game = { ...game, phase: "reveal", correct: game.correct + Number(correct), results: [...game.results, { round: game.round, title: "Take Me to Church", artist: "Hozier", artwork: "", url: "https://music.apple.com/", tier: "hit", input: correct ? "Take Me to Church" : "Someone New", correct, skipped: false }] };
    }
    if (action === "next") game = game.round === 9 ? { ...game, phase: "complete" } : { ...game, round: 9, phase: "guessing", guessDeadline: Date.now() + 15000, serverNow: Date.now() };
    return route.fulfill({ json: { game: { ...game, serverNow: Date.now() }, audioEnabled: true } });
  });
  await page.goto("http://localhost:3004/");
  await expect(page.getByRole("button", { name: "Take Me to Church", exact: true })).toBeVisible();
  expect(await notes(page)).toEqual([]);
  await page.getByRole("button", { name: "Take Me to Church", exact: true }).click();
  await expect.poll(() => notes(page)).toContain(523);
  await page.reload();
  await expect(page.locator(".answer-verdict")).toContainText("THAT'S THE ONE");
  expect(await notes(page)).toEqual([]);
  await page.getByRole("button", { name: "Next song", exact: true }).click();
  await clearNotes(page);
  await page.getByRole("button", { name: "Someone New", exact: true }).click();
  await expect.poll(() => notes(page)).toContain(330);
  await clearNotes(page);
  await page.getByRole("button", { name: "See my fan status", exact: true }).click();
  await expect.poll(() => notes(page)).toContain(523);
  await page.reload();
  await expect(page.locator(".completed")).toBeVisible();
  expect(await notes(page)).toEqual([]);
});
