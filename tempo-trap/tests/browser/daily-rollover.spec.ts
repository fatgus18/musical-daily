import { test, expect, type Page } from "@playwright/test";
import { dailyDate, puzzleNumber } from "../../src/lib/game";
import type { Puzzle, SavedGame } from "../../src/lib/types";

test.use({ timezoneId: "America/Los_Angeles" });

const BEFORE_MIDNIGHT = Date.parse("2026-11-09T18:29:55Z");
const PREVIOUS_DATE = "2026-11-09";
const NEXT_DATE = "2026-11-10";

// Only the response clock/date is controlled here. The actual route is checked
// separately below; these tests exercise real client state and persisted timers.
async function controlledMidnight(page: Page, puzzle: Puzzle) {
  // Compile the dev account endpoint before freezing browser timers; on a cold
  // dev server this is unrelated to the rollover behavior under test.
  await page.request.get("/api/account/session");
  await page.clock.install({ time: BEFORE_MIDNIGHT - 3600000 });
  await page.clock.pauseAt(BEFORE_MIDNIGHT);
  await page.route("**/api/daily?mode=daily", async route => {
    const now = await page.evaluate(() => Date.now());
    const date = dailyDate(new Date(now));
    await route.fulfill({ json: { ...puzzle, date, number: puzzleNumber(date), serverNow: now } });
  });
}

async function hydratePausedPage(page: Page) {
  // AccountProvider deliberately defers its first request to an animation frame.
  // Advance only those startup frames, keeping the game clock before midnight.
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.locator(".round-toolbar").count();
  }, { timeout: 20000 }).toBe(1);
}

test("daily API reports the IST day and server clock with no cache", async ({ request }) => {
  const response = await request.get("/api/daily");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toContain("no-store");
  const puzzle = await response.json() as Puzzle;
  expect(puzzle.serverNow).toBeGreaterThan(0);
  expect(puzzle.date).toBe(dailyDate(new Date(puzzle.serverNow!)));
  expect(puzzle.number).toBe(puzzleNumber(puzzle.date));
});

test("midnight IST refreshes an untouched daily in an open tab outside India", async ({ page, request }) => {
  const puzzle = await (await request.get("/api/daily")).json() as Puzzle;
  await controlledMidnight(page, puzzle);
  await page.goto("/");
  await hydratePausedPage(page);
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await expect(page.locator(".edition-label")).toHaveText(`DAILY MIX #${String(puzzleNumber(PREVIOUS_DATE)).padStart(3, "0")}`);
  await page.clock.runFor(6000);
  await expect(page.locator(".edition-label")).toHaveText(`DAILY MIX #${String(puzzleNumber(NEXT_DATE)).padStart(3, "0")}`);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain(`tempo:daily:${PREVIOUS_DATE}`);
  expect(keys).toContain(`tempo:daily:${NEXT_DATE}`);
});

test("midnight IST preserves an active guess and offers the new mix after the reveal", async ({ page, request }) => {
  const puzzle = await (await request.get("/api/daily")).json() as Puzzle;
  await controlledMidnight(page, puzzle);
  const deadline = BEFORE_MIDNIGHT + 15000;
  const saved: SavedGame = { puzzle: { ...puzzle, date: PREVIOUS_DATE, number: puzzleNumber(PREVIOUS_DATE) },
    progress: { round: 0, phase: "guessing", guess: "100", deadline, results: [], token: puzzle.token } };
  await page.addInitScript(value => localStorage.setItem(`tempo:daily:${value.puzzle.date}`, JSON.stringify(value)), saved);
  await page.goto("/");
  await hydratePausedPage(page);
  await expect(page.getByRole("timer")).toContainText("15 SECONDS LEFT");
  await page.clock.runFor(6000);
  await expect(page.locator(".daily-refresh-notice")).toContainText("A new daily mix is ready");
  await expect(page.getByRole("button", { name: "Finish this round to switch" })).toBeDisabled();
  await expect(page.getByRole("timer")).toContainText("9 SECONDS LEFT");
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveValue("100");
  expect(await page.evaluate(date => JSON.parse(localStorage.getItem(`tempo:daily:${date}`)!).progress.deadline, PREVIOUS_DATE)).toBe(deadline);

  await page.route("**/api/guess", route => route.fulfill({ json: {
    result: { round: 0, trackId: puzzle.tracks[0].id, guess: 100, bpm: 100, matchedBpm: 100, difference: 0, score: 1000, label: "Right on the beat." },
    results: [{ round: 0, trackId: puzzle.tracks[0].id, guess: 100, bpm: 100, matchedBpm: 100, difference: 0, score: 1000, label: "Right on the beat." }], token: puzzle.token,
  } }));
  await page.getByRole("button", { name: "Lock in my guess" }).click();
  await expect(page.getByRole("heading", { name: "Right on the beat." })).toBeVisible();
  await page.getByRole("button", { name: "Play today’s mix" }).click();
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  const previous = await page.evaluate(date => JSON.parse(localStorage.getItem(`tempo:daily:${date}`)!), PREVIOUS_DATE) as SavedGame;
  expect(previous.progress.results).toHaveLength(1);
  expect(previous.progress.results[0].score).toBe(1000);
  expect(previous.progress.phase).toBe("reveal");
});

