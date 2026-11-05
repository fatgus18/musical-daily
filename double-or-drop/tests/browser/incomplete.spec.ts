import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Catalog} from "../../src/lib/catalog-types";
import type {PublicGame} from "../../src/lib/types";

async function state(request:APIRequestContext):Promise<PublicGame>{return(await(await request.get("/api/game")).json()).game;}
function winner(game:PublicGame){const catalog=JSON.parse(readFileSync(resolve(`data/catalog-releases/${game.catalogVersion}.json`),"utf8"))as Catalog;const left=catalog.tracks.find(track=>track.id===game.pair.left.id)!.metrics[game.pair.metric]!.value,right=catalog.tracks.find(track=>track.id===game.pair.right.id)!.metrics[game.pair.metric]!.value;return(game.pair.metric==="year"?left<right:left>right)?"left":"right";}
async function move(request:APIRequestContext,game:PublicGame,action:string,choice?:string):Promise<PublicGame>{const response=await request.post("/api/game",{data:{action,gameId:game.id,round:game.round,revision:game.revision,choice}});expect(response.ok()).toBe(true);return(await response.json()).game;}
async function start(page:Page){await page.goto("/");await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled({timeout:30000});await page.getByRole("button",{name:"Runtime",exact:false}).click();await page.getByRole("button",{name:"Let’s play",exact:true}).click();await expect(page.locator(".song-pick")).toHaveCount(2);return state(page.request);}
async function home(page:Page){await page.getByRole("button",{name:"Double or Drop home",exact:true}).click();await expect(page.getByRole("button",{name:"Resume run",exact:false})).toBeVisible();}

test("home preserves a run; discarding protects its bank, records incomplete, and permits a genuinely new run",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  let game=await start(page);game=await move(page.request,game,"guess",winner(game));game=await move(page.request,game,"bank");game=await move(page.request,game,"guess",winner(game));
  await page.reload();await expect(page.locator(".decision-panel")).toBeVisible();await home(page);
  expect((await state(page.request)).phase).toBe("decision");
  await page.screenshot({path:"test-results-incomplete/drop-resume-options.png",fullPage:true});
  await page.getByRole("button",{name:"Discard & start fresh",exact:false}).click();
  await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();
  await expect(page.locator(".run-reset-notice")).toContainText("saved as incomplete");
  const discarded=await state(page.request);expect(discarded.id).toBe(game.id);expect(discarded.completionStatus).toBe("incomplete");expect(discarded.banked).toBe(100);expect(discarded.pot).toBe(0);expect(discarded.guessDeadline).toBeNull();expect(discarded.answered).toBe(2);
  await page.reload();await expect(page.getByRole("button",{name:"Resume run",exact:false})).toHaveCount(0);await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:"test-results-incomplete/drop-fresh-mobile.png",fullPage:true});
  await page.getByRole("button",{name:"Let’s play",exact:true}).click();await expect(page.locator(".song-pick")).toHaveCount(2);const fresh=await state(page.request);expect(fresh.id).not.toBe(game.id);expect(fresh.lives).toBe(3);expect(fresh.banked).toBe(0);
  const duplicate=await move(page.request,game,"discard");expect(duplicate.revision).toBe(discarded.revision);expect((await state(page.request)).id).toBe(fresh.id);expect(errors).toEqual([]);
});

test("a lost discard response restores the saved incomplete outcome without requiring another discard",async({page})=>{
  const original=await start(page);await home(page);let intercepted=false;
  await page.route("**/api/game",async route=>{if(!intercepted&&route.request().method()==="POST"&&route.request().postDataJSON().action==="discard"){intercepted=true;await route.fetch();await route.abort("connectionreset");return;}await route.continue();});
  await page.getByRole("button",{name:"Discard & start fresh",exact:false}).click();await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();await expect(page.locator(".error-banner")).toHaveCount(0);expect(intercepted).toBe(true);
  const saved=await state(page.request);expect(saved.id).toBe(original.id);expect(saved.completionStatus).toBe("incomplete");expect(saved.answered).toBe(0);expect(saved.revision).toBe(original.revision+1);
});

test("discard handles a just-expired pick once and keeps the new-run setup visible",async({page})=>{
  const original=await start(page);await home(page);
  // Only this isolated guest's row is changed to exercise a server/client deadline race.
  const db=new DatabaseSync(resolve("data/double-drop.sqlite"));try{db.prepare("UPDATE games SET state=json_set(state,'$.guessDeadline',?) WHERE id=? AND active=1").run(Date.now()-1,original.id);}finally{db.close();}
  await page.getByRole("button",{name:"Discard & start fresh",exact:false}).click();await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();
  const saved=await state(page.request);expect(saved.completionStatus).toBe("incomplete");expect(saved.answered).toBe(1);expect(saved.lives).toBe(2);expect(saved.results[0].timedOut).toBe(true);expect(saved.revision).toBe(original.revision+2);
});

test("an unsuccessful discard preserves the active run and lets the player retry",async({page})=>{
  const original=await start(page);await home(page);let fail=true;
  await page.route("**/api/game",async route=>{if(fail&&route.request().method()==="POST"&&route.request().postDataJSON().action==="discard")return route.fulfill({status:503,json:{error:"Could not save this discard. Try again."}});await route.continue();});
  await page.getByRole("button",{name:"Discard & start fresh",exact:false}).click();await expect(page.locator(".error-banner")).toBeVisible();await expect(page.getByRole("button",{name:"Resume run",exact:false})).toBeEnabled();expect((await state(page.request)).id).toBe(original.id);expect((await state(page.request)).phase).not.toBe("complete");
  fail=false;await page.getByRole("button",{name:"Discard & start fresh",exact:false}).click();await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled();expect((await state(page.request)).completionStatus).toBe("incomplete");
});
