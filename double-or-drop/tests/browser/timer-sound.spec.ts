import { test, expect as baseExpect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Catalog } from "../../src/lib/catalog-types";
import type { PublicGame, Side } from "../../src/lib/types";

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 120_000 });

const gameState = async (request: APIRequestContext): Promise<PublicGame> => (await (await request.get("/api/game")).json()).game;
function correctSide(game: PublicGame): Side {
  const catalog = JSON.parse(readFileSync(resolve(`data/catalog-releases/${game.catalogVersion}.json`), "utf8")) as Catalog;
  const left = catalog.tracks.find(track => track.id === game.pair.left.id)!.metrics[game.pair.metric]!.value;
  const right = catalog.tracks.find(track => track.id === game.pair.right.id)!.metrics[game.pair.metric]!.value;
  return (game.pair.metric === "year" ? left < right : left > right) ? "left" : "right";
}
async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Runtime", exact: false }).click();
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".pick-clock")).toBeVisible();
  return gameState(page.request);
}
async function pick(page: Page, game: PublicGame, correct = true) {
  const winner = correctSide(game), side = correct ? winner : winner === "left" ? "right" : "left";
  await page.keyboard.press(side === "left" ? "1" : "2");
  await expect(page.locator(".decision-panel")).toBeVisible({ timeout: 15_000 });
  return gameState(page.request);
}

test("twenty-second picks survive home and reload; urgent timeout loses one life and protects the bank", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let game = await start(page);
  expect(game.guessDeadline! - game.createdAt).toBe(20_000);
  await expect(page.locator(".pick-clock strong")).toHaveText(/^(?:1[0-9]|20)$/);
  game = await pick(page, game);
  await page.getByRole("button", { name: "Bank & keep playing" }).click();
  await expect(page.locator(".pick-clock")).toBeVisible();
  game = await gameState(page.request); expect(game.banked).toBe(100);
  game = await pick(page, game);
  await page.getByRole("button", { name: "Risk for 200" }).click();
  await expect(page.locator(".pick-clock")).toBeVisible();
  game = await gameState(page.request);
  const deadline = game.guessDeadline!;
  expect(game.pot).toBe(100); expect(game.banked).toBe(100);
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume run" })).toBeVisible();
  expect((await gameState(page.request)).guessDeadline).toBe(deadline);
  await page.getByRole("button", { name: "Resume run" }).click();
  await page.reload();
  await expect(page.locator(".pick-clock")).toBeVisible();
  expect((await gameState(page.request)).guessDeadline).toBe(deadline);
  await expect(page.locator(".pick-clock")).toHaveClass(/urgent/, { timeout: 22_000 });
  const seconds = Number(await page.locator(".pick-clock strong").textContent());
  expect(seconds).toBeGreaterThan(0); expect(seconds).toBeLessThanOrEqual(5);
  await expect(page.locator(".pick-clock")).toHaveCSS("animation-name", "pick-urgency");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".pick-clock")).toHaveCSS("animation-name", "none");
  // Reduced motion retains the high-contrast warning without the shaking animation.
  await expect(page.locator(".pick-clock")).toHaveCSS("border-top-color", "rgb(255, 155, 132)");
  await expect(page.getByText("2 lives left. Keep your groove.")).toBeVisible({ timeout: 10_000 });
  const expired = await gameState(page.request);
  expect(expired.reveal?.timedOut).toBe(true); expect(expired.reveal?.selected).toBeNull();
  expect(expired.lives).toBe(2); expect(expired.banked).toBe(100); expect(expired.pot).toBe(0);
  expect(expired.answered).toBe(3); expect(expired.guessDeadline).toBeNull();
  const replay = await page.request.post("/api/game", { data: { action: "guess", gameId: game.id, round: game.round, revision: game.revision, choice: correctSide(game) } });
  expect(replay.ok()).toBe(true); expect((await replay.json()).game.revision).toBe(expired.revision);
  await page.reload(); await expect(page.getByText("2 lives left. Keep your groove.")).toBeVisible();
  expect((await gameState(page.request)).lives).toBe(2);
  expect(errors).toEqual([]);
});

