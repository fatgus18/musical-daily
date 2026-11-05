import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";

const studio = "http://localhost:3001/rhythm-lab";
type ObservedNote = { frequency: number; at: number; stopAt: number; ended: boolean; context: number };
type StudioProbe = {
  notes: ObservedNote[];
  contexts: AudioContext[];
  createdUrls: string[];
  revokedUrls: string[];
  microphoneRequests: number;
};

/** Observe native audio and Blob lifecycles without replacing synthesis, capture, or playback. */
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const scope = window as unknown as { studioProbe: StudioProbe };
    const probe: StudioProbe = { notes: [], contexts: [], createdUrls: [], revokedUrls: [], microphoneRequests: 0 };
    scope.studioProbe = probe;
    const createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = createOscillator.call(this);
      if (!probe.contexts.includes(this)) probe.contexts.push(this);
      let frequency = oscillator.frequency.value;
      const setFrequency = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
      oscillator.frequency.setValueAtTime = (value, at) => { frequency = value; return setFrequency(value, at); };
      const note: ObservedNote = { frequency, at: Infinity, stopAt: Infinity, ended: false, context: probe.contexts.indexOf(this) };
      const start = oscillator.start.bind(oscillator), stop = oscillator.stop.bind(oscillator);
      oscillator.start = (at = 0) => { note.frequency = frequency; note.at = at; probe.notes.push(note); start(at); };
      oscillator.stop = (at = 0) => { note.stopAt = at; stop(at); };
      oscillator.addEventListener("ended", () => { note.ended = true; });
      return oscillator;
    };
    const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => { const url = createUrl(object); probe.createdUrls.push(url); return url; };
    URL.revokeObjectURL = url => { probe.revokedUrls.push(url); revokeUrl(url); };
    if (navigator.mediaDevices?.getUserMedia) {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = constraints => { probe.microphoneRequests++; return getUserMedia(constraints); };
    }
  });
}

async function notes(page: Page, frequency: number, activeOnly = false) {
  return page.evaluate(({ frequency, activeOnly }) => {
    const probe = (window as unknown as { studioProbe: StudioProbe }).studioProbe;
    return probe.notes.filter(note => Math.abs(note.frequency - frequency) < 0.01 && (!activeOnly || (!note.ended && note.stopAt > probe.contexts[note.context].currentTime))).map(note => ({ ...note }));
  }, { frequency, activeOnly });
}

