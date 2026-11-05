import {test,expect} from "@playwright/test";
import {MUSIC_FACTS,FACT_HISTORY_KEY} from "../../../musical-daily/src/lib/music-facts";

test("startup music facts shuffle, link to real subjects, and can be hidden and restored",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://localhost:3001/");
  await page.addStyleTag({content:"nextjs-portal{display:none!important}"});
  const card=page.getByRole("complementary",{name:"Off the record: a surprising music fact"});
  await expect(card).toHaveAttribute("aria-busy","false");
  const first=await card.getAttribute("data-fact-id");
  const fact=MUSIC_FACTS.find(value=>value.id===first)!;
  await expect(card.locator(".music-fact-story p")).toHaveText(fact.text);
  await expect(card.locator(".music-fact-destination")).toHaveAttribute("href",fact.musicUrl);
  await expect(card.locator(".music-fact-source")).toHaveAttribute("href",fact.sourceUrl);
  for(const link of await card.getByRole("link").all()){
    await expect(link).toHaveAttribute("target","_blank");await expect(link).toHaveAttribute("rel","noopener noreferrer");
  }
  await page.getByRole("button",{name:"Show another music fact",exact:true}).click();
  await expect(card).not.toHaveAttribute("data-fact-id",first!);
  const second=await card.getAttribute("data-fact-id");
  await page.getByRole("button",{name:"Hide music fact for this visit",exact:true}).focus();await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);await expect(page.getByRole("button",{name:"Show music fact",exact:false})).toBeFocused();
  await page.keyboard.press("Enter");await expect(card).toHaveAttribute("data-fact-id",second!);
  await expect(page.getByRole("button",{name:"Hide music fact for this visit",exact:true})).toBeFocused();
  await page.keyboard.press("Enter");await page.reload();
  await expect(card).toHaveAttribute("aria-busy","false");await expect(card).not.toHaveAttribute("data-fact-id",second!);
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).length,FACT_HISTORY_KEY)).toBe(3);
  expect(errors).toEqual([]);
});

test("every fact fits narrow phones and the four games remain discoverable",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});await page.setViewportSize({width:320,height:640});
  await page.goto("http://localhost:3001/");await page.addStyleTag({content:"nextjs-portal{display:none!important}"});
  const card=page.locator(".music-fact");await expect(card).toHaveAttribute("aria-busy","false");
  await page.getByRole("button",{name:"High contrast",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-contrast","high");
  for(let i=0;i<MUSIC_FACTS.length;i++){
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await page.evaluate(()=>scrollTo(0,0));
    for(const bottom of await page.locator(".game-info h3").evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().bottom)))expect(bottom).toBeLessThanOrEqual(640);
    await page.getByRole("button",{name:"Show another music fact",exact:true}).click();
  }
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:width===390?844:1000});await page.evaluate(()=>scrollTo(0,0));
    await page.getByRole("button",{name:"High contrast",exact:true}).click();
    await page.screenshot({path:test.info().outputPath(`music-fact-${width}.png`),fullPage:true,animations:"disabled"});
  }
});
