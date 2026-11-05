import {test,expect,type APIRequestContext} from "@playwright/test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import type {Catalog} from "../../src/lib/catalog-types";
import type {Move,PublicGame,Side} from "../../src/lib/types";

const gameState=async(request:APIRequestContext):Promise<PublicGame>=>(await(await request.get("/api/game")).json()).game;
function correctSide(game:PublicGame):Side{
  const catalog=JSON.parse(readFileSync(resolve(`data/catalog-releases/${game.catalogVersion}.json`),"utf8")) as Catalog;
  const left=catalog.tracks.find(track=>track.id===game.pair.left.id)!.metrics[game.pair.metric]!.value;
  const right=catalog.tracks.find(track=>track.id===game.pair.right.id)!.metrics[game.pair.metric]!.value;
  return (game.pair.metric==="year"?left<right:left>right)?"left":"right";
}
async function apiMove(request:APIRequestContext,game:PublicGame,action:Move,choice?:Side):Promise<PublicGame>{
  const response=await request.post("/api/game",{data:{action,gameId:game.id,round:game.round,revision:game.revision,...(choice?{choice}:{})}});
  expect(response.ok()).toBe(true);return(await response.json()).game;
}

test("bank goals preserve clocks, count protected points and celebrate once on a narrow high-contrast screen",async({page})=>{
  test.setTimeout(120000);
  await page.setViewportSize({width:320,height:740});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/");
  await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Runtime",exact:false}).click();
  await page.getByRole("group",{name:"Bank goal",exact:true}).getByRole("button",{name:"500",exact:true}).click();
  await expect(page.getByRole("group",{name:"Bank goal",exact:true}).getByRole("button",{name:"500",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.locator(".md-contrast-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-contrast","high");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole("button",{name:"Let’s play",exact:true}).click();
  await expect(page.locator(".song-pick")).toHaveCount(2);
  let game=await gameState(page.request);const initialDeadline=game.guessDeadline;
  expect(game.bankTarget).toBe(500);expect(game.lives).toBe(3);
  await page.reload();
  await expect(page.getByRole("progressbar",{name:/Bank goal/})).toHaveAttribute("value","0");
  game=await gameState(page.request);expect(game.guessDeadline).toBe(initialDeadline);expect(game.bankTarget).toBe(500);
  await expect(page.locator(".run-milestone")).toHaveCount(0);

  // Real server transitions create an 800-point at-risk pot without touching the bank.
  for(let i=0;i<4;i++){
    game=await apiMove(page.request,game,"guess",correctSide(game));
    if(i<3)game=await apiMove(page.request,game,"risk");
  }
  expect(game.pot).toBe(800);expect(game.banked).toBe(0);expect(game.correct).toBe(4);
  await page.reload();
  await expect(page.getByRole("button",{name:"Bank & keep playing"})).toBeVisible();
  await expect(page.getByRole("progressbar",{name:/Bank goal/})).toHaveAttribute("value","0");
  await expect(page.locator(".run-milestone")).toHaveCount(0);
  await page.getByRole("button",{name:"Bank & keep playing"}).click();
  await expect(page.locator(".run-milestone")).toContainText("Goal in the bank! 500 points protected.");
  await expect(page.getByRole("progressbar",{name:/Bank goal/})).toHaveAttribute("value","500");
  await expect(page.locator(".run-goal-ribbon")).toContainText("BANK GOAL MET");
  game=await gameState(page.request);
  expect(game.phase).toBe("guess");expect(game.banked).toBe(800);expect(game.pot).toBe(0);expect(game.lives).toBe(3);
  expect(game.correct).toBe(4);expect(game.answered).toBe(4);expect(game.bestStreak).toBe(4);expect(game.completionStatus).toBeNull();
  expect(game.guessDeadline!-game.serverNow).toBeGreaterThan(0);expect(game.guessDeadline!-game.serverNow).toBeLessThanOrEqual(20000);
  const bankDeadline=game.guessDeadline;
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator(".run-goal-ribbon")).toContainText("BANK GOAL MET");
  await expect(page.locator(".run-milestone")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-contrast","high");
  game=await gameState(page.request);expect(game.guessDeadline).toBe(bankDeadline);
  // End immediately once restoration is checked. Scrolling to the footer and waiting
  // for a click consumes the real next-pick deadline; finish-button UI has its own test.
  const completed=await apiMove(page.request,game,"cashout");
  expect(completed.phase).toBe("complete");expect(completed.answered).toBe(4);
  await page.reload();
  await expect(page.locator(".result-panel")).toBeVisible();
  const final=await(await page.request.get("/api/game")).json();
  expect(final.game.completionStatus).toBe("completed");expect(final.game.banked).toBe(800);
  expect(final.game.answered).toBe(4);expect(final.game.correct).toBe(4);expect(final.personalBest).toBe(800);
  await expect(page.locator(".run-goal-ribbon")).toContainText("BANK GOAL MET");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
