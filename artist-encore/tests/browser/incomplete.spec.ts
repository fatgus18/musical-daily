import {test,expect} from "@playwright/test";
import {DatabaseSync} from "node:sqlite";
import {resolve} from "node:path";

test("Encore home preserves a mix; discard records it once and reload never resumes it",async({page})=>{
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();
  await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();
  await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  const initial=(await (await page.request.get("/api/game")).json()).game;
  await page.getByRole("button",{name:"Encore home",exact:true}).click();
  await expect(page.getByRole("region",{name:"Saved mix"})).toContainText("0 of 10 songs answered");
  await expect(page.getByRole("region",{name:"Saved mix"})).toContainText("count as incomplete");
  expect((await (await page.request.get("/api/game")).json()).game.phase).toBe("ready");
  await page.getByRole("button",{name:"Discard saved mix",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"recorded as incomplete"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Discard saved mix",exact:true})).toHaveCount(0);
  expect(await page.locator("audio").evaluate((audio:HTMLAudioElement)=>audio.paused)).toBe(true);
  const discarded=(await (await page.request.get("/api/game")).json()).game;
  expect(discarded.id).toBe(initial.id);expect(discarded.phase).toBe("discarded");expect(discarded.completionStatus).toBe("incomplete");expect(discarded.results).toHaveLength(0);expect(discarded.preview).toBeUndefined();
  const late=await page.request.post("/api/game",{data:{action:"listen",gameId:initial.id,round:0}});expect((await late.json()).game.phase).toBe("discarded");
  await page.reload();await expect(page.getByLabel("Who's on repeat?")).toBeVisible();await expect(page.getByRole("button",{name:"Back to your saved mix"})).toHaveCount(0);
  const db=new DatabaseSync(resolve("data/encore.sqlite"),{readOnly:true});const rows=db.prepare("SELECT event FROM account_result_outbox WHERE game_id=?").all(initial.id);db.close();expect(rows).toHaveLength(1);expect(JSON.parse(String(rows[0].event))).toMatchObject({status:"incomplete",incompleteReason:"discarded",rounds:0,score:0,won:false});
  await page.screenshot({path:"test-results-incomplete/encore-discarded.png",fullPage:true});
});

test("starting another Encore mix retires the saved mix only once",async({page})=>{
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();
  await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  const first=(await (await page.request.get("/api/game")).json()).game;
  await page.getByRole("button",{name:"Encore home",exact:true}).click();await page.getByRole("button",{name:"Adele",exact:true}).click();
  await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  const second=(await (await page.request.get("/api/game")).json()).game;expect(second.id).not.toBe(first.id);expect(second.phase).toBe("ready");
  const stale=(await (await page.request.post("/api/game",{data:{action:"sync",gameId:first.id,round:0}})).json()).game;expect(stale.phase).toBe("discarded");expect(stale.incompleteReason).toBe("replaced");
  const db=new DatabaseSync(resolve("data/encore.sqlite"),{readOnly:true});const rows=db.prepare("SELECT event FROM account_result_outbox WHERE game_id=?").all(first.id);db.close();expect(rows).toHaveLength(1);expect(JSON.parse(String(rows[0].event))).toMatchObject({status:"incomplete",incompleteReason:"replaced",rounds:0});
  await page.getByRole("button",{name:"Encore home",exact:true}).click();await expect(page.getByRole("region",{name:"Saved mix"})).toBeVisible();await page.screenshot({path:"test-results-incomplete/encore-saved-mix.png",fullPage:true});
});
