import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { RoomState } from "../../src/lib/rooms/types";
import { roomMedia } from "./media";

const origin = "https://localhost:3100";
function fixture(operation: string, code?: string): RoomState {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/rooms-browser/fixture.mjs"), operation, ...(code ? [code] : [])], { encoding: "utf8", windowsHide: true }));
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function hostRoom(page: Page, name = "Host") {
  await page.goto("/encore/rooms");
  await expect(page.getByLabel("Your room name")).toBeEnabled();
  const joinTab = page.getByRole("button", { name: "Join a room", exact: true });
  if (await joinTab.isVisible()) {
    await joinTab.click();
    await expect(page.getByLabel("Room code", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Find an artist")).toBeHidden();
    await page.getByRole("button", { name: "Host a room", exact: true }).click();
    await expect(page.getByLabel("Find an artist")).toBeVisible();
    await page.screenshot({ path: "test-results-rooms/room-entry-phone.png", fullPage: true });
  }
  await page.getByLabel("Your room name").fill(name);
  await page.getByLabel("Find an artist").fill("Adele");
  await page.getByRole("button", { name: "Choose Adele", exact: true }).click();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.locator(".er-site")).toHaveAttribute("data-room-phase", "lobby");
  return new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
}
async function joinRoom(page: Page, code: string, name = "Friend") {
  await page.goto(`/encore/rooms/${code}`);
  await page.getByLabel("Your room name").fill(name);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.locator(".er-site")).toHaveAttribute("data-room-phase", "lobby");
}

test.beforeAll(() => { fixture("catalog"); });

test("phone host and desktop friend create, invite, hear, guess early, reconnect and leave through the actual UI", async ({ browser }) => {
  const host = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  const friend = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  await Promise.all([roomMedia(host), roomMedia(friend)]);
  try {
    const one = await host.newPage(); const two = await friend.newPage();
    for (const page of [one, two]) page.on("pageerror", error => errors.push(error.message));
    const code = await hostRoom(one);
    await one.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { roomInvite: string }).roomInvite = text; } } }));
    await one.getByRole("button", { name: "Copy invite link", exact: true }).tap();
    expect(await one.evaluate(() => (window as unknown as { roomInvite: string }).roomInvite)).toBe(`${origin}/encore/rooms/${code}`);
    await joinRoom(two, code);
    await expect(one.locator(".er-lobby-players li")).toHaveCount(2);
    for (const [width, height] of [[320, 740], [390, 844], [844, 390], [1440, 1000]]) {
      await one.setViewportSize({ width, height }); await fits(one);
      await one.getByRole("button", { name: /^Room rules/ }).click();
      await expect(one.getByRole("dialog")).toBeVisible();
      expect((await one.getByRole("dialog").boundingBox())!.height).toBeLessThanOrEqual(height);
      await one.getByRole("button", { name: "Close room rules" }).click();
    }
    await one.setViewportSize({ width: 390, height: 844 });
    await one.screenshot({ path: "test-results-rooms/room-lobby-phone.png", fullPage: true });
    await one.getByRole("button", { name: "Ready up", exact: true }).tap();
    await two.getByRole("button", { name: "Ready up", exact: true }).click();
    await expect(one.getByRole("button", { name: "Start the match", exact: true })).toBeEnabled();
    await one.getByRole("button", { name: "Start the match", exact: true }).tap();
    await expect(one.getByRole("button", { name: "Guess now", exact: true })).toBeVisible({ timeout: 25000 });
    await expect(two.getByRole("button", { name: "Guess now", exact: true })).toBeVisible();
    const before = fixture("inspect", code);
    expect(before.startAt).not.toBeNull();
    expect(Date.now() - before.startAt!).toBeLessThan(15000);
    await one.getByRole("button", { name: "Guess now", exact: true }).tap();
    await expect(one.getByRole("group", { name: "Which song is it?" }).getByRole("button")).toHaveCount(4);
    await expect(two.getByRole("group", { name: "Which song is it?" })).toHaveCount(0);
    await expect(one.getByRole("timer")).toBeInViewport();
    for (const choice of await one.getByRole("group", { name: "Which song is it?" }).getByRole("button").all()) await expect(choice).toBeInViewport();
    await fits(one);
    await one.screenshot({ path: "test-results-rooms/room-guess-phone.png", fullPage: true });
    const correct = before.picks[0].choices!.find(choice => choice.id === before.picks[0].correctChoiceId)!;
    await one.getByRole("group", { name: "Which song is it?" }).getByRole("button", { name: correct.label, exact: true }).tap();
    await expect(one.getByRole("heading", { name: "Answer locked." })).toBeVisible();
    await expect(one.getByRole("heading", { name: correct.label, exact: true })).toHaveCount(0);
    // Reload restores the friend's identity, never restarts the shared clock.
    const firstId = (await (await two.request.get(`/encore/api/rooms/${code}`)).json()).room.youId;
    await two.reload();
    await expect(two.getByRole("button", { name: "Guess now", exact: true })).toBeVisible();
    expect((await (await two.request.get(`/encore/api/rooms/${code}`)).json()).room.youId).toBe(firstId);
    await two.getByRole("button", { name: "Guess now", exact: true }).click();
    const wrong = before.picks[0].choices!.find(choice => choice.id !== correct.id)!;
    await two.getByRole("group", { name: "Which song is it?" }).getByRole("button", { name: wrong.label, exact: true }).click();
    await expect(one.locator(".er-site")).toHaveAttribute("data-room-phase", "reveal");
    await expect(two.locator(".er-site")).toHaveAttribute("data-room-phase", "reveal");
    await expect(one.locator(".er-reveal h2")).toHaveText(before.picks[0].track.title);
    await one.screenshot({ path: "test-results-rooms/room-reveal-phone.png", fullPage: true });
    await one.getByRole("button", { name: "Leave room", exact: true }).tap();
    await expect(one.getByRole("dialog", { name: "Leaving the encore?" })).toBeVisible();
    await fits(one);
    await one.screenshot({ path: "test-results-rooms/room-leave-phone.png" });
    await one.getByRole("dialog").getByRole("button", { name: "Stay in the room", exact: true }).tap();
    await one.getByRole("button", { name: "Leave room", exact: true }).tap();
    await one.getByRole("dialog").getByRole("button", { name: "Leave room", exact: true }).tap();
    await expect(one.getByLabel("Your room name")).toBeVisible();
    await expect.poll(async () => { const response = await two.request.get(`/encore/api/rooms/${code}`); const state = (await response.json()).room; return state.hostId === state.youId; }).toBe(true);
    expect(errors).toEqual([]);
  } finally { await Promise.all([host.close(), friend.close()]); }
});

