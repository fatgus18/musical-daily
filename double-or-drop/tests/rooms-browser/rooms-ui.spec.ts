import { test, expect } from "@playwright/test";
import { correctChoice, createOnPage, fits, fixture, joinOnPage, origin, read } from "./helpers";

test("three browsers play a shared run with touch, keyboard, banking, five-second final reveal and result sharing", async ({ browser }) => {
  const contexts = await Promise.all([{ width: 390, height: 844 }, { width: 1440, height: 1000 }, { width: 320, height: 740 }].map(viewport => browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport, hasTouch: true })));
  const errors: string[] = [];
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of pages) page.on("pageerror", error => errors.push(error.message));
    const code = await createOnPage(pages[0]);
    await pages[0].evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as unknown as {coopShare:string}).coopShare = value; } } }));
    await pages[0].getByRole("button", { name: "Copy invite link", exact: true }).tap();
    expect(await pages[0].evaluate(() => (window as unknown as {coopShare:string}).coopShare)).toBe(`${origin}/double-or-drop/rooms/${code}`);
    await joinOnPage(pages[1], code, "Keys");
    await joinOnPage(pages[2], code, "Touch");
    await expect(pages[0].locator(".dr-lobby-players li")).toHaveCount(3);
    for (const [width, height] of [[320, 740], [390, 844], [844, 390], [1440, 1000]]) {
      await pages[0].setViewportSize({ width, height });
      await fits(pages[0]);
      await pages[0].getByRole("button", { name: /^Room rules/ }).click();
      await expect(pages[0].getByRole("dialog")).toBeVisible();
      expect((await pages[0].getByRole("dialog").boundingBox())!.height).toBeLessThanOrEqual(height);
      await pages[0].getByRole("button", { name: "Close room rules" }).click();
    }
    await pages[0].setViewportSize({ width: 390, height: 844 });
    await pages[0].getByRole("button", { name: "High contrast", exact: true }).tap();
    await expect(pages[0].locator("html")).toHaveAttribute("data-contrast", "high");
    await fits(pages[0]);
    await pages[0].screenshot({ path: "test-results-rooms/coop-lobby-contrast-phone.png", fullPage: true });
    await pages[0].getByRole("button", { name: "High contrast", exact: true }).tap();
    await pages[0].getByRole("button", { name: "Sound settings", exact: true }).tap();
    await expect(pages[0].getByRole("region", { name: "Sound settings" })).toBeVisible();
    await expect(pages[0].getByLabel("Effects volume")).toBeVisible();
    await pages[0].getByRole("button", { name: "Done", exact: true }).tap();
    await pages[0].screenshot({ path: "test-results-rooms/coop-lobby-phone.png", fullPage: true });
    for (const page of pages) await page.getByRole("button", { name: "Ready up", exact: true }).tap();
    await pages[0].getByRole("button", { name: "Start the run", exact: true }).tap();

    for (let turn = 0; turn < 6; turn++) {
      const active = pages[turn % 3];
      const watcher = pages[(turn + 1) % 3];
      const decision = turn === 2 ? "Bank & pick" : [1, 3].includes(turn) ? "Risk & double" : "Pick for the team";
      await expect(active.getByRole("button", { name: decision, exact: true })).toBeVisible();
      await expect(active.locator(".dr-pair")).toHaveCount(0);
      await expect(watcher.getByRole("button", { name: decision, exact: true })).toHaveCount(0);
      if (turn === 1) {
        await active.reload();
        await expect(active.getByRole("button", { name: decision, exact: true })).toBeVisible();
      }
      await active.getByRole("button", { name: decision, exact: true }).tap();
      await expect(active.locator(".dr-site")).toHaveAttribute("data-room-phase", "guess");
      await expect(active.getByRole("timer")).toBeVisible();
      const time = Number(await active.getByRole("timer").locator("strong").innerText());
      expect(time).toBeLessThanOrEqual(20); expect(time).toBeGreaterThanOrEqual(16);
      await expect(active.locator(".dr-pair button")).toHaveCount(2);
      await fits(active);
      await expect(watcher.locator(".dr-pair button")).toHaveCount(2);
      for (const button of await watcher.locator(".dr-pair button").all()) await expect(button).toBeDisabled();
      await expect(active.locator("audio, video")).toHaveCount(0);
      await expect(active.locator(".dr-pair a")).toHaveCount(0);
      if (turn === 0 || turn === 2) {
        await expect(active.locator(".skip-link")).not.toBeInViewport();
        await expect(active.getByRole("timer")).toBeInViewport();
        for (const button of await active.locator(".dr-pair button").all()) await expect(button).toBeInViewport();
        await active.screenshot({ path: `test-results-rooms/coop-pick-${turn === 0 ? 390 : 320}.png`, fullPage: true });
      }
      const correct = correctChoice(code);
      const choice = turn < 3 ? correct : correct === "left" ? "right" : "left";
      const button = active.locator(`.dr-pair button[data-side=${choice}]`);
      if (turn === 1) { await button.focus(); await active.keyboard.press(choice === "left" ? "a" : "b"); }
      else await button.tap();
      await expect(active.locator(".dr-site")).toHaveAttribute("data-room-phase", "reveal");
      await expect(active.locator(".dr-verdict")).toBeVisible();
      const state = await read(active.request, code);
      expect(state.team.banked).toBe(turn >= 2 ? 200 : 0);
      if (turn === 5) {
        expect(state.team.lives).toBe(0);
        await expect(active.locator(".dr-finale")).toHaveCount(0);
        await active.waitForTimeout(3000);
        await expect(active.locator(".dr-site")).toHaveAttribute("data-room-phase", "reveal");
        await active.screenshot({ path: "test-results-rooms/coop-final-miss-phone.png", fullPage: true });
      }
    }
    for (const page of pages) await expect(page.locator(".dr-finale")).toBeVisible();
    await expect(pages[0].locator(".dr-final-number")).toHaveText("200");
    await expect(pages[0].locator(".skip-link")).not.toBeInViewport();
    await pages[0].screenshot({ path: "test-results-rooms/coop-result-phone.png", fullPage: true });
    await pages[1].screenshot({ path: "test-results-rooms/coop-result-desktop.png", fullPage: true });
    await pages[0].getByRole("button", { name: "Share team score", exact: true }).tap();
    const share = await pages[0].evaluate(() => (window as unknown as {coopShare:string}).coopShare);
    expect(share).toContain("200 points");
    expect(share).toContain(`${origin}/double-or-drop/rooms`);
    await pages[0].getByRole("button", { name: "Run it back", exact: true }).tap();
    for (const page of pages) await expect(page.locator(".dr-site")).toHaveAttribute("data-room-phase", "lobby");
    await pages[0].getByRole("button", { name: "Leave room", exact: true }).tap();
    await expect(pages[0].getByRole("dialog", { name: "Passing the mic for good?" })).toBeVisible();
    await pages[0].getByRole("button", { name: "Stay with the crew", exact: true }).tap();
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("artist discovery publishes a playable collection for a phone-created co-op room", async ({ browser }) => {
  fixture("catalog");
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto("/double-or-drop/rooms");
    await page.getByLabel("Your room name").fill("Adele Crew");
    await page.getByLabel("Or find an artist", { exact: true }).fill("Adele");
    const liveArtist = page.locator(".artist-results button").filter({ hasText: "Adele" }).first();
    await liveArtist.tap();
    await expect(page.locator(".artist-coverage")).toBeVisible();
    await page.getByRole("group", { name: "Comparison type" }).getByRole("button", { name: "Runtime", exact: true }).tap();
    await page.getByRole("button", { name: "Create room", exact: true }).tap();
    await expect(page.locator(".dr-room-strip h1")).toHaveText("Adele");
    const code = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    expect((await read(page.request, code)).theme).toBe("artist:adele");
    await fits(page);
  } finally { await context.close(); }
});