test("a sleeping completed tab refreshes on focus without deleting its finished score", async ({ page, request }) => {
  const puzzle = await (await request.get("/api/daily")).json() as Puzzle;
  await controlledMidnight(page, puzzle);
  const results = puzzle.tracks.map((track, round) => ({ round, trackId: track.id, guess: 100, bpm: 100, matchedBpm: 100, difference: 0, score: 1000, label: "Right on the beat." }));
  const saved: SavedGame = { puzzle: { ...puzzle, date: PREVIOUS_DATE, number: puzzleNumber(PREVIOUS_DATE) },
    progress: { round: 4, phase: "complete", guess: "", deadline: null, results, token: puzzle.token } };
  await page.addInitScript(value => localStorage.setItem(`tempo:daily:${value.puzzle.date}`, JSON.stringify(value)), saved);
  await page.goto("/");
  await hydratePausedPage(page);
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
  await expect(page.locator(".next-mix-label")).toContainText("00:00:05");
  // setSystemTime does not run interval callbacks, mirroring a suspended tab.
  await page.clock.setSystemTime(BEFORE_MIDNIGHT + 6000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  expect(await page.evaluate(date => JSON.parse(localStorage.getItem(`tempo:daily:${date}`)!).progress.results.length, PREVIOUS_DATE)).toBe(5);
});

test("finishing a mix after midnight keeps its result and share button until the player switches", async ({ page, request }) => {
  const puzzle = await (await request.get("/api/daily")).json() as Puzzle;
  await controlledMidnight(page, puzzle);
  const results = puzzle.tracks.map((track, round) => ({ round, trackId: track.id, guess: 100, bpm: 100, matchedBpm: 100, difference: 0, score: 1000, label: "Right on the beat." }));
  const saved: SavedGame = { puzzle: { ...puzzle, date: PREVIOUS_DATE, number: puzzleNumber(PREVIOUS_DATE) },
    progress: { round: 4, phase: "guessing", guess: "100", deadline: BEFORE_MIDNIGHT + 15000, results: results.slice(0, 4), token: puzzle.token } };
  await page.addInitScript(value => localStorage.setItem(`tempo:daily:${value.puzzle.date}`, JSON.stringify(value)), saved);
  await page.goto("/");
  await hydratePausedPage(page);
  await expect(page.getByRole("timer")).toContainText("15 SECONDS LEFT");
  await page.clock.runFor(6000);
  await page.route("**/api/guess", route => route.fulfill({ json: { result: results[4], results, token: puzzle.token } }));
  await page.getByRole("button", { name: "Lock in my guess" }).click();
  await expect(page.getByRole("heading", { name: "Right on the beat." })).toBeVisible();
  await page.getByRole("button", { name: "See my results" }).click();
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
  await page.clock.runFor(3000);
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share your score" })).toBeVisible();
  await expect(page.locator(".edition-label")).toHaveText(`DAILY MIX #${String(puzzleNumber(PREVIOUS_DATE)).padStart(3, "0")}`);
  await page.getByRole("button", { name: "Play today’s mix" }).click();
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await expect(page.locator(".edition-label")).toHaveText(`DAILY MIX #${String(puzzleNumber(NEXT_DATE)).padStart(3, "0")}`);
  expect(await page.evaluate(date => JSON.parse(localStorage.getItem(`tempo:daily:${date}`)!).progress.phase, PREVIOUS_DATE)).toBe("complete");
});