test("failed audio is recoverable and a host skip is explicitly void for everyone", async ({ browser }) => {
  const host = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 320, height: 740 }, hasTouch: true });
  const friend = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  await Promise.all([roomMedia(host), roomMedia(friend, true)]);
  try {
    const one = await host.newPage(); const two = await friend.newPage();
    const code = await hostRoom(one, "Host Error");
    await joinRoom(two, code, "Friend Error");
    await one.getByRole("button", { name: "Ready up", exact: true }).tap();
    await two.getByRole("button", { name: "Ready up", exact: true }).click();
    await one.getByRole("button", { name: "Start the match", exact: true }).tap();
    await expect(two.getByRole("button", { name: "Retry audio", exact: true })).toBeVisible();
    await expect(two.locator(".er-audio-error")).toContainText("couldn't load");
    await expect(one.locator(".er-site")).toHaveAttribute("data-room-phase", "loading");
    await fits(one);
    await one.getByRole("button", { name: "Skip round for everyone", exact: true }).tap();
    await expect(one.getByRole("heading", { name: "This round won't count." })).toBeVisible();
    await expect(two.getByRole("heading", { name: "This round won't count." })).toBeVisible();
    const state = (await (await one.request.get(`/encore/api/rooms/${code}`)).json()).room;
    expect(state.reveals[0]).toMatchObject({ voided: true, reason: "host_skipped" });
    expect(state.leaderboard.every((player: {score:number;timeMs:number}) => player.score === 0 && player.timeMs === 0)).toBe(true);
  } finally { await Promise.all([host.close(), friend.close()]); }
});