interface AudioProbe { contexts: number; frequencies: number[]; started: number; active: number }
async function instrumentAudio(page: Page) {
  await page.addInitScript(() => {
    // Observe real Web Audio objects; do not replace playback with fake nodes.
    const probe = { contexts: 0, frequencies: [] as number[], started: 0, active: 0 };
    (window as typeof window & { __audioProbe: typeof probe }).__audioProbe = probe;
    const NativeContext = window.AudioContext;
    const observe = <T extends OscillatorNode | AudioBufferSourceNode>(voice: T): T => {
      let started = false;
      voice.addEventListener("ended", () => { if (started) { probe.active--; started = false; } });
      const nativeStart = voice.start.bind(voice);
      voice.start = ((...args: [number?]) => { probe.started++; probe.active++; started = true; nativeStart(...args); }) as typeof voice.start;
      return voice;
    };
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) { super(options); probe.contexts++; }
      createOscillator() {
        const voice = observe(super.createOscillator());
        const set = voice.frequency.setValueAtTime.bind(voice.frequency);
        voice.frequency.setValueAtTime = (value: number, time: number) => { probe.frequencies.push(value); return set(value, time); };
        return voice;
      }
      createBufferSource() { return observe(super.createBufferSource()); }
    };
  });
}
const audio = (page: Page) => page.evaluate(() => ({ ...(window as typeof window & { __audioProbe: AudioProbe }).__audioProbe }));
const resetNotes = (page: Page) => page.evaluate(() => { (window as typeof window & { __audioProbe: AudioProbe }).__audioProbe.frequencies = []; });
async function expectNotes(page: Page, frequencies: number[]) {
  await expect.poll(async () => (await audio(page)).frequencies).toEqual(expect.arrayContaining(frequencies));
}

test("sound waits for interaction, action tones differ, home and hidden tabs stop music, and mute survives reload", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await instrumentAudio(page);
  await page.goto("/"); await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled({ timeout: 30_000 });
  expect((await audio(page)).contexts).toBe(0); expect((await audio(page)).started).toBe(0);
  await page.getByRole("button", { name: "Runtime", exact: false }).click();
  await expect.poll(async () => (await audio(page)).contexts).toBe(1);
  await expectNotes(page, [660, 880]);
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".pick-clock")).toBeVisible();
  let game = await gameState(page.request);
  await resetNotes(page); game = await pick(page, game);
  await expectNotes(page, [523, 659, 784, 1047, 1568]);
  await resetNotes(page); await page.getByRole("button", { name: "Bank & keep playing" }).click();
  await expect(page.locator(".pick-clock")).toBeVisible();
  await expectNotes(page, [1319, 1760, 2093]);
  game = await gameState(page.request); await resetNotes(page); game = await pick(page, game, false);
  await expectNotes(page, [330, 147]);
  expect(game.lives).toBe(2);
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume run" })).toBeVisible();
  await expect.poll(async () => (await audio(page)).active).toBe(0);
  const stopped = (await audio(page)).started;
  await page.waitForTimeout(400); expect((await audio(page)).started).toBe(stopped);
  await page.getByRole("button", { name: "Resume run" }).click();
  await expect.poll(async () => (await audio(page)).started).toBeGreaterThan(stopped);
  // Feed the same visibility event browsers send, keeping real AudioContext scheduling observable.
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(async () => (await audio(page)).active).toBe(0);
  const hidden = (await audio(page)).started;
  await page.waitForTimeout(400); expect((await audio(page)).started).toBe(hidden);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(async () => (await audio(page)).started).toBeGreaterThan(hidden);
  await page.getByRole("button", { name: "Mute game sounds", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable game sounds", exact: true })).toBeVisible();
  await expect.poll(async () => (await audio(page)).active).toBe(0);
  await page.reload(); await expect(page.getByRole("button", { name: "Enable game sounds", exact: true })).toBeVisible();
  expect((await audio(page)).contexts).toBe(0);
  await page.getByRole("button", { name: "Double or Drop home", exact: true }).click();
  expect((await audio(page)).contexts).toBe(0); expect((await audio(page)).started).toBe(0);
  expect(errors).toEqual([]);
});
