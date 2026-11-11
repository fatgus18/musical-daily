import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function studio(page: Page) {
  await page.goto("/rhythm-lab");
  await expect(page.getByRole("button", { name: "C4 key", exact: true })).toBeEnabled();
}

test("phone hub keeps game discovery, facts, instructions and filtered surprise playable", async ({ page }) => {
  await page.goto("/");
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    for (const name of ["Rhythm Lab", "My stats"]) {
      const box = await nav.getByRole("link", { name, exact: true }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole("button", { name: /How it works/ })).toBeVisible();
    await expect(page.locator(".games-grid .game-card:visible")).toHaveCount(4);
  }
  await page.getByRole("button", { name: "Daily ritual" }).tap();
  await expect(page.locator(".games-grid .game-card:visible")).toHaveCount(3);
  await expect(page.locator(".double-drop-card")).toHaveAttribute("href", /mode=daily/);
  await page.getByRole("button", { name: "Surprise me" }).tap();
  const picker = page.locator(".game-picker-dialog");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".picker-actions a")).toBeVisible();
  await expect(picker.locator(".picker-selection h3")).not.toHaveText("Encore");
  const first = await picker.locator(".picker-selection h3").innerText();
  await picker.getByRole("button", { name: "Spin again" }).tap();
  await expect(picker.locator(".picker-selection h3")).not.toHaveText(first);
  await page.getByRole("button", { name: "Close game picker" }).tap();
  await page.getByRole("button", { name: "Play anytime" }).tap();
  await expect(page.locator(".games-grid .game-card:visible")).toHaveCount(4);
  await page.getByRole("button", { name: "How it works", exact: false }).tap();
  const instructions = page.locator("dialog[open]");
  await expect(instructions.getByRole("heading", { name: "Rhythm Lab", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close instructions" }).tap();
  const fact = page.locator(".music-fact");
  await expect(fact).toHaveAttribute("aria-busy", "false");
  const previous = await fact.getAttribute("data-fact-id");
  await page.getByRole("button", { name: "Show another music fact" }).tap();
  await expect(fact).not.toHaveAttribute("data-fact-id", previous!);
  await expect(fact.locator(".music-fact-destination")).toHaveAttribute("href", /^https:\/\//);
  await page.getByRole("button", { name: "Hide music fact for this visit" }).tap();
  await expect(fact).toHaveCount(0);
  await page.getByRole("button", { name: "Show music fact" }).tap();
  await expect(fact).toBeVisible();
  await page.getByRole("link", { name: /Open Rhythm Lab/ }).tap();
  await expect(page).toHaveURL(/\/rhythm-lab$/);
});

test("phone studio controls stay reachable and a real touch performance downloads, plays and discards", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 740 });
  await studio(page);
  test.skip(!await page.evaluate(() => "AudioContext" in window || "webkitAudioContext" in window), "This browser build has no Web Audio implementation (Windows Playwright WebKit); real recording is verified in Chromium, never with mocked audio.");
  await fits(page);
  for (const name of ["Lower octave", "Higher octave", "Mute studio", "Stop all sound"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const volume = page.getByRole("slider", { name: "Live volume", exact: true });
  expect((await volume.boundingBox())!.width).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Higher octave" }).tap();
  await expect(page.getByRole("button", { name: "C5 key", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lower octave" }).tap();
  for (const name of ["Velvet keys", "Warm bass", "Glass bells", "Analog synth"]) {
    await page.getByRole("button", { name, exact: true }).tap();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Mute studio", exact: true }).tap();
  await page.getByRole("button", { name: "Start recording", exact: true }).tap();
  await expect(page.locator(".studio-error")).toContainText("unmute");
  await page.getByRole("button", { name: "Dismiss studio error" }).tap();
  await page.getByRole("button", { name: "Unmute studio", exact: true }).tap();
  await page.getByRole("button", { name: "Start recording", exact: true }).tap();
  const dockStop = page.getByRole("button", { name: "Stop current recording", exact: true });
  await expect(dockStop).toBeVisible({ timeout: 15000 });
  for (const name of ["C4 key", "E4 key", "G4 key"]) {
    const key = page.getByRole("button", { name, exact: true });
    await key.tap({ position: { x: 8, y: 150 } });
    await expect(key).toHaveAttribute("aria-pressed", "false");
  }
  for (const name of ["Kick", "Snare", "Clap", "Hi-hat", "Open hat", "Tom"]) {
    await page.getByRole("button", { name: `Play ${name}`, exact: true }).tap();
  }
  await expect(dockStop).toBeInViewport();
  await dockStop.tap();
  const download = page.getByRole("link", { name: "Download WAV", exact: true });
  await expect(download).toBeVisible({ timeout: 15000 });
  await page.getByRole("link", { name: "Listen or download", exact: true }).tap();
  await expect(page.locator(".studio-recorder")).toBeInViewport();
  const downloadPromise = page.waitForEvent("download");
  await download.tap();
  const file = await downloadPromise;
  const bytes = await readFile((await file.path())!);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  let peak = 0;
  for (let at = 44; at < bytes.length; at += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(at)));
  expect(peak, "touch notes and drums must produce real recorded audio").toBeGreaterThan(300);
  await page.getByRole("button", { name: "Play recording", exact: true }).tap();
  await expect.poll(() => page.locator(".studio-recorder audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.05);
  await page.getByRole("button", { name: "Pause recording", exact: true }).tap();
  const position = page.getByRole("slider", { name: "Recording playback position" });
  await position.tap({ position: { x: 50, y: 20 } });
  expect(Number(await position.inputValue())).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("phone-studio-recorded.png"), fullPage: true });
  await page.locator(".studio-recorder").screenshot({ path: testInfo.outputPath("phone-recording-controls.png") });
  await page.getByRole("button", { name: /New recording/ }).tap();
  await expect(download).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeFocused();
  await fits(page);
  expect(errors).toEqual([]);
});

test("touch sequencer reaches step sixteen, presets and sliders work in portrait and landscape", async ({ page }) => {
  await studio(page);
  await page.getByRole("button", { name: "Clear", exact: true }).tap();
  await expect(page.locator(".studio-step[aria-pressed=true]")).toHaveCount(0);
  const last = page.getByRole("button", { name: "Kick, step 16", exact: true });
  await last.tap();
  await expect(last).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator(".studio-step-scroll").evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole("button", { name: /After-hours house/ }).tap();
  await expect(page.getByRole("slider", { name: "Tempo", exact: true })).toHaveValue("124");
  await page.getByRole("button", { name: /Pocket breakbeat/ }).tap();
  await expect(page.locator(".studio-step[aria-pressed=true]").first()).toBeVisible();
  await page.getByRole("button", { name: /Late-night lo-fi/ }).tap();
  for (const name of ["Tempo", "Swing", "Live volume", "Tone", "Kick level"]) {
    const slider = page.getByRole("slider", { name, exact: true });
    const previous = await slider.inputValue();
    await slider.tap({ position: { x: 14, y: 20 } });
    expect(await slider.inputValue()).not.toBe(previous);
  }
  await page.getByRole("button", { name: "Play beat", exact: true }).tap();
  if (await page.evaluate(() => "AudioContext" in window || "webkitAudioContext" in window)) {
    await expect(page.getByRole("button", { name: "Stop beat", exact: true })).toBeVisible();
    await expect(page.locator(".studio-step.is-current").first()).toBeAttached();
  } else {
    await expect(page.locator(".studio-error")).toContainText("Your browser cannot play studio audio");
  }
  await page.getByRole("button", { name: "Stop all sound", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Play beat", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await fits(page);
  await page.getByRole("button", { name: /How to play/ }).tap();
  const help = page.locator(".studio-help");
  await expect(help).toBeVisible();
  const close = page.getByRole("button", { name: "Close studio guide" });
  await close.tap();
  await expect(help).not.toBeVisible();
  await page.getByRole("button", { name: "High contrast", exact: true }).tap();
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await fits(page);
});

test("simultaneous touch notes and cancellation never leave a stuck piano key", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Real multitouch injection uses Chrome's device protocol; WebKit runs the single-touch recording flow.");
  await studio(page);
  const c = page.getByRole("button", { name: "C4 key", exact: true });
  const e = page.getByRole("button", { name: "E4 key", exact: true });
  await c.scrollIntoViewIfNeeded();
  const boxes = [(await c.boundingBox())!, (await e.boundingBox())!];
  const session = await context.newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: boxes.map((box, index) => ({ id: index + 1, x: box.x + box.width / 2, y: box.y + box.height * .85 })) });
  await expect(c).toHaveAttribute("aria-pressed", "true");
  await expect(e).toHaveAttribute("aria-pressed", "true");
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(c).toHaveAttribute("aria-pressed", "false");
  await expect(e).toHaveAttribute("aria-pressed", "false");
  await session.detach();
  await page.locator(".studio-intro h1").tap();
  await page.keyboard.down("a");
  await expect(c).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(c).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.up("a");
});