async function setRange(input: Locator, value: number) {
  await input.evaluate((element, next) => {
    const range = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, String(next));
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(String(value));
}

async function openStudio(page: Page) {
  await installProbe(page);
  await page.goto(studio);
  await expect(page.locator(".studio-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "C4 key", exact: true })).toBeEnabled();
}

test("real keyboard, mouse and drum audio becomes a playable WAV and New recording discards it", async ({ page }) => {
  const errors: string[] = [], posts: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")) posts.push(request.url()); });
  await openStudio(page);
  await page.getByRole("button", { name: "Analog synth", exact: true }).click();
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled({ timeout: 15000 });
  await page.locator(".studio-intro h1").click();
  await page.keyboard.down("a");
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "C4 key", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(400);
  const key = page.getByRole("button", { name: "E4 key", exact: true });
  await key.scrollIntoViewIfNeeded();
  const box = (await key.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8);
  await page.mouse.down();
  await expect(key).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.keyboard.up("a");
  await page.getByRole("button", { name: "Play Kick", exact: true }).click();
  await page.waitForTimeout(550);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  const downloadLink = page.getByRole("link", { name: "Download WAV", exact: true });
  await expect(downloadLink).toBeVisible({ timeout: 15000 });
  const takeUrl = await downloadLink.getAttribute("href");
  expect(takeUrl).toMatch(/^blob:/);

  const downloadEvent = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.wav$/);
  const filename = await download.path();
  expect(filename).not.toBeNull();
  const bytes = await readFile(filename!);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt16LE(34)).toBe(16);
  const rate = bytes.readUInt32LE(24), frames = bytes.readUInt32LE(40) / 2;
  expect(rate).toBeGreaterThanOrEqual(8000);
  expect(rate).toBeLessThanOrEqual(384000);
  expect(bytes.length).toBe(44 + frames * 2);
  expect(frames / rate).toBeGreaterThan(0.8);
  expect(frames / rate).toBeLessThan(20);
  let nonzero = 0, peak = 0;
  for (let offset = 44; offset < bytes.length; offset += 2) { const sample = Math.abs(bytes.readInt16LE(offset)); if (sample > 8) nonzero++; peak = Math.max(peak, sample); }
  expect(nonzero, "the WAV must contain the real performed notes, not just a silent export").toBeGreaterThan(rate * 0.25);
  expect(peak).toBeGreaterThan(300);

  await page.getByRole("button", { name: "Play recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".studio-recorder audio").evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0.05);
  await page.getByRole("button", { name: "Pause recording", exact: true }).click();
  await page.getByRole("button", { name: /New recording/ }).click();
  await expect(downloadLink).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
  expect(await page.evaluate(url => (window as unknown as { studioProbe: StudioProbe }).studioProbe.revokedUrls.includes(url!), takeUrl)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { studioProbe: StudioProbe }).studioProbe.microphoneRequests)).toBe(0);
  expect(posts, "performances stay in the browser").toEqual([]);
  expect(errors).toEqual([]);
});

test("the beat follows tempo and swing, typing stays quiet, and blur/navigation release audio", async ({ page }) => {
  await openStudio(page);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  for (let step = 1; step <= 16; step++) await page.getByRole("button", { name: `Tom, step ${step}`, exact: true }).click();
  await setRange(page.getByRole("slider", { name: "Tempo", exact: true }), 120);
  await setRange(page.getByRole("slider", { name: "Swing", exact: true }), 25);
  await page.getByRole("button", { name: "Play beat", exact: true }).click();
  await expect.poll(async () => (await notes(page, 175)).length).toBeGreaterThanOrEqual(6);
  const hits = await notes(page, 175);
  for (let i = 1; i < 6; i++) expect(hits[i].at - hits[i - 1].at).toBeCloseTo(i % 2 === 1 ? 0.15625 : 0.09375, 3);
  await page.getByRole("button", { name: "Stop beat", exact: true }).click();
  const count = (await notes(page, 175)).length;
  await page.waitForTimeout(400);
  expect((await notes(page, 175)).length).toBe(count);
  expect((await notes(page, 175, true)).length).toBe(0);

  await page.getByRole("slider", { name: "Tempo", exact: true }).focus();
  const beforeTyping = (await notes(page, 261.625565)).length;
  await page.keyboard.press("a");
  await page.waitForTimeout(100);
  expect((await notes(page, 261.625565)).length).toBe(beforeTyping);
  // Native button activation must sustain one voice, even when Enter repeats.
  const focusedKey = page.getByRole("button", { name: "E4 key", exact: true });
  await focusedKey.focus();
  await page.keyboard.down("Enter");
  await expect.poll(async () => (await notes(page, 329.627557, true)).length).toBeGreaterThan(0);
  const focusedPress = (await notes(page, 329.627557)).length;
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.waitForTimeout(150);
  expect((await notes(page, 329.627557)).length).toBe(focusedPress);
  await page.keyboard.up("Enter");
  await expect.poll(async () => (await notes(page, 329.627557, true)).length).toBe(0);
  await page.locator(".studio-intro h1").click();
  await page.keyboard.down("a");
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBeGreaterThan(0);
  const firstPress = (await notes(page, 261.625565)).length;
  await page.keyboard.down("a");
  expect((await notes(page, 261.625565)).length).toBe(firstPress);
  await page.keyboard.up("a");
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBe(0);
  await page.keyboard.down("a");
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBe(0);
  await page.keyboard.up("a");

  await page.getByRole("button", { name: "Play beat", exact: true }).click();
  await expect.poll(async () => (await notes(page, 175)).length).toBeGreaterThan(count);
  const contextIndex = (await notes(page, 175)).at(-1)!.context;
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "My stats", exact: true }).click();
  await expect(page).toHaveURL("http://localhost:3001/stats");
  await expect.poll(() => page.evaluate(index => (window as unknown as { studioProbe: StudioProbe }).studioProbe.contexts[index]?.state, contextIndex)).toBe("closed");
});

