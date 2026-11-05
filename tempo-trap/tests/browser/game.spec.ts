import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTracks,getCatalogVersion } from "../../src/lib/catalog";
function catalogFor(version:string): { tracks: {id:string;bpm:number}[] } {
  return JSON.parse(readFileSync(resolve(process.cwd(),"data/catalog-releases",`${version}.json`),"utf8"));
}

test("dated releases preserve old puzzles and the expanded daily rotation has no repeats",()=>{
  const index=JSON.parse(readFileSync(resolve("data/catalog-releases.json"),"utf8")) as {releases:{version:string;effectiveOn:string;selection:string}[]};
  for(const release of index.releases) expect(getCatalogVersion(release.effectiveOn)).toBe(release.version);
  const latest=index.releases.at(-1)!;
  expect(getCatalogVersion("2026-10-31",true)).toBe(latest.version);
  const snapshot=JSON.parse(readFileSync(resolve("data/catalog-releases",`${latest.version}.json`),"utf8"));
  if(snapshot.rotation){
    const seen=new Set<string>();
    for(let day=0;day<snapshot.rotation.length;day++){
      const date=new Date(Date.parse(latest.effectiveOn)+day*86400000).toISOString().slice(0,10);
      const tracks=getTracks(date,"daily",latest.version);
      expect(tracks).toHaveLength(5);expect(new Set(tracks.map(t=>t.artist)).size).toBe(5);
      for(const track of tracks){expect(seen.has(track.id)).toBeFalsy();seen.add(track.id);}
    }
    expect(seen.size).toBeGreaterThan(100);
  }
});

test("practice immediately uses the expanded pool and scores against its pinned version",async({request})=>{
  const puzzle=await (await request.get("/api/daily?mode=practice")).json();
  const library=catalogFor(puzzle.version);
  expect(library.tracks.length).toBeGreaterThan(100);
  let token=puzzle.token;
  for(const track of puzzle.tracks){
    expect(track).not.toHaveProperty("bpm");expect(track).not.toHaveProperty("bpmQuality");
    const bpm=library.tracks.find(t=>t.id===track.id)!.bpm;
    const response=await request.post("/api/guess",{data:{token,guess:bpm}});
    const answer=await response.json();expect(response.ok()).toBeTruthy();expect(answer.result.score).toBe(1000);token=answer.token;
  }
});

test("server hides answers, rejects tampered sessions, and signs all five results", async ({ request }) => {
  const response = await request.get("/api/daily");
  expect(response.ok()).toBeTruthy();
  const puzzle = await response.json();
  expect(puzzle.tracks).toHaveLength(5);
  expect(new Set(puzzle.tracks.map((t: { artist: string }) => t.artist)).size).toBe(5);
  for (const track of puzzle.tracks) { expect(track).not.toHaveProperty("bpm"); expect(track.spotifyUrl).toContain("https://open.spotify.com/track/"); expect(track.artworkUrl).toContain("mzstatic.com"); }
  const invalid = await request.post("/api/guess", { data: { token: puzzle.token + "x", guess: 100 } });
  expect(invalid.status()).toBe(400);
  const outOfRange = await request.post("/api/guess", { data: { token: puzzle.token, guess: 999 } });
  expect(outOfRange.status()).toBe(400);
  let token = puzzle.token;
  for (let round = 0; round < 5; round++) {
    const bpm = catalogFor(puzzle.version).tracks.find(t => t.id === puzzle.tracks[round].id)!.bpm;
    const reply = await request.post("/api/guess", { data: { token, guess: bpm } });
    const result = await reply.json();
    expect(reply.ok()).toBeTruthy(); expect(result.result.score).toBe(1000); expect(result.results).toHaveLength(round + 1);
    // Retrying a lost response is idempotent for the same signed state and guess.
    const retry = await request.post("/api/guess", { data: { token, guess: bpm } });
    expect(await retry.json()).toEqual(result);
    token = result.token;
  }
  expect((await request.post("/api/guess", { data: { token, guess: 100 } })).status()).toBe(409);
});

