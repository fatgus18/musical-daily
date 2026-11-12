import { expect, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { PublicRoom, RoomState } from "../../src/lib/rooms/types";

export const origin = "https://localhost:3100";
export const roomPath = (code: string) => `/double-or-drop/api/rooms/${code}`;
export function fixture<T = RoomState>(operation: string, code?: string): T {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/rooms-browser/fixture.mjs"), operation, ...(code ? [code] : [])], { encoding: "utf8", windowsHide: true }));
}
export async function json(response: APIResponse) {
  expect(response.ok(), `${response.url()} ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
export async function read(client: APIRequestContext, code: string): Promise<PublicRoom> {
  return (await json(await client.get(roomPath(code)))).room;
}
export async function post(client: APIRequestContext, code: string, data: object): Promise<PublicRoom> {
  return (await json(await client.post(roomPath(code), { headers: { origin }, data }))).room;
}
export function move(state: PublicRoom, action: string, fields: object = {}) {
  return { action, matchId: state.matchId, turn: state.turn, requestId: randomUUID(), ...fields };
}
export async function act(client: APIRequestContext, state: PublicRoom, action: string, fields: object = {}) {
  return post(client, state.code, move(state, action, fields));
}
export async function create(client: APIRequestContext, nickname = "Captain", settings: object = {}) {
  const init = await json(await client.get("/double-or-drop/api/rooms"));
  const input = { action: "create", nickname, requestId: randomUUID(), theme: "all", metricFilter: "duration", catalogVersion: init.catalog.version, ...settings };
  const room = (await json(await client.post("/double-or-drop/api/rooms", { headers: { origin }, data: input }))).room as PublicRoom;
  return { room, input, catalog: init.catalog };
}
export function correctChoice(code: string) {
  const state = fixture("inspect", code);
  const pair = state.game.pair;
  const left = pair.left.metrics[pair.metric]!.value;
  const right = pair.right.metrics[pair.metric]!.value;
  expect(left).not.toBe(right);
  return (pair.metric === "year" ? left < right : left > right) ? "left" as const : "right" as const;
}
export function privateDecision(room: PublicRoom) {
  expect(room.pair).toBeUndefined();
  expect(room).not.toHaveProperty("game");
  expect(room).not.toHaveProperty("processed");
  expect(room).not.toHaveProperty("requestId");
}
export function hiddenValues(room: PublicRoom) {
  expect(room.pair).toBeTruthy();
  for (const side of ["left", "right"] as const) {
    expect(room.pair![side]).not.toHaveProperty("metrics");
    expect(room.pair![side]).not.toHaveProperty("sourceUrl");
    expect(room.pair![side]).not.toHaveProperty("previewUrl");
    expect(room.pair![side]).not.toHaveProperty("previewSourceUrl");
  }
}
export async function seedAccount(context: BrowserContext) {
  // Reuse the existing private fixture, which validates both manifest origin
  // and temporary account DB paths before creating any synthetic identity.
  const seeded = JSON.parse(execFileSync(process.execPath, [resolve("../artist-encore/tests/account-services/seed-local.mjs"), "identity"], { encoding: "utf8", windowsHide: true }));
  await context.addCookies([{ name: "md_hub_session", value: seeded.session.token, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  return seeded.user as { id: string; email: string };
}

export async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
export async function createOnPage(page: Page, nickname = "Captain") {
  await page.goto("/double-or-drop/rooms");
  await expect(page.getByLabel("Your room name")).toBeEnabled();
  await page.getByLabel("Your room name").fill(nickname);
  const collections = page.getByRole("combobox", { name: /Pick a collection/ });
  await collections.focus();
  await collections.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Music collections" })).toBeVisible();
  await collections.press("Home");
  await collections.press("Enter");
  await expect(collections).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("group", { name: "Comparison type" }).getByRole("button", { name: "Runtime", exact: true }).click();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.locator(".dr-site")).toHaveAttribute("data-room-phase", "lobby");
  return new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
}
export async function joinOnPage(page: Page, code: string, nickname: string) {
  await page.goto(`/double-or-drop/rooms/${code}`);
  await page.getByLabel("Your room name").fill(nickname);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.locator(".dr-site")).toHaveAttribute("data-room-phase", "lobby");
}