test("a real provider preview travels through the protected room audio route and decodes before the shared start", async ({ browser, playwright }) => {
  const host = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  const friend = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const page = await host.newPage();
    const code = await hostRoom(page, "Real Audio");
    const joinedResponse = await friend.post(`/encore/api/rooms/${code}`, { headers: { origin }, data: { action: "join", nickname: "Audio Partner" } });
    expect(joinedResponse.ok()).toBe(true);
    let room = (await joinedResponse.json()).room;
    const act = async (action: string) => {
      const response = await friend.post(`/encore/api/rooms/${code}`, { headers: { origin }, data: { action, matchId: room.matchId, round: room.round, audioRevision: room.audioRevision, ready: true } });
      expect(response.ok(), await response.text()).toBe(true);
      room = (await response.json()).room;
    };
    fixture("provider-audio", code);
    await act("ready");
    await page.getByRole("button", { name: "Ready up", exact: true }).tap();
    const media = page.waitForResponse(response => response.url().includes(`/api/rooms/${code}/audio`));
    await page.getByRole("button", { name: "Start the match", exact: true }).tap();
    await expect(page.locator(".er-site")).toHaveAttribute("data-room-phase", "loading");
    await act("loaded");
    const response = await media;
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/^audio\//);
    expect((await response.body()).length).toBeGreaterThan(10000);
    await expect(page.getByRole("button", { name: "Guess now", exact: true })).toBeVisible({ timeout: 25000 });
    const state = fixture("inspect", code);
    expect(state.members.every(player => player.loaded)).toBe(true);
    expect(state.picks[0].track.preview).toContain("audio-ssl.itunes.apple.com");
    await expect(page.locator(".er-disc.is-spinning")).toBeVisible();
  } finally { await Promise.all([host.close(), friend.dispose()]); }
});

test("Guess now stops the decoded clip immediately while its real request is still in flight", async ({ browser }) => {
  const host = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true });
  const friend = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  await Promise.all([roomMedia(host), roomMedia(friend)]);
  await host.addInitScript(() => {
    const events: { type: "start" | "stop"; at: number }[] = [];
    (window as unknown as { roomAudioEvents: typeof events }).roomAudioEvents = events;
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer && this.buffer.duration >= 15) events.push({ type: "start", at: performance.now() });
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      if (this.buffer && this.buffer.duration >= 15) events.push({ type: "stop", at: performance.now() });
      return stop.apply(this, args);
    };
  });
  try {
    const one = await host.newPage(); const two = await friend.newPage();
    const code = await hostRoom(one, "Slow Network");
    await joinRoom(two, code, "Fast Network");
    await one.getByRole("button", { name: "Ready up", exact: true }).tap();
    await two.getByRole("button", { name: "Ready up", exact: true }).click();
    await one.getByRole("button", { name: "Start the match", exact: true }).tap();
    await expect(one.getByRole("button", { name: "Guess now", exact: true })).toBeVisible();
    await expect.poll(() => one.evaluate(() => (window as unknown as {roomAudioEvents:{type:string}[]}).roomAudioEvents.filter(event => event.type === "start").length)).toBeGreaterThan(0);
    let notify: () => void = () => undefined;
    const requested = new Promise<void>(resolve => { notify = resolve; });
    await one.route(`**/api/rooms/${code}`, async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.action === "guess") {
        notify();
        // Simulate latency while preserving the actual authenticated request,
        // server scoring, response and clock; no API response is substituted.
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      await route.continue();
    });
    const clickedAt = await one.evaluate(() => performance.now());
    await one.getByRole("button", { name: "Guess now", exact: true }).tap();
    await requested;
    await one.waitForTimeout(600);
    const during = await one.evaluate(at => (window as unknown as {roomAudioEvents:{type:string;at:number}[]}).roomAudioEvents.filter(event => event.at >= at), clickedAt);
    expect(during.some(event => event.type === "stop")).toBe(true);
    expect(during.filter(event => event.type === "start")).toEqual([]);
    await expect(one.getByRole("group", { name: "Which song is it?" }).getByRole("button")).toHaveCount(4);
    expect(await one.evaluate(at => (window as unknown as {roomAudioEvents:{type:string;at:number}[]}).roomAudioEvents.filter(event => event.at >= at && event.type === "start").length, clickedAt)).toBe(0);
  } finally { await Promise.all([host.close(), friend.close()]); }
});
