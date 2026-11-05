import {test,expect,type Page} from "@playwright/test";
import type {GameId,GameStats} from "@musical-daily/accounts";

const user={id:"incomplete-stats-reader",name:"Alex Music",email:"alex@example.test",picture:null};
const empty:GameStats={played:0,completed:0,incomplete:0,wins:0,totalScore:0,bestScore:0,averageScore:0,averagePercent:0,totalCorrect:0,totalRounds:0,currentStreak:0,bestStreak:0,lastPlayed:null,recent:[]};
const games:Record<GameId,GameStats>={
  blackjack:{...empty},tempo:{...empty},
  encore:{...empty,played:1,incomplete:1,totalCorrect:2,totalRounds:3,averagePercent:67,recent:[{eventId:"encore-partial",date:"2026-11-03",status:"incomplete",incompleteReason:"replaced",score:2,maxScore:10,correct:2,rounds:3,won:false,artist:{id:"hozier",name:"Hozier"}}]},
  "double-drop":{...empty,played:2,completed:1,incomplete:1,wins:1,totalScore:1,bestScore:1,averageScore:1,totalCorrect:3,totalRounds:5,averagePercent:60,totalBanked:300,bestBanked:200,recent:[{eventId:"drop-partial",date:"2026-11-03",status:"incomplete",incompleteReason:"discarded",score:2,maxScore:4,correct:2,rounds:4,won:false,bankedPoints:200},{eventId:"drop-complete",date:"2026-11-02",score:1,maxScore:1,correct:1,rounds:1,won:true,bankedPoints:100}]},
};
const metric=(page:Page,label:string)=>page.locator(".md-stats-metric").filter({has:page.locator("dt",{hasText:label})}).locator("dd");
async function account(page:Page,data=games){await page.route("**/api/account/session",route=>route.fulfill({json:{user,configured:true}}));await page.route("**/api/account/stats",route=>route.fulfill({json:{user,games:data}}));}

test("combined and individual stats distinguish incomplete plays and keep actual answers and banks",async({page})=>{
  await account(page);await page.goto("http://localhost:3001/stats");
  await expect(metric(page,"Incomplete mixes")).toHaveText("1");await expect(metric(page,"Incomplete runs")).toHaveText("1");await expect(metric(page,"Banked points")).toHaveText("300");
  await page.goto("http://localhost:3004/stats");await expect(metric(page,"Mixes finished")).toHaveText("0");await expect(metric(page,"Incomplete mixes")).toHaveText("1");await expect(metric(page,"Songs recognized")).toHaveText("2");await expect(metric(page,"Songs answered")).toHaveText("3");await expect(metric(page,"Average accuracy")).toHaveText("67%");
  await expect(page.locator(".md-stats-result-status")).toHaveText("Incomplete");await expect(page.locator(".md-stats-history")).toContainText("2 / 3 answered");await expect(page.locator(".md-stats-history")).toContainText("Replaced with a new run");
  await page.screenshot({path:"test-results-incomplete/encore-stats-desktop.png",fullPage:true});
  await page.goto("http://localhost:3005/stats");await expect(metric(page,"Runs finished")).toHaveText("1");await expect(metric(page,"Incomplete runs")).toHaveText("1");await expect(metric(page,"Best bank")).toHaveText("200");await expect(metric(page,"Finished with points")).toHaveText("1");await expect(metric(page,"Accuracy")).toHaveText("60%");
  await expect(page.locator(".md-stats-result-status")).toHaveText(["Incomplete","Completed"]);await expect(page.locator(".md-stats-history")).toContainText("200 banked");
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:"test-results-incomplete/drop-stats-mobile.png",fullPage:true});
});

test("an incomplete-only account with no answers gets no invented accuracy or completion",async({page})=>{
  const zero:Record<GameId,GameStats>={...games,encore:{...empty,played:1,incomplete:1,recent:[{eventId:"encore-empty",date:"2026-11-03",status:"incomplete",incompleteReason:"discarded",score:0,maxScore:10,correct:0,rounds:0,won:false}]},"double-drop":{...empty,played:1,incomplete:1,totalBanked:0,bestBanked:0,recent:[{eventId:"drop-empty",date:"2026-11-03",status:"incomplete",incompleteReason:"discarded",score:0,maxScore:0,correct:0,rounds:0,won:false,bankedPoints:0}]}};
  await account(page,zero);await page.goto("http://localhost:3004/stats");await expect(metric(page,"Incomplete mixes")).toHaveText("1");await expect(metric(page,"Mixes finished")).toHaveText("0");await expect(metric(page,"Average accuracy")).toHaveText("—");await expect(page.locator(".md-stats-history")).toContainText("No answers");
  await page.goto("http://localhost:3005/stats");await expect(metric(page,"Incomplete runs")).toHaveText("1");await expect(metric(page,"Runs finished")).toHaveText("0");await expect(metric(page,"Accuracy")).toHaveText("—");await expect(page.locator(".md-stats-history")).toContainText("No picks answered");expect(await page.locator("main").innerText()).not.toMatch(/NaN|Infinity/);
});
