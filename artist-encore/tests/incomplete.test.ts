import {test} from "node:test";
import assert from "node:assert/strict";
import type {ArtistPool} from "../src/lib/catalog.ts";
import type {Game} from "../src/lib/types.ts";
import {act,createGame,finishIncomplete,publicGame,unfinished} from "../src/lib/engine.ts";
import {findGame,openStore,pruneStore,recordMix,saveGame,startMix,transaction} from "../src/lib/store.ts";
import {claimGuestGames,flushAccountResults} from "../src/lib/account-results.ts";

const pool:ArtistPool={artist:{id:"fixture",name:"Fixture Artist",image:"",url:"https://music.apple.com/"},tracks:Array.from({length:60},(_,i)=>({id:String(i),title:`Track ${i}`,artistId:"fixture",artist:"Fixture Artist",aliases:[],preview:`https://audio-ssl.itunes.apple.com/${i}.m4a`,artwork:"",url:"https://music.apple.com/",duration:200,rank:1000-i})),ranking:{kind:"streams",label:"Fixture",sourceUrl:"https://example.com",asOf:"2026-11-01"},fetchedAt:1};
function answer(game:Game,now:number){act(game,"listen",game.round,"",now);act(game,"heard",game.round,"",now+10000);act(game,"answer",game.round,game.picks[game.round].correctChoiceId!,now+11000);}
function event(db:ReturnType<typeof openStore>,id:string){return JSON.parse(String(db.prepare("SELECT event FROM account_result_outbox WHERE game_id=?").get(id)!.event));}

test("discarding a fresh mix records zero answered rounds exactly once and cannot resume",async()=>{
  const db=openStore(":memory:");const game=startMix(db,"account:a",pool,"zero",10000);
  act(game,"discard",0,"",11000);saveGame(db,game);const restored=findGame(db,game.player,game.id)!;
  assert.equal(restored.phase,"discarded");assert.equal(restored.incompleteReason,"discarded");assert.equal(publicGame(restored).preview,undefined);
  for(const action of ["listen","heard","answer","next","sync","discard"])act(restored,action,0,game.picks[0].correctChoiceId!,20000);
  saveGame(db,restored);assert.equal(restored.results.length,0);assert.equal(restored.completedAt,11000);
  const result=event(db,game.id);assert.equal(result.status,"incomplete");assert.equal(result.rounds,0);assert.equal(result.correct,0);assert.equal(result.maxScore,10);assert.equal(result.won,false);
  let published=0;await flushAccountResults(db,game.player,async events=>{published+=events.length;return{saved:true};});await flushAccountResults(db,game.player,async events=>{published+=events.length;return{saved:true};});assert.equal(published,1);db.close();
});

test("new mixes replace prior active mixes transactionally and idempotent retries cannot reopen them",()=>{
  const db=openStore(":memory:");const first=startMix(db,"account:a",pool,"first",10000);answer(first,10000);saveGame(db,first);
  const second=startMix(db,"account:a",pool,"second",30000);assert.equal(findGame(db,"account:a",first.id)!.phase,"discarded");assert.equal(event(db,first.id).incompleteReason,"replaced");assert.equal(event(db,first.id).correct,1);assert.equal(event(db,first.id).rounds,1);
  const retry=startMix(db,"account:a",pool,"second",40000);assert.equal(retry.id,second.id);
  const stale=startMix(db,"account:a",pool,"first",41000);assert.equal(stale.phase,"discarded");assert.equal(findGame(db,"account:a")!.id,second.id);
  const third=startMix(db,"account:a",pool,"third",42000);assert.equal(findGame(db,"account:a")!.id,third.id);assert.equal(findGame(db,"account:a",second.id)!.phase,"discarded");assert.equal(db.prepare("SELECT count(*) n FROM account_result_outbox").get()!.n,2);db.close();
});

