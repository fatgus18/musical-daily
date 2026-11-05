import { test, expect, type Page } from "@playwright/test";

const hub = "http://localhost:3001";
const blackjack = "http://localhost:3000";
const check = expect.configure({ timeout: 15000 });

async function openApp(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Development notices must not cover the real bottom-of-page controls.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function blackjackStorage(page: Page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("sbj_")).sort().map(key => [key, localStorage.getItem(key)])));
}

test("hub filters and reduced-motion surprise picks stay in the chosen collection on narrow screens", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, hub);
  await check(page.locator(".game-card:visible")).toHaveCount(4);
  await page.getByRole("button", { name: "High contrast", exact: true }).click();
  await check(page.locator("html")).toHaveAttribute("data-contrast", "high");

  const filters = page.getByRole("group", { name: "Filter games" });
  for (const collection of [
    { name: "Daily ritual", titles: ["Blackjack Music", "Tempo Trap"], width: 390 },
    { name: "Play anytime", titles: ["Encore", "Double or Drop"], width: 320 },
  ]) {
    await page.setViewportSize({ width: collection.width, height: 844 });
    const filter = filters.getByRole("button", { name: collection.name, exact: true });
    await filter.click();
    await check(filter).toHaveAttribute("aria-pressed", "true");
    await check(page.locator(".game-card:visible")).toHaveCount(2);
    await check(page.locator(".game-card:visible h3")).toHaveText(collection.titles);
    const allowedHrefs = await page.locator(".game-card:visible").evaluateAll(cards => cards.map(card => card.getAttribute("href")));
    await noOverflow(page);

    await page.getByRole("button", { name: /Surprise me/ }).click();
    const picker = page.getByRole("dialog", { name: /Your next spin/ });
    await check(picker).toBeVisible();
    expect(await picker.evaluate(element => element.matches(":modal"))).toBe(true);
    const launch = picker.getByRole("link", { name: /^Play / });
    await check(launch).toBeVisible();
    const firstHref = await launch.getAttribute("href");
    expect(allowedHrefs).toContain(firstHref);
    expect(collection.titles).toContain(await picker.locator(".picker-selection h3").innerText());
    await check(picker.locator(".picker-record")).not.toHaveClass(/is-spinning/);
    await check(page).toHaveURL(`${hub}/`);

    await picker.getByRole("button", { name: /Spin again/ }).click();
    await check(launch).not.toHaveAttribute("href", firstHref!);
    expect(allowedHrefs).toContain(await launch.getAttribute("href"));
    await check(page).toHaveURL(`${hub}/`);
    await noOverflow(page);
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await picker.screenshot({ path: test.info().outputPath(`picker-${collection.width}.png`) });
    await page.keyboard.press("Escape");
    await check(picker).not.toBeVisible();
  }
  await filters.getByRole("button", { name: "All games", exact: true }).click();
  await check(page.locator(".game-card:visible")).toHaveCount(4);
  await noOverflow(page);
});

test("Blackjack unlocks the remix room only after a real finish and never rewrites that result", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scoringPosts: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/reveal", "/api/finish"].includes(path)) scoringPosts.push(path);
  });
  await openApp(page, blackjack);
  const cards = page.locator(".bj-track-card");
  await check(cards).toHaveCount(9);
  await check(page.locator(".hand-remix")).toHaveCount(0);
  const stand = page.getByRole("button", { name: "STAND & LOCK IN", exact: true });
  await check(stand).toBeDisabled();
  await cards.first().press("Enter");
  await check(stand).toBeEnabled();
  const finish = page.waitForResponse(response => new URL(response.url()).pathname === "/api/finish" && response.request().method() === "POST");
  await stand.click();
  expect((await finish).ok()).toBe(true);
  const remix = page.locator(".hand-remix");
  await check(remix).toBeVisible();
  const saved = await blackjackStorage(page);
  const dailyKey = Object.keys(saved).find(key => key.startsWith("sbj_daily_"));
  expect(dailyKey).toBeTruthy();
  const daily = JSON.parse(saved[dailyKey!]!);
  expect(daily.gameOver).toBe(true);
  expect(daily.pickedIds).toHaveLength(1);
  expect(daily.finishData).toBeTruthy();
  expect(scoringPosts.filter(path => path === "/api/finish")).toHaveLength(1);
  const postsAfterFinish = [...scoringPosts];

  await remix.locator("summary").click();
  const records = remix.getByRole("group", { name: "Choose records for your remix" }).getByRole("button");
  await check(records).toHaveCount(9);
  await records.first().click();
  await check(records.first()).toHaveAttribute("aria-pressed", "true");
  await remix.getByRole("button", { name: /Give me a nudge/ }).click();
  await check(remix.locator(".remix-hint")).toBeVisible();
  await remix.getByRole("button", { name: "Show a best hand", exact: true }).click();
  await check(remix.locator(".remix-console [role=status]")).toContainText("Best hand shown.");
  const meter = remix.getByRole("meter", { name: "Remix total toward target" });
  expect(await meter.getAttribute("aria-valuenow")).toBe(await meter.getAttribute("aria-valuemax"));
  await remix.screenshot({ path: test.info().outputPath("remix-room.png") });
  await remix.getByRole("button", { name: "My original hand", exact: true }).click();
  await check(remix.locator(".remix-records button[aria-pressed=true]")).toHaveCount(1);
  await remix.getByRole("button", { name: "Clear", exact: true }).click();
  await check(meter).toHaveAttribute("aria-valuenow", "0");

  await page.getByRole("button", { name: "High contrast", exact: true }).click();
  await check(page.locator("html")).toHaveAttribute("data-contrast", "high");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    expect(await remix.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  expect(await blackjackStorage(page)).toEqual(saved);
  expect(scoringPosts).toEqual(postsAfterFinish);
});

