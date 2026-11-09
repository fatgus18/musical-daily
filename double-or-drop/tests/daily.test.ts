import test from "node:test";
import assert from "node:assert/strict";
import {buildDailyChallenge,ensureDailyChallenge,findDailyGame,DAILY_PICKS,dailyReset} from "../src/lib/daily.ts";
import {createDailyGame,createGame,act,publicGame,settleClock} from "../src/lib/engine.ts";
import {openStore,saveGame,findModeGame,pruneStore} from "../src/lib/store.ts";
import {queueAccountResult,claimGuestGames} from "../src/lib/account-results.ts";
import {winner} from "../src/lib/rules.ts";
import {finalLossRevealKey} from "../src/lib/final-loss-reveal.ts";
import type {Catalog} from "../src/lib/catalog.ts";
import type {Game,Move,Side} from "../src/lib/types.ts";

const date="2026-11-09",now=Date.parse(`${date}T12:00:00Z`);
const catalog:Catalog={schema:1,version:"0123456789abcdef",createdAt:new Date(now).toISOString(),sources:[{id:"test",url:"https://example.com",note:"Test fixture"}],tracks:Array.from({length:80},(_,i)=>({id:`track-${i}`,title:`Track ${i}`,artist:`Artist ${i}`,primaryArtist:`Artist ${i}`,artwork:"https://example.com/art.jpg",sourceUrl:"https://example.com",popularity:70,metrics:{duration:{value:100+i*4,sourceUrl:"https://example.com"},streams:{value:(i+1)*10000000,sourceUrl:"https://example.com",asOf:date},year:{value:1970+i%50,sourceUrl:"https://example.com"}}}))};
const challenge=buildDailyChallenge(catalog,date);
const fresh=(player="guest:one")=>createDailyGame(player,challenge,crypto.randomUUID(),now);
function move(game:Game,action:Move,side?:Side){return act(game,action,game.round,game.revision,side,undefined,game.updatedAt+1);}
const correct=(game:Game)=>move(game,"guess",winner(game.pair));
const wrong=(game:Game)=>move(game,"guess",winner(game.pair)==="left"?"right":"left");

test("daily pairs are deterministic, date-dependent and independent of player and banking decisions",()=>{
  assert.equal(challenge.pairs.length,DAILY_PICKS);
  assert.deepEqual(buildDailyChallenge(catalog,date),challenge);
  assert.notDeepEqual(buildDailyChallenge(catalog,"2026-11-10").pairs,challenge.pairs);
  const a=fresh(),b=fresh("guest:two");
  assert.notEqual(a.id,b.id);assert.deepEqual(a.pair,b.pair);
  for(let i=0;i<5;i++){correct(a);correct(b);move(a,"bank");move(b,"risk");assert.deepEqual(a.pair,b.pair);}
  assert.notEqual(a.banked,b.banked);
  assert.equal(new Set(challenge.pairs.flatMap(p=>[p.left.id,p.right.id])).size,20);
});

test("daily ends after ten picks, auto-banks its surviving pot, and keeps the final answer visible",()=>{
  const game=fresh();
  for(let i=0;i<10;i++){correct(game);if(i<9)move(game,game.ladder===6?"bank":"risk");}
  assert.equal(game.phase,"complete");assert.equal(game.answered,10);assert.equal(game.endReason,"daily-complete");
  assert.equal(game.banked,4000);assert.equal(game.pot,0);assert.equal(game.lives,3);
  assert.ok(finalLossRevealKey(publicGame(game)));
  assert.equal(move(game,"risk").stale,true);assert.equal(game.round,9);
});

test("daily loses its unbanked pot on the third miss and retains the three-second reveal",()=>{
  const game=fresh();correct(game);move(game,"bank");
  for(let i=0;i<3;i++){wrong(game);if(i<2)move(game,"next");}
  assert.equal(game.phase,"complete");assert.equal(game.endReason,"lives");assert.equal(game.banked,100);
  assert.ok(finalLossRevealKey(publicGame(game)));
});

