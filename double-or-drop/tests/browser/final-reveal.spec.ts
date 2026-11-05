import {test,expect,type Page,type APIRequestContext} from "@playwright/test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Catalog} from "../../src/lib/catalog-types";
import type {PublicGame,Side} from "../../src/lib/types";

const state=async(request:APIRequestContext):Promise<PublicGame>=>(await(await request.get("/api/game")).json()).game;
function wrongSide(game:PublicGame):Side{const catalog=JSON.parse(readFileSync(resolve(`data/catalog-releases/${game.catalogVersion}.json`),"utf8"))as Catalog;const l=catalog.tracks.find(t=>t.id===game.pair.left.id)!.metrics[game.pair.metric]!.value,r=catalog.tracks.find(t=>t.id===game.pair.right.id)!.metrics[game.pair.metric]!.value;return(game.pair.metric==="year"?l<r:l>r)?"right":"left";}
async function move(request:APIRequestContext,game:PublicGame,action:string,choice?:Side):Promise<PublicGame>{const response=await request.post("/api/game",{data:{action,choice,gameId:game.id,round:game.round,revision:game.revision}});expect(response.ok()).toBe(true);return(await response.json()).game;}
async function oneLife(page:Page){await page.goto("/");await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled({timeout:30000});await page.getByRole("button",{name:"Runtime",exact:false}).click();await page.getByRole("button",{name:"Let’s play",exact:true}).click();await expect(page.locator(".song-pick")).toHaveCount(2);let game=await state(page.request);for(let i=0;i<2;i++){game=await move(page.request,game,"guess",wrongSide(game));game=await move(page.request,game,"next");}await page.reload();await expect(page.locator(".pick-clock")).toBeVisible();return state(page.request);}

test("third wrong pick shows the selected wrong record and answer for three seconds before results",async({page})=>{
  const game=await oneLife(page);
  await expect(page.locator(".track-listen")).toHaveCount(0);await expect(page.locator(".comparison a")).toHaveCount(0);
  await page.keyboard.press(wrongSide(game)==="left"?"1":"2");
  await expect(page.locator(".final-loss-panel")).toBeVisible();await expect(page.locator(".losing-card .your-pick")).toBeVisible();await expect(page.locator(".winning-card .revealed-value")).toBeVisible();
  await expect(page.locator(".result-panel")).toHaveCount(0);await expect(page.locator(".decision-actions")).toHaveCount(0);await expect(page.locator(".song-pick:enabled")).toHaveCount(0);
  const finished=await state(page.request);expect(finished.phase).toBe("complete");expect(finished.lives).toBe(0);
  await page.waitForTimeout(1800);await expect(page.locator(".final-loss-panel")).toBeVisible();
  await expect(page.locator(".result-panel")).toBeVisible({timeout:6000});
  const before=finished.revision;await page.reload();await expect(page.locator(".result-panel")).toBeVisible();await expect(page.locator(".final-loss-panel")).toHaveCount(0);expect((await state(page.request)).revision).toBe(before);
});

test("a last-life timeout gets the same final reveal and reduced motion does not skip it",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});const game=await oneLife(page);
  // Change only this test guest's deadline, exercising the real expiry API without a long wall-clock wait.
  const db=new DatabaseSync(resolve("data/double-drop.sqlite"));try{db.prepare("UPDATE games SET state=json_set(state,'$.guessDeadline',?) WHERE id=? AND active=1").run(Date.now()-1,game.id);}finally{db.close();}
  await page.reload();await expect(page.locator(".final-loss-panel")).toBeVisible();await expect(page.locator(".final-loss-panel")).toContainText("TIME’S UP");await expect(page.locator(".result-panel")).toHaveCount(0);
  await expect(page.locator(".final-reveal-wait>span")).toHaveCSS("animation-name","none");await page.waitForTimeout(1700);await expect(page.locator(".final-loss-panel")).toBeVisible();
  await expect(page.locator(".result-panel")).toBeVisible({timeout:6000});const saved=await state(page.request);expect(saved.results.at(-1)?.timedOut).toBe(true);expect(saved.answered).toBe(3);
});

test("new tempo games are rejected and all available modes hide listening links until answers",async({page})=>{
  await page.goto("/");await expect(page.getByRole("button",{name:"Let’s play",exact:true})).toBeEnabled({timeout:30000});await expect(page.locator(".metric-options button")).toHaveCount(3);
  const initial=await(await page.request.get("/api/game")).json();expect(initial.catalog.themes.every((theme:{metrics:string[]})=>!theme.metrics.includes("tempo"))).toBe(true);
  const rejected=await page.request.post("/api/game",{data:{action:"create",requestId:crypto.randomUUID(),metricFilter:"tempo",theme:"all",catalogVersion:initial.catalog.version}});expect(rejected.status()).toBe(400);
  await page.getByRole("button",{name:"Let’s play",exact:true}).click();await expect(page.locator(".song-pick")).toHaveCount(2);const game=await state(page.request);expect(["streams","duration"]).toContain(game.pair.metric);for(const track of [game.pair.left,game.pair.right]){expect(track.previewUrl).toBeUndefined();expect(track.previewSourceUrl).toBeUndefined();}
  await expect(page.getByRole("link",{name:"Full song",exact:false})).toHaveCount(0);await expect(page.locator(".track-listen")).toHaveCount(0);await expect(page.locator(".comparison a")).toHaveCount(0);
  await page.keyboard.press(wrongSide(game)==="left"?"1":"2");await expect(page.locator(".value-source a")).toHaveCount(2);await expect(page.locator(".track-listen")).toHaveCount(0);
});
