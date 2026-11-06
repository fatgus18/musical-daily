import {test,expect,type Page,type Response} from "@playwright/test";
import type {PublicGame,CatalogOffer} from "../../src/lib/types";

type GamePayload={game?:PublicGame;offer?:CatalogOffer;error?:string};
function gameAction(response:Response,action:string){
  const request=response.request();
  if(request.method()!=="POST"||new URL(response.url()).pathname!=="/encore/api/game")return false;
  try{return request.postDataJSON()?.action===action;}catch{return false;}
}
async function actionResponse(page:Page,action:string,perform:()=>Promise<unknown>,timeout=30000){
  const [result]=await Promise.all([page.waitForResponse(response=>gameAction(response,action),{timeout}),perform()]);
  expect(result.status(),`Encore ${action} response`).toBe(200);
  const payload=await result.json() as GamePayload;
  expect(payload.error,`Encore ${action} should not return an application error`).toBeUndefined();
  return payload;
}
function assertPublicGame(game:PublicGame|undefined):asserts game is PublicGame{
  expect(game).toBeTruthy();expect(game?.id).toBeTruthy();
  expect(game).not.toHaveProperty("picks");expect(game).not.toHaveProperty("player");expect(game).not.toHaveProperty("correctChoiceId");
}

test("a guest can search Hozier, hear a real clip, answer, resume and discard on the deployed site",async({page},testInfo)=>{
  test.skip(!process.env.MUSICAL_DAILY_LIVE_URL,"Run using playwright.cloud.config.ts against an explicitly selected live deployment.");
  const origin=new URL(String(testInfo.project.use.baseURL)).origin;
  const loopbackRequests:string[]=[];const errors:string[]=[];
  let gameId="";let discarded=false;
  page.on("request",request=>{
    const url=new URL(request.url());
    if(/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(url.hostname))loopbackRequests.push(`${url.origin}${url.pathname}`);
  });
  page.on("pageerror",error=>errors.push(error.message));
  try{
    const document=await page.goto("/encore",{waitUntil:"domcontentloaded"});
    expect(document?.status()).toBe(200);
    await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
    await expect(page.getByRole("link",{name:"Musical Daily home"})).toHaveAttribute("href","/");

    const searchResponse=page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname==="/encore/api/artists"&&url.searchParams.get("q")==="Hozier";
    },{timeout:60000});
    const [searched]=await Promise.all([searchResponse,page.getByLabel("Who's on repeat?").fill("Hozier")]);expect(searched.status()).toBe(200);
    const directory=await searched.json();
    const artist=directory.artists.find((candidate:{id:string;name:string})=>candidate.name==="Hozier");
    expect(artist,"The live provider should return Hozier").toBeTruthy();
    const choice=page.locator(".artist-option").filter({has:page.getByText("Hozier",{exact:true})}).first();
    await expect(choice).toBeEnabled();
    let created=await actionResponse(page,"create",()=>choice.click(),120000);
    if(created.offer){
      // Follow the real provider's coverage decision instead of inventing rarity.
      const offer=created.offer;expect(offer.artist.id).toBe(artist.id);
      expect(offer.previewable).toBeGreaterThanOrEqual(10);
      const available=offer.rankedAvailable?"Play 6 / 3 / 1 mix":"Play discovery mix";
      if(!offer.rankedAvailable)expect(offer.discoveryAvailable).toBe(true);
      await expect(page.getByRole("region",{name:"Artist catalog"})).toBeVisible();
      created=await actionResponse(page,"create",()=>page.getByRole("button",{name:available}).click(),120000);
    }
    const initial=created.game;assertPublicGame(initial);gameId=initial.id;
    expect(initial.artist.id).toBe(artist.id);expect(initial.artist.name).toBe("Hozier");
    expect(initial.phase).toBe("ready");expect(initial.round).toBe(0);expect(initial.results).toHaveLength(0);
    expect(initial.poolSize).toBeGreaterThanOrEqual(10);expect(initial.clipSeconds).toBe(10);
    expect(initial.preview).toBeTruthy();expect(new URL(initial.preview!,origin).protocol).toBe("https:");
    expect(initial.choices).toBeUndefined();expect(initial.guessDeadline).toBeNull();
    if(initial.mode==="ranked")expect(initial.mixCounts).toEqual({hit:6,favorite:3,deep:1});
    else expect(initial.mode).toBe("discovery");
    await expect(page.locator(".round-dots")).toHaveAttribute("aria-label","Song 1 of 10");
    await expect(page.locator(".round-dots i")).toHaveCount(10);

    // Observe the real media element advancing after a user click. No seek,
    // fake timers, media interception, or fabricated heard request is used.
    const heardResponse=page.waitForResponse(response=>gameAction(response,"heard"),{timeout:45000});
    const [heard]=await Promise.all([heardResponse,(async()=>{
      await page.getByRole("button",{name:"Play the clip"}).click();
      await expect.poll(()=>page.locator("audio").evaluate((audio:HTMLAudioElement)=>audio.paused?0:audio.currentTime),{timeout:25000}).toBeGreaterThan(initial.clipOffset+.5);
    })()]);
    expect(heard.status()).toBe(200);
    const timed=(await heard.json() as GamePayload).game;assertPublicGame(timed);
    expect(timed.id).toBe(gameId);expect(timed.phase).toBe("guessing");
    expect(timed.guessDeadline!-timed.serverNow).toBe(15000);expect(timed.choices).toHaveLength(4);
    const choices=page.getByRole("group",{name:"WHICH SONG IS IT?"});
    await expect(choices.getByRole("button")).toHaveCount(4);
    await expect(page.getByRole("timer")).toBeVisible();
    const playback=await page.locator("audio").evaluate((audio:HTMLAudioElement)=>({time:audio.currentTime,paused:audio.paused,error:audio.error?.code??null,source:audio.currentSrc}));
    expect(playback.error).toBeNull();expect(playback.paused).toBe(true);
    expect(playback.time).toBeGreaterThanOrEqual(initial.clipOffset+10);
    expect(playback.time).toBeLessThan(initial.clipOffset+11);
    expect(new URL(playback.source).protocol).toBe("https:");
    const answered=await actionResponse(page,"answer",()=>choices.getByRole("button").first().click());
    assertPublicGame(answered.game);
    expect(answered.game.phase).toBe("reveal");expect(answered.game.results).toHaveLength(1);
    expect(answered.game.results[0].timedOut).not.toBe(true);
    expect(answered.game.results[0].skipped).toBe(false);
    expect(answered.game.correct).toBe(answered.game.results[0].correct?1:0);
    await expect(page.getByRole("button",{name:"Next song",exact:true})).toBeVisible();

    await page.reload({waitUntil:"domcontentloaded"});
    await expect(page.getByRole("button",{name:"Next song",exact:true})).toBeVisible();
    const restoredResponse=await page.request.get(`${origin}/encore/api/game`);expect(restoredResponse.status()).toBe(200);
    const restored=(await restoredResponse.json() as GamePayload).game;assertPublicGame(restored);
    expect(restored.id).toBe(gameId);expect(restored.phase).toBe("reveal");expect(restored.results).toEqual(answered.game.results);
    expect(restored.correct).toBe(answered.game.correct);
    await page.getByRole("button",{name:"Encore home",exact:true}).click();
    await expect(page.getByRole("region",{name:"Saved mix"})).toContainText("1 of 10 songs answered");
    const result=await actionResponse(page,"discard",()=>page.getByRole("button",{name:"Discard saved mix",exact:true}).click());
    assertPublicGame(result.game);discarded=true;
    expect(result.game.id).toBe(gameId);expect(result.game.phase).toBe("discarded");
    expect(result.game.completionStatus).toBe("incomplete");expect(result.game.incompleteReason).toBe("discarded");
    expect(result.game.results).toHaveLength(1);expect(result.game.preview).toBeUndefined();
    await expect(page.getByRole("status").filter({hasText:"recorded as incomplete"})).toBeVisible();
    await page.reload({waitUntil:"domcontentloaded"});
    await expect(page.getByLabel("Who's on repeat?")).toBeVisible();
    await expect(page.getByRole("button",{name:"Back to your saved mix"})).toHaveCount(0);
    const finalResponse=await page.request.get(`${origin}/encore/api/game`);expect(finalResponse.status()).toBe(200);
    const final=(await finalResponse.json() as GamePayload).game;assertPublicGame(final);
    expect(final.id).toBe(gameId);expect(final.phase).toBe("discarded");expect(final.results).toHaveLength(1);
    expect(loopbackRequests,"No deployed browser request may fall back to localhost").toEqual([]);
    expect(errors).toEqual([]);
  }finally{
    // A failed provider/media assertion should not leave an abandoned smoke run.
    // This uses only the isolated guest cookie established by this test.
    if(gameId&&!discarded)await page.request.post(`${origin}/encore/api/game`,{data:{action:"discard",gameId,round:0},timeout:15000}).catch(()=>{});
  }
});