test("real audio plays for 15 seconds before BPM entry unlocks", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await expect(page.locator(".album-cover")).toBeVisible();
  await expect.poll(() => page.locator(".album-cover").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Let’s hear it" }).click();
  await expect(page.getByText("JUST LISTEN", { exact: true })).toBeVisible({ timeout: 25000 });
  const start = Date.now();
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toBeVisible({ timeout: 20000 });
  expect(Date.now() - start).toBeGreaterThan(14000);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("tempo:daily:"))!)!));
  const bpm = catalogFor(saved.puzzle.version).tracks.find(t => t.id === saved.puzzle.tracks[0].id)!.bpm;
  await page.getByLabel("YOUR GUESS", { exact: true }).fill(String(bpm));
  await page.getByRole("button", { name: "Lock in my guess" }).click();
  await expect(page.getByText("Right on the beat.", { exact: true })).toBeVisible();
  await expect(page.locator(".comparison .coral")).toHaveText("+1000points");
  await page.reload();
  await expect(page.locator(".comparison .coral")).toHaveText("+1000points");
  await expect(page.locator(".playback-progress > span").first()).toHaveText("0:15");
  await page.screenshot({ path: "test-results/tempo-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("last five guessing seconds stand out, respect reduced motion, and stop on submission", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith("tempo:daily:"))!;
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.progress.phase = "guessing"; saved.progress.deadline = Date.now() + 15000;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  const timer = page.getByRole("timer");
  await expect(timer).toContainText("15 SECONDS LEFT");
  await expect(timer).not.toHaveClass(/urgent/);
  await page.clock.runFor(9000);
  await expect(timer).toContainText("6 SECONDS LEFT");
  await expect(timer).not.toHaveClass(/urgent/);
  await page.clock.runFor(1050);
  await expect(timer).toContainText("5 SECONDS LEFT");
  await expect(timer).toHaveClass(/urgent/);
  await expect(timer).toHaveCSS("animation-name", "guess-urgency");
  await expect(page.getByRole("status").filter({ hasText: "Five seconds left" })).toHaveText("Five seconds left. Lock in your guess.");
  await expect(page.locator(".guess-timer-track")).toHaveClass(/urgent/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(timer).toHaveCSS("animation-name", "none");
  await expect(timer).toHaveCSS("outline-width", "2px");
  await expect(timer).toHaveCSS("background-color", "rgb(86, 55, 44)");
  await page.getByLabel("YOUR GUESS", { exact: true }).fill("100");
  await page.route("**/api/guess", route => route.fulfill({ status: 503, json: { error: "Test retry" } }));
  await page.getByRole("button", { name: "Lock in my guess" }).click();
  await expect(timer).toHaveText("ANSWER LOCKED");
  await expect(timer).not.toHaveClass(/urgent/);
  await expect(page.locator(".guess-timer-track")).not.toHaveClass(/urgent/);
});

test("expired timer auto-submits an empty answer and survives refresh", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith("tempo:daily:"))!;
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.progress.phase = "guessing"; saved.progress.deadline = Date.now() - 1000; saved.progress.guess = "";
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByText("The beat got away", { exact: true })).toBeVisible();
  await expect(page.locator(".comparison .coral")).toHaveText("+0points");
});

test("five rounds finish, daily stats count once, and practice stays separate", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  for (let round = 0; round < 5; round++) {
    const selected = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith("tempo:daily:"))!;
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved.progress.phase = "guessing"; saved.progress.deadline = Date.now() + 15000;
      localStorage.setItem(key, JSON.stringify(saved));
      return {id:saved.puzzle.tracks[saved.progress.round].id,version:saved.puzzle.version};
    });
    const bpm = catalogFor(selected.version).tracks.find(t => t.id === selected.id)!.bpm;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("YOUR GUESS", { exact: true }).fill(String(bpm));
    await page.getByRole("button", { name: "Lock in my guess" }).click();
    await expect(page.getByText("Right on the beat.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: round === 4 ? "See my results" : "Next round", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tempo:stats")!).played)).toBe(1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tempo:stats")!).played)).toBe(1);
  await page.getByRole("button", { name: "Play another mix" }).click();
  await expect(page.getByText("PRACTICE SESSION", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Daily mix", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human metronome." })).toBeVisible();
});

test("audio failures allow a retry without starting the guessing timer", async ({ page }) => {
  await page.route("https://audio-ssl.itunes.apple.com/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Let’s hear it" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeEnabled();
  await expect(page.getByLabel("YOUR GUESS", { exact: true })).toHaveCount(0);
});

test("mobile layout, instructions, and hub navigation work without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Let’s hear it" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/tempo-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "How to play", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("http://localhost:3001");
  await expect(page.getByRole("heading", { name: "Good music. Great instincts." })).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(3);
  await expect(page.locator(".game-card h3")).toHaveText(["Blackjack Music", "Tempo Trap", "Encore"]);
  await expect(page.getByRole("link", { name: "Musical Daily home", exact: true })).toHaveAttribute("href", "/");
  await expect(page.locator(".musical-daily-logo")).toHaveAttribute("src", "/brand/musical-daily.svg");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/hub-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: "test-results/hub-desktop.png", fullPage: true });
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Tempo Trap", exact: true }) }).click();
  await expect(page).toHaveURL("http://localhost:3002/");
  await expect(page.getByRole("link", { name: "Musical Daily home", exact: true })).toHaveAttribute("href", "http://localhost:3001");
  await expect(page.locator(".musical-daily-logo")).toHaveAttribute("src", "/brand/musical-daily.svg");
});