test("daily timeout on the tenth pick finishes exactly once without advancing a hidden pair",()=>{
  const game=fresh();for(let i=0;i<9;i++){correct(game);move(game,"bank");}
  const deadline=game.guessDeadline!;assert.equal(settleClock(game,deadline),true);
  assert.equal(game.answered,10);assert.equal(game.endReason,"daily-complete");assert.equal(game.lives,2);
  assert.equal(game.banked,900);assert.equal(game.results.at(-1)?.timedOut,true);
  assert.equal(settleClock(game,deadline+1000),false);
});

test("midnight expires unfinished daily attempts, preserving only already protected points",()=>{
  const game=fresh();correct(game);move(game,"bank");correct(game);
  assert.equal(game.pot,100);assert.equal(settleClock(game,dailyReset(date)),true);
  assert.equal(game.completionStatus,"incomplete");assert.equal(game.endReason,"expired");
  assert.equal(game.banked,100);assert.equal(game.pot,0);assert.equal(game.completedAt,dailyReset(date));
});

test("public daily state exposes the current pair only, with no plan, future titles or answers",()=>{
  const game=fresh(),view=publicGame(game);
  assert.equal(view.mode,"daily");assert.equal(view.totalPicks,10);assert.equal(view.dailyDate,date);
  assert.equal("dailyPairs" in view,false);assert.equal("metrics" in view.pair.left,false);assert.equal(view.reveal,undefined);
  const serialized=JSON.stringify(view);for(const pair of challenge.pairs.slice(1))assert.equal(serialized.includes(`\"id\":\"${pair.left.id}\"`),false);
});

test("first stored daily challenge survives catalog changes and concurrent publishers",async()=>{
  const db=await openStore(":memory:");try{
    const changed={...catalog,version:"fedcba9876543210",tracks:catalog.tracks.slice().reverse()};
    const [one,two]=await Promise.all([ensureDailyChallenge(db,catalog,date),ensureDailyChallenge(db,changed,date)]);
    assert.deepEqual(one,two);assert.deepEqual(await ensureDailyChallenge(db,changed,date),one);
    assert.equal((await db.execute("SELECT count(*) n FROM daily_challenges")).rows[0].n,1);
  }finally{db.close();}
});

test("a daily attempt and unlimited run coexist; discarding or many later runs cannot reroll today",async()=>{
  const db=await openStore(":memory:");try{
    const daily=fresh();const unlimited=createGame(daily.player,catalog,crypto.randomUUID(),{},now);
    await saveGame(db,daily);await saveGame(db,unlimited);
    assert.equal((await findModeGame(db,daily.player,"daily"))?.id,daily.id);
    assert.equal((await findModeGame(db,daily.player,"unlimited"))?.id,unlimited.id);
    await assert.rejects(saveGame(db,fresh()),/UNIQUE/);
    move(daily,"discard");await saveGame(db,daily,0);
    assert.equal((await findDailyGame(db,daily.player,date))?.completionStatus,"incomplete");
    await assert.rejects(saveGame(db,fresh()),/UNIQUE/);
    act(unlimited,"discard",0,0,undefined,undefined,now+1);await saveGame(db,unlimited,0);
    for(let i=0;i<60;i++){const run=createGame(daily.player,catalog,crypto.randomUUID(),{},now+i+10);act(run,"discard",0,0,undefined,undefined,now+i+11);await saveGame(db,run);}
    await pruneStore(db,now+10000,true);
    assert.equal((await findDailyGame(db,daily.player,date))?.id,daily.id);
  }finally{db.close();}
});

test("daily account results keep daily mode/date and claims cannot overwrite an account's attempt",async()=>{
  const db=await openStore(":memory:");try{
    const game=fresh("account:user");correct(game);move(game,"cashout");await saveGame(db,game);
    await queueAccountResult(db,game);
    const rows=(await db.execute("SELECT event FROM account_result_outbox")).rows;
    assert.equal(rows.length,1);const event=JSON.parse(String(rows[0].event));assert.equal(event.mode,"daily");assert.equal(event.date,date);
    const guest=fresh("guest:claimed");await saveGame(db,guest);
    await db.transaction(tx=>claimGuestGames(tx,guest.player,"user",now+10));
    assert.equal((await findDailyGame(db,"account:user",date))?.id,game.id);
    assert.equal((await findDailyGame(db,guest.player,date))?.id,guest.id);
  }finally{db.close();}
});
