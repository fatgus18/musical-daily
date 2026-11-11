import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const origin = "https://localhost:3100";
interface PublicBoard {
  date: string;
  catalogVersion: string;
  rulesVersion: string;
  targetStreams: number;
  tracks: { id: string; title: string; artist: string }[];
}

function assertLocalFixture() {
  const fixture = JSON.parse(readFileSync(resolve("../test-results-accounts/fixture.json"), "utf8"));
  if (fixture.localFixture !== true || fixture.origin !== origin) throw new Error("Run the disposable local HTTPS services fixture first.");
}

async function loadBoard(page: Page, reload = false): Promise<PublicBoard> {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/blackjack/api/daily" && value.request().method() === "GET");
  if (reload) await page.reload(); else await page.goto("/blackjack/");
  const result = await response;
  expect(result.ok()).toBe(true);
  await expect(page.locator(".bj-track-card")).toHaveCount(9);
  return result.json();
}

const titles = (page: Page) => page.locator(".bj-track-card h3").allTextContents();

test("daily Blackjack has a stable personal layout, a shared exact cap and a spoiler-free playable share link", async ({ browser }) => {
  assertLocalFixture();
  const first = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, timezoneId: "Asia/Kolkata" });
  const friend = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, timezoneId: "America/Los_Angeles" });
  try {
    const page = await first.newPage();
    const friendPage = await friend.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    friendPage.on("pageerror", error => pageErrors.push(error.message));
    let copied = "";
    await page.exposeFunction("captureBlackjackShare", (text: string) => { copied = text; });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text: string) => (window as unknown as { captureBlackjackShare(text: string): Promise<void> }).captureBlackjackShare(text) },
      });
    });

    // Both are actual new guests with independently generated browser layouts.
    const board = await loadBoard(page);
    const friendBoard = await loadBoard(friendPage);
    expect(board.date).toBe(friendBoard.date);
    expect(board.catalogVersion).toBe(friendBoard.catalogVersion);
    expect(board.rulesVersion).toBe(friendBoard.rulesVersion);
    expect(board.targetStreams).toBe(friendBoard.targetStreams);
    expect(board.tracks.map(track => track.id).sort()).toEqual(friendBoard.tracks.map(track => track.id).sort());
    const firstTitles = await titles(page);
    const friendTitles = await titles(friendPage);
    expect([...firstTitles].sort()).toEqual([...friendTitles].sort());
    expect(firstTitles).not.toEqual(friendTitles);
    const cap = page.locator(".bj-console p").filter({ hasText: "Exact cap:" });
    await expect(cap).toContainText(board.targetStreams.toLocaleString("en-US"));
    await expect(friendPage.locator(".bj-console p").filter({ hasText: "Exact cap:" })).toHaveText(await cap.innerText());

    const identity = await page.evaluate(() => localStorage.getItem("sbj_board_identity_v1"));
    expect(identity).toBeTruthy();
    await loadBoard(page, true);
    expect(await titles(page)).toEqual(firstTitles);
    expect(await page.evaluate(() => localStorage.getItem("sbj_board_identity_v1"))).toBe(identity);

    // Find a witness independently using the same immutable local release.
    // No answer/debug endpoint or real user's state is involved.
    const catalog = JSON.parse(readFileSync(resolve(`../blackjack-music/data/catalog-releases/${board.catalogVersion}.json`), "utf8"));
    const streams = new Map<string, number>(catalog.tracks.map((track: { id: string; streams: number }) => [track.id, track.streams]));
    let optimalIds: string[] = [];
    for (let mask = 1; mask < 1 << board.tracks.length; mask++) {
      const hand = board.tracks.filter((_track, index) => mask & (1 << index));
      if (hand.length >= 3 && hand.length <= 5 && hand.reduce((sum, track) => sum + streams.get(track.id)!, 0) === board.targetStreams) {
        optimalIds = hand.map(track => track.id);
        break;
      }
    }
    expect(optimalIds.length).toBeGreaterThanOrEqual(3);
    for (const id of optimalIds) {
      const track = board.tracks.find(value => value.id === id)!;
      const card = page.getByRole("button", { name: `${track.title} by ${track.artist}, reveal stream count`, exact: true });
      await expect(card).toHaveAttribute("aria-disabled", "false");
      // Target the title to avoid the nested audio-preview button.
      await card.locator("h3").click();
      await expect(page.locator(".bj-track-card[data-state='picked']")).toHaveCount(optimalIds.indexOf(id) + 1);
    }
    await expect(page.locator(".bj-results")).toContainText("100.0% Accuracy");
    await page.getByRole("button", { name: "📤 Share Score", exact: true }).click();
    await expect.poll(() => copied).toContain(`${origin}/blackjack/`);
    await expect(page.getByRole("button", { name: "✅ Score + link copied!", exact: true })).toBeVisible();
    expect(copied).toMatch(/Stream Blackjack — Day #\d+/);
    expect(copied).toContain("BLACKJACK");
    expect(copied).toContain("100.0%");
    expect(copied).not.toMatch(/🟩|⬛|⭐|optimal|Best hand|seed=|session=/);
    for (const track of board.tracks) {
      expect(copied).not.toContain(track.id);
      expect(copied).not.toContain(track.title);
    }
    const sharedUrl = copied.trim().split("\n").at(-1)!;
    const sharedPage = await friend.newPage();
    expect((await sharedPage.goto(sharedUrl))?.ok()).toBe(true);
    await expect(sharedPage.locator(".bj-track-card")).toHaveCount(9);
    expect(await titles(sharedPage)).toEqual(friendTitles);
    await expect(sharedPage.locator(".bj-results")).toHaveCount(0);
    await expect(sharedPage.locator(".bj-track-card[data-state='picked']")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.all([first.close(), friend.close()]);
  }
});