test("a failed replacement leaves the old mix and its stats untouched; other identities stay isolated",()=>{
  const db=openStore(":memory:");const saved=startMix(db,"account:a",pool,"saved",10000);const other=startMix(db,"account:b",pool,"other",11000);
  assert.throws(()=>startMix(db,"account:a",{...pool,tracks:pool.tracks.slice(0,3)},"failed",12000));
  assert.deepEqual(findGame(db,"account:a",saved.id),JSON.parse(JSON.stringify(saved)));assert.equal(db.prepare("SELECT count(*) n FROM account_result_outbox").get()!.n,0);assert.equal(findGame(db,"account:b",saved.id),null);
  startMix(db,"account:a",pool,"replacement",13000);assert.deepEqual(findGame(db,"account:b",other.id),JSON.parse(JSON.stringify(other)));db.close();
});

test("ten answered songs remain completed before the final reveal is dismissed",()=>{
  const db=openStore(":memory:");const game=createGame("account:a",pool,[],"full",10000);
  for(let round=0;round<10;round++){answer(game,10000+round*20000);if(round<9)act(game,"next",round,"",22000+round*20000);}
  assert.equal(game.phase,"reveal");recordMix(db,game);act(game,"discard",9,"",220000);saveGame(db,game);
  assert.equal(game.phase,"complete");assert.equal(game.completionStatus,"completed");assert.equal(event(db,game.id).status,"completed");assert.equal(event(db,game.id).rounds,10);assert.equal(event(db,game.id).won,true);db.close();
});

test("an elapsed tenth guess completes the mix, while an early discard leaves nine answers",()=>{
  const game=createGame("account:a",pool,[],"last",10000);
  for(let round=0;round<9;round++){answer(game,10000+round*20000);act(game,"next",round,"",22000+round*20000);}
  act(game,"listen",9,"",190000);act(game,"heard",9,"",200000);
  const early=structuredClone(game);finishIncomplete(early,"discarded",214999);assert.equal(early.completionStatus,"incomplete");assert.equal(early.results.length,9);
  finishIncomplete(game,"discarded",215000);assert.equal(game.completionStatus,"completed");assert.equal(game.results.length,10);assert.equal(game.results[9].timedOut,true);
});

test("retention queues expired account and guest mixes before deleting details",()=>{
  const now=Date.parse("2026-11-03");const db=openStore(":memory:");const account=createGame("account:a",pool,[],"old-account",now-31*86400000);const guest=createGame("guest",pool,[],"old-guest",now-31*86400000);recordMix(db,account);recordMix(db,guest);
  const result=pruneStore(db,now,true);assert.equal(result.games,2);assert.equal(findGame(db,account.player,account.id),null);assert.equal(event(db,account.id).incompleteReason,"expired");assert.equal(event(db,guest.id).rounds,0);
  transaction(db,()=>claimGuestGames(db,"guest","b"));assert.equal(db.prepare("SELECT player FROM account_result_outbox WHERE game_id=?").get(guest.id)!.player,"account:b");pruneStore(db,now,true);assert.equal(db.prepare("SELECT count(*) n FROM account_result_outbox").get()!.n,2);db.close();
});

test("login keeps an account's active mix and retires competing guest mixes without double claiming",()=>{
  const db=openStore(":memory:");const account=startMix(db,"account:a",pool,"account",10000);const guest=startMix(db,"guest",pool,"guest",12000);answer(guest,12000);saveGame(db,guest);
  transaction(db,()=>claimGuestGames(db,"guest","a"));assert.equal(findGame(db,"account:a")!.id,account.id);assert.equal(findGame(db,"account:a",guest.id)!.phase,"discarded");assert.equal(event(db,guest.id).incompleteReason,"account-merge");assert.equal(event(db,guest.id).rounds,1);
  assert.equal(transaction(db,()=>claimGuestGames(db,"guest","a")),0);assert.equal(db.prepare("SELECT count(*) n FROM account_result_outbox").get()!.n,1);db.close();
});

test("login resumes one guest mix when the account has none and retains all finished guest events",()=>{
  const db=openStore(":memory:");const first=startMix(db,"guest",pool,"first",10000);const active=startMix(db,"guest",pool,"active",12000);
  transaction(db,()=>claimGuestGames(db,"guest","a"));assert.equal(findGame(db,"account:a")!.id,active.id);assert.equal(unfinished(findGame(db,"account:a",active.id)!),true);assert.equal(event(db,first.id).status,"incomplete");assert.equal(db.prepare("SELECT player FROM account_result_outbox WHERE game_id=?").get(first.id)!.player,"account:a");db.close();
});
