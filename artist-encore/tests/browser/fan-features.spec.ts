import {test,expect,type Page} from "@playwright/test";
import type {PublicGame} from "../../src/lib/types";

const artist={id:"apple:342260741",name:"Hozier",image:"",url:"https://music.apple.com/us/artist/hozier/342260741"};
async function account(page:Page){await page.route("**/api/account/session",route=>route.fulfill({json:{user:null,configured:false}}));}

test("front-row pins persist, unpin by keyboard, and replay through the artist API on narrow screens",async({page})=>{
  await account(page);await page.emulateMedia({reducedMotion:"reduce"});await page.setViewportSize({width:320,height:740});
  await page.addInitScript(()=>localStorage.setItem("musical-daily:contrast:v1","high"));
  let created:string|undefined;
  await page.route("**/api/game",async route=>{
    if(route.request().method()==="GET"){await route.fulfill({json:{game:null,audioEnabled:true}});return;}
    created=route.request().postDataJSON().artistId;
    await route.fulfill({json:{offer:{artist,previewable:18,ranked:0,rankedAvailable:false,discoveryAvailable:true,ranking:{kind:"unranked",label:"Fixture",sourceUrl:artist.url,asOf:"2026-11-03"}}}});
  });
  await page.route("**/api/artists?**",route=>route.fulfill({json:{artists:[artist]}}));
  await page.goto("/");await page.getByLabel("Who's on repeat?").fill("Hozier");
  const pin=page.getByRole("button",{name:"Pin Hozier as a favorite",exact:true});await expect(pin).toBeVisible();await pin.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Play a mix by Hozier"})).toBeVisible();
  await expect(page.locator(".favorite-storage")).toHaveText("Saved on this browser · up to 8 artists");
  await page.locator(".favorite-artists").screenshot({path:test.info().outputPath("pinned-artists.png")});
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("encore:favorite-artists:v1")!));expect(stored).toEqual({version:1,artists:[{id:artist.id,name:artist.name}]});
  await page.reload();await expect(page.getByRole("button",{name:"Play a mix by Hozier"})).toBeVisible();
  await page.getByRole("button",{name:"Play a mix by Hozier"}).click();await expect(page.getByRole("region",{name:"Artist catalog"})).toBeVisible();expect(created).toBe(artist.id);
  const unpin=page.locator(".favorite-artists").getByRole("button",{name:"Unpin Hozier",exact:true});await unpin.focus();await page.keyboard.press("Enter");await expect(page.locator(".favorite-card")).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator("html")).toHaveAttribute("data-contrast","high");
});

test("50/50 shows two choices, keeps the deadline on reload, and marks an assisted reveal",async({page})=>{
  await account(page);await page.setViewportSize({width:320,height:740});await page.emulateMedia({reducedMotion:"reduce"});
  await page.clock.install();
  let game:PublicGame={id:"fixture-mix",artist,ranking:{kind:"streams",label:"Fixture",sourceUrl:artist.url,asOf:"2026-11-03"},round:0,phase:"guessing",results:[],correct:0,tier:"hit",listenAt:Date.now()-10000,guessDeadline:Date.now()+15000,serverNow:Date.now(),clipOffset:7,clipSeconds:10,choices:[{id:"one",label:"Work Song"},{id:"correct",label:"Take Me to Church"},{id:"three",label:"Cherry Wine"},{id:"four",label:"From Eden"}],lifeline:{used:false,round:null,active:false}};
  const originalDeadline=game.guessDeadline;let used=0;
  await page.route("**/api/game",async route=>{
    if(route.request().method()==="POST"){
      const body=route.request().postDataJSON();
      if(body.action==="fifty-fifty"){used++;game={...game,choices:game.choices!.filter(choice=>["correct","four"].includes(choice.id)),lifeline:{used:true,round:0,active:true}};}
      if(body.action==="answer"){expect(body.choiceId).toBe("correct");game={...game,phase:"reveal",choices:undefined,correct:1,lifeline:{used:true,round:0,active:false},results:[{round:0,title:"Take Me to Church",artist:artist.name,artwork:"/favicon.ico",url:artist.url,tier:"hit",input:"Take Me to Church",correct:true,skipped:false,assisted:true}]};}
    }
    await route.fulfill({json:{game:{...game,serverNow:Date.now()},audioEnabled:true}});
  });
  await page.goto("/");await expect(page.locator(".song-choice")).toHaveCount(4);
  await page.clock.pauseAt(await page.evaluate(()=>Date.now()+500));
  await page.getByRole("button",{name:/50\/50.*USE LIFELINE/}).click();await expect(page.locator(".song-choice")).toHaveCount(2);await expect(page.locator(".lifeline-ticket")).toBeDisabled();
  expect(used).toBe(1);expect(game.guessDeadline).toBe(originalDeadline);await expect(page.locator("#lifeline-note")).toHaveText("Two wrong answers gone. Make it count.");
  await page.clock.resume();await page.reload();await expect(page.locator(".song-choice")).toHaveCount(2);await expect(page.locator(".lifeline-ticket")).toBeDisabled();expect(game.guessDeadline).toBe(originalDeadline);
  await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('[data-choice="correct"]').focus();await page.keyboard.press("Enter");await expect(page.locator(".assisted-label")).toContainText("50/50 used this round");await expect(page.locator(".answer-verdict")).toContainText("THAT'S THE ONE");
  await page.clock.resume();
});
