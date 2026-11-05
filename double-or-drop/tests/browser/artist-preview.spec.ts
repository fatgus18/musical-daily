import { test, expect } from "@playwright/test";

test("live artist collections retain songs without exposing preview controls or song links in runtime rounds", async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const artistsResponse = await page.request.get("/api/artists?q=Hozier", { timeout: 60000 }); expect(artistsResponse.ok()).toBe(true);
  const { artists } = await artistsResponse.json(); const artist = artists.find((item: { name: string }) => item.name === "Hozier"); expect(artist).toBeTruthy();
  const loaded = await page.request.post("/api/artists", { data: { artistId: artist.id }, timeout: 90000 }); expect(loaded.ok()).toBe(true);
  const pack = await loaded.json(); expect(pack.theme.trackCount).toBeGreaterThan(40); expect(pack.theme.metrics).not.toContain("tempo");
  let releaseLoad: () => void = () => {};
  const gate = new Promise<void>(resolveGate => { releaseLoad = resolveGate; });
  await page.route("**/api/artists", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await gate; await route.fulfill({ json: pack });
  });
  await page.goto("/"); await expect(page.getByRole("button", { name: "Let’s play", exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByRole("button", { name: "Tempo", exact: true })).toHaveCount(0);
  await page.getByLabel("Or find an artist").fill("Hozier");
  await page.locator(".artist-results button").filter({ hasText: "Hozier" }).filter({ hasText: "Explore" }).first().click();
  await expect(page.getByRole("button", { name: "Loading artist…", exact: false })).toBeDisabled();
  releaseLoad(); await expect(page.locator(".artist-coverage")).toContainText(`${pack.theme.trackCount} songs ready`);
  await page.getByRole("button", { name: "Runtime", exact: false }).click();
  await page.getByRole("button", { name: "Let’s play", exact: true }).click();
  await expect(page.locator(".song-pick")).toHaveCount(2);
  const {game}=await (await page.request.get("/api/game")).json();
  expect(game.catalogVersion).toBe(pack.catalogVersion); expect(game.pair.metric).toBe("duration");
  expect(game.pair.left.artist).toContain("Hozier"); expect(game.pair.right.artist).toContain("Hozier");
  for(const track of [game.pair.left,game.pair.right]) { expect(track.previewUrl).toBeUndefined(); expect(track.previewSourceUrl).toBeUndefined(); }
  await expect(page.locator(".track-listen")).toHaveCount(0); await expect(page.locator(".comparison a")).toHaveCount(0);
  expect(await page.locator("audio").getAttribute("src")).toBeNull(); expect(errors).toEqual([]);
});
