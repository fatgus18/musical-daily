import {test,expect} from "@playwright/test";

test("collection and artist controls share a theme and support keyboard selection without accidental changes",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/artists?q=*",route=>route.fulfill({json:{artists:[{id:"apple:fixture",name:"The Weeknd",genre:"R&B / Soul"}]}}));
  await page.goto("/");await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled({timeout:30000});
  await expect(page.locator(".catalog-count")).toHaveCount(0);await expect(page.getByText(/songs in rotation/)).toHaveCount(0);
  const collection=page.getByRole("combobox",{name:"Pick a collection",exact:false});
  await expect(collection).toContainText("Anything goes");await collection.focus();await page.keyboard.press("ArrowDown");await expect(page.getByRole("listbox",{name:"Music collections"})).toBeVisible();
  await expect(page.getByRole("option",{selected:true})).toContainText("Anything goes");
  await page.screenshot({path:"test-results-collection/collection-menu-desktop.png",fullPage:true});
  await page.keyboard.press("End");await page.keyboard.press("Escape");await expect(page.getByRole("listbox")).toHaveCount(0);await expect(collection).toBeFocused();await expect(collection).toContainText("Anything goes");
  await page.keyboard.press("ArrowDown");await page.keyboard.type("rock");await page.keyboard.press("Enter");await expect(collection).toContainText("Rock anthems");await expect(page.getByRole("listbox")).toHaveCount(0);
  await collection.click();await page.getByRole("button",{name:"Runtime",exact:false}).click();await expect(page.getByRole("listbox")).toHaveCount(0);
  const search=page.getByLabel("Or find an artist");await search.fill("The Weeknd");await expect(page.getByRole("region",{name:"Artist search results"})).toBeVisible();
  await expect(page.locator(".artist-result").filter({hasText:/\d+ songs/}).first()).toBeVisible();
  await page.screenshot({path:"test-results-collection/artist-menu-desktop.png",fullPage:true});
  await page.keyboard.press("ArrowDown");await expect(page.locator(".artist-results button").first()).toBeFocused();await page.keyboard.press("Escape");await expect(page.getByRole("region",{name:"Artist search results"})).toHaveCount(0);await expect(search).toBeFocused();await expect(search).toHaveValue("The Weeknd");
  await page.keyboard.press("ArrowDown");await expect(page.getByRole("region",{name:"Artist search results"})).toBeVisible();
  await page.locator(".artist-result").filter({hasText:/\d+ songs/}).first().click();await expect(collection).toContainText("The Weeknd");
  await collection.click();await expect(page.getByRole("option",{selected:true})).toContainText("The Weeknd");await page.keyboard.press("Escape");
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await collection.click();
  await expect(page.locator(".collection-menu")).toHaveCSS("animation-name","none");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const bounds=await page.locator(".collection-menu").boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({path:"test-results-collection/collection-menu-mobile.png",fullPage:true});
  await page.getByRole("option",{name:"Pop party",exact:false}).click();await expect(collection).toContainText("Pop party");
  await page.getByRole("button",{name:"Let’s play",exact:true}).click();await expect(page.locator(".song-pick")).toHaveCount(2);
  const {game}=await(await page.request.get("/api/game")).json();expect(game.theme).toBe("pop");expect(errors).toEqual([]);
});