test("a narrow touch screen supports chords, cancelled touches, high contrast and reduced motion", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await openStudio(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "High contrast", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
    await expect(page.getByRole("button", { name: "High contrast", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Analog synth", exact: true }).tap();
    await page.getByRole("button", { name: "Start recording", exact: true }).tap();
    const dockStop = page.getByRole("button", { name: "Stop current recording", exact: true });
    await expect(dockStop).toBeVisible({ timeout: 15000 });
    const cKey = page.getByRole("button", { name: "C4 key", exact: true }), eKey = page.getByRole("button", { name: "E4 key", exact: true });
    await cKey.scrollIntoViewIfNeeded();
    const c = (await cKey.boundingBox())!, e = (await eKey.boundingBox())!;
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { id: 1, x: c.x + c.width / 2, y: c.y + c.height * 0.8 },
      { id: 2, x: e.x + e.width / 2, y: e.y + e.height * 0.8 },
    ] });
    await expect(cKey).toHaveAttribute("aria-pressed", "true");
    await expect(eKey).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBeGreaterThan(0);
    await expect.poll(async () => (await notes(page, 329.627557, true)).length).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(cKey).toHaveAttribute("aria-pressed", "false");
    await expect(eKey).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBe(0);
    await expect.poll(async () => (await notes(page, 329.627557, true)).length).toBe(0);
    await session.detach();
    await expect(dockStop).toBeInViewport();
    await dockStop.tap();
    await expect(page.getByRole("link", { name: "Download WAV", exact: true })).toBeVisible({ timeout: 15000 });
    await expect(dockStop).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".studio-shell").evaluate(element => element.getAnimations({ subtree: true }).filter(animation => {
      const timing = animation.effect?.getTiming();
      return animation.playState === "running" && timing?.iterations === Infinity && Number(timing.duration) > 50;
    }).length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("rhythm-studio-mobile-contrast.png"), fullPage: true });
  } finally { await context.close(); }
});

test("audio interruption preserves a non-silent take and a fresh recording resumes the same studio", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openStudio(page);
  await page.getByRole("button", { name: "Analog synth", exact: true }).click();
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled({ timeout: 15000 });
  await page.locator(".studio-intro h1").click();
  await page.keyboard.down("a");
  await expect.poll(async () => (await notes(page, 261.625565, true)).length).toBeGreaterThan(0);
  const contextIndex = (await notes(page, 261.625565)).at(-1)!.context;
  await page.waitForTimeout(700);

  // Suspend the real context while recording, as a device interruption can do.
  // This leaves the processor unable to render; stop must retain received PCM
  // and finish even if the worklet cannot acknowledge its final partial chunk.
  await page.evaluate(async index => {
    const probe = (window as unknown as { studioProbe: StudioProbe }).studioProbe;
    await probe.contexts[index].suspend();
  }, contextIndex);
  await page.keyboard.up("a");
  const downloadLink = page.getByRole("link", { name: "Download WAV", exact: true });
  await expect(downloadLink).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toHaveCount(0);
  await expect(page.locator(".studio-error")).toContainText(/interrupted/i);
  const firstUrl = (await downloadLink.getAttribute("href"))!;

  const inspectTake = async (url: string) => page.evaluate(async currentUrl => {
    const buffer = await (await fetch(currentUrl)).arrayBuffer();
    const view = new DataView(buffer);
    const rate = view.getUint32(24, true), frames = view.getUint32(40, true) / 2;
    let nonzero = 0, peak = 0;
    for (let offset = 44; offset < buffer.byteLength; offset += 2) {
      const value = Math.abs(view.getInt16(offset, true));
      if (value > 8) nonzero++;
      peak = Math.max(peak, value);
    }
    return { rate, frames, nonzero, peak, bytes: buffer.byteLength };
  }, url);
  const firstTake = await inspectTake(firstUrl);
  expect(firstTake.frames / firstTake.rate).toBeGreaterThan(0.4);
  expect(firstTake.nonzero).toBeGreaterThan(firstTake.rate * 0.25);
  expect(firstTake.peak).toBeGreaterThan(300);
  expect(firstTake.bytes).toBe(44 + firstTake.frames * 2);

  await page.getByRole("button", { name: /New recording/ }).click();
  await expect(downloadLink).toHaveCount(0);
  await expect(page.locator(".studio-error")).toHaveCount(0);
  expect(await page.evaluate(url => (window as unknown as { studioProbe: StudioProbe }).studioProbe.revokedUrls.includes(url), firstUrl)).toBe(true);
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled({ timeout: 15000 });
  await expect.poll(() => page.evaluate(index => (window as unknown as { studioProbe: StudioProbe }).studioProbe.contexts[index].state, contextIndex)).toBe("running");
  await page.locator(".studio-intro h1").click();
  await page.keyboard.down("d");
  await expect.poll(async () => (await notes(page, 329.627557, true)).length).toBeGreaterThan(0);
  expect((await notes(page, 329.627557)).at(-1)!.context).toBe(contextIndex);
  await page.waitForTimeout(600);
  await page.keyboard.up("d");
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect(downloadLink).toBeVisible({ timeout: 6000 });
  const secondUrl = (await downloadLink.getAttribute("href"))!;
  expect(secondUrl).not.toBe(firstUrl);
  const secondTake = await inspectTake(secondUrl);
  expect(secondTake.nonzero).toBeGreaterThan(secondTake.rate * 0.2);
  expect(secondTake.peak).toBeGreaterThan(300);
  expect(secondTake.bytes).toBe(44 + secondTake.frames * 2);
  expect(errors).toEqual([]);
});
