import {test,expect} from "@playwright/test";
import {DatabaseSync} from "node:sqlite";
import {resolve} from "node:path";
import type {Game} from "../../src/lib/types";
test("real artist preview plays ten seconds, scores, restores, and rotates a new mix",async({page,playwright})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();
  const artist=page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first();await expect(artist).toBeVisible({timeout:30000});await artist.click();
  await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  const initial=(await (await page.request.get("/api/game")).json()).game;
  expect(initial.phase).toBe("ready");expect(initial.picks).toBeUndefined();expect(initial.title).toBeUndefined();
  expect(initial.choices).toBeUndefined();
  const db=new DatabaseSync(resolve("data/encore.sqlite"),{readOnly:true});const stored=JSON.parse(String(db.prepare("SELECT state FROM games WHERE id=?").get(initial.id)!.state)) as Game;db.close();
  expect(stored.picks.filter(p=>p.tier==="hit")).toHaveLength(6);expect(stored.picks.filter(p=>p.tier==="favorite")).toHaveLength(3);expect(stored.picks.filter(p=>p.tier==="deep")).toHaveLength(1);
  await page.getByRole("button",{name:"Play the clip"}).click();
  await expect(page.locator(".audio-console")).toHaveClass(/is-playing/);
  await expect(page.getByRole("group",{name:"WHICH SONG IS IT?"})).toBeVisible({timeout:30000});
  const timed=(await (await page.request.get("/api/game")).json()).game;expect(timed.guessDeadline-timed.serverNow).toBeGreaterThan(0);expect(timed.guessDeadline-timed.serverNow).toBeLessThanOrEqual(15000);
  expect(timed.choices).toHaveLength(4);expect(timed.correctChoiceId).toBeUndefined();await expect(page.getByRole("group",{name:"WHICH SONG IS IT?"}).getByRole("button")).toHaveCount(4);
  const played=await page.locator("audio").evaluate((el:HTMLAudioElement)=>({time:el.currentTime,paused:el.paused}));expect(played.paused).toBe(true);expect(played.time).toBeGreaterThanOrEqual(17);expect(played.time).toBeLessThan(17.6);
  await page.reload();await expect(page.getByRole("group",{name:"WHICH SONG IS IT?"})).toBeVisible();
  const restored=(await (await page.request.get("/api/game")).json()).game;expect(restored.guessDeadline).toBe(timed.guessDeadline);expect(restored.choices).toEqual(timed.choices);
  const invalid=await page.request.post("/api/game",{data:{action:"answer",gameId:initial.id,round:0,choiceId:"forged"}});expect(invalid.status()).toBe(400);
  await page.getByRole("button",{name:stored.picks[0].track.title,exact:true}).focus();await page.keyboard.press("Enter");await expect(page.getByText("✦ THAT'S THE ONE.",{exact:true})).toBeVisible();
  const outsider=await playwright.request.newContext({baseURL:"http://localhost:3004"});expect((await outsider.post("/api/game",{data:{action:"next",gameId:initial.id,round:0}})).status()).toBe(400);await outsider.dispose();
  await page.getByRole("button",{name:"Next song",exact:true}).click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible();
  await page.getByRole("button",{name:"Choose another artist"}).click();await page.getByRole("button",{name:"Adele",exact:true}).click();await artist.click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:30000});
  const next=(await (await page.request.get("/api/game")).json()).game;expect(next.id).not.toBe(initial.id);expect(errors).toEqual([]);
  await page.screenshot({path:"test-results/encore-desktop.png",fullPage:true});
});
test("mobile layout, instructions and hub navigation",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await expect(page.getByLabel("Who's on repeat?")).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole("button",{name:"How to play"}).click();await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.screenshot({path:"test-results/encore-mobile.png",fullPage:true});await page.getByRole("link",{name:"Musical Daily home"}).click();await expect(page).toHaveURL("http://localhost:3001/");
  await page.getByRole("link").filter({has:page.getByRole("heading",{name:"Encore",exact:true})}).click();await expect(page).toHaveURL("http://localhost:3004/");
});
test("Hozier loads a live catalog beyond the old eighteen-song ranking intersection",async({request})=>{
  test.setTimeout(150000);const artists=await (await request.get("/api/artists?q=Hozier",{timeout:60000})).json();const artist=artists.artists.find((a:{name:string})=>a.name==="Hozier");expect(artist).toBeTruthy();
  const response=await request.get(`/api/catalog?artistId=${encodeURIComponent(artist.id)}`,{timeout:120000});expect(response.ok()).toBe(true);const {offer}=await response.json();expect(offer.previewable).toBeGreaterThan(40);expect(offer.ranked).toBeGreaterThanOrEqual(20);expect(offer.rankedAvailable).toBe(true);expect(offer.discoveryAvailable).toBe(true);expect(offer.tracks).toBeUndefined();
  const created=await request.post("/api/game",{data:{action:"create",artistId:artist.id,requestId:crypto.randomUUID(),mode:"discovery"},timeout:30000});expect(created.ok()).toBe(true);const {game}=await created.json();expect(game.mode).toBe("discovery");expect(game.poolSize).toBe(offer.previewable);expect(game.ranking.kind).toBe("unranked");expect(game.picks).toBeUndefined();
});
test("limited popularity offers discovery explicitly instead of inventing hit tiers",async({page})=>{
  let offered=false;await page.route("**/api/game",async route=>{const req=route.request();if(req.method()==="POST"){const body=req.postDataJSON();if(body.action==="create"&&body.mode!=="discovery"&&!offered){offered=true;const response=await page.request.get(`/api/catalog?artistId=${encodeURIComponent(body.artistId)}`,{timeout:120000});const {offer}=await response.json();await route.fulfill({json:{offer:{...offer,ranked:0,rankedAvailable:false,ranking:{...offer.ranking,kind:"unranked"}}}});return;}}await route.continue();});
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();
  await expect(page.getByRole("region",{name:"Artist catalog"})).toBeVisible({timeout:90000});await expect(page.getByRole("button",{name:"Play the clip"})).toHaveCount(0);await page.getByRole("button",{name:"Play discovery mix"}).click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible();await expect(page.locator(".mini-recipe")).toHaveText("10 songs · no popularity tiers");
  const {game}=await (await page.request.get("/api/game")).json();expect(game.mode).toBe("discovery");expect(game.ranking.kind).toBe("unranked");
});
test("leaving a slowly loading clip cancels playback and unavailable media can be replaced",async({page})=>{
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();
  await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  let release:(()=>void)|undefined;let intercepted=false;
  await page.route(/https:\/\/[^/]+\.(?:itunes\.apple\.com|mzstatic\.com)\//,async route=>{
    if(route.request().resourceType()!=="media"){await route.continue();return;}
    intercepted=true;await new Promise<void>(resolve=>{release=resolve;});await route.continue().catch(()=>{});
  });
  await page.getByRole("button",{name:"Play the clip"}).click();await expect.poll(()=>intercepted).toBe(true);
  await page.getByRole("button",{name:"Encore home",exact:true}).click();release?.();
  await expect(page.getByLabel("Who's on repeat?")).toBeVisible();await expect.poll(()=>page.locator("audio").evaluate((el:HTMLAudioElement)=>el.readyState),{timeout:20000}).toBeGreaterThanOrEqual(1);expect(await page.locator("audio").evaluate((el:HTMLAudioElement)=>el.paused)).toBe(true);
  await page.unrouteAll({behavior:"wait"});await page.getByRole("button",{name:"Back to your saved mix"}).click();
  await page.route(/https:\/\/[^/]+\.(?:itunes\.apple\.com|mzstatic\.com)\//,route=>route.request().resourceType()==="media"?route.abort():route.continue());
  // Force a fresh media request so the second attempt exercises an unavailable source.
  await page.locator("audio").evaluate((el:HTMLAudioElement)=>{el.removeAttribute("src");el.load();});
  const before=(await (await page.request.get("/api/game")).json()).game;
  await page.getByRole("button",{name:"Play the clip"}).click();await expect(page.locator(".error[role=alert]")).toContainText("couldn't play");
  await page.getByRole("button",{name:"Try a different clip at this level"}).click();await expect(page.locator(".error[role=alert]")).toHaveCount(0);
  const after=(await (await page.request.get("/api/game")).json()).game;expect(after.preview).not.toBe(before.preview);expect(after.tier).toBe(before.tier);expect(after.correct).toBe(0);expect(after.round).toBe(0);
  const retry=await page.request.post("/api/game",{data:{action:"replace-clip",gameId:before.id,round:before.round,expectedPreview:before.preview,expectedListenAt:before.listenAt}});expect(retry.status()).toBe(200);expect((await retry.json()).game.preview).toBe(after.preview);
});
test("guess countdown survives replay and home navigation, highlights five seconds, and expires once",async({page})=>{
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  await expect(page.getByRole("timer")).toHaveCount(0);await page.getByRole("button",{name:"Play the clip"}).click();await expect(page.getByRole("group",{name:"WHICH SONG IS IT?"})).toBeVisible({timeout:30000});
  const started=(await (await page.request.get("/api/game")).json()).game;expect(started.guessDeadline-started.serverNow).toBeLessThanOrEqual(15000);
  await page.getByRole("button",{name:"Replay · the timer keeps running"}).click();
  await expect(page.locator(".guess-clock.urgent")).toBeVisible({timeout:15000});
  expect(await page.locator(".guess-clock").evaluate(el=>getComputedStyle(el).animationName)).toBe("guess-urgency");
  expect((await (await page.request.get("/api/game")).json()).game.guessDeadline).toBe(started.guessDeadline);
  await page.emulateMedia({reducedMotion:"reduce"});expect(await page.locator(".guess-clock").evaluate(el=>getComputedStyle(el).animationName)).toBe("none");expect(await page.locator(".guess-clock").evaluate(el=>getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:"test-results/encore-mobile-choices.png",fullPage:true});
  await page.getByRole("button",{name:"Encore home",exact:true}).click();await expect(page.getByLabel("Who's on repeat?")).toBeVisible();expect(await page.locator("audio").evaluate((el:HTMLAudioElement)=>el.paused)).toBe(true);
  await page.reload();await expect(page.getByLabel("Who's on repeat?")).toBeVisible();await expect(page.getByRole("button",{name:"Play the clip"})).toHaveCount(0);
  await expect.poll(async()=>((await (await page.request.get("/api/game")).json()).game.phase),{timeout:12000}).toBe("reveal");
  await page.getByRole("button",{name:"Back to your saved mix"}).click();await expect(page.getByText("TIME’S UP. NEXT ONE’S YOURS.",{exact:true})).toBeVisible();
  const expired=(await (await page.request.get("/api/game")).json()).game;expect(expired.results).toHaveLength(1);expect(expired.results[0].timedOut).toBe(true);expect(expired.correct).toBe(0);
});
test("Encore home stays open when an earlier artist request finishes",async({page})=>{
  let release:(()=>void)|undefined;let requested=false;let completed=false;
  await page.route("**/api/game",async route=>{const req=route.request();if(req.method()==="POST"&&req.postDataJSON().action==="create"){requested=true;const responsePromise=route.fetch();await new Promise<void>(resolve=>{release=resolve;});const response=await responsePromise;await route.fulfill({response});completed=true;return;}await route.continue();});
  await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect.poll(()=>requested).toBe(true);
  await page.getByRole("button",{name:"Encore home",exact:true}).click();await expect(page.getByLabel("Who's on repeat?")).toBeVisible();release?.();await expect.poll(()=>completed,{timeout:90000}).toBe(true);
  await expect(page.getByRole("button",{name:"Adele",exact:true})).toBeEnabled();await expect(page.getByRole("button",{name:"Play the clip"})).toHaveCount(0);
  await page.reload();await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
});
test("a real artist portrait and four options fit both mobile and desktop",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto("/");await page.getByRole("button",{name:"Adele",exact:true}).click();await page.locator(".artist-option").filter({has:page.getByText("Adele",{exact:true})}).first().click();await expect(page.getByRole("button",{name:"Play the clip"})).toBeVisible({timeout:90000});
  const portrait=page.getByRole("img",{name:"Adele artist portrait"});await expect(portrait).toBeVisible({timeout:15000});await expect.poll(()=>portrait.evaluate((img:HTMLImageElement)=>img.naturalWidth),{timeout:15000}).toBeGreaterThan(0);await page.getByText("About this mix",{exact:true}).click();await expect(page.getByRole("link",{name:"Photo: Apple Music"})).toHaveAttribute("href",/music\.apple\.com\/us\/artist\/adele\/262836961/);
  await page.getByRole("button",{name:"Play the clip"}).click();await expect(page.getByRole("group",{name:"WHICH SONG IS IT?"})).toBeVisible({timeout:30000});await expect(page.locator(".song-choice")).toHaveCount(4);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect.poll(()=>page.locator(".answer-choices").evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
  await page.screenshot({path:"test-results/encore-mobile-choices.png",fullPage:true});await page.setViewportSize({width:1440,height:1080});await page.screenshot({path:"test-results/encore-desktop-choices.png",fullPage:true});await page.getByRole("button",{name:"Encore home",exact:true}).click();
});
