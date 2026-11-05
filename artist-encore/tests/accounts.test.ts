import {test} from "node:test";
import assert from "node:assert/strict";
import {createGame,act} from "../src/lib/engine.ts";
import {openStore,recordMix,saveGame,findGame,historyFor,transaction} from "../src/lib/store.ts";
import {claimGuestGames,flushAccountResults} from "../src/lib/account-results.ts";
import type {Game} from "../src/lib/types.ts";
import type {ArtistPool} from "../src/lib/catalog.ts";
const pool:ArtistPool={artist:{id:"test",name:"Test Artist",image:"",url:"https://music.apple.com/"},tracks:Array.from({length:30},(_,i)=>({id:String(i),title:`Song ${i}`,artistId:"test",artist:"Test Artist",aliases:[],preview:`https://audio-ssl.itunes.apple.com/${i}.m4a`,artwork:"https://is1-ssl.mzstatic.com/a.jpg",url:"https://music.apple.com/",duration:200,rank:100-i})),ranking:{kind:"streams",label:"Test",sourceUrl:"https://example.com",asOf:"2026-11-01"},fetchedAt:Date.now()};
function finish(game:Game){const start=Date.now()-200000;for(let round=0;round<10;round++){const now=start+round*19000;act(game,"listen",round,"",now);act(game,"heard",round,"",now+10000);act(game,round<6?"answer":"pass",round,game.picks[round].correctChoiceId!,now+11000);if(round<9)act(game,"next",round,"",now+12000);}return game;}
test("verified login claims only this browser's guest games and history once",()=>{
  const db=openStore(":memory:");const guest=finish(createGame("guest-a",pool,[],"a"));const other=createGame("guest-b",pool,[],"b");recordMix(db,guest);recordMix(db,other);
  assert.equal(transaction(db,()=>claimGuestGames(db,"guest-a","user-1")),1);assert.equal(findGame(db,"guest-a",guest.id),null);assert.equal(findGame(db,"account:user-1",guest.id)?.player,"account:user-1");assert.ok(findGame(db,"guest-b",other.id));assert.equal(findGame(db,"account:user-2",guest.id),null);
  const first=historyFor(db,"account:user-1","test");assert.equal(first.length,10);assert.equal(transaction(db,()=>claimGuestGames(db,"guest-a","user-1")),0);assert.deepEqual(historyFor(db,"account:user-1","test"),first);assert.equal(db.prepare("SELECT count(*) n FROM account_result_outbox").get()!.n,1);db.close();
});
test("the last answered song queues one canonical result before the results-page click",async()=>{
  const db=openStore(":memory:");const game=finish(createGame("account:user-1",pool,[],"complete"));assert.equal(game.phase,"reveal");recordMix(db,game);saveGame(db,game);const batches:unknown[]=[];
  assert.equal(await flushAccountResults(db,game.player,async events=>{batches.push(events);assert.equal(events.length,1);assert.equal(events[0].score,6);assert.equal(events[0].correct,6);assert.equal(events[0].rounds,10);return{saved:true};}),true);
  act(game,"next",9);saveGame(db,game);await flushAccountResults(db,game.player,async events=>{batches.push(events);return{saved:true};});assert.equal(batches.length,1);db.close();
});
test("temporary account-service failures retain results and retries stay isolated",async()=>{
  const db=openStore(":memory:");const a=finish(createGame("account:a",pool,[],"a"));const b=finish(createGame("account:b",pool,[],"b"));recordMix(db,a);recordMix(db,b);const now=Date.now();
  assert.equal(await flushAccountResults(db,a.player,async()=>{throw new Error("offline");},now),false);
  let calls=0;assert.equal(await flushAccountResults(db,a.player,async()=>{calls++;return{saved:true};},now+1000),false);assert.equal(calls,0);
  assert.equal(await flushAccountResults(db,a.player,async events=>{calls++;assert.equal(events.length,1);assert.equal(events[0].eventId,a.id);return{saved:true};},now+6000),true);assert.equal(calls,1);assert.equal(db.prepare("SELECT synced_at FROM account_result_outbox WHERE game_id=?").get(b.id)!.synced_at,null);db.close();
});
